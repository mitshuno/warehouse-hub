/**
 * Sambungan data Warehouse Hub.
 *
 * HUB_DATA_URL  — berkas katalog stok yang dihasilkan GitHub Actions dari WMS.
 *                 Biarkan apa adanya kecuali lokasinya dipindah.
 *
 * HUB_API_URL   — URL web app Apps Script (berakhiran /exec) untuk lapisan reseller:
 *                 login kode reseller, angka stok pasti, stok toko, saran stok aman.
 *                 Dibiarkan kosong = mode pratinjau, hanya katalog status yang tampil.
 */
window.HUB_DATA_URL = "data/katalog.json";
window.HUB_API_URL  = "";
