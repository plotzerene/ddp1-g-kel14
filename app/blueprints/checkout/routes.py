"""
routes.py (checkout) — FOLDER TEAMMATE 2.

Starter yang sudah berfungsi end-to-end:

    GET  /checkout/               ringkasan keranjang + metadata POV dari visualizer + form pembeli
    POST /checkout/remove/<i>     hapus satu tiket
    POST /checkout/clear          kosongkan keranjang
    POST /checkout/pay            validasi form → buat pesanan (simulasi) → e-ticket
    GET  /checkout/ticket         e-ticket pesanan terakhir

Keranjang dibaca lewat `Cart()` dari `shared_state.py` (kontrak bersama).

Ide pengembangan untuk Teammate 2 (cukup ubah folder ini + static/css/checkout.css):
  * kode promo / voucher, countdown batas waktu pembayaran
  * simulasi tiap metode bayar (QRIS, VA), riwayat pesanan
  * QR asli (mis. library `qrcode`) dan unduh e-ticket PDF
"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime

from flask import Blueprint, redirect, render_template, request, session, url_for

from ...shared_state import Cart, CartItem, get_event

checkout_bp = Blueprint("checkout", __name__, template_folder="templates")

ORDER_SESSION_KEY = "tiketpov_last_order"
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PAYMENT_METHODS: dict[str, str] = {
    "qris": "QRIS",
    "va": "Virtual Account Bank",
    "ewallet": "E-Wallet",
    "card": "Kartu Kredit / Debit",
}
CINEMA_ADMIN_FEE = 3_000        # per tiket bioskop
CONCERT_TAX_RATE = 0.15         # pajak pemerintah (tertulis di peta kategori resmi)
CONCERT_FEE_RATE = 0.05         # convenience fee


def compute_totals(items: list[CartItem]) -> dict:
    """Subtotal + biaya: bioskop kena biaya admin tetap, konser kena pajak 15% + fee 5%."""
    subtotal = sum(item.price for item in items)
    concert = sum(item.price for item in items if _is_concert(item))
    cinema_count = sum(1 for item in items if not _is_concert(item))
    tax = round(concert * CONCERT_TAX_RATE)
    convenience = round(concert * CONCERT_FEE_RATE)
    admin = cinema_count * CINEMA_ADMIN_FEE
    return {"subtotal": subtotal, "tax": tax, "convenience": convenience, "admin": admin,
            "total": subtotal + tax + convenience + admin}


def _is_concert(item: CartItem) -> bool:
    event = get_event(item.event_id)
    return event is not None and event.kind == "concert"


def ticket_matrix(code: str, size: int = 21) -> list[list[int]]:
    """Pola kotak-kotak deterministik dari hash kode tiket (dekorasi mirip QR, BUKAN QR asli)."""
    bits = "".join(f"{byte:08b}" for byte in hashlib.sha256(code.encode()).digest() * 2)
    matrix = [[int(bits[(row * size + col) % len(bits)]) for col in range(size)] for row in range(size)]
    for top, left in ((0, 0), (0, size - 7), (size - 7, 0)):        # tiga penanda sudut
        for r in range(7):
            for c in range(7):
                edge = r in (0, 6) or c in (0, 6)
                core = 2 <= r <= 4 and 2 <= c <= 4
                matrix[top + r][left + c] = 1 if edge or core else 0
    return matrix


def _validate(form) -> tuple[dict, dict]:
    values = {
        "name": form.get("name", "").strip(),
        "email": form.get("email", "").strip(),
        "method": form.get("method", ""),
    }
    errors = {}
    if len(values["name"]) < 3:
        errors["name"] = "Nama minimal 3 karakter."
    if not EMAIL_PATTERN.match(values["email"]):
        errors["email"] = "Format email belum benar, contoh: nama@email.com."
    if values["method"] not in PAYMENT_METHODS:
        errors["method"] = "Pilih salah satu metode pembayaran."
    return values, errors


def _render_checkout(values: dict | None = None, errors: dict | None = None, status: int = 200):
    items = Cart().items()
    page = render_template("checkout/checkout.html", items=items, totals=compute_totals(items),
                           methods=PAYMENT_METHODS, values=values or {}, errors=errors or {})
    return page, status


@checkout_bp.get("/")
def index():
    return _render_checkout()


@checkout_bp.post("/remove/<int:index>")
def remove(index: int):
    Cart().remove(index)
    return redirect(url_for("checkout.index"))


@checkout_bp.post("/clear")
def clear():
    Cart().clear()
    return redirect(url_for("checkout.index"))


@checkout_bp.post("/pay")
def pay():
    cart = Cart()
    items = cart.items()
    if not items:
        return redirect(url_for("checkout.index"))
    values, errors = _validate(request.form)
    if errors:
        return _render_checkout(values, errors, status=400)

    session[ORDER_SESSION_KEY] = {
        "code": f"TP-{secrets.token_hex(4).upper()}",
        "paid_at": datetime.now().strftime("%d %b %Y · %H.%M WIB"),
        "buyer": {"name": values["name"], "email": values["email"]},
        "method": PAYMENT_METHODS[values["method"]],
        "items": [item.to_dict() for item in items],
        "totals": compute_totals(items),
    }
    cart.clear()
    return redirect(url_for("checkout.ticket"))


@checkout_bp.get("/ticket")
def ticket():
    order = session.get(ORDER_SESSION_KEY)
    if not order:
        return redirect(url_for("checkout.index"))
    tickets = [
        {"item": CartItem.from_dict(entry), "code": f"{order['code']}-{number:02d}",
         "matrix": ticket_matrix(f"{order['code']}-{number:02d}")}
        for number, entry in enumerate(order["items"], start=1)
    ]
    return render_template("checkout/eticket.html", order=order, tickets=tickets)
