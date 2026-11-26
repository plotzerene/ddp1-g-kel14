"""
assets_sync.py — Menyalin `./reference_assets/` ke `./app/static/reference_assets/`.

Dipanggil otomatis saat aplikasi start, jadi teman satu tim cukup `git pull` lalu
`python run.py`. Nama file dinormalkan supaya URL-nya stabil:

    "trailer_cinema AVENGERS ENDGAME.mp4"  →  videos/trailer_cinema.mp4
    "gbk_coldplay_cat8_side_pov.jpeg"      →  images/gbk_coldplay_cat8_side_pov.jpg
    "Poster Avengers ENDGAME.jpeg"         →  images/poster_avengers_endgame.jpg

Bila sebuah file tidak ada, `asset_url()` mengembalikan None dan frontend memakai
fallback (video prosedural / placeholder foto).
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
SOURCE_DIR = APP_DIR.parent / "reference_assets"
STATIC_ASSET_DIR = APP_DIR / "static" / "reference_assets"
ASSET_URL_PREFIX = "/static/reference_assets"
ALLOWED_SUFFIXES = {".jpg", ".png", ".webp", ".mp4", ".webm"}
# Ekspor kanvas desain (4 MB) hanya acuan visual; tidak dilayani web.
DESIGN_ONLY = {"page1_final_canvas.png"}

# Nama baku yang diminta brief proyek; varian bernama lebih panjang dipetakan ke sini.
CANONICAL_NAMES: tuple[str, ...] = (
    "images/gbk_coldplay_seating_map.jpg",
    "images/gbk_coldplay_stage_full.jpg",
    "images/gbk_coldplay_festival_pov.jpg",
    "images/gbk_coldplay_cat8_side_pov.jpg",
    "images/xxi_regular_studio.jpg",
    "images/xxi_the_premiere.jpg",
    "images/xxi_imax_studio.jpg",
    "images/xxi_4dx_seats.jpg",
    "videos/trailer_cinema.mp4",
    "videos/coldplay_live.mp4",
)


@dataclass
class SyncReport:
    source_found: bool
    copied: list[str] = field(default_factory=list)
    unchanged: int = 0
    missing: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if not self.source_found:
            return "Folder reference_assets/ tidak ditemukan — memakai fallback prosedural."
        text = f"Aset referensi: {len(self.copied)} disalin, {self.unchanged} sudah terbaru"
        if self.missing:
            text += f", {len(self.missing)} belum ada ({', '.join(self.missing)})"
        return text + "."


def normalize_name(filename: str) -> str:
    """Huruf kecil, spasi/simbol → garis bawah, .jpeg → .jpg."""
    path = Path(filename)
    suffix = path.suffix.lower()
    if suffix == ".jpeg":
        suffix = ".jpg"
    stem = re.sub(r"[^a-z0-9]+", "_", path.stem.lower()).strip("_")
    return f"{stem}{suffix}"


def plan_sync(source_dir: Path = SOURCE_DIR) -> dict[Path, str]:
    """Petakan tiap file sumber ke path tujuan relatif (mis. 'videos/trailer_cinema.mp4')."""
    plan: dict[Path, str] = {}
    # File langsung di root (mis. person_silhouette_clean.png) ikut disalin ke root static.
    for path in sorted(p for p in source_dir.iterdir() if p.is_file() and not p.name.startswith(".")):
        name = normalize_name(path.name)
        if Path(name).suffix in ALLOWED_SUFFIXES and name not in DESIGN_ONLY:
            plan[path] = name
    for folder in sorted(p for p in source_dir.iterdir() if p.is_dir()):
        files = sorted(p for p in folder.iterdir() if p.is_file() and not p.name.startswith("."))
        names = {path: normalize_name(path.name) for path in files}
        names = {path: name for path, name in names.items() if Path(name).suffix in ALLOWED_SUFFIXES}
        taken = set(names.values())
        for canonical in (c for c in CANONICAL_NAMES if c.startswith(folder.name + "/")):
            base = Path(canonical).name
            if base in taken:
                continue
            stem, suffix = Path(base).stem, Path(base).suffix
            # Varian seperti "trailer_cinema_avengers_endgame.mp4" → nama baku.
            match = next((path for path, name in names.items()
                          if name.startswith(stem + "_") and name.endswith(suffix)), None)
            if match is not None:
                names[match] = base
                taken.add(base)
        for path, name in names.items():
            plan[path] = f"{folder.name}/{name}"
    return plan


def sync_reference_assets(source_dir: Path = SOURCE_DIR, target_dir: Path = STATIC_ASSET_DIR) -> SyncReport:
    """Salin file yang baru/berubah saja (dibandingkan ukuran & waktu modifikasi)."""
    if not source_dir.is_dir():
        return SyncReport(source_found=False, missing=list(CANONICAL_NAMES))
    report = SyncReport(source_found=True)
    for source, relative in plan_sync(source_dir).items():
        target = target_dir / relative
        stat = source.stat()
        if target.is_file() and target.stat().st_size == stat.st_size and target.stat().st_mtime >= stat.st_mtime:
            report.unchanged += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        report.copied.append(relative)
    report.missing = [name for name in CANONICAL_NAMES if not (target_dir / name).is_file()]
    return report


POSTER_FALLBACK_REL = "images/posters/poster_fallback.svg"


def asset_exists(relative: str) -> bool:
    if not relative:
        return False
    return (
        (STATIC_ASSET_DIR / relative).is_file()
        or (APP_DIR / "static" / relative).is_file()
    )


def asset_url(relative: str) -> str | None:
    """URL statis sebuah aset, atau None bila filenya tidak ada."""
    if not relative:
        return None
    if (STATIC_ASSET_DIR / relative).is_file():
        return f"{ASSET_URL_PREFIX}/{relative}"
    if (APP_DIR / "static" / relative).is_file():
        return f"/static/{relative}"
    return None


def photo_entry(relative: str, caption: str) -> dict:
    """Entri foto pembanding untuk fitur 'Bandingkan dengan Foto Asli'."""
    url = asset_url(relative)
    return {"file": relative, "caption": caption, "url": url, "missing": url is None}
