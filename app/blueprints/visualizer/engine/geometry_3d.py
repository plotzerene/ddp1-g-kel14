"""
geometry_3d.py — Mesin vektor & trigonometri 3D (murni Python, tanpa NumPy).

Semua sudut kamera yang dipakai Three.js dihitung DI SINI, bukan di JavaScript.

Konvensi dunia (sengaja disamakan dengan Three.js supaya angka Python bisa
langsung dipasang ke kamera WebGL):

* satuan meter, sumbu Y ke atas, sistem tangan-kanan
* Bioskop : layar di bidang z = 0 menghadap +z, penonton duduk di z > 0
* Stadion : (0, 0, 0) = tengah lapangan, Utara (panggung utama) = -z, Timur = +x
* yaw     : rotasi terhadap sumbu Y. 0 rad = memandang ke -z, positif = menoleh ke kiri
* pitch   : positif = mendongak, negatif = menunduk
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import ClassVar, Iterator

EPS = 1e-9


# --------------------------------------------------------------------------- #
# Vektor 3D
# --------------------------------------------------------------------------- #
@dataclass(frozen=True, slots=True)
class Vec3:
    """Vektor/titik 3D immutable dengan operator aritmetika."""

    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def __mul__(self, k: float) -> "Vec3":
        return Vec3(self.x * k, self.y * k, self.z * k)

    def __rmul__(self, k: float) -> "Vec3":
        return self.__mul__(k)

    def __neg__(self) -> "Vec3":
        return Vec3(-self.x, -self.y, -self.z)

    def __iter__(self) -> Iterator[float]:
        yield self.x
        yield self.y
        yield self.z

    def dot(self, other: "Vec3") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def cross(self, other: "Vec3") -> "Vec3":
        return Vec3(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )

    def length(self) -> float:
        return math.sqrt(self.dot(self))

    def normalized(self) -> "Vec3":
        n = self.length()
        return Vec3(0.0, 0.0, 0.0) if n < EPS else Vec3(self.x / n, self.y / n, self.z / n)

    def horizontal(self) -> "Vec3":
        """Proyeksi ke bidang lantai (y = 0)."""
        return Vec3(self.x, 0.0, self.z)

    def distance_to(self, other: "Vec3") -> float:
        return (self - other).length()

    def horizontal_distance_to(self, other: "Vec3") -> float:
        return math.hypot(self.x - other.x, self.z - other.z)

    def lerp(self, other: "Vec3", t: float) -> "Vec3":
        return Vec3(
            self.x + (other.x - self.x) * t,
            self.y + (other.y - self.y) * t,
            self.z + (other.z - self.z) * t,
        )

    def with_y(self, y: float) -> "Vec3":
        return Vec3(self.x, y, self.z)

    def to_list(self, ndigits: int = 3) -> list[float]:
        return [round(self.x, ndigits), round(self.y, ndigits), round(self.z, ndigits)]


UP = Vec3(0.0, 1.0, 0.0)


# --------------------------------------------------------------------------- #
# Fungsi dasar
# --------------------------------------------------------------------------- #
def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def euclidean_distance(a: Vec3, b: Vec3) -> float:
    """Jarak Euclidean 3D: sqrt(dx² + dy² + dz²)."""
    return math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)


def angle_between_deg(u: Vec3, v: Vec3) -> float:
    """Sudut terkecil antara dua vektor (derajat) lewat hasil kali titik."""
    lu, lv = u.length(), v.length()
    if lu < EPS or lv < EPS:
        return 0.0
    return math.degrees(math.acos(clamp(u.dot(v) / (lu * lv), -1.0, 1.0)))


def yaw_pitch_between(eye: Vec3, target: Vec3) -> tuple[float, float]:
    """Yaw & pitch (radian) agar kamera di `eye` menatap `target`."""
    d = target - eye
    yaw = math.atan2(-d.x, -d.z)
    pitch = math.atan2(d.y, math.hypot(d.x, d.z))
    return yaw, pitch


def direction_from_yaw_pitch(yaw: float, pitch: float) -> Vec3:
    """Kebalikan `yaw_pitch_between`: vektor arah pandang satuan."""
    cp = math.cos(pitch)
    return Vec3(-math.sin(yaw) * cp, math.sin(pitch), -math.cos(yaw) * cp)


def right_of(facing: Vec3) -> Vec3:
    """Vektor 'kanan' horizontal untuk seseorang yang menghadap `facing`."""
    f = facing.horizontal().normalized()
    return Vec3(-f.z, 0.0, f.x)


def signed_yaw_offset_deg(facing: Vec3, to_target: Vec3) -> float:
    """Berapa derajat kepala harus menoleh dari arah hadap kursi (+ = ke kanan)."""
    f = facing.horizontal().normalized()
    t = to_target.horizontal().normalized()
    if f.length() < EPS or t.length() < EPS:
        return 0.0
    return math.degrees(math.atan2(t.dot(right_of(f)), t.dot(f)))


def angular_size_deg(extent_m: float, distance_m: float) -> float:
    """Sudut yang ditempati benda selebar `extent_m` pada jarak `distance_m`."""
    if distance_m < EPS:
        return 180.0
    return math.degrees(2.0 * math.atan(extent_m / (2.0 * distance_m)))


def subtended_angle_deg(eye: Vec3, p1: Vec3, p2: Vec3) -> float:
    """Sudut di mata antara dua titik (mis. tepi kiri & kanan layar)."""
    return angle_between_deg(p1 - eye, p2 - eye)


def elevation_deg(eye: Vec3, point: Vec3) -> float:
    """Sudut elevasi titik terhadap garis mata horizontal (+ = di atas mata)."""
    return math.degrees(math.atan2(point.y - eye.y, eye.horizontal_distance_to(point)))


# --------------------------------------------------------------------------- #
# Kotak penghalang (pilar panggung, menara delay, dsb.)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True, slots=True)
class AABB:
    """Axis-Aligned Bounding Box untuk uji garis pandang."""

    min: Vec3
    max: Vec3

    def segment_hits(self, a: Vec3, b: Vec3) -> bool:
        """Uji potong ruas garis a→b terhadap kotak (metode slab)."""
        t0, t1 = 0.0, 1.0
        for start, delta, lo, hi in (
            (a.x, b.x - a.x, self.min.x, self.max.x),
            (a.y, b.y - a.y, self.min.y, self.max.y),
            (a.z, b.z - a.z, self.min.z, self.max.z),
        ):
            if abs(delta) < EPS:
                if start < lo or start > hi:
                    return False
                continue
            ta, tb = (lo - start) / delta, (hi - start) / delta
            if ta > tb:
                ta, tb = tb, ta
            t0, t1 = max(t0, ta), min(t1, tb)
            if t0 > t1:
                return False
        return True

    @property
    def center(self) -> Vec3:
        return self.min.lerp(self.max, 0.5)

    @property
    def size(self) -> Vec3:
        return self.max - self.min


# --------------------------------------------------------------------------- #
# Lensa kamera (FOV dihitung Python, bukan di-hardcode di JS)
# --------------------------------------------------------------------------- #
class LensMode(str, Enum):
    NORMAL = "normal"
    WIDE = "wide"
    ZOOM = "zoom"


@dataclass(frozen=True)
class CameraLens:
    """FOV vertikal diturunkan dari faktor zoom: fov = 2·atan(tan(fov₀/2) / zoom).

    `base_fov_deg` = FOV "mata normal" (zoom 1×). Bawaannya 55°; bioskop memakai 68° (rentang
    realistis 65–70° untuk pandangan menatap layar lebar) lewat `Venue.LENS_BASE_FOV_DEG`.
    """

    mode: LensMode
    label: str
    zoom_factor: float
    base_fov_deg: float = 55.0

    BASE_VERTICAL_FOV_DEG: ClassVar[float] = 55.0

    @property
    def vertical_fov_deg(self) -> float:
        half = math.radians(self.base_fov_deg / 2.0)
        return math.degrees(2.0 * math.atan(math.tan(half) / self.zoom_factor))

    def horizontal_fov_deg(self, aspect: float) -> float:
        half_v = math.radians(self.vertical_fov_deg / 2.0)
        return math.degrees(2.0 * math.atan(math.tan(half_v) * aspect))

    def to_dict(self) -> dict:
        return {
            "mode": self.mode.value,
            "label": self.label,
            "zoom_factor": self.zoom_factor,
            "vertical_fov_deg": round(self.vertical_fov_deg, 2),
        }


LENSES: dict[LensMode, CameraLens] = {
    LensMode.NORMAL: CameraLens(LensMode.NORMAL, "Mata Normal 55°", 1.0),
    LensMode.WIDE: CameraLens(LensMode.WIDE, "Wide 0.5x HP", 0.5),
    LensMode.ZOOM: CameraLens(LensMode.ZOOM, "Zoom 2x", 2.0),
}


def lens_set(base_fov_deg: float | None = None) -> dict[LensMode, CameraLens]:
    """Daftar lensa untuk satu venue; `None`/55° = bawaan (`LENSES`)."""
    if base_fov_deg is None or abs(base_fov_deg - CameraLens.BASE_VERTICAL_FOV_DEG) < 1e-9:
        return LENSES
    return {
        mode: CameraLens(
            mode,
            f"Mata Normal {base_fov_deg:g}°" if mode is LensMode.NORMAL else lens.label,
            lens.zoom_factor,
            base_fov_deg,
        )
        for mode, lens in LENSES.items()
    }


def lens_for(mode: str | LensMode | None, base_fov_deg: float | None = None) -> CameraLens:
    lenses = lens_set(base_fov_deg)
    try:
        return lenses[LensMode(mode)] if mode else lenses[LensMode.NORMAL]
    except ValueError:
        return lenses[LensMode.NORMAL]


# --------------------------------------------------------------------------- #
# Hasil perhitungan arah pandang
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ViewAngles:
    """Arah pandang dari mata ke satu titik fokus."""

    distance_m: float
    horizontal_distance_m: float
    yaw_rad: float
    pitch_rad: float
    neck_yaw_deg: float
    neck_pitch_deg: float
    look_at: Vec3

    def to_dict(self) -> dict:
        return {
            "distance_m": round(self.distance_m, 2),
            "horizontal_distance_m": round(self.horizontal_distance_m, 2),
            "yaw_rad": round(self.yaw_rad, 5),
            "pitch_rad": round(self.pitch_rad, 5),
            "yaw_deg": round(math.degrees(self.yaw_rad), 2),
            "pitch_deg": round(math.degrees(self.pitch_rad), 2),
            "neck_yaw_deg": round(self.neck_yaw_deg, 2),
            "neck_pitch_deg": round(self.neck_pitch_deg, 2),
            "look_at": self.look_at.to_list(),
        }


def compute_view(
    eye: Vec3,
    target: Vec3,
    facing: Vec3,
    *,
    free_orientation: bool = False,
    recline_deg: float = 0.0,
) -> ViewAngles:
    """Hitung yaw/pitch kamera + beban leher relatif arah hadap kursi.

    * `free_orientation` True untuk penonton berdiri (badan bebas berputar → leher 0°).
    * Sandaran rebah menopang kepala, jadi separuh sudut rebah mengurangi dongakan leher.
    """
    yaw, pitch = yaw_pitch_between(eye, target)
    neck_yaw = 0.0 if free_orientation else signed_yaw_offset_deg(facing, target - eye)
    neck_pitch = math.degrees(pitch) - 0.5 * recline_deg
    return ViewAngles(
        distance_m=euclidean_distance(eye, target),
        horizontal_distance_m=eye.horizontal_distance_to(target),
        yaw_rad=yaw,
        pitch_rad=pitch,
        neck_yaw_deg=neck_yaw,
        neck_pitch_deg=neck_pitch,
        look_at=target,
    )


@dataclass(frozen=True)
class ScreenCoverage:
    """Seberapa besar layar/LED memenuhi medan pandang."""

    horizontal_deg: float
    vertical_deg: float
    top_edge_deg: float
    bottom_edge_deg: float
    center_elevation_deg: float
    off_axis_deg: float
    fov_fill_h_pct: float
    fov_fill_v_pct: float
    frame_fill_pct: float
    distance_in_heights: float
    distance_in_widths: float

    def to_dict(self) -> dict:
        return {k: round(getattr(self, k), 2) for k in self.__dataclass_fields__}


def screen_coverage(
    eye: Vec3,
    *,
    left: Vec3,
    right: Vec3,
    top: Vec3,
    bottom: Vec3,
    center: Vec3,
    normal: Vec3,
    width: float,
    height: float,
    lens_h_fov_deg: float,
    lens_v_fov_deg: float,
) -> ScreenCoverage:
    """Cakupan FOV layar dari titik mata.

    Sudut horizontal/vertikal diukur dari vektor ke tepi layar yang sebenarnya,
    jadi kursi pinggir otomatis mendapat sudut yang lebih sempit (foreshortening).
    """
    h_deg = subtended_angle_deg(eye, left, right)
    v_deg = subtended_angle_deg(eye, bottom, top)
    distance = euclidean_distance(eye, center)
    off_axis = angle_between_deg(normal.horizontal(), (eye - center).horizontal())
    fill_h = clamp(h_deg / lens_h_fov_deg * 100.0, 0.0, 100.0)
    fill_v = clamp(v_deg / lens_v_fov_deg * 100.0, 0.0, 100.0)
    return ScreenCoverage(
        horizontal_deg=h_deg,
        vertical_deg=v_deg,
        top_edge_deg=elevation_deg(eye, top),
        bottom_edge_deg=elevation_deg(eye, bottom),
        center_elevation_deg=elevation_deg(eye, center),
        off_axis_deg=off_axis,
        fov_fill_h_pct=fill_h,
        fov_fill_v_pct=fill_v,
        frame_fill_pct=fill_h * fill_v / 100.0,
        distance_in_heights=distance / height if height > EPS else 0.0,
        distance_in_widths=distance / width if width > EPS else 0.0,
    )
