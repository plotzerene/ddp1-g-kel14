# Panduan Handoff Tim Pengembangan Backend (`PANDUAN_TIM.md`)

Dokumen ini adalah panduan teknis resmi untuk **Teman A** dan **Teman B** dalam melanjutkan pengembangan backend aplikasi web **titiket.com** hingga siap dinilai pada **Authentic Assessment Dasar-Dasar Pemrograman 1 (Fasilkom UI)**.

***

## 1. Ringkasan Status Proyek & Arsitektur

Seluruh fondasi antarmuka pengguna (UI/UX FigCraft), mesin kalkulasi 3D/akustik, dan proteksi konkurensi pemesanan kursi sudah selesai dibangun pada cabang `main`. Saat dokumen ini disusun, seluruh **88 unit test aktif** (melampaui target awal 80 unit test) telah berjalan dan berstatus **LULUS (hijau)** pada berkas berikut:

• `tests/test_engine.py` : Pengujian geometri 3D (`geometry_3d.py`), antropometri & halangan pandang (`obstruction.py`), akustik (`acoustics.py`), skor & rekomendasi kursi (`sightline_ai.py`), serta API visualizer.
• `tests/test_seat_lock.py` : Pengujian mesin penguncian kursi 10 menit (`SeatLockStore` dengan `LOCK_SECONDS = 600` di `app/blueprints/visualizer/engine/seat_lock.py`) dan integrasi keranjang.
• `tests/test_theme.py` : Sistem dual tema Terang (`#FFFFFF` / `#F8FAFC`) dan Gelap (`#0B0F17` / `#161F30`), `tokens.css`, `theme-light.css`, dan `theme.js`.
• `tests/test_pages.py` : Halaman pembuka sinematik `/intro`, landing `/`, detail film `/movie/<slug>`, detail konser `/event/coldplay/*`, pemisahan studio film vs stadion konser, modal trailer, responsivitas multi-device, dan HUD fullscreen 3D.
• `tests/test_handoff.py` : Kontrak stub `engines/` yang saat ini melempar `NotImplementedError` hingga diimplementasikan oleh rekan tim.

### Yang Sudah Berfungsi Penuh

• **Sistem Tema Dual-Mode**: Light Mode & Dark Mode terintegrasi penuh pada `app/static/css/tokens.css`, `app/static/css/theme-light.css`, dan `app/static/js/theme.js`.
• **Visualizer 3D POV (`Three.js` + Python Engine)**: Simulasi sudut pandang nyata untuk 4 tipe studio Cinema XXI (`xxi-regular`, `xxi-premiere`, `xxi-imax`, `xxi-4dx`) dan stadion konser (`gbk-coldplay`) melalui `app/blueprints/visualizer/`.
• **Seat Locking 10 Menit**: `SeatLockStore` menjaga satu kursi tidak dapat direbut pembeli lain selama 600 detik dan otomatis melepaskannya ketika waktu kunci habis.
• **Antarmuka Lengkap**: Halaman `/intro`, `/` (katalog, cari, promo, kategori, modal info cepat), `/movie/<slug>` (pemilih tanggal, bioskop, studio per film, trailer modal), `/event/coldplay/*`, dan `/checkout/` (form pembeli, 12 kanal pembayaran resmi, pratinjau e-tiket).

### Posisi Tugas Teman A & Teman B

Teman A dan Teman B bertugas **mengimplementasikan logika backend Python** pada direktori `engines/`, merancang persistensi **SQLite (`instance/titiket.db`)**, menyambungkan form & endpoint frontend yang sudah terpasang ke backend melalui Flask Blueprints, serta melengkapi pengujian unit agar sistem autentikasi, F&B, pembayaran, dan e-tiket PDF berjalan utuh end-to-end.

### Peta File Bersama (`[BERSAMA]`)

Berkas berikut dipakai lintas modul. Koordinasikan di grup sebelum mengubahnya melalui Pull Request ke `main`:

| Berkas | Peran Bersama |
|---|---|
| `app/__init__.py` | Application factory `create_app()` untuk mendaftarkan blueprint |
| `app/shared_state.py` | Kontrak bersama `EVENTS`, `TICKET_PRICES`, `Cart`, `CartItem`, dan `format_rupiah` |
| `app/templates/base.html` | Layout global, navbar, modal autentikasi, dan injeksi `sso_ui_login_url` |
| `app/static/css/tokens.css` | Design tokens warna, font, spasi, dan container |
| `requirements.txt` | Daftar dependensi Python (tambahkan `reportlab` saat modul PDF dikerjakan) |

