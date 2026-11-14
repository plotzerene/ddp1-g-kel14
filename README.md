# titiket.com: Pemesanan Tiket + Visualizer POV 3D

Proyek Authentic Assessment **Dasar-Dasar Pemrograman 1**. Aplikasi Flask untuk membeli tiket
bioskop (Cinema XXI: Regular, The Premiere, IMAX, 4DX) dan konser (Coldplay di GBK), melihat
pandangan dari kursi itu dalam 3D, lalu checkout.

Semua perhitungan geometri, halangan kepala, akustik, skor, dan rekomendasi dilakukan
**Python**. JavaScript hanya menggambar hasilnya.

## Menjalankan

Butuh Python 3.10 atau lebih baru. Satu-satunya dependensi pihak ketiga adalah Flask.

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Buka alamat yang tercetak di terminal, biasanya `http://127.0.0.1:5000`.

- **macOS:** port 5000 sering dipakai AirPlay Receiver. `run.py` otomatis pindah ke port
  kosong berikutnya dan mencetak alamatnya. Bisa juga `PORT=8000 python run.py`.
- Saat start, isi `reference_assets/` disalin ke `app/static/reference_assets/` dengan nama
  yang dirapikan. Folder salinan itu tidak ikut di-commit.
- Aset yang belum ada tidak membuat error. Video diganti animasi, foto diganti keterangan.

### Halaman utama

| Alamat | Isi |
|---|---|
| `/` | landing: katalog film dan konser, promo, studio |
| `/intro` | pembuka sinematik: parallax mouse, lalu gerbang masuk |
| `/movie/<slug>` | detail film dari `movies_catalog.json`, dengan modal trailer |
| `/event/coldplay/overview`, `/tickets`, `/terms` | detail konser Coldplay dengan tiga tab |
| `/visualizer/studio/<venue_id>` | peta kursi 2D dan POV 3D |
| `/checkout/` | ringkasan pesanan dan pembayaran simulasi |

Tema terang dan gelap bisa diganti lewat tombol di header. Pilihan disimpan di browser.

## Tes otomatis

```bash
python -m unittest discover -s tests -v
```

Tes ada di folder `tests/`:

| File | Yang diuji |
|---|---|
| `test_engine.py` | mesin Python: geometri, halangan, akustik, skor, rekomendasi, route, dan API |
| `test_theme.py` | tombol tema, token terang dan gelap, dan skrip penyimpan pilihan |
| `test_pages.py` | intro, detail film, detail konser, placeholder auth, dan judul film |
| `test_handoff.py` | stub folder `engines/`, modal trailer, CSS tema terang, dan README ini |

Jalankan tes setiap kali selesai mengubah kode, sebelum commit dan sebelum membuka Pull Request.

## Struktur folder

```text
run.py                          titik masuk server
requirements.txt                hanya Flask
reference_assets/               foto, video, dan logo sumber (asli)
movies_catalog.json             data 6 film: judul, sinopsis, rating, spesifikasi
tests/                          tes otomatis
engines/                        kerangka modul untuk anggota tim (lihat bagian di bawah)
app/
├── __init__.py                 app factory, mendaftarkan blueprint                 [BERSAMA]
├── shared_state.py             harga, katalog acara, keranjang tiket               [BERSAMA]
├── assets_sync.py              penyalin aset referensi                             [BERSAMA]
├── templates/base.html         layout, header, tombol tema, placeholder auth       [BERSAMA]
├── templates/_icons.html       sprite ikon SVG                                     [BERSAMA]
├── static/css/tokens.css       design token: warna, font, spasi, mode terang/gelap [BERSAMA]
├── blueprints/
│   ├── landing/                halaman depan, katalog, promo
│   ├── intro/                  halaman /intro (parallax dan gerbang masuk)
│   ├── events/                 detail film (/movie) dan detail konser (/event)
│   ├── visualizer/             peta 2D, POV 3D, mesin Python, JSON API
│   │   ├── routes.py
│   │   ├── models/             base_venue.py, cinema_xxi.py, concert_gbk.py
│   │   ├── engine/             geometry_3d, obstruction, acoustics, sightline_ai, pov_engine
│   │   └── templates/visualizer/studio_pov.html
│   └── checkout/               ringkasan, pembayaran, e-tiket
└── static/
    ├── css/                    tokens, theme-light, auth, intro, detail, landing,
    │                           visualizer, checkout
    └── js/                     intro, auth_modal, movie_trailer, theme, landing,
                                map_2d_picker, pov_3d_three, visualizer_app
```

