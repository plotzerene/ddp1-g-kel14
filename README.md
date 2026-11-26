# titiket.com: Pemesanan Tiket + Visualizer POV 3D

Proyek Authentic Assessment **Dasar-Dasar Pemrograman 1** (kelompok 14). Aplikasi Flask untuk membeli
tiket bioskop (Cinema XXI) dan konser (Coldplay di GBK), melihat pandangan dari kursi itu dalam 3D,
lalu checkout. Perhitungan geometri, halangan kepala, akustik, skor, dan rekomendasi dilakukan oleh
Python. JavaScript hanya menggambar hasilnya.

## Menjalankan

Butuh Python 3.10 atau lebih baru. Dependensi pihak ketiga hanya Flask.

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Buka alamat yang tercetak di terminal, biasanya `http://127.0.0.1:5000`. Di macOS port 5000 sering
dipakai AirPlay Receiver, jadi `run.py` otomatis pindah ke port kosong berikutnya
(atau `PORT=8000 python run.py`).

## Menguji

```bash
python -m unittest discover -s tests          # tanpa dependensi tambahan
pytest tests/                                  # hasil yang sama, bila pytest terpasang
```

## Peta folder

| Folder | Isi |
|---|---|
| `app/` | aplikasi Flask: blueprint `landing`, `events`, `visualizer`, `checkout`, `auth`, `intro` |
| `app/static/css/` | `tokens.css` (token desain), `liquid_glass.css` (material Apple Liquid Glass), CSS per halaman |
| `engines/` | modul domain: autentikasi, makanan, pembayaran, dan e-tiket PDF |
| `tests/` | tes halaman, mesin POV, kunci kursi, tema, dan video promo |
| `reference_assets/` | aset desain dan media; file FigCraft `TiketPOV_Recreated.figcraft` jadi acuan tampilan |

## Halaman utama

| Alamat | Isi |
|---|---|
| `/` dan `/home` | beranda: hero dengan globe tur dunia, katalog film dan konser |
| `/intro` | pembuka sinematik dengan parallax mouse |
| `/movie/<slug>` | detail film dengan modal trailer |
| `/event/coldplay/overview` | detail konser Coldplay |
| `/visualizer/studio/<venue_id>` | peta kursi 2D dan POV 3D |
| `/checkout/` | data penonton per kursi, ringkasan biaya, metode pembayaran |
| `/profile` | pesanan saya: menunggu pembayaran, riwayat, buku alamat |
