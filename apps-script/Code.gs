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
var SHEET_TOKO     = 'stok_toko';
var SHEET_PILIHAN  = 'produk_toko';

/**
 * Parameter rekomendasi stok aman. Ubah di sini bila kenyataannya bergeser.
 *
 * LEAD_HARI     — lama dari reseller memesan sampai barang tiba di tokonya.
 * CADANGAN_HARI — bantalan di atas itu, supaya tidak pas-pasan saat penjualan
 *                 sedang ramai atau pengiriman telat.
 *
 * Stok aman = laju jual harian × (LEAD_HARI + CADANGAN_HARI).
 */
var LEAD_HARI = 3;
var CADANGAN_HARI = 7;

/**
 * Kata sandi untuk GitHub Actions. Harus sama dengan secret HUB_TOKEN.
 * Ini BUKAN kode reseller — kode reseller ada di sheet "reseller".
 */
var KODE_AKSES = 'ganti-kode-ini';

var KOLOM_SKU = ['SKU', 'Nama di WMS', 'Tampil', 'Kategori', 'Nama Tampil', 'Varian', 'Ditemukan'];
var KOLOM_RESELLER = ['Nama', 'Kode', 'Aktif', 'Catatan', 'Terakhir masuk'];
var KOLOM_STOK = ['SKU', 'Varian', 'Ukuran', 'Stok', 'Diperbarui'];
var KOLOM_TOKO = ['Reseller', 'SKU', 'Varian', 'Ukuran', 'Stok toko', 'Waktu'];
var KOLOM_PILIHAN = ['Reseller', 'SKU', 'Varian', 'Ukuran', 'Dijual'];

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

    // Dua aksi ini dipanggil dari browser reseller, gerbangnya kode reseller —
    // bukan KODE_AKSES. Karena itu diperiksa sebelum penjagaan admin di bawah.
    if (req.aksi === 'masuk') {
      return masukReseller_(req);
    }
    if (req.aksi === 'simpan-stok-toko') {
      return simpanTokoReseller_(req);
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
function sheetToko_()     { return sheet_(SHEET_TOKO, KOLOM_TOKO); }
function sheetPilihan_()  { return sheet_(SHEET_PILIHAN, KOLOM_PILIHAN); }

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
/* Sheet "stok_toko" — catatan stok di toko reseller                   */
/* ------------------------------------------------------------------ */

/**
 * Setiap penyimpanan adalah satu baris baru, bukan menimpa baris lama.
 * Riwayat inilah yang membuat laju jual bisa dihitung tanpa meminta reseller
 * mencatat penjualan — cukup "berapa sisa di toko sekarang".
 */
function simpanStokToko_(nama, isi) {
  if (!isi.length) return 0;
  var sh = sheetToko_();
  var sekarang = new Date();
  var baris = isi.map(function (b) {
    return [nama, String(b.sku || ''), String(b.varian || ''), String(b.size || ''),
            Number(b.stok) || 0, sekarang];
  });
  sh.getRange(sh.getLastRow() + 1, 1, baris.length, KOLOM_TOKO.length).setValues(baris);
  return baris.length;
}

/**
 * Hitung stok terakhir dan laju jual harian per produk untuk satu reseller.
 *
 * Laju dihitung dari selang waktu yang stoknya TURUN saja. Selang yang stoknya
 * naik berarti reseller baru merestok; berapa yang terjual di selang itu tidak
 * bisa diketahui dari satu angka, jadi selang tersebut dilewati — lebih baik
 * tidak menghitung daripada menghitung salah.
 */
function analisisToko_(nama) {
  var sh = sheetToko_();
  var n = sh.getLastRow();
  if (n < 2) return {};

  var per = {};
  sh.getRange(2, 1, n - 1, KOLOM_TOKO.length).getValues().forEach(function (r) {
    if (String(r[0] || '').trim() !== nama) return;
    var sku = String(r[1] || '').trim();
    if (!sku) return;
    var waktu = r[5] instanceof Date ? r[5].getTime() : new Date(r[5]).getTime();
    if (!waktu) return;
    var k = kunci_(sku, r[2], r[3]);
    if (!per[k]) per[k] = [];
    per[k].push({ stok: Number(r[4]) || 0, waktu: waktu });
  });

  var out = {};
  Object.keys(per).forEach(function (k) {
    var d = per[k].sort(function (a, b) { return a.waktu - b.waktu; });
    var turun = 0, hari = 0;
    for (var i = 1; i < d.length; i++) {
      var selisih = d[i - 1].stok - d[i].stok;
      var jarak = (d[i].waktu - d[i - 1].waktu) / 86400000;
      // Jarak sangat pendek dibuang: itu biasanya koreksi salah ketik,
      // bukan penjualan sungguhan, dan bisa meledakkan laju harian.
      if (selisih > 0 && jarak >= 0.25) { turun += selisih; hari += jarak; }
    }
    var akhir = d[d.length - 1];
    out[k] = {
      stok: akhir.stok,
      laju: hari > 0 ? Math.round((turun / hari) * 100) / 100 : 0,
      diperbarui: Utilities.formatDate(new Date(akhir.waktu), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm'),
      catatan: d.length,
    };
  });
  return out;
}


/* ------------------------------------------------------------------ */
/* Sheet "produk_toko" — produk apa saja yang dijual tiap reseller     */
/* ------------------------------------------------------------------ */

/**
 * Tidak semua reseller menjual semua produk. Tanpa daftar ini, halaman Toko saya
 * memaksa mereka mengisi puluhan baris yang tidak relevan — dan fitur yang
 * merepotkan tidak akan dipakai.
 */
function bacaPilihan_(nama) {
  var sh = sheetPilihan_();
  var n = sh.getLastRow();
  if (n < 2) return {};
  var out = {};
  sh.getRange(2, 1, n - 1, KOLOM_PILIHAN.length).getValues().forEach(function (r) {
    if (String(r[0] || '').trim() !== nama) return;
    var sku = String(r[1] || '').trim();
    if (!sku) return;
    out[kunci_(sku, r[2], r[3])] = r[4] === true;
  });
  return out;
}

/** Perbarui baris yang sudah ada, tambahkan yang belum. */
function simpanPilihan_(nama, pilihan) {
  if (!pilihan || !pilihan.length) return 0;
  var sh = sheetPilihan_();
  var n = sh.getLastRow();

  var barisKe = {};
  if (n >= 2) {
    sh.getRange(2, 1, n - 1, 4).getValues().forEach(function (r, i) {
      if (String(r[0] || '').trim() !== nama) return;
      barisKe[kunci_(String(r[1] || '').trim(), r[2], r[3])] = i + 2;
    });
  }

  var tambahan = [], diubah = 0;
  pilihan.forEach(function (p) {
    var sku = String(p.sku || '').trim();
    if (!sku) return;
    var k = kunci_(sku, p.varian, p.size);
    var jual = p.jual === true;
    if (barisKe[k]) {
      sh.getRange(barisKe[k], 5).setValue(jual);
    } else {
      tambahan.push([nama, sku, String(p.varian || ''), String(p.size || ''), jual]);
    }
    diubah++;
  });

  if (tambahan.length) {
    sh.getRange(sh.getLastRow() + 1, 1, tambahan.length, KOLOM_PILIHAN.length).setValues(tambahan);
  }
  var total = sh.getLastRow() - 1;
  if (total > 0) {
    sh.getRange(2, 5, total, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
      .setHorizontalAlignment('center');
  }
  return diubah;
}

/* ------------------------------------------------------------------ */
/* Sheet "reseller" — kode masuk                                       */
/* ------------------------------------------------------------------ */

/** Cari baris reseller yang kodenya cocok dan masih aktif. */
function cariReseller_(kode) {
  kode = String(kode || '').trim();
  if (!kode) return { galat: 'KODE_KOSONG' };

  var sh = sheetReseller_();
  var n = sh.getLastRow();
  if (n < 2) return { galat: 'KODE_RESELLER_SALAH' };

  var nilai = sh.getRange(2, 1, n - 1, KOLOM_RESELLER.length).getValues();
  for (var i = 0; i < nilai.length; i++) {
    var r = nilai[i];
    // Perbandingan tanpa peduli besar-kecil huruf: kode dibagikan lewat WhatsApp
    // dan sering diketik ulang, bukan disalin.
    if (String(r[R_KODE] || '').trim().toUpperCase() !== kode.toUpperCase()) continue;
    if (r[R_AKTIF] !== true) return { galat: 'KODE_NONAKTIF' };
    return { baris: i + 2, nama: String(r[R_NAMA] || 'Reseller') };
  }
  return { galat: 'KODE_RESELLER_SALAH' };
}

function balasanReseller_(nama) {
  return {
    ok: true,
    nama: nama,
    stok: bacaStok_(),
    toko: analisisToko_(nama),
    pilihan: bacaPilihan_(nama),
    parameter: { lead_hari: LEAD_HARI, cadangan_hari: CADANGAN_HARI },
  };
}

function masukReseller_(req) {
  var r = cariReseller_(req && req.kode_reseller);
  if (r.galat) return json_({ ok: false, error: r.galat });

  sheetReseller_().getRange(r.baris, R_TERAKHIR + 1)
    .setValue(Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm'));

  return json_(balasanReseller_(r.nama));
}

function simpanTokoReseller_(req) {
  var r = cariReseller_(req && req.kode_reseller);
  if (r.galat) return json_({ ok: false, error: r.galat });

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var n = simpanStokToko_(r.nama, (req && req.isi) || []);
    var m = simpanPilihan_(r.nama, (req && req.pilihan) || []);
    var balas = balasanReseller_(r.nama);
    balas.tersimpan = n;
    balas.pilihan_tersimpan = m;
    return json_(balas);
  } finally {
    try { lock.releaseLock(); } catch (abaikan) {}
  }
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
