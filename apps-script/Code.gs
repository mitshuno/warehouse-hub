/**
 * Backend Google Sheets untuk Warehouse Hub.
 *
 * Dua tugas:
 *   1. Menyimpan daftar SKU mana yang boleh tampil di situs publik (kotak centang).
 *   2. Menyajikan angka stok pasti — hanya kepada reseller yang punya kode.
 *
 * Alur daftar SKU:
 *   GitHub Actions  --(daftar SKU dari WMS)-->  skrip ini
 *   skrip ini       --(SKU baru jadi baris baru, centang KOSONG)-->  sheet "sku"
 *   skrip ini       --(daftar centang saat ini)-->  GitHub Actions
 *   Actions menyaring, lalu menulis data/katalog.json (status saja, tanpa angka)
 *
 * Alur angka stok:
 *   GitHub Actions  --(stok pasti SKU yang tampil)-->  sheet "stok"
 *   Reseller di HP  --(kode reseller)-->  skrip ini  --(angka stok)-->  HP
 *
 * Angka stok TIDAK PERNAH masuk ke repo GitHub — repo itu public. Angka hanya
 * hidup di spreadsheet ini dan dikirim ke browser setelah kode reseller cocok.
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
 * Setiap kali berkas ini diubah, deployment harus diperbarui:
 *   Deploy → Manage deployments → ikon pensil → Version: New version → Deploy.
 *
 * Ketiga sheet dibuat otomatis pada permintaan pertama.
 */

var SHEET_SKU      = 'sku';
var SHEET_RESELLER = 'reseller';
var SHEET_STOK     = 'stok';

/**
 * Kata sandi untuk GitHub Actions. Harus sama dengan secret HUB_TOKEN.
 * Ini BUKAN kode reseller — kode reseller ada di sheet "reseller".
 */
var KODE_AKSES = 'ganti-kode-ini';

var KOLOM_SKU = ['SKU', 'Nama di WMS', 'Tampil', 'Kategori', 'Nama Tampil', 'Varian', 'Ditemukan'];
var KOLOM_RESELLER = ['Nama', 'Kode', 'Aktif', 'Catatan', 'Terakhir masuk'];
var KOLOM_STOK = ['SKU', 'Varian', 'Ukuran', 'Stok', 'Diperbarui'];

var KATEGORI = ['Abaya', 'Hijab', 'Mukena', 'Daster', 'Set', 'Inner', 'Lainnya'];

var K_SKU = 0, K_NAMA = 1, K_TAMPIL = 2, K_KATEGORI = 3, K_NAMA_TAMPIL = 4,
    K_VARIAN = 5, K_DITEMUKAN = 6;

var R_NAMA = 0, R_KODE = 1, R_AKTIF = 2, R_CATATAN = 3, R_TERAKHIR = 4;


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
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // "masuk" dipanggil dari browser reseller, gerbangnya kode reseller —
    // bukan KODE_AKSES. Karena itu diperiksa sebelum penjagaan admin di bawah.
    if (req.aksi === 'masuk') {
      return masukReseller_(req);
    }

    if (!cocok_(req.kode)) {
      return json_({ ok: false, error: 'KODE_SALAH' });
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);

      if (req.aksi === 'sinkron-sku') {
        var baru = tambahSkuBaru_(req.produk || []);
        return json_({ ok: true, sku: bacaDaftar_(), baru: baru });
      }

      if (req.aksi === 'simpan-stok') {
        var n = simpanStok_(req.stok || []);
        return json_({ ok: true, tersimpan: n });
      }

      return json_({ ok: false, error: 'Aksi tidak dikenal: ' + req.aksi });
    } finally {
      try { lock.releaseLock(); } catch (abaikan) {}
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}


/* ------------------------------------------------------------------ */
/* Umum                                                                */
/* ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

function cocok_(kode) {
  return !KODE_AKSES || String(kode || '') === KODE_AKSES;
}

function sheet_(nama, kolom) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(nama);
  if (!sh) sh = ss.insertSheet(nama);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, kolom.length).setValues([kolom])
      .setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheetSku_()      { return sheet_(SHEET_SKU, KOLOM_SKU); }
function sheetReseller_() { return sheet_(SHEET_RESELLER, KOLOM_RESELLER); }
function sheetStok_()     { return sheet_(SHEET_STOK, KOLOM_STOK); }

function kunci_(sku, varian, size) {
  return String(sku) + '||' + String(varian || '') + '||' + String(size || '');
}


/* ------------------------------------------------------------------ */
/* Sheet "sku" — daftar centang                                        */
/* ------------------------------------------------------------------ */

function rapikan_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return;

  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 300);
  sh.setColumnWidth(3, 80);
  sh.setColumnWidth(4, 110);
  sh.setColumnWidth(5, 240);

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
    .setRanges([sh.getRange(2, 1, n, KOLOM_SKU.length)])
    .build();
  sh.setConditionalFormatRules([aturan]);
}

