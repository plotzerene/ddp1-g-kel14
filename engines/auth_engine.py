"""auth_engine.py: kerangka autentikasi (dikerjakan Teman A).

Yang harus diisi:
- Tabel users di SQLite (modul bawaan sqlite3). File database: instance/titiket.db.
- Password di-hash dengan werkzeug.security (generate_password_hash dan check_password_hash).
  Jangan pernah menyimpan password dalam bentuk teks biasa.
- SSO UI: email berdomain @ui.ac.id ditandai is_ui_student=True. Diskon 15% diterapkan
  di checkout, bukan di sini.
- Reset password: token sekali pakai dengan masa berlaku.

Kontrak:
- Kesalahan yang boleh ditampilkan ke pengguna memakai AuthError.
- Method yang belum diisi melempar NotImplementedError.
"""
from __future__ import annotations

from dataclasses import dataclass


class AuthError(Exception):
    """Kesalahan yang aman ditampilkan ke pengguna, misalnya email sudah terdaftar atau kata sandi salah."""


@dataclass(frozen=True)
class User:
    user_id: int
    email: str
    name: str
    is_ui_student: bool = False


UI_EMAIL_DOMAIN = "@ui.ac.id"
STUDENT_DISCOUNT_RATE = 0.15  # diskon 15% hanya untuk harga dasar tiket
OTP_LENGTH = 6


class AuthManager:
    """Pengelola akun. Satu instance dibuat per aplikasi dengan lokasi database."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path  # Teman A: buka koneksi dan buat tabel saat pertama kali dipakai.

    def register_user(self, email: str, password: str, name: str) -> User:
        """Daftarkan akun baru. Melempar AuthError jika email sudah terdaftar."""
        raise NotImplementedError

    def login_user(self, email: str, password: str) -> User:
        """Verifikasi email dan kata sandi. Melempar AuthError jika tidak cocok."""
        raise NotImplementedError

    def verify_sso_ui(self, ui_email: str) -> User:
        """Masuk lewat SSO UI. Hanya email @ui.ac.id yang diterima, lalu is_ui_student=True.

        TODO Teman A: panggil verify_sso_email dan issue_otp, lalu validate_otp. Setelah berhasil,
        tandai sesi is_ui_student=True, user_email, dan user_name.
        """
        raise NotImplementedError

    def verify_sso_email(self, email: str) -> bool:
        """Cek apakah email memakai domain UI (@ui.ac.id). Tidak membedakan huruf besar atau kecil.

        TODO Teman A: kembalikan True hanya jika email berakhiran UI_EMAIL_DOMAIN dan bagian
        sebelum @ tidak kosong. Domain seperti @ui.ac.id.com atau @gmail.com harus ditolak (False).
        Tidak memerlukan password akun kampus.
        """
        raise NotImplementedError

    def issue_otp(self, email: str) -> str:
        """Buat kode OTP acak dengan OTP_LENGTH digit untuk email ini.

        TODO Teman A: simpan kode beserta waktu kedaluwarsa di SQLite. Kode ditampilkan di layar
        sebagai simulasi, bukan dikirim lewat email.
        """
        raise NotImplementedError

    def validate_otp(self, email: str, code: str) -> bool:
        """Cocokkan kode OTP. Kode hanya boleh dipakai sekali dan harus belum kedaluwarsa.

        TODO Teman A: setelah kode berhasil dipakai, hapus dari penyimpanan sehingga kode kedua
        dengan nilai yang sama ditolak (False).
        """
        raise NotImplementedError

    def apply_student_discount(self, price: int, is_ui_student: bool) -> int:
        """Kembalikan harga setelah diskon mahasiswa UI untuk harga dasar tiket (rupiah, bilangan bulat).

        TODO Teman A: jika is_ui_student True, potong STUDENT_DISCOUNT_RATE dari price.
        Jika False, kembalikan price apa adanya. Diskon tidak berlaku untuk F&B dan biaya layanan,
        jadi pemanggil hanya boleh mengirim harga dasar tiket.
        """
        raise NotImplementedError

    def generate_reset_token(self, email: str) -> str:
        """Buat token reset password sekali pakai untuk email yang terdaftar."""
        raise NotImplementedError