***

## 2. Pembagian Tugas: Teman A (Modul Autentikasi, Database User & SSO UI)

• **Cabang Git**: `feat/sso-ui-auth` (cabang sudah tersedia di repositori)
• **File Kerja Utama**:
  • `engines/auth_engine.py`
  • Blueprint baru `app/blueprints/auth/` (`__init__.py` dan `routes.py`), lalu daftarkan pada `app/__init__.py`
  • Integrasi handler form di `app/static/js/auth_modal.js` & `app/templates/base.html`
  • Database SQLite: `instance/titiket.db`
• **Target Pengujian TDD**:
  • Buat berkas `tests/test_sso_auth.py` berisi **12 unit test** (mulai dari status gagal/merah hingga seluruh 12 test berstatus **hijau/lulus**).
  • Perbarui `test_auth_stubs_raise_until_implemented` di `tests/test_handoff.py` setelah stub diganti implementasi nyata.

### Rincian Tugas Backend (Teman A)

#### a. Perancangan Database SQLite (`instance/titiket.db`)

Gunakan modul standar `sqlite3` (tanpa ORM eksternal) dan inisialisasi skema tabel secara otomatis saat `AuthManager.__init__(self, db_path: str)` atau koneksi pertama dibuka. Buat tabel `users`:

| Kolom | Tipe & Constraint | Keterangan |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | ID unik pengguna |
| `email` | `TEXT UNIQUE NOT NULL` | Email login (case-insensitive / dinormalisasi huruf kecil) |
| `password_hash` | `TEXT NOT NULL` | Hash sandi hasil `werkzeug.security.generate_password_hash` |
| `full_name` | `TEXT NOT NULL` | Nama lengkap pengguna |
| `npm` | `TEXT` | Nomor Pokok Mahasiswa (opsional untuk akun reguler, diisi untuk akun UI) |
| `is_ui_student` | `BOOLEAN DEFAULT 0` | `1` (`True`) jika terverifikasi mahasiswa UI (`@ui.ac.id`), `0` jika reguler |
| `created_at` | `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` | Waktu pembuatan akun |

Wajib gunakan `werkzeug.security`:
• Simpan sandi hanya melalui `generate_password_hash(password)`.
• Validasi saat masuk hanya melalui `check_password_hash(password_hash, password)`.

#### b. Logika Autentikasi Reguler (`engines/auth_engine.py`)

Perhatikan kerangka yang sudah tersedia di `engines/auth_engine.py` (memiliki kelas `AuthError`, dataclass `User`, dan `AuthManager`):

1. `register_user(email, password, full_name)`:
   • Di stub awal bernama `register_user(self, email: str, password: str, name: str) -> User` (pastikan mendukung parameter `full_name` atau mempertahankan kompatibilitas dengan `name` agar kontrak awal tetap terjaga).
   • Validasi format email, panjang password minimal 8 karakter, dan cek duplikasi email. Lempar `AuthError` apabila email sudah terdaftar atau input tidak valid.
   • Hash password dengan `generate_password_hash`, simpan ke tabel `users`, dan kembalikan objek `User`.
2. `login_user(email, password)`:
   • Ambil baris user berdasarkan email, verifikasi memakai `check_password_hash`. Jika tidak cocok, lempar `AuthError`.
   • Di lapisan rute (`app/blueprints/auth/routes.py`), simpan identitas user ke Flask `session` (misalnya `session["user_id"]`, `session["user_email"]`, `session["user_name"]`, dan `session["is_ui_student"]`).
3. `generate_reset_token(email)` & `reset_password(token, new_password)`:
   • Buat token sekali pakai yang aman (misalnya via `secrets.token_urlsafe(32)`) lengkap dengan batas kedaluwarsa (simpan di tabel SQLite terpisah seperti `password_reset_tokens` atau struktur penyimpanan token yang persisten).
   • Saat `reset_password(token, new_password)` dipanggil, validasi token belum dipakai dan belum kedaluwarsa, perbarui `password_hash` pada tabel `users`, lalu hanguskan token tersebut.

#### c. Autentikasi Kampus (SSO UI) & Diskon Mahasiswa 15%

