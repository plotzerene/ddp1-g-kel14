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

from flask import Blueprint, abort, current_app, jsonify, redirect, render_template, request, session, url_for

from ...assets_sync import POSTER_FALLBACK_REL, asset_url
from ...shared_state import (
    MAX_CART_ITEMS,
    Cart,
    CartItem,
    event_for_venue,
    format_rupiah,
    get_event,
    price_for_film_venue,
)
from .engine.geometry_3d import LENSES
from .engine.obstruction import DEFAULT_BODY_CM, MAX_BODY_CM, MIN_BODY_CM
from .engine.pov_engine import PovReport, engine_for
from .engine.seat_lock import SeatLockStore
from .engine.sightline_ai import SmartSeatRecommender
from .models import SeatNotFoundError, Venue, get_venue, venue_registry
from .models.base_venue import SeatStatus

visualizer_bp = Blueprint("visualizer", __name__, template_folder="templates")

POV_CART_FIELDS = ("score", "grade", "distance_m", "h_fov_deg", "neck_pitch_deg", "neck_yaw_deg",
                   "obstruction_pct", "visible_pct", "audio_delay_ms", "spl_db")
LIMITS = {"body_min_cm": MIN_BODY_CM, "body_max_cm": MAX_BODY_CM, "body_default_cm": DEFAULT_BODY_CM}


