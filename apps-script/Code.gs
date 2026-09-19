/**
 * Backend Google Sheets untuk Warehouse Hub.
 *
 * Tugasnya saat ini: menyimpan daftar SKU mana yang boleh tampil di situs publik,
 * dalam bentuk kotak centang yang bisa diatur dari HP.
 *
 * Alurnya:
 *   GitHub Actions  --(daftar SKU dari WMS)-->  skrip ini
 *   skrip ini       --(SKU baru jadi baris baru, centang KOSONG)-->  Sheet
 *   skrip ini       --(daftar centang saat ini)-->  GitHub Actions
 *   Actions menyaring, lalu menulis data/katalog.json
 *
 * SKU baru sengaja masuk dalam keadaan TIDAK dicentang: produk yang baru muncul
 * di gudang tidak boleh tampil ke publik sebelum Anda meninjaunya.
 *
 * Cara pasang (sekali saja):
 *   1. Buka spreadsheet → menu Extensions → Apps Script.
 *   2. Hapus kode contoh, tempel seluruh berkas ini.
 *   3. Ganti KODE_AKSES di bawah dengan kata sandi bebas milik Anda.
 *   4. Deploy → New deployment → Web app.
 *        Execute as     : Me
 *        Who has access : Anyone
 *   5. Salin URL yang berakhiran /exec, simpan sebagai secret HUB_API_URL di
 *      GitHub, dan KODE_AKSES sebagai secret HUB_TOKEN.
 *
 * Sheet "sku" dibuat otomatis pada permintaan pertama.
 */

var NAMA_SHEET = 'sku';

/**
 * Kata sandi untuk memanggil skrip ini. Harus sama dengan secret HUB_TOKEN
 * di GitHub. Jangan dibagikan ke siapa pun.
 */
var KODE_AKSES = 'ganti-kode-ini';

var KOLOM = ['SKU', 'Nama di WMS', 'Tampil', 'Kategori', 'Nama Tampil', 'Varian', 'Ditemukan'];
var KATEGORI = ['Abaya', 'Hijab', 'Mukena', 'Daster', 'Set', 'Inner', 'Lainnya'];

var K_SKU = 0, K_NAMA = 1, K_TAMPIL = 2, K_KATEGORI = 3, K_NAMA_TAMPIL = 4,
    K_VARIAN = 5, K_DITEMUKAN = 6;


/* ------------------------------------------------------------------ */
/* Titik masuk web app                                                 */
/* ------------------------------------------------------------------ */

function doGet(e) {
  try {
    if (!cocok_(e && e.parameter && e.parameter.kode)) {
      return json_({ ok: false, error: 'KODE_SALAH' });
    }
    return json_({ ok: true, sku: bacaDaftar_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!cocok_(req.kode)) {
      return json_({ ok: false, error: 'KODE_SALAH' });
    }

    if (req.aksi === 'sinkron-sku') {
      var baru = tambahSkuBaru_(req.produk || []);
      return json_({ ok: true, sku: bacaDaftar_(), baru: baru });
    }

    return json_({ ok: false, error: 'Aksi tidak dikenal: ' + req.aksi });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (abaikan) {}
  }
}


/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

function cocok_(kode) {
  return !KODE_AKSES || String(kode || '') === KODE_AKSES;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(NAMA_SHEET);
  if (!sh) sh = ss.insertSheet(NAMA_SHEET);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, KOLOM.length).setValues([KOLOM])
      .setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 130);   // SKU
    sh.setColumnWidth(2, 300);   // Nama di WMS
    sh.setColumnWidth(3, 80);    // Tampil
    sh.setColumnWidth(4, 110);   // Kategori
    sh.setColumnWidth(5, 240);   // Nama Tampil
  }
  return sh;
}

/**
 * Pasang kotak centang di kolom Tampil dan dropdown di kolom Kategori.
 * Dijalankan ulang tiap ada baris baru — aturan lama ditimpa, tidak menumpuk.
 */
