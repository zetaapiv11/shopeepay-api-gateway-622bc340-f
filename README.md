# ShopeePay API Gateway (Node.js + PostgreSQL + Render)

Gateway API untuk membuat invoice QRIS dan memeriksa status pembayaran, dengan penyimpanan transaksi persisten di PostgreSQL.
Struktur endpoint dan nama environment mengikuti repo referensi `ahmadzakiyox/shoppepay-api-gateway`, tetapi kode ditulis ulang dari nol
(repo referensi berlisensi proprietary, kodenya tidak disalin).

## Baca dulu: apa yang BENAR-BENAR dilakukan proyek ini

Hasil analisis repo referensi (hanya README yang dapat diperiksa; `server.js` tidak dapat dibuka):

| Hal | Repo referensi | Proyek ini |
|---|---|---|
| Penyimpanan | Stateless (RAM) | PostgreSQL (invoice, event pembayaran, event webhook) |
| `SHOPEE_TOKEN` | Token **sesi** Partner Portal (`B:...`) diambil manual dari DevTools. **Bukan** kredensial merchant resmi | Sama. Token ini bisa mati kapan saja dan penggunaannya bisa melanggar ketentuan Shopee |
| Cek mutasi | Memanggil endpoint internal portal yang tidak terdokumentasi | Sama, lewat adapter. Nama field request/respons adalah **asumsi awal** (lihat "Blok capture") |
| `/create-qris` | Menyuntik nominal ke QRIS statis + hitung ulang CRC16 | Sama (`qris_kind: "static_injected"`). Ini **bukan** invoice dinamis resmi dari provider |
| Webhook | README menyebut, tidak ada rincian | `501 NOT_CONFIGURED` di produksi karena signature resmi tidak terdokumentasi |
| API key | Header atau `?api_key=` | Hanya header `X-API-Key` (query string bocor ke log/URL) |

Status token (`GET /token-status`):

- `NOT_CONFIGURED`: `SHOPEE_TOKEN` atau `SHOPEE_API_BASE` kosong.
- `UNVERIFIED`: provider tidak dapat dihubungi atau format respons tidak dikenali.
- `VALID`: provider menjawab uji langsung dengan token itu dan format dikenali. Ini bukti uji langsung, **bukan** validasi resmi (tidak ada mekanisme resmi).
- `INVALID`: provider menolak token (HTTP 401/403 atau kode `200020`).

Pembayaran hanya ditandai lunas bila ditemukan transaksi sukses di mutasi provider dengan nominal sama persis, waktu di antara pembuatan invoice dan kedaluwarsa,
dan `transaction_id` yang belum diklaim invoice lain (dijamin constraint database). Klaim dari client tidak pernah dianggap bukti.

### Blok capture (wajib dicocokkan)

Di `src/services/paymentProvider.js` ada blok `BLOK TERGANTUNG-CAPTURE`. Yang terverifikasi dari referensi hanya: token berada di `data.metadata.token`,
ada endpoint `get-transaction-list`, dan kode error token mati `200020`. Nama field lain (filter waktu, paginasi, kunci array respons, field transaksi)
adalah asumsi awal. Buka Partner Portal akun merchant **kamu sendiri**, lihat request `get-transaction-list` di DevTools, lalu samakan
`buildListPayload`, `extractList`, `normalizeTransaction`, dan isi `SHOPEE_API_BASE` (URL dasar hasil capture). Sebelum itu dilakukan,
`/token-status` akan menampilkan `UNVERIFIED` dan `/check-payment` mengembalikan error, tidak pernah "lunas palsu".

## Instalasi di Termux

```bash
pkg update && pkg upgrade
pkg install nodejs git
cd ~                      # gunakan home Termux, JANGAN /sdcard (masalah permission & symlink)
git clone REPOSITORY_URL
cd shopeepay-api-gateway
npm install               # menghasilkan package-lock.json (commit file ini untuk Render)
cp .env.example .env
nano .env
```

