"""
cinema_xxi.py — Empat tipe studio Cinema XXI sebagai hierarki kelas.

    Venue (ABC)
      └── CinemaStudio            ← logika bersama: grid kursi, ruang, akustik, layout JSON
            ├── RegularStudio     ← 13 baris × 18 kursi, layar 14 × 6 m
            ├── PremiereStudio    ← 5 baris × 8 recliner berpasangan (ReclinerSeat)
            ├── IMAXStudio        ← 14 baris × 22 kursi, layar lengkung 22 × 12 m
            └── FourDXStudio      ← 8 baris × 16 kursi gerak blok-4 (MotionSeat)

    SeatNode (ABC)
      └── CinemaSeat ─┬─ ReclinerSeat (postur rebah, sandaran kaki)
                      └─ MotionSeat   (profil gerak hidrolik)

Subclass hanya meng-override "hook" kecil (`gap_after`, `_group_id`, `_create_screen`,
`interior_theme`, ...), sisanya diwarisi — contoh inheritance + polimorfisme.

Catatan konvensi XXI: baris A adalah baris PALING BELAKANG (paling atas),
huruf terakhir paling dekat layar. Nomor kursi 1 ada di sisi kiri penonton.
"""
from __future__ import annotations

import hashlib
import random
import string
from dataclasses import dataclass
from functools import cached_property
from typing import ClassVar, Sequence

from ....assets_sync import asset_url, photo_entry
from ....shared_state import TICKET_PRICES
from ..engine.acoustics import AcousticEnvironment, SpeakerSource
from ..engine.geometry_3d import Vec3
from ..engine.obstruction import ObstructionModel, Posture, SeatedRowObstruction
from ..engine.sightline_ai import ScoringProfile
from .base_venue import (
    FrontNeighbor, Occluder, ScreenSurface, SeatNode, SeatNotFoundError, SeatStatus,
    SurfaceShape, TargetStage, Venue, VenueKind,
)

CINEMA_WEIGHTS = {"fov": 0.28, "neck": 0.24, "off_axis": 0.14, "obstruction": 0.20, "acoustic": 0.14}
BASE_CATALOG_FILMS = frozenset({
    "sore",
    "jatuh-cinta-seperti-di-film-film",
    "boboiboy-the-movie",
    "ejen-ali-the-movie-2",
    "la-la-land",
    "avengers-endgame",
})


@dataclass(frozen=True)
class StudioSpec:
    """Ukuran fisik satu tipe studio (semua dalam meter)."""

    studio_type: str
    rows: int
    seats_per_row: int
    seat_pitch_m: float
    row_depth_m: float
    row_rise_m: float
    first_row_distance_m: float
    screen_width_m: float
    screen_height_m: float
    screen_bottom_m: float
    aisle_after: tuple[int, ...]
    aisle_width_m: float
    price_key: str
    ideal_h_fov_deg: float
    fov_sigma: tuple[float, float]
    standard_label: str
    side_margin_m: float = 1.3
    back_margin_m: float = 1.6
    mean_absorption: float = 0.60
    sold_ratio: float = 0.24


# =========================================================================== #
# Target: layar
# =========================================================================== #
class CinemaScreen(TargetStage):
    """Layar datar di bidang z = 0 yang menghadap penonton (+z)."""

    has_subtitles = True

    def __init__(self, width: float, height: float, bottom: float, label: str = "Layar") -> None:
        super().__init__("screen", label, "Fokus Layar", "layar")
        self.surface = self._make_surface(width, height, bottom)

    def _make_surface(self, width: float, height: float, bottom: float) -> ScreenSurface:
        return ScreenSurface("screen", self.label, SurfaceShape.FLAT,
                             Vec3(0.0, bottom + height / 2.0, 0.0), width, height)

    @property
    def focus_point(self) -> Vec3:
        return self.surface.center

    def surfaces(self) -> list[ScreenSurface]:
        return [self.surface]

    def sightline_span(self) -> tuple[Vec3, Vec3]:
        edges = self.surface.edges()
        return edges["bottom"], edges["top"]

    def performance_points(self) -> list[Vec3]:
        return [self.surface.center]

    @property
    def extent_width(self) -> float:
        return self.surface.width

    @property
    def facing_normal(self) -> Vec3:
        return self.surface.normal


