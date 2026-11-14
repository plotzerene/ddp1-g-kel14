"""Tes kerangka handoff: modul engines, modal trailer, tema terang, dan README."""

from __future__ import annotations

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

    def test_movie_page_has_trailer_modal_without_local_video(self):
        html = self.get_text("/movie/sore")
        self.assertIn('id="trailer-modal"', html)
        self.assertIn('id="trailer-open"', html)
        self.assertIn("Tonton Trailer", html)
        self.assertIn("Trailer belum tersedia.", html)
        self.assertNotIn("<video", html)

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
