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
import secrets
import threading
import time

from flask import current_app, session

CART_SESSION_KEY = "tiketpov_cart"
MAX_CART_ITEMS = 6          # cookie session Flask dibatasi ±4 KB; pindah ke DB bila perlu lebih

# =========================================================================== #
# 1. Harga tiket (Rupiah)
# =========================================================================== #
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


def format_rupiah_short(amount: float | int | None) -> str:
    """50000 → 'Rp 50 rb', 45000 → 'Rp 45 rb' (filter Jinja `|rupiah_short`)."""
    if amount is None:
        return "Rp 0"
    rounded = int(round(amount))
    if 1_000 <= rounded < 1_000_000 and rounded % 1_000 == 0:
        return f"Rp {rounded // 1_000} rb"
    return format_rupiah(rounded)


# =========================================================================== #
# 2. Katalog acara
# =========================================================================== #
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


def _film(
    event_id: str,
    title: str,
    meta: str,
    poster: str,
    trailer: str,
    venues: tuple[str, ...] = CINEMA_STUDIOS,
) -> Event:
    poster_path = poster if poster.startswith("images/") else f"images/{poster}"
    trailer_path = (
        f"videos/{trailer}" if trailer and not trailer.startswith("videos/") else trailer
    )
    return Event(event_id, title, "film", meta, poster_path, trailer_path, venues)


FILM_STUDIO_PRICES: dict[str, dict[str, int]] = {
    "how-to-lose-a-guy-in-10-days": {
        "xxi-regular": 50_000,
        "xxi-premiere": 100_000,
    },
    "the-nun": {
        "xxi-regular": 45_000,
    },
    "the-hunger-games": {
        "xxi-regular": 50_000,
        "xxi-imax": 75_000,
    },
    "spiderman-no-way-home": {
        "xxi-imax": 80_000,
        "xxi-4dx": 75_000,
    },
    "chiikawa-movie": {
        "xxi-regular": 45_000,
    },
    "zootopia-2": {
        "xxi-regular": 50_000,
        "xxi-imax": 75_000,
    },
}

DEFAULT_VENUE_PRICES: dict[str, int] = {
    "xxi-regular": TICKET_PRICES["regular"],
    "xxi-premiere": TICKET_PRICES["premiere"],
    "xxi-imax": TICKET_PRICES["imax"],
    "xxi-4dx": TICKET_PRICES["4dx"],
}


def price_for_film_venue(
    film_id: str | None,
    venue_id: str,
    fallback: int | None = None,
) -> int:
    """Harga kursi aktual untuk kombinasi film dan studio (override per film bila tersedia)."""
    if film_id and film_id in FILM_STUDIO_PRICES:
        override = FILM_STUDIO_PRICES[film_id].get(venue_id)
        if override is not None:
            return override
    if fallback is not None:
        return fallback
    return DEFAULT_VENUE_PRICES.get(venue_id, TICKET_PRICES["regular"])


