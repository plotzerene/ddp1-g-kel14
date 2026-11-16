"""Verifikasi katalog 6 film baru, poster 2:3 WebP, trailer YouTube resmi, /studio_pov, & harga ringkas."""
from __future__ import annotations

import json
import re
import struct
from pathlib import Path

import pytest

from app import create_app
from app.shared_state import EVENTS

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "movies_catalog.json"
POSTERS_DIR = ROOT / "app" / "static" / "images" / "posters"

NEW_MOVIES = {
    "how-to-lose-a-guy-in-10-days": {
        "title": "How to Lose a Guy in 10 Days",
        "poster": "how_to_lose_a_guy_in_10_days.webp",
        "embed_id": "hzNX_WZDNXE",
        "venues": ("xxi-regular", "xxi-premiere"),
        "prices": {"xxi-regular": 50_000, "xxi-premiere": 100_000},
        "price_labels": ("Rp 50 rb", "Rp 100 rb"),
    },
    "the-nun": {
        "title": "The Nun",
        "poster": "the_nun.webp",
        "embed_id": "pzD9zGcUNrw",
        "venues": ("xxi-regular",),
        "prices": {"xxi-regular": 45_000},
        "price_labels": ("Rp 45 rb",),
    },
    "the-hunger-games": {
        "title": "The Hunger Games",
        "poster": "hunger_games.webp",
        "embed_id": "mfmrPu43DF8",
        "venues": ("xxi-regular", "xxi-imax"),
        "prices": {"xxi-regular": 50_000, "xxi-imax": 75_000},
        "price_labels": ("Rp 50 rb", "Rp 75 rb"),
    },
    "spiderman-no-way-home": {
        "title": "Spider-Man: No Way Home",
        "poster": "spiderman_no_way_home.webp",
        "embed_id": "JfVOs4VSpmA",
        "venues": ("xxi-imax", "xxi-4dx"),
        "prices": {"xxi-imax": 80_000, "xxi-4dx": 75_000},
        "price_labels": ("Rp 80 rb", "Rp 75 rb"),
    },
    "chiikawa-movie": {
        "title": "Chiikawa Movie",
        "poster": "chiikawa_movie.webp",
        "embed_id": "yUwALMbnnvs",
        "venues": ("xxi-regular",),
        "prices": {"xxi-regular": 45_000},
        "price_labels": ("Rp 45 rb",),
    },
    "zootopia-2": {
        "title": "Zootopia 2",
        "poster": "zootopia_2.webp",
        "embed_id": "C5s3lua1qgk",
        "venues": ("xxi-regular", "xxi-imax"),
        "prices": {"xxi-regular": 50_000, "xxi-imax": 75_000},
        "price_labels": ("Rp 50 rb", "Rp 75 rb"),
    },
}


def _webp_dimensions(path: Path) -> tuple[int, int]:
    """Baca dimensi piksel WebP (VP8, VP8L, atau VP8X) tanpa dependensi eksternal."""
    data = path.read_bytes()
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    chunk_type = data[12:16]
    if chunk_type == b"VP8X":
        w = 1 + int.from_bytes(data[24:27], "little")
        h = 1 + int.from_bytes(data[27:30], "little")
        return w, h
    if chunk_type == b"VP8 ":
        start = 20
        assert data[start + 3:start + 6] == b"\x9d\x01\x2a"
        w_raw, h_raw = struct.unpack_from("<HH", data, start + 6)
        return w_raw & 0x3FFF, h_raw & 0x3FFF
    if chunk_type == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise AssertionError(f"Format chunk WebP tidak dikenali: {chunk_type!r}")


@pytest.fixture
def client():
    app = create_app({"TESTING": True})
    with app.test_client() as c:
        yield c


def test_real_webp_posters_and_svg_fallback_assets(client):
    assert (POSTERS_DIR / "poster_fallback.svg").is_file()
    res_svg = client.get("/static/images/posters/poster_fallback.svg")
    assert res_svg.status_code == 200
    assert b"<svg" in res_svg.data

    for spec in NEW_MOVIES.values():
        path = POSTERS_DIR / spec["poster"]
        assert path.is_file(), f"Poster WebP hilang: {path}"
        w, h = _webp_dimensions(path)
        assert w > 0 and h > 0
        assert abs((w / h) - (2 / 3)) < 0.01, f"{spec['poster']} bukan rasio 2:3 ({w}x{h})"
        res = client.get(f"/static/images/posters/{spec['poster']}")
        assert res.status_code == 200