File bertanda **[BERSAMA]** dipakai banyak modul. Ubahnya lewat Pull Request yang disetujui
semua anggota.

## Pembagian tugas dan cabang Git

| Modul | Pemilik | Folder yang boleh diubah bebas | Cabang yang disarankan |
|---|---|---|---|
| Arsitektur, 3D, dan tema | Lead Architect | `app/blueprints/visualizer/**`, `app/static/js/pov_3d_three.js`, `app/static/js/visualizer_app.js`, `app/static/css/visualizer.css`, `app/static/css/theme-light.css`, `app/static/css/intro.css`, `app/blueprints/intro/**` | `lead/<fitur>` |
| Auth dan database | Teman A | `engines/auth_engine.py`, `app/blueprints/auth/**` (dibuat Teman A), `app/static/css/auth.css`, `app/static/js/auth_modal.js` | `auth/<fitur>` |
| Makanan, pembayaran, dan e-tiket PDF | Teman B | `engines/food_engine.py`, `engines/payment_engine.py`, `engines/ticket_pdf_engine.py`, `app/blueprints/checkout/**`, `app/static/css/checkout.css` | `food/<fitur>`, `payment/<fitur>`, `ticket/<fitur>` |
| Landing dan katalog | Anggota lain | `app/blueprints/landing/**`, `app/static/css/landing.css`, `app/static/js/landing.js` | `landing/<fitur>` |

Aturan kerja:
- Setiap orang hanya mengubah folder miliknya. Konflik hanya mungkin di file **[BERSAMA]**.
- Kalau perlu menyentuh file bersama, kabari grup dulu.
- Sebelum commit, jalankan tes. Tes yang gagal tidak boleh masuk `main`.

## Kontrak folder `engines/`

Folder `engines/` berisi kerangka yang sudah memiliki kelas, fungsi, dan docstring. Isinya
belum diimplementasikan. Metode yang belum diisi melempar `NotImplementedError`, jadi tes
tetap lulus sampai modulnya selesai.

| File | Pemilik | Yang harus diisi |
|---|---|---|
| `auth_engine.py` | Teman A | `AuthManager`: `register_user`, `login_user`, `verify_sso_ui`, `generate_reset_token`. Gunakan SQLite dan `werkzeug.security`. SSO UI mengenali email @ui.ac.id. |
| `food_engine.py` | Teman B | `MENU` dari data titiket.food, `FoodCart`, dan `find_item`. Keranjang makanan terpisah dari keranjang tiket. |
| `payment_engine.py` | Teman B | `create_virtual_account`. Nomor VA harus unik per pesanan dan bisa diuji. |
| `ticket_pdf_engine.py` | Teman B | `render_ticket_pdf` dengan ReportLab. Tambahkan ReportLab ke `requirements.txt` saat mulai dikerjakan. |

Setelah modul selesai, hubungkan ke route lewat blueprint masing-masing, lalu tambahkan tes
di `tests/`. Ganti stub yang diuji dengan perilaku sebenarnya di `test_handoff.py`.

## Kontrak antar-modul (`app/shared_state.py`)

- `EVENTS`: katalog acara untuk landing. Tiap acara punya daftar `venue_id`.
- `TICKET_PRICES`: satu-satunya sumber harga tiket.
- `Cart()`: keranjang tiket di session Flask. Visualizer menulis, checkout membaca.

```python
from app.shared_state import Cart, EVENTS, format_rupiah

for item in Cart().items():          # list CartItem
    item.seat_label                  # "CAT 3 · Baris 14 · Kursi 188"
    item.price                       # 3250000
    item.pov["score"]                # skor sightline, juga distance_m, obstruction_pct, audio_delay_ms
```

Tautan antar-halaman:

```jinja
<a href="{{ url_for('visualizer.studio', venue_id='xxi-imax') }}">Pilih Kursi & Lihat 3D POV</a>
<a href="{{ url_for('checkout.index') }}">Checkout</a>
<a href="{{ url_for('intro.index') }}">Masuk Pengalaman Sinematik</a>
```

`venue_id` yang tersedia: `xxi-regular`, `xxi-premiere`, `xxi-imax`, `xxi-4dx`, `gbk-coldplay`.

