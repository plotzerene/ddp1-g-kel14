"""
routes.py (checkout) : Keranjang, pembayaran terproteksi auth, e-tiket, dan profil pesanan.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import time
from datetime import datetime

from flask import Blueprint, current_app, jsonify, redirect, render_template, request, session, url_for

from ...shared_state import (
    Cart,
    CartItem,
    active_order_owner,
    current_user,
    get_event,
    get_order_store,
)

checkout_bp = Blueprint("checkout", __name__, template_folder="templates")

ORDER_SESSION_KEY = "tiketpov_last_order"
PENDING_CODE_KEY = "tiketpov_pending_order"
SEAT_OWNER_KEY = "tiketpov_seat_owner"
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PAYMENT_METHODS: dict[str, str] = {
    "qris": "QRIS",
    "va": "Virtual Account Bank",
    "ewallet": "E-Wallet",
    "card": "Kartu Kredit / Debit",
    "bca": "BCA Virtual Account",
    "mandiri": "Mandiri Virtual Account",
    "bni": "BNI Virtual Account",
    "bri": "BRI Virtual Account",
    "gopay": "GoPay",
    "ovo": "OVO",
    "shopeepay": "ShopeePay",
    "dana": "DANA",
    "indomaret": "Indomaret",
    "alfamart": "Alfamart",
    "alfamidi": "Alfamidi",
}

PAYMENT_GROUPS: list[dict] = [
    {
        "title": "Transfer & Virtual Account Bank",
        "channels": [
            {"key": "bca", "label": "BCA Virtual Account", "logo": "bca.png", "kind": "va", "code": "88010 0812 9940 112"},
            {"key": "mandiri", "label": "Mandiri Virtual Account", "logo": "mandiri.png", "kind": "va", "code": "89022 0812 9940 112"},
            {"key": "bni", "label": "BNI Virtual Account", "logo": "bni.png", "kind": "va", "code": "88100 0812 9940 112"},
            {"key": "bri", "label": "BRI Virtual Account", "logo": "bri.png", "kind": "va", "code": "88811 0812 9940 112"},
        ],
    },
    {
        "title": "QRIS & Dompet Digital",
        "channels": [
            {"key": "qris", "label": "QRIS Instan", "logo": "qris.png", "kind": "qris", "code": "ID1020304050607"},
            {"key": "gopay", "label": "GoPay", "logo": "gopay.png", "kind": "ewallet", "code": "0812 9940 1120"},
            {"key": "ovo", "label": "OVO", "logo": "ovo.png", "kind": "ewallet", "code": "0812 9940 1120"},
            {"key": "shopeepay", "label": "ShopeePay", "logo": "shopeepay.png", "kind": "ewallet", "code": "89308 1299 40112"},
            {"key": "dana", "label": "DANA", "logo": "dana.png", "kind": "ewallet", "code": "0812 9940 1120"},
        ],
    },
    {
        "title": "Pembayaran Gerai Ritel",
        "channels": [
            {"key": "indomaret", "label": "Indomaret", "logo": "indomaret.png", "kind": "retail", "code": "TTKT 9402 8112 77"},
            {"key": "alfamart", "label": "Alfamart", "logo": "alfamart.png", "kind": "retail", "code": "TTKT 8821 0492 10"},
            {"key": "alfamidi", "label": "Alfamidi", "logo": "alfamidi.png", "kind": "retail", "code": "TTKT 8821 0492 10"},
        ],
    },
]
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


def _ticket_venue_type(item: CartItem) -> str:
    """Tentukan jenis venue tiket ('concert' atau 'cinema') untuk pemisahan kode e-tiket."""
    if _is_concert(item) or item.venue_id.startswith("gbk"):
        return "concert"
    return "cinema"


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


def _render_cart():
    items = Cart().items()
    return render_template(
        "checkout/cart.html",
        items=items,
        totals=compute_totals(items),
    )


STUDIO_DISPLAY_LABELS: dict[str, str] = {
    "xxi-regular": "Studio 1",
    "xxi-premiere": "Studio Premiere",
    "xxi-imax": "Studio IMAX",
    "xxi-4dx": "Studio 4DX",
}


def _stepper_viz_href(items: list[CartItem]) -> str:
    if not items:
        return url_for("visualizer.index")
    first = items[0]
    if _ticket_venue_type(first) == "concert" or not first.event_id:
        return url_for("visualizer.studio", venue_id=first.venue_id)
    return url_for("visualizer.studio", venue_id=first.venue_id, film=first.event_id)


def _release_cart_locks(seat_keys: list[str] | None = None) -> None:
    locks = current_app.config.get("SEAT_LOCKS")
    owner = session.get(SEAT_OWNER_KEY)
    if not locks or not owner:
        return
    if seat_keys is None:
        locks.release_all(owner)
    else:
        for key in seat_keys:
            locks.release(key, owner)


def _channel_meta(method_key: str) -> dict:
    for group in PAYMENT_GROUPS:
        for ch in group["channels"]:
            if ch["key"] == method_key:
                return ch
    return {
        "key": method_key,
        "label": PAYMENT_METHODS.get(method_key, "Kanal Resmi"),
        "kind": "qris" if method_key == "qris" else "va",
        "code": "88010 0812 9940 112",
    }


def _build_tickets(order: dict) -> list[dict]:
    tickets: list[dict] = []
    for number, entry in enumerate(order.get("items", []), start=1):
        cart_item = CartItem.from_dict(entry)
        venue_type = _ticket_venue_type(cart_item)
        code = f"{order['code']}-{number:02d}"
        event = get_event(cart_item.event_id)
        event_title = event.title if event is not None else cart_item.venue_name.split(" · ")[0]
        pov = cart_item.pov if isinstance(cart_item.pov, dict) else {}
        if venue_type == "concert":
            show_date = str(pov.get("show_date") or "Sabtu, 19 Des 2026")
            show_time = str(pov.get("show_time") or "19:30 WIB")
            cinema = str(pov.get("cinema_name") or "Stadion Utama GBK")
            studio_lbl = str(pov.get("studio_label") or "Pintu Timur")
        else:
            show_date = str(pov.get("show_date") or "Sabtu, 14 Nov 2026")
            show_time = str(pov.get("show_time") or "19:00 WIB")
            cinema = str(pov.get("cinema_name") or "AGORA MALL XXI")
            studio_lbl = str(pov.get("studio_label") or STUDIO_DISPLAY_LABELS.get(cart_item.venue_id, "Studio 1"))
        tickets.append({
            "item": cart_item,
            "code": code,
            "venue_type": venue_type,
            "event_type": "concert" if venue_type == "concert" else "film",
            "event_title": event_title,
            "show_date": show_date,
            "show_time": show_time,
            "studio_cinema": f"{cinema} \u2022 {studio_lbl}",
            "matrix": ticket_matrix(code) if venue_type != "concert" else [],
        })
    return tickets


def _active_pending_order(items: list[CartItem]) -> dict | None:
    code = session.get(PENDING_CODE_KEY)
    if not code:
        return None
    order = get_order_store().find(active_order_owner(), str(code))
    if not order or order.get("status") != "PENDING":
        session.pop(PENDING_CODE_KEY, None)
        return None
    item_keys = [i.key for i in items]
    order_keys = [f"{e.get('venue_id')}|{e.get('seat_id')}" for e in order.get("items", [])]
    if item_keys and item_keys != order_keys:
        return None
    order["remaining_seconds"] = max(0, int(float(order.get("expires_ts", 0)) - time.time()))
    return order


def _lock_remaining_seconds(items: list[CartItem]) -> int:
    locks = current_app.config.get("SEAT_LOCKS")
    if not locks or not items:
        return 600
    remaining = [int(round(locks.seconds_left(i.key))) for i in items if locks.seconds_left(i.key) > 0]
    return min(remaining) if remaining else 600


def _render_checkout(values: dict | None = None, errors: dict | None = None, status: int = 200):
    items = Cart().items()
    user = current_user() or {}
    pending_order = _active_pending_order(items)
    merged_values = {
        "name": (values or {}).get("name") or (pending_order or {}).get("buyer", {}).get("name") or user.get("name", ""),
        "email": (values or {}).get("email") or (pending_order or {}).get("buyer", {}).get("email") or user.get("email", ""),
        "method": (values or {}).get("method") or (pending_order or {}).get("method_key", ""),
    }
    page = render_template(
        "checkout/checkout.html",
        items=items,
        totals=compute_totals(items),
        methods=PAYMENT_METHODS,
        payment_groups=PAYMENT_GROUPS,
        sso_discount_rate=0.15,
        values=merged_values,
        errors=errors or {},
        pending_order=pending_order,
        lock_remaining_seconds=_lock_remaining_seconds(items),
        stepper_viz_href=_stepper_viz_href(items),
    )
    return page, status


@checkout_bp.get("/cart", strict_slashes=False)
def cart():
    return _render_cart()


@checkout_bp.get("/checkout/", strict_slashes=False)
def index():
    if not current_user():
        if Cart().items() or request.args.get("order"):
            return redirect(url_for("checkout.cart", auth="required", next=url_for("checkout.index")))
        return redirect(url_for("checkout.cart"))
    if not Cart().items():
        return redirect(url_for("checkout.cart"))
    return _render_checkout()


@checkout_bp.post("/checkout/remove/<int:index>")
def remove(index: int):
    cart_store = Cart()
    items = cart_store.items()
    removed_key = [items[index].key] if 0 <= index < len(items) else []
    if cart_store.remove(index) and removed_key:
        _release_cart_locks(removed_key)
    session.pop(PENDING_CODE_KEY, None)
    if request.form.get("next") == "cart" or not cart_store.items():
        return redirect(url_for("checkout.cart"))
    return redirect(url_for("checkout.index"))


@checkout_bp.post("/checkout/clear")
def clear():
    _release_cart_locks()
    Cart().clear()
    session.pop(PENDING_CODE_KEY, None)
    return redirect(url_for("checkout.cart"))


@checkout_bp.post("/checkout/pending")
def create_pending():
    if not current_user():
        return jsonify(ok=False, error="Silakan masuk akun terlebih dahulu untuk melanjutkan pembayaran."), 401
    items = Cart().items()
    if not items:
        return jsonify(ok=False, error="Keranjang masih kosong."), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = dict(request.form)
    values, errors = _validate(data)
    if errors:
        return jsonify(ok=False, errors=errors), 400

    method_key = values["method"]
    channel = _channel_meta(method_key)
    existing = _active_pending_order(items)
    code = existing["code"] if existing else f"TP-{secrets.token_hex(4).upper()}"
    now_ts = time.time()
    expires_ts = float(existing["expires_ts"]) if existing else now_ts + 900.0
    order = {
        "code": code,
        "status": "PENDING",
        "created_at": datetime.now().strftime("%d %b %Y · %H.%M WIB"),
        "expires_ts": expires_ts,
        "remaining_seconds": max(0, int(expires_ts - now_ts)),
        "buyer": {"name": values["name"], "email": values["email"]},
        "method_key": method_key,
        "method": PAYMENT_METHODS[method_key],
        "payment_code": channel.get("code", "88010 0812 9940 112"),
        "items": [item.to_dict() for item in items],
        "totals": compute_totals(items),
        "viz_href": _stepper_viz_href(items),
    }
    saved = get_order_store().upsert(active_order_owner(), order)
    session[PENDING_CODE_KEY] = saved["code"]
    return jsonify(ok=True, order=saved)


@checkout_bp.post("/checkout/cancel")
def cancel_order():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = dict(request.form)
    action = str(data.get("action") or "cancel_order").strip()
    reason = str(data.get("reason") or "Dibatalkan oleh pengguna").strip()
    items = Cart().items()
    target_code = str(data.get("order_code") or session.get(PENDING_CODE_KEY) or "").strip()

    if action == "change_method":
        if target_code and current_user():
            get_order_store().update_status(
                active_order_owner(),
                target_code,
                "CANCELLED",
                cancelled_at=datetime.now().strftime("%d %b %Y · %H.%M WIB"),
                cancel_reason="Ganti metode pembayaran",
            )
        session.pop(PENDING_CODE_KEY, None)
        return jsonify(ok=True, unlocked=True, redirect=None)

    if action == "change_seat":
        viz_href = _stepper_viz_href(items)
        if not items and target_code and current_user():
            found = get_order_store().find(active_order_owner(), target_code)
            if found and found.get("viz_href"):
                viz_href = str(found["viz_href"])
        session.pop(PENDING_CODE_KEY, None)
        return jsonify(ok=True, redirect=viz_href)

    if action == "expired_hold":
        viz_href = _stepper_viz_href(items)
        _release_cart_locks()
        Cart().clear()
        if target_code and current_user():
            get_order_store().update_status(
                active_order_owner(),
                target_code,
                "EXPIRED",
                cancelled_at=datetime.now().strftime("%d %b %Y · %H.%M WIB"),
                cancel_reason="Waktu reservasi kursi habis",
            )
        session.pop(PENDING_CODE_KEY, None)
        return jsonify(ok=True, redirect=viz_href)

    if action == "payment_expired":
        _release_cart_locks()
        Cart().clear()
        if target_code and current_user():
            get_order_store().update_status(
                active_order_owner(),
                target_code,
                "EXPIRED",
                cancelled_at=datetime.now().strftime("%d %b %Y · %H.%M WIB"),
                cancel_reason=reason or "Batas waktu pembayaran berakhir",
            )
        session.pop(PENDING_CODE_KEY, None)
        return jsonify(ok=True)

    _release_cart_locks()
    Cart().clear()
    if target_code and current_user():
        get_order_store().update_status(
            active_order_owner(),
            target_code,
            "CANCELLED",
            cancelled_at=datetime.now().strftime("%d %b %Y · %H.%M WIB"),
            cancel_reason=reason,
        )
    elif items and current_user():
        get_order_store().upsert(active_order_owner(), {
            "code": f"TP-{secrets.token_hex(4).upper()}",
            "status": "CANCELLED",
            "created_at": datetime.now().strftime("%d %b %Y · %H.%M WIB"),
            "cancelled_at": datetime.now().strftime("%d %b %Y · %H.%M WIB"),
            "cancel_reason": reason,
            "buyer": {"name": (current_user() or {}).get("name", ""), "email": (current_user() or {}).get("email", "")},
            "method": "Belum selesai",
            "items": [item.to_dict() for item in items],
            "totals": compute_totals(items),
        })
    session.pop(PENDING_CODE_KEY, None)
    if request.is_json:
        return jsonify(ok=True, redirect=url_for("landing.index"))
    return redirect(url_for("landing.index"))


@checkout_bp.post("/checkout/pay")
def pay():
    if not current_user():
        if request.is_json or "application/json" in request.headers.get("Accept", ""):
            return jsonify(ok=False, error="Silakan masuk akun terlebih dahulu."), 401
        return redirect(url_for("checkout.cart", auth="required", next=url_for("checkout.index")))
    cart_store = Cart()
    items = cart_store.items()
    if not items:
        return redirect(url_for("checkout.cart"))
    values, errors = _validate(request.form)
    if errors:
        return _render_checkout(values, errors, status=400)

    pending_code = session.pop(PENDING_CODE_KEY, None)
    order_code = str(pending_code or f"TP-{secrets.token_hex(4).upper()}")
    paid_at = datetime.now().strftime("%d %b %Y · %H.%M WIB")
    channel = _channel_meta(values["method"])
    order = {
        "code": order_code,
        "status": "PAID",
        "created_at": paid_at,
        "paid_at": paid_at,
        "buyer": {"name": values["name"], "email": values["email"]},
        "method_key": values["method"],
        "method": PAYMENT_METHODS[values["method"]],
        "payment_code": channel.get("code", ""),
        "items": [item.to_dict() for item in items],
        "totals": compute_totals(items),
        "viz_href": _stepper_viz_href(items),
    }
    session[ORDER_SESSION_KEY] = order
    get_order_store().upsert(active_order_owner(), order)
    _release_cart_locks()
    cart_store.clear()
    return redirect(url_for("checkout.ticket"))


@checkout_bp.get("/checkout/ticket")
def ticket():
    if not current_user():
        return redirect(url_for("checkout.cart", auth="required", next=url_for("checkout.ticket")))
    order = session.get(ORDER_SESSION_KEY)
    if not order:
        return redirect(url_for("checkout.cart"))
    tickets = _build_tickets(order)
    parsed_items = [t["item"] for t in tickets]
    return render_template(
        "checkout/eticket.html",
        order=order,
        tickets=tickets,
        stepper_viz_href=_stepper_viz_href(parsed_items),
    )


@checkout_bp.get("/profile", strict_slashes=False)
@checkout_bp.get("/pesanan", strict_slashes=False)
def profile():
    user = current_user()
    raw_orders = get_order_store().list_for(active_order_owner()) if user else []
    now_ts = time.time()
    pending_orders: list[dict] = []
    completed_orders: list[dict] = []
    cancelled_orders: list[dict] = []
    for entry in raw_orders:
        enriched = dict(entry)
        enriched["tickets"] = _build_tickets(entry)
        if entry.get("status") == "PENDING":
            enriched["remaining_seconds"] = max(0, int(float(entry.get("expires_ts", now_ts)) - now_ts))
            pending_orders.append(enriched)
        elif entry.get("status") == "PAID":
            completed_orders.append(enriched)
        else:
            cancelled_orders.append(enriched)
    active_tab = request.args.get("tab", "pending")
    if active_tab not in ("pending", "completed", "cancelled"):
        active_tab = "pending"
    return render_template(
        "checkout/profile.html",
        user=user,
        active_tab=active_tab,
        pending_orders=pending_orders,
        completed_orders=completed_orders,
        cancelled_orders=cancelled_orders,
    )


@checkout_bp.get("/profile/resume/<code>")
def resume_order(code: str):
    if not current_user():
        return redirect(url_for("checkout.cart", auth="required", next=url_for("checkout.profile")))
    order = get_order_store().find(active_order_owner(), code)
    if not order or order.get("status") != "PENDING":
        return redirect(url_for("checkout.profile", tab="pending"))
    cart = Cart()
    cart.clear()
    locks = current_app.config.get("SEAT_LOCKS")
    owner = session.get(SEAT_OWNER_KEY)
    if not owner:
        owner = secrets.token_hex(16)
        session[SEAT_OWNER_KEY] = owner
    for raw in order.get("items", []):
        item = CartItem.from_dict(raw)
        if locks:
            locks.acquire(item.key, owner)
        cart.add(item)
    session[PENDING_CODE_KEY] = order["code"]
    return redirect(url_for("checkout.index"))
