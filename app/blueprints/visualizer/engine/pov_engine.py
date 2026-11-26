"""
pov_engine.py — Orkestrator: (kursi, tinggi badan, target, lensa) → laporan POV lengkap.

Alur satu kali `evaluate()`:

    SeatNode ──► posisi mata (antropometri + postur)
            ├─► arah pandang ke setiap target (yaw, pitch, beban leher)
            ├─► cakupan FOV tiap layar/LED + uji terhalang pilar (ray casting)
            ├─► halangan kepala penonton depan / kerumunan
            ├─► profil akustik (delay, dB, low-pass, gaung, gema)
            └─► Sightline Score 0–100

Hasilnya `PovReport.to_dict()` — JSON yang langsung dipakai kamera Three.js,
node Web Audio, dan panel metrik. JavaScript tidak menghitung sudut apa pun.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Sequence

from .acoustics import AcousticProfile, AcousticSimulator
from .geometry_3d import (
    CameraLens, ScreenCoverage, Vec3, ViewAngles, angular_size_deg, clamp, compute_view,
    elevation_deg, lens_for, right_of, screen_coverage,
)
from .obstruction import (
    Anthropometry, FrontSpectator, ObstructionContext, ObstructionResult, Posture,
)
from .sightline_ai import (
    RoofProtection, SightlineMetrics, SightlineScore, SightlineScorer, assess_roof_protection,
)

if TYPE_CHECKING:
    from ..models.base_venue import ScreenSurface, SeatNode, TargetStage, Venue

POSTURE_LABELS = {
    Posture.SEATED: "duduk",
    Posture.RECLINED: "rebah di recliner",
    Posture.STANDING: "berdiri",
}


# --------------------------------------------------------------------------- #
# Struktur hasil
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SurfaceView:
    """Satu layar/LED dilihat dari satu kursi."""

    surface_id: str
    label: str
    area_m2: float
    visible_pct: float
    obliquity_deg: float
    faces_viewer: bool
    coverage: ScreenCoverage

    @property
    def legibility_pct(self) -> float:
        """Terlihat × √cos(kemiringan): layar yang dilihat sangat menyamping sulit dibaca."""
        if not self.faces_viewer:
            return 0.0
        cosine = max(0.0, math.cos(math.radians(min(self.obliquity_deg, 90.0))))
        return self.visible_pct * math.sqrt(cosine)

    def to_dict(self) -> dict:
        return {
            "id": self.surface_id,
            "label": self.label,
            "visible_pct": round(self.visible_pct, 1),
            "legibility_pct": round(self.legibility_pct, 1),
            "obliquity_deg": round(self.obliquity_deg, 1),
            "faces_viewer": self.faces_viewer,
            "coverage": self.coverage.to_dict(),
        }


@dataclass(frozen=True)
class TargetView:
    """Satu target (layar / panggung) dilihat dari satu kursi."""

    target_id: str
    label: str
    noun: str
    button_label: str
    view: ViewAngles
    off_axis_deg: float
    surfaces: tuple[SurfaceView, ...]
    stage_visible_pct: float

    @property
    def best_surface(self) -> SurfaceView | None:
        """Layar terbesar yang benar-benar terbaca (bukan yang dilihat dari belakang/tertutup)."""
        readable = [s for s in self.surfaces if s.legibility_pct > 0.0]
        return max(readable, key=lambda s: s.coverage.horizontal_deg * s.legibility_pct, default=None)

    @property
    def effective_fov_deg(self) -> float:
        """Lebar sudut layar terbaik setelah dikali keterbacaannya."""
        return max((s.coverage.horizontal_deg * s.legibility_pct / 100.0 for s in self.surfaces), default=0.0)

    @property
    def led_visible_pct(self) -> float | None:
        """Rata-rata keterbacaan LED berbobot luas permukaan."""
        total_area = sum(s.area_m2 for s in self.surfaces)
        if total_area <= 0.0:
            return None
        return sum(s.area_m2 * s.legibility_pct for s in self.surfaces) / total_area

    @property
    def visible_pct(self) -> float:
        led = self.led_visible_pct
        if led is None:
            return self.stage_visible_pct
        return 0.6 * led + 0.4 * self.stage_visible_pct

    def to_dict(self) -> dict:
        best = self.best_surface
        led = self.led_visible_pct
        return {
            "id": self.target_id,
            "label": self.label,
            "button_label": self.button_label,
            **self.view.to_dict(),
            "off_axis_deg": round(self.off_axis_deg, 1),
            "stage_visible_pct": round(self.stage_visible_pct, 1),
            "led_visible_pct": None if led is None else round(led, 1),
            "visible_pct": round(self.visible_pct, 1),
            "coverage": best.coverage.to_dict() if best else None,
            "surfaces": [s.to_dict() for s in self.surfaces],
        }


@dataclass(frozen=True)
class PovReport:
    """Laporan POV lengkap untuk satu kursi."""

    venue_id: str
    venue_name: str
    seat: "SeatNode"
    viewer: Anthropometry
    front: Anthropometry
    eye: Vec3
    lens: CameraLens
    aspect: float
    targets: dict[str, TargetView]
    primary_id: str
    active_id: str
    obstruction: ObstructionResult
    primary_obstruction: ObstructionResult
    front_spectator: FrontSpectator | None
    acoustics: AcousticProfile
    metrics: SightlineMetrics
    score: SightlineScore
    reference_photos: tuple[dict, ...]
    compute_ms: float
    roof_protection: RoofProtection | None = None

    @property
    def primary(self) -> TargetView:
        return self.targets[self.primary_id]

    @property
    def active(self) -> TargetView:
        return self.targets[self.active_id]

    @property
    def eye_height_m(self) -> float:
        return self.eye.y - self.seat.floor_position.y

    @property
    def clear_view_pct(self) -> float:
        """Bagian pandangan ke target aktif yang bebas halangan (untuk bar & baterai "Bebas Halangan").

        Diambil yang terburuk dari tiga sumber: kepala penonton di depan, struktur yang menutup
        area panggung, dan struktur yang menutup LED yang menghadap penonton (dirata-rata).
        """
        active = self.active
        parts = [100.0 - self.obstruction.blocked_height_pct, active.stage_visible_pct]
        facing = [s.visible_pct for s in active.surfaces if s.faces_viewer]
        if facing:
            parts.append(sum(facing) / len(facing))
        return clamp(min(parts), 0.0, 100.0)

    def summary(self) -> dict:
        """Versi ringkas untuk heatmap, rekomendasi, dan keranjang."""
        return {
            "venue_id": self.venue_id,
            "seat_id": self.seat.seat_id,
            "label": self.seat.label,
            "category": self.seat.category,
            "price": self.seat.price,
            "score": round(self.score.total, 1),
            "grade": self.score.grade,
            "distance_m": round(self.metrics.distance_m, 1),
            "h_fov_deg": round(self.metrics.h_fov_deg, 1),
            "neck_pitch_deg": round(self.metrics.neck_pitch_deg, 1),
            "neck_yaw_deg": round(self.metrics.neck_yaw_deg, 1),
            "obstruction_pct": round(self.primary_obstruction.blocked_height_pct, 1),
            "visible_pct": round(self.metrics.visible_pct, 1),
            "audio_delay_ms": round(self.acoustics.delay_ms, 1),
            "spl_db": round(self.acoustics.spl_db, 1),
            "floor": self.seat.floor_position.to_list(),
        }

    def to_dict(self) -> dict:
        seat, active = self.seat, self.active
        facing = seat.facing
        return {
            "computed_by": "python",
            "compute_ms": round(self.compute_ms, 2),
            "venue_id": self.venue_id,
            "venue_name": self.venue_name,
            "seat": seat.to_dict(),
            "seat_frame": {
                "origin": seat.floor_position.to_list(),
                "facing": facing.to_list(4),
                "right": right_of(facing).to_list(4),
                **seat.frame_dict(),
            },
            "viewer": {
                "body_height_cm": self.viewer.stature_cm,
                "front_height_cm": self.front.stature_cm,
                "eye_height_m": round(self.eye_height_m, 3),
                "posture": seat.posture.value,
                "posture_label": POSTURE_LABELS[seat.posture],
                "recline_deg": seat.recline_deg,
            },
            "eye": self.eye.to_list(),
            "camera": {
                "position": self.eye.to_list(),
                "look_at": active.view.look_at.to_list(),
                "yaw_rad": round(active.view.yaw_rad, 5),
                "pitch_rad": round(active.view.pitch_rad, 5),
                "roll_rad": 0.0,
                "fov_deg": round(self.lens.vertical_fov_deg, 2),
                "horizontal_fov_deg": round(self.lens.horizontal_fov_deg(self.aspect), 2),
                "near": 0.1,
                "far": 1500.0,
                "lens": self.lens.to_dict(),
            },
            "active_target": self.active_id,
            "primary_target": self.primary_id,
            "targets": {tid: tv.to_dict() for tid, tv in self.targets.items()},
            "obstruction": self.obstruction.to_dict(),
            "clear_view_pct": round(self.clear_view_pct, 1),
            "front_spectator": self.front_spectator.to_dict() if self.front_spectator else {"present": False},
            "acoustics": self.acoustics.to_dict(),
            "score": self.score.to_dict(),
            "reference_photos": list(self.reference_photos),
            "roof_protection": self.roof_protection.to_dict() if self.roof_protection else None,
            "summary": self.summary(),
        }


# --------------------------------------------------------------------------- #
# Mesin
# --------------------------------------------------------------------------- #
class PovEngine:
    """Satu instance per venue; menyimpan cache hasil agar heatmap & rekomendasi cepat."""

    CACHE_LIMIT = 8_000  # clear-on-full; cukup untuk satu heatmap studio, menahan RAM tetap kecil

    def __init__(self, venue: "Venue") -> None:
        self.venue = venue
        self.scorer = SightlineScorer(venue.scoring_profile())
        self.acoustics = AcousticSimulator(venue.acoustic_environment(), venue.speaker_sources())
        self._boxes = [occluder.box for occluder in venue.occluders()]
        self._panels = [s for target in venue.targets() for s in target.surfaces() if s.is_flat]
        self._cache: dict[tuple, PovReport] = {}

    # --- uji garis pandang ---------------------------------------------------
    def _segment_clear(self, a: Vec3, b: Vec3, skip_surface_id: str | None = None) -> bool:
        """True bila ruas a→b tidak menabrak kotak penghalang maupun panel LED lain."""
        for box in self._boxes:
            if box.segment_hits(a, b):
                return False
        for panel in self._panels:
            if panel.surface_id != skip_surface_id and panel.blocks_segment(a, b):
                return False
        return True

    def _points_visible_pct(self, eye: Vec3, points: Sequence[Vec3], skip_surface_id: str | None = None) -> float:
        if not points:
            return 100.0
        if not self._boxes and len(self._panels) <= 1:
            return 100.0      # venue tanpa penghalang (bioskop)
        clear = sum(1 for p in points if self._segment_clear(eye, p, skip_surface_id))
        return 100.0 * clear / len(points)

    def _surface_view(self, eye: Vec3, surface: "ScreenSurface", lens: CameraLens, aspect: float) -> SurfaceView:
        edges = surface.edges()
        coverage = screen_coverage(
            eye, left=edges["left"], right=edges["right"], top=edges["top"], bottom=edges["bottom"],
            center=surface.center, normal=surface.normal, width=surface.width, height=surface.height,
            lens_h_fov_deg=lens.horizontal_fov_deg(aspect), lens_v_fov_deg=lens.vertical_fov_deg,
        )
        faces = surface.faces(eye)
        visible = self._points_visible_pct(eye, surface.sample_points(), surface.surface_id) if faces else 0.0
        return SurfaceView(surface.surface_id, surface.label, surface.area, visible,
                           surface.obliquity_deg(eye), faces, coverage)

    def _target_view(self, eye: Vec3, seat: "SeatNode", target: "TargetStage",
                     lens: CameraLens, aspect: float) -> TargetView:
        view = compute_view(eye, target.focus_point, seat.facing,
                            free_orientation=seat.free_orientation, recline_deg=seat.recline_deg)
        surfaces = tuple(self._surface_view(eye, s, lens, aspect) for s in target.surfaces())
        return TargetView(
            target_id=target.target_id, label=target.label, noun=target.noun,
            button_label=target.button_label, view=view, off_axis_deg=target.off_axis_deg(eye),
            surfaces=surfaces,
            stage_visible_pct=self._points_visible_pct(eye, target.performance_points()),
        )

    # --- halangan ------------------------------------------------------------
    def _obstruction(self, seat: "SeatNode", eye: Vec3, viewer: Anthropometry, front: Anthropometry,
                     target: "TargetStage") -> tuple[ObstructionResult, FrontSpectator | None]:
        model = self.venue.obstruction_model(seat)
        bottom, top = target.sightline_span()
        neighbor = seat.front_neighbor()
        ctx = ObstructionContext(
            eye=eye, viewer_floor=seat.floor_position, viewer_facing=seat.facing,
            viewer=viewer, front=front,
            target_bottom=bottom, target_top=top, target_width_m=target.extent_width,
            target_label=target.noun,
            front_floor=neighbor.floor if neighbor else None,
            front_posture=neighbor.posture if neighbor else Posture.SEATED,
            front_seat_height_m=neighbor.seat_height_m if neighbor else seat.seat_height_m,
            front_recline_deg=neighbor.recline_deg if neighbor else 0.0,
            has_subtitles=target.has_subtitles,
            crowd_clear_zone_m=target.crowd_clear_zone_m,
        )
        return model.evaluate(ctx), model.front_spectator(ctx)

    # --- API utama -----------------------------------------------------------
    def evaluate(self, seat: "SeatNode", body_height_cm: object = 170.0, front_height_cm: object = 170.0,
                 target_id: str | None = None, lens_mode: str | None = None,
                 aspect: float = 16.0 / 9.0) -> PovReport:
        viewer = Anthropometry.from_cm(body_height_cm)
        front = Anthropometry.from_cm(front_height_cm)
        lens = lens_for(lens_mode, self.venue.LENS_BASE_FOV_DEG)
        active_target = self.venue.target(target_id)
        primary_target = self.venue.primary_target
        aspect = round(clamp(float(aspect), 0.4, 4.0), 2)

        key = (seat.seat_id, viewer.stature_cm, front.stature_cm, active_target.target_id, lens.mode, aspect)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        started = time.perf_counter()
        eye = seat.eye_position(viewer)
        targets = {t.target_id: self._target_view(eye, seat, t, lens, aspect) for t in self.venue.targets()}

        primary_obstruction, primary_front = self._obstruction(seat, eye, viewer, front, primary_target)
        if active_target is primary_target:
            obstruction, front_spectator = primary_obstruction, primary_front
        else:
            obstruction, front_spectator = self._obstruction(seat, eye, viewer, front, active_target)

        acoustics = self.acoustics.profile(eye)
        primary_view = targets[primary_target.target_id]
        best = primary_view.best_surface
        if best is not None:
            h_fov, top_edge = best.coverage.horizontal_deg, best.coverage.top_edge_deg
        else:   # tidak ada layar yang terbaca dari kursi ini
            h_fov = 0.0 if primary_view.surfaces else angular_size_deg(
                primary_target.extent_width, primary_view.view.distance_m)
            top_edge = elevation_deg(eye, primary_target.sightline_span()[1])
        metrics = SightlineMetrics(
            h_fov_deg=h_fov,
            effective_fov_deg=primary_view.effective_fov_deg if primary_view.surfaces else h_fov,
            top_edge_deg=top_edge,
            neck_pitch_deg=primary_view.view.neck_pitch_deg,
            neck_yaw_deg=primary_view.view.neck_yaw_deg,
            off_axis_deg=primary_view.off_axis_deg,
            obstruction_impact_pct=primary_obstruction.impact_pct,
            visible_pct=primary_view.visible_pct,
            distance_m=primary_view.view.distance_m,
            acoustics=acoustics,
        )
        report = PovReport(
            venue_id=self.venue.venue_id, venue_name=self.venue.name, seat=seat,
            viewer=viewer, front=front, eye=eye, lens=lens, aspect=aspect,
            targets=targets, primary_id=primary_target.target_id, active_id=active_target.target_id,
            obstruction=obstruction, primary_obstruction=primary_obstruction,
            front_spectator=front_spectator, acoustics=acoustics, metrics=metrics,
            score=self.scorer.score(metrics),
            reference_photos=tuple(self.venue.reference_photos(seat)),
            compute_ms=(time.perf_counter() - started) * 1000.0,
            roof_protection=assess_roof_protection(seat, getattr(self.venue, "BOWL", None)),
        )
        if len(self._cache) >= self.CACHE_LIMIT:
            self._cache.clear()
        self._cache[key] = report
        return report

    def heatmap(self, body_height_cm: object = 170.0, front_height_cm: object = 170.0) -> list[dict]:
        """Skor semua kursi kandidat (untuk mewarnai peta 2D)."""
        return [
            {"seat_id": r.seat.seat_id, "score": round(r.score.total, 1), "grade": r.score.grade,
             "group": r.seat.group_key}
            for r in (self.evaluate(seat, body_height_cm, front_height_cm)
                      for seat in self.venue.candidate_seats())
        ]


@lru_cache(maxsize=None)
def engine_for(venue_id: str) -> PovEngine:
    """Satu PovEngine per venue (lazy singleton)."""
    from ..models import get_venue   # impor lokal: models bergantung pada paket engine

    return PovEngine(get_venue(venue_id))