# =========================================================================== #
# Helper
# =========================================================================== #
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
    locks = _seat_locks()
    lock_seconds_left = int(round(min((locks.seconds_left(i.key) for i in items), default=0)))
    return {
        "count": len(items),
        "max": MAX_CART_ITEMS,
        "keys": [item.key for item in items],
        "subtotal": sum(item.price for item in items),
        "lock_seconds_left": lock_seconds_left,
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


# =========================================================================== #
# Halaman
# =========================================================================== #
CONCERT_ZONE_ORDER: tuple[str, ...] = (
    "Festival",
    "Ultimate Experience",
    "My Universe",
    "CAT 1",
    "CAT 2",
    "CAT 3",
    "CAT 4",
    "CAT 5",
    "CAT 6",
    "CAT 7",
    "CAT 8",
)


def _concert_zone_tabs(venue) -> list[dict]:
    """Bangun daftar tab zona stadion GBK terurut tanpa mencampur studio bioskop."""
    grouped: dict[str, list[dict]] = {}
    for block in venue.layout().get("blocks", []):
        cat = block.get("category") or block.get("label") or ""
        if cat:
            grouped.setdefault(cat, []).append(block)

    ordered_cats = [cat for cat in CONCERT_ZONE_ORDER if cat in grouped]
    for cat in grouped:
        if cat not in ordered_cats:
            ordered_cats.append(cat)

    tabs: list[dict] = []
    for cat in ordered_cats:
        blocks = grouped[cat]
        tabs.append({
            "category": cat,
            "label": "Festival Standing" if cat == "Festival" else cat,
            "block_id": blocks[0]["id"],
            "block_ids": [b["id"] for b in blocks],
            "price": blocks[0]["price"],
        })
    return tabs


@visualizer_bp.get("/")
def index():
    """Pintu masuk dari landing: terjemahkan ?type/film/event/studio menjadi halaman studio."""
    args = request.args
    event = get_event(args.get("film") or args.get("event"))
    studio_venue = f"xxi-{args.get('studio')}"
    if studio_venue in venue_registry() and (event is None or studio_venue in event.venues):
        venue_id = studio_venue
    elif event is not None:
        venue_id = event.venues[0]
    elif args.get("type") == "concert":
        venue_id = "gbk-coldplay"
    else:
        venue_id = next(iter(venue_registry()))
    film = event.event_id if event is not None and event.kind == "film" else None
    return redirect(url_for("visualizer.studio", venue_id=venue_id, film=film))


def _seat_status(venue: Venue, seat, film_id: str | None) -> SeatStatus:
    if hasattr(venue, "seat_status_for"):
        return venue.seat_status_for(seat, film_id)
    return seat.status


def _seat_price(venue: Venue, seat, film_id: str | None) -> int:
    if venue.kind.value == "cinema":
        return price_for_film_venue(film_id, venue.venue_id, seat.price)
    return seat.price


@visualizer_bp.get("/studio/<venue_id>")
def studio(venue_id: str):
    return _render_studio(venue_id)


def studio_pov(event_id: str):
    """Rute langsung simulator denah kursi & POV 3D untuk film/konser (/studio_pov/<event_id>)."""
    event = get_event(event_id)
    if event is None:
        abort(404)
    requested_studio = (request.args.get("studio") or "").strip()
    venue_id = requested_studio if requested_studio in event.venues else event.venues[0]
    return _render_studio(venue_id, forced_event=event)


def _render_studio(venue_id: str, forced_event=None):
    venue = get_venue(venue_id)
    is_concert = venue.kind.value == "concert"
    requested_film = forced_event if forced_event is not None else (
        None if is_concert else get_event(request.args.get("film"))
    )
    if requested_film is not None and requested_film.kind != "film" and forced_event is None:
        requested_film = None

    cinema_arg = (request.args.get("cinema") or "").strip()
    date_arg = (request.args.get("date") or "").strip()
    time_arg = (request.args.get("time") or "").strip()

    if not is_concert and requested_film is not None and venue_id not in requested_film.venues:
        target_venue = requested_film.venues[0]
        return redirect(url_for(
            "visualizer.studio",
            venue_id=target_venue,
            film=requested_film.event_id,
            cinema=cinema_arg or None,
            date=date_arg or None,
            time=time_arg or None,
        ))

    event = forced_event or event_for_venue(venue_id, requested_film.event_id if requested_film else None)
    film = event if not is_concert and event is not None and event.kind == "film" else requested_film
    film_id = film.event_id if film is not None else None

    if is_concert:
        venue_tabs = []
        concert_zones = _concert_zone_tabs(venue)
        boot_venues = []
        venue_prices: dict[str, int] = {}
    else:
        registry = venue_registry()
        allowed_ids = event.venues if event is not None else tuple(registry.keys())
        venue_tabs = [
            registry[vid] for vid in allowed_ids
            if vid in registry and registry[vid].kind.value == "cinema"
        ]
        concert_zones = []
        venue_prices = {
            v.venue_id: price_for_film_venue(film_id, v.venue_id, v.price_from)
            for v in venue_tabs
        }
        boot_venues = [{**v.summary(), "price_from": venue_prices[v.venue_id]} for v in venue_tabs]

    schedule = {
        "cinema": cinema_arg or ("Stadion Utama GBK" if is_concert else "AGORA MALL XXI"),
        "date": date_arg or ("19 Des 2026" if is_concert else "Sabtu, 14 Nov 2026"),
        "time": (
            time_arg if ("WIB" in time_arg) else (f"{time_arg} WIB" if time_arg else ("19:30 WIB" if is_concert else "19:00 WIB"))
        ),
    }
    event_poster = asset_url(event.poster) if event is not None and event.poster else ""
    fallback_poster = asset_url(POSTER_FALLBACK_REL) or "/static/images/posters/poster_fallback.svg"
    placeholder = "__VENUE__"
    bootstrap = {
        "venueId": venue.venue_id,
        # Film pilihan ikut dibawa saat berpindah studio, supaya trailernya dan harganya tetap sama.
        "film": film.event_id if not is_concert and film is not None and film.kind == "film" else None,
        "schedule": schedule,
        "venues": boot_venues,
        "limits": LIMITS,
        "posterFallbackUrl": fallback_poster,
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
                           schedule=schedule, event_poster=event_poster or fallback_poster,
                           venues=venue_tabs, venue_prices=venue_prices,
                           concert_zones=concert_zones, bootstrap=bootstrap)


# =========================================================================== #
# API
# =========================================================================== #
@visualizer_bp.get("/api/venues")
def api_venues():
    return jsonify(venues=[{**v.summary(), "price_from": v.price_from} for v in venue_registry().values()])


@visualizer_bp.get("/api/venues/<venue_id>/layout")
def api_layout(venue_id: str):
    venue = get_venue(venue_id)
    scoring = venue.scoring_profile()
    film_arg = request.args.get("film")
    event = event_for_venue(venue_id, film_arg)
    active_film = film_arg or (event.event_id if event is not None and event.kind == "film" else None)
    price_override = (
        price_for_film_venue(active_film, venue_id, venue.price_from)
        if venue.kind.value == "cinema"
        else None
    )
    layout = (
        venue.layout_for_film(active_film, price_override=price_override)
        if hasattr(venue, "layout_for_film")
        else venue.layout()
    )
    media = dict(layout["media"])
    if event is not None:       # layar 3D memutar trailer/rekaman acara yang dipilih
        media.update(video=asset_url(event.trailer) or media["video"], video_label=event.title,
                     poster=asset_url(event.poster) or media["poster"])
    default_selector = (
        venue.default_selector_for_film(active_film)
        if hasattr(venue, "default_selector_for_film")
        else venue.default_selector()
    )
    return jsonify({
        **layout,
        "media": media,
        "event": {"event_id": event.event_id, "title": event.title, "meta": event.meta} if event else None,
        "presets": SmartSeatRecommender.presets_for(venue.kind.value),
        "lenses": [lens.to_dict() for lens in LENSES.values()],
        "limits": LIMITS,
        "default_selector": default_selector,
        "scoring": {"standard_label": scoring.standard_label, "ideal_h_fov_deg": scoring.ideal_h_fov_deg},
        "price_from": price_override if price_override is not None else venue.price_from,
    })


@visualizer_bp.post("/api/pov")
def api_pov():
    payload = _payload()
    venue, report = _evaluate(payload)
    film_id = payload.get("film")
    data = report.to_dict()
    data["seat"]["status"] = _seat_status(venue, report.seat, film_id).value
    data["seat"]["price"] = _seat_price(venue, report.seat, film_id)
    data["in_cart"] = f"{venue.venue_id}|{report.seat.seat_id}" in Cart().seat_keys()
    return jsonify(data)


@visualizer_bp.post("/api/recommend")
def api_recommend():
    data = _payload()
    venue = get_venue(str(data.get("venue_id", "")))
    film_id = data.get("film")
    body_cm = data.get("body_height_cm", DEFAULT_BODY_CM)
    front_cm = data.get("front_height_cm", DEFAULT_BODY_CM)
    engine = engine_for(venue.venue_id)
    recommender = SmartSeatRecommender(venue, lambda seat: engine.evaluate(seat, body_cm, front_cm))
    result = recommender.recommend(
        str(data.get("preset", "ideal_thx")),
        available_fn=lambda seat: _seat_status(venue, seat, film_id) is SeatStatus.AVAILABLE,
    )
    if venue.kind.value == "cinema" and film_id:
        adjusted_price = price_for_film_venue(film_id, venue.venue_id)
        for rec in result.get("recommendations", []):
            rec["price"] = adjusted_price
    return jsonify(result)


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
    film_id = data.get("film")
    is_standing = getattr(report.seat, "seat_type", "") == "festival"      # area berdiri: tidak memakai kata "kursi"
    if _seat_status(venue, report.seat, film_id) is not SeatStatus.AVAILABLE:
        sold = "Tiket ini sudah habis." if is_standing else "Kursi ini sudah terjual."
        return jsonify(
            error=sold,
            conflict_kind="sold",
            conflict_seat_id=report.seat.seat_id,
            conflict_label=report.seat.label,
            conflict_standing=is_standing,
            **_cart_state(),
        ), 409
    seat_key = f"{venue.venue_id}|{report.seat.seat_id}"
    owner = _seat_owner()
    if not _seat_locks().acquire(seat_key, owner):
        busy = "Tiket ini sedang dipilih pembeli lain." if is_standing else "Kursi ini sedang dipilih pembeli lain."
        return jsonify(
            error=busy,
            conflict_kind="collision",
            conflict_seat_id=report.seat.seat_id,
            conflict_label=report.seat.label,
            conflict_standing=is_standing,
            **_cart_state(),
        ), 409
    event = event_for_venue(venue.venue_id, film_id)
    summary = report.summary()
    raw_schedule = data.get("schedule") if isinstance(data.get("schedule"), dict) else {}
    is_concert_venue = venue.kind.value == "concert"
    studio_labels = {
        "xxi-regular": "Studio 1",
        "xxi-premiere": "Studio Premiere",
        "xxi-imax": "Studio IMAX",
        "xxi-4dx": "Studio 4DX",
    }
    show_date = str(raw_schedule.get("date") or ("Sabtu, 19 Des 2026" if is_concert_venue else "Sabtu, 14 Nov 2026"))[:60]
    show_time = str(raw_schedule.get("time") or ("19:30 WIB" if is_concert_venue else "19:00 WIB"))[:30]
    cinema_name = str(raw_schedule.get("cinema") or ("Stadion Utama GBK" if is_concert_venue else "AGORA MALL XXI"))[:60]
    studio_label = "Pintu Timur" if is_concert_venue else studio_labels.get(venue.venue_id, venue.short_label)
    seat_price = _seat_price(venue, report.seat, film_id)
    item = CartItem(
        event_id=event.event_id if event else "",
        venue_id=venue.venue_id,
        venue_name=f"{event.title} · {venue.short_label}" if event else venue.name,
        seat_id=report.seat.seat_id,
        seat_label=report.seat.label,
        category=report.seat.category,
        price=seat_price,
        pov={**{key: summary[key] for key in POV_CART_FIELDS},
             "body_height_cm": report.viewer.stature_cm, "front_height_cm": report.front.stature_cm,
             "show_date": show_date, "show_time": show_time,
             "cinema_name": cinema_name, "studio_label": studio_label},
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


@visualizer_bp.post("/api/cart/clear")
def api_cart_clear():
    _seat_locks().release_all(_seat_owner())
    Cart().clear()
    return jsonify(status="cleared", **_cart_state())
