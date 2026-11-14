"""
routes.py (visualizer) — halaman peta 2D + POV 3D dan JSON API-nya.

    GET  /visualizer?type=cinema&film=<slug>      dari landing "Beli tiket" (film)
    GET  /visualizer?type=cinema&studio=<tipe>    dari kartu studio (regular | premiere | imax | 4dx)
    GET  /visualizer?type=concert&event=<slug>    dari landing "Beli tiket" (konser)
    GET  /visualizer/studio/<venue_id>[?film=]    halaman utama
    GET  /visualizer/api/venues                   daftar venue
    GET  /visualizer/api/venues/<id>/layout       geometri venue (peta 2D + scene 3D) + video acaranya
    POST /visualizer/api/pov                      kursi + tinggi badan → kamera, halangan, akustik, skor
    POST /visualizer/api/recommend                Smart Seat Recommender (top 3)
    GET  /visualizer/api/venues/<id>/heatmap      skor semua kursi kandidat
    GET/POST /visualizer/api/cart                 keranjang bersama (lihat shared_state.py)
    POST /visualizer/api/cart/remove
"""
from __future__ import annotations

import math
import secrets

from flask import Blueprint, current_app, jsonify, redirect, render_template, request, session, url_for

from ...assets_sync import asset_url
from ...shared_state import MAX_CART_ITEMS, Cart, CartItem, event_for_venue, format_rupiah, get_event
from .engine.geometry_3d import LENSES
from .engine.obstruction import DEFAULT_BODY_CM, MAX_BODY_CM, MIN_BODY_CM
from .engine.pov_engine import PovReport, engine_for
from .engine.seat_lock import SeatLockStore
from .engine.sightline_ai import SmartSeatRecommender
from .models import SeatNotFoundError, Venue, get_venue, venue_registry

visualizer_bp = Blueprint("visualizer", __name__, template_folder="templates")

POV_CART_FIELDS = ("score", "grade", "distance_m", "h_fov_deg", "neck_pitch_deg", "neck_yaw_deg",
                   "obstruction_pct", "visible_pct", "audio_delay_ms", "spl_db")
LIMITS = {"body_min_cm": MIN_BODY_CM, "body_max_cm": MAX_BODY_CM, "body_default_cm": DEFAULT_BODY_CM}


# --------------------------------------------------------------------------- #
# Helper
# --------------------------------------------------------------------------- #
def _payload() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _number(value: object, default: float) -> float:
    try:
        number = float(value)       # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return default if math.isnan(number) or math.isinf(number) else number


def _evaluate(data: dict) -> tuple[Venue, PovReport]:
    """Validasi input lalu jalankan PovEngine untuk satu kursi."""
    venue = get_venue(str(data.get("venue_id", "")))
    selector = data.get("selector")
    if not isinstance(selector, dict):
        selector = {"seat_id": data.get("seat_id")}
    seat = venue.resolve_seat(selector)
    report = engine_for(venue.venue_id).evaluate(
        seat,
        body_height_cm=data.get("body_height_cm", DEFAULT_BODY_CM),
        front_height_cm=data.get("front_height_cm", DEFAULT_BODY_CM),
        target_id=data.get("target_id"),
        lens_mode=data.get("lens"),
        aspect=_number(data.get("aspect"), 16.0 / 9.0),
    )
    return venue, report


SEAT_OWNER_KEY = "tiketpov_seat_owner"


def _seat_locks() -> SeatLockStore:
    """Kunci kursi disimpan per aplikasi, sehingga tiap instance aplikasi (dan tiap tes) terisolasi."""
    return current_app.config.setdefault("SEAT_LOCKS", SeatLockStore())


def _seat_owner() -> str:
    """Token pemilik kunci untuk sesi browser ini."""
    owner = session.get(SEAT_OWNER_KEY)
    if not owner:
        owner = secrets.token_hex(16)
        session[SEAT_OWNER_KEY] = owner
    return owner


def _prune_expired_cart() -> None:
    """Buang item keranjang yang kuncinya sudah kedaluwarsa, supaya kursi tidak dibayar setelah dilepas."""
    cart = Cart()
    locks, owner = _seat_locks(), _seat_owner()
    items = cart.items()
    for index in reversed(range(len(items))):
        if not locks.is_locked_by(items[index].key, owner):
            cart.remove(index)