Isi `.env`:

- `API_KEY`: string acak minimal 16 karakter. Buat dengan `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `DATABASE_URL`: **External Database URL** dari Render (host berakhiran `.render.com`). Dari luar Render, URL internal tidak bisa dipakai.
  Pastikan aturan akses masuk (inbound/IP allowlist) database mengizinkan IP-mu dan koneksi internet Termux stabil.
- `QRIS_STATIC`: string QRIS statis merchant milikmu (opsional; tanpa ini `/create-qris` mengembalikan `NOT_CONFIGURED`).
- `SHOPEE_TOKEN` dan `SHOPEE_API_BASE`: opsional, diperlukan untuk verifikasi pembayaran (lihat "Blok capture").
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: opsional.

Jalankan migrasi dan server:

```bash
npm run migrate
npm start            # atau: npm run dev (auto-reload)
```

Tes unit (tanpa database/jaringan): `npm test`.

## Deploy ke Render

Kebijakan paket Render (paket gratis tidur saat idle, masa berlaku database gratis terbatas, dll.) bisa berbeda dan berubah; cek halaman pricing Render
dan sesuaikan `plan` di `render.yaml`.

1. **GitHub**: buat repository **Private**, lalu dari folder proyek: `git init && git add . && git commit -m "init"`,
   `git remote add origin URL_REPO`, `git push -u origin main`. Pastikan `.env` tidak ikut (sudah di `.gitignore`) dan `package-lock.json` ikut ter-commit (diperlukan `npm ci`).
2. **PostgreSQL**: Dashboard Render > New > PostgreSQL. Pilih nama/region/paket. Salin *Internal Database URL* (untuk Web Service di region yang sama)
   atau *External Database URL* (untuk Termux).
3. **Web Service**: New > Blueprint (memakai `render.yaml`, otomatis membuat database + service dan menghubungkan `DATABASE_URL`),
   atau New > Web Service secara manual: Build `npm ci`, Start `npm start`, Health Check Path `/api/health`.
4. **Environment variables** (Dashboard > Environment): `API_KEY`, `QRIS_STATIC`, `SHOPEE_TOKEN`, `SHOPEE_API_BASE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `PUBLIC_BASE_URL` (mis. `https://nama-service.onrender.com`). Secret hanya diisi di dashboard, tidak di GitHub.
5. **Migrasi**: `render.yaml` mengaktifkan `AUTO_MIGRATE=true` sehingga skema dibuat saat service start. Alternatif: jalankan `npm run migrate`
   dari Termux (dengan External URL) atau dari Shell Render jika tersedia di paketmu.
6. **Uji**: `curl https://nama-service.onrender.com/api/health`, lalu contoh curl di bawah dengan URL Render.
7. **Log**: Dashboard > Logs. Log berformat JSON dan secret otomatis disamarkan; tetap jangan menempelkan log mentah ke tempat publik tanpa memeriksanya.

Server mendengarkan `process.env.PORT` pada `0.0.0.0`; HTTPS disediakan Render.

## Alur lengkap: pelanggan bayar → otomatis lunas → produk terkirim

```
Website/Bot (server)         Gateway                         Shopee
   │ POST /create-qris ───────▶ simpan invoice PENDING
   │◀─ qris_url, payable_amount ┘
   │  tampilkan QR ke pelanggan
   │                          Pelanggan scan & bayar ───────────▶
   │                          watcher (tiap 10 dtk, hanya bila ada PENDING)
   │                            ├─ ambil mutasi ◀──────────────────
   │                            ├─ cocokkan nominal + waktu + ID transaksi unik
   │                            └─ tandai LUNAS (transaksi SQL) + antre callback
   │◀─ POST CALLBACK_URL  (X-Gateway-Signature) ┘
   │  verifikasi tanda tangan → cek order & nominal → KIRIM PRODUK
```

