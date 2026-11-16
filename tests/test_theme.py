"""Tes tombol ganti tema terang atau gelap (Langkah 2)."""

from __future__ import annotations

import unittest
from pathlib import Path

from app import create_app

ROOT = Path(__file__).resolve().parents[1]
# Dipisah dari literal agar pemeriksaan teks tidak memuat tanda hubung ganda sendiri.
DOUBLE_HYPHEN = "-" + "-"


class ThemeToggleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()

    def test_toggle_is_on_every_main_page(self):
        venue_id = self.client.get("/visualizer/api/venues").get_json()["venues"][0]["venue_id"]
        for path in ("/home", f"/visualizer/studio/{venue_id}", "/cart"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn('id="theme-toggle"', response.get_data(as_text=True))
                response.close()

    def test_saved_theme_is_applied_before_stylesheet(self):
        html = self.client.get("/home").get_data(as_text=True)
        self.assertIn('localStorage.getItem("titiket-theme")', html)
        self.assertLess(html.index("localStorage.getItem"), html.index("tokens.css"))

    def test_theme_script_is_served_with_storage_key(self):
        response = self.client.get("/static/js/theme.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("titiket-theme", response.get_data(as_text=True))
        response.close()

    def test_light_and_dark_tokens_are_defined(self):
        css = (ROOT / "app/static/css/tokens.css").read_text(encoding="utf-8")
        self.assertIn('html[data-theme="light"]', css)
        self.assertIn("--color-background: #FFFFFF", css)
        self.assertIn("--color-background: #0B0F17", css)
        self.assertIn("--color-card: #161F30", css)

    def test_new_theme_text_has_no_double_hyphen(self):
        partial = (ROOT / "app/templates/_theme_toggle.html").read_text(encoding="utf-8")
        script = (ROOT / "app/static/js/theme.js").read_text(encoding="utf-8")
        self.assertNotIn(DOUBLE_HYPHEN, partial)
        self.assertNotIn(DOUBLE_HYPHEN, script)

    def test_circular_crescent_toggle_everywhere(self):
        tokens = (ROOT / "app/static/css/tokens.css").read_text(encoding="utf-8")
        partial = (ROOT / "app/templates/_theme_toggle.html").read_text(encoding="utf-8")
        script = (ROOT / "app/static/js/theme.js").read_text(encoding="utf-8")

        self.assertIn(".theme-toggle__moon", tokens)
        self.assertIn("display: none !important;", tokens)
        self.assertIn("border-radius: 9999px;", tokens)
        self.assertIn("theme-toggle__moon", partial)
        self.assertNotIn("theme-toggle__sun", partial)
        self.assertIn('step === "promo"', script)

        for path in ("/home", "/promo", "/visualizer/studio/xxi-regular", "/cart"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            html = response.get_data(as_text=True)
            response.close()
            self.assertIn('id="theme-toggle"', html, path)
            self.assertIn("theme-toggle__moon", html, path)
            self.assertNotIn("theme-toggle__sun", html, path)


if __name__ == "__main__":
    unittest.main()