class CurvedCinemaScreen(CinemaScreen):
    """Layar IMAX melengkung: busur silinder, kedua tepi maju ke arah penonton."""

    def __init__(self, width: float, height: float, bottom: float, radius: float) -> None:
        self.radius = radius
        super().__init__(width, height, bottom, label="Layar Lengkung IMAX")

    def _make_surface(self, width: float, height: float, bottom: float) -> ScreenSurface:
        return ScreenSurface("screen", self.label, SurfaceShape.CURVED,
                             Vec3(0.0, bottom + height / 2.0, 0.0), width, height,
                             curve_radius=self.radius)


# =========================================================================== #
# Kursi
# =========================================================================== #
class CinemaSeat(SeatNode):
    """Kursi bioskop standar: duduk tegak menghadap layar (-z)."""

    seat_type = "regular"
    FACING: ClassVar[Vec3] = Vec3(0.0, 0.0, -1.0)

    def __init__(self, *, seat_id: str, category: str, price: int, status: SeatStatus,
                 row_index: int, row_letter: str, number: int, position: Vec3,
                 spec: StudioSpec, group_id: str | None = None) -> None:
        super().__init__(seat_id, f"Baris {row_letter} · Kursi {number}", category, price, status)
        self.row_index = row_index          # 0 = baris terdekat ke layar
        self.row_letter = row_letter
        self.number = number
        self.position = position
        self.spec = spec
        self.group_id = group_id
        self._front: CinemaSeat | None = None

    def link_front(self, seat: "CinemaSeat") -> None:
        self._front = seat

    @property
    def floor_position(self) -> Vec3:
        return self.position

    @property
    def facing(self) -> Vec3:
        return self.FACING

    @property
    def posture(self) -> Posture:
        return Posture.SEATED

    def front_neighbor(self) -> FrontNeighbor | None:
        front = self._front
        if front is None:
            return None
        return FrontNeighbor(front.floor_position, front.posture, front.seat_height_m, front.recline_deg)

    def is_adjacent_to(self, other: SeatNode) -> bool:
        return (isinstance(other, CinemaSeat) and other.row_index == self.row_index
                and abs(other.number - self.number) <= 1)

    def frame_dict(self) -> dict:
        return {
            "seat_type": self.seat_type,
            "row_depth": self.spec.row_depth_m,
            "row_rise": self.spec.row_rise_m,
            "seat_pitch": self.spec.seat_pitch_m,
            "is_front_row": self._front is None,
            "group": self.group_id,
        }

    def layout_dict(self) -> dict:
        return {
            "id": self.seat_id, "row": self.row_letter, "row_index": self.row_index,
            "number": self.number, "x": round(self.position.x, 3), "y": round(self.position.y, 3),
            "z": round(self.position.z, 3), "status": self.status.value, "group": self.group_id,
        }


class ReclinerSeat(CinemaSeat):
    """Recliner kulit The Premiere: badan rebah, kaki di atas footrest."""

    seat_type = "recliner"
    seat_height_m = 0.46
    RECLINE_DEG: ClassVar[float] = 22.0

    @property
    def posture(self) -> Posture:
        return Posture.RECLINED

    @property
    def recline_deg(self) -> float:
        return self.RECLINE_DEG

    def frame_dict(self) -> dict:
        return {**super().frame_dict(),
                "footrest": {"raised": True, "length_m": 0.62, "top_y": 0.50}}


class MotionSeat(CinemaSeat):
    """Kursi gerak 4DX di atas basis hidrolik (satu basis untuk 4 kursi)."""

    seat_type = "motion"
    seat_height_m = 0.50
    MOTION: ClassVar[dict] = {"roll_deg": 3.0, "pitch_deg": 2.4, "heave_m": 0.03}

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.motion_pivot = self.position

    def frame_dict(self) -> dict:
        return {**super().frame_dict(),
                "motion": {**self.MOTION, "pivot": self.motion_pivot.to_list()},
                "footrest": {"raised": False, "length_m": 0.35, "top_y": 0.18}}