Aturan emas: **produk hanya boleh dikirim dari backend**, setelah (a) callback bertanda tangan valid, atau (b) `POST /check-payment` dari server kamu
mengembalikan `paid: true`. Jangan pernah mengirim produk karena browser/bot pelanggan "bilang sudah bayar", dan jangan menaruh `API_KEY` di JavaScript browser.

1. Backend website memanggil `POST /create-qris` dengan **harga dari database kamu** (bukan dari input pelanggan), `order_id` unik.
2. Tampilkan `qris_url` (gambar PNG) dan **`payable_amount`** (bila `UNIQUE_CODE_MAX` aktif, nominal bayar sedikit berbeda dari harga). Pelanggan harus membayar nominal persis itu.
3. Gateway memantau mutasi sendiri (`WATCH_INTERVAL_SECONDS`, default 10 detik), menandai lunas, lalu mengirim callback ke `CALLBACK_URL`.
4. Backend website menerima callback, memverifikasi, lalu mengirim produk. Contoh lengkap: `examples/website-callback-receiver.js`.
5. Halaman checkout cukup polling endpoint **backend-mu sendiri** (yang membaca status pesanan) untuk menampilkan "Pembayaran diterima".
   Backend-mu boleh juga memanggil `/check-payment` sebagai cadangan; saat watcher sehat, endpoint ini hanya membaca database dan tidak menembak Shopee.

Variabel env tambahan: `WATCH_INTERVAL_SECONDS`, `CALLBACK_URL` (https), `CALLBACK_SECRET` (min 16 karakter, sama di gateway dan website), `CALLBACK_MAX_ATTEMPTS`.

### Format callback

`POST CALLBACK_URL` dengan `Content-Type: application/json` dan header `X-Gateway-Event`, `X-Gateway-Event-Id`, `X-Gateway-Signature: t=<unix>,v1=<hex>`:

```json
{
  "event": "payment.paid",
  "event_id": "evt_<invoice_id>",
  "order_id": "ORDER-123",
  "invoice_id": "uuid",
  "amount": 15000,
  "payable_amount": 15000,
  "currency": "IDR",
  "status": "PAID",
  "transaction_id": "264693445089687719",
  "paid_at": "2026-10-29T10:03:11.000Z",
  "source": "watcher"
}
```

Verifikasi: `v1 = HMAC_SHA256(CALLBACK_SECRET, "<t>." + <body mentah>)`, tolak bila `t` selisih lebih dari 5 menit. Balas **2xx** bila berhasil.
Selain 2xx (atau timeout) gateway mencoba lagi dengan jeda 10 dtk, 20 dtk, 40 dtk, … (maks. 1 jam) hingga `CALLBACK_MAX_ATTEMPTS`, lalu status `FAILED` dan alert Telegram.
Pengiriman bersifat *at-least-once*: callback yang sama bisa datang lebih dari sekali, jadi proses secara idempotent (pakai `event_id`/`order_id`; contoh sudah menanganinya).
Pantau callback macet: `GET /callbacks?status=FAILED`; kirim ulang: `POST /callbacks/retry` dengan `{ "order_id": "..." }`.

### Batasan yang perlu kamu ketahui

- Otomatisasi ini bergantung pada token sesi Partner Portal yang tidak resmi. Bila token mati, pembayaran **tidak** terdeteksi: watcher berhenti 5 menit, mengirim alert Telegram,
  dan `/token-status` menampilkan `INVALID`. Perbarui lewat `POST /update-token` atau env `SHOPEE_TOKEN`. Pelanggan yang sudah bayar saat itu perlu ditangani manual atau
  otomatis terdeteksi setelah token diperbarui selama invoice belum kedaluwarsa.