def test_catalog_and_events_seed_include_all_six_movies():
    catalog = {m["id"]: m for m in json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["movies"]}
    for slug, spec in NEW_MOVIES.items():
        assert slug in EVENTS
        assert EVENTS[slug].venues == spec["venues"]
        assert slug in catalog
        assert catalog[slug]["title"] == spec["title"]
        assert catalog[slug]["embed_id"] == spec["embed_id"]
        assert len(catalog[slug]["synopsis"].strip()) > 30


def test_landing_detail_and_studio_pov_routes_for_new_movies(client):
    landing_html = client.get("/home").get_data(as_text=True)
    assert "poster_fallback.svg" in landing_html

    for slug, spec in NEW_MOVIES.items():
        assert spec["title"] in landing_html
        assert spec["poster"] in landing_html
        assert f"https://www.youtube-nocookie.com/embed/{spec['embed_id']}" in landing_html

        detail = client.get(f"/movie/{slug}")
        assert detail.status_code == 200
        detail_html = detail.get_data(as_text=True)
        assert spec["title"] in detail_html
        assert f"https://www.youtube-nocookie.com/embed/{spec['embed_id']}" in detail_html
        assert f"/visualizer/?film={slug}" in detail_html
        bottom_bar = detail_html.split('class="movie-bottom-bar__actions"', 1)[1].split("</div>", 1)[0]
        assert "Tonton Trailer" in bottom_bar
        assert "Pilih Jadwal &amp; Kursi" in bottom_bar
        assert "Simulasi POV 3D" not in bottom_bar
        visible_text = re.sub(r"<[^>]+>", " ", re.sub(r"<script\b.*?</script>", " ", detail_html, flags=re.S))
        assert "--" not in visible_text
        for lbl in spec["price_labels"]:
            assert lbl in detail_html

        pov_page = client.get(f"/studio_pov/{slug}")
        assert pov_page.status_code == 200
        pov_html = pov_page.get_data(as_text=True)
        assert spec["title"] in pov_html
        for lbl in spec["price_labels"]:
            assert lbl in pov_html


def test_randomized_seat_statuses_and_per_movie_pricing_cart_flow(client):
    # Dua film berbeda pada studio yang sama harus memiliki peta okupansi acak yang berbeda
    layout_nun = client.get("/visualizer/api/venues/xxi-regular/layout?film=the-nun").get_json()
    layout_chiikawa = client.get("/visualizer/api/venues/xxi-regular/layout?film=chiikawa-movie").get_json()
    statuses_nun = {s["id"]: s["status"] for s in layout_nun["seats"]}
    statuses_chiikawa = {s["id"]: s["status"] for s in layout_chiikawa["seats"]}
    assert statuses_nun != statuses_chiikawa
    assert "sold" in statuses_nun.values() and "available" in statuses_nun.values()
    assert layout_nun["price"] == 45_000
    assert layout_chiikawa["price"] == 45_000

    # Uji harga spesifik & penambahan keranjang untuk setiap film baru
    for slug, spec in NEW_MOVIES.items():
        for vid, expected_price in spec["prices"].items():
            layout = client.get(f"/visualizer/api/venues/{vid}/layout?film={slug}").get_json()
            assert layout["price"] == expected_price
            assert layout["price_from"] == expected_price

            default_id = layout["default_selector"]["seat_id"]
            status_lookup = {s["id"]: s["status"] for s in layout["seats"]}
            assert status_lookup[default_id] == "available"

            pov = client.post("/visualizer/api/pov", json={
                "venue_id": vid, "seat_id": default_id, "film": slug,
            }).get_json()
            assert pov["seat"]["price"] == expected_price
            assert pov["seat"]["status"] == "available"

            add = client.post("/visualizer/api/cart", json={
                "venue_id": vid, "seat_id": default_id, "film": slug,
            })
            assert add.status_code == 201
            assert add.get_json()["items"][-1]["price"] == expected_price
            client.post("/visualizer/api/cart/clear", json={})


def test_map_legend_uses_terpilih_tersedia_terisi_labels():
    js = (ROOT / "app" / "static" / "js" / "map_2d_picker.js").read_text(encoding="utf-8")
    assert "'Tersedia'" in js
    assert "'Terpilih'" in js
    assert "'Terisi'" in js
    assert "formatRupiahShort" in js
