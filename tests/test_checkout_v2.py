"""Tes V2: data penonton per kursi, cabang QRIS di pesanan, struktur checkout, pil timer, dan proyeksi pin globe."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from app import create_app
from app.blueprints.visualizer.models import get_venue

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "app/static/css"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class CheckoutV2Tests(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()
        self.client.post("/auth/login", json={"email": "konser@example.com", "password": "password123"})
        for seat in ("cat1:R1:S10", "cat1:R1:S11"):
            self.client.post("/visualizer/api/cart", json={"venue_id": "gbk-coldplay", "seat_id": seat})

    def test_attendee_form_is_in_main_column_and_payment_in_summary_panel(self):
        html = self.client.get("/checkout/").get_data(as_text=True)
        main, aside = html.split('<aside class="summary', 1)
        self.assertIn("Data Penonton per Kursi", main)
        self.assertIn('id="attendee-same-toggle"', main)
        self.assertIn('data-attendee="2"', main)
        self.assertNotIn('id="payment-method-accordion"', main)
        self.assertLess(aside.index("Rincian Harga"), aside.index('id="payment-method-accordion"'))
        self.assertLess(aside.index('id="payment-method-accordion"'), aside.index('id="pay-submit-btn"'))
        self.assertIn("pay-submit__spinner", aside)

    def test_attendees_are_validated_and_saved(self):
        base = {"mode": "ticket", "name": "Penonton Satu", "email": "satu@example.com", "method": "qris",
                "attendee_nik_1": "3174000000000001"}
        bad = self.client.post("/checkout/pending", json={**base, "attendee_name_2": "Ab"})
        self.assertEqual(bad.status_code, 400)
        self.assertIn("attendee_2", bad.get_json()["errors"])
        ok = self.client.post("/checkout/pending", json={**base, "attendee_name_2": "Penonton Dua"})
        self.assertEqual(ok.status_code, 200)
        names = [a["name"] for a in ok.get_json()["order"]["attendees"]]
        self.assertEqual(names, ["Penonton Satu", "Penonton Dua"])

    def test_eticket_holder_follows_attendee_per_seat(self):
        paid = self.client.post("/checkout/pay", data={
            "name": "Penonton Satu", "email": "satu@example.com", "method": "qris",
            "attendee_name_2": "Penonton Dua", "attendee_email_2": "dua@example.com"})
        self.assertEqual(paid.status_code, 302)
        ticket = self.client.get("/checkout/ticket").get_data(as_text=True)
        self.assertIn("<strong>Penonton Dua</strong>", ticket)

    def test_qris_order_hides_va_label_and_offers_qris_modal(self):
        base = {"mode": "ticket", "name": "Penonton Satu", "email": "satu@example.com"}
        self.client.post("/checkout/pending", json={**base, "method": "qris"})
        html = self.client.get("/profile?tab=pending").get_data(as_text=True)
        self.assertIn("Menunggu Pembayaran via QRIS", html)
        self.assertIn("Metode: <strong>QRIS</strong>", html)
        self.assertNotIn("Kode Bayar / VA", html)
        self.assertIn('data-open-qris=', html)
        self.assertIn('id="profile-qris-modal"', html)
        self.client.post("/checkout/pending", json={**base, "method": "bca"})
        self.assertIn("Kode Bayar / VA", self.client.get("/profile?tab=pending").get_data(as_text=True))


class VisualRulesTests(unittest.TestCase):
    def test_pay_timer_is_glass_pill_with_urgent_state(self):
        tpl = read("app/blueprints/checkout/templates/checkout/checkout.html")
        pill = tpl.split('id="pay-timer-pill"', 1)[1].split("</div>", 1)[0]
        self.assertIn("#i-clock", pill)
        self.assertNotIn("#i-lock", pill)
        css = (CSS / "checkout.css").read_text(encoding="utf-8")
        self.assertIn("border-radius: 9999px;", css.split(".pay-timer-pill {", 1)[1].split("}", 1)[0])
        self.assertIn(".pay-timer-pill.is-urgent", css)
        self.assertIn("URGENT_SECONDS = 120", read("app/static/js/checkout_ui.js"))

    def test_ui_student_badge_never_wraps_and_popover_is_wide_enough(self):
        auth = (CSS / "auth.css").read_text(encoding="utf-8")
        self.assertIn("min-width: 280px;", auth.split(".profile-popover {", 1)[1].split("}", 1)[0])
        self.assertIn("white-space: nowrap;", auth.split(".profile-popover__ui-badge {", 1)[1].split("}", 1)[0])

    def test_no_package_emoji_and_no_dull_yellow_accent(self):
        for path in ("app/blueprints/landing/templates/landing/index.html",
                     "app/blueprints/checkout/templates/checkout/checkout.html",
                     "app/blueprints/checkout/templates/checkout/cart.html",
                     "app/blueprints/checkout/templates/checkout/eticket.html"):
            self.assertNotIn("\U0001F4E6", read(path), path)
        for css in CSS.glob("*.css"):
            text = css.read_text(encoding="utf-8").upper()
            for banned in ("#CA8A04", "#B45309"):
                self.assertNotIn(banned, text, f"{banned} di {css.name}")
        tokens = read("app/static/css/tokens.css")
        self.assertIn("--color-accent: #0D9488;", tokens)
        self.assertIn("--color-accent: #006875;", tokens)

    def test_apple_glass_tokens_and_spring_curve(self):
        css = read("app/static/css/liquid_glass.css")
        for token in ("rgba(255, 255, 255, 0.65)", "rgba(15, 23, 42, 0.65)",
                      "blur(24px) saturate(190%) contrast(90%)", "cubic-bezier(0.32, 0.72, 0, 1)",
                      "transform: scale(0.985);", "transform: translateY(-2px);"):
            self.assertIn(token, css)

    def test_booking_height_pill_and_floating_action_bar(self):
        html = create_app().test_client().get("/visualizer/studio/xxi-regular").get_data(as_text=True)
        self.assertNotIn("data-height-step", html)
        self.assertIn("Tinggi: <strong", html)
        bar = html.split('id="cta-bar"', 1)[1].split("{# INSIGHT", 1)[0]
        for ident in ('id="btn-clear"', 'id="btn-cart"', 'id="btn-checkout"'):
            self.assertIn(ident, bar)
        self.assertIn("liquid-glass", html.split('id="cta-bar"', 1)[0].rsplit("<div", 1)[1])

    def test_checkout_primary_button_is_52px(self):
        css = read("app/static/css/checkout.css")
        self.assertIn("min-height: 52px;", css.split(".pay-submit {", 1)[1].split("}", 1)[0])


@unittest.skipUnless(shutil.which("node"), "node tidak terpasang")
class GlobeProjectionTests(unittest.TestCase):
    """Pin DOM globe memakai proyeksi yang sama dengan shader Cobe (bukan rumus sin(lng + phi) polos)."""

    def project(self, lat, lon, phi, theta):
        src = read("app/static/js/cobe_globe.js")
        block = re.search(r"const SPHERE_R[\s\S]*?\n}\n", src).group(0).replace("export function", "function")
        script = block + f"; console.log(JSON.stringify(projectLatLon({lat}, {lon}, {phi}, {theta})));"
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    @staticmethod
    def angles(lat, lon):  # locationToAngles() di cobe_globe.js
        import math
        return math.pi - (math.radians(lon) - math.pi / 2), math.radians(lat)

    def test_focused_city_lands_at_globe_center_facing_camera(self):
        phi, theta = self.angles(-6.2186, 106.8026)
        p = self.project(-6.2186, 106.8026, phi, theta)
        self.assertAlmostEqual(p["x"], 0.5, places=6)
        self.assertAlmostEqual(p["y"], 0.5, places=6)
        self.assertGreater(p["z"], 0.999)

    def test_neighbours_sit_on_the_correct_side_and_far_side_is_hidden(self):
        phi, theta = self.angles(-6.2186, 106.8026)
        singapore = self.project(1.3521, 103.8198, phi, theta)
        tokyo = self.project(35.6762, 139.6503, phi, theta)
        self.assertLess(singapore["x"], 0.5)   # barat laut Jakarta
        self.assertLess(singapore["y"], 0.5)
        self.assertGreater(tokyo["x"], 0.5)    # timur laut
        self.assertLess(tokyo["y"], singapore["y"])
        behind = self.project(-6.2186, 106.8026, phi + 3.14159265, theta)
        self.assertLess(behind["z"], 0)        # di belakang bola: pin disembunyikan

    def test_landing_has_four_pins_and_pin_css_overrides_glass_transition(self):
        html = create_app().test_client().get("/home").get_data(as_text=True)
        self.assertEqual(html.count("data-globe-pin="), 4)
        css = read("app/static/css/landing.css")
        pin = css.split(".cobe-canvas-wrap .globe-pin {", 1)[1].split("}", 1)[0]
        self.assertNotIn("transition: all", pin)  # transisi `all` akan membuat pin tertinggal dari putaran bola


if __name__ == "__main__":
    unittest.main()
