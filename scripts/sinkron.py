#!/usr/bin/env python3
"""
Sinkron stok WMS → data/katalog.json.

Dijalankan GitHub Actions secara berkala. Tidak mengubah apa pun di WMS —
hanya login dan dua permintaan GET.

Aturan yang tidak boleh dilanggar (lihat README):
  1. Berkas keluaran TIDAK PERNAH memuat angka stok. Hanya status.
     Repo Pages harus public, jadi apa pun yang ditulis di sini terbaca siapa saja.
  2. Penyaringan SKU terjadi DI SINI, bukan di browser. SKU yang tidak
     didaftarkan di sku-tampil.json tidak pernah terkirim ke mana pun.

Daftar SKU yang boleh tampil diambil dari Google Sheets (kotak centang) bila
HUB_API_URL diset. Sheet-nya diisi sendiri oleh skrip ini: SKU baru dari WMS
masuk sebagai baris baru dengan centang KOSONG, lalu tinggal dicentang manual.
Hasilnya disalin balik ke sku-tampil.json — sebagai cadangan bila Apps Script
sedang tidak bisa dihubungi, sekaligus supaya perubahan centang punya riwayat di git.

Kredensial dibaca dari environment (GitHub Actions secret), tidak pernah dari berkas:
  PORTAL_USER, PORTAL_PASS, HUB_API_URL, HUB_TOKEN, dan opsional PORTAL_BASE.

Hanya pustaka standar — tidak ada dependensi untuk dipasang.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

AKAR = Path(__file__).resolve().parent.parent
BERKAS_CONFIG = AKAR / "sku-tampil.json"
BERKAS_KELUAR = AKAR / "data" / "katalog.json"

BASE = os.environ.get("PORTAL_BASE", "https://portal.nawinow.com").rstrip("/")
WAKTU_HABIS = 60


def ambil_daftar_dari_sheet(produk: list[dict], cadangan: dict) -> tuple[dict, list[str]] | None:
    """
    Kirim seluruh SKU yang ada di WMS ke Apps Script, terima kembali daftar
    centangnya. SKU yang belum ada di Sheet ditambahkan di sana dengan centang
    kosong — jadi produk baru tidak pernah tampil sebelum ditinjau.

    Mengembalikan None bila Sheet belum disetel atau tidak bisa dihubungi;
    pemanggil lalu memakai sku-tampil.json sebagai cadangan.
    """
    url = os.environ.get("HUB_API_URL")
    if not url:
        return None

    ringkas: dict[str, dict] = {}
    for it in produk:
        sku = it.get("sku")
        if not sku:
            continue
        if sku not in ringkas:
            # Nilai dari cadangan dipakai Apps Script sebagai isi awal baris BARU saja.
            # Gunanya saat pindah ke Sheets: keadaan centang yang sudah berjalan ikut
            # terbawa, jadi situs tidak mendadak kosong. Baris yang sudah ada di Sheet
            # tidak pernah tersentuh oleh ini.
            awal = cadangan.get(sku) or {}
            ringkas[sku] = {
                "sku": sku,
                "nama": it.get("nama") or sku,
                "varian": 0,
                "tampil": bool(awal.get("tampil")),
                "kategori": awal.get("kategori") or "",
                "nama_tampil": awal.get("nama_tampil") or "",
            }
        ringkas[sku]["varian"] += 1

    muatan = json.dumps({
        "kode": os.environ.get("HUB_TOKEN", ""),
        "aksi": "sinkron-sku",
        "produk": list(ringkas.values()),
    }).encode()

    req = urllib.request.Request(url, data=muatan, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=WAKTU_HABIS) as r:
            hasil = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001 — apa pun sebabnya, cadangan harus jalan
        print(f"! Sheet tidak bisa dihubungi ({e}). Memakai sku-tampil.json.")
        return None

    if not hasil.get("ok"):
        galat = hasil.get("error")
        if galat == "KODE_SALAH":
            print("! HUB_TOKEN tidak cocok dengan KODE_AKSES di Apps Script.")
        else:
            print(f"! Sheet menolak permintaan: {galat}")
        return None

    return hasil.get("sku") or {}, hasil.get("baru") or []


def minta(url: str, data: dict | None = None, token: str | None = None) -> dict:
    tubuh = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=tubuh, method="POST" if data else "GET")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=WAKTU_HABIS) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # Jangan pernah cetak tubuh permintaan — bisa memuat password.
        rinci = e.read().decode(errors="replace")[:300]
        raise SystemExit(f"Gagal {e.code} saat memanggil {url}\n{rinci}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Tidak bisa menghubungi {url}: {e.reason}")


def masuk() -> str:
    pengguna = os.environ.get("PORTAL_USER")
    sandi = os.environ.get("PORTAL_PASS")
    if not pengguna or not sandi:
        raise SystemExit("PORTAL_USER / PORTAL_PASS belum diset di environment.")
    hasil = minta(
        f"{BASE}/api/v1/auth/login",
        {"identifier": pengguna, "password": sandi},
    )
    token = (hasil.get("data") or {}).get("accessToken")
    if not token:
        raise SystemExit("Login berhasil tapi tidak ada accessToken di balasan.")
    return token


def status_dari(item: dict, ambang: dict) -> str:
    """
    Ubah angka jadi status. Dipanggil sekali per baris, dan hanya hasilnya
    yang ikut ke berkas keluaran.
    """
    stok = item.get("current_stock") or 0
    if stok <= 0:
        return "habis"

    # Ambang mutlak: produk yang jarang laku punya days_of_stock raksasa
    # (999 bila avg_daily 0), padahal fisiknya tinggal beberapa potong.
    if stok <= ambang.get("menipis_qty", 5):
        return "menipis"

    min_stock = item.get("min_stock") or 0
    if min_stock > 0 and stok <= min_stock:
        return "menipis"

    if (item.get("avg_daily") or 0) > 0:
        if (item.get("days_of_stock") or 0) <= ambang.get("menipis_hari", 14):
            return "menipis"

    return "aman"


def main() -> int:
    config = json.loads(BERKAS_CONFIG.read_text(encoding="utf-8"))
    ambang = config.get("ambang", {})
    periode = int(config.get("periode_hari", 30))

    token = masuk()
    laporan = minta(
        f"{BASE}/wms/api/reports/product-analytics?period_days={periode}",
        token=token,
    )
    semua = laporan.get("items", [])

    # Sheet adalah sumber kebenaran daftar centang bila tersedia; berkas hanya cadangan.
    dari_sheet = ambil_daftar_dari_sheet(semua, config.get("sku", {}))
    if dari_sheet is not None:
        daftar, sku_baru = dari_sheet
        config["sku"] = daftar
        BERKAS_CONFIG.write_text(
            json.dumps(config, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
        )
        sumber_daftar = "Google Sheets"
        if sku_baru:
            # Jangan bilang "belum dicentang" di sini: saat pindah dari berkas ke
            # Sheet, sebagian baris baru justru langsung tercentang karena membawa
            # keadaan lama. Yang masuk tanpa centang hanya yang benar-benar baru.
            tanpa_centang = [s for s in sku_baru if not (daftar.get(s) or {}).get("tampil")]
            print(f"+ {len(sku_baru)} SKU ditambahkan ke Sheet"
                  + (f", {len(tanpa_centang)} di antaranya tanpa centang" if tanpa_centang else "")
                  + f": {', '.join(sku_baru[:15])}"
                  + (f" … (+{len(sku_baru) - 15} lagi)" if len(sku_baru) > 15 else ""))
    else:
        daftar = config.get("sku", {})
        sumber_daftar = "sku-tampil.json"

    keluar, terpakai = [], set()
    for it in semua:
        sku = it.get("sku")
        aturan = daftar.get(sku)
        # Daftar-izin: SKU yang belum didaftarkan tidak ditampilkan. SKU baru di
        # WMS karena itu tidak pernah bocor duluan sebelum sempat ditinjau.
        if not aturan or not aturan.get("tampil"):
            continue
        terpakai.add(sku)
        keluar.append({
            "sku": sku,
            "nama": aturan.get("nama_tampil") or it.get("nama") or sku,
            "kategori": aturan.get("kategori") or "Lainnya",
            "varian": it.get("varian") or "",
            "size": it.get("size") or "",
            "status": status_dari(it, ambang),
            "laris": it.get("classification") == "fast",
            "restock": None,
        })

    keluar.sort(key=lambda x: (x["sku"], x["varian"], x["size"]))

    hasil = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "mode": "status",
        "sumber": "wms",
        "items": keluar,
    }
    BERKAS_KELUAR.parent.mkdir(parents=True, exist_ok=True)
    BERKAS_KELUAR.write_text(
        json.dumps(hasil, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )

    diminta = {s for s, a in daftar.items() if a.get("tampil")}
    hilang = sorted(diminta - terpakai)
    belum = sorted(s for s in {it.get("sku") for it in semua} if s not in diminta)

    print(f"WMS   : {len(semua)} baris produk")
    print(f"Daftar: {sumber_daftar} — {len(diminta)} SKU dicentang dari {len(daftar)}")
    print(f"Tampil: {len(keluar)} baris dari {len(terpakai)} SKU")
    n = sum(1 for i in keluar if i["status"] == "aman")
    print(f"Status: aman {n}, menipis {sum(1 for i in keluar if i['status']=='menipis')}, "
          f"habis {sum(1 for i in keluar if i['status']=='habis')}")
    if hilang:
        print(f"! Dicentang tapi tidak ada di WMS: {', '.join(hilang)}")
    if belum:
        print(f"! Tidak dicentang, disembunyikan ({len(belum)}): {', '.join(belum)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