- Pembayaran yang masuk **setelah** invoice kedaluwarsa tidak ditandai lunas otomatis (uang masuk, produk tidak terkirim). Atur `INVOICE_TTL_MINUTES` secukupnya dan sediakan jalur bantuan manual.
- Pencocokan memakai nominal + jendela waktu. Tanpa `UNIQUE_CODE_MAX`, dua pelanggan dengan nominal sama pada waktu bersamaan akan ditolak (`AMOUNT_IN_USE`); aktifkan kode unik untuk toko ramai.
- Paket gratis Render bisa tidur saat idle; saat tidur watcher tidak berjalan. Untuk pembayaran sungguhan gunakan paket yang selalu aktif.

## Referensi API

Semua endpoint selain `/api/health` dan `/qr/:id` memerlukan header `X-API-Key`.
Error selalu berbentuk `{ "success": false, "error": { "code": "...", "message": "..." } }`.

| Method & path | Keterangan |
|---|---|
| `GET /api/health` | Publik. `{ success, status: "online", timestamp }` |
| `GET /token-status` | Status integrasi: `NOT_CONFIGURED/UNVERIFIED/VALID/INVALID` (opsional header `X-Shopee-Token` untuk uji token lain) |
| `POST /update-token` | Body `{ "token": "..." }`; ganti token di memori proses (tidak disimpan, hilang saat restart) |
| `POST /create-qris` | Body `{ amount, order_id }`. Validasi integer positif, batas `MIN_AMOUNT`/`MAX_AMOUNT`, format `order_id`, tolak duplikat (409). Respons 201 berisi `invoice_id`, `order_id`, `amount`, `unique_code`, `payable_amount`, `status`, `qris_kind`, `qris_payload`, `qris_url`, `expires_at` |
| `GET /qr/:id` | Publik. Gambar PNG QR (hanya invoice PENDING, ID berupa UUID acak) |
| `POST /check-payment` | Body `{ order_id }`. Mengembalikan `{ success, paid, status, transaction?, data }`. Dibatasi interval minimal `MIN_CHECK_INTERVAL_SECONDS` per invoice |
| `GET /transactions` | Transaksi **lokal** dari PostgreSQL. Query: `page`, `limit` (maks 100), `status`, `order_id` |
| `GET /transactions/all` | Transaksi lokal dengan `start_date`, `end_date` (YYYY-MM-DD, WIB), `status`, paginasi (maks 500), dan `total_paid_amount` |
| `GET /transactions/provider` | Mutasi langsung dari provider (butuh konfigurasi sesi) |
| `GET /callbacks` | Antrean callback keluar (`status=PENDING/DELIVERED/FAILED`, paginasi) |
| `POST /callbacks/retry` | Body `{ order_id }`; jadwalkan ulang callback PENDING/FAILED |
| `POST /webhooks/payment` | Produksi: `501 NOT_CONFIGURED` (signature resmi tidak terdokumentasi). Development: simulasi, lihat di bawah |

Catatan penting: `/transactions` dan `/transactions/all` hanya menampilkan transaksi yang dibuat lewat gateway ini.
Endpoint ini **tidak** otomatis memberikan seluruh mutasi merchant ShopeePay.

`UNIQUE_CODE_MAX` (default 0): bila diisi, mis. 99, gateway menambahkan kode unik Rp1..99 ke nominal sehingga `payable_amount` berbeda untuk setiap invoice PENDING.
Bila 0, dua invoice PENDING dengan nominal sama ditolak (`409 AMOUNT_IN_USE`) karena pembayarannya tidak dapat dibedakan.

## Pengujian dengan curl

