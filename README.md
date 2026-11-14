# TiketPOV — Pemesanan Tiket + Visualizer POV 3D

Proyek Authentic Assessment **Dasar-Dasar Pemrograman 1**. Aplikasi Flask untuk memilih
kursi bioskop (Cinema XXI: Regular, The Premiere, IMAX, 4DX) dan konser (Coldplay di GBK),
melihat pandangan dari kursi itu dalam 3D, lalu checkout.

Semua perhitungan geometri, halangan kepala, akustik, skor, dan rekomendasi dilakukan
**Python**. JavaScript hanya menggambar hasilnya.

## Menjalankan

Butuh Python 3.10 atau lebih baru.

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Buka alamat yang tercetak di terminal, biasanya `http://127.0.0.1:5000`.

- **macOS:** port 5000 sering dipakai AirPlay Receiver. `run.py` otomatis pindah ke port
  kosong berikutnya (mis. 5001) dan mencetak alamatnya. Bisa juga `PORT=8000 python run.py`.
- Saat start, isi `reference_assets/` disalin ke `app/static/reference_assets/` dengan nama
  yang dirapikan (mis. `trailer_cinema AVENGERS ENDGAME.mp4` → `videos/trailer_cinema.mp4`).
  Folder salinan itu tidak ikut di-commit.
- Aset yang belum ada tidak membuat error: video diganti animasi, foto diganti keterangan.
  Saat ini yang belum ada hanya `reference_assets/images/xxi_4dx_seats.jpg`.

Tes otomatis (37 tes: mesin Python, route, template, aset statis):

```bash
python -m unittest discover -s tests -v
```

## Struktur & pembagian kerja

```text
run.py                          titik masuk
requirements.txt                hanya Flask
reference_assets/               foto & video referensi (sumber asli)
tests/test_engine.py            tes otomatis
app/
├── __init__.py                 app factory, mendaftarkan 3 blueprint      [BERSAMA]
├── shared_state.py             harga, katalog acara, keranjang            [BERSAMA]
├── assets_sync.py              penyalin aset referensi                    [BERSAMA]
├── templates/base.html         layout + header + ikon                     [BERSAMA]
├── static/css/tokens.css       design token (warna, font, spasi)          [BERSAMA]
├── blueprints/
│   ├── landing/                [TEAMMATE 1]  halaman depan & katalog
│   │   ├── routes.py
│   │   └── templates/landing/index.html
│   ├── visualizer/             peta 2D + POV 3D + mesin Python
│   │   ├── routes.py           halaman + JSON API
│   │   ├── models/             base_venue.py, cinema_xxi.py, concert_gbk.py
│   │   ├── engine/             geometry_3d.py, obstruction.py, acoustics.py,
│   │   │                       sightline_ai.py, pov_engine.py
│   │   └── templates/visualizer/studio_pov.html
│   └── checkout/               [TEAMMATE 2]  ringkasan, pembayaran, e-ticket
│       ├── routes.py
│       └── templates/checkout/{checkout,eticket}.html
└── static/
    ├── css/landing.css         [TEAMMATE 1]
    ├── css/checkout.css        [TEAMMATE 2]
    ├── css/visualizer.css
    └── js/                     map_2d_picker.js, pov_3d_three.js, visualizer_app.js,
                                vendor/three.module.min.js
```

| Siapa | Boleh diubah bebas |
|---|---|
| Teammate 1 | `app/blueprints/landing/**`, `app/static/css/landing.css` |
| Teammate 2 | `app/blueprints/checkout/**`, `app/static/css/checkout.css` |
| Pemilik visualizer | `app/blueprints/visualizer/**`, `app/static/css/visualizer.css`, `app/static/js/*.js` |

File bertanda **[BERSAMA]** dipakai ketiga modul. Ubah lewat Pull Request yang disetujui
semua anggota.

## Kontrak antar-modul (`app/shared_state.py`)

- `EVENTS` — katalog acara untuk Landing. Tiap acara punya daftar `venue_id`.
- `TICKET_PRICES` — satu-satunya sumber harga.
- `Cart()` — keranjang di session Flask. Visualizer menulis, Checkout membaca.

```python
from app.shared_state import Cart, EVENTS, format_rupiah

for item in Cart().items():          # list CartItem
    item.seat_label                  # "CAT 3 · Baris 14 · Kursi 188"
    item.price                       # 3250000
    item.pov["score"]                # skor sightline, juga distance_m, obstruction_pct, audio_delay_ms, ...
```

Tautan antar-halaman:

```jinja
<a href="{{ url_for('visualizer.studio', venue_id='xxi-imax') }}">Pilih Kursi & Lihat 3D POV</a>
<a href="{{ url_for('checkout.index') }}">Checkout</a>
```

`venue_id` yang tersedia: `xxi-regular`, `xxi-premiere`, `xxi-imax`, `xxi-4dx`, `gbk-coldplay`.

Template baru cukup `{% extends "base.html" %}`, lalu `{% set step = "landing" %}`
(atau `"checkout"`), dan isi `{% block content %}`. Pakai kelas dari `tokens.css`
(`.btn`, `.btn--primary`, `.glass`, `.chip`, `.field`, `.input`) dan variabel
`var(--color-…)`, jangan menulis warna hex langsung.

## Alur kerja Git

Setup awal (sekali, oleh satu orang):

```bash
git init
git add .
git commit -m "Kerangka awal TiketPOV"
git branch -M main
git remote add origin https://github.com/<akun>/<repo>.git
git push -u origin main
```

Teman satu tim:

```bash
git clone https://github.com/<akun>/<repo>.git
cd <repo>
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
python run.py
```

Setiap mengerjakan fitur:

```bash
git checkout main && git pull            # ambil perubahan terbaru
git checkout -b landing/filter-acara     # branch: <modul>/<fitur>
# ...ubah file di foldermu saja...
python -m unittest discover -s tests     # pastikan tidak ada yang rusak
git add app/blueprints/landing app/static/css/landing.css
git commit -m "landing: tambah filter film/konser"
git push -u origin landing/filter-acara
```

Lalu buka Pull Request di GitHub ke `main` dan minta satu anggota lain me-review.
Selama tiap orang hanya mengubah foldernya sendiri, merge conflict tidak akan terjadi.
Konflik hanya mungkin di file **[BERSAMA]**, jadi kabari grup sebelum menyentuhnya.

## API visualizer

| Method & path | Fungsi |
|---|---|
| `GET /visualizer/studio/<venue_id>` | halaman peta 2D + POV 3D |
| `GET /visualizer/api/venues/<venue_id>/layout` | geometri venue (kursi, layar, blok, penghalang) |
| `POST /visualizer/api/pov` | kursi + tinggi badan → kamera, halangan, akustik, skor |
| `POST /visualizer/api/recommend` | 3 kursi terbaik untuk satu preset |
| `GET /visualizer/api/venues/<venue_id>/heatmap` | skor semua kursi kandidat |
| `GET` / `POST /visualizer/api/cart`, `POST /visualizer/api/cart/remove` | keranjang |

Contoh:

```bash
curl -X POST http://127.0.0.1:5000/visualizer/api/pov \
  -H "Content-Type: application/json" \
  -d '{"venue_id": "xxi-imax", "selector": {"seat_id": "D11"}, "body_height_cm": 165}'
```

## Konsep Python yang dipakai

- **OOP:** `abc.ABC` + `@abstractmethod` (`Venue`, `SeatNode`, `TargetStage`, `ObstructionModel`,
  `RecommendationStrategy`), inheritance (`CinemaStudio` → 4 studio; `CinemaSeat` →
  `ReclinerSeat`, `MotionSeat`), polimorfisme, `@dataclass(frozen=True)`, `Enum`, type hints.
- **Geometri 3D** (`geometry_3d.py`): vektor, jarak Euclidean, yaw/pitch, sudut pandang layar,
  uji potong garis–kotak untuk pilar panggung.
- **Antropometri & halangan** (`obstruction.py`): tinggi mata dari tinggi badan, C-value,
  model kerumunan berlapis untuk area berdiri.
- **Akustik** (`acoustics.py`): cepat rambat bunyi, hukum kuadrat terbalik, line array,
  RT60 Sabine, jarak kritis, gema dengan metode sumber cermin.
- **Skor & rekomendasi** (`sightline_ai.py`): skor berbobot 0–100 dan pola Strategy per preset.

## Catatan tata letak

- Baris **A = paling belakang**, mengikuti konvensi Cinema XXI. Layar ada di sisi atas peta.
- Tata letak GBK mengikuti peta kategori resmi dan foto panggung: dua LED bundar di sisi
  dan satu LED setengah lingkaran di tengah. CAT 7 dan CAT 8 adalah restricted view di
  samping panggung, sehingga kategori terjauh adalah CAT 6 (±185–205 m).
- E-ticket memakai pola kotak dekoratif dari hash kode tiket, bukan QR yang bisa dipindai.
  Pembayaran hanya simulasi.