function rapikan_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return;

  sh.getRange(2, K_TAMPIL + 1, n, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
    .setHorizontalAlignment('center');

  sh.getRange(2, K_KATEGORI + 1, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(KATEGORI, true).build()
  );

  // Baris yang dicentang diberi warna lembut supaya sekilas terlihat mana
  // yang sedang tampil di situs.
  var aturan = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$C2=TRUE')
    .setBackground('#e6f4ea')
    .setRanges([sh.getRange(2, 1, n, KOLOM.length)])
    .build();
  sh.setConditionalFormatRules([aturan]);
}

function bacaDaftar_() {
  var sh = sheet_();
  var n = sh.getLastRow();
  if (n < 2) return {};

  var nilai = sh.getRange(2, 1, n - 1, KOLOM.length).getValues();
  var out = {};
  nilai.forEach(function (r) {
    var sku = String(r[K_SKU] || '').trim();
    if (!sku) return;
    out[sku] = {
      tampil: r[K_TAMPIL] === true,
      kategori: String(r[K_KATEGORI] || '').trim() || 'Lainnya',
      nama_tampil: String(r[K_NAMA_TAMPIL] || '').trim(),
    };
  });
  return out;
}

/**
 * Masukkan SKU yang belum ada sebagai baris baru.
 *
 * SKU yang sudah ada TIDAK disentuh sama sekali — centang dan nama tampilan yang
 * sudah Anda atur tidak boleh tertimpa oleh sinkron.
 *
 * Isi awal baris baru diambil dari nilai bawaan yang dikirim Actions bila ada.
 * Itu hanya terjadi saat pindah dari sku-tampil.json ke Sheet ini, supaya keadaan
 * centang yang sudah berjalan ikut terbawa. Produk yang benar-benar baru di gudang
 * tidak membawa bawaan apa pun, jadi masuk dengan centang KOSONG.
 */
function tambahSkuBaru_(produk) {
  var sh = sheet_();
  var adaSkrg = {};
  var n = sh.getLastRow();
  if (n >= 2) {
    sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (r) {
      var s = String(r[0] || '').trim();
      if (s) adaSkrg[s] = true;
    });
  }

  var hariIni = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var barisBaru = [], skuBaru = [];

  produk.forEach(function (p) {
    var sku = String((p && p.sku) || '').trim();
    if (!sku || adaSkrg[sku]) return;
    adaSkrg[sku] = true;
    skuBaru.push(sku);
    var nama = String(p.nama || sku);
    barisBaru.push([
      sku,
      nama,
      p.tampil === true,
      String(p.kategori || '') || tebakKategori_(nama),
      String(p.nama_tampil || ''),
      p.varian || 1,
      hariIni,
    ]);
  });

  if (barisBaru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, barisBaru.length, KOLOM.length).setValues(barisBaru);
  }
  rapikan_(sh);
  return skuBaru;
}

function tebakKategori_(nama) {
  var s = String(nama || '').toLowerCase();
  if (s.indexOf('mukena') >= 0) return 'Mukena';
  if (s.indexOf('daster') >= 0) return 'Daster';
  if (s.indexOf('abaya') >= 0) return 'Abaya';
  if (s.indexOf('khimar') >= 0 || s.indexOf('bergo') >= 0 || s.indexOf('pashmina') >= 0 ||
      s.indexOf('hijab') >= 0 || s.indexOf('bandana') >= 0) return 'Hijab';
  return 'Lainnya';
}


/* ------------------------------------------------------------------ */
/* Menu di spreadsheet                                                 */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Warehouse Hub')
    .addItem('Centang semua', 'centangSemua')
    .addItem('Hapus semua centang', 'hapusSemuaCentang')
    .addItem('Rapikan tampilan', 'rapikanManual')
    .addToUi();
}

function ubahSemua_(nilai) {
  var sh = sheet_();
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var isi = [];
  for (var i = 0; i < n; i++) isi.push([nilai]);
  sh.getRange(2, K_TAMPIL + 1, n, 1).setValues(isi);
}

function centangSemua()      { ubahSemua_(true); }
function hapusSemuaCentang() { ubahSemua_(false); }
function rapikanManual()     { rapikan_(sheet_()); }
