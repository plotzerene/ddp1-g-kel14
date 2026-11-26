"""
concert_gbk.py — Stadion Utama GBK untuk Coldplay "Music of the Spheres" Jakarta.

Tata letak mengikuti peta kategori resmi (`gbk_coldplay_seating_map.jpg`) dan foto
panggung (`gbk_coldplay_stage_full.jpg`):

* Mangkuk oval dua tingkat (tribun bawah & atas), panggung utama di ujung Utara.
* Panggung: LED tengah setengah-lingkaran (Ø 20 m) yang menjorok ke belakang, diapit
  dua LED bundar (Ø 16 m) yang diserongkan 15° ke arah penonton, runway 40 m ke
  B-Stage bundar (Ø 10 m), dan C-Stage kecil di barat-daya lapangan.
* Kategori: Ultimate Experience, CAT 1–8, Festival & My Universe (berdiri).

Sistem koordinat tribun memakai (bearing, depth):
    bearing = sudut kompas dari Utara searah jarum jam (0° = belakang panggung)
    depth   = jarak horizontal dari bibir lapangan ke arah luar (m)
    x = (rx + depth)·sin(bearing),   z = −(rz + depth)·cos(bearing)
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import cached_property, lru_cache
from typing import ClassVar, Sequence

from ....assets_sync import asset_url, photo_entry
from ....shared_state import TICKET_PRICES
from ..engine.acoustics import AcousticEnvironment, SpeakerSource
from ..engine.geometry_3d import AABB, UP, Vec3
from ..engine.obstruction import (
    ObstructionModel, Posture, SeatedRowObstruction, StandingCrowdObstruction,
)
from ..engine.sightline_ai import ScoringProfile
from .base_venue import (
    FrontNeighbor, Occluder, ScreenSurface, SeatNode, SeatNotFoundError, SurfaceShape,
    TargetStage, Venue, VenueKind,
)

CONCERT_WEIGHTS = {"visibility": 0.24, "proximity": 0.24, "obstruction": 0.16,
                   "off_axis": 0.12, "neck": 0.10, "acoustic": 0.14}
SEAT_ID_PATTERN = re.compile(r"^(?P<block>[a-z0-9_]+):(?:spot(?P<spot>\d+)|R(?P<row>\d+):S(?P<seat>\d+))$")


# --------------------------------------------------------------------------- #
# Geometri mangkuk stadion
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class TierSpec:
    name: str
    label: str
    depth_start: float
    depth_end: float
    base_y: float
    rake: float                      # kenaikan (m) per meter kedalaman

    def height_at(self, depth: float) -> float:
        return self.base_y + (depth - self.depth_start) * self.rake


@dataclass(frozen=True)
class BowlProfile:
    """Mangkuk oval SUGBK: elips dalam 110 × 165 m, dua tingkat tribun, atap cincin.

    Elips dalam = bentang lantai dasar (rumput + lintasan lari atletik): sumbu panjang 165 m (z),
    sumbu pendek 110 m (x). Tepi tribun bawah mundur di belakang lintasan, bukan menempel ke lapangan.
    """

    rx_inner: float = 55.0
    rz_inner: float = 82.5
    row_depth: float = 0.80
    seat_pitch: float = 0.50
    tiers: tuple[TierSpec, ...] = (
        TierSpec("lower", "Tribun Bawah", 0.0, 22.0, 2.8, 0.42),
        TierSpec("upper", "Tribun Atas", 26.0, 48.0, 13.6, 0.62),
    )
    closed_start: float = 318.0      # tribun di belakang panggung ditutup
    closed_end: float = 402.0        # = 42° setelah melewati Utara
    roof_depth: tuple[float, float] = (5.0, 54.0)
    roof_y: tuple[float, float] = (35.0, 39.0)

    def point(self, bearing_deg: float, depth: float, y: float = 0.0) -> Vec3:
        b = math.radians(bearing_deg)
        return Vec3((self.rx_inner + depth) * math.sin(b), y, -(self.rz_inner + depth) * math.cos(b))

    def inward(self, bearing_deg: float) -> Vec3:
        """Arah hadap kursi: normal elips ke arah lapangan (tegak lurus deretan kursi)."""
        b = math.radians(bearing_deg)
        return Vec3(-math.sin(b) / self.rx_inner, 0.0, math.cos(b) / self.rz_inner).normalized()

    def tier(self, name: str) -> TierSpec:
        return next(t for t in self.tiers if t.name == name)

    def arc_length(self, bearing_start: float, bearing_end: float, depth: float, steps: int = 24) -> float:
        """Panjang busur elips secara numerik (jumlah tali busur)."""
        points = [self.point(bearing_start + (bearing_end - bearing_start) * i / steps, depth)
                  for i in range(steps + 1)]
        return sum(points[i].distance_to(points[i + 1]) for i in range(steps))


@dataclass(frozen=True)
class RowSpec:
    number: int                      # 1 = baris terdepan blok
    tier: TierSpec
    depth: float
    y: float
    has_front: bool
    seat_count: int


# --------------------------------------------------------------------------- #
# Blok kategori tiket
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CategoryBlock:
    """Satu blok kategori pada peta: irisan cincin tribun atau area lapangan."""

    block_id: str
    label: str
    category: str
    color: str
    price_key: str
    tiers: tuple[str, ...] = ()
    bearing_start: float = 0.0
    bearing_end: float = 0.0
    depth_min: float | None = None
    depth_max: float | None = None
    standing: bool = False
    restricted: bool = False
    text_color: str = "#0F172A"
    description: str = ""
    perks: tuple[str, ...] = ()

    @property
    def price(self) -> int:
        return TICKET_PRICES[self.price_key]

    def depth_ranges(self, bowl: BowlProfile) -> list[tuple[TierSpec, float, float]]:
        ranges = []
        for name in self.tiers:
            tier = bowl.tier(name)
            start = tier.depth_start if self.depth_min is None else max(tier.depth_start, self.depth_min)
            end = tier.depth_end if self.depth_max is None else min(tier.depth_end, self.depth_max)
            if end - start >= bowl.row_depth:
                ranges.append((tier, start, end))
        return ranges

    def rows(self, bowl: BowlProfile) -> tuple[RowSpec, ...]:
        return _rows_of(self, bowl)

    def bearing_of(self, row: RowSpec, seat_index: int) -> float:
        """Kursi 1 berada di sisi KIRI penonton (bearing terbesar), nomor naik ke kanan."""
        fraction = (seat_index + 0.5) / row.seat_count
        return self.bearing_end - fraction * (self.bearing_end - self.bearing_start)

    def outline(self, bowl: BowlProfile, step_deg: float = 3.0) -> list[list[float]]:
        """Poligon [x, z] blok untuk peta 2D."""
        ranges = self.depth_ranges(bowl)
        inner, outer = ranges[0][1], ranges[-1][2]
        steps = max(2, int(math.ceil((self.bearing_end - self.bearing_start) / step_deg)))
        bearings = [self.bearing_start + (self.bearing_end - self.bearing_start) * i / steps
                    for i in range(steps + 1)]
        ring = [bowl.point(b, outer) for b in bearings] + [bowl.point(b, inner) for b in reversed(bearings)]
        return [[round(p.x, 2), round(p.z, 2)] for p in ring]

    def label_point(self, bowl: BowlProfile) -> list[float]:
        ranges = self.depth_ranges(bowl)
        mid = bowl.point((self.bearing_start + self.bearing_end) / 2.0, (ranges[0][1] + ranges[-1][2]) / 2.0)
        return [round(mid.x, 2), round(mid.z, 2)]


@lru_cache(maxsize=None)
def _rows_of(block: CategoryBlock, bowl: BowlProfile) -> tuple[RowSpec, ...]:
    """Tabel baris sebuah blok (di-cache; dataclass frozen bisa di-hash)."""
    rows: list[RowSpec] = []
    for tier, start, end in block.depth_ranges(bowl):
        count = int((end - start) / bowl.row_depth + 1e-6)
        for k in range(count):
            depth = start + (k + 0.5) * bowl.row_depth
            arc = bowl.arc_length(block.bearing_start, block.bearing_end, depth)
            rows.append(RowSpec(
                number=len(rows) + 1, tier=tier, depth=depth, y=tier.height_at(depth),
                has_front=k > 0 or start > tier.depth_start + 1e-6,
                seat_count=max(1, int(arc / bowl.seat_pitch)),
            ))
    return tuple(rows)


@dataclass(frozen=True)
class SpotSpec:
    number: int
    key: str
    label: str
    description: str
    x: float
    z: float
    density: float                   # orang per m²


# --------------------------------------------------------------------------- #
# Posisi penonton di stadion
# --------------------------------------------------------------------------- #
class StadiumPosition(SeatNode):
    """Basis semua posisi di stadion: selalu tahu blok kategorinya."""

    def __init__(self, seat_id: str, label: str, block: CategoryBlock) -> None:
        super().__init__(seat_id, label, block.label, block.price)
        self.block = block

    @property
    def group_key(self) -> str:
        return self.block.block_id


class SubRowPosition(StadiumPosition):
    """Kursi bernomor di tribun: blok → baris → nomor kursi."""

    seat_type = "tribune"
    seat_height_m = 0.45       # mata = lantai undakan + 0.45 m (kursi) + 0.456·tinggi badan (±0.75 m)

    def __init__(self, block: CategoryBlock, bowl: BowlProfile, row: RowSpec, seat_index: int) -> None:
        number = seat_index + 1
        super().__init__(f"{block.block_id}:R{row.number}:S{number}",
                         f"{block.label} · Baris {row.number} · Kursi {number}", block)
        self.bowl = bowl
        self.row = row
        self.seat_number = number
        self.bearing = block.bearing_of(row, seat_index)
        self._floor = bowl.point(self.bearing, row.depth, row.y)
        self._facing = bowl.inward(self.bearing)

    @property
    def floor_position(self) -> Vec3:
        return self._floor

    @property
    def facing(self) -> Vec3:
        return self._facing

    @property
    def posture(self) -> Posture:
        return Posture.SEATED

    @property
    def clear_front(self) -> bool:
        """Baris 1 tiap blok (dan baris pertama tiap tingkat) berpandangan bebas: tanpa penonton di depan."""
        return self.row.number == 1 or not self.row.has_front

    def front_neighbor(self) -> FrontNeighbor | None:
        if self.clear_front:
            return None
        step = self.bowl.row_depth
        floor = self._floor + self._facing * step - UP * (self.row.tier.rake * step)
        return FrontNeighbor(floor, Posture.SEATED, self.seat_height_m)

    def frame_dict(self) -> dict:
        tier, step = self.row.tier, self.bowl.row_depth
        return {
            "seat_type": self.seat_type,
            "row_depth": step,
            "row_rise": round(tier.rake * step, 3),
            "seat_pitch": self.bowl.seat_pitch,
            "is_front_row": self.clear_front,
            # Jumlah baris yang digambar di depan/belakang pada tingkat tribun yang sama (untuk detail 3D).
            "rows_ahead": 0 if self.clear_front else int((self.row.depth - tier.depth_start) / step),
            "rows_behind": int((tier.depth_end - self.row.depth) / step),
            "tier": self.row.tier.name,
            "tier_label": self.row.tier.label,
            "row": self.row.number,
            "seat": self.seat_number,
            "block_id": self.block.block_id,
            "restricted": self.block.restricted,
            "color": self.block.color,
        }


class StandingSpot(StadiumPosition):
    """Spot berdiri di lapangan (Festival / My Universe)."""

    seat_type = "festival"

    def __init__(self, block: CategoryBlock, spot: SpotSpec, look_target: Vec3) -> None:
        super().__init__(f"{block.block_id}:spot{spot.number}", f"{block.label} · {spot.label}", block)
        self.spot = spot
        self._floor = Vec3(spot.x, 0.0, spot.z)
        self._facing = (look_target - self._floor).horizontal().normalized()

    @property
    def floor_position(self) -> Vec3:
        return self._floor

    @property
    def facing(self) -> Vec3:
        return self._facing

    @property
    def posture(self) -> Posture:
        return Posture.STANDING

    @property
    def free_orientation(self) -> bool:
        return True

    def front_neighbor(self) -> FrontNeighbor | None:
        return None        # kerumunan ditangani StandingCrowdObstruction

    def frame_dict(self) -> dict:
        return {
            "seat_type": self.seat_type,
            "is_front_row": False,
            "crowd_density": self.spot.density,
            "crowd_spacing": round(1.0 / math.sqrt(self.spot.density), 3),
            "spot": self.spot.number,
            "block_id": self.block.block_id,
            "restricted": False,
            "color": self.block.color,
        }


# --------------------------------------------------------------------------- #
# Target: panggung utama & panggung satelit
# --------------------------------------------------------------------------- #
class MainStage(TargetStage):
    """Panggung utama di Utara dengan tiga permukaan LED."""

    DECK_Y: ClassVar[float] = 2.8
    FRONT_Z: ClassVar[float] = -55.0
    BACK_Z: ClassVar[float] = -80.0
    HALF_WIDTH: ClassVar[float] = 30.0
    PERFORMER_Z: ClassVar[float] = -60.0
    WING_YAW_DEG: ClassVar[float] = 15.0

    def __init__(self) -> None:
        super().__init__("main_stage", "Main Stage", "Fokus Main Stage", "panggung utama")
        yaw = math.radians(self.WING_YAW_DEG)
        self.center_led = ScreenSurface(
            "led_center", "LED Tengah (setengah lingkaran)", SurfaceShape.SEMICIRCLE,
            Vec3(0.0, self.DECK_Y + 5.0, -74.0), 20.0, 10.0)
        self.left_led = ScreenSurface(
            "led_left", "LED Bundar Kiri", SurfaceShape.CIRCLE, Vec3(-29.0, 13.5, -60.0), 16.0, 16.0,
            normal=Vec3(math.sin(yaw), 0.0, math.cos(yaw)))
        self.right_led = ScreenSurface(
            "led_right", "LED Bundar Kanan", SurfaceShape.CIRCLE, Vec3(29.0, 13.5, -60.0), 16.0, 16.0,
            normal=Vec3(-math.sin(yaw), 0.0, math.cos(yaw)))

    @property
    def focus_point(self) -> Vec3:
        return Vec3(0.0, 7.5, -64.0)

    def surfaces(self) -> list[ScreenSurface]:
        return [self.center_led, self.left_led, self.right_led]

    def sightline_span(self) -> tuple[Vec3, Vec3]:
        return (Vec3(0.0, self.DECK_Y, self.PERFORMER_Z), Vec3(0.0, self.DECK_Y + 10.0, self.PERFORMER_Z))

    def performance_points(self) -> list[Vec3]:
        return [Vec3(x, self.DECK_Y + 1.3, self.PERFORMER_Z) for x in (-18.0, -12.0, -6.0, 0.0, 6.0, 12.0, 18.0)]

    @property
    def extent_width(self) -> float:
        return 2.0 * self.HALF_WIDTH

    @property
    def crowd_clear_zone_m(self) -> float:
        return (self.FRONT_Z - self.PERFORMER_Z) + 2.0      # tepi panggung + pit barikade

    @property
    def facing_normal(self) -> Vec3:
        return Vec3(0.0, 0.0, 1.0)


class SatelliteStage(TargetStage):
    """Panggung bundar kecil (B-Stage / C-Stage) yang bisa ditonton dari segala arah."""

    def __init__(self, target_id: str, label: str, center: Vec3, radius: float) -> None:
        super().__init__(target_id, label, f"Fokus {label}", label)
        self.center = center            # titik tengah permukaan dek
        self.radius = radius

    @property
    def focus_point(self) -> Vec3:
        return self.center + UP * 1.4

    def surfaces(self) -> list[ScreenSurface]:
        return []

    def sightline_span(self) -> tuple[Vec3, Vec3]:
        return self.center, self.center + UP * 1.9

    def performance_points(self) -> list[Vec3]:
        r = self.radius * 0.6
        base = self.center + UP * 1.3
        return [base, base + Vec3(r, 0, 0), base + Vec3(-r, 0, 0), base + Vec3(0, 0, r), base + Vec3(0, 0, -r)]

    @property
    def extent_width(self) -> float:
        return 2.0 * self.radius

    @property
    def crowd_clear_zone_m(self) -> float:
        return self.radius + 1.5

    def to_dict(self) -> dict:
        return {**super().to_dict(), "center": self.center.to_list(), "radius": self.radius}


# --------------------------------------------------------------------------- #
# Stadion
# --------------------------------------------------------------------------- #
class ColdplayGBKStadium(Venue):
    """Coldplay Music of the Spheres — Stadion Utama Gelora Bung Karno."""

    BOWL: ClassVar[BowlProfile] = BowlProfile()
    #: 178 cm → tinggi mata berdiri 0,936 × 1,78 = 1,666 m (rentang 1,65–1,75 m untuk penonton dewasa).
    DEFAULT_VIEWER_CM: ClassVar[float | None] = 178.0
    RUNWAY: ClassVar[dict] = {"x0": -1.5, "x1": 1.5, "z0": -55.0, "z1": -15.0, "y": 1.8}
    BANDS: ClassVar[dict[str, str]] = {
        "depan": "Baris Depan", "tengah": "Baris Tengah", "belakang": "Baris Belakang"}
    SIDES: ClassVar[dict[str, tuple[str, float]]] = {
        "kiri": ("Sisi Kiri", 0.15), "tengah": ("Tengah Blok", 0.50), "kanan": ("Sisi Kanan", 0.85)}
    SPOTS: ClassVar[tuple[SpotSpec, ...]] = (
        SpotSpec(1, "front_pit", "Spot 1: Bibir Panggung",
                 "Tepat di belakang barikade panggung utama. Paling dekat, paling padat.", -6.0, -50.5, 4.0),
        SpotSpec(2, "bstage_pit", "Spot 2: Samping Runway",
                 "Menempel barikade B-Stage di ujung runway.", 8.5, -10.0, 3.5),
        SpotSpec(3, "mid", "Spot 3: Tengah Lapangan",
                 "Di belakang menara suara, sejajar meja FOH. Lebih lega.", 0.0, 24.0, 2.5),
        SpotSpec(4, "back", "Spot 4: Belakang Lapangan",
                 "Paling lega, dekat tribun selatan.", 0.0, 60.0, 1.5),
        SpotSpec(5, "fan_zone", "Spot 5: Zona Festival (28 m)",
                 "Di sisi runway, 28 m dari bibir panggung utama — pandangan penuh ke videotron.",
                 -5.0, -27.0, 3.0),
    )
    PHOTOS_FESTIVAL: ClassVar = (
        ("images/gbk_coldplay_festival_pov.jpg", "POV Festival — lautan kepala dan dua LED bundar"),
        ("images/gbk_coldplay_stage_full2.jpg", "POV Festival dari tengah lapangan"),
        ("images/gbk_coldplay_stage_full3.jpg", "Panggung saat konser berlangsung"),
    )
    PHOTOS_RESTRICTED: ClassVar = (
        ("images/gbk_coldplay_cat8_side_pov.jpg", "POV CAT 8 — restricted view dari samping panggung"),
        ("images/gbk_coldplay_cat8_side_pov2.jpg", "POV CAT 8A — lautan Xyloband dari tribun samping"),
    )
    PHOTOS_TRIBUNE: ClassVar = (
        ("images/gbk_coldplay_stage_full.jpg", "Panggung, runway, dan B-Stage dilihat dari tribun selatan"),
        ("images/gbk_coldplay_stage_full3.jpg", "Panggung saat konser berlangsung"),
    )
    PHOTO_MAP: ClassVar = (("images/gbk_coldplay_seating_map.jpg", "Peta kategori resmi Coldplay Jakarta"),)

    def __init__(self) -> None:
        super().__init__("gbk-coldplay", "Coldplay · Music of the Spheres — GBK Jakarta",
                         VenueKind.CONCERT, "Stadion Utama Gelora Bung Karno, panggung di sisi Utara")
        self.main_stage = MainStage()
        self.b_stage = SatelliteStage("b_stage", "B-Stage", Vec3(0.0, 1.8, -10.0), 5.0)
        self.c_stage = SatelliteStage("c_stage", "C-Stage", Vec3(-20.0, 1.5, 52.0), 3.5)
        self.blocks: dict[str, CategoryBlock] = {b.block_id: b for b in self._define_blocks()}
        self._seated_model = SeatedRowObstruction()
        self._crowd_models = {s.number: StandingCrowdObstruction(s.density) for s in self.SPOTS}
        self._positions: dict[str, StadiumPosition] = {}

    # --- definisi kategori (mengikuti peta resmi) -----------------------------
    @staticmethod
    def _define_blocks() -> list[CategoryBlock]:
        white = "#FFFFFF"
        return [
            CategoryBlock("ultimate", "ULTIMATE EXPERIENCE", "Ultimate Experience", "#F9C4EC", "gbk:ultimate",
                          ("lower",), 84, 97, depth_max=5.6,
                          description="Kursi CAT 1 baris terdepan + paket VIP.",
                          perks=("Backstage tour", "Foto di atas panggung", "Pintu masuk khusus",
                                 "Merchandise eksklusif")),
            CategoryBlock("cat1", "CAT 1", "CAT 1", "#1F45FF", "gbk:cat1", ("lower",), 84, 97, depth_min=5.6,
                          text_color=white, description="Tribun bawah timur, sejajar B-Stage."),
            CategoryBlock("my_universe", "MY UNIVERSE", "My Universe", "#E0559F", "gbk:my_universe",
                          standing=True, text_color=white,
                          description="Tiket Festival + early entry & pintu masuk khusus.",
                          perks=("Early entry", "Pintu masuk khusus", "Gift item", "Konter merchandise khusus")),
            CategoryBlock("festival", "FESTIVAL", "Festival", "#D94A93", "gbk:festival", standing=True,
                          text_color=white, description="Berdiri bebas di lapangan."),
            CategoryBlock("cat2a", "CAT 2A", "CAT 2", "#F58220", "gbk:cat2", ("lower",), 242, 294,
                          description="Tribun bawah barat."),
            CategoryBlock("cat2b_n", "CAT 2B (Utara)", "CAT 2", "#F58220", "gbk:cat2", ("lower",), 66, 84,
                          description="Tribun bawah timur, sisi dekat panggung."),
            CategoryBlock("cat2b_s", "CAT 2B (Selatan)", "CAT 2", "#F58220", "gbk:cat2", ("lower",), 97, 118,
                          description="Tribun bawah timur, sisi selatan."),
            CategoryBlock("cat3", "CAT 3", "CAT 3", "#007A87", "gbk:cat3", ("lower",), 118, 242,
                          text_color=white, description="Tribun bawah lengkung selatan, menghadap panggung."),
            CategoryBlock("cat4a", "CAT 4A", "CAT 4", "#2EB100", "gbk:cat4", ("upper",), 228, 294,
                          description="Tribun atas barat."),
            CategoryBlock("cat4b", "CAT 4B", "CAT 4", "#2EB100", "gbk:cat4", ("upper",), 66, 132,
                          description="Tribun atas timur."),
            CategoryBlock("cat5a", "CAT 5A", "CAT 5", "#EE1C2E", "gbk:cat5", ("upper",), 198, 228,
                          text_color=white, description="Tribun atas barat-daya."),
            CategoryBlock("cat5b", "CAT 5B", "CAT 5", "#EE1C2E", "gbk:cat5", ("upper",), 132, 162,
                          text_color=white, description="Tribun atas tenggara."),
            CategoryBlock("cat6", "CAT 6", "CAT 6", "#00B5E2", "gbk:cat6", ("upper",), 162, 198,
                          description="Tribun atas selatan — paling jauh, lurus ke panggung."),
            CategoryBlock("cat7a", "CAT 7A", "CAT 7", "#8EE000", "gbk:cat7", ("lower", "upper"), 294, 306,
                          restricted=True, description="Restricted view — samping panggung sisi barat."),
            CategoryBlock("cat7b", "CAT 7B", "CAT 7", "#8EE000", "gbk:cat7", ("lower", "upper"), 54, 66,
                          restricted=True, description="Restricted view — samping panggung sisi timur."),
            CategoryBlock("cat8a", "CAT 8A", "CAT 8", "#9A9AAE", "gbk:cat8", ("lower", "upper"), 306, 318,
                          restricted=True, description="Restricted view — serong belakang panggung barat."),
            CategoryBlock("cat8b", "CAT 8B", "CAT 8", "#9A9AAE", "gbk:cat8", ("lower", "upper"), 42, 54,
                          restricted=True, description="Restricted view — serong belakang panggung timur."),
        ]

    # --- resolusi posisi -----------------------------------------------------
    def _block(self, block_id: object) -> CategoryBlock:
        try:
            return self.blocks[str(block_id)]
        except KeyError as exc:
            raise SeatNotFoundError(f"Kategori '{block_id}' tidak ada di peta GBK.") from exc

    def _remember(self, position: StadiumPosition) -> StadiumPosition:
        return self._positions.setdefault(position.seat_id, position)

    def spot_position(self, block: CategoryBlock, spot_number: int) -> StandingSpot:
        spot = next((s for s in self.SPOTS if s.number == spot_number), None)
        if spot is None or not block.standing:
            raise SeatNotFoundError(f"Spot {spot_number} tidak tersedia untuk {block.label}.")
        cached = self._positions.get(f"{block.block_id}:spot{spot.number}")
        if cached is not None:
            return cached                                   # type: ignore[return-value]
        return self._remember(StandingSpot(block, spot, self.main_stage.focus_point))  # type: ignore[return-value]

    def seat_position(self, block: CategoryBlock, row_number: int, seat_number: int) -> SubRowPosition:
        rows = block.rows(self.BOWL)
        if block.standing or not 1 <= row_number <= len(rows):
            raise SeatNotFoundError(f"Baris {row_number} tidak ada di {block.label}.")
        row = rows[row_number - 1]
        if not 1 <= seat_number <= row.seat_count:
            raise SeatNotFoundError(f"Kursi {seat_number} tidak ada di baris {row_number} {block.label}.")
        cached = self._positions.get(f"{block.block_id}:R{row_number}:S{seat_number}")
        if cached is not None:
            return cached                                   # type: ignore[return-value]
        return self._remember(SubRowPosition(block, self.BOWL, row, seat_number - 1))  # type: ignore[return-value]

    def band_rows(self, block: CategoryBlock) -> dict[str, int]:
        """Nomor baris yang mewakili Depan / Tengah / Belakang."""
        count = len(block.rows(self.BOWL))
        return {"depan": 1, "tengah": max(1, (count + 1) // 2), "belakang": count}

    def band_position(self, block: CategoryBlock, band: str, side: str) -> SubRowPosition:
        if band not in self.BANDS or side not in self.SIDES:
            raise SeatNotFoundError(f"Sub-posisi '{band}/{side}' tidak dikenal.")
        row_number = self.band_rows(block)[band]
        row = block.rows(self.BOWL)[row_number - 1]
        seat_number = min(row.seat_count, int(self.SIDES[side][1] * row.seat_count) + 1)
        return self.seat_position(block, row_number, seat_number)

    def resolve_seat(self, selector: dict) -> SeatNode:
        try:
            seat_id = selector.get("seat_id")
            if seat_id:
                match = SEAT_ID_PATTERN.match(str(seat_id))
                if match is None:
                    raise SeatNotFoundError(f"Format posisi '{seat_id}' tidak valid.")
                block = self._block(match["block"])
                if match["spot"]:
                    return self.spot_position(block, int(match["spot"]))
                return self.seat_position(block, int(match["row"]), int(match["seat"]))
            block = self._block(selector.get("block_id"))
            if block.standing:
                return self.spot_position(block, int(selector.get("spot", 1)))
            if selector.get("row") and selector.get("seat"):
                return self.seat_position(block, int(selector["row"]), int(selector["seat"]))
            return self.band_position(block, str(selector.get("band", "tengah")),
                                      str(selector.get("side", "tengah")))
        except (TypeError, ValueError) as exc:
            raise SeatNotFoundError("Pilihan posisi tidak valid.") from exc

    @cached_property
    def _candidates(self) -> list[StadiumPosition]:
        """9 sub-posisi (3 baris × 3 sisi) tiap blok duduk + 4 spot tiap kategori berdiri."""
        seats: list[StadiumPosition] = []
        for block in self.blocks.values():
            if block.standing:
                seats += [self.spot_position(block, spot.number) for spot in self.SPOTS]
            else:
                seats += [self.band_position(block, band, side) for band in self.BANDS for side in self.SIDES]
        return seats

    def candidate_seats(self) -> Sequence[SeatNode]:
        return self._candidates

    @property
    def short_label(self) -> str:
        return "Coldplay GBK"

    def default_selector(self) -> dict:
        return {"block_id": "cat3", "band": "tengah", "side": "tengah"}

    # --- kontrak Venue -------------------------------------------------------
    def targets(self) -> list[TargetStage]:
        return [self.main_stage, self.b_stage, self.c_stage]

    def obstruction_model(self, seat: SeatNode) -> ObstructionModel:
        if isinstance(seat, StandingSpot):
            return self._crowd_models[seat.spot.number]
        return self._seated_model

    def occluders(self) -> list[Occluder]:
        return self._occluders

    @cached_property
    def _occluders(self) -> list[Occluder]:
        def box(oid: str, label: str, kind: str, xs: tuple[float, float], ys: tuple[float, float],
                zs: tuple[float, float]) -> Occluder:
            return Occluder(oid, label, kind, AABB(Vec3(min(xs), ys[0], zs[0]), Vec3(max(xs), ys[1], zs[1])))

        items: list[Occluder] = []
        for sign, side in ((-1.0, "barat"), (1.0, "timur")):
            items += [
                # Dua pilar per sisi: dari CAT 8 sebagian sinar ke LED tengah lolos di sela-selanya.
                box(f"scaffold_in_{side}", f"Pilar scaffolding LED {side} (dalam)", "pillar",
                    (sign * 21.0, sign * 24.0), (0.0, 23.0), (-69.0, -65.5)),
                box(f"scaffold_out_{side}", f"Pilar scaffolding LED {side} (luar)", "pillar",
                    (sign * 36.5, sign * 40.0), (0.0, 23.0), (-69.0, -65.5)),
                box(f"pa_{side}", f"Line array PA {side}", "speaker",
                    (sign * 18.8, sign * 20.2), (9.0, 20.0), (-58.4, -57.0)),
                box(f"delay_{side}", f"Menara delay {side}", "tower",
                    (sign * 19.25, sign * 21.75), (0.0, 16.0), (11.75, 14.25)),
                box(f"foh_{side}", f"Platform FOH {side}", "platform",
                    (sign * 9.5, sign * 14.5), (0.0, 3.5), (35.5, 38.5)),
            ]
        items.append(box("backwall", "Dinding belakang panggung", "wall",
                         (-32.0, 32.0), (0.0, 14.0), (-80.6, -79.8)))
        return items

    @staticmethod
    def _occluder_dict(occluder: Occluder) -> dict:
        data = occluder.to_dict()
        if occluder.kind == "tower":
            data["role"] = "Menara truss & speaker tunda agar suara dan lampu sinkron hingga tribun belakang."
            data["short"] = "DLY"
        elif occluder.kind == "platform":
            data["role"] = "Meja kontrol tata suara (audio), lampu, & efek visual konser di tengah lapangan."
            data["short"] = "FOH"
        return data

    def acoustic_environment(self) -> AcousticEnvironment:
        return AcousticEnvironment(
            name="Stadion GBK (semi terbuka)", temperature_c=28.0, humidity_pct=80.0,
            volume_m3=1_500_000.0, surface_m2=150_000.0, mean_absorption=0.55,
            source_spl_db=100.0, reference_distance_m=50.0, directivity_q=10.0,
            comfort_spl_db=(92.0, 102.0), reference_listening_spl_db=100.0, wet_scale=0.60,
            echo_plane_z=self.BOWL.rz_inner + 30.0,
        )

    def speaker_sources(self) -> list[SpeakerSource]:
        south = Vec3(0.0, 0.0, 1.0)     # semua speaker memancar ke arah penonton (selatan)
        return [
            SpeakerSource("Line array utama kiri", Vec3(-19.5, 15.0, -57.7), line_length_m=9.0, aim=south),
            SpeakerSource("Line array utama kanan", Vec3(19.5, 15.0, -57.7), line_length_m=9.0, aim=south),
            SpeakerSource("Menara delay kiri", Vec3(-20.5, 14.0, 13.0), line_length_m=4.0,
                          level_offset_db=-10.0, is_main=False, aim=south),
            SpeakerSource("Menara delay kanan", Vec3(20.5, 14.0, 13.0), line_length_m=4.0,
                          level_offset_db=-10.0, is_main=False, aim=south),
        ]

    def scoring_profile(self) -> ScoringProfile:
        return ScoringProfile(kind="concert", weights=CONCERT_WEIGHTS, standard_label="Sightline konser",
                              comfort_spl_db=(92.0, 102.0), proximity_near_m=8.0, proximity_far_m=220.0)

    def reference_photos(self, seat: SeatNode | None = None) -> list[dict]:
        block = getattr(seat, "block", None)
        if block is not None and block.standing:
            photos = self.PHOTOS_FESTIVAL
        elif block is not None and block.restricted:
            photos = self.PHOTOS_RESTRICTED
        else:
            photos = self.PHOTOS_TRIBUNE
        return [photo_entry(path, caption) for path, caption in photos + self.PHOTO_MAP]

    def media(self) -> dict:
        return {
            "video": asset_url("videos/coldplay_live.mp4"),
            "video_label": "Coldplay live",
            "poster": asset_url("images/gbk_coldplay_stage_full3.jpg"),
        }

    # --- layout JSON ---------------------------------------------------------
    def _mini_grid(self, block: CategoryBlock, max_rows: int = 6, max_cols: int = 10) -> list[list[dict]]:
        """Kisi kursi perwakilan untuk dipilih langsung di Sub-Position Picker."""
        rows = block.rows(self.BOWL)
        picks = sorted({round(i * (len(rows) - 1) / max(1, max_rows - 1)) for i in range(max_rows)})
        grid = []
        for index in picks:
            row = rows[index]
            cols = min(max_cols, row.seat_count)
            seats = sorted({min(row.seat_count, int((c + 0.5) / cols * row.seat_count) + 1) for c in range(cols)})
            grid.append([{"seat_id": f"{block.block_id}:R{row.number}:S{n}", "row": row.number, "seat": n}
                         for n in seats])
        return grid

    def _block_dict(self, block: CategoryBlock) -> dict:
        data = {
            "id": block.block_id, "label": block.label, "category": block.category,
            "color": block.color, "text_color": block.text_color, "price": block.price,
            "standing": block.standing, "restricted": block.restricted,
            "description": block.description, "perks": list(block.perks),
        }
        if block.standing:
            return data
        rows = block.rows(self.BOWL)
        bands = self.band_rows(block)
        data.update({
            "tiers": [{"name": t.name, "label": t.label, "depth_start": round(a, 2), "depth_end": round(b, 2),
                       "y_start": round(t.height_at(a), 2), "y_end": round(t.height_at(b), 2)}
                      for t, a, b in block.depth_ranges(self.BOWL)],
            "bearing": [block.bearing_start, block.bearing_end],
            "outline": block.outline(self.BOWL),
            "label_pos": block.label_point(self.BOWL),
            "row_count": len(rows),
            "seats_per_row": rows[len(rows) // 2].seat_count,
            "row_seats": [row.seat_count for row in rows],
            "bands": [{"key": key, "label": label, "row": bands[key]} for key, label in self.BANDS.items()],
            "sides": [{"key": key, "label": label} for key, (label, _) in self.SIDES.items()],
            "mini_grid": self._mini_grid(block),
        })
        return data

    @classmethod
    def _field_outline(cls) -> list[list[float]]:
        """Area Festival: elips sejajar kontur dalam tribun GBK, dipotong garis depan panggung (z = -53 m).

        Mundur 13 m dari tepi lapangan (= 2,6 m di dalam lintasan lari 10,4 m), jadi rumput terisi sampai
        dekat trek tanpa pernah menimpanya.
        """
        bowl, inset, top, steps = cls.BOWL, 13.0, -53.0, 64
        start = math.degrees(math.acos(-top / (bowl.rz_inner - inset)))     # elips memotong z = top di bearing ini
        bearings = [start + (360.0 - 2.0 * start) * i / steps for i in range(steps + 1)]
        return [[round(p.x, 2), round(p.z, 2)] for p in (bowl.point(b, -inset) for b in bearings)]

    @cached_property
    def _layout(self) -> dict:
        bowl, stage = self.BOWL, self.main_stage
        bearings = [i * 3.0 for i in range(121)]

        def ring(depth: float, y: float) -> list[list[float]]:
            return [bowl.point(b, depth, y).to_list(2) for b in bearings]

        return {
            **self.summary(),
            "bowl": {
                "rx_inner": bowl.rx_inner, "rz_inner": bowl.rz_inner,
                "row_depth": bowl.row_depth, "seat_pitch": bowl.seat_pitch,
                "bearings": bearings,
                "closed": [bowl.closed_start, bowl.closed_end],
                "field_edge": ring(0.0, 0.0),
                "tiers": [{"name": t.name, "label": t.label, "rake": t.rake,
                           "depth_start": t.depth_start, "depth_end": t.depth_end,
                           "inner": ring(t.depth_start, t.height_at(t.depth_start)),
                           "outer": ring(t.depth_end, t.height_at(t.depth_end))} for t in bowl.tiers],
                "roof": {"inner": ring(bowl.roof_depth[0], bowl.roof_y[0]),
                         "outer": ring(bowl.roof_depth[1], bowl.roof_y[1])},
            },
            "blocks": [self._block_dict(b) for b in self.blocks.values()],
            "field": {"outline": self._field_outline()},
            "stage": {
                "deck": {"x0": -stage.HALF_WIDTH, "x1": stage.HALF_WIDTH, "z0": stage.BACK_Z,
                         "z1": stage.FRONT_Z, "y": stage.DECK_Y},
                "performer_z": stage.PERFORMER_Z,
                "runway": self.RUNWAY,
                "b_stage": {
                    "center": self.b_stage.center.to_list(),
                    "radius": self.b_stage.radius,
                    "label": "B-Stage (Panggung Tengah)",
                    "role": "Panggung satelit di ujung runway agar band lebih dekat ke Festival & tribun tengah.",
                },
                "c_stage": {
                    "center": self.c_stage.center.to_list(),
                    "radius": self.c_stage.radius,
                    "label": "C-Stage (Panggung Akustik)",
                    "role": "Panggung bundar di belakang area Festival untuk sesi lagu akustik intim di tengah penonton.",
                },
            },
            "standing_spots": [{"number": s.number, "key": s.key, "label": s.label,
                                "description": s.description, "x": s.x, "z": s.z, "density": s.density}
                               for s in self.SPOTS],
            "targets": [t.to_dict() for t in self.targets()],
            "occluders": [self._occluder_dict(o) for o in self.occluders()],
            "speakers": [s.to_dict() for s in self.speaker_sources()],
            "features": {"xylobands": True},
            "media": self.media(),
            "reference_photos": self.reference_photos(),
        }

    def layout(self) -> dict:
        return self._layout