**Catatan Frontend Saat Ini**:
Di `app/templates/base.html`, modal autentikasi (`#auth-modal`) sudah terpasang lengkap untuk tab **Masuk** (`action="/auth/login"`), **Daftar** (`action="/auth/register"`), **Lupa Kata Sandi** (`action="/auth/forgot-password"`), dan **Reset Kata Sandi** (`action="/auth/reset-password"`), dilengkapi logo resmi Makara UI (`makara_ui.png`). Tombol CTA *"Masuk dengan SSO UI"* saat ini mengarahkan pengguna ke tautan resmi CAS UI (`{{ sso_ui_login_url }}` menuju `https://sso.ui.ac.id/cas2/login?service=...`). Sementara itu, `app/static/js/auth_modal.js` masih mencegat `submit` dengan `event.preventDefault()` dalam mode pratinjau UI sampai rute `/auth/*` aktif.

Tugas integrasi Teman A di backend dan penghubung UI:

1. Validasi Domain & Verifikasi SSO (`verify_sso_email` / `verify_sso_ui`):
   • Sediakan fungsi `verify_sso_email(email)` (dan sambungkan dengan `AuthManager.verify_sso_ui(ui_email)` yang sudah ada di stub `engines/auth_engine.py`).
   • Wajib memvalidasi secara ketat bahwa email berakhiran domain resmi `@ui.ac.id` (contoh ditolak: `@gmail.com`, `@ui.ac.id.fake.com`).
   • Jika terhubung ke alur CAS ticket callback (`/auth/sso/callback`) maupun alur verifikasi email kampus + OTP simulasi, pastikan akun otomatis tercatat di tabel `users` dengan `is_ui_student = 1`.
2. Mekanisme Simulasi OTP 6-Digit (untuk pengujian lokal luring tanpa server CAS eksternal):
   • `issue_otp(email)`: Hasilkan kode OTP acak 6 digit (`000000` sampai `999999`) memakai modul `secrets`, simpan masa berlaku (misal 5 menit) di memori/SQLite, dan validasi bahwa email berakhiran `@ui.ac.id`.
   • `validate_otp(email, code)`: Verifikasi kecocokan kode OTP, pastikan belum kedaluwarsa, dan hapus OTP setelah sekali berhasil dipakai.
3. Logika Sesi & Diskon Mahasiswa 15%:
   • Ketika autentikasi SSO UI berhasil, set `session["is_ui_student"] = True`.
   • Buat fungsi `apply_student_discount(price, is_ui_student)` yang otomatis memotong **15%** dari harga dasar tiket apabila `is_ui_student` bernilai `True`.
   • **Aturan penting**: Potongan 15% hanya dihitung dari **harga dasar tiket** (`subtotal`), **TIDAK** memotong biaya admin, pajak hiburan, convenience fee, maupun item F&B (`titiket.food`).
4. Sambungkan Modal Frontend:
   • Buat blueprint `auth_bp` di `app/blueprints/auth/routes.py` untuk menangani `POST /auth/login`, `POST /auth/register`, `POST /auth/forgot-password`, `POST /auth/reset-password`, rute logout, serta endpoint verifikasi/callback SSO UI.
   • Perbarui `app/static/js/auth_modal.js` agar submit form mengirim `fetch` JSON atau POST ke endpoint Flask `/auth/*`, menampilkan `AuthError` bila gagal, dan memperbarui status pill akun & lencana diskon SSO UI di header (`#sso-footer-badge`).

#### d. Checklist 12 Target Unit Test Teman A (`tests/test_sso_auth.py`)

Susun 12 unit test independen di `tests/test_sso_auth.py` mencakup skenario berikut:
1. Pembuatan tabel `users` otomatis pada SQLite.
2. Registrasi user baru berhasil menyimpan hash sandi (bukan teks polos).
3. Registrasi gagal melempar `AuthError` untuk email duplikat.
4. Registrasi gagal melempar `AuthError` untuk format email atau panjang sandi tidak valid.
5. Login berhasil mengembalikan objek `User` sesuai email & sandi benar.
6. Login gagal melempar `AuthError` saat email tidak ditemukan atau sandi salah.
7. `generate_reset_token` menghasilkan token valid dan `reset_password` mengubah hash sandi serta menghanguskan token lama.
8. `verify_sso_email` & `verify_sso_ui` menerima `@ui.ac.id` dan menolak domain non-UI (termasuk spoofed domain).
9. `issue_otp` menghasilkan kode numerik tepat 6 digit untuk email `@ui.ac.id`.
10. `validate_otp` berhasil untuk kode cocok dan gagal untuk kode salah atau sekali pakai ulang.
11. `apply_student_discount` memotong tepat 15% saat `is_ui_student=True` dan 0% saat `False`.
12. Integrasi Flask route `/auth/*` mengisi `session["is_ui_student"] = True` saat login SSO UI berhasil.

