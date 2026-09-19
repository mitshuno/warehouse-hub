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

Kredensial dibaca dari environment (GitHub Actions secret), tidak pernah dari berkas:
  PORTAL_USER, PORTAL_PASS, dan opsional PORTAL_BASE.

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
    daftar = config.get("sku", {})

    token = masuk()
    laporan = minta(
        f"{BASE}/wms/api/reports/product-analytics?period_days={periode}",
        token=token,
    )
    semua = laporan.get("items", [])

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
    baru = sorted({it.get("sku") for it in semua} - set(daftar))

    print(f"WMS  : {len(semua)} baris produk")
    print(f"Tampil: {len(keluar)} baris dari {len(terpakai)} SKU")
    n = sum(1 for i in keluar if i["status"] == "aman")
    print(f"Status: aman {n}, menipis {sum(1 for i in keluar if i['status']=='menipis')}, "
          f"habis {sum(1 for i in keluar if i['status']=='habis')}")
    if hilang:
        print(f"! Didaftarkan tapi tidak ada di WMS: {', '.join(hilang)}")
    if baru:
        print(f"! SKU baru di WMS, belum didaftarkan (disembunyikan): {', '.join(baru)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
