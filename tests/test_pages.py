"""Tes halaman intro, detail film, detail konser Coldplay, dan placeholder auth."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from app import create_app

ROOT = Path(__file__).resolve().parents[1]
DOUBLE_HYPHEN = "-" + "-"


def visible_text(html: str) -> str:
    """Teks yang dilihat pengguna: tanpa script, style, dan tag."""
    html = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S)
    return re.sub(r"<[^>]+>", " ", html)


class PagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()
        catalog = json.loads((ROOT / "movies_catalog.json").read_text(encoding="utf-8"))
        cls.movie_ids = [movie["id"] for movie in catalog["movies"]]

    def get_text(self, path: str) -> str:
        response = self.client.get(path)
        try:
            self.assertEqual(response.status_code, 200, path)
            return response.get_data(as_text=True)
        finally:
            response.close()

    def test_intro_has_three_layers_and_gate(self):
        html = self.get_text("/intro")
        self.assertIn("FEEL THE MOMENTS", html)
        self.assertIn('data-depth="34"', html)
        self.assertIn("Mulai Eksplorasi", html)
        self.assertIn("Lanjut sebagai Tamu", html)
        self.assertIn('href="/"', html)

    def test_every_catalog_film_has_a_detail_page(self):
        for movie_id in self.movie_ids:
            with self.subTest(movie=movie_id):
                html = self.get_text(f"/movie/{movie_id}")
                self.assertIn("Beli Tiket", html)
                self.assertIn(f"/visualizer/?film={movie_id}", html)

    def test_unknown_movie_is_not_found(self):
        response = self.client.get("/movie/tidak-ada")
        self.assertEqual(response.status_code, 404)
        response.close()

    def test_coldplay_tabs_and_buy_link(self):
        overview = self.get_text("/event/coldplay/overview")
        tickets = self.get_text("/event/coldplay/tickets")
        terms = self.get_text("/event/coldplay/terms")
        self.assertIn('href="/visualizer/studio/gbk-coldplay"', overview)
        self.assertIn("Kategori Tiket", tickets)
        self.assertIn("Syarat dan Ketentuan", terms)
        for html in (overview, tickets, terms):
            self.assertIn('aria-label="Menu konser"', html)

    def test_auth_placeholders_are_in_base_header(self):
        html = self.get_text("/checkout/")
        self.assertIn('data-auth-open="login"', html)
        self.assertIn('data-auth-open="register"', html)
        self.assertIn('id="auth-modal"', html)
        self.assertIn("SSO UI", html)

    def test_visible_text_has_no_double_hyphen(self):
        for path in ("/intro", "/movie/sore", "/event/coldplay/terms"):
            with self.subTest(path=path):
                text = visible_text(self.get_text(path))
                self.assertNotIn(DOUBLE_HYPHEN, text)

    def test_catalog_title_uses_corrected_spelling(self):
        html = self.get_text("/movie/jatuh-cinta-seperti-di-film-film")
        self.assertIn("Jatuh Cinta Seperti di Film Film", html)
        self.assertNotIn("Film-Film", html)


if __name__ == "__main__":
    unittest.main()