***

## 3. Pembagian Tugas: Teman B (Modul F&B, Pembayaran, & Generator PDF E-Tiket)

• **Cabang Git**: `feat/ticket-pdf-engine` (cabang sudah tersedia di repositori)
• **File Kerja Utama**:
  • `engines/food_engine.py`
  • `engines/payment_engine.py`
  • `engines/ticket_pdf_engine.py`
  • `app/blueprints/checkout/routes.py` beserta template di `app/blueprints/checkout/templates/checkout/`
  • Database SQLite: `instance/titiket.db`
• **Target Pengujian TDD**:
  • Buat berkas `tests/test_ticket_pdf.py` berisi **7 unit test** (dari status merah menjadi seluruhnya **hijau/lulus**).
  • Perbarui `test_food_stubs_raise_until_implemented` dan `test_payment_and_pdf_stubs_raise_until_implemented` di `tests/test_handoff.py` setelah stub diganti implementasi nyata.

### Rincian Tugas Backend (Teman B)

#### a. Perancangan Database SQLite untuk Transaksi (`instance/titiket.db`)

Buat inisialisasi skema transaksi di `instance/titiket.db` dengan 3 tabel utama (gunakan tipe integer untuk nominal rupiah):

1. Tabel `orders`:
   • `id TEXT PRIMARY KEY` (kode order unik, mis. `ORD-8F21A9`)
   • `user_id INTEGER` (referensi opsional ke `users.id` milik Teman A atau `NULL` untuk guest checkout)
   • `order_token TEXT` (token unik pengaman akses halaman e-tiket & unduh PDF)
   • `subtotal INTEGER` (total harga dasar tiket dalam rupiah)
   • `discount INTEGER` (nominal potongan SSO UI 15% jika berlaku)
   • `admin_fee INTEGER` (total biaya admin, convenience fee, dan pajak)
   • `total_amount INTEGER` (nominal akhir termasuk F&B yang harus dibayar)
   • `payment_method TEXT` (mis. `bca`, `mandiri`, `qris`, `gopay`, dll.)
   • `va_number TEXT` (nomor Virtual Account / kode bayar ritel / payload QRIS)
   • `status TEXT` (`PENDING`, `PAID`, atau `CANCELLED`)
   • `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
   • `expires_at TIMESTAMP` (batas waktu pembayaran sebelum order kedaluwarsa)

2. Tabel `tickets`:
   • `id INTEGER PRIMARY KEY AUTOINCREMENT`
   • `order_id TEXT NOT NULL` (relasi ke `orders.id`)
   • `event_name TEXT NOT NULL`
   • `venue_type TEXT NOT NULL` (`cinema` atau `concert`)
   • `seat_id TEXT NOT NULL` (kode kursi / area berdiri, mis. `D11` atau `cat3:R14:S207`)
   • `ticket_code TEXT UNIQUE NOT NULL` (format `TTK-<ORDER_ID>-<SEAT_ID>`)

3. Tabel `food_orders`:
   • `id INTEGER PRIMARY KEY AUTOINCREMENT`
   • `order_id TEXT NOT NULL` (relasi ke `orders.id`)
   • `item_name TEXT NOT NULL`
   • `quantity INTEGER NOT NULL`
   • `price INTEGER NOT NULL` (harga satuan atau subtotal item dalam rupiah)

#### b. Modul `titiket.food` (`engines/food_engine.py`)

• Lengkapi konstanta `MENU: tuple[MenuItem, ...]` pada `engines/food_engine.py` dengan menu resmi bioskop `titiket.food`:
  • Varian Popcorn (contoh: Popcorn Caramel Large, Popcorn Salted)
  • Kudapan gurih (contoh: Truffle Fries)
  • Minuman (contoh: Iced Lemon Tea, Mineral Water)
  • Paket hemat (`Combo Pack`: popcorn + minuman)
• Implementasikan method yang ada pada `FoodCart` (`add(item_id, quantity)`, `remove(item_id)`, `total()`) serta fungsi `find_item(item_id)`.
• Sediakan fungsi pembantu tingkat aplikasi `add_food_to_cart(...)` untuk menyambungkan aksi tambah/kurang menu F&B dari UI ke Flask `session` tanpa mencemari struktur `shared_state.Cart` milik tiket, lalu gabungkan total belanja F&B ke ringkasan perhitungan di `app/blueprints/checkout/routes.py` (`compute_totals()`).

#### c. Sistem Pembayaran Multi-Channel (`engines/payment_engine.py`)

• Halaman checkout frontend (`app/blueprints/checkout/routes.py` bagian `PAYMENT_GROUPS`) sudah merender **12 kanal pembayaran resmi** lengkap dengan logonya:
  • Bank VA: `bca`, `mandiri`, `bni`, `bri`
  • QRIS & E-Wallet: `qris`, `gopay`, `ovo`, `shopeepay`, `dana`
  • Gerai Ritel: `indomaret`, `alfamart`, `alfamidi`
• Implementasikan `create_virtual_account(order_id, amount, bank)` sesuai kontrak `SUPPORTED_BANKS` (`bca`, `bni`, `bri`, `mandiri`) yang bersifat **deterministik** terhadap `order_id` agar mudah diuji ulang.
• Tambahkan fungsi `generate_payment_instruction(method, total_amount)` untuk melayani seluruh 12 metode di atas:
  • Menghasilkan nomor Virtual Account unik berbasis prefix kanal (misal `89022` + digit unik deterministik/acak aman untuk Mandiri, `88010` untuk BCA, dll.), kode ritel (`TTKT ...`), atau string payload simulasi standar QRIS.
• **Fail-Safe Timeout Penguncian Kursi 10 Menit (Wajib)**:
  • Integrasikan `SeatLockStore` yang ada di `app/blueprints/visualizer/engine/seat_lock.py` (diperoleh dari aplikasi atau registry `seat_lock_store`) ke alur `POST /checkout/pay` pada `app/blueprints/checkout/routes.py`.
  • Sebelum menandai transaksi `PAID`, periksa apakah seluruh kursi di `Cart().items()` masih terkunci sah oleh pemilik sesi saat ini (belum melewati batas `600` detik / 10 menit).
  • Apabila kunci kursi sudah habis waktunya (`expired`) atau direbut pengguna lain, batalkan proses pembayaran (`status = CANCELLED`), lepaskan kunci sisa, dan arahkan pengguna kembali ke peta kursi dengan pesan error yang jelas.

#### d. Dynamic E-Ticket PDF Engine (`engines/ticket_pdf_engine.py`)

• Tambahkan library `reportlab` (dan `Pillow` bila diperlukan modul QR/barcode ReportLab) ke `requirements.txt`, instal pada `.venv`, dan catat di `README.md`.
• Pertahankan kontrak `TicketData` dan `render_ticket_pdf(ticket: TicketData, output_path: Path) -> Path`.
• Tambahkan fungsi dan fitur PDF dinamis berikut:
  1. `build_ticket_code(order_id, seat_id)` : Mengembalikan string format standar `TTK-<ORDER_ID>-<SEAT_ID>`.
  2. **Logika Barcode vs QR Code**:
     • Jika `venue_type == "concert"` (konser stadion GBK): gambar **Barcode Code128 horizontal** menggunakan `reportlab.graphics.barcode.code128.Code128`.
     • Jika `venue_type == "cinema"` (bioskop XXI): gambar **QR Code asli** menggunakan modul `reportlab.graphics.barcode.qr.QrCodeWidget`.
     • *(Sebagai catatan integrasi, tampilan HTML di `app/blueprints/checkout/routes.py` saat ini memakai `ticket_matrix()` dekoratif untuk pratinjau halaman, sedangkan file PDF unduhan harus merender Barcode Code128 / QR Code vektor asli dari ReportLab).*
  3. `generate_ticket_pdf(order_data) -> BytesIO` : Merakit berkas PDF biner **in-memory** (`io.BytesIO`) berukuran rapi yang memuat identitas/logo `titiket.com`, nama acara, studio/venue, posisi kursi/spot, nama pemesan, lencana status **LUNAS**, rincian F&B (jika ada), serta Code128 Barcode / QR Code sesuai jenis venue.
  4. **Rute Download Flask**: Pasang route pada `checkout_bp` (misalnya `GET /checkout/ticket/<order_id>/pdf` atau `GET /checkout/ticket/pdf`) yang memanggil `generate_ticket_pdf(order_data)` dan mengirimkannya melalui:
     `send_file(pdf_stream, mimetype="application/pdf", as_attachment=True, download_name="E-Ticket.pdf")`.

#### e. Checklist 7 Target Unit Test Teman B (`tests/test_ticket_pdf.py`)

Susun 7 unit test di `tests/test_ticket_pdf.py` mencakup skenario berikut:
1. Katalog `MENU` pada `food_engine` tidak kosong, memiliki harga bulat rupiah, dan `find_item` berfungsi.
2. `FoodCart.add`, `remove`, `total`, serta validasi error untuk item tidak ada / tidak tersedia bekerja benar.
3. `create_virtual_account` deterministik untuk `order_id` yang sama dan melempar `ValueError` untuk bank tidak didukung.
4. `generate_payment_instruction` menghasilkan VA / payload QRIS valid untuk seluruh 12 metode checkout.
5. `POST /checkout/pay` gagal dan menolak transaksi saat kunci kursi 10 menit telah kedaluwarsa (`SeatLockStore` expired fail-safe).
6. `build_ticket_code(order_id, seat_id)` menghasilkan format presisi `TTK-<ORDER_ID>-<SEAT_ID>`.
7. `generate_ticket_pdf(order_data)` mengembalikan stream `BytesIO` berawalan `%PDF` lengkap (menguji cabang Barcode Code128 untuk konser dan QR Code untuk bioskop) serta rute download Flask mengembalikan `Content-Type: application/pdf`.

***

## 4. Panduan Kerja Git & Kontribusi untuk Anggota Tim

Ikuti langkah berurutan di terminal agar riwayat kontribusi di GitHub tercatat rapi, merata untuk 3 akun kontributor, dan bebas konflik cabang.

### Langkah 1: Clone Repositori dari GitHub

```bash
git clone https://github.com/<akun-organisasi-atau-pemilik>/<nama-repo>.git
cd <nama-repo>
```

### Langkah 2: Setel Identitas Git Lokal Masing-Masing

Wajib jalankan perintah ini di folder proyek agar nama dan email Anda terekam di riwayat commit GitHub sebagai bukti pemerataan kontributor:

```bash
git config user.name "Nama Lengkap Anda"
git config user.email "email_github_anda@ui.ac.id"
```

### Langkah 3: Pindah ke Cabang Fitur Masing-Masing

Jangan bekerja langsung di cabang `main`:

• **Teman A (Modul Auth, SQLite User & SSO UI)**:
  ```bash
  git checkout feat/sso-ui-auth
  ```
• **Teman B (Modul F&B, Payment, Fail-Safe Seat Lock & PDF)**:
  ```bash
  git checkout feat/ticket-pdf-engine
  ```

Jika cabang lokal tertinggal dari `main` setelah ada pembaruan bersama, sinkronkan dulu dengan aman:

```bash
git fetch origin
git merge main
```

### Langkah 4: Aktifkan Virtual Environment & Instal Dependensi

• **macOS / Linux**:
  ```bash
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
  ```
• **Windows (PowerShell / Git Bash)**:
  ```bash
  python -m venv .venv
  .venv\Scripts\activate
  pip install -r requirements.txt
  ```

Jalankan server lokal untuk uji visual di browser:

```bash
python run.py
```

*(Jika Teman B mulai mengerjakan `ticket_pdf_engine.py`, jalankan `pip install reportlab` lalu perbarui `requirements.txt`.)*

### Langkah 5: Jalankan Siklus Pengujian TDD Secara Berkala

Uji modul milik masing-masing sampai seluruh tes yang awalnya merah berubah hijau, lalu verifikasi seluruh suite proyek tetap lulus:

• **Teman A**:
  ```bash
  python -m unittest tests/test_sso_auth.py -v
  ```
• **Teman B**:
  ```bash
  python -m unittest tests/test_ticket_pdf.py -v
  ```
• **Validasi Seluruh Proyek Sebelum Commit (Wajib 100% Hijau)**:
  ```bash
  python -m unittest discover -s tests -v
  ```

### Langkah 6: Commit Mandiri & Push ke Remote Branch Sendiri

Gunakan format Conventional Commits yang jelas (contoh prefiks `feat:`, `fix:`, `test:`, `docs:`) dan hindari menyertakan nama asisten AI atau tag co-author bot pada pesan commit:

• **Contoh Teman A**:
  ```bash
  git add engines/auth_engine.py app/blueprints/auth/ tests/test_sso_auth.py
  git commit -m "feat(auth): implement sqlite user auth, sso ui verification, and 15% student discount"
  git push -u origin feat/sso-ui-auth
  ```
• **Contoh Teman B**:
  ```bash
  git add engines/food_engine.py engines/payment_engine.py engines/ticket_pdf_engine.py app/blueprints/checkout/ tests/test_ticket_pdf.py requirements.txt
  git commit -m "feat(checkout): implement fnb cart, 12-channel payment fail-safe, and reportlab pdf ticket"
  git push -u origin feat/ticket-pdf-engine
  ```

Setelah seluruh unit test pada cabang masing-masing hijau, buat **Pull Request** di GitHub menuju `main` agar seluruh anggota tim dapat melakukan code review sebelum digabung.

***

## 5. Rubrik Penilaian Authentic Assessment DDP 1

Berikut pemetaan pencapaian 6 kriteria penilaian resmi Authentic Assessment DDP 1 Fasilkom UI serta kontribusi yang harus dituntaskan Teman A dan Teman B pada bagian backend:

| Kriteria Penilaian | Bobot | Target Utama & Implementasi pada `titiket.com` | Status Saat Ini & Tindak Lanjut Tim |
|---|---|---|---|
| **1. Masalah yang Diangkat** | **20%** | Mengatasi *blind buying* saat membeli tiket bioskop maupun konser Stadion GBK (ketidakpastian jarak, sudut leher, halangan kepala/pilar, dan kenyamanan visual). | Antarmuka dan narasi solusi sudah terpasang utuh di `/`, `/intro`, `/movie/<slug>`, dan `/visualizer`. |
| **2. Solusi Unik / POV 3D** | **10%** | Visualizer interaktif 3D POV (`Three.js`) yang digabungkan dengan ekosistem pembelian terpadu termasuk pemesanan makanan (`titiket.food`). | Simulasi 3D dan heatmap selesai 100%; Teman B melengkapi fungsi backend & keranjang `titiket.food` di `engines/food_engine.py`. |
| **3. Hal Baru di Luar Kelas** | **20%** | 1) WebGL 3D & proyeksi FOV kamera, 2) State locking kursi 10 menit anti tabrakan pembeli, 3) E-Ticket PDF dinamis dengan Barcode/QR asli (`ReportLab`), 4) Integrasi/Simulasi SSO UI (`@ui.ac.id`) & diskon 15%. | 3D WebGL & `SeatLockStore` 10 menit sudah berjalan; Teman A melengkapi SSO UI & diskon 15%, Teman B melengkapi fail-safe lock di checkout + PDF ReportLab. |
| **4. Kompleksitas Program Modular** | **20%** | Arsitektur OOP Python terstruktur (`abc.ABC`, dataclass, blueprint Flask terpisah), pemisahan ketat `engines/`, database SQLite relasional (`users`, `orders`, `tickets`, `food_orders`), serta cakupan tes unit ekstensif (>80 unit test). | 88 unit test baseline lulus; Teman A & B mengimplementasikan seluruh modul `engines/`, skema SQLite, serta menambah 12 test Auth + 7 test Ticket/PDF. |
| **5. Kualitas Repositori Git** | **20%** | Commit terisolasi di cabang fitur (`feat/sso-ui-auth`, `feat/ticket-pdf-engine`), pesan Conventional Commits, dokumentasi lengkap (`README.md` & `PANDUAN_TIM.md`), serta riwayat kontribusi **3 anggota tim yang merata**. | Cabang fitur sudah disiapkan; Teman A & B wajib push commit mandiri atas akun Git masing-masing sesuai Bagian 4 panduan ini. |
| **6. Video Presentasi** | **10%** | Demonstrasi alur pengguna dari awal sampai e-tiket PDF serta penjelasan kode arsitektur Python/3D/database oleh seluruh anggota tim (maksimal 15 menit). | Direkam bersama setelah integrasi `feat/sso-ui-auth` dan `feat/ticket-pdf-engine` digabung ke `main`. |
