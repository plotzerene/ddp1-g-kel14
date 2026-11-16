"""
sightline_ai.py — Sightline Score (0–100) dan Smart Seat Recommender.

Bagian 1 — `SightlineScorer`
    Menggabungkan beberapa komponen (masing-masing 0–100) dengan bobot per jenis venue:
    cakupan layar, kenyamanan leher, sudut samping, bebas halangan, akustik,
    visibilitas panggung/LED, dan kedekatan.

Bagian 2 — `SmartSeatRecommender`
    Pola Strategy: setiap preset ("Paling Ideal", "Leher Anti Pegal",
    "Terdekat ke B-Stage", "Imersif Maksimal") adalah subclass
    `RecommendationStrategy` dengan fungsi utilitas dan penjelasannya sendiri.
    Recommender menilai semua kandidat, mengurutkan, lalu memilih 3 teratas
    yang tidak saling bersebelahan (greedy dengan batasan keragaman).
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, ClassVar

from .acoustics import AcousticProfile
from .geometry_3d import clamp

if TYPE_CHECKING:  # hanya untuk type hint, menghindari import melingkar
    from ..models.base_venue import SeatNode, Venue
    from .pov_engine import PovReport

THX_MIN_FOV_DEG = 36.0        # THX: sudut pandang minimum dari kursi terjauh
SMPTE_MAX_TOP_EDGE_DEG = 35.0  # SMPTE EG-18: dongakan maksimum ke tepi atas layar

COMPONENT_LABELS: dict[str, str] = {
    "fov": "Cakupan Layar",
    "neck": "Kenyamanan Leher",
    "off_axis": "Posisi Persis di Tengah",
    "obstruction": "Bebas Halangan",
    "acoustic": "Musik",
    "visibility": "Cakupan Layar",
    "proximity": "Kedekatan ke Panggung",
}


# --------------------------------------------------------------------------- #
# Profil penilaian & metrik masukan
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ScoringProfile:
    """Parameter penilaian milik satu venue."""

    kind: str                                   # "cinema" | "concert"
    weights: dict[str, float]
    ideal_h_fov_deg: float = 45.0
    fov_sigma_low: float = 12.0                 # toleransi bila layar terasa terlalu kecil
    fov_sigma_high: float = 18.0                # toleransi bila layar terlalu besar/dekat
    standard_label: str = "THX ≥ 36°"
    comfort_spl_db: tuple[float, float] = (76.0, 90.0)
    proximity_near_m: float = 8.0
    proximity_far_m: float = 220.0


@dataclass(frozen=True)
class SightlineMetrics:
    """Angka mentah hasil mesin geometri/halangan/akustik untuk satu kursi."""

    h_fov_deg: float              # lebar sudut layar terbaik yang terbaca
    effective_fov_deg: float      # h_fov × keterbacaan (0 bila LED hanya terlihat dari belakang)
    top_edge_deg: float
    neck_pitch_deg: float
    neck_yaw_deg: float
    off_axis_deg: float
    obstruction_impact_pct: float
    visible_pct: float
    distance_m: float
    acoustics: AcousticProfile


@dataclass(frozen=True)
class SightlineScore:
    total: float
    grade: str
    breakdown: dict[str, float]
    weights: dict[str, float]

    def to_dict(self) -> dict:
        return {
            "total": round(self.total, 1),
            "grade": self.grade,
            "breakdown": [
                {"key": key, "label": COMPONENT_LABELS[key], "value": round(value, 1),
                 "weight": round(self.weights[key], 3)}
                for key, value in self.breakdown.items()
            ],
        }


# --------------------------------------------------------------------------- #
# Fungsi komponen (murni, mudah diuji)
# --------------------------------------------------------------------------- #
def _ramp(value: float, good: float, bad: float) -> float:
    """100 bila value ≤ good, turun linear ke 0 pada value ≥ bad."""
    if value <= good:
        return 100.0
    if value >= bad:
        return 0.0
    return 100.0 * (bad - value) / (bad - good)


def fov_score(h_fov_deg: float, ideal_deg: float, sigma_low: float, sigma_high: float) -> float:
    """Kurva Gauss asimetris di sekitar sudut pandang ideal studio."""
    sigma = sigma_low if h_fov_deg < ideal_deg else sigma_high
    return 100.0 * math.exp(-(((h_fov_deg - ideal_deg) / sigma) ** 2))


def neck_score(neck_pitch_deg: float, neck_yaw_deg: float, top_edge_deg: float) -> float:
    """Leher netral = tengah target dekat garis mata dan tidak perlu menoleh.

    Mendongak lebih melelahkan daripada menunduk, jadi batasnya lebih ketat.
    Tepi atas layar di atas 35° (SMPTE) mendapat penalti tambahan.
    """
    if neck_pitch_deg >= 0.0:
        pitch = _ramp(neck_pitch_deg, 10.0, 40.0)
    else:
        pitch = _ramp(-neck_pitch_deg, 15.0, 45.0)
    yaw = _ramp(abs(neck_yaw_deg), 12.0, 65.0)
    penalty = max(0.0, top_edge_deg - SMPTE_MAX_TOP_EDGE_DEG) * 2.0
    return clamp(0.6 * pitch + 0.4 * yaw - penalty, 0.0, 100.0)


def off_axis_score(off_axis_deg: float, kind: str) -> float:
    """Bioskop: distorsi trapesium naik kuadratik. Konser: proyeksi kosinus muka panggung."""
    if kind == "cinema":
        return clamp(100.0 * (1.0 - (off_axis_deg / 55.0) ** 2), 0.0, 100.0)
    cosine = math.cos(math.radians(min(off_axis_deg, 90.0)))
    return 100.0 * max(0.0, cosine) ** 0.8


def acoustic_score(profile: AcousticProfile, comfort_spl_db: tuple[float, float]) -> float:
    """Level (35%), kejernihan D/R (30%), sinkron audio–video (20%), keseimbangan kiri–kanan (15%)."""
    low, high = comfort_spl_db
    if profile.spl_db < low:
        level = max(0.0, 100.0 - (low - profile.spl_db) * 6.0)
    elif profile.spl_db > high:
        level = max(0.0, 100.0 - (profile.spl_db - high) * 8.0)   # terlalu keras = lelah & berisiko
    else:
        level = 100.0
    clarity = clamp(70.0 + profile.direct_to_reverb_db * 4.0, 0.0, 100.0)
    sync = _ramp(profile.delay_ms, 45.0, 400.0)
    balance = _ramp(profile.stereo_skew_ms, 3.0, 60.0)
    return 0.35 * level + 0.30 * clarity + 0.20 * sync + 0.15 * balance


def proximity_score(distance_m: float, led_h_deg: float, near_m: float, far_m: float) -> float:
    """Kedekatan dinilai logaritmik (persepsi ukuran) + ukuran sudut LED terbesar."""
    ratio = math.log(max(distance_m, near_m) / near_m) / math.log(far_m / near_m)
    performer = clamp(100.0 * (1.0 - ratio), 0.0, 100.0)
    led = clamp(led_h_deg / 25.0 * 100.0, 0.0, 100.0)
    return 0.65 * performer + 0.35 * led


def grade_of(total: float) -> str:
    if total >= 85.0:
        return "Sempurna"
    if total >= 70.0:
        return "Bagus"
    if total >= 55.0:
        return "Cukup"
    if total >= 40.0:
        return "Kurang"
    return "Terbatas"


class SightlineScorer:
    """Menghitung Sightline Score berbobot untuk satu venue."""

    def __init__(self, profile: ScoringProfile) -> None:
        total_weight = sum(profile.weights.values())
        if total_weight <= 0:
            raise ValueError("Bobot skor harus positif.")
        self.profile = profile
        self.weights = {k: w / total_weight for k, w in profile.weights.items()}

    def components(self, m: SightlineMetrics) -> dict[str, float]:
        p = self.profile
        every = {
            "fov": fov_score(m.h_fov_deg, p.ideal_h_fov_deg, p.fov_sigma_low, p.fov_sigma_high),
            "neck": neck_score(m.neck_pitch_deg, m.neck_yaw_deg, m.top_edge_deg),
            "off_axis": off_axis_score(m.off_axis_deg, p.kind),
            "obstruction": clamp(100.0 - m.obstruction_impact_pct, 0.0, 100.0),
            "acoustic": acoustic_score(m.acoustics, p.comfort_spl_db),
            "visibility": clamp(m.visible_pct, 0.0, 100.0),
            "proximity": proximity_score(m.distance_m, m.effective_fov_deg, p.proximity_near_m, p.proximity_far_m),
        }
        return {key: every[key] for key in self.weights}

    def score(self, m: SightlineMetrics) -> SightlineScore:
        breakdown = self.components(m)
        total = sum(self.weights[key] * value for key, value in breakdown.items())
        return SightlineScore(total=total, grade=grade_of(total), breakdown=breakdown, weights=self.weights)


# --------------------------------------------------------------------------- #
# Kalimat penjelasan (bahasa sehari-hari, tanpa angka sudut)
# --------------------------------------------------------------------------- #
def view_phrase(clear_pct: float) -> str:
    if clear_pct >= 95.0:
        return "Pandangan bebas halangan."
    if clear_pct >= 85.0:
        return "Pandangan nyaris bebas halangan."
    if clear_pct >= 60.0:
        return "Sebagian kecil pandangan terhalang."
    return "Pandangan terhalang sebagian."


def screen_phrase(h_fov_deg: float, ideal_deg: float) -> str:
    ratio = h_fov_deg / ideal_deg if ideal_deg else 1.0
    if 0.85 <= ratio <= 1.15:
        return "Ukuran layar pas di pandangan."
    if ratio < 0.85:
        return "Layar terlihat utuh tanpa perlu menoleh."
    return "Layar terasa besar dan imersif."


def neck_phrase(neck_score_value: float) -> str:
    if neck_score_value >= 85.0:
        return "Leher tetap santai sepanjang acara."
    if neck_score_value >= 60.0:
        return "Leher cukup nyaman, sesekali perlu sedikit mendongak."
    return "Perlu mendongak atau menoleh cukup sering."


def center_phrase(off_axis_deg: float, noun: str) -> str:
    if off_axis_deg <= 8.0:
        return f"Posisi persis di tengah {noun}."
    if off_axis_deg <= 20.0:
        return f"Dekat dengan garis tengah {noun}."
    return f"Agak di samping {noun}."


# --------------------------------------------------------------------------- #
# Strategi rekomendasi
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RecommendContext:
    kind: str
    scoring: ScoringProfile


class RecommendationStrategy(ABC):
    """Satu preset preferensi = satu fungsi utilitas + penjelasan."""

    key: ClassVar[str]
    labels: ClassVar[dict[str, str]]          # label per jenis venue
    description: ClassVar[str]

    def supports(self, kind: str) -> bool:
        return kind in self.labels

    @abstractmethod
    def utility(self, report: "PovReport", ctx: RecommendContext) -> float:
        """Makin besar makin direkomendasikan."""

    @abstractmethod
    def reasons(self, report: "PovReport", ctx: RecommendContext) -> list[str]:
        """Penjelasan singkat (Bahasa Indonesia) kenapa kursi ini dipilih."""

    def describe(self, kind: str) -> dict:
        return {"key": self.key, "label": self.labels[kind], "description": self.description}


class IdealStrategy(RecommendationStrategy):
    key = "ideal_thx"
    labels = {"cinema": "Paling Ideal", "concert": "Paling Ideal"}
    description = ""

    def utility(self, report, ctx):
        bonus = 0.0
        if ctx.kind == "cinema" and report.metrics.h_fov_deg >= THX_MIN_FOV_DEG \
                and report.metrics.top_edge_deg <= SMPTE_MAX_TOP_EDGE_DEG:
            bonus = 3.0
        return report.score.total + bonus

    def reasons(self, report, ctx):
        m = report.metrics
        if ctx.kind == "cinema":
            return [
                screen_phrase(m.h_fov_deg, ctx.scoring.ideal_h_fov_deg),
                neck_phrase(report.score.breakdown["neck"]),
                center_phrase(m.off_axis_deg, "layar"),
                view_phrase(report.clear_view_pct),
            ]
        return [
            f"Sekitar {m.distance_m:.0f} m dari panggung utama.",
            center_phrase(m.off_axis_deg, "panggung"),
            view_phrase(report.clear_view_pct),
        ]


class NeckComfortStrategy(RecommendationStrategy):
    key = "neck_comfort"
    labels = {"cinema": "Leher Anti Pegal", "concert": "Leher Anti Pegal"}
    description = "Mengutamakan posisi kepala netral: tidak mendongak dan tidak menoleh lama."

    def utility(self, report, ctx):
        parts = report.score.breakdown
        return 0.65 * parts["neck"] + 0.20 * parts["obstruction"] + 0.15 * report.score.total

    def reasons(self, report, ctx):
        return [
            neck_phrase(report.score.breakdown["neck"]),
            center_phrase(report.metrics.off_axis_deg, report.primary.noun),
            view_phrase(report.clear_view_pct),
        ]


class ClosestBStageStrategy(RecommendationStrategy):
    key = "closest_bstage"
    labels = {"concert": "Terdekat ke B-Stage"}
    description = "Posisi paling dekat ke B-Stage di tengah lapangan, tetap memperhitungkan visibilitasnya."

    def utility(self, report, ctx):
        b_stage = report.targets["b_stage"]
        closeness = clamp(100.0 * (1.0 - b_stage.view.distance_m / 180.0), 0.0, 100.0)
        return 0.8 * closeness + 0.2 * b_stage.stage_visible_pct

    def reasons(self, report, ctx):
        b_stage = report.targets["b_stage"]
        return [
            f"Hanya sekitar {b_stage.view.distance_m:.0f} m dari B-Stage.",
            "B-Stage terlihat jelas." if b_stage.stage_visible_pct >= 85.0
            else "B-Stage sebagian tertutup menara suara.",
            f"Panggung utama tetap terlihat dari jarak {report.metrics.distance_m:.0f} m.",
        ]


class MaxImmersionStrategy(RecommendationStrategy):
    key = "max_immersion"
    labels = {"cinema": "Imersif Maksimal (Layar Memenuhi Pandangan)"}
    description = "Layar sebesar mungkin di pandanganmu tanpa harus mendongak berlebihan."

    def utility(self, report, ctx):
        m = report.metrics
        fill = min(m.h_fov_deg, 80.0) / 80.0 * 70.0
        penalty = max(0.0, m.top_edge_deg - SMPTE_MAX_TOP_EDGE_DEG) * 3.0
        return fill + 0.3 * report.score.breakdown["neck"] - penalty

    def reasons(self, report, ctx):
        m = report.metrics
        return [
            "Layar memenuhi sebagian besar pandanganmu.",
            "Tepi atas layar masih nyaman dilihat." if m.top_edge_deg <= SMPTE_MAX_TOP_EDGE_DEG
            else "Perlu sedikit mendongak ke tepi atas layar.",
            f"Jarak ke layar sekitar {m.distance_m:.0f} m.",
        ]


# --------------------------------------------------------------------------- #
# Recommender
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Recommendation:
    rank: int
    report: "PovReport"
    utility: float
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "rank": self.rank,
            "utility": round(self.utility, 2),
            "reasons": self.reasons,
            **self.report.summary(),
        }


class SmartSeatRecommender:
    """Menilai semua kandidat kursi lalu memilih top-N yang beragam."""

    STRATEGIES: ClassVar[dict[str, RecommendationStrategy]] = {
        s.key: s for s in (
            IdealStrategy(), NeckComfortStrategy(), ClosestBStageStrategy(), MaxImmersionStrategy(),
        )
    }
    MAX_PER_GROUP: ClassVar[int] = 1

    def __init__(self, venue: "Venue", evaluate: Callable[["SeatNode"], "PovReport"]) -> None:
        self.venue = venue
        self.evaluate = evaluate

    @classmethod
    def presets_for(cls, kind: str) -> list[dict]:
        return [s.describe(kind) for s in cls.STRATEGIES.values() if s.supports(kind)]

    def recommend(
        self,
        preset: str,
        top_n: int = 3,
        available_fn: Callable[["SeatNode"], bool] | None = None,
    ) -> dict:
        strategy = self.STRATEGIES.get(preset)
        kind = self.venue.kind.value
        if strategy is None or not strategy.supports(kind):
            raise ValueError(f"Preset '{preset}' tidak tersedia untuk venue ini.")

        ctx = RecommendContext(kind=kind, scoring=self.venue.scoring_profile())
        is_avail = available_fn or (lambda seat: seat.is_available)
        reports = [self.evaluate(seat) for seat in self.venue.candidate_seats() if is_avail(seat)]
        # Urutkan menurun berdasarkan utilitas; seri → lebih murah dulu, lalu ID agar deterministik.
        ranked = sorted(reports, key=lambda r: (-strategy.utility(r, ctx), r.seat.price, r.seat.seat_id))

        picks: list[Recommendation] = []
        per_group: dict[str, int] = {}
        for report in ranked:
            seat = report.seat
            if any(seat.is_adjacent_to(pick.report.seat) for pick in picks):
                continue
            group = seat.group_key
            if group is not None and per_group.get(group, 0) >= self.MAX_PER_GROUP:
                continue
            if group is not None:
                per_group[group] = per_group.get(group, 0) + 1
            picks.append(Recommendation(len(picks) + 1, report, strategy.utility(report, ctx),
                                        strategy.reasons(report, ctx)))
            if len(picks) == top_n:
                break

        return {
            "preset": strategy.describe(kind),
            "evaluated": len(reports),
            "recommendations": [pick.to_dict() for pick in picks],
            "note": None if picks else "Tidak ada tiket tersedia.",
        }
