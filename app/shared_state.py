"""
shared_state.py — KONTRAK BERSAMA antara 3 modul (landing, visualizer, checkout).

Tiga hal yang dibagi di sini, dan hanya di sini:

1. `TICKET_PRICES` — satu-satunya sumber harga tiket.
2. `EVENTS`        — katalog film & konser: poster, trailer, dan venue-nya.
3. `Cart`          — keranjang di session Flask: Visualizer MENULIS, Checkout MEMBACA.

Aturan tim: ubah file ini lewat Pull Request yang disetujui ketiga anggota,
karena perubahan di sini memengaruhi semua modul.

Bentuk satu item keranjang di session (lihat `CartItem`):

    {
      "event_id": "coldplay-gbk",
      "venue_id": "gbk-coldplay",
      "venue_name": "Coldplay · Music of the Spheres — GBK Jakarta",
      "seat_id": "cat3:R14:S207",
      "seat_label": "CAT 3 · Baris 14 · Kursi 207",
      "category": "CAT 3",
      "price": 3250000,
      "pov": {"score": 71.4, "grade": "Bagus", "distance_m": 168.2, "h_fov_deg": 5.4,
              "neck_pitch_deg": -2.1, "neck_yaw_deg": 0.4, "obstruction_pct": 0.0,
              "visible_pct": 100.0, "audio_delay_ms": 481.0, "spl_db": 95.2,
              "body_height_cm": 170.0, "front_height_cm": 170.0}
    }
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, MutableMapping

from flask import session

CART_SESSION_KEY = "tiketpov_cart"
MAX_CART_ITEMS = 6          # cookie session Flask dibatasi ±4 KB; pindah ke DB bila perlu lebih

# --------------------------------------------------------------------------- #
# 1. Harga tiket (Rupiah)
# --------------------------------------------------------------------------- #
TICKET_PRICES: dict[str, int] = {
    # Cinema XXI — per kursi
    "regular": 50_000,
    "premiere": 150_000,
    "imax": 85_000,
    "4dx": 110_000,
    # Coldplay GBK — sesuai peta kategori resmi
    "gbk:ultimate": 11_000_000,
    "gbk:my_universe": 5_700_000,
    "gbk:cat1": 5_000_000,
    "gbk:cat2": 4_000_000,
    "gbk:festival": 3_500_000,
    "gbk:cat3": 3_250_000,
    "gbk:cat4": 2_500_000,
    "gbk:cat5": 1_750_000,
    "gbk:cat6": 1_250_000,
    "gbk:cat7": 1_250_000,
    "gbk:cat8": 800_000,
}


def format_rupiah(amount: float | int | None) -> str:
    """50000 → 'Rp 50.000' (dipakai juga sebagai filter Jinja `|rupiah`)."""
    if amount is None:
        return "Rp 0"
    return "Rp " + f"{int(round(amount)):,}".replace(",", ".")


# --------------------------------------------------------------------------- #
# 2. Katalog acara
# --------------------------------------------------------------------------- #
# ponytail: semua film bisa dibuka di keempat studio; batasi per film bila jadwal nyata dibutuhkan.
CINEMA_STUDIOS: tuple[str, ...] = ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx")


@dataclass(frozen=True)
class Event:
    """Satu judul di katalog. `poster`/`trailer` = path relatif di static/reference_assets/
    (nama file hasil normalisasi `assets_sync.normalize_name`)."""

    event_id: str               # slug, dipakai di URL: /visualizer?type=cinema&film=<event_id>
    title: str
    kind: str                   # "film" | "concert"
    meta: str                   # "2D · 1h 48m · Drama / Romance · R13+"
    poster: str
    trailer: str
    venues: tuple[str, ...]     # venue_id di modul visualizer


def _film(event_id: str, title: str, meta: str, poster: str, trailer: str) -> Event:
    return Event(event_id, title, "film", meta, f"images/{poster}", f"videos/{trailer}", CINEMA_STUDIOS)


EVENTS: dict[str, Event] = {
    event.event_id: event for event in (
        _film("sore", "SORE: Istri dari Masa Depan", "2D · 1h 48m · Drama / Romance · R13+",
              "poster_film_sore_ini_yang_rekomendasi_ya.jpg",
              "sore_istri_dari_masa_depan_official_trailer.mp4"),
        _film("jatuh-cinta-seperti-di-film-film", "Jatuh Cinta Seperti di Film Film",
              "2D · 1h 58m · Romance / Comedy · R13+",
              "jatuh_cinta_seperti_di_film_film_poster.jpg",
              "jatuh_cinta_seperti_di_film_film_official_trailer.mp4"),
        _film("boboiboy-the-movie", "BoBoiBoy The Movie", "2D · 1h 40m · Animation / Action · SU",
              "poster_boboiby_movie.jpg", "boboiboy_the_movie_official_trailer.mp4"),
        _film("ejen-ali-the-movie-2", "Ejen Ali: The Movie 2", "2D · 1h 45m · Animation / Action · SU",
              "ejen_ali_movie_2_poster.jpg", "ejen_ali_the_movie_2_misi_satria_official_trailer_2.mp4"),
        _film("la-la-land", "La La Land", "2D · 2h 8m · Musical / Romance · R13+",
              "poster_la_la_land.jpg", "la_la_land_2016_movie_official_trailer_dreamers.mp4"),
        _film("avengers-endgame", "Avengers: Endgame", "2D / IMAX / 4DX · 3h 2m · Action / Sci-Fi · R13+",
              "poster_avengers_endgame.jpg", "trailer_cinema.mp4"),
        Event("coldplay-gbk", "Coldplay: Music of the Spheres", "concert",
              "Stadion Utama Gelora Bung Karno · Jakarta · Live Concert",
              "images/poster_coldplay_konser.jpg", "videos/coldplay_live.mp4", ("gbk-coldplay",)),
    )
}


def get_event(event_id: str | None) -> Event | None:
    return EVENTS.get(event_id or "")


def event_for_venue(venue_id: str, preferred: str | None = None) -> Event | None:
    """Acara untuk sebuah venue. `preferred` (slug film dari URL) dipakai bila memang tayang di sana;
    selain itu judul pertama di katalog yang memakai venue tersebut."""
    chosen = get_event(preferred)
    if chosen is not None and venue_id in chosen.venues:
        return chosen
    return next((event for event in EVENTS.values() if venue_id in event.venues), None)


# --------------------------------------------------------------------------- #
# 3. Keranjang
# --------------------------------------------------------------------------- #
@dataclass
class CartItem:
    event_id: str
    venue_id: str
    venue_name: str
    seat_id: str
    seat_label: str
    category: str
    price: int
    pov: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.venue_id}|{self.seat_id}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CartItem":
        return cls(
            event_id=str(data.get("event_id", "")),
            venue_id=str(data.get("venue_id", "")),
            venue_name=str(data.get("venue_name", "")),
            seat_id=str(data.get("seat_id", "")),
            seat_label=str(data.get("seat_label", "")),
            category=str(data.get("category", "")),
            price=int(data.get("price", 0)),
            pov=dict(data.get("pov") or {}),
        )


class Cart:
    """Pembungkus keranjang di session. Pakai: `Cart().add(item)` / `Cart().items()`."""

    def __init__(self, store: MutableMapping[str, Any] | None = None) -> None:
        self._store = session if store is None else store

    def _raw(self) -> list[dict[str, Any]]:
        raw = self._store.get(CART_SESSION_KEY, [])
        return raw if isinstance(raw, list) else []

    def _save(self, items: list[CartItem]) -> None:
        self._store[CART_SESSION_KEY] = [item.to_dict() for item in items]
        if hasattr(self._store, "modified"):
            self._store.modified = True     # type: ignore[attr-defined]

    def items(self) -> list[CartItem]:
        return [CartItem.from_dict(entry) for entry in self._raw() if isinstance(entry, dict)]

    def add(self, item: CartItem) -> str:
        """Mengembalikan 'added', 'exists' (kursi sudah ada), atau 'full'."""
        items = self.items()
        if any(existing.key == item.key for existing in items):
            return "exists"
        if len(items) >= MAX_CART_ITEMS:
            return "full"
        self._save(items + [item])
        return "added"

    def remove(self, index: int) -> bool:
        items = self.items()
        if not 0 <= index < len(items):
            return False
        del items[index]
        self._save(items)
        return True

    def clear(self) -> None:
        self._save([])

    @property
    def count(self) -> int:
        return len(self._raw())

    @property
    def subtotal(self) -> int:
        return sum(item.price for item in self.items())

    def seat_keys(self) -> list[str]:
        return [item.key for item in self.items()]
