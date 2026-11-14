"""Tes Liquid Glass, parallax Martian, placeholder pencarian, dan istilah area berdiri."""

from __future__ import annotations

import unittest
from pathlib import Path

from app import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app/static"


class LiquidGlassTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()

    def get_text(self, path: str) -> str:
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        return response.get_data(as_text=True)

    def test_stylesheet_is_linked_globally_after_page_css(self):
        for path in ("/", "/cart", "/visualizer/studio/xxi-regular", "/movie/sore"):
            with self.subTest(path=path):
                html = self.get_text(path)
                self.assertIn("css/liquid_glass.css", html)
                self.assertLess(html.index("css/tokens.css"), html.index("css/liquid_glass.css"))
        self.assertEqual(self.client.get("/static/css/liquid_glass.css").status_code, 200)

    def test_stylesheet_defines_all_components_and_both_materials(self):
        css = (STATIC / "css/liquid_glass.css").read_text(encoding="utf-8")
        for selector in (".liquid-glass-pill", ".liquid-glass-switch", ".liquid-glass-dock",
                         ".liquid-glass-modal", ".liquid-glass--obsidian"):
            self.assertIn(selector, css)
        self.assertIn("backdrop-filter", css)
        self.assertIn("rgba(255, 255, 255, 0.40) 0%", css)  # kilau specular kiri atas
        self.assertIn("inset 0 1px 1px", css)
        self.assertIn("#08090C", css)                       # kanvas 3D obsidian
        self.assertIn("#F8FAFC 0%, #FFFFFF", css)           # latar halaman terang
        self.assertIn("prefers-reduced-motion", css)

    def test_components_use_glass_classes(self):
        self.assertIn("liquid-glass-switch", self.get_text("/"))
        self.assertIn("auth-modal__panel liquid-glass-modal", self.get_text("/"))
        viz = self.get_text("/visualizer/studio/xxi-regular")
        self.assertIn("hud hud--tl liquid-glass-dock", viz)
        movie = self.get_text("/movie/sore")
        self.assertIn('detail__cta-secondary liquid-glass-pill" id="trailer-open"', movie)

    def test_landing_parallax_showcase_and_assets(self):
        html = self.get_text("/")
        self.assertIn("data-parallax-stage", html)
        self.assertEqual(html.count("data-parallax-layer"), 3)
        self.assertIn("js/parallax.js", html)
        for name in ("background.svg", "frame.svg", "foreground.svg"):
            with self.subTest(layer=name):
                self.assertIn(f"images/parallax/{name}", html)
                self.assertEqual(self.client.get(f"/static/images/parallax/{name}").status_code, 200)

    def test_parallax_uses_extracted_lerp_formula(self):
        js = (STATIC / "js/parallax.js").read_text(encoding="utf-8")
        self.assertIn("var DAMPING = 0.08;", js)
        self.assertIn("curX += (targetX - curX) * DAMPING;", js)
        self.assertIn("var tx = -curX * maxOffset * layer.depth;", js)
        self.assertIn("((event.clientX - rect.left) / width - 0.5) * 2", js)
        self.assertIn("prefers-reduced-motion", js)

    def test_search_placeholder_cycles_every_three_seconds(self):
        js = (STATIC / "js/landing.js").read_text(encoding="utf-8")
        for hint in ("Cari film SORE: Istri dari Masa Depan...", "Cari konser Coldplay di GBK...",
                     "Cari bioskop Studio IMAX...", "Cari film Jatuh Cinta Seperti di Film Film..."):
            self.assertIn(hint, js)
        self.assertIn("}, 3000);", js)
        self.assertNotIn("Film-Film", js)

    def test_standing_picker_never_says_kursi(self):
        picker = (STATIC / "js/map_2d_picker.js").read_text(encoding="utf-8")
        self.assertIn("block.standing ? `${block.label} — Pilih Spot Berdiri`", picker)
        concert = self.get_text("/visualizer/studio/gbk-coldplay")
        self.assertIn("Pilih Kategori (CAT)", concert)
        self.assertIn("Perbesar Peta Area", concert)
        self.assertNotIn("Pilih Kategori / Area", concert)


if __name__ == "__main__":
    unittest.main()
