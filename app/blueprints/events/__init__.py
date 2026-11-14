"""events: detail film (/movie/<slug>) dan detail konser Coldplay (/event/coldplay/...).

Teks film dibaca dari movies_catalog.json. Poster dan trailer memakai daftar EVENTS di shared_state.
Tombol beli menuju visualizer, yang sudah berjalan.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from flask import Blueprint, abort, render_template, url_for

from ...assets_sync import asset_url
from ...shared_state import EVENTS
from ..visualizer.models import get_venue

events_bp = Blueprint("events", __name__)

CATALOG_PATH = Path(__file__).resolve().parents[3] / "movies_catalog.json"
COLDPLAY_ID = "coldplay-gbk"
COLDPLAY_INFO = {
    "schedule": "Sabtu, 19 Des 2026 • 18:30 WIB (Open Gate 16:00 WIB)",
    "location": "Stadion Utama Gelora Bung Karno, Jakarta",
    "promoter": "PK Entertainment • Promotor Resmi",
}
COLDPLAY_TABS = (
    ("overview", "Ringkasan", "events.coldplay_overview"),
    ("tickets", "Tiket", "events.coldplay_tickets"),
    ("terms", "Syarat & Ketentuan", "events.coldplay_terms"),
)


@lru_cache(maxsize=1)
def _catalog() -> dict[str, dict]:
    data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return {movie["id"]: movie for movie in data["movies"]}


def _youtube_embed(embed_id: str | None) -> str:
    """URL embed YouTube tanpa cookie, atau string kosong jika ID trailer belum diisi."""
    return f"https://www.youtube-nocookie.com/embed/{embed_id}" if embed_id else ""


@events_bp.get("/movie/<slug>")
def movie(slug: str):
    details = _catalog().get(slug)
    event = EVENTS.get(slug)
    if details is None or event is None or event.kind != "film":
        abort(404)
    return render_template(
        "events/movie.html",
        movie=details,
        poster_url=asset_url(event.poster),
        trailer_local=asset_url(event.trailer),
        trailer_embed=_youtube_embed(details.get("embed_id")),
        buy_url=url_for("visualizer.index", film=slug),
    )


def _render_coldplay(tab: str):
    event = EVENTS[COLDPLAY_ID]
    venue = get_venue(event.venues[0])
    tabs = [{"key": key, "label": label, "href": url_for(endpoint), "active": key == tab}
            for key, label, endpoint in COLDPLAY_TABS]
    return render_template(
        "events/event.html",
        tab=tab,
        event=event,
        venue=venue,
        tabs=tabs,
        poster_url=asset_url(event.poster),
        buy_url=url_for("visualizer.studio", venue_id=venue.venue_id),
        categories=[{"label": b.label, "standing": b.standing} for b in venue.blocks.values()],
        info=COLDPLAY_INFO,
    )


@events_bp.get("/event/coldplay/overview")
def coldplay_overview():
    return _render_coldplay("overview")


@events_bp.get("/event/coldplay/tickets")
def coldplay_tickets():
    return _render_coldplay("tickets")


@events_bp.get("/event/coldplay/terms")
def coldplay_terms():
    return _render_coldplay("terms")
