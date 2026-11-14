"""
acoustics.py — Simulasi akustik berbasis jarak 3D.

Keluaran modul ini menyetir node Web Audio di browser:

* DelayNode        ← waktu rambat bunyi  t = d / c,  c = 331.3·√(1 + T/273.15)
* GainNode         ← redaman sebaran (hukum kuadrat terbalik / line array) + serapan udara
* BiquadFilterNode ← frekuensi tinggi lebih cepat diserap udara → low-pass makin rendah
* ConvolverNode    ← gaung: RT60 Sabine, jarak kritis, rasio direct-to-reverberant
* Delay gema       ← pantulan tribun seberang (metode sumber cermin)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from .geometry_3d import Vec3, angle_between_deg, clamp, euclidean_distance

REFERENCE_FREQ_HZ = 1000.0


# --------------------------------------------------------------------------- #
# Rumus fisika dasar
# --------------------------------------------------------------------------- #
def speed_of_sound(temperature_c: float) -> float:
    """Cepat rambat bunyi di udara (m/s) sebagai fungsi suhu."""
    return 331.3 * math.sqrt(1.0 + temperature_c / 273.15)


def propagation_delay_ms(distance_m: float, temperature_c: float = 20.0) -> float:
    return distance_m / speed_of_sound(temperature_c) * 1000.0


def air_absorption_db_per_m(freq_hz: float, humidity_pct: float = 60.0) -> float:
    """Serapan udara (dB/m), pendekatan sederhana ISO 9613-1: α ≈ 0.005·(f/1 kHz)^1.5.

    Udara lembap (Jakarta) menyerap sedikit lebih kecil daripada udara kering.
    """
    humidity_factor = clamp(1.25 - humidity_pct / 200.0, 0.75, 1.25)
    return 0.005 * (freq_hz / 1000.0) ** 1.5 * humidity_factor


def spreading_loss_db(
    distance_m: float,
    reference_m: float,
    line_length_m: float = 0.0,
    temperature_c: float = 20.0,
    freq_hz: float = REFERENCE_FREQ_HZ,
) -> float:
    """Redaman sebaran geometri relatif terhadap jarak acuan.

    * Sumber titik : 20·log10(d)  → −6 dB tiap jarak berlipat dua
    * Line array   : sampai jarak transisi d_c = L²·f / (2c) gelombangnya silindris
                     (10·log10(d) → −3 dB), setelah itu kembali −6 dB.
    """
    c = speed_of_sound(temperature_c)

    def level(d: float) -> float:
        d = max(d, 1.0)
        if line_length_m <= 0.0:
            return 20.0 * math.log10(d)
        transition = max(1.0, line_length_m ** 2 * freq_hz / (2.0 * c))
        if d <= transition:
            return 10.0 * math.log10(d)
        return 10.0 * math.log10(transition) + 20.0 * math.log10(d / transition)

    return level(distance_m) - level(reference_m)


def rt60_sabine(volume_m3: float, surface_m2: float, mean_absorption: float, air_m: float = 0.0) -> float:
    """Waktu dengung Sabine: RT60 = 0.161·V / (S·ᾱ + 4·m·V)."""
    absorption = surface_m2 * mean_absorption + 4.0 * air_m * volume_m3
    return 0.161 * volume_m3 / max(absorption, 1e-6)


def critical_distance(directivity_q: float, volume_m3: float, rt60_s: float) -> float:
    """Jarak kritis: titik di mana bunyi langsung = bunyi gaung. d_c = 0.057·√(Q·V / RT60)."""
    return 0.057 * math.sqrt(directivity_q * volume_m3 / max(rt60_s, 1e-6))


def lowpass_cutoff_hz(distance_m: float, humidity_pct: float = 60.0) -> float:
    """Frekuensi yang sudah teredam 6 dB oleh udara pada jarak ini (untuk BiquadFilter)."""
    per_m = air_absorption_db_per_m(1000.0, humidity_pct)
    cutoff = 1000.0 * (6.0 / (per_m * max(distance_m, 1.0))) ** (1.0 / 1.5)
    return clamp(cutoff, 1500.0, 20000.0)


# --------------------------------------------------------------------------- #
# Deskripsi ruang & sumber bunyi
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class AcousticEnvironment:
    name: str
    temperature_c: float
    humidity_pct: float
    volume_m3: float
    surface_m2: float
    mean_absorption: float
    source_spl_db: float                 # SPL satu sumber utama pada jarak acuan
    reference_distance_m: float
    directivity_q: float
    comfort_spl_db: tuple[float, float]  # rentang level nyaman
    reference_listening_spl_db: float    # level yang dipetakan ke gain 1.0
    wet_scale: float                     # seberapa terdengar gaung di Web Audio
    echo_plane_z: float | None = None    # bidang pantul dominan (tribun seberang)
    echo_absorption_db: float = 6.0


@dataclass(frozen=True)
class SpeakerSource:
    label: str
    position: Vec3
    line_length_m: float = 0.0           # 0 = sumber titik, >0 = line array
    level_offset_db: float = 0.0
    is_main: bool = True                 # menara delay di-time-align ke sumber utama
    aim: Vec3 | None = None              # arah pancar utama (None = ke segala arah)

    def off_axis_loss_db(self, listener: Vec3) -> float:
        """Speaker berarah: penuh sampai 60° dari sumbu, turun linear hingga −12 dB di ≥120°."""
        if self.aim is None:
            return 0.0
        angle = angle_between_deg(self.aim.horizontal(), (listener - self.position).horizontal())
        return clamp((angle - 60.0) / 60.0, 0.0, 1.0) * 12.0

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "position": self.position.to_list(),
            "line_length_m": self.line_length_m,
            "is_main": self.is_main,
        }


@dataclass(frozen=True)
class AcousticProfile:
    """Hasil simulasi untuk satu posisi pendengar."""

    distance_m: float
    delay_ms: float
    speed_of_sound_ms: float
    spl_db: float
    attenuation_db: float
    air_absorption_db: float
    lowpass_hz: float
    rt60_s: float
    critical_distance_m: float
    direct_to_reverb_db: float
    reverb_wet: float
    echo_delay_ms: float
    echo_gain: float
    gain: float
    dominant_source: str
    source_position: Vec3
    lip_sync: str
    loudness_note: str
    stereo_skew_ms: float = 0.0      # selisih waktu tiba antar speaker utama (0 = seimbang)

    def to_dict(self) -> dict:
        return {
            "distance_m": round(self.distance_m, 1),
            "delay_ms": round(self.delay_ms, 1),
            "stereo_skew_ms": round(self.stereo_skew_ms, 1),
            "speed_of_sound_ms": round(self.speed_of_sound_ms, 1),
            "spl_db": round(self.spl_db, 1),
            "attenuation_db": round(self.attenuation_db, 1),
            "air_absorption_db": round(self.air_absorption_db, 2),
            "lowpass_hz": round(self.lowpass_hz),
            "rt60_s": round(self.rt60_s, 2),
            "critical_distance_m": round(self.critical_distance_m, 1),
            "direct_to_reverb_db": round(self.direct_to_reverb_db, 1),
            "reverb_wet": round(self.reverb_wet, 3),
            "echo_delay_ms": round(self.echo_delay_ms, 1),
            "echo_gain": round(self.echo_gain, 3),
            "dominant_source": self.dominant_source,
            "lip_sync": self.lip_sync,
            "loudness_note": self.loudness_note,
            # Parameter siap pakai untuk node Web Audio (satuan detik / Hz / linear).
            "web_audio": {
                "delay_s": round(self.delay_ms / 1000.0, 4),
                "gain": round(self.gain, 3),
                "lowpass_hz": round(self.lowpass_hz),
                "reverb_wet": round(self.reverb_wet, 3),
                "reverb_rt60_s": round(self.rt60_s, 2),
                "echo_delay_s": round(self.echo_delay_ms / 1000.0, 4),
                "echo_gain": round(self.echo_gain, 3),
                "source_position": self.source_position.to_list(),
            },
        }


# --------------------------------------------------------------------------- #
# Simulator
# --------------------------------------------------------------------------- #
class AcousticSimulator:
    """Menghitung profil akustik satu titik dengar terhadap sekumpulan speaker."""

    HAAS_WINDOW_M = 15.0   # selisih lintasan < ±15 m (≈ 43 ms) menyatu dengan bunyi langsung

    def __init__(self, environment: AcousticEnvironment, sources: Sequence[SpeakerSource]) -> None:
        if not sources:
            raise ValueError("Minimal satu sumber bunyi diperlukan.")
        self.env = environment
        self.sources = tuple(sources)
        self.rt60 = rt60_sabine(environment.volume_m3, environment.surface_m2, environment.mean_absorption)
        self.critical = critical_distance(environment.directivity_q, environment.volume_m3, self.rt60)
        self.speed = speed_of_sound(environment.temperature_c)

    def _level_from(self, source: SpeakerSource, listener: Vec3, distance: float) -> float:
        env = self.env
        spreading = spreading_loss_db(distance, env.reference_distance_m, source.line_length_m, env.temperature_c)
        air = air_absorption_db_per_m(REFERENCE_FREQ_HZ, env.humidity_pct) * max(0.0, distance - env.reference_distance_m)
        return env.source_spl_db + source.level_offset_db - spreading - air - source.off_axis_loss_db(listener)

    @staticmethod
    def _lip_sync_label(delay_ms: float) -> str:
        """Ambang deteksi lag audio–video (ITU-R BT.1359): 45 / 125 / 185 ms."""
        if delay_ms <= 45.0:
            return "sinkron dengan gambar"
        if delay_ms <= 125.0:
            return "lag nyaris tak terasa"
        if delay_ms <= 185.0:
            return "lag mulai terasa"
        return "suara jelas terlambat dari gambar LED"

    def _loudness_note(self, spl: float) -> str:
        low, high = self.env.comfort_spl_db
        if spl > high + 3.0:
            return "sangat keras — disarankan memakai earplug"
        if spl > high:
            return "keras"
        if spl < low:
            return "agak pelan"
        return "nyaman"

    def profile(self, listener: Vec3) -> AcousticProfile:
        env = self.env
        distances = [max(1.0, euclidean_distance(listener, s.position)) for s in self.sources]
        levels = [self._level_from(s, listener, d) for s, d in zip(self.sources, distances)]

        # Penjumlahan energi semua speaker: L = 10·log10(Σ 10^(Li/10))
        spl = 10.0 * math.log10(sum(10.0 ** (level / 10.0) for level in levels))
        dominant_index = max(range(len(levels)), key=levels.__getitem__)
        dominant, dominant_distance = self.sources[dominant_index], distances[dominant_index]

        # Waktu tiba ditentukan muka gelombang sumber utama (menara delay di-align ke sana).
        main_pairs = [(d, s) for d, s in zip(distances, self.sources) if s.is_main] or list(zip(distances, self.sources))
        main_distance, main_source = min(main_pairs, key=lambda pair: pair[0])
        delay_ms = main_distance / self.speed * 1000.0
        farthest_main = max(pair[0] for pair in main_pairs)
        stereo_skew_ms = (farthest_main - main_distance) / self.speed * 1000.0

        direct_to_reverb = 20.0 * math.log10(self.critical / dominant_distance)
        reverb_wet = env.wet_scale / (1.0 + 10.0 ** (direct_to_reverb / 10.0))

        echo_delay_ms, echo_gain = 0.0, 0.0
        if env.echo_plane_z is not None:
            mirror = Vec3(main_source.position.x, main_source.position.y,
                          2.0 * env.echo_plane_z - main_source.position.z)
            path = euclidean_distance(listener, mirror)
            extra = path - main_distance
            if extra > self.HAAS_WINDOW_M:
                echo_delay_ms = extra / self.speed * 1000.0
                loss_db = 20.0 * math.log10(path / main_distance) + env.echo_absorption_db
                echo_gain = clamp(10.0 ** (-loss_db / 20.0), 0.0, 0.6)

        return AcousticProfile(
            distance_m=main_distance,
            delay_ms=delay_ms,
            speed_of_sound_ms=self.speed,
            spl_db=spl,
            attenuation_db=env.source_spl_db - spl,
            air_absorption_db=air_absorption_db_per_m(REFERENCE_FREQ_HZ, env.humidity_pct) * dominant_distance,
            lowpass_hz=lowpass_cutoff_hz(dominant_distance, env.humidity_pct),
            rt60_s=self.rt60,
            critical_distance_m=self.critical,
            direct_to_reverb_db=direct_to_reverb,
            reverb_wet=clamp(reverb_wet, 0.0, 1.0),
            echo_delay_ms=echo_delay_ms,
            echo_gain=echo_gain,
            gain=clamp(10.0 ** ((spl - env.reference_listening_spl_db) / 20.0), 0.2, 1.0),
            dominant_source=dominant.label,
            source_position=dominant.position,
            lip_sync=self._lip_sync_label(delay_ms),
            loudness_note=self._loudness_note(spl),
            stereo_skew_ms=stereo_skew_ms,
        )
