"""Tes struktur video promo Remotion (tanpa render): registrasi komposisi, linimasa 7 adegan, dan aturan istilah."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROMO = ROOT / "promo_video"
SRC = PROMO / "src"
SCENES = SRC / "TitiketPromo/scenes"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class PromoVideoTests(unittest.TestCase):
    def test_root_registers_titiket_promo_composition(self):
        root = read(SRC / "Root.tsx")
        self.assertIn('id="TitiketPromo"', root)
        self.assertIn("component={TitiketPromoMain}", root)
        self.assertIn('import "../../app/static/css/liquid_glass.css";', root)
        timeline = read(SRC / "TitiketPromo/timeline.ts")
        for name, value in (("FPS", 60), ("WIDTH", 1920), ("HEIGHT", 1080), ("DURATION_IN_FRAMES", 1200)):
            with self.subTest(constant=name):
                self.assertIn(f"export const {name} = {value};", timeline)

    def test_seven_scenes_fill_timeline_without_gaps(self):
        timeline = read(SRC / "TitiketPromo/timeline.ts")
        spans = [(int(a), int(b)) for a, b in re.findall(r"from: (\d+), durationInFrames: (\d+)", timeline)]
        self.assertEqual(spans, [(0, 180), (180, 180), (360, 240), (600, 240), (840, 180), (1020, 120), (1140, 60)])
        for (start, length), (next_start, _) in zip(spans, spans[1:]):
            self.assertEqual(start + length, next_start)
        self.assertEqual(spans[-1][0] + spans[-1][1], 1200)

    def test_global_font_stack(self):
        css = read(SRC / "styles/global.css")
        self.assertIn('font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;', css)

    def test_standing_area_scenes_never_say_kursi(self):
        components = SRC / "TitiketPromo/components"
        for path in (SCENES / "Scene5ConcertViewport.tsx", SCENES / "Scene6BoardingPass.tsx",
                     components / "StageMusicians.tsx", components / "BoardingPassCard.tsx"):
            with self.subTest(file=path.name):
                self.assertNotIn("kursi", read(path).lower())
        concert = read(SCENES / "Scene5ConcertViewport.tsx")
        for text in ("Festival · Spot 3 (Tengah Lapangan)", "Bebas Berdiri", "Jarak Panggung: 28 m", "Rp 3,5 jt"):
            self.assertIn(text, concert)

    def test_cinema_hud_copy(self):
        cinema = read(SCENES / "Scene4CinemaViewport.tsx")
        for text in ("Baris F · Kursi 15", "Sempurna", "PANDANGAN LAYAR", "KEMIRINGAN LEHER", "JARAK PANDANG"):
            self.assertIn(text, cinema)
        self.assertNotIn("Duduk Bernomor", cinema)
        self.assertIn("stroke={EMERALD}", cinema)
        self.assertIn('EMERALD = "#15803D"', read(SRC / "TitiketPromo/components/LightGlass.ts"))

    def test_logo_capsule_matches_liquid_glass_reference(self):
        brand = read(SCENES / "Scene2BrandReveal.tsx")
        for text in (
            "borderRadius: 9999",
            "linear-gradient(180deg, rgba(255, 255, 255, 0.35) 0%, rgba(255, 255, 255, 0.08) 60%, rgba(255, 255, 255, 0.18) 100%)",
            "blur(32px) saturate(220%)",
            "const LOGO_SPRING = { damping: 14, mass: 0.8, stiffness: 120 };",
            "interpolate(frame, SWEEP, [-100, 200]",
            "[IGNITE, IGNITE + 6, IGNITE + 18], [1, 1.5, 1]",
            "translateY(${20 * (1 - subtitle)}px)",
            "1px solid rgba(255, 255, 255, 0.65)",
            "0 24px 48px -12px rgba(0, 0, 0, 0.35), inset 0 1.5px 2px rgba(255, 255, 255, 0.9), inset 0 -1.5px 2px rgba(0, 0, 0, 0.15)",
            'color="#FFFFFF"',
        ):
            self.assertIn(text, brand)

    def test_scene_corrections(self):
        backdrop = read(SCENES / "StageBackdrop.tsx")
        self.assertIn("AudienceSilhouette", backdrop)
        self.assertNotIn("person_silhouette", backdrop)
        catalog = read(SCENES / "Scene3CatalogTransition.tsx")
        self.assertNotIn("GET ", catalog)
        self.assertNotIn("parallax/background.svg", catalog)
        for text in ("images/bioskopbg.jpg", 'className="lg-light"', "#F8FAFC", "Feel the moments beyond"):
            self.assertIn(text, catalog)
        cinema = read(SCENES / "Scene4CinemaViewport.tsx")
        self.assertIn("video/trailer_sore.mp4", cinema)
        concert = read(SCENES / "Scene5ConcertViewport.tsx")
        self.assertIn("video/coldplay_live.mp4", concert)
        self.assertEqual(concert.count('role: "'), 9)
        outro = read(SCENES / "Scene7Outro.tsx")
        for text in ('className="lg-light"', "<BoardingPassCard", "Diskon 15% Mahasiswa UI", "PAYMENT_PARTNERS", "SOCIALS"):
            self.assertIn(text, outro)

    def test_light_glass_tokens_match_web_app(self):
        """Token .lg-light di video harus sama persis dengan token terang liquid_glass.css."""
        squash = lambda text: re.sub(r"\s+", " ", text)
        app_css = squash(read(ROOT / "app/static/css/liquid_glass.css"))
        block = re.search(r"\.lg-light \{(.*?)\n\}", read(SRC / "styles/global.css"), re.S).group(1)
        declarations = [squash(d).strip() for d in block.split(";") if "--lg-" in d]
        self.assertEqual(len(declarations), 12)
        for declaration in declarations:
            with self.subTest(token=declaration.split(":")[0]):
                self.assertIn(declaration + ";", app_css)

    def test_bgm_volume_curve_and_ducking(self):
        self.assertIn("<SoundDesign />", read(SRC / "TitiketPromo/index.tsx"))
        main = read(SRC / "TitiketPromo/sound.tsx")
        self.assertIn('import { Audio, interpolate, Sequence, staticFile } from "remotion";', main)
        self.assertIn('<Audio src={staticFile("audio/bgm_promo.m4a")} volume={bgmVolume} />', main)
        frames_src = re.search(r"const BGM_FRAMES = \[(.*?)\];", main).group(1).replace("DURATION_IN_FRAMES - 1", "1199")
        frames = [int(x) for x in frames_src.split(",")]
        volumes = [float(x) for x in re.search(r"const BGM_VOLUMES = \[(.*?)\];", main).group(1).split(",")]

        def volume(frame: int) -> float:
            for (f0, v0), (f1, v1) in zip(zip(frames, volumes), zip(frames[1:], volumes[1:])):
                if f0 <= frame <= f1:
                    return v0 + (v1 - v0) * (frame - f0) / (f1 - f0)
            return volumes[-1]

        # Detik 0-5 senyap (efek air di BGM tidak terdengar), konser 0,45, sisanya sesuai kurva sebelumnya.
        expected = {0: 0.0, 150: 0.0, 300: 0.0, 330: 0.7, 450: 0.7, 600: 0.25, 720: 0.25, 840: 0.25,
                    855: 0.35, 930: 0.35, 1005: 0.35, 1020: 0.7, 1100: 0.7, 1140: 0.7, 1199: 0.0}
        for frame, level in expected.items():
            with self.subTest(frame=frame):
                self.assertAlmostEqual(volume(frame), level, places=3)
        cinema = read(SCENES / "Scene4CinemaViewport.tsx")
        self.assertIn("volume={(f) => interpolate(f, [0, 12, 228, 240], [0, 0.9, 0.9, 0], CLAMP)}", cinema)

    def test_sfx_cues_and_stadium_ambience(self):
        sound = read(SRC / "TitiketPromo/sound.tsx")
        cues = set(re.findall(r'\{ at: (\d+), file: "([^"]+)"', sound))
        for frame, file in (("150", "sfx/whoosh.wav"), ("205", "sfx/crystal_ping.wav"), ("235", "sfx/sub_impact.wav"),
                            ("58", "sfx/haptic_thud.wav"), ("86", "sfx/glass_chime_1.wav"), ("98", "sfx/glass_chime_2.wav"),
                            ("110", "sfx/glass_chime_3.wav"), ("458", "sfx/scroll_swoosh.wav"),
                            ("566", "sfx/ui_click.wav"), ("568", "sfx/whoosh.wav")):
            with self.subTest(cue=f"{frame} {file}"):
                self.assertIn((frame, file), cues)
        self.assertIn("const CROWD = { from: 840, durationInFrames: 180, volume: 0.3, fade: 15 };", sound)
        # Suara asli video di videotron dimatikan: satu-satunya <Video> di adegan konser selalu muted.
        concert = read(SCENES / "Scene5ConcertViewport.tsx")
        self.assertEqual(len(re.findall(r"<Video\s", concert)), 1)
        self.assertIn("      muted\n", concert)
        self.assertNotIn("volume=", concert)
        self.assertNotIn("withAudio", concert)
        self.assertIn('staticFile("sfx/stadium_crowd.wav")', sound)
        generator = read(PROMO / "scripts/make-sfx.mjs")
        for name in ("glass_chime_1.wav", "haptic_thud.wav", "whoosh.wav", "crystal_ping.wav", "sub_impact.wav",
                     "stadium_crowd.wav", "scroll_swoosh.wav", "ui_click.wav"):
            self.assertIn(name, generator)
        self.assertIn("node scripts/make-sfx.mjs", read(PROMO / "package.json"))

    def test_light_mode_hud_cards(self):
        light = read(SRC / "TitiketPromo/components/LightGlass.ts")
        for text in ('background: "rgba(255, 255, 255, 0.82)"', '"blur(20px) saturate(190%)"', 'border: "1px solid rgba(255, 255, 255, 0.95)"',
                     'boxShadow: "0 16px 32px -8px rgba(0, 0, 0, 0.15), inset 0 1.5px 2px rgba(255, 255, 255, 1)"',
                     "borderRadius: 16", 'color: "#64748B"', "fontSize: 10", 'HUD_INK = "#0F172A"', 'EMERALD = "#15803D"', 'EMERALD_GLOW = "#22C55E"'):
            self.assertIn(text, light)
        for name in ("Scene4CinemaViewport.tsx", "Scene5ConcertViewport.tsx"):
            with self.subTest(scene=name):
                scene = read(SCENES / name)
                self.assertIn("...LIGHT_GLASS_CARD", scene)
                self.assertNotIn("liquid-glass-dock", scene)

    def test_cinematic_push_and_realistic_stage(self):
        hook = read(SCENES / "Scene1Hook.tsx")
        for text in ("const PUSH = [140, 180] as const;", "(1.45 - drift) * push", "blur={24 * push}", "opacity: 1 - push", "<GlowVoid"):
            self.assertIn(text, hook)
        stage = read(SCENES / "StageBackdrop.tsx")
        for text in ("const StageFloor", "const StageProps", "const FohTower", "Kabinet line array", "Garis kisi perspektif"):
            self.assertIn(text, stage)
        logo = read(SRC / "TitiketPromo/components/BrandLogo.tsx")
        for text in ("0 0 30px rgba(234, 179, 8,", "0 0 60px rgba(202, 138, 4,", '"2px solid rgba(255, 255, 255, 0.5)"'):
            self.assertIn(text, logo)

    def test_catalog_scroll_and_sore_click(self):
        data = read(SRC / "TitiketPromo/data.ts")
        block = re.search(r"export const NOW_PLAYING = \[(.*?)\] as const;", data, re.S).group(1)
        titles = re.findall(r'title: "([^"]+)"', block)
        self.assertEqual(titles, ["How to Lose a Guy in 10 Days", "The Nun", "SORE: Istri dari Masa Depan",
                                  "Spider-Man: No Way Home", "Chiikawa Movie"])
        self.assertEqual(re.findall(r"featured: (true|false)", block), ["false", "false", "true", "false", "false"])
        catalog = read(SCENES / "Scene3CatalogTransition.tsx")
        for text in ("REKOMENDASI POV 3D", "Aktifkan SSO UI", "Lagi tayang",
                     "Diskon Khusus Mahasiswa UI 15% • Verifikasi SSO UI sekali klik saat checkout bioskop &amp; konser!",
                     "const SCROLL = { from: 100, to: 160, distance: 600 };", "const CURSOR_MOVE = [160, 204] as const;",
                     "const CLICK = 206;", "const ZOOM = [216, 240] as const;", "[1, 0.96]"):
            with self.subTest(text=text):
                self.assertIn(text, catalog)
        self.assertNotIn("IntroPage", catalog)

    def test_no_hyphenated_film_title(self):
        for path in SRC.rglob("*.ts*"):
            with self.subTest(file=path.name):
                self.assertNotIn("Film-Film", read(path))


if __name__ == "__main__":
    unittest.main()
