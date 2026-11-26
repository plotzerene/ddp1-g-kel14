"""
base_venue.py — Abstract Base Class untuk semua venue.

Tiga kontrak abstrak yang wajib diimplementasikan studio bioskop maupun stadion:

* `TargetStage` — sesuatu yang ditonton (layar bioskop, panggung utama, B-Stage)
* `SeatNode`    — satu posisi penonton (kursi, recliner, kursi tribun, spot berdiri)
* `Venue`       — kumpulan kursi + target + penghalang + lingkungan akustik

Mesin perhitungan (`engine/`) hanya mengenal ketiga abstraksi ini, jadi venue
baru cukup dibuat sebagai subclass tanpa mengubah mesinnya (polimorfisme).
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import ClassVar, Sequence

from ..engine.acoustics import AcousticEnvironment, SpeakerSource
from ..engine.geometry_3d import AABB, EPS, UP, Vec3, angle_between_deg
from ..engine.obstruction import Anthropometry, ObstructionModel, Posture
from ..engine.sightline_ai import ScoringProfile


class SeatNotFoundError(LookupError):
    """Kursi / blok / venue yang diminta tidak ada."""


class VenueKind(str, Enum):
    CINEMA = "cinema"
    CONCERT = "concert"


class SeatStatus(str, Enum):
    AVAILABLE = "available"
    SOLD = "sold"


class SurfaceShape(str, Enum):
    FLAT = "flat"
    CURVED = "curved"
    CIRCLE = "circle"
    SEMICIRCLE = "semicircle"


# --------------------------------------------------------------------------- #
# Permukaan layar / LED
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ScreenSurface:
    """Permukaan yang memutar video: layar datar, layar lengkung, LED bundar/setengah bundar.

    Koordinat lokal (u, v) ∈ [-0.5, 0.5]²: u = kiri→kanan dari sisi penonton, v = bawah→atas.
    """

    surface_id: str
    label: str
    shape: SurfaceShape
    center: Vec3
    width: float
    height: float
    normal: Vec3 = Vec3(0.0, 0.0, 1.0)
    curve_radius: float | None = None

    @property
    def right(self) -> Vec3:
        return UP.cross(self.normal).normalized()

    @property
    def is_flat(self) -> bool:
        return self.shape is not SurfaceShape.CURVED

    @property
    def half_angle(self) -> float:
        """Setengah sudut busur layar lengkung (radian)."""
        if not self.curve_radius:
            return 0.0
        return math.asin(min(1.0, self.width / (2.0 * self.curve_radius)))

    @property
    def area(self) -> float:
        radius = self.width / 2.0
        if self.shape is SurfaceShape.CIRCLE:
            return math.pi * radius ** 2
        if self.shape is SurfaceShape.SEMICIRCLE:
            return math.pi * radius ** 2 / 2.0
        if self.shape is SurfaceShape.CURVED and self.curve_radius:
            return 2.0 * self.half_angle * self.curve_radius * self.height
        return self.width * self.height

    def point(self, u: float, v: float) -> Vec3:
        """Titik dunia untuk koordinat lokal (u, v)."""
        if self.shape is SurfaceShape.CURVED and self.curve_radius:
            angle = 2.0 * u * self.half_angle
            r = self.curve_radius
            return (self.center + self.right * (r * math.sin(angle))
                    + self.normal * (r * (1.0 - math.cos(angle))) + UP * (v * self.height))
        return self.center + self.right * (u * self.width) + UP * (v * self.height)

    def contains(self, u: float, v: float) -> bool:
        """Apakah (u, v) berada di dalam bentuk layar (masker bundar/setengah bundar)."""
        if abs(u) > 0.5 or abs(v) > 0.5:
            return False
        if self.shape is SurfaceShape.CIRCLE:
            return (2.0 * u) ** 2 + (2.0 * v) ** 2 <= 1.0
        if self.shape is SurfaceShape.SEMICIRCLE:
            x, y = u * self.width, (v + 0.5) * self.height
            return x * x + y * y <= (self.width / 2.0) ** 2
        return True

    def sample_points(self, nu: int = 6, nv: int = 6) -> list[Vec3]:
        """Titik sampel merata di permukaan untuk uji garis pandang."""
        points = [
            self.point((i + 0.5) / nu - 0.5, (j + 0.5) / nv - 0.5)
            for i in range(nu) for j in range(nv)
            if self.contains((i + 0.5) / nu - 0.5, (j + 0.5) / nv - 0.5)
        ]
        return points or [self.center]

    def edges(self) -> dict[str, Vec3]:
        base_v = -0.5 if self.shape is SurfaceShape.SEMICIRCLE else 0.0
        return {
            "left": self.point(-0.5, base_v),
            "right": self.point(0.5, base_v),
            "top": self.point(0.0, 0.5),
            "bottom": self.point(0.0, -0.5),
        }

    def faces(self, eye: Vec3) -> bool:
        """False bila penonton berada di belakang permukaan."""
        return (eye - self.center).dot(self.normal) > 0.05

    def obliquity_deg(self, eye: Vec3) -> float:
        """Sudut antara normal layar dan arah ke mata (0° = tegak lurus)."""
        return angle_between_deg(self.normal, eye - self.center)

    def blocks_segment(self, a: Vec3, b: Vec3) -> bool:
        """Apakah panel ini menghalangi ruas garis a→b (uji potong garis–bidang)."""
        if not self.is_flat:
            return False
        direction = b - a
        denom = self.normal.dot(direction)
        if abs(denom) < EPS:
            return False
        t = self.normal.dot(self.center - a) / denom
        if not 0.002 < t < 0.998:
            return False
        local = a + direction * t - self.center
        return self.contains(local.dot(self.right) / self.width, local.dot(UP) / self.height)

    def arc_points(self, segments: int = 32) -> list[list[float]]:
        """Titik [x, y_tengah, z] sepanjang busur — dipakai Three.js membangun mesh layar."""
        return [self.point(i / segments - 0.5, 0.0).to_list() for i in range(segments + 1)]

    def to_dict(self) -> dict:
        return {
            "id": self.surface_id,
            "label": self.label,
            "shape": self.shape.value,
            "center": self.center.to_list(),
            "width": self.width,
            "height": self.height,
            "normal": self.normal.to_list(4),
            "yaw_rad": round(math.atan2(self.normal.x, self.normal.z), 5),
            "curve_radius": self.curve_radius,
            "arc": self.arc_points() if self.shape is SurfaceShape.CURVED else None,
        }


@dataclass(frozen=True)
class Occluder:
    """Benda padat yang bisa menghalangi pandangan (pilar, menara delay, FOH)."""

    occluder_id: str
    label: str
    kind: str
    box: AABB

    def to_dict(self) -> dict:
        return {
            "id": self.occluder_id,
            "label": self.label,
            "kind": self.kind,
            "min": self.box.min.to_list(),
            "max": self.box.max.to_list(),
        }


@dataclass(frozen=True)
class FrontNeighbor:
    """Posisi & postur penonton tepat di depan sebuah kursi."""

    floor: Vec3
    posture: Posture
    seat_height_m: float
    recline_deg: float = 0.0


# --------------------------------------------------------------------------- #
# ABC 1 — target tontonan
# --------------------------------------------------------------------------- #
class TargetStage(ABC):
    """Sesuatu yang bisa dijadikan fokus pandangan."""

    has_subtitles: ClassVar[bool] = False

    def __init__(self, target_id: str, label: str, button_label: str, noun: str) -> None:
        self.target_id = target_id
        self.label = label
        self.button_label = button_label
        self.noun = noun            # dipakai di kalimat: "layar", "panggung utama", ...

    @property
    @abstractmethod
    def focus_point(self) -> Vec3:
        """Titik yang ditatap kamera saat tombol fokus ditekan."""

    @abstractmethod
    def surfaces(self) -> list[ScreenSurface]:
        """Permukaan video milik target ini (boleh kosong)."""

    @abstractmethod
    def sightline_span(self) -> tuple[Vec3, Vec3]:
        """Ruas vertikal (bawah, atas) yang harus terlihat — dasar hitung halangan."""

    @abstractmethod
    def performance_points(self) -> list[Vec3]:
        """Titik-titik tempat penampil berada, untuk uji terhalang pilar/menara."""

    @property
    @abstractmethod
    def extent_width(self) -> float:
        """Lebar target (m) untuk menghitung porsi lateral yang tertutup kepala."""

    @property
    def crowd_clear_zone_m(self) -> float:
        """Jarak dari titik target ke barikade penonton terdepan."""
        return 3.0

    @property
    def facing_normal(self) -> Vec3 | None:
        """Arah hadap target (None = bisa ditonton dari segala arah)."""
        return None

    def off_axis_deg(self, eye: Vec3) -> float:
        normal = self.facing_normal
        if normal is None:
            return 0.0
        return angle_between_deg(normal.horizontal(), (eye - self.focus_point).horizontal())

    def to_dict(self) -> dict:
        bottom, top = self.sightline_span()
        return {
            "id": self.target_id,
            "label": self.label,
            "button_label": self.button_label,
            "focus_point": self.focus_point.to_list(),
            "span": [bottom.to_list(), top.to_list()],
            "surfaces": [s.to_dict() for s in self.surfaces()],
        }


# --------------------------------------------------------------------------- #
# ABC 2 — posisi penonton
# --------------------------------------------------------------------------- #
class SeatNode(ABC):
    """Satu posisi menonton. Subclass menentukan postur, arah hadap, dan tetangga depan."""

    seat_height_m: ClassVar[float] = 0.44
    seat_type: ClassVar[str] = "generic"

    def __init__(self, seat_id: str, label: str, category: str, price: int,
                 status: SeatStatus = SeatStatus.AVAILABLE) -> None:
        self.seat_id = seat_id
        self.label = label
        self.category = category
        self.price = price
        self.status = status

    # --- wajib diisi subclass ------------------------------------------------
    @property
    @abstractmethod
    def floor_position(self) -> Vec3:
        """Titik lantai tepat di bawah penonton."""

    @property
    @abstractmethod
    def facing(self) -> Vec3:
        """Arah hadap kursi (vektor satuan horizontal)."""

    @property
    @abstractmethod
    def posture(self) -> Posture:
        ...

    @abstractmethod
    def front_neighbor(self) -> FrontNeighbor | None:
        """Penonton tepat di depan, atau None untuk baris terdepan / area berdiri."""

    @abstractmethod
    def frame_dict(self) -> dict:
        """Data lingkungan sekitar kursi untuk membangun detail 3D di dekat kamera."""

    # --- perilaku bawaan -----------------------------------------------------
    @property
    def recline_deg(self) -> float:
        return 0.0

    @property
    def free_orientation(self) -> bool:
        """True bila badan bebas berputar (berdiri) sehingga leher tidak terbebani."""
        return False

    @property
    def is_available(self) -> bool:
        return self.status is SeatStatus.AVAILABLE

    @property
    def group_key(self) -> str | None:
        """Kunci pengelompokan untuk menjaga keragaman rekomendasi."""
        return None

    def is_adjacent_to(self, other: "SeatNode") -> bool:
        return False

    def eye_position(self, viewer: Anthropometry) -> Vec3:
        """Template method: lantai + tinggi mata sesuai postur (+ geser mundur saat rebah)."""
        up, back = viewer.eye_offsets(self.posture, self.seat_height_m, self.recline_deg)
        return self.floor_position + UP * up - self.facing * back

    def to_dict(self) -> dict:
        return {
            "seat_id": self.seat_id,
            "label": self.label,
            "category": self.category,
            "price": self.price,
            "status": self.status.value,
            "posture": self.posture.value,
            "seat_type": self.seat_type,
            "floor": self.floor_position.to_list(),
            "facing": self.facing.to_list(4),
        }


# --------------------------------------------------------------------------- #
# ABC 3 — venue
# --------------------------------------------------------------------------- #
class Venue(ABC):
    """Kontrak yang dipakai PovEngine, recommender, dan API layout."""

    #: FOV vertikal lensa "mata normal" (derajat). None → bawaan engine (55°).
    LENS_BASE_FOV_DEG: ClassVar[float | None] = None
    #: Tinggi badan awal pengunjung (cm) di slider. None → `DEFAULT_BODY_CM` (170).
    DEFAULT_VIEWER_CM: ClassVar[float | None] = None

    def __init__(self, venue_id: str, name: str, kind: VenueKind, tagline: str) -> None:
        self.venue_id = venue_id
        self.name = name
        self.kind = kind
        self.tagline = tagline

    @abstractmethod
    def targets(self) -> list[TargetStage]:
        """Daftar target; elemen pertama = target utama."""

    @abstractmethod
    def occluders(self) -> list[Occluder]:
        ...

    @abstractmethod
    def resolve_seat(self, selector: dict) -> SeatNode:
        """Terjemahkan pilihan dari UI (seat_id / blok+baris+sisi / spot) menjadi SeatNode."""

    @abstractmethod
    def candidate_seats(self) -> Sequence[SeatNode]:
        """Kursi yang dinilai oleh Smart Seat Recommender & heatmap."""

    @abstractmethod
    def obstruction_model(self, seat: SeatNode) -> ObstructionModel:
        ...

    @abstractmethod
    def acoustic_environment(self) -> AcousticEnvironment:
        ...

    @abstractmethod
    def speaker_sources(self) -> list[SpeakerSource]:
        ...

    @abstractmethod
    def scoring_profile(self) -> ScoringProfile:
        ...

    @abstractmethod
    def layout(self) -> dict:
        """Seluruh geometri venue sebagai JSON untuk peta 2D dan scene Three.js."""

    @abstractmethod
    def reference_photos(self, seat: SeatNode | None = None) -> list[dict]:
        ...

    @abstractmethod
    def media(self) -> dict:
        ...

    @abstractmethod
    def default_selector(self) -> dict:
        """Posisi awal yang ditampilkan saat venue pertama kali dibuka."""

    # --- helper konkret ------------------------------------------------------
    @property
    def short_label(self) -> str:
        """Label pendek untuk tab di UI."""
        return self.name

    @property
    def price_from(self) -> int:
        return min((seat.price for seat in self.candidate_seats()), default=0)

    @property
    def primary_target(self) -> TargetStage:
        return self.targets()[0]

    def target(self, target_id: str | None) -> TargetStage:
        for candidate in self.targets():
            if candidate.target_id == target_id:
                return candidate
        return self.primary_target

    def summary(self) -> dict:
        return {"venue_id": self.venue_id, "name": self.name, "short_label": self.short_label,
                "kind": self.kind.value, "tagline": self.tagline}