function bacaDaftar_() {
  var sh = sheetSku_();
  var n = sh.getLastRow();
  if (n < 2) return {};

  var out = {};
  sh.getRange(2, 1, n - 1, KOLOM_SKU.length).getValues().forEach(function (r) {
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
  var sh = sheetSku_();
  var ada = {};
  var n = sh.getLastRow();
  if (n >= 2) {
    sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (r) {
      var s = String(r[0] || '').trim();
      if (s) ada[s] = true;
    });
  }

  var hariIni = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var barisBaru = [], skuBaru = [];

  produk.forEach(function (p) {
    var sku = String((p && p.sku) || '').trim();
    if (!sku || ada[sku]) return;
    ada[sku] = true;
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
    sh.getRange(sh.getLastRow() + 1, 1, barisBaru.length, KOLOM_SKU.length).setValues(barisBaru);
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
/* Sheet "stok" — angka pasti, ditulis Actions                         */
/* ------------------------------------------------------------------ */

/** Tulis ulang seluruh isi sheet stok. Hanya SKU yang dicentang yang dikirim Actions. */
function simpanStok_(daftar) {
  var sh = sheetStok_();
  var n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, KOLOM_STOK.length).clearContent();
  if (!daftar.length) return 0;

  var waktu = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm');
  var baris = daftar.map(function (s) {
    return [String(s.sku || ''), String(s.varian || ''), String(s.size || ''),
            Number(s.qty) || 0, waktu];
  });
  sh.getRange(2, 1, baris.length, KOLOM_STOK.length).setValues(baris);
  return baris.length;
}

/**
 * Baca angka stok, disaring ulang terhadap daftar centang.
 *
 * Penyaringan di sini penting meski Actions sudah menyaring: begitu Anda hapus
 * centang sebuah SKU, sheet stok masih memuatnya sampai sinkron berikutnya
 * (hingga 20 menit). Tanpa saringan ini, reseller masih bisa melihat angkanya
 * selama jeda tersebut.
 */
function bacaStok_() {
  var daftar = bacaDaftar_();
  var sh = sheetStok_();
  var n = sh.getLastRow();
  if (n < 2) return {};

  var out = {};
  sh.getRange(2, 1, n - 1, KOLOM_STOK.length).getValues().forEach(function (r) {
    var sku = String(r[0] || '').trim();
    if (!sku) return;
    var aturan = daftar[sku];
    if (!aturan || !aturan.tampil) return;
    out[kunci_(sku, r[1], r[2])] = Number(r[3]) || 0;
  });
  return out;
}


/* ------------------------------------------------------------------ */
/* Sheet "reseller" — kode masuk                                       */
/* ------------------------------------------------------------------ */

function masukReseller_(req) {
  var kode = String((req && req.kode_reseller) || '').trim();
  if (!kode) return json_({ ok: false, error: 'KODE_KOSONG' });

  var sh = sheetReseller_();
  var n = sh.getLastRow();
  if (n < 2) return json_({ ok: false, error: 'KODE_RESELLER_SALAH' });

  var nilai = sh.getRange(2, 1, n - 1, KOLOM_RESELLER.length).getValues();
  for (var i = 0; i < nilai.length; i++) {
    var r = nilai[i];
    // Perbandingan tanpa peduli besar-kecil huruf: kode dibagikan lewat WhatsApp
    // dan sering diketik ulang, bukan disalin.
    if (String(r[R_KODE] || '').trim().toUpperCase() !== kode.toUpperCase()) continue;
    if (r[R_AKTIF] !== true) return json_({ ok: false, error: 'KODE_NONAKTIF' });

    sh.getRange(i + 2, R_TERAKHIR + 1)
      .setValue(Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm'));

    return json_({
      ok: true,
      nama: String(r[R_NAMA] || 'Reseller'),
      stok: bacaStok_(),
    });
  }
  return json_({ ok: false, error: 'KODE_RESELLER_SALAH' });
}

function rapikanReseller_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 130);
  sh.setColumnWidth(3, 70);
  sh.setColumnWidth(4, 240);
  sh.setColumnWidth(5, 140);
  sh.getRange(2, R_AKTIF + 1, n, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
    .setHorizontalAlignment('center');
  sh.getRange(2, R_KODE + 1, n, 1).setFontFamily('Roboto Mono');
}

/** Kode acak tanpa huruf/angka yang mudah tertukar saat diketik ulang (0/O, 1/I). */
function kodeAcak_() {
  var huruf = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 8; i++) {
    if (i === 4) s += '-';
    s += huruf.charAt(Math.floor(Math.random() * huruf.length));
  }
  return s;
}


/* ------------------------------------------------------------------ */
/* Menu di spreadsheet                                                 */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Warehouse Hub')
    .addItem('Tambah reseller', 'tambahReseller')
    .addSeparator()
    .addItem('Centang semua SKU', 'centangSemua')
    .addItem('Hapus semua centang SKU', 'hapusSemuaCentang')
    .addItem('Rapikan tampilan', 'rapikanManual')
    .addToUi();
}

function tambahReseller() {
  var ui = SpreadsheetApp.getUi();
  var jawab = ui.prompt('Tambah reseller', 'Nama reseller:', ui.ButtonSet.OK_CANCEL);
  if (jawab.getSelectedButton() !== ui.Button.OK) return;

  var nama = jawab.getResponseText().trim();
  if (!nama) { ui.alert('Nama tidak boleh kosong.'); return; }

  var sh = sheetReseller_();
  var kode = kodeAcak_();
  sh.appendRow([nama, kode, true, '', '']);
  rapikanReseller_(sh);

  ui.alert('Reseller ditambahkan',
    nama + '\n\nKode masuk:  ' + kode +
    '\n\nBagikan kode ini ke reseller tersebut. Hapus centang di kolom "Aktif" ' +
    'kapan saja untuk mencabut aksesnya.', ui.ButtonSet.OK);
}

function ubahSemua_(nilai) {
  var sh = sheetSku_();
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var isi = [];
  for (var i = 0; i < n; i++) isi.push([nilai]);
  sh.getRange(2, K_TAMPIL + 1, n, 1).setValues(isi);
}

function centangSemua()      { ubahSemua_(true); }
function hapusSemuaCentang() { ubahSemua_(false); }
function rapikanManual()     { rapikan_(sheetSku_()); rapikanReseller_(sheetReseller_()); }