def _cart_state() -> dict:
    _prune_expired_cart()
    cart = Cart()
    items = cart.items()
    return {
        "count": len(items),
        "max": MAX_CART_ITEMS,
        "keys": [item.key for item in items],
        "subtotal": sum(item.price for item in items),
        "items": [item.to_dict() for item in items],
    }


@visualizer_bp.errorhandler(SeatNotFoundError)
def handle_not_found(error: SeatNotFoundError):
    if "/api/" in request.path:
        return jsonify(error=str(error)), 404
    return render_template("error.html", code=404, message=str(error)), 404


@visualizer_bp.errorhandler(ValueError)
def handle_bad_request(error: ValueError):
    return jsonify(error=str(error)), 400


# --------------------------------------------------------------------------- #
# Halaman
# --------------------------------------------------------------------------- #
@visualizer_bp.get("/")
def index():
    """Pintu masuk dari landing: terjemahkan ?type/film/event/studio menjadi halaman studio."""
    args = request.args
    event = get_event(args.get("film") or args.get("event"))
    studio_venue = f"xxi-{args.get('studio')}"
    if studio_venue in venue_registry():
        venue_id = studio_venue
    elif event is not None:
        venue_id = event.venues[0]
    elif args.get("type") == "concert":
        venue_id = "gbk-coldplay"
    else:
        venue_id = next(iter(venue_registry()))
    film = event.event_id if event is not None and event.kind == "film" else None
    return redirect(url_for("visualizer.studio", venue_id=venue_id, film=film))


@visualizer_bp.get("/studio/<venue_id>")
def studio(venue_id: str):
    venue = get_venue(venue_id)
    film = get_event(request.args.get("film"))
    event = event_for_venue(venue_id, film.event_id if film else None)
    placeholder = "__VENUE__"
    bootstrap = {
        "venueId": venue.venue_id,
        # Film pilihan ikut dibawa saat berpindah studio, supaya trailernya tetap sama.
        "film": film.event_id if film is not None and film.kind == "film" else None,
        "venues": [{**v.summary(), "price_from": v.price_from} for v in venue_registry().values()],
        "limits": LIMITS,
        "api": {
            "layout": url_for("visualizer.api_layout", venue_id=placeholder),
            "heatmap": url_for("visualizer.api_heatmap", venue_id=placeholder),
            "pov": url_for("visualizer.api_pov"),
            "recommend": url_for("visualizer.api_recommend"),
            "cart": url_for("visualizer.api_cart"),
            "cartRemove": url_for("visualizer.api_cart_remove"),
        },
        "urls": {
            "studio": url_for("visualizer.studio", venue_id=placeholder),
            "checkout": url_for("checkout.index"),
            "landing": url_for("landing.index"),
        },
        "cart": _cart_state(),
    }
    return render_template("visualizer/studio_pov.html", venue=venue, event=event,
                           venues=list(venue_registry().values()), bootstrap=bootstrap)


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@visualizer_bp.get("/api/venues")
def api_venues():
    return jsonify(venues=[{**v.summary(), "price_from": v.price_from} for v in venue_registry().values()])


@visualizer_bp.get("/api/venues/<venue_id>/layout")
def api_layout(venue_id: str):
    venue = get_venue(venue_id)
    scoring = venue.scoring_profile()
    event = event_for_venue(venue_id, request.args.get("film"))
    layout = venue.layout()
    media = dict(layout["media"])
    if event is not None:       # layar 3D memutar trailer/rekaman acara yang dipilih
        media.update(video=asset_url(event.trailer) or media["video"], video_label=event.title,
                     poster=asset_url(event.poster) or media["poster"])
    return jsonify({
        **layout,
        "media": media,
        "event": {"event_id": event.event_id, "title": event.title, "meta": event.meta} if event else None,
        "presets": SmartSeatRecommender.presets_for(venue.kind.value),
        "lenses": [lens.to_dict() for lens in LENSES.values()],
        "limits": LIMITS,
        "default_selector": venue.default_selector(),
        "scoring": {"standard_label": scoring.standard_label, "ideal_h_fov_deg": scoring.ideal_h_fov_deg},
        "price_from": venue.price_from,
    })