Template baru cukup `{% extends "base.html" %}`, lalu `{% set step = "landing" %}`
(atau `"checkout"`), dan isi `{% block content %}`. Pakai variabel `var(--color-...)` dari
`tokens.css`, jangan menulis warna hex langsung di komponen.

Data film ada di `movies_catalog.json`. Untuk memutar trailer di modal, isi `embed_id` (ID video
YouTube) pada film yang bersangkutan. Modal akan menampilkan "Trailer belum tersedia." selama
`embed_id` kosong.

## Alur kerja Git

Setup awal (sekali, oleh satu orang):

```bash
git init
git add .
git commit -m "Baseline titiket.com"
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
git checkout main && git pull                 # ambil perubahan terbaru
git checkout -b auth/login-sqlite             # branch: <modul>/<fitur>
# ...ubah file di folder milikmu saja...
python -m unittest discover -s tests          # pastikan tidak ada yang rusak
git add engines/auth_engine.py tests/
git commit -m "auth: login dengan SQLite"
git push -u origin auth/login-sqlite
```

Lalu buka Pull Request ke `main` dan minta satu anggota lain me-review. Jangan langsung
push ke `main`.

## Rubrik penilaian

Bagian ini belum terisi. Dokumen rubrik resmi dari dosen tidak tersimpan di repositori.
Salin poin-poin rubrik ke sini, lalu tandai bagian mana yang sudah dipenuhi dan oleh siapa.

## Konsep Python yang dipakai

- **OOP:** `abc.ABC` dan `@abstractmethod` (`Venue`, `SeatNode`, `TargetStage`, `ObstructionModel`,
  `RecommendationStrategy`), inheritance (`CinemaStudio` ke 4 studio, `CinemaSeat` ke
  `ReclinerSeat` dan `MotionSeat`), polimorfisme, `@dataclass(frozen=True)`, `Enum`, dan type hints.
- **Geometri 3D** (`geometry_3d.py`): vektor, jarak Euclidean, yaw dan pitch, sudut pandang layar,
  uji potong garis ke kotak untuk pilar panggung.
- **Antropometri dan halangan** (`obstruction.py`): tinggi mata dari tinggi badan, nilai C,
  model kerumunan berlapis untuk area berdiri.
- **Akustik** (`acoustics.py`): cepat rambat bunyi, hukum kuadrat terbalik, line array,
  RT60 Sabine, jarak kritis, gema dengan metode sumber cermin.
- **Skor dan rekomendasi** (`sightline_ai.py`): skor berbobot 0 sampai 100 dan pola Strategy per preset.

## API visualizer

| Method dan path | Fungsi |
|---|---|
| `GET /visualizer/studio/<venue_id>` | halaman peta 2D dan POV 3D |
| `GET /visualizer/api/venues/<venue_id>/layout` | geometri venue: kursi, layar, blok, penghalang |
| `POST /visualizer/api/pov` | kursi dan tinggi badan menjadi kamera, halangan, akustik, dan skor |
| `POST /visualizer/api/recommend` | 3 kursi terbaik untuk satu preset |
| `GET /visualizer/api/venues/<venue_id>/heatmap` | skor semua kursi kandidat |
| `GET` dan `POST /visualizer/api/cart`, `POST /visualizer/api/cart/remove` | keranjang |

Contoh:

```bash
curl -X POST http://127.0.0.1:5000/visualizer/api/pov \
  -H "Content-Type: application/json" \
  -d '{"venue_id": "xxi-imax", "selector": {"seat_id": "D11"}, "body_height_cm": 165}'
```

## Catatan tata letak

- Baris **A adalah baris paling belakang**, mengikuti konvensi Cinema XXI. Layar ada di sisi atas peta.
- Tata letak GBK mengikuti peta kategori resmi dan foto panggung: dua LED bundar di sisi dan
  satu LED setengah lingkaran di tengah. CAT 7 dan CAT 8 adalah restricted view di samping
  panggung, sehingga kategori terjauh adalah CAT 6 (sekitar 185 sampai 205 m).
- E-ticket di halaman checkout memakai pola kotak dekoratif dari hash kode tiket, bukan QR
  yang bisa dipindai. Pembayaran hanya simulasi.
- Scene 3D tetap gelap di kedua mode tema, sebagai mode bioskop.
