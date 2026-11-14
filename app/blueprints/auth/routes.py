"""
routes.py (auth) : endpoint sesi autentikasi untuk modal Login, Register, Google OAuth, dan SSO UI.
"""
from __future__ import annotations

import re
from datetime import datetime

from flask import Blueprint, jsonify, redirect, request, url_for

from ...shared_state import current_user, set_current_user

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _payload() -> dict:
    if request.is_json:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}
    return dict(request.form)


def _wants_json() -> bool:
    if request.is_json:
        return True
    accept = request.headers.get("Accept", "")
    return "application/json" in accept or request.headers.get("X-Requested-With") == "fetch"


def _make_user(name: str, email: str, provider: str) -> dict:
    clean_email = email.strip().lower()
    is_ui = provider == "SSO UI" or clean_email.endswith("@ui.ac.id")
    display_name = name.strip() or ("Mahasiswa UI" if is_ui else clean_email.split("@")[0])
    return {
        "name": display_name,
        "email": clean_email,
        "provider": provider,
        "is_ui_student": bool(is_ui),
        "logged_in_at": datetime.now().strftime("%d %b %Y · %H.%M WIB"),
    }


def _safe_next(raw_next: object) -> str:
    target = str(raw_next or "").strip()
    if target.startswith("/") and not target.startswith("//"):
        return target
    return url_for("landing.index")


@auth_bp.get("/session")
def session_state():
    user = current_user()
    return jsonify(authenticated=bool(user), user=user)


@auth_bp.post("/login")
def login():
    data = _payload()
    email = str(data.get("email", "")).strip()
    password = str(data.get("password", "")).strip()
    if not EMAIL_RE.match(email):
        return jsonify(ok=False, error="Format email belum valid."), 400
    if not password:
        return jsonify(ok=False, error="Kata sandi wajib diisi."), 400
    display = str(data.get("name", "")).strip() or email.split("@")[0]
    user = _make_user(display, email, "SSO UI" if email.lower().endswith("@ui.ac.id") else "Email")
    set_current_user(user)
    if _wants_json():
        return jsonify(ok=True, authenticated=True, user=user, next=_safe_next(data.get("next")))
    return redirect(_safe_next(data.get("next")))


@auth_bp.post("/register")
def register():
    data = _payload()
    full_name = str(data.get("full_name") or data.get("name") or "").strip()
    email = str(data.get("email", "")).strip()
    password = str(data.get("password", "")).strip()
    agree = data.get("agree_terms")
    if not EMAIL_RE.match(email):
        return jsonify(ok=False, error="Format email belum valid."), 400
    if len(password) < 8:
        return jsonify(ok=False, error="Kata sandi minimal 8 karakter."), 400
    if agree in (False, "false", "0", "off"):
        return jsonify(ok=False, error="Setujui Syarat & Ketentuan terlebih dahulu."), 400
    user = _make_user(full_name or email.split("@")[0], email, "Email")
    set_current_user(user)
    if _wants_json():
        return jsonify(ok=True, authenticated=True, user=user, next=_safe_next(data.get("next")))
    return redirect(_safe_next(data.get("next")))


@auth_bp.post("/oauth")
def oauth():
    data = _payload()
    provider = str(data.get("provider", "Google")).strip() or "Google"
    is_sso = provider.lower().startswith("sso") or provider == "SSO UI"
    default_email = "mahasiswa@ui.ac.id" if is_sso else "member@titiket.com"
    default_name = "Mahasiswa UI" if is_sso else f"Akun {provider}"
    email = str(data.get("email", "")).strip() or default_email
    name = str(data.get("name", "")).strip() or default_name
    user = _make_user(name, email, "SSO UI" if is_sso else provider)
    set_current_user(user)
    return jsonify(ok=True, authenticated=True, user=user, next=_safe_next(data.get("next")))


@auth_bp.get("/callback/ui")
def callback_ui():
    """Callback simulasi CAS SSO UI agar verifikasi kampus langsung mengaktifkan sesi."""
    ticket = request.args.get("ticket", "").strip()
    uid = request.args.get("username", "").strip() or "mahasiswa.ui"
    email = f"{uid}@ui.ac.id" if "@" not in uid else uid
    user = _make_user("Mahasiswa UI", email, "SSO UI")
    if ticket or True:
        set_current_user(user)
    return redirect(_safe_next(request.args.get("next") or url_for("landing.index")))


@auth_bp.post("/forgot-password")
def forgot_password():
    data = _payload()
    email = str(data.get("email", "")).strip()
    if not EMAIL_RE.match(email):
        return jsonify(ok=False, error="Format email belum valid."), 400
    return jsonify(ok=True, email=email, message="Instruksi reset kata sandi telah dikirim.")


@auth_bp.post("/reset-password")
def reset_password():
    data = _payload()
    new_pass = str(data.get("new_password", "")).strip()
    if len(new_pass) < 8:
        return jsonify(ok=False, error="Kata sandi baru minimal 8 karakter."), 400
    return jsonify(ok=True, message="Kata sandi berhasil diperbarui. Silakan masuk.")


@auth_bp.post("/logout")
def logout():
    set_current_user(None)
    if _wants_json():
        return jsonify(ok=True, authenticated=False, user=None)
    return redirect(url_for("landing.index"))
