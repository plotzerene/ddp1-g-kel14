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
        """Masuk lewat SSO UI. Hanya email @ui.ac.id yang diterima, lalu is_ui_student=True."""
        raise NotImplementedError

    def generate_reset_token(self, email: str) -> str:
        """Buat token reset password sekali pakai untuk email yang terdaftar."""
        raise NotImplementedError
