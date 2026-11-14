"""
obstruction.py — Antropometri tubuh & simulasi halangan kepala.

Slider "Tinggi Badan Kamu" (145–195 cm) dan "Tinggi Penonton di Depan" masuk ke sini:

1. `Anthropometry` mengubah tinggi badan menjadi tinggi mata / puncak kepala / bahu
   memakai rasio segmen tubuh Drillis & Contini (1966).
2. `ObstructionModel` (abstract) punya dua strategi:
   * `SeatedRowObstruction`   — kursi berundak (bioskop & tribun): garis pandang
     melewati puncak kepala orang di baris depan (analisis C-value arsitektur venue).
   * `StandingCrowdObstruction` — festival berdiri: kerumunan berlapis dimodelkan
     sebagai penghalang probabilistik per baris.
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import ClassVar

from .geometry_3d import EPS, Vec3, angular_size_deg, clamp, euclidean_distance

MIN_BODY_CM = 145.0
MAX_BODY_CM = 195.0
DEFAULT_BODY_CM = 170.0


class Posture(str, Enum):
    SEATED = "seated"
    RECLINED = "reclined"
    STANDING = "standing"


# --------------------------------------------------------------------------- #
# Antropometri
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Anthropometry:
    """Ukuran tubuh turunan dari tinggi badan (rasio terhadap stature H)."""

    stature_cm: float

    EYE_RATIO: ClassVar[float] = 0.936             # tinggi mata berdiri
    SHOULDER_RATIO: ClassVar[float] = 0.818        # tinggi bahu berdiri
    SITTING_HEIGHT_RATIO: ClassVar[float] = 0.520  # alas duduk → puncak kepala
    SITTING_EYE_RATIO: ClassVar[float] = 0.456     # alas duduk → mata
    SITTING_SHOULDER_RATIO: ClassVar[float] = 0.338
    SHOULDER_WIDTH_RATIO: ClassVar[float] = 0.259
    HEAD_WIDTH_RATIO: ClassVar[float] = 0.090

    @classmethod
    def from_cm(cls, value: object) -> "Anthropometry":
        """Validasi input slider: non-angka → default, di luar rentang → dijepit."""
        try:
            cm = float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            cm = DEFAULT_BODY_CM
        if math.isnan(cm) or math.isinf(cm):
            cm = DEFAULT_BODY_CM
        return cls(clamp(cm, MIN_BODY_CM, MAX_BODY_CM))

    @property
    def stature_m(self) -> float:
        return self.stature_cm / 100.0

    @property
    def shoulder_width_m(self) -> float:
        return self.SHOULDER_WIDTH_RATIO * self.stature_m

    @property
    def head_width_m(self) -> float:
        return self.HEAD_WIDTH_RATIO * self.stature_m

    def _offsets(
        self, sitting_ratio: float, standing_ratio: float,
        posture: Posture, seat_height_m: float, recline_deg: float,
    ) -> tuple[float, float]:
        """(naik, mundur) dalam meter relatif titik lantai di bawah kursi.

        Saat rebah, batang tubuh berputar θ dari vertikal: tinggi = L·cos θ,
        geser ke belakang = L·sin θ.
        """
        if posture is Posture.STANDING:
            return standing_ratio * self.stature_m, 0.0
        length = sitting_ratio * self.stature_m
        theta = math.radians(recline_deg) if posture is Posture.RECLINED else 0.0
        return seat_height_m + length * math.cos(theta), length * math.sin(theta)

    def eye_offsets(self, posture: Posture, seat_height_m: float = 0.44, recline_deg: float = 0.0):
        return self._offsets(self.SITTING_EYE_RATIO, self.EYE_RATIO, posture, seat_height_m, recline_deg)

    def head_top_offsets(self, posture: Posture, seat_height_m: float = 0.44, recline_deg: float = 0.0):
        return self._offsets(self.SITTING_HEIGHT_RATIO, 1.0, posture, seat_height_m, recline_deg)

    def shoulder_offsets(self, posture: Posture, seat_height_m: float = 0.44, recline_deg: float = 0.0):
        return self._offsets(self.SITTING_SHOULDER_RATIO, self.SHOULDER_RATIO, posture, seat_height_m, recline_deg)


# --------------------------------------------------------------------------- #
# Data masukan & keluaran
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ObstructionContext:
    """Semua yang dibutuhkan model halangan untuk satu kursi + satu target."""

    eye: Vec3
    viewer_floor: Vec3
    viewer_facing: Vec3
    viewer: Anthropometry
    front: Anthropometry
    target_bottom: Vec3
    target_top: Vec3
    target_width_m: float
    target_label: str = "layar"
    front_floor: Vec3 | None = None          # None = baris terdepan
    front_posture: Posture = Posture.SEATED
    front_seat_height_m: float = 0.44
    front_recline_deg: float = 0.0
    has_subtitles: bool = False
    crowd_clear_zone_m: float = 3.0          # jarak barikade ke titik target


@dataclass(frozen=True)
class FrontSpectator:
    """Penonton tepat di depan — dipakai Three.js untuk menggambar siluetnya."""

    floor: Vec3
    head_top_y: float
    shoulder_y: float
    shoulder_width_m: float
    head_radius_m: float
    posture: Posture
    height_cm: float
    lean_back_m: float = 0.0

    def to_dict(self) -> dict:
        return {
            "present": True,
            "floor": self.floor.to_list(),
            "head_top_y": round(self.head_top_y, 3),
            "shoulder_y": round(self.shoulder_y, 3),
            "shoulder_width_m": round(self.shoulder_width_m, 3),
            "head_radius_m": round(self.head_radius_m, 3),
            "posture": self.posture.value,
            "height_cm": round(self.height_cm, 1),
            "lean_back_m": round(self.lean_back_m, 3),
        }


@dataclass(frozen=True)
class ObstructionResult:
    model: str
    blocked_pct: float            # % luas target yang tertutup
    blocked_height_pct: float     # % tinggi target tertutup di garis tengah
    impact_pct: float             # dampak 0–100 yang masuk ke Sightline Score
    c_value_cm: float | None      # clearance garis pandang di atas kepala depan
    lowest_visible_y: float | None
    subtitle_blocked: bool
    subtitle_blocked_pct: float
    severity: str
    message: str
    visibility_profile: tuple[float, ...]   # bawah → atas, 0 = tertutup, 1 = terlihat
    crowd_rows: int = 0

    @staticmethod
    def severity_of(impact_pct: float) -> str:
        if impact_pct < 3.0:
            return "bebas"
        if impact_pct < 20.0:
            return "ringan"
        if impact_pct < 50.0:
            return "sedang"
        return "berat"

    @classmethod
    def clear(cls, model: str, message: str, samples: int = 12) -> "ObstructionResult":
        return cls(model, 0.0, 0.0, 0.0, None, None, False, 0.0, "bebas", message, (1.0,) * samples)

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "blocked_pct": round(self.blocked_pct, 1),
            "blocked_height_pct": round(self.blocked_height_pct, 1),
            "impact_pct": round(self.impact_pct, 1),
            "c_value_cm": None if self.c_value_cm is None else round(self.c_value_cm, 1),
            "lowest_visible_y": None if self.lowest_visible_y is None else round(self.lowest_visible_y, 2),
            "subtitle_blocked": self.subtitle_blocked,
            "subtitle_blocked_pct": round(self.subtitle_blocked_pct, 1),
            "severity": self.severity,
            "message": self.message,
            "visibility_profile": [round(v, 2) for v in self.visibility_profile],
            "crowd_rows": self.crowd_rows,
        }


# --------------------------------------------------------------------------- #
# Strategi halangan (polimorfisme)
# --------------------------------------------------------------------------- #
class ObstructionModel(ABC):
    """Kontrak: setiap venue memilih model yang cocok untuk tiap kursi."""

    name: ClassVar[str] = "abstract"
    PROFILE_SAMPLES: ClassVar[int] = 12

    @abstractmethod
    def front_spectator(self, ctx: ObstructionContext) -> FrontSpectator | None:
        """Geometri penonton tepat di depan (None bila tidak ada)."""

    @abstractmethod
    def evaluate(self, ctx: ObstructionContext) -> ObstructionResult:
        """Hitung persentase target yang tertutup."""


class SeatedRowObstruction(ObstructionModel):
    """Kursi berundak: satu kepala di baris depan memotong bagian bawah target.

    Garis dari mata melewati puncak kepala depan lalu diperpanjang ke bidang target:
        y_potong = y_mata + (y_kepala − y_mata) · (D / d)
    dengan D = jarak horizontal ke target dan d = jarak ke kepala di depan.
    """

    name = "seated_row"
    SUBTITLE_BAND: ClassVar[float] = 0.12     # subtitle = 12% tinggi layar terbawah
    SUBTITLE_WIDTH: ClassVar[float] = 0.50    # ...dan 50% lebar layar di tengah
    IMPACT_WEIGHT: ClassVar[float] = 3.0      # 33% tinggi tertutup ≈ dampak maksimal

    def front_spectator(self, ctx: ObstructionContext) -> FrontSpectator | None:
        if ctx.front_floor is None:
            return None
        args = (ctx.front_posture, ctx.front_seat_height_m, ctx.front_recline_deg)
        head_up, lean_back = ctx.front.head_top_offsets(*args)
        shoulder_up, _ = ctx.front.shoulder_offsets(*args)
        return FrontSpectator(
            floor=ctx.front_floor,
            head_top_y=ctx.front_floor.y + head_up,
            shoulder_y=ctx.front_floor.y + shoulder_up,
            shoulder_width_m=ctx.front.shoulder_width_m,
            head_radius_m=ctx.front.head_width_m * 0.62,
            posture=ctx.front_posture,
            height_cm=ctx.front.stature_cm,
            lean_back_m=lean_back,
        )

    def evaluate(self, ctx: ObstructionContext) -> ObstructionResult:
        spectator = self.front_spectator(ctx)
        if spectator is None:
            return ObstructionResult.clear(
                self.name, "Baris terdepan: tidak ada penonton di depanmu.", self.PROFILE_SAMPLES)

        span = ctx.target_top.y - ctx.target_bottom.y
        target_dist = ctx.eye.horizontal_distance_to(ctx.target_bottom)
        facing = ctx.viewer_facing.horizontal().normalized()
        to_target = (ctx.target_bottom - ctx.eye).horizontal().normalized()
        # Menatap menyamping → kepala yang menghalangi berada lebih jauh di sepanjang garis pandang.
        cos_theta = max(0.3, facing.dot(to_target))
        gap = (ctx.front_floor - ctx.eye).horizontal().dot(facing) - spectator.lean_back_m
        head_dist = gap / cos_theta
        if span < EPS or gap < 0.15 or head_dist >= target_dist:
            return ObstructionResult.clear(
                self.name, f"Tidak ada kepala di antara kamu dan {ctx.target_label}.", self.PROFILE_SAMPLES)

        scale = target_dist / head_dist
        y_head = ctx.eye.y + (spectator.head_top_y - ctx.eye.y) * scale
        y_shoulder = ctx.eye.y + (spectator.shoulder_y - ctx.eye.y) * scale
        frac_head = clamp((y_head - ctx.target_bottom.y) / span, 0.0, 1.0)
        frac_shoulder = clamp((y_shoulder - ctx.target_bottom.y) / span, 0.0, 1.0)

        # Lebar sudut kepala/bahu dibanding lebar sudut target.
        slant = math.hypot(head_dist, spectator.head_top_y - ctx.eye.y)
        target_mid = ctx.target_bottom.lerp(ctx.target_top, 0.5)
        target_ang = max(EPS, angular_size_deg(ctx.target_width_m, euclidean_distance(ctx.eye, target_mid)))
        head_ang = angular_size_deg(2.0 * spectator.head_radius_m, slant)
        lat_head = min(1.0, head_ang / target_ang)
        lat_shoulder = min(1.0, angular_size_deg(spectator.shoulder_width_m, slant) / target_ang)
        blocked_area = (frac_shoulder * lat_shoulder + max(0.0, frac_head - frac_shoulder) * lat_head) * 100.0

        # C-value: tinggi garis pandang ke tepi bawah target saat melewati kepala depan.
        y_line = ctx.eye.y + (ctx.target_bottom.y - ctx.eye.y) * (head_dist / target_dist)
        c_value_cm = (y_line - spectator.head_top_y) * 100.0

        subtitle_pct, subtitle_blocked = 0.0, False
        if ctx.has_subtitles:
            band = clamp((y_head - ctx.target_bottom.y) / (self.SUBTITLE_BAND * span), 0.0, 1.0)
            subtitle_pct = band * min(1.0, head_ang / (self.SUBTITLE_WIDTH * target_ang)) * 100.0
            subtitle_blocked = band > 0.25

        impact = clamp(frac_head * 100.0 * self.IMPACT_WEIGHT, 0.0, 100.0)
        n = self.PROFILE_SAMPLES
        profile = tuple(
            0.0 if ctx.target_bottom.y + (i + 0.5) / n * span < y_head else 1.0 for i in range(n))

        if frac_head <= 0.0:
            message = (f"Garis pandang bersih: puncak kepala penonton depan {abs(c_value_cm):.0f} cm "
                       f"di bawah garis pandangmu ke tepi bawah {ctx.target_label}.")
        else:
            message = (f"Kepala penonton depan ({ctx.front.stature_cm:.0f} cm) menutup "
                       f"{frac_head * 100:.0f}% bagian bawah {ctx.target_label}")
            message += " — subtitle ikut tertutup." if subtitle_blocked else "."
        return ObstructionResult(
            model=self.name,
            blocked_pct=blocked_area,
            blocked_height_pct=frac_head * 100.0,
            impact_pct=impact,
            c_value_cm=c_value_cm,
            lowest_visible_y=max(ctx.target_bottom.y, y_head),
            subtitle_blocked=subtitle_blocked,
            subtitle_blocked_pct=subtitle_pct,
            severity=ObstructionResult.severity_of(impact),
            message=message,
            visibility_profile=profile,
            crowd_rows=1,
        )


class StandingCrowdObstruction(ObstructionModel):
    """Festival berdiri: kerumunan berlapis sebagai penghalang probabilistik.

    Untuk tiap titik sampel pada target, sinar dari mata melewati baris ke-i pada
    ketinggian y_i. Peluang tertutup di baris itu bergantung pada zona tubuh yang
    dilewati (bahu / kepala / tangan-HP terangkat) dan kerapatan lateral kerumunan:

        P(terlihat) = Π (1 − p_i)

    Deterministik (tanpa random) supaya hasilnya sama setiap kali slider digeser.
    """

    name = "standing_crowd"
    CROWD_MEAN_CM: ClassVar[float] = 165.0
    MAX_ROWS: ClassVar[int] = 80
    SAMPLES: ClassVar[int] = 24
    HANDS_ZONE_M: ClassVar[float] = 0.25
    PEEK_FACTOR: ClassVar[float] = 0.5   # kita bisa menggeser kepala mencari celah 2 baris terdekat

    def __init__(self, density_per_m2: float = 2.5) -> None:
        self.density = max(0.5, density_per_m2)
        self.spacing = 1.0 / math.sqrt(self.density)

    def _direction(self, ctx: ObstructionContext) -> Vec3:
        return (ctx.target_bottom - ctx.eye).horizontal().normalized()

    def front_spectator(self, ctx: ObstructionContext) -> FrontSpectator | None:
        floor = ctx.viewer_floor + self._direction(ctx) * self.spacing
        return FrontSpectator(
            floor=floor,
            head_top_y=floor.y + ctx.front.stature_m,
            shoulder_y=floor.y + Anthropometry.SHOULDER_RATIO * ctx.front.stature_m,
            shoulder_width_m=ctx.front.shoulder_width_m,
            head_radius_m=ctx.front.head_width_m * 0.62,
            posture=Posture.STANDING,
            height_cm=ctx.front.stature_cm,
        )

    def _row_person(self, index: int, ctx: ObstructionContext) -> tuple[float, float]:
        """(tinggi bahu, tinggi puncak kepala) orang di baris ke-`index`."""
        if index <= 2:
            stature = ctx.front.stature_m
        else:  # variasi ±6 cm yang deterministik (sudut emas)
            stature = self.CROWD_MEAN_CM / 100.0 + 0.06 * math.sin(index * 2.399963)
        base = ctx.viewer_floor.y
        return base + Anthropometry.SHOULDER_RATIO * stature, base + stature

    def evaluate(self, ctx: ObstructionContext) -> ObstructionResult:
        span = ctx.target_top.y - ctx.target_bottom.y
        distance = ctx.eye.horizontal_distance_to(ctx.target_bottom)
        rows = min(self.MAX_ROWS, int(max(0.0, distance - ctx.crowd_clear_zone_m) / self.spacing))
        if rows == 0 or span < EPS:
            return ObstructionResult.clear(
                self.name, f"Kamu di barikade terdepan: {ctx.target_label} terlihat penuh.", self.SAMPLES)

        rho_shoulder = min(0.92, 0.44 / self.spacing)
        rho_head = min(0.60, 0.16 / self.spacing)
        rho_hands = min(0.08, 0.022 * self.density)
        people = [self._row_person(i, ctx) for i in range(1, rows + 1)]

        profile: list[float] = []
        for k in range(self.SAMPLES):
            y_target = ctx.target_bottom.y + (k + 0.5) / self.SAMPLES * span
            slope = (y_target - ctx.eye.y) / distance
            visible = 1.0
            for i, (shoulder_y, head_y) in enumerate(people, start=1):
                y_ray = ctx.eye.y + slope * i * self.spacing
                if y_ray < shoulder_y:
                    p = rho_shoulder
                elif y_ray < head_y:
                    p = rho_head * (1.6 if i == 1 else 1.0)
                    if i <= 2:
                        p *= self.PEEK_FACTOR
                elif y_ray < head_y + self.HANDS_ZONE_M:
                    p = rho_hands
                else:
                    if slope > 0:
                        break       # sinar sudah di atas kerumunan dan terus naik
                    continue
                visible *= 1.0 - p
                if visible < 1e-4:
                    visible = 0.0
                    break
            profile.append(visible)

        visible_fraction = sum(profile) / len(profile)
        blocked = (1.0 - visible_fraction) * 100.0
        lowest = next(
            (ctx.target_bottom.y + (k + 0.5) / self.SAMPLES * span for k, v in enumerate(profile) if v >= 0.5),
            None)
        # Ringkas profil 24 sampel → 12 untuk UI.
        compact = tuple((profile[i] + profile[i + 1]) / 2.0 for i in range(0, self.SAMPLES, 2))
        message = (f"{rows} baris kerumunan ({self.density:.1f} orang/m²) di depanmu: sekitar "
                   f"{blocked:.0f}% {ctx.target_label} tertutup kepala dan tangan terangkat.")
        return ObstructionResult(
            model=self.name,
            blocked_pct=blocked,
            blocked_height_pct=blocked,
            impact_pct=clamp(blocked, 0.0, 100.0),
            c_value_cm=(ctx.eye.y - (ctx.viewer_floor.y + ctx.front.stature_m)) * 100.0,
            lowest_visible_y=lowest,
            subtitle_blocked=False,
            subtitle_blocked_pct=0.0,
            severity=ObstructionResult.severity_of(blocked),
            message=message,
            visibility_profile=compact,
            crowd_rows=rows,
        )
