"""
routes.py (checkout) : Keranjang, pembayaran terproteksi auth, e-tiket, dan profil pesanan.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import time
from datetime import datetime

from ...assets_sync import POSTER_FALLBACK_REL, asset_url
from flask import Blueprint, current_app, jsonify, redirect, render_template, request, session, url_for

from ...shared_state import (
    VENUE_ADDONS,
    AddonCart,
    AddressBook,
    Cart,
    CartItem,
    MerchCart,
    active_order_owner,
    current_user,
    get_event,
    get_order_store,
    is_guest_checkout,
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
            {"key": "gopay", "label": "GoPay", "logo": "gopay.png", "kind": "ewallet", "code": "0812 9940 1120", "deeplink": "gojek://gopay/merchanttransfer?ref=titiket"},
            {"key": "ovo", "label": "OVO", "logo": "ovo.png", "kind": "ewallet", "code": "0812 9940 1120", "deeplink": "ovo://payment/titiket"},
            {"key": "shopeepay", "label": "ShopeePay", "logo": "shopeepay.png", "kind": "ewallet", "code": "89308 1299 40112", "deeplink": "shopeeid://pay?merchant=titiket"},
            {"key": "dana", "label": "DANA", "logo": "dana.png", "kind": "ewallet", "code": "0812 9940 1120", "deeplink": "dana://qr/titiket"},
        ],
    },
    {
        "title": "Kartu Kredit / Debit",
        "channels": [
            {"key": "card", "label": "Kartu Kredit / Debit", "logo": "bca.png", "kind": "card", "code": "4111 •••• •••• 1111"},
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


def compute_totals(items: list[CartItem], addons: list[dict] | None = None) -> dict:
    """Subtotal + biaya: bioskop kena biaya admin tetap, konser kena pajak 15% + fee 5% + add-on venue."""
    subtotal = sum(item.price for item in items)
    concert = sum(item.price for item in items if _is_concert(item))
    cinema_count = sum(1 for item in items if not _is_concert(item))
    tax = round(concert * CONCERT_TAX_RATE)
    convenience = round(concert * CONCERT_FEE_RATE)
    admin = cinema_count * CINEMA_ADMIN_FEE
    addon_subtotal = sum(int(a.get("line_total", 0)) for a in (addons or []))
    return {
        "subtotal": subtotal,
        "tax": tax,
        "convenience": convenience,
        "admin": admin,
        "addon_subtotal": addon_subtotal,
        "total": subtotal + tax + convenience + admin + addon_subtotal,
    }


def compute_merch_totals(merch_items: list[dict], shipping_fee: int) -> dict:
    subtotal = sum(int(m.get("line_total", 0)) for m in merch_items)
    ship = shipping_fee if merch_items else 0
    return {
        "subtotal": subtotal,
        "tax": 0,
        "convenience": 0,
        "admin": 0,
        "addon_subtotal": 0,
        "shipping_fee": ship,
        "total": subtotal + ship,
    }


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


def _validate(form, seats: int = 1) -> tuple[dict, dict]:
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
    # Data Penonton per Kursi: Penonton 1 = pemesan (name/email); penonton 2..N opsional di klien lama,
    # tetapi divalidasi bila kolomnya dikirim.
    attendees = [{"name": values["name"], "nik": form.get("attendee_nik_1", "").strip()[:24], "email": values["email"]}]
    for n in range(2, max(1, seats) + 1):
        if f"attendee_name_{n}" not in form:
            continue
        row = {
            "name": form.get(f"attendee_name_{n}", "").strip()[:80],
            "nik": form.get(f"attendee_nik_{n}", "").strip()[:24],
            "email": form.get(f"attendee_email_{n}", "").strip()[:120],
        }
        if len(row["name"]) < 3:
            errors[f"attendee_{n}"] = f"Nama Penonton {n} minimal 3 karakter."
        elif row["email"] and not EMAIL_PATTERN.match(row["email"]):
            errors[f"attendee_{n}"] = f"Format email Penonton {n} belum benar."
        attendees.append(row)
    values["attendees"] = attendees
    return values, errors


def _render_cart():
    items = Cart().items()
    addons = AddonCart().items()
    merch_cart = MerchCart()
    merch_items = merch_cart.items()
    addr_book = AddressBook()
    return render_template(
        "checkout/cart.html",
        items=items,
        totals=compute_totals(items, addons),
        selected_addons=addons,
        addon_subtotal=AddonCart().subtotal,
        lock_remaining_seconds=_lock_remaining_seconds(items) if items else 0,
        merch_items=merch_items,
        merch_subtotal=merch_cart.subtotal,
        shipping_fee=merch_cart.shipping_fee,
        merch_total=merch_cart.subtotal + merch_cart.shipping_fee,
        addresses=addr_book.list(),
        active_address=addr_book.active(),
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
    if method_key == "card":
        return {
            "key": "card",
            "label": "Kartu Kredit / Debit (Visa, Mastercard)",
            "kind": "card",
            "code": "4111 •••• •••• 1111",
        }
    return {
        "key": method_key,
        "label": PAYMENT_METHODS.get(method_key, "Kanal Resmi"),
        "kind": "qris" if method_key == "qris" else "va",
        "code": "88010 0812 9940 112",
    }


def _resolve_event_poster(event, is_concert: bool) -> tuple[str, str]:
    fallback_url = asset_url(POSTER_FALLBACK_REL) or "/static/images/posters/poster_fallback.svg"
    if event is not None and event.poster:
        return (asset_url(event.poster) or fallback_url), fallback_url
    if is_concert:
        return (asset_url("images/gbk_coldplay_stage_full3.jpg") or fallback_url), fallback_url
    return fallback_url, fallback_url


def _build_tickets(order: dict) -> list[dict]:
    tickets: list[dict] = []
    attendees = order.get("attendees") or []
    for number, entry in enumerate(order.get("items", []), start=1):
        cart_item = CartItem.from_dict(entry)
        # Data Penonton per Kursi: pemegang tiket = penonton ke-N, jatuh ke pemesan bila kosong.
        holder = (attendees[number - 1].get("name") if number <= len(attendees) else "") or order.get("buyer", {}).get("name", "")
        venue_type = _ticket_venue_type(cart_item)
        code = f"{order['code']}-{number:02d}"
        event = get_event(cart_item.event_id)
        event_title = event.title if event is not None else cart_item.venue_name.split(" · ")[0]
        poster_url, _ = _resolve_event_poster(event, venue_type == "concert")
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
            "holder_email": (attendees[number - 1].get("email") if number <= len(attendees) else "") or order.get("buyer", {}).get("email", ""),
            "holder": holder,
            "venue_type": venue_type,
            "event_type": "concert" if venue_type == "concert" else "film",
            "event_title": event_title,
            "poster_url": poster_url,
            "show_date": show_date,
            "show_time": show_time,
            "studio_cinema": f"{cinema} \u2022 {studio_lbl}",
            "matrix": ticket_matrix(code) if venue_type != "concert" else [],
        })
    return tickets


_CROWD_SLOTS: tuple[dict, ...] = (
    {
        "time": "15:30 \u2013 16:30 WIB",
        "status": "Sangat Lancar",
        "detail": "Antrean pemeriksaan < 5 menit",
        "level": "low",
        "fill_pct": 24,
        "recommended": False,
    },
    {
        "time": "16:30 \u2013 18:00 WIB",
        "status": "Rekomendasi Ideal",
        "detail": "Antrean stabil ~10\u201315 menit",
        "level": "ideal",
        "fill_pct": 56,
        "recommended": True,
    },
    {
        "time": "18:00 \u2013 19:30 WIB",
        "status": "Jam Padat",
        "detail": "Antrean pintu gerbang mencapai 30+ menit",
        "level": "high",
        "fill_pct": 94,
        "recommended": False,
    },
)


def _concert_crowd_guide(tickets: list[dict]) -> dict | None:
    """Rekomendasi waktu kedatangan & lajur pemeriksaan barang per sektor tiket GBK."""
    concert_ticket = next((t for t in tickets if t.get("venue_type") == "concert"), None)
    if concert_ticket is None:
        return None
    item = concert_ticket["item"]
    seat_id = str(getattr(item, "seat_id", "") or "")
    block_id = seat_id.split(":", 1)[0].lower() if ":" in seat_id else seat_id.lower()
    sector_label = str(getattr(item, "category", "") or "GBK").strip() or "GBK"

    if block_id in ("ultimate", "my_universe"):
        gate_code, gate_name = "GATE 1", "Plaza Timur (VIP & Early Entry)"
        lane = "Lane Prioritas A1\u2013A2"
        tip = "Gunakan jalur khusus prioritas di sayap kanan Plaza Timur tanpa bergabung ke antrean reguler."
    elif block_id == "festival":
        gate_code, gate_name = "GATE 7", "Ring Road Selatan (Akses Lapangan)"
        lane = "Lane F5\u2013F8 (Sisi Timur Tenda Selatan)"
        tip = "Lajur F5\u2013F8 di ujung timur tenda selatan cenderung jauh lebih lengang dibandingkan lajur tengah F1\u2013F4."
    elif block_id in ("cat1", "cat2b_n", "cat2b_s", "cat4b", "cat5b", "cat7b", "cat8b"):
        gate_code, gate_name = "GATE 3", "Plaza Timur (Tribun Timur)"
        lane = "Lane Timur T4\u2013T6"
        tip = "Pilih meja body check T4\u2013T6 di sisi utara Plaza Timur karena lajur T1\u2013T2 berhimpitan dengan arus lapangan."
    elif block_id in ("cat2a", "cat4a", "cat5a", "cat7a", "cat8a"):
        gate_code, gate_name = "GATE 5", "Pintu Barat (Tribun Barat)"
        lane = "Lane Barat B4\u2013B6 (Sayap Selatan)"
        tip = "Akses langsung dari drop-off Barat menuju bilik B4\u2013B6 lebih cepat, terutama bagi pengguna tas transparan (clear bag)."
    else:
        gate_code, gate_name = "GATE 6", "Plaza Tenggara (Tribun Selatan)"
        lane = "Lane Selatan S5\u2013S7 (Jalur Kanan)"
        tip = "Masuk melalui sisi kanan S5\u2013S7 yang terpisah dari antrean lapangan sehingga pemeriksaan tas jauh lebih ringkas."

    return {
        "sector_label": sector_label,
        "gate_code": gate_code,
        "gate_name": gate_name,
        "body_check_lane": lane,
        "body_check_tip": tip,
        "slots": [dict(slot) for slot in _CROWD_SLOTS],
    }


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
    addons = AddonCart().items()
    merch_cart = MerchCart()
    merch_items = merch_cart.items()
    addr_book = AddressBook()
    checkout_mode = "merch" if request.args.get("mode") == "merch" and merch_items else "ticket"
    user = current_user() or {}
    pending_order = _active_pending_order(items)
    merged_values = {
        "name": (values or {}).get("name") or (pending_order or {}).get("buyer", {}).get("name") or user.get("name", ""),
        "email": (values or {}).get("email") or (pending_order or {}).get("buyer", {}).get("email") or user.get("email", ""),
        "method": (values or {}).get("method") or (pending_order or {}).get("method_key", "") or "qris",
        "attendees": (values or {}).get("attendees") or (pending_order or {}).get("attendees") or [],
    }
    totals = (
        compute_merch_totals(merch_items, merch_cart.shipping_fee)
        if checkout_mode == "merch"
        else compute_totals(items, addons)
    )
    is_standing_only = bool(items) and all(
        i.seat_id.startswith("festival:") or i.seat_id.startswith("my_universe:")
        for i in items
    )
    is_concert_checkout = bool(items) and _ticket_venue_type(items[0]) == "concert"
    hero_event = get_event(items[0].event_id) if items else None
    hero_poster_url, poster_fallback_url = _resolve_event_poster(hero_event, is_concert_checkout)
    page = render_template(
        "checkout/checkout.html",
        items=items,
        is_standing_only=is_standing_only,
        is_concert_checkout=is_concert_checkout,
        hero_poster_url=hero_poster_url,
        poster_fallback_url=poster_fallback_url,
        totals=totals,
        addon_catalog=VENUE_ADDONS,
        selected_addons=addons,
        addon_subtotal=AddonCart().subtotal,
        merch_items=merch_items,
        merch_subtotal=merch_cart.subtotal,
        shipping_fee=merch_cart.shipping_fee,
        addresses=addr_book.list(),
        active_address=addr_book.active(),
        checkout_mode=checkout_mode,
        is_preview_empty=(checkout_mode == "ticket" and not items),
        methods=PAYMENT_METHODS,
        payment_groups=PAYMENT_GROUPS,
        sso_discount_rate=0.15,
        values=merged_values,
        errors=errors or {},
        pending_order=pending_order,
        lock_remaining_seconds=_lock_remaining_seconds(items) if (checkout_mode == "ticket" and items) else 0,
        stepper_viz_href=_stepper_viz_href(items),
    )
    return page, status


@checkout_bp.get("/cart", strict_slashes=False)
def cart():
    return _render_cart()


@checkout_bp.get("/checkout/", strict_slashes=False)
def index():
    return _render_checkout()


@checkout_bp.post("/checkout/api/addons")
def api_addons():
    data = request.get_json(silent=True) or dict(request.form)
    item_id = str(data.get("item_id", "")).strip()
    qty = int(data.get("qty", 0) or 0)
    note = data.get("note")
    addon_cart = AddonCart()
    if not addon_cart.set_item(item_id, qty, None if note is None else str(note)):
        return jsonify(ok=False, error="Item add-on tidak ditemukan."), 404
    items = Cart().items()
    addons = addon_cart.items()
    return jsonify(
        ok=True,
        addons=addons,
        addon_count=addon_cart.count,
        addon_subtotal=addon_cart.subtotal,
        totals=compute_totals(items, addons),
    )


@checkout_bp.post("/checkout/api/addresses")
def api_addresses_add():
    data = request.get_json(silent=True) or dict(request.form)
    street = str(data.get("street", "")).strip()
    city = str(data.get("city", "")).strip()
    if len(street) < 5 or len(city) < 3:
        return jsonify(ok=False, error="Alamat lengkap dan kota wajib diisi."), 400
    book = AddressBook()
    entry = book.add(
        tag=str(data.get("tag", "Rumah")),
        label=str(data.get("label", "")),
        recipient=str(data.get("recipient", "Evans Kano")),
        phone=str(data.get("phone", "+62 812 3456 7890")),
        street=street,
        city=city,
        make_default=bool(data.get("make_default", True)),
    )
    return jsonify(ok=True, address=entry, addresses=book.list(), active=book.active())


@checkout_bp.post("/checkout/api/addresses/default")
def api_addresses_default():
    data = request.get_json(silent=True) or dict(request.form)
    addr_id = str(data.get("address_id", "")).strip()
    book = AddressBook()
    if not book.set_default(addr_id):
        return jsonify(ok=False, error="Alamat tidak ditemukan."), 404
    return jsonify(ok=True, addresses=book.list(), active=book.active())


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
    AddonCart().clear()
    session.pop(PENDING_CODE_KEY, None)
    return redirect(url_for("checkout.cart"))


def _can_submit_checkout(data: dict) -> bool:
    return bool(current_user())


@checkout_bp.post("/checkout/pending")
def create_pending():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = dict(request.form)
    if not _can_submit_checkout(data):
        return jsonify(ok=False, error="Silakan masuk atau daftar akun terlebih dahulu untuk melanjutkan pemesanan."), 401
    checkout_mode = str(data.get("mode") or "ticket")
    items = Cart().items()
    addons = AddonCart().items()
    merch_cart = MerchCart()
    merch_items = merch_cart.items()
    if checkout_mode == "merch":
        if not merch_items:
            return jsonify(ok=False, error="Keranjang merchandise masih kosong."), 400
    elif not items and not addons:
        return jsonify(ok=False, error="Keranjang masih kosong."), 400
    values, errors = _validate(data, seats=len(items) if checkout_mode != "merch" else 1)
    if errors:
        return jsonify(ok=False, errors=errors), 400

    method_key = values["method"]
    channel = _channel_meta(method_key)
    existing = _active_pending_order(items)
    code = existing["code"] if existing else f"TP-{secrets.token_hex(4).upper()}"
    now_ts = time.time()
    expires_ts = float(existing["expires_ts"]) if existing else now_ts + 900.0
    totals = (
        compute_merch_totals(merch_items, merch_cart.shipping_fee)
        if checkout_mode == "merch"
        else compute_totals(items, addons)
    )
    order = {
        "code": code,
        "status": "PENDING",
        "mode": checkout_mode,
        "created_at": datetime.now().strftime("%d %b %Y · %H.%M WIB"),
        "expires_ts": expires_ts,
        "remaining_seconds": max(0, int(expires_ts - now_ts)),
        "buyer": {"name": values["name"], "email": values["email"]},
        "attendees": values["attendees"],
        "method_key": method_key,
        "method": PAYMENT_METHODS[method_key],
        "payment_kind": channel.get("kind", "qris"),
        "payment_code": channel.get("code", "88010 0812 9940 112"),
        "deeplink": channel.get("deeplink", ""),
        "items": [item.to_dict() for item in items] if checkout_mode != "merch" else [],
        "addons": addons if checkout_mode != "merch" else [],
        "merch_items": merch_items if checkout_mode == "merch" else [],
        "shipping_address": AddressBook().active() if checkout_mode == "merch" else None,
        "totals": totals,
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
        AddonCart().clear()
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
        AddonCart().clear()
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
    AddonCart().clear()
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
    form_data = dict(request.form)
    if not _can_submit_checkout(form_data):
        if request.is_json or "application/json" in request.headers.get("Accept", ""):
            return jsonify(ok=False, error="Silakan masuk atau daftar akun terlebih dahulu untuk melanjutkan pemesanan."), 401
        return redirect(url_for("checkout.cart", auth="required", next=url_for("checkout.index")))
    checkout_mode = str(form_data.get("mode") or "ticket")
    cart_store = Cart()
    items = cart_store.items()
    addons = AddonCart().items()
    merch_cart = MerchCart()
    merch_items = merch_cart.items()
    if checkout_mode == "merch":
        if not merch_items:
            return redirect(url_for("checkout.cart"))
    elif not items and not addons:
        return redirect(url_for("checkout.cart"))
    values, errors = _validate(request.form, seats=len(items) if checkout_mode != "merch" else 1)
    if errors:
        return _render_checkout(values, errors, status=400)

    pending_code = session.pop(PENDING_CODE_KEY, None)
    order_code = str(pending_code or f"TTKT-20261219-{secrets.randbelow(9000) + 1000}")
    paid_at = datetime.now().strftime("%d %b %Y · %H.%M WIB")
    channel = _channel_meta(values["method"])
    totals = (
        compute_merch_totals(merch_items, merch_cart.shipping_fee)
        if checkout_mode == "merch"
        else compute_totals(items, addons)
    )
    order = {
        "code": order_code,
        "status": "PAID",
        "mode": checkout_mode,
        "created_at": paid_at,
        "paid_at": paid_at,
        "buyer": {"name": values["name"], "email": values["email"]},
        "attendees": values["attendees"],
        "method_key": values["method"],
        "method": PAYMENT_METHODS[values["method"]],
        "payment_code": channel.get("code", ""),
        "items": [item.to_dict() for item in items] if checkout_mode != "merch" else [],
        "addons": addons if checkout_mode != "merch" else [],
        "merch_items": merch_items if checkout_mode == "merch" else [],
        "shipping_address": AddressBook().active() if checkout_mode == "merch" else None,
        "totals": totals,
        "viz_href": _stepper_viz_href(items),
    }
    session[ORDER_SESSION_KEY] = order_code
    get_order_store().upsert(active_order_owner(), order)
    if checkout_mode == "merch":
        merch_cart.clear()
    else:
        _release_cart_locks()
        cart_store.clear()
        AddonCart().clear()
    return redirect(url_for("checkout.ticket"))


@checkout_bp.get("/checkout/ticket")
def ticket():
    raw_order = session.get(ORDER_SESSION_KEY)
    order = None
    if isinstance(raw_order, dict):
        order = raw_order
    elif isinstance(raw_order, str) and raw_order:
        order = get_order_store().find(active_order_owner(), raw_order)
    if not order:
        if not current_user():
            return redirect(url_for("checkout.cart", auth="required", next=url_for("checkout.ticket")))
        return redirect(url_for("checkout.cart"))
    tickets = _build_tickets(order)
    parsed_items = [t["item"] for t in tickets]
    return render_template(
        "checkout/eticket.html",
        order=order,
        tickets=tickets,
        addons=order.get("addons", []),
        merch_items=order.get("merch_items", []),
        shipping_address=order.get("shipping_address"),
        stepper_viz_href=_stepper_viz_href(parsed_items),
        crowd_guide=_concert_crowd_guide(tickets),
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
    if active_tab not in ("pending", "completed", "cancelled", "account", "addresses"):
        active_tab = "pending"
    addr_book = AddressBook()
    return render_template(
        "checkout/profile.html",
        user=user,
        active_tab=active_tab,
        pending_orders=pending_orders,
        completed_orders=completed_orders,
        cancelled_orders=cancelled_orders,
        addresses=addr_book.list(),
        active_address=addr_book.active(),
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