EVENTS: dict[str, Event] = {
    event.event_id: event for event in (
        _film("sore", "SORE: Istri dari Masa Depan", "2D · 1h 48m · Drama / Romance · R13+",
              "poster_film_sore_ini_yang_rekomendasi_ya.jpg",
              "sore_istri_dari_masa_depan_official_trailer.mp4",
              ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx")),
        _film("jatuh-cinta-seperti-di-film-film", "Jatuh Cinta Seperti di Film Film",
              "2D · 1h 58m · Romance / Comedy · R13+",
              "jatuh_cinta_seperti_di_film_film_poster.jpg",
              "jatuh_cinta_seperti_di_film_film_official_trailer.mp4",
              ("xxi-regular", "xxi-premiere")),
        _film("boboiboy-the-movie", "BoBoiBoy The Movie", "2D · 1h 40m · Animation / Action · SU",
              "poster_boboiby_movie.jpg", "boboiboy_the_movie_official_trailer.mp4",
              ("xxi-regular", "xxi-4dx")),
        _film("ejen-ali-the-movie-2", "Ejen Ali: The Movie 2", "2D · 1h 45m · Animation / Action · SU",
              "ejen_ali_movie_2_poster.jpg", "ejen_ali_the_movie_2_misi_satria_official_trailer_2.mp4",
              ("xxi-regular", "xxi-imax")),
        _film("la-la-land", "La La Land", "2D · 2h 8m · Musical / Romance · R13+",
              "poster_la_la_land.jpg", "la_la_land_2016_movie_official_trailer_dreamers.mp4",
              ("xxi-regular", "xxi-premiere", "xxi-imax")),
        _film("avengers-endgame", "Avengers: Endgame", "2D / IMAX / 4DX · 3h 2m · Action / Sci-Fi · R13+",
              "poster_avengers_endgame.jpg", "trailer_cinema.mp4",
              ("xxi-regular", "xxi-imax", "xxi-4dx")),
        _film("how-to-lose-a-guy-in-10-days", "How to Lose a Guy in 10 Days",
              "2D / The Premiere XXI · 116 Menit · Romance, Comedy · 13+",
              "images/posters/how_to_lose_a_guy_in_10_days.webp", "",
              ("xxi-regular", "xxi-premiere")),
        _film("the-nun", "The Nun",
              "Regular 2D (Dolby Atmos) · 96 Menit · Horror, Mystery · 17+",
              "images/posters/the_nun.webp", "",
              ("xxi-regular",)),
        _film("the-hunger-games", "The Hunger Games",
              "Regular 2D / IMAX · 142 Menit · Sci-Fi, Action, Dystopia · 13+",
              "images/posters/hunger_games.webp", "",
              ("xxi-regular", "xxi-imax")),
        _film("spiderman-no-way-home", "Spider-Man: No Way Home",
              "IMAX with Laser / 4DX · 148 Menit · Action, Sci-Fi, Adventure · 13+",
              "images/posters/spiderman_no_way_home.webp", "",
              ("xxi-imax", "xxi-4dx")),
        _film("chiikawa-movie", "Chiikawa Movie",
              "Regular 2D · 75 Menit · Anime, Comedy, Slice of Life · SU",
              "images/posters/chiikawa_movie.webp", "",
              ("xxi-regular",)),
        _film("zootopia-2", "Zootopia 2",
              "Regular 2D / IMAX 3D · 105 Menit · Animation, Adventure, Comedy · SU",
              "images/posters/zootopia_2.webp", "",
              ("xxi-regular", "xxi-imax")),
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


# =========================================================================== #
# 3. Keranjang
# =========================================================================== #
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


# =========================================================================== #
# 4. Sesi Autentikasi & Penyimpan Pesanan (Profile & Riwayat Transaksi)
# =========================================================================== #
AUTH_SESSION_KEY = "tiketpov_user"
ORDER_OWNER_KEY = "tiketpov_seat_owner"


def current_user() -> dict[str, Any] | None:
    """Data pengguna yang sedang masuk pada sesi Flask, atau None untuk tamu."""
    raw = session.get(AUTH_SESSION_KEY)
    return dict(raw) if isinstance(raw, dict) and raw.get("email") else None


def set_current_user(user: dict[str, Any] | None) -> None:
    if user is None:
        session.pop(AUTH_SESSION_KEY, None)
    else:
        session[AUTH_SESSION_KEY] = dict(user)
    session.modified = True


def active_order_owner() -> str:
    """Kunci pemilik pesanan di store: email akun bila sudah masuk, atau token sesi."""
    user = current_user()
    if user and user.get("email"):
        return f"user:{str(user['email']).strip().lower()}"
    owner = session.get(ORDER_OWNER_KEY)
    if not owner:
        owner = secrets.token_hex(16)
        session[ORDER_OWNER_KEY] = owner
    return f"sess:{owner}"


class OrderStore:
    """Penyimpan daftar pesanan sementara (PENDING, PAID, CANCELLED, EXPIRED) per pemilik."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._orders: dict[str, list[dict[str, Any]]] = {}

    @staticmethod
    def _expire_if_needed(entry: dict[str, Any], now_ts: float) -> None:
        if entry.get("status") == "PENDING" and float(entry.get("expires_ts", 0)) <= now_ts:
            entry["status"] = "EXPIRED"
            entry.setdefault("cancelled_at", time.strftime("%d %b %Y · %H.%M WIB"))
            entry.setdefault("cancel_reason", "Batas waktu pembayaran berakhir")

    def upsert(self, owner: str, order: dict[str, Any]) -> dict[str, Any]:
        copy = dict(order)
        with self._guard:
            bucket = self._orders.setdefault(owner, [])
            for idx, existing in enumerate(bucket):
                if existing.get("code") == copy.get("code"):
                    bucket[idx] = copy
                    return dict(copy)
            bucket.insert(0, copy)
            return dict(copy)

    def list_for(self, owner: str) -> list[dict[str, Any]]:
        now_ts = time.time()
        with self._guard:
            bucket = self._orders.get(owner, [])
            for entry in bucket:
                self._expire_if_needed(entry, now_ts)
            return [dict(entry) for entry in bucket]

    def find(self, owner: str, code: str) -> dict[str, Any] | None:
        now_ts = time.time()
        with self._guard:
            for entry in self._orders.get(owner, []):
                if entry.get("code") == code:
                    self._expire_if_needed(entry, now_ts)
                    return dict(entry)
        return None

    def find_latest_pending(self, owner: str) -> dict[str, Any] | None:
        for entry in self.list_for(owner):
            if entry.get("status") == "PENDING":
                return entry
        return None

    def update_status(self, owner: str, code: str, status: str, **fields: Any) -> dict[str, Any] | None:
        with self._guard:
            for entry in self._orders.get(owner, []):
                if entry.get("code") == code:
                    entry["status"] = status
                    entry.update(fields)
                    return dict(entry)
        return None


def get_order_store() -> OrderStore:
    return current_app.config.setdefault("ORDERS_STORE", OrderStore())