```bash
BASE=http://localhost:3001
KEY=ISI_API_KEY_KAMU

# Health
curl -s $BASE/api/health

# Status token
curl -s $BASE/token-status -H "X-API-Key: $KEY"

# Buat invoice
curl -s -X POST $BASE/create-qris -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"amount":15000,"order_id":"ORDER-123"}'

# Cek pembayaran
curl -s -X POST $BASE/check-payment -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"order_id":"ORDER-123"}'

# Daftar transaksi lokal
curl -s "$BASE/transactions?status=PENDING&page=1&limit=20" -H "X-API-Key: $KEY"
curl -s "$BASE/transactions/all?start_date=2026-10-01&end_date=2026-10-31" -H "X-API-Key: $KEY"

# Tanpa API key (harus 401)
curl -s -i -X POST $BASE/create-qris -H "Content-Type: application/json" -d '{"amount":15000,"order_id":"ORDER-124"}'

# Input invalid (harus 400)
curl -s -X POST $BASE/create-qris -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"amount":"15000","order_id":"!!"}'

# Webhook simulasi (HANYA NODE_ENV=development; nominal harus sama dengan payable_amount)
curl -s -X POST $BASE/webhooks/payment -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" -H "X-Dev-Simulation: true" \
  -d '{"event_id":"sim-1","order_id":"ORDER-123","amount":15000,"currency":"IDR"}'
```

Di `NODE_ENV=production`, simulasi webhook ditolak (`501`) dan tidak pernah menandai invoice lunas. Event simulasi di development ditandai `simulated=true`.

## Integrasi bot Telegram

Notifikasi (invoice dibuat, pembayaran terverifikasi, error integrasi) dikirim bila `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` terisi.
Kegagalan notifikasi tidak pernah mengubah status pembayaran.

Contoh bot penjualan ada di `examples/telegram-bot.js`: `/produk` menampilkan katalog, `/beli KODE` membuat QRIS (harga dari katalog di server bot),
lalu bot memantau `/check-payment` dan mengirim produk begitu `paid: true`. Ganti `PRODUCTS` dengan katalog dan stok milikmu.
Isi `.env` bot dengan token **milikmu sendiri**; jangan memakai token dari repo atau percakapan mana pun.
Bot bisa memakai polling `/check-payment` (seperti contoh) atau callback ke server bot, sama seperti website.

## Keamanan

- `API_KEY` dibandingkan dengan `timingSafeEqual`; server menolak start bila `API_KEY` kosong, pendek, atau masih nilai contoh.
- Helmet, rate limit global, batas body 10 KB, timeout HTTP, error handler terpusat, query selalu berparameter.
- Log tidak memuat secret (redaksi otomatis key sensitif, nilai env rahasia, connection string, token bot). Token/API key tidak disimpan di tabel transaksi.
- Pembayaran ganda dicegah: `SELECT ... FOR UPDATE`, unique constraint `provider_txn_id`, unique index nominal untuk invoice PENDING, dan `event_key` unik di `payment_events`.
- Invoice kedaluwarsa tidak akan dicocokkan lagi; pembayaran yang masuk setelah kedaluwarsa tidak otomatis ditandai lunas dan perlu ditangani manual.
- Graceful shutdown (SIGTERM/SIGINT) menutup server lalu pool database.
- Penggunaan token sesi dan endpoint internal Partner Portal bersifat tidak resmi dan menjadi tanggung jawabmu. Pahami syarat & ketentuan ShopeePay sebelum memakainya untuk produksi komersial.

## Struktur

```
src/app.js                    entry point, middleware, graceful shutdown
src/config.js                 pembacaan & validasi environment
src/routes/                   health, token, qris, transactions, webhooks, callbacks
src/services/                 paymentProvider (adapter), telegram, invoices (akses data + markPaid),
                              watcher (pemantau otomatis), callbacks (callback keluar + retry)
src/middleware/apiKey.js      autentikasi X-API-Key
src/database/                 db.js (pool pg), migrate.js
src/utils/                    logger, errors, validate, qris (penyuntik TLV + CRC16)
migrations/001_init.sql       invoices, payment_events, webhook_events
migrations/002_callbacks.sql  callback_deliveries (antrean callback)
examples/telegram-bot.js      contoh bot: /produk, /beli KODE -> bayar -> produk terkirim
examples/website-callback-receiver.js  contoh penerima callback di backend website
test/                         tes unit (qris, logger, matching, signature)
```