@visualizer_bp.post("/api/pov")
def api_pov():
    venue, report = _evaluate(_payload())
    data = report.to_dict()
    data["in_cart"] = f"{venue.venue_id}|{report.seat.seat_id}" in Cart().seat_keys()
    return jsonify(data)


@visualizer_bp.post("/api/recommend")
def api_recommend():
    data = _payload()
    venue = get_venue(str(data.get("venue_id", "")))
    body_cm = data.get("body_height_cm", DEFAULT_BODY_CM)
    front_cm = data.get("front_height_cm", DEFAULT_BODY_CM)
    engine = engine_for(venue.venue_id)
    recommender = SmartSeatRecommender(venue, lambda seat: engine.evaluate(seat, body_cm, front_cm))
    return jsonify(recommender.recommend(str(data.get("preset", "ideal_thx"))))


@visualizer_bp.get("/api/venues/<venue_id>/heatmap")
def api_heatmap(venue_id: str):
    get_venue(venue_id)
    cells = engine_for(venue_id).heatmap(request.args.get("body_height_cm", DEFAULT_BODY_CM),
                                         request.args.get("front_height_cm", DEFAULT_BODY_CM))
    scores = [cell["score"] for cell in cells] or [0.0]
    return jsonify(venue_id=venue_id, min=min(scores), max=max(scores), cells=cells)


@visualizer_bp.get("/api/cart")
def api_cart():
    return jsonify(_cart_state())


@visualizer_bp.post("/api/cart")
def api_cart_add():
    """Tambah kursi aktif ke keranjang. Metadata POV dihitung ulang di server, bukan dari klien."""
    data = _payload()
    venue, report = _evaluate(data)
    is_standing = getattr(report.seat, "seat_type", "") == "festival"      # area berdiri: tidak memakai kata "kursi"
    if not report.seat.is_available:
        sold = "Tiket ini sudah habis." if is_standing else "Kursi ini sudah terjual."
        return jsonify(error=sold, **_cart_state()), 409
    seat_key = f"{venue.venue_id}|{report.seat.seat_id}"
    owner = _seat_owner()
    if not _seat_locks().acquire(seat_key, owner):
        busy = "Tiket ini sedang dipilih pembeli lain." if is_standing else "Kursi ini sedang dipilih pembeli lain."
        return jsonify(error=busy, **_cart_state()), 409
    event = event_for_venue(venue.venue_id, data.get("film"))
    summary = report.summary()
    item = CartItem(
        event_id=event.event_id if event else "",
        venue_id=venue.venue_id,
        venue_name=f"{event.title} · {venue.short_label}" if event else venue.name,
        seat_id=report.seat.seat_id,
        seat_label=report.seat.label,
        category=report.seat.category,
        price=report.seat.price,
        pov={**{key: summary[key] for key in POV_CART_FIELDS},
             "body_height_cm": report.viewer.stature_cm, "front_height_cm": report.front.stature_cm},
    )
    status = Cart().add(item)
    if status == "full":
        _seat_locks().release(seat_key, owner)  # kursi tidak jadi masuk keranjang, jadi kunci dilepas
    messages = {
        "added": f"{item.seat_label} masuk keranjang ({format_rupiah(item.price)}).",
        "exists": "Tiket ini sudah ada di keranjang." if is_standing else "Kursi ini sudah ada di keranjang.",
        "full": f"Keranjang penuh (maksimal {MAX_CART_ITEMS} tiket).",
    }
    code = {"added": 201, "exists": 200, "full": 409}[status]
    return jsonify(status=status, message=messages[status], **_cart_state()), code


@visualizer_bp.post("/api/cart/remove")
def api_cart_remove():
    data = _payload()
    key = f"{data.get('venue_id', '')}|{data.get('seat_id', '')}"
    cart = Cart()
    index = next((i for i, item in enumerate(cart.items()) if item.key == key), None)
    removed = index is not None and cart.remove(index)
    if removed:
        _seat_locks().release(key, _seat_owner())
    return jsonify(status="removed" if removed else "missing", **_cart_state())