# =========================================================================== #
# Studio
# =========================================================================== #
class CinemaStudio(Venue):
    """Basis semua studio: membangun grid kursi dari `StudioSpec`."""

    SPEC: ClassVar[StudioSpec]
    display_name: ClassVar[str]
    tagline_text: ClassVar[str]
    seat_class: ClassVar[type[CinemaSeat]] = CinemaSeat
    PHOTOS: ClassVar[tuple[tuple[str, str], ...]] = ()

    def __init__(self) -> None:
        spec = self.SPEC
        super().__init__(f"xxi-{spec.studio_type}", f"Cinema XXI · {self.display_name}",
                         VenueKind.CINEMA, self.tagline_text)
        self.price = TICKET_PRICES[spec.price_key]
        self._columns = self._column_offsets()
        self._screen = self._create_screen()
        self._grid = self._build_seats()
        self._seats = {seat.seat_id: seat for row in self._grid for seat in row}
        self._film_statuses: dict[str, dict[str, SeatStatus]] = {}
        self._obstruction = SeatedRowObstruction()

    # === hook yang boleh di-override subclass ================================
    def gap_after(self, number: int) -> float:
        """Celah tambahan (m) setelah kursi bernomor `number` — lorong, meja, dsb."""
        return self.SPEC.aisle_width_m if number in self.SPEC.aisle_after else 0.0

    def _group_id(self, row_letter: str, number: int) -> str | None:
        return None

    def _create_screen(self) -> CinemaScreen:
        spec = self.SPEC
        return CinemaScreen(spec.screen_width_m, spec.screen_height_m, spec.screen_bottom_m)

    def _after_build(self, grid: list[list[CinemaSeat]]) -> None:
        """Kesempatan subclass melengkapi kursi setelah grid jadi."""

    def interior_theme(self) -> dict:
        raise NotImplementedError

    def special_features(self) -> dict:
        return {}

    def furniture(self) -> list[dict]:
        return []

    # === pembangunan grid ====================================================
    def _column_offsets(self) -> list[float]:
        """Posisi x tiap nomor kursi, simetris terhadap sumbu tengah layar."""
        spec, cursor, centers = self.SPEC, 0.0, []
        for number in range(1, spec.seats_per_row + 1):
            centers.append(cursor + spec.seat_pitch_m / 2.0)
            cursor += spec.seat_pitch_m
            if number < spec.seats_per_row:
                cursor += self.gap_after(number)
        return [x - cursor / 2.0 for x in centers]

    def _status_for(self, seat_id: str, row_index: int) -> SeatStatus:
        """Kursi 'terjual' pseudo-acak tapi deterministik (hash), baris belakang lebih laku."""
        digest = hashlib.md5(f"{self.venue_id}:{seat_id}".encode()).digest()
        roll = int.from_bytes(digest[:2], "big") / 65535.0
        popularity = 0.4 + 1.2 * row_index / max(1, self.SPEC.rows - 1)
        return SeatStatus.SOLD if roll < self.SPEC.sold_ratio * popularity else SeatStatus.AVAILABLE

    def _build_seats(self) -> list[list[CinemaSeat]]:
        spec = self.SPEC
        letters = string.ascii_uppercase[:spec.rows]
        grid: list[list[CinemaSeat]] = []
        for row_index in range(spec.rows):
            letter = letters[spec.rows - 1 - row_index]         # A = paling belakang
            z = spec.first_row_distance_m + row_index * spec.row_depth_m
            y = row_index * spec.row_rise_m
            row: list[CinemaSeat] = []
            for col, x in enumerate(self._columns):
                number = col + 1
                seat_id = f"{letter}{number}"
                seat = self.seat_class(
                    seat_id=seat_id, category=self.display_name, price=self.price,
                    status=self._status_for(seat_id, row_index), row_index=row_index,
                    row_letter=letter, number=number, position=Vec3(x, y, z), spec=spec,
                    group_id=self._group_id(letter, number),
                )
                if row_index > 0:
                    seat.link_front(grid[row_index - 1][col])
                row.append(seat)
            grid.append(row)
        self._after_build(grid)
        return grid

    # === kontrak Venue =======================================================
    def targets(self) -> list[TargetStage]:
        return [self._screen]

    def occluders(self) -> list[Occluder]:
        return []

    def resolve_seat(self, selector: dict) -> SeatNode:
        seat_id = str(selector.get("seat_id", "")).strip().upper()
        try:
            return self._seats[seat_id]
        except KeyError as exc:
            raise SeatNotFoundError(f"Kursi '{seat_id}' tidak ada di {self.name}.") from exc

    def candidate_seats(self) -> Sequence[SeatNode]:
        return list(self._seats.values())

    @property
    def short_label(self) -> str:
        return self.display_name

    def default_selector(self) -> dict:
        """Kursi tersedia terdekat ke tengah baris pada ±60% kedalaman studio."""
        return self.default_selector_for_film(None)

    def _film_status_map(self, film_id: str | None) -> dict[str, SeatStatus] | None:
        if not film_id or film_id in BASE_CATALOG_FILMS:
            return None
        cached = self._film_statuses.get(film_id)
        if cached is not None:
            return cached
        rng = random.Random(f"titiket-seatmap:{self.venue_id}:{film_id}")
        rows_count = max(1, self.SPEC.rows - 1)
        status_map: dict[str, SeatStatus] = {}
        for row in self._grid:
            avail_count = 0
            for seat in row:
                popularity = 0.4 + 1.2 * seat.row_index / rows_count
                threshold = min(0.75, max(0.10, self.SPEC.sold_ratio * popularity))
                st = SeatStatus.SOLD if rng.random() < threshold else SeatStatus.AVAILABLE
                status_map[seat.seat_id] = st
                if st is SeatStatus.AVAILABLE:
                    avail_count += 1
            if avail_count == 0 and row:
                pick = row[len(row) // 2]
                status_map[pick.seat_id] = SeatStatus.AVAILABLE
        self._film_statuses[film_id] = status_map
        return status_map

    def seat_status_for(self, seat: SeatNode, film_id: str | None = None) -> SeatStatus:
        status_map = self._film_status_map(film_id)
        if status_map is None:
            return seat.status
        return status_map.get(seat.seat_id, seat.status)

    def default_selector_for_film(self, film_id: str | None = None) -> dict:
        """Kursi tersedia terdekat ke tengah baris pada ±60% kedalaman studio untuk film tertentu."""
        row = self._grid[round((self.SPEC.rows - 1) * 0.6)]
        middle = (len(row) - 1) / 2.0
        available = [
            seat for seat in row
            if self.seat_status_for(seat, film_id) is SeatStatus.AVAILABLE
        ] or row
        best = min(available, key=lambda seat: abs((seat.number - 1) - middle))
        return {"seat_id": best.seat_id}

    def obstruction_model(self, seat: SeatNode) -> ObstructionModel:
        return self._obstruction

    @cached_property
    def room(self) -> dict:
        spec = self.SPEC
        row_width = self._columns[-1] - self._columns[0] + spec.seat_pitch_m
        width = max(row_width + 2.0 * spec.side_margin_m, spec.screen_width_m + 2.4)
        depth = spec.first_row_distance_m + (spec.rows - 1) * spec.row_depth_m + spec.back_margin_m
        back_floor = (spec.rows - 1) * spec.row_rise_m
        height = max(spec.screen_bottom_m + spec.screen_height_m + 1.0, back_floor + 2.8)
        return {"width": round(width, 2), "depth": round(depth, 2), "height": round(height, 2),
                "wall_z": -1.0, "back_floor_y": round(back_floor, 2)}

    def acoustic_environment(self) -> AcousticEnvironment:
        room = self.room
        w, d, h = room["width"], room["depth"] + 1.0, room["height"]
        return AcousticEnvironment(
            name=self.name, temperature_c=22.0, humidity_pct=55.0,
            volume_m3=w * d * h * 0.8,                 # lantai berundak mengurangi volume
            surface_m2=2.0 * (w * d + w * h + d * h),
            mean_absorption=self.SPEC.mean_absorption,
            source_spl_db=82.0,
            reference_distance_m=d * 2.0 / 3.0,        # titik kalibrasi bioskop: 2/3 kedalaman ruang
            directivity_q=12.0,
            comfort_spl_db=(78.0, 88.0),
            reference_listening_spl_db=86.0,
            wet_scale=0.28,
        )

    def speaker_sources(self) -> list[SpeakerSource]:
        surface = self._screen.surface
        y, third = surface.center.y, surface.width / 3.0
        return [
            SpeakerSource("Speaker Tengah (di balik layar)", Vec3(0.0, y, -0.3)),
            SpeakerSource("Speaker Kiri", Vec3(-third, y, -0.3), level_offset_db=-3.0),
            SpeakerSource("Speaker Kanan", Vec3(third, y, -0.3), level_offset_db=-3.0),
        ]

    def scoring_profile(self) -> ScoringProfile:
        spec = self.SPEC
        return ScoringProfile(
            kind="cinema", weights=CINEMA_WEIGHTS, ideal_h_fov_deg=spec.ideal_h_fov_deg,
            fov_sigma_low=spec.fov_sigma[0], fov_sigma_high=spec.fov_sigma[1],
            standard_label=spec.standard_label, comfort_spl_db=(78.0, 88.0),
        )

    def reference_photos(self, seat: SeatNode | None = None) -> list[dict]:
        return [photo_entry(path, caption) for path, caption in self.PHOTOS]

    def media(self) -> dict:
        return {
            "video": asset_url("videos/trailer_cinema.mp4"),
            "video_label": "Trailer film",
            "poster": asset_url("images/poster_avengers_endgame.jpg"),
        }

    @cached_property
    def _layout(self) -> dict:
        spec = self.SPEC
        return {
            **self.summary(),
            "studio_type": spec.studio_type,
            "display_name": self.display_name,
            "price": self.price,
            "room": self.room,
            "spec": {
                "rows": spec.rows, "seats_per_row": spec.seats_per_row,
                "seat_pitch": spec.seat_pitch_m, "row_depth": spec.row_depth_m,
                "row_rise": spec.row_rise_m, "first_row_distance": spec.first_row_distance_m,
                "standard_label": spec.standard_label, "ideal_h_fov_deg": spec.ideal_h_fov_deg,
            },
            "screen": self._screen.surface.to_dict(),
            "targets": [t.to_dict() for t in self.targets()],
            "rows": [{"letter": row[0].row_letter, "index": row[0].row_index,
                      "y": round(row[0].position.y, 3), "z": round(row[0].position.z, 3)}
                     for row in self._grid],
            "columns": [round(x, 3) for x in self._columns],
            "seats": [seat.layout_dict() for row in self._grid for seat in row],
            "seat_type": self.seat_class.seat_type,
            "seat_height": self.seat_class.seat_height_m,
            "theme": self.interior_theme(),
            "furniture": self.furniture(),
            "features": self.special_features(),
            "occluders": [],
            "speakers": [s.to_dict() for s in self.speaker_sources()],
            "media": self.media(),
            "reference_photos": self.reference_photos(),
        }

    def layout(self) -> dict:
        return self._layout

    def layout_for_film(self, film_id: str | None = None, price_override: int | None = None) -> dict:
        base = self.layout()
        status_map = self._film_status_map(film_id)
        if status_map is None and (price_override is None or price_override == base.get("price")):
            return base
        copy = dict(base)
        if price_override is not None:
            copy["price"] = price_override
        if status_map is not None:
            copy["seats"] = [
                {**s, "status": status_map.get(s["id"], SeatStatus(s["status"])).value}
                for s in base["seats"]
            ]
        return copy


# =========================================================================== #
# Empat studio konkret
# =========================================================================== #
class RegularStudio(CinemaStudio):
    display_name = "Regular 2D"
    tagline_text = "13 baris × 18 kursi, layar lebar 14 × 6 m (2.39:1)"
    SPEC = StudioSpec(
        studio_type="regular", rows=13, seats_per_row=18, seat_pitch_m=0.56,
        row_depth_m=1.10, row_rise_m=0.35, first_row_distance_m=6.0,
        screen_width_m=14.0, screen_height_m=6.0, screen_bottom_m=1.5,
        aisle_after=(4, 14), aisle_width_m=1.0, price_key="regular",
        ideal_h_fov_deg=45.0, fov_sigma=(12.0, 18.0), standard_label="THX ≥ 36° (ideal ±45°)",
    )
    PHOTOS = (
        ("images/xxi_regular_studio.jpg", "Studio Regular XXI — deret kursi merah berundak"),
        ("images/xxi_regular_studio2.jpg", "Studio Regular XXI — pandangan ke layar"),
    )

    def interior_theme(self) -> dict:
        return {"wall": "#3a0d12", "wall_accent": "#5a141b", "ceiling": "#0c0a0d", "carpet": "#231419",
                "seat": "#c0202a", "seat_dark": "#7d1118", "armrest": "#141416",
                "step_light": "#ffb347", "sconce": "#ff9d5c"}


class PremiereStudio(CinemaStudio):
    display_name = "The Premiere"
    tagline_text = "5 baris × 4 pasang recliner kulit, legroom 1.8 m"
    seat_class = ReclinerSeat
    SPEC = StudioSpec(
        studio_type="premiere", rows=5, seats_per_row=8, seat_pitch_m=0.92,
        row_depth_m=1.80, row_rise_m=0.45, first_row_distance_m=6.0,
        screen_width_m=10.0, screen_height_m=4.2, screen_bottom_m=1.5,
        aisle_after=(4,), aisle_width_m=1.3, price_key="premiere",
        ideal_h_fov_deg=45.0, fov_sigma=(12.0, 20.0), standard_label="THX ≥ 36° (ideal ±45°)",
        mean_absorption=0.65, sold_ratio=0.30,
    )
    TABLE_GAP_M: ClassVar[float] = 0.55
    CONSOLE_GAP_M: ClassVar[float] = 0.10
    PHOTOS = (
        ("images/xxi_the_premiere.jpg", "The Premiere — recliner kulit berpasangan"),
        ("images/xxi_the_premiere2.jpg", "The Premiere — pandangan ke layar"),
    )

    def gap_after(self, number: int) -> float:
        """Pasangan 1-2 | meja+lampu | 3-4 | lorong | 5-6 | meja+lampu | 7-8."""
        if number % 2 == 1:
            return self.CONSOLE_GAP_M
        return super().gap_after(number) or self.TABLE_GAP_M

    def _group_id(self, row_letter: str, number: int) -> str:
        return f"{row_letter}-P{(number + 1) // 2}"

    def furniture(self) -> list[dict]:
        tables = []
        for row in self._grid:
            for left_no in (2, 6):                       # meja di antara pasangan
                left, right = row[left_no - 1], row[left_no]
                tables.append({
                    "type": "side_table",
                    "x": round((left.position.x + right.position.x) / 2.0, 3),
                    "y": round(left.position.y, 3), "z": round(left.position.z, 3), "lamp": True,
                })
        return tables

    def interior_theme(self) -> dict:
        return {"wall": "#3b1d14", "wall_accent": "#6b3a22", "ceiling": "#0d0a09", "carpet": "#2a1a12",
                "seat": "#5e1f1c", "seat_dark": "#3a1210", "headrest": "#c8aa7a", "armrest": "#2a100e",
                "step_light": "#ffc46b", "sconce": "#ffb760", "table": "#20120c", "lamp": "#ffcf8a"}

    def special_features(self) -> dict:
        return {"recliner": {"recline_deg": ReclinerSeat.RECLINE_DEG, "footrest": True}}


class IMAXStudio(CinemaStudio):
    display_name = "IMAX Laser"
    tagline_text = "14 baris × 22 kursi di tribun curam, layar lengkung 22 × 12 m"
    SCREEN_RADIUS_M: ClassVar[float] = 30.0
    SPEC = StudioSpec(
        studio_type="imax", rows=14, seats_per_row=22, seat_pitch_m=0.56,
        row_depth_m=1.05, row_rise_m=0.55, first_row_distance_m=8.0,
        screen_width_m=22.0, screen_height_m=12.0, screen_bottom_m=0.6,
        aisle_after=(5, 17), aisle_width_m=1.0, price_key="imax",
        ideal_h_fov_deg=65.0, fov_sigma=(20.0, 24.0), standard_label="IMAX 60–70°",
    )
    PHOTOS = (
        ("images/xxi_imax_studio.jpg", "IMAX — layar raksasa dari lantai ke plafon"),
        ("images/xxi_imax_studio2.jpg", "IMAX — tribun curam dan plafon biru"),
        ("images/xxi_imax_studio3.jpg", "IMAX — pandangan dari baris belakang"),
    )

    def _create_screen(self) -> CinemaScreen:
        spec = self.SPEC
        return CurvedCinemaScreen(spec.screen_width_m, spec.screen_height_m,
                                  spec.screen_bottom_m, self.SCREEN_RADIUS_M)

    def interior_theme(self) -> dict:
        return {"wall": "#0b1022", "wall_accent": "#16224a", "ceiling": "#06070d", "carpet": "#2a1c14",
                "seat": "#c8202c", "seat_dark": "#84131b", "armrest": "#101014",
                "step_light": "#4d8dff", "sconce": "#3d7bff"}

    def special_features(self) -> dict:
        return {"curved_screen": {"radius_m": self.SCREEN_RADIUS_M}}


class FourDXStudio(CinemaStudio):
    display_name = "4DX Motion"
    tagline_text = "8 baris × 16 kursi gerak hidrolik dalam blok 4-kursi"
    seat_class = MotionSeat
    BLOCK_SIZE: ClassVar[int] = 4
    BLOCK_GAP_M: ClassVar[float] = 0.45
    SPEC = StudioSpec(
        studio_type="4dx", rows=8, seats_per_row=16, seat_pitch_m=0.62,
        row_depth_m=1.25, row_rise_m=0.42, first_row_distance_m=6.0,
        screen_width_m=13.0, screen_height_m=5.45, screen_bottom_m=1.5,
        aisle_after=(8,), aisle_width_m=1.1, price_key="4dx",
        ideal_h_fov_deg=48.0, fov_sigma=(12.0, 18.0), standard_label="THX ≥ 36° (ideal ±48°)",
        mean_absorption=0.55,
    )
    PHOTOS = (("images/xxi_4dx_seats.jpg", "4DX — blok kursi gerak 4-seat dengan footrest"),)

    def gap_after(self, number: int) -> float:
        if number % self.BLOCK_SIZE != 0:
            return 0.0
        return super().gap_after(number) or self.BLOCK_GAP_M

    def _group_id(self, row_letter: str, number: int) -> str:
        return f"{row_letter}-Q{(number - 1) // self.BLOCK_SIZE + 1}"

    def _after_build(self, grid: list[list[CinemaSeat]]) -> None:
        """Titik pivot gerak = pusat lantai tiap blok 4-kursi."""
        for row in grid:
            for start in range(0, len(row), self.BLOCK_SIZE):
                block = row[start:start + self.BLOCK_SIZE]
                center_x = sum(seat.position.x for seat in block) / len(block)
                pivot = Vec3(center_x, block[0].position.y, block[0].position.z)
                for seat in block:
                    seat.motion_pivot = pivot      # type: ignore[attr-defined]

    def interior_theme(self) -> dict:
        return {"wall": "#111116", "wall_accent": "#1d1d26", "ceiling": "#050507", "carpet": "#15151a",
                "seat": "#1c1c22", "seat_dark": "#0e0e12", "seat_piping": "#d0202a", "armrest": "#0b0b0e",
                "step_light": "#ff3b4a", "sconce": "#d0202a", "base": "#2a2a33"}

    def special_features(self) -> dict:
        pivots = {}
        for row in self._grid:
            for seat in row:
                pivots[seat.group_id] = seat.motion_pivot.to_list()   # type: ignore[attr-defined]
        return {"four_dx": {
            "effects": ["Gerak hidrolik", "Getaran", "Angin", "Kabut air", "Kilat"],
            "motion": MotionSeat.MOTION,
            "wind_speed_ms": 6.0,
            "block_pivots": pivots,
        }}
