"""Tes kerangka handoff: modul engines, modal trailer, tema terang, dan README."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from app import create_app
from engines.auth_engine import AuthManager
from engines.food_engine import FoodCart, find_item
from engines.payment_engine import create_virtual_account
from engines.ticket_pdf_engine import TicketData, render_ticket_pdf

ROOT = Path(__file__).resolve().parents[1]
DOUBLE_HYPHEN = "-" + "-"


class EngineStubTests(unittest.TestCase):
    def test_auth_stubs_raise_until_implemented(self):
        auth = AuthManager("instance/test.db")
        with self.assertRaises(NotImplementedError):
            auth.register_user("a@example.com", "rahasia", "Nama")
        with self.assertRaises(NotImplementedError):
            auth.verify_sso_ui("a@ui.ac.id")

    def test_food_stubs_raise_until_implemented(self):
        with self.assertRaises(NotImplementedError):
            FoodCart().total()
        with self.assertRaises(NotImplementedError):
            find_item("popcorn-besar")

    def test_payment_and_pdf_stubs_raise_until_implemented(self):
        with self.assertRaises(NotImplementedError):
            create_virtual_account("ORDER-1", 100000, "bca")
        ticket = TicketData("K1", "Film", "XXI", "A1", 50000, "Pembeli")
        with self.assertRaises(NotImplementedError):
            render_ticket_pdf(ticket, Path("tiket.pdf"))


class PageIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()

    def get_text(self, path: str) -> str:
        response = self.client.get(path)
        try:
            self.assertEqual(response.status_code, 200, path)
            return response.get_data(as_text=True)
        finally:
            response.close()

    def test_movie_page_prefers_local_trailer_video(self):
        html = self.get_text("/movie/sore")
        self.assertIn('id="trailer-modal"', html)
        self.assertIn('id="trailer-open"', html)
        self.assertIn("Tonton Trailer", html)
        self.assertIn('<video id="trailer-video"', html)
        self.assertIn("videos/sore_istri_dari_masa_depan_official_trailer.mp4", html)
        self.assertNotIn('<iframe id="trailer-frame"', html)

    def test_youtube_fallback_renders_when_local_video_is_missing(self):
        from flask import render_template

        from app.blueprints.events import _youtube_embed

        embed = _youtube_embed("lY95G24f9E4")
        self.assertEqual(embed, "https://www.youtube-nocookie.com/embed/lY95G24f9E4")
        self.assertEqual(_youtube_embed(None), "")
        with self.client.application.test_request_context():
            html = render_template(
                "events/movie.html",
                movie={"title": "Uji", "tagline": "", "rating": 0, "duration": "",
                       "age_rating": "", "genres": [], "synopsis": "", "tech_specs": {}},
                poster_url=None,
                trailer_local=None,
                trailer_embed=embed,
                buy_url="/visualizer/",
            )
        self.assertIn('<iframe id="trailer-frame"', html)
        self.assertIn(embed, html)
        self.assertNotIn('<video id="trailer-video"', html)

    def test_catalog_has_youtube_embed_ids_for_all_films(self):
        catalog = json.loads((ROOT / "movies_catalog.json").read_text(encoding="utf-8"))
        for movie in catalog["movies"]:
            with self.subTest(movie=movie["id"]):
                self.assertTrue(movie.get("embed_id"))

    def test_light_theme_stylesheet_is_loaded_everywhere(self):
        html = self.get_text("/checkout/")
        self.assertIn("theme-light.css", html)
        css = (ROOT / "app/static/css/theme-light.css").read_text(encoding="utf-8")
        self.assertIn('html[data-theme="light"] .panel', css)

    def test_visualizer_and_checkout_still_render(self):
        self.get_text("/checkout/")
        self.get_text("/visualizer/api/venues")


def prose(markdown: str) -> str:
    """Kalimat README saja: tanpa blok kode, baris tabel, dan nama variabel CSS."""
    text = re.sub(r"```.*?```", "", markdown, flags=re.S)
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("|")]
    return "\n".join(lines).replace("var(--", "var(")


class ReadmeTests(unittest.TestCase):
    def test_readme_documents_run_test_and_branches(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("python run.py", readme)
        self.assertIn("python -m unittest discover -s tests", readme)
        self.assertIn("engines/", readme)

    def test_readme_prose_has_no_double_hyphen(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertNotIn(DOUBLE_HYPHEN, prose(readme))


if __name__ == "__main__":
    unittest.main()
