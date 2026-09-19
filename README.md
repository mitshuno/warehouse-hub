# Warehouse Hub

Etalase stok gudang untuk reseller. Satu berkas HTML statis — tanpa server, tanpa build,
tanpa dependensi — diterbitkan gratis lewat GitHub Pages.

Sumber stok adalah WMS di [portal.nawinow.com](https://portal.nawinow.com/). Hub ini
**read-only**: satu-satunya kebenaran stok tetap di WMS.

## Status

| Fase | Isi | Status |
|---|---|---|
| **1a** | Kerangka UI + katalog stok | ✅ selesai |
| **1b** | Sinkron GitHub Actions dari WMS + whitelist SKU | ✅ selesai — tinggal pasang secret |
| **1c** | Daftar centang SKU di Google Sheets | ✅ selesai — tinggal deploy |
| **1d** | Login reseller + angka stok pasti | ✅ selesai |
| **1e** | Stok toko reseller + rekomendasi stok aman | belum |
| **2** | Watchlist, alert restock, draft pesanan, PWA, tren stok | belum |

## Menjalankan secara lokal

```bash
python -m http.server 5177
# lalu buka http://127.0.0.1:5177
```

Harus lewat server, bukan `file://` — halaman mengambil `data/katalog.json` dengan `fetch`,
dan `file://` diblokir CORS.

## Apa yang sudah ada (fase 1a)

- Tabel katalog: cari, saring kategori/status/ukuran, urut per kolom, paginasi 10/25/50/100
- Baris zebra, header tabel menempel, baris bisa dibuka dengan Enter (bukan cuma klik)
- Tampilan **Matriks** — warna × ukuran per SKU, cara baca yang tepat untuk abaya & hijab
- Detail per SKU: jumlah kombinasi aman, perkiraan restock, matriks lengkap
- Mode terang & gelap: mengikuti setelan sistem, bisa ditimpa manual, tersimpan di browser
- Di HP tabel berubah jadi kartu padat; matriks tetap tabel dengan gulir mendatar
- Status ditandai ikon **dan** teks, tidak hanya warna

## Masuk sebagai reseller

Pengunjung biasa hanya melihat status **Aman / Menipis / Habis**. Reseller yang memasukkan
kodenya melihat **jumlah persis per varian** — di tabel, di matriks, dan di detail SKU.

Angka itu tidak pernah ada di repo. Alurnya:

```
Actions --(angka stok, hanya SKU yang dicentang)--> sheet "stok" di spreadsheet Anda
Reseller di HP --(kode)--> Apps Script --(angka)--> HP
```

### Menambah reseller

Di spreadsheet: menu **Warehouse Hub → Tambah reseller**. Masukkan namanya, kode acak
dibuatkan otomatis, lalu bagikan kode itu lewat WhatsApp.

Mencabut akses: hapus centang di kolom **Aktif** pada sheet `reseller`. Berlaku seketika —
reseller itu langsung kembali hanya melihat status.

Catatan tentang kode:
- Tidak peduli huruf besar-kecil, karena kode sering diketik ulang, bukan disalin.
- Tersimpan di peramban reseller, jadi cukup diketik sekali sampai mereka menekan keluar.
- Kode yang dicabut otomatis terbuang dari peramban saat mereka membuka halaman lagi.

## Keamanan tampilan

Repo GitHub Pages gratis harus public, jadi isi `data/katalog.json` ikut terbaca siapa pun.
Karena itu pemisahannya tegas:

| Jalur | Isi | Pembaca |
|---|---|---|
| `data/katalog.json` (ditulis Actions) | SKU whitelist + **status saja** | publik |
| Apps Script (setelah kode reseller) | angka stok pasti + insight pribadi | reseller |

Dua aturan yang tidak boleh dilanggar:

1. **Angka stok pasti tidak pernah di-commit ke repo.**
2. **Penyaringan whitelist SKU terjadi di lapisan sinkron, bukan di browser.** SKU yang
   tidak boleh tampil harus tidak pernah terkirim — menyembunyikannya dengan JavaScript
   percuma, datanya tetap terbaca di *view-source*.

## Sinkron dengan WMS

Tanpa mengubah satu baris pun kode WMS — repo `mitshuno/picking-packing` tidak disentuh.
[`.github/workflows/sinkron-stok.yml`](.github/workflows/sinkron-stok.yml) menjalankan
[`scripts/sinkron.py`](scripts/sinkron.py) tiap 20 menit:

1. `POST /api/v1/auth/login` ke Portal → access token
2. `GET /wms/api/reports/product-analytics` → satu panggilan, sudah memuat stok,
   laju jual, `days_of_stock`, dan klasifikasi fast/slow
3. Kirim daftar SKU ke Google Sheets, terima daftar centangnya, saring,
   ubah angka jadi status, tulis `data/katalog.json`
4. Periksa ulang keluaran — bila ada satu saja nilai angka, workflow berhenti sebelum commit
5. Commit hanya bila isinya berubah

Skripnya memakai pustaka standar Python saja — tidak ada `pip install`.

### Secret yang harus dipasang

**Settings → Secrets and variables → Actions → New repository secret**

| Nama | Isi |
|---|---|
| `PORTAL_USER` | username akun Portal untuk sinkron |
| `PORTAL_PASS` | password akun tersebut |
| `HUB_API_URL` | URL web app Apps Script (berakhiran `/exec`) |
| `HUB_TOKEN` | `KODE_AKSES` di Apps Script |

Dua yang terakhir boleh dikosongkan — tanpa keduanya sinkron tetap jalan memakai
`sku-tampil.json`.

Jangan pernah menaruh keempatnya di berkas mana pun dalam repo ini.

### Mengatur SKU mana yang tampil

Lewat **kotak centang di Google Sheets** — tinggal centang dari HP, tanpa menyentuh JSON.

Kolomnya: `SKU` · `Nama di WMS` · **`Tampil`** (centang) · `Kategori` · `Nama Tampil` ·
`Varian` · `Ditemukan`. Hanya tiga kolom tengah yang Anda isi; sisanya ditulis sinkron.

- **Daftarnya mengisi dirinya sendiri.** Tiap sinkron, semua SKU dari WMS dikirim ke Sheet.
  Yang belum ada masuk sebagai baris baru dengan **centang kosong** — produk baru di gudang
  tidak pernah tampil ke publik sebelum Anda meninjaunya.
- **Sinkron tidak pernah menimpa centang Anda.** Baris yang sudah ada tidak disentuh sama sekali.
- `Nama Tampil` kosong → pakai nama dari WMS. Diisi untuk merapikan judul marketplace yang panjang.
- Menu **Warehouse Hub** di spreadsheet punya pintasan *Centang semua* / *Hapus semua centang*.

Perubahan centang baru terlihat di situs setelah sinkron berikutnya (≤20 menit), atau
langsung lewat **Actions → Sinkron stok dari WMS → Run workflow**.

#### Memasang backend Sheets

1. Buka spreadsheet → **Extensions → Apps Script**
2. Hapus kode contoh, tempel seluruh isi [`apps-script/Code.gs`](apps-script/Code.gs)
3. Ganti `var KODE_AKSES = 'ganti-kode-ini';` dengan kata sandi bebas
4. **Deploy → New deployment → Web app** — *Execute as* `Me`, *Who has access* `Anyone`
5. Salin URL yang berakhiran `/exec`, lalu tambahkan dua secret di GitHub:
   `HUB_API_URL` (URL tadi) dan `HUB_TOKEN` (kata sandi tadi)

Ketiga sheet (`sku`, `reseller`, `stok`) dibuat otomatis pada sinkron pertama.

⚠️ **Setiap kali `Code.gs` diperbarui, deployment harus dinaikkan versinya** — kalau tidak,
Apps Script tetap menjalankan kode lama. Caranya: **Deploy → Manage deployments → ikon
pensil → Version: New version → Deploy**. URL `/exec`-nya tidak berubah.

#### Kalau Sheets bermasalah

Sinkron tidak ikut mati. Bila Apps Script tak bisa dihubungi atau tokennya salah, skrip
mencetak peringatan lalu memakai [`sku-tampil.json`](sku-tampil.json) — salinan centang
terakhir yang di-commit otomatis tiap sinkron berhasil. Berkas itu juga menjadi riwayat
perubahan centang di git.

Ambang status juga diatur di berkas yang sama:

```jsonc
"ambang": { "menipis_hari": 14, "menipis_qty": 5 }
```

`menipis_qty` adalah pengaman mutlak: produk yang jarang laku punya `days_of_stock`
raksasa padahal fisiknya tinggal beberapa potong — tanpa ambang ini ia terbaca "aman".

## Struktur berkas

| Berkas | Isi |
|---|---|
| `index.html` | Seluruh aplikasi — tampilan, penyaringan, paginasi, matriks |
| `config.js` | Lokasi data + alamat Apps Script. Ditulis otomatis oleh sinkron |
| `sku-tampil.json` | Ambang status + salinan centang terakhir dari Sheets (cadangan) |
| `apps-script/Code.gs` | Backend Google Sheets — daftar centang SKU, kode reseller, angka stok |
| `scripts/sinkron.py` | Penarik stok dari WMS. Pustaka standar saja |
| `.github/workflows/sinkron-stok.yml` | Penjadwal sinkron tiap 20 menit |
| `data/katalog.json` | Katalog stok — ditulis otomatis, jangan disunting tangan |
| `.nojekyll` | Melewati pemrosesan Jekyll di GitHub Pages |

## Publikasi lewat GitHub Pages

1. Repo: [mitshuno/warehouse-hub](https://github.com/mitshuno/warehouse-hub) — harus **public**.
2. **Settings → Pages** → Source: *Deploy from a branch*.
3. Branch `main`, folder `/ (root)`, **Save**.

Setiap `git push` berikutnya otomatis memperbarui situs.
