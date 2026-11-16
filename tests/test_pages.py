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
        for intro_path in ("/", "/intro"):
            with self.subTest(intro_path=intro_path):
                html = self.get_text(intro_path)
                self.assertIn("FEEL THE MOMENTS BEYOND", html)
                self.assertNotIn("PARALLAX LAYERED ENTRANCE", html)
                self.assertNotIn("POV 3D ENGINE", html)
                self.assertIn("titiket-fade-in", html)
                self.assertEqual(html.count("data-parallax-layer"), 3)
                self.assertIn('data-depth="0.35"', html)
                self.assertIn('data-depth="0.70"', html)
                self.assertIn('data-depth="1.25"', html)
                self.assertIn("Mulai Eksplorasi", html)
                self.assertIn("Lanjut Jelajah sebagai Tamu", html)
                self.assertIn('href="/home"', html)
                self.assertNotIn('<header class="site-header"', html)
                self.assertNotIn('<footer class="site-footer', html)

        intro_css = self.get_text("/static/css/intro.css")
        self.assertIn("dvh)", intro_css)
        self.assertIn("clamp(", intro_css)
        self.assertNotIn("parallax-intro__badge", intro_css)

        tokens_css = self.get_text("/static/css/tokens.css")
        self.assertIn(".page-fade-curtain", tokens_css)
        self.assertIn("is-page-fading-in", tokens_css)

        theme_js = self.get_text("/static/js/theme.js")
        self.assertIn("TitiketTransition", theme_js)
        self.assertIn("fadeOutAndGo", theme_js)
        self.assertNotIn("-" + "-", theme_js)

    def test_every_catalog_film_has_a_detail_page(self):
        for movie_id in self.movie_ids:
            with self.subTest(movie=movie_id):
                html = self.get_text(f"/movie/{movie_id}")
                self.assertIn("Pilih Jadwal &amp; Kursi", html)
                self.assertIn('id="trailer-open"', html)
                self.assertIn("Detail Acara", html)
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
        html = self.get_text("/cart")
        self.assertIn('data-auth-open="login"', html)
        self.assertIn('data-auth-open="register"', html)
        self.assertIn('id="auth-modal"', html)
        self.assertIn("SSO UI", html)

    def test_visible_text_has_no_double_hyphen(self):
        for path in ("/", "/intro", "/home", "/promo", "/movie/sore", "/event/coldplay/terms",
                     "/visualizer/studio/xxi-regular", "/cart"):
            with self.subTest(path=path):
                text = visible_text(self.get_text(path))
                self.assertNotIn(DOUBLE_HYPHEN, text)

    def test_unified_brand_wordmark_renders_without_raster_logo(self):
        for path in ("/", "/intro", "/home", "/promo", "/visualizer/studio/xxi-regular", "/cart"):
            with self.subTest(path=path):
                html = self.get_text(path)
                self.assertIn('class="brand-logo', html)
                self.assertIn('class="brand-logo__dot"', html)
                self.assertNotIn("logo_2.png", html)

    @staticmethod
    def _login(client, email="penguji@example.com"):
        resp = client.post("/auth/login", json={"email": email, "password": "password123"})
        assert resp.status_code == 200
        return resp

    def test_checkout_instruction_hidden_initially_and_code_separated_per_venue(self):
        cinema_client = create_app().test_client()
        add_cinema = cinema_client.post(
            "/visualizer/api/cart",
            json={"venue_id": "xxi-regular", "seat_id": "C6", "body_height_cm": 170},
        )
        self.assertIn(add_cinema.status_code, (200, 201))
        guest_checkout = cinema_client.get("/checkout/")
        self.assertEqual(guest_checkout.status_code, 302)
        self.assertIn("auth=required", guest_checkout.headers["Location"])

        self._login(cinema_client, "bioskop@example.com")
        checkout_html = cinema_client.get("/checkout/").get_data(as_text=True)
        self.assertRegex(checkout_html, r'id="payment-instruction-panel"[^>]*hidden')
        self.assertRegex(checkout_html, r'id="pay-timer-pill"[^>]*hidden')
        self.assertNotIn('id="confirm-paid-btn"', checkout_html)
        paid_cinema = cinema_client.post(
            "/checkout/pay",
            data={"name": "Penguji Bioskop", "email": "bioskop@example.com", "method": "bca"},
        )
        self.assertEqual(paid_cinema.status_code, 302)
        cinema_ticket = cinema_client.get("/checkout/ticket").get_data(as_text=True)
        self.assertIn("eticket__code", cinema_ticket)
        self.assertIn("QR Code Tiket", cinema_ticket)
        self.assertNotIn("eticket__barcode-wrap", cinema_ticket)

        concert_client = create_app().test_client()
        self._login(concert_client, "konser@example.com")
        add_concert = concert_client.post(
            "/visualizer/api/cart",
            json={"venue_id": "gbk-coldplay", "seat_id": "festival:spot1"},
        )
        self.assertIn(add_concert.status_code, (200, 201))
        paid_concert = concert_client.post(
            "/checkout/pay",
            data={"name": "Penguji Konser", "email": "konser@example.com", "method": "qris"},
        )
        self.assertEqual(paid_concert.status_code, 302)
        concert_ticket = concert_client.get("/checkout/ticket").get_data(as_text=True)
        self.assertIn("eticket__barcode-wrap", concert_ticket)
        self.assertIn("Barcode Code128", concert_ticket)
        self.assertNotIn("QR Code Tiket", concert_ticket)
        self.assertNotIn("eticket__code", concert_ticket)

    def test_catalog_title_uses_corrected_spelling(self):
        html = self.get_text("/movie/jatuh-cinta-seperti-di-film-film")
        self.assertIn("Jatuh Cinta Seperti di Film Film", html)
        self.assertNotIn("Film-Film", html)

    def test_visualizer_figcraft_layout_and_controls(self):
        html = self.get_text(
            "/visualizer/studio/xxi-regular"
            "?film=sore&cinema=AGORA%20MALL%20XXI&date=Sab%2C%2015%20Nov&time=18%3A45"
        )
        for marker in (
            'class="viz-event-card',
            'class="viz-pov-card',
            'class="pov-hud-metrics"',
            "PANDANGAN LAYAR",
            "KEMIRINGAN LEHER",
            "JARAK PANDANG",
            'id="btn-clear"',
            "Hapus Pilihan",
            "Lanjut ke Checkout",
            'class="seat-map-scroll"',
            'id="btn-map-spotlight"',
            "Perbesar Peta Kursi",
            'id="seat-spotlight-modal"',
            "Seret untuk melihat sekeliling",
            'id="btn-fullscreen"',
            'id="fullscreen-hud"',
            "AGORA MALL XXI",
        ):
            self.assertIn(marker, html)
        self.assertNotIn("AREA LAYAR", html)
        self.assertNotIn('id="viz-tagline"', html)
        self.assertNotIn('id="map-hint"', html)

    def test_no_purple_palette_in_tokens_or_concert(self):
        banned = ("#A566FF", "#4338CA", "#818CF8", "#1E1B4B", "#312E81", "#27273B")
        files = (
            ROOT / "app/static/css/tokens.css",
            ROOT / "app/static/css/visualizer.css",
            ROOT / "app/static/css/theme-light.css",
            ROOT / "app/static/css/landing.css",
            ROOT / "app/static/css/auth.css",
            ROOT / "app/blueprints/visualizer/models/concert_gbk.py",
        )
        for path in files:
            content = path.read_text(encoding="utf-8").upper()
            for hex_code in banned:
                self.assertNotIn(hex_code, content, f"{hex_code} found in {path.name}")

        resp = self.client.get("/visualizer/api/venues/gbk-coldplay/layout")
        try:
            self.assertEqual(resp.status_code, 200)
            venue = resp.get_json()
        finally:
            resp.close()
        cat3 = next(b for b in venue["blocks"] if b["id"] == "cat3")
        self.assertEqual(cat3["color"].upper(), "#007A87")

    def test_trailer_modal_close_handlers_and_light_contrast_rules(self):
        trailer_js = (ROOT / "app/static/js/movie_trailer.js").read_text(encoding="utf-8")
        for token in (".trailer-modal__close", "#trailer-close", "stopMedia", "pause()", "Escape"):
            self.assertIn(token, trailer_js)

        light_css = (ROOT / "app/static/css/theme-light.css").read_text(encoding="utf-8")
        for selector in (".pov-hud-metrics", ".reco-card__score", ".map-spotlight-btn", ".seat-spotlight-dialog", ".screen-label"):
            self.assertIn(selector, light_css)

    def test_landing_figcraft_home_reconstruction(self):
        html = self.get_text("/home")
        for marker in (
            "Feel the moments beyond",
            "JABODETABEK",
            "Cari film, bioskop, atau konser...",
            'id="theme-toggle"',
            'href="/cart"',
            "Promo",
            'data-auth-open="login"',
            'data-category="bioskop"',
            'data-category="konser"',
            'data-category="film"',
            'data-category="food"',
            'data-category="sewa"',
            'class="featured-carousel"',
            'id="promo-mahasiswa"',
            "Lagi tayang",
            "Coming Soon",
            "Ingatkan Saya",
            'id="now-playing-expand"',
            'id="quick-info-modal"',
            "Perusahaan &amp; Legalitas",
            "Jelajahi Hiburan",
            "Pusat Bantuan &amp; Layanan CS",
            "Saluran Pembayaran Resmi",
        ):
            self.assertIn(marker, html)
        self.assertNotIn("hero-spotlight", html)
        self.assertNotIn("sso-strip__badge", html)
        self.assertNotIn("sso-strip__intro", html)
        self.assertNotIn("Intro 3D", html)
        self.assertIn("Masuk dengan SSO UI", html)

    def test_venue_separation_cinema_vs_concert(self):
        cinema_html = self.get_text("/visualizer/studio/xxi-regular?film=sore")
        self.assertNotIn("Coldplay GBK", cinema_html)
        self.assertNotIn("gbk-coldplay", cinema_html)
        for label in ("Regular 2D", "The Premiere", "IMAX Laser", "4DX Motion"):
            self.assertIn(label, cinema_html)

        concert_html = self.get_text("/visualizer/studio/gbk-coldplay")
        for studio_id in ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx"):
            self.assertNotIn(f'id="tab-{studio_id}"', concert_html)
        for zone_label in ("Festival Standing", "Ultimate Experience", "My Universe", "CAT 1", "CAT 3", "CAT 8"):
            self.assertIn(zone_label, concert_html)

    def test_dynamic_studio_availability_per_film(self):
        expected = {
            "sore": ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx"),
            "jatuh-cinta-seperti-di-film-film": ("xxi-regular", "xxi-premiere"),
            "boboiboy-the-movie": ("xxi-regular", "xxi-4dx"),
            "ejen-ali-the-movie-2": ("xxi-regular", "xxi-imax"),
            "la-la-land": ("xxi-regular", "xxi-premiere", "xxi-imax"),
            "avengers-endgame": ("xxi-regular", "xxi-imax", "xxi-4dx"),
        }
        all_studios = ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx")
        for slug, allowed in expected.items():
            viz_html = self.get_text(f"/visualizer/studio/xxi-regular?film={slug}")
            for vid in all_studios:
                tab_marker = f'id="tab-{vid}"'
                if vid in allowed:
                    self.assertIn(tab_marker, viz_html)
                else:
                    self.assertNotIn(tab_marker, viz_html)

        movie_html = self.get_text("/movie/boboiboy-the-movie")
        self.assertIn("Regular 2D", movie_html)
        self.assertIn("4DX Motion", movie_html)
        self.assertNotIn("The Premiere", movie_html)
        self.assertNotIn("IMAX Laser", movie_html)

        redir = self.client.get("/visualizer/studio/xxi-premiere?film=boboiboy-the-movie")
        self.assertEqual(redir.status_code, 302)
        self.assertIn("/visualizer/studio/xxi-regular?film=boboiboy-the-movie", redir.headers["Location"])

    def test_visualizer_ux_controls_and_sso_ui_validation(self):
        viz_html = self.get_text("/visualizer/studio/xxi-regular")
        for marker in (
            'data-venue-count="4"',
            'class="venue-tab format-pill"',
            'class="viz-right viz-sidebar"',
            'class="cta-summary__row summary-seats-row"',
            'id="btn-fullscreen"',
            "Layar Penuh",
            'id="btn-exit-fullscreen"',
            'id="btn-clear"',
            "Hapus Pilihan",
        ):
            self.assertIn(marker, viz_html)

        for removed in (
            'id="btn-reset-camera"',
            'id="target-buttons"',
            'id="fs-target-buttons"',
        ):
            self.assertNotIn(removed, viz_html)

        concert_html = self.get_text("/visualizer/studio/gbk-coldplay")
        self.assertIn('id="pov-card-badge" hidden', concert_html)
        self.assertIn('id="deck-display-group" hidden', concert_html)

        landing_html = self.get_text("/home")
        self.assertIn('class="poster-card__cover-link" href="/movie/sore"', landing_html)
        self.assertIn('class="poster-card__fab" href="/movie/sore"', landing_html)

        for path in ("/", "/home", "/intro", "/cart"):
            page_html = self.get_text(path)
            self.assertIn("https://sso.ui.ac.id/cas2/login?service=", page_html)
            self.assertNotIn('data-auth-view="sso"', page_html)
            self.assertNotIn('id="auth-sso-user"', page_html)
            self.assertNotIn('id="auth-sso-pass"', page_html)

        landing_js = (ROOT / "app/static/js/landing.js").read_text(encoding="utf-8")
        for token in ("currentTime = 0", "pause()", "Escape", "cancel"):
            self.assertIn(token, landing_js)

    def test_multi_device_responsive_and_fullscreen_hud(self):
        for path in ("/", "/intro", "/movie/sore", "/visualizer/studio/xxi-regular", "/cart"):
            html = self.get_text(path)
            self.assertIn("viewport-fit=cover", html)

        viz_html = self.get_text("/visualizer/studio/xxi-regular")
        for token in (
            "fullscreen-hud-top",
            "fs-tip-full",
            "fs-tip-short",
            "fs-exit-full",
            "fs-exit-short",
            "Kembali ke Peta Kursi (Esc)",
        ):
            self.assertIn(token, viz_html)

        pov_js = (ROOT / "app/static/js/pov_3d_three.js").read_text(encoding="utf-8")
        for token in ("idleResetMs = 3000", "_scheduleIdleReset", "resetLook"):
            self.assertIn(token, pov_js)

        viz_js = (ROOT / "app/static/js/visualizer_app.js").read_text(encoding="utf-8")
        self.assertNotIn("setMapZoom", viz_js)

        checks = {
            "app/static/css/tokens.css": ("overflow-x: clip", "100dvh", "max-height: 500px"),
            "app/static/css/intro.css": ("min-height: 100vh", "min-height: 100dvh"),
            "app/static/css/visualizer.css": (
                ".fullscreen-hud-top",
                "z-index: 10001",
                "env(safe-area-inset-top)",
                "env(safe-area-inset-bottom)",
                "touch-action: pan-x pan-y",
                "min-width: 480px;",
            ),
            "app/static/css/landing.css": (
                "clamp(1.75rem, 4vw + 0.5rem, 3rem)",
                "clamp(0.875rem, 1.5vw + 0.25rem, 1.125rem)",
                "90dvh",
            ),
            "app/static/css/detail.css": ("flex-wrap: nowrap", "90dvh", "position: sticky"),
            "app/static/css/checkout.css": ("#pay-submit-btn", "position: sticky", "90dvh"),
            "app/static/css/auth.css": (
                "width: min(92vw, clamp(340px, 38vw, 580px))",
                "90dvh",
                "position: sticky",
            ),
        }
        for rel, tokens in checks.items():
            css = (ROOT / rel).read_text(encoding="utf-8")
            for token in tokens:
                self.assertIn(token, css, f"Missing {token!r} in {rel}")

    def test_hero_cinema_interior_backdrop(self):
        landing_html = self.get_text("/home")
        self.assertIn('class="hero-stage"', landing_html)
        self.assertIn("Feel the moments beyond", landing_html)

        landing_css = (ROOT / "app/static/css/landing.css").read_text(encoding="utf-8")
        for token in (
            ".hero-stage::before",
            'html[data-theme="dark"] .hero-stage::before',
            'url("../reference_assets/images/bioskopbg.jpg")',
            ".hero-stage__inner",
        ):
            self.assertIn(token, landing_css, f"Missing {token!r} in landing.css")

        bg_asset = ROOT / "app/static/reference_assets/images/bioskopbg.jpg"
        self.assertTrue(bg_asset.is_file())
        resp = self.client.get("/static/reference_assets/images/bioskopbg.jpg")
        try:
            self.assertEqual(resp.status_code, 200)
        finally:
            resp.close()

    def test_cart_and_checkout_dual_routing_and_empty_state(self):
        fresh = create_app().test_client()

        # Navbar cart links to /cart from both base header and landing page.
        landing_html = fresh.get("/home").get_data(as_text=True)
        self.assertIn('href="/cart"', landing_html)

        # Empty checkout directly redirects to /cart.
        for path in ("/checkout", "/checkout/"):
            redir = fresh.get(path)
            self.assertEqual(redir.status_code, 302)
            self.assertTrue(redir.headers["Location"].endswith("/cart"))

        # Empty /cart shows Keranjang Belanja + unified top navbar without stepper or Langkah 3 dari 3.
        for cart_path in ("/cart", "/cart/"):
            cart_resp = fresh.get(cart_path)
            self.assertEqual(cart_resp.status_code, 200)
            cart_html = cart_resp.get_data(as_text=True)
            self.assertIn("Keranjang Belanja", cart_html)
            cart_header = cart_html.split("<header class=\"site-header\">", 1)[1].split("</header>", 1)[0]
            self.assertIn('id="city-selector"', cart_header)
            self.assertIn("Cari film, bioskop, atau konser...", cart_header)
            self.assertIn('id="theme-toggle"', cart_header)
            self.assertIn('data-auth-open="login"', cart_header)
            self.assertIn('data-auth-open="register"', cart_header)
            self.assertIn('href="/cart"', cart_header)
            self.assertNotIn("cart-site-nav", cart_html)
            self.assertNotIn("Konser GBK", cart_header)
            self.assertNotIn("Lagi Tayang", cart_header)
            empty_card = cart_html.split('class="empty-state cart-empty-card"', 1)[1].split("</section>", 1)[0]
            self.assertIn("Keranjangmu masih kosong", empty_card)
            self.assertIn("Pilih tiket dan tekan tombol Tambah ke Keranjang.", empty_card)
            self.assertIn("Pilih Tiket", empty_card)
            self.assertIn("#i-arrow-right", empty_card)
            self.assertIn('href="/home"', empty_card)
            self.assertNotIn('class="stepper"', cart_html)
            self.assertNotIn("Langkah 3 dari 3", cart_html)
            self.assertNotIn("Checkout &amp; Pembayaran", cart_html)
            self.assertNotIn("Pilih Posisi &amp; Lihat POV 3D", cart_html)
            self.assertNotIn("#i-eye", empty_card)

        # Non-empty cart lets user proceed to /checkout/ cleanly.
        layout = fresh.get("/visualizer/api/venues/xxi-regular/layout").get_json()
        free_seat = next(s["id"] for s in layout["seats"] if s["status"] == "available")
        add_resp = fresh.post(
            "/visualizer/api/cart",
            json={"venue_id": "xxi-regular", "seat_id": free_seat, "body_height_cm": 170},
        )
        self.assertIn(add_resp.status_code, (200, 201))

        cart_filled = fresh.get("/cart").get_data(as_text=True)
        self.assertIn("Ringkasan Keranjang", cart_filled)
        self.assertIn("Lanjut ke Pembayaran", cart_filled)
        self.assertIn('href="/checkout/"', cart_filled)
        self.assertNotIn('class="stepper"', cart_filled)

        guest_checkout_resp = fresh.get("/checkout/")
        self.assertEqual(guest_checkout_resp.status_code, 302)
        self.assertIn("/cart?auth=required", guest_checkout_resp.headers["Location"])

        self._login(fresh, "dualroute@example.com")
        checkout_resp = fresh.get("/checkout/")
        self.assertEqual(checkout_resp.status_code, 200)
        checkout_html = checkout_resp.get_data(as_text=True)
        self.assertIn("Langkah 3 dari 3", checkout_html)
        self.assertIn("Checkout &amp; Pembayaran", checkout_html)
        self.assertIn('class="stepper"', checkout_html)
        self.assertNotIn(DOUBLE_HYPHEN, visible_text(checkout_html))

        # Removing from /cart keeps user on /cart cleanly.
        rem_resp = fresh.post("/checkout/remove/0", data={"next": "cart"})
        self.assertEqual(rem_resp.status_code, 302)
        self.assertTrue(rem_resp.headers["Location"].endswith("/cart"))

        # Strict Helvetica font stack with Segoe UI across tokens.css & checkout.css.
        expected_stack = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, "Segoe UI", Arial, sans-serif'
        tokens_css = (ROOT / "app/static/css/tokens.css").read_text(encoding="utf-8")
        checkout_css = (ROOT / "app/static/css/checkout.css").read_text(encoding="utf-8")
        self.assertIn(expected_stack, tokens_css)
        self.assertIn(expected_stack, checkout_css)
        self.assertIn('html[data-theme="light"] .cart-empty-card', checkout_css)

    def test_intro_auth_gate_restructure_and_ai_slop_cleanup(self):
        intro_html = self.get_text("/intro")
        gate_slice = intro_html.split('id="intro-gate"', 1)[1].split("</section>", 1)[0]
        self.assertIn("Mulai Pengalaman Menontonmu", gate_slice)
        self.assertIn("Pilih metode autentikasi untuk melanjutkan:", gate_slice)

        # Strict button order in Masuk group: SSO UI -> Google -> Email.
        sso_idx = gate_slice.find("Masuk dengan SSO UI")
        google_idx = gate_slice.find("Masuk dengan Google")
        email_idx = gate_slice.find("Masuk dengan Email")
        reg_idx = gate_slice.find("Daftar Akun Baru")
        guest_idx = gate_slice.find("Lanjut Jelajah sebagai Tamu")
        self.assertGreater(sso_idx, -1)
        self.assertGreater(google_idx, sso_idx)
        self.assertGreater(email_idx, google_idx)
        self.assertGreater(reg_idx, email_idx)
        self.assertGreater(guest_idx, reg_idx)

        self.assertIn("Diskon 15%", gate_slice)
        self.assertIn('data-oauth-provider="Google"', gate_slice)
        self.assertIn('data-auth-open="login"', gate_slice)
        self.assertIn('data-auth-open="register"', gate_slice)
        self.assertNotIn("Mendapatkan promo &amp; poin reservasi", intro_html)
        self.assertNotIn("Bebas biaya tambahan", intro_html)
        self.assertNotIn("Dolly Zoom-in", intro_html)

        landing_html = self.get_text("/")
        self.assertNotIn("terhubung ke FoodEngine", landing_html)
        self.assertNotIn("nama@contoh.ac.id", landing_html)
        self.assertIn("nama@email.com", landing_html)

        viz_html = self.get_text("/visualizer/studio/xxi-regular")
        self.assertNotIn("Geser slider untuk menyesuaikan pandangan", viz_html)

        movie_html = self.get_text("/movie/sore")
        self.assertIn("Did You Know? (Trivia Film)", movie_html)
        self.assertIn("Cerita Films", movie_html)

        auth_js = (ROOT / "app/static/js/auth_modal.js").read_text(encoding="utf-8")
        self.assertNotIn("AuthEngine", auth_js)
        self.assertNotIn("mode pratinjau UI", auth_js)
        self.assertNotIn(DOUBLE_HYPHEN, auth_js)

    def test_final_ux_audit_eticket_stepper_spotlight_and_auth(self):
        # 1. Stepper guardrail: Step 3 locked in Step 2, Step 2 unlocked back link in Step 3.
        viz_html = self.get_text("/visualizer/studio/xxi-regular?film=sore")
        stepper_slice = viz_html.split('aria-label="Langkah pemesanan"', 1)[1].split("</nav>", 1)[0]
        self.assertIn('class="stepper__link is-disabled" aria-disabled="true"', stepper_slice)
        self.assertNotIn('href="/checkout/"', stepper_slice)

        c = create_app().test_client()
        self._login(c, "evans@example.com")
        layout = c.get("/visualizer/api/venues/xxi-regular/layout").get_json()
        free_seat = next(s["id"] for s in layout["seats"] if s["status"] == "available")
        add = c.post(
            "/visualizer/api/cart",
            json={
                "venue_id": "xxi-regular",
                "seat_id": free_seat,
                "film": "sore",
                "schedule": {"cinema": "AGORA MALL XXI", "date": "Sabtu, 14 Nov 2026", "time": "19:00 WIB"},
            },
        )
        self.assertIn(add.status_code, (200, 201))
        checkout_html = c.get("/checkout/").get_data(as_text=True)
        checkout_stepper = checkout_html.split('aria-label="Langkah pemesanan"', 1)[1].split("</nav>", 1)[0]
        self.assertIn('href="/visualizer/studio/xxi-regular?film=sore"', checkout_stepper)

        # 2. E-Ticket: realistic schedule & T&C, zero simulation POV stats, zero studio duplication.
        paid = c.post(
            "/checkout/pay",
            data={"name": "Evans Kano", "email": "evans@example.com", "method": "qris"},
        )
        self.assertEqual(paid.status_code, 302)
        ticket_html = c.get("/checkout/ticket").get_data(as_text=True)
        for token in (
            "Tanggal Tayang",
            "Waktu",
            "Studio &amp; Bioskop",
            "Kode Booking",
            "Sabtu, 14 Nov 2026",
            "19:00 WIB",
            "AGORA MALL XXI • Studio 1",
            "Syarat &amp; Ketentuan Penukaran:",
            "SORE: Istri dari Masa Depan",
        ):
            self.assertIn(token, ticket_html)
        for removed in ("Skor sightline", "Jarak pandang", "Halangan kepala", "Delay suara", "Istri dari Masa Depan · Regular"):
            self.assertNotIn(removed, ticket_html)
        self.assertNotIn(DOUBLE_HYPHEN, visible_text(ticket_html))

        # 3. Visualizer CSS/JS fixes + Spotlight Modal + clean seatmap surface + centered metrics + compact HUD.
        viz_css = (ROOT / "app/static/css/visualizer.css").read_text(encoding="utf-8")
        metric_block = viz_css.split(".pov-metric__value {", 1)[1].split("}", 1)[0]
        self.assertNotIn("text-overflow: ellipsis", metric_block)
        self.assertIn("white-space: normal", metric_block)
        self.assertIn("text-align: center", metric_block)
        hud_metrics_block = viz_css.split(".pov-hud-metrics {", 1)[1].split("}", 1)[0]
        self.assertIn("align-items: center", hud_metrics_block)
        self.assertIn("justify-items: center", hud_metrics_block)
        self.assertIn("text-align: center", hud_metrics_block)
        self.assertIn("z-index: 9998", viz_css)
        self.assertIn("backdrop-filter: blur(8px)", viz_css)
        self.assertIn("scale(0.95)", viz_css)
        self.assertIn("0.25s ease-out", viz_css)
        self.assertNotIn('url("../reference_assets/images/bioskopbg.jpg")', viz_css)
        self.assertIn("visibility: hidden", viz_css.split(".viewport__veil.is-hidden {", 1)[1].split("}", 1)[0])

        light_css = (ROOT / "app/static/css/theme-light.css").read_text(encoding="utf-8")
        self.assertNotIn('url("../reference_assets/images/bioskopbg.jpg")', light_css)
        self.assertIn("background: #FFFFFF;\n  background-image: none;", light_css)

        lg_css = (ROOT / "app/static/css/liquid_glass.css").read_text(encoding="utf-8")
        self.assertIn(".viewport:not(.is-fullscreen-theater) .hud--tl.liquid-glass-dock", lg_css)
        self.assertIn("padding: 6px 10px;", lg_css)
        self.assertIn("font-size: 12px;", lg_css)
        self.assertIn("font-size: 11px;", lg_css)

        map_js = (ROOT / "app/static/js/map_2d_picker.js").read_text(encoding="utf-8")
        self.assertNotIn("textContent = 'LAYAR'", map_js)

        # 4. Header & Auth harmonization across Catalog (/home), Visualizer, and Cart.
        for path in ("/home", "/visualizer/studio/xxi-regular", "/cart"):
            html = self.get_text(path)
            self.assertIn('data-auth-open="login"', html)
            self.assertIn('data-auth-open="register"', html)
            self.assertIn("Masuk", html)
            self.assertIn("Daftar", html)
            self.assertNotIn("Apple ID", html)
            self.assertNotIn('class="account-pill"', html)

            reg_view = html.split('data-auth-view="register"', 1)[1].split('data-auth-view="forgot"', 1)[0]
            sso_pos = reg_view.find("Daftar / Aktivasi Mahasiswa via SSO UI")
            google_pos = reg_view.find("Daftar Cepat dengan Google")
            form_pos = reg_view.find('name="full_name"')
            self.assertGreater(sso_pos, -1)
            self.assertGreater(google_pos, sso_pos)
            self.assertGreater(form_pos, google_pos)

    def test_curved_screen_generalized_concerts_and_top_parallax(self):
        # 1. Fullscreen Parallax Entrance sits at dedicated root '/' & catalog lives cleanly at '/home'.
        intro_html = self.get_text("/")
        self.assertIn('id="intro-stage"', intro_html)
        self.assertIn("FEEL THE MOMENTS BEYOND", intro_html)
        self.assertNotIn('<header class="site-header"', intro_html)
        self.assertNotIn('<footer class="site-footer', intro_html)
        self.assertIn('href="/home"', intro_html)

        landing_html = self.get_text("/home")
        self.assertNotIn('id="parallax-intro"', landing_html)
        self.assertNotIn('id="pov-showcase"', landing_html)
        self.assertIn('<header class="site-header">', landing_html)
        self.assertIn('<footer class="site-footer official-footer"', landing_html)
        cat_pos = landing_html.find('id="catalog-section"')
        hero_pos = landing_html.find('class="hero-stage"')
        lag_pos = landing_html.find('id="lagi-tayang"')
        self.assertGreater(cat_pos, -1)
        self.assertGreater(hero_pos, cat_pos)
        self.assertGreater(lag_pos, hero_pos)

        # 2. Exact 6 quick filter chips present & no "Konser GBK" in filters/header.
        for label in ("Semua", "Bioskop Terdekat", "IMAX Laser", "Konser Musik", "Hari Ini", "Besok"):
            self.assertIn(label, landing_html)
        header_html = landing_html.split("<header", 1)[1].split("</header>", 1)[0]
        self.assertIn("Konser Musik", header_html)
        self.assertIn('href="/concerts"', header_html)
        self.assertNotIn("Konser GBK", header_html)

        # 3. /concerts & /events return HTTP 200 and use Coldplay venue strictly on Coldplay card.
        for path in ("/concerts", "/events?type=concert"):
            resp = self.client.get(path)
            self.assertEqual(resp.status_code, 200)
            body = resp.get_data(as_text=True)
            self.assertIn("Konser Musik &amp; Festival", body)
            self.assertIn("Stadion Utama Gelora Bung Karno, Jakarta", body)

        # 4. 2D map curved screen + radial <path class="sight-cone"> & removed duplicate screen banner.
        studio_html = self.get_text("/visualizer/studio/xxi-imax")
        self.assertNotIn("AREA LAYAR", studio_html)
        self.assertNotIn("cinema-screen-banner", studio_html)
        map_js = (ROOT / "app/static/js/map_2d_picker.js").read_text(encoding="utf-8")
        self.assertIn("this.cone = svg('path', { class: 'sight-cone'", map_js)
        self.assertIn("_buildScreenArc", map_js)
        self.assertIn("LAYAR IMAX", map_js)

        # 5. Authentic empty hourglass symbol registered & wired in auth_modal.js without '--'.
        icons_html = (ROOT / "app/templates/_icons.html").read_text(encoding="utf-8")
        self.assertIn('id="i-hourglass-empty"', icons_html)
        auth_js = (ROOT / "app/static/js/auth_modal.js").read_text(encoding="utf-8")
        self.assertIn("#i-hourglass-empty", auth_js)
        self.assertIn('oauthBtn.closest("#intro-gate") ? "/home" : ""', auth_js)
        self.assertIn('window.location.href = "/home"', auth_js)

    def test_promo_page_and_navigation_links(self):
        promo_html = self.get_text("/promo")
        self.assertIn('data-step="promo"', promo_html)
        self.assertIn("Promo &amp; Syarat Ketentuan", promo_html)
        self.assertIn('data-promo-filter="bioskop" aria-pressed="false">Bioskop</button>', promo_html)
        self.assertIn('data-promo-filter="konser" aria-pressed="false">Konser</button>', promo_html)
        self.assertNotIn("Bioskop XXI", promo_html)
        self.assertNotIn("Konser GBK", promo_html.split("</header>", 1)[0])
        self.assertIn("Diskon Sivitas Akademika Universitas Indonesia 15%", promo_html)
        self.assertIn("Cashback Instan QRIS &amp; Dompet Digital 10%", promo_html)
        self.assertIn("Hemat Studio IMAX Laser &amp; 4DX Motion", promo_html)
        self.assertIn("Prioritas Zona Konser &amp; Bebas Biaya Admin VA", promo_html)
        self.assertIn("Bundling Camilan Bioskop &amp; Stadion titiket.food", promo_html)
        self.assertIn("Syarat &amp; Ketentuan Promo", promo_html)
        self.assertIn("Ketentuan Umum Promo titiket.com", promo_html)
        self.assertNotIn(DOUBLE_HYPHEN, visible_text(promo_html))

        landing_html = self.get_text("/home")
        self.assertIn("Diskon Khusus Mahasiswa UI 15%", landing_html)
        self.assertIn("Verifikasi SSO UI sekali klik saat checkout bioskop &amp; konser!", landing_html)
        self.assertIn("liquid-glass-btn-primary", landing_html)
        self.assertIn(">Aktifkan SSO UI<", landing_html)
        self.assertNotIn("sso-strip__all", landing_html)

        # Unified global top navbar consistency across catalog (/home), promo, cart, movie detail, and visualizer.
        for path in ("/home", "/promo", "/cart", "/movie/sore", "/visualizer/studio/xxi-regular"):
            with self.subTest(unified_header=path):
                page_html = self.get_text(path)
                header = page_html.split('<header class="site-header">', 1)[1].split("</header>", 1)[0]
                for token in ('class="brand-logo"', 'id="city-selector"', 'id="catalog-search"',
                              "Cari film, bioskop, atau konser...", 'id="theme-toggle"',
                              'data-auth-open="login"', 'data-auth-open="register"', 'href="/cart"'):
                    self.assertIn(token, header)
                for removed_nav in ("cart-site-nav", "promo-nav", "Lagi Tayang", "Konser GBK"):
                    self.assertNotIn(removed_nav, header)

        promo_css = (ROOT / "app/static/css/promo.css").read_text(encoding="utf-8")
        self.assertIn('html[data-theme="dark"] .promo-card', promo_css)
        self.assertIn(".promo-terms-list", promo_css)

        promo_tpl = (ROOT / "app/blueprints/landing/templates/landing/promo.html").read_text(encoding="utf-8")
        self.assertNotIn("-" * 2, promo_tpl)

    def test_master_modal_and_auth_guard_architecture(self):
        app = create_app()
        guest = app.test_client()
        layout = guest.get("/visualizer/api/venues/xxi-regular/layout").get_json()
        seat_one, seat_two = [s["id"] for s in layout["seats"] if s["status"] == "available"][:2]

        # 1. Guest blocked from checkout GET, pending POST, and pay POST.
        self.assertEqual(guest.post("/visualizer/api/cart", json={"venue_id": "xxi-regular", "seat_id": seat_one}).status_code, 201)
        guest_get = guest.get("/checkout/")
        self.assertEqual(guest_get.status_code, 302)
        self.assertIn("auth=required", guest_get.headers["Location"])
        self.assertEqual(guest.post("/checkout/pending", json={"name": "Guest", "email": "g@example.com", "method": "bca"}).status_code, 401)
        self.assertEqual(guest.post("/checkout/pay", json={"name": "Guest", "email": "g@example.com", "method": "bca"}).status_code, 401)

        # 2. Collision response returns Modal B metadata to second session.
        other = app.test_client()
        collision = other.post("/visualizer/api/cart", json={"venue_id": "xxi-regular", "seat_id": seat_one})
        self.assertEqual(collision.status_code, 409)
        cdata = collision.get_json()
        self.assertEqual(cdata["conflict_kind"], "collision")
        self.assertEqual(cdata["conflict_seat_id"], seat_one)
        self.assertFalse(cdata["conflict_standing"])

        # 3. Register + login + pending order creation + cancel actions + profile 3 tabs.
        reg = guest.post("/auth/register", json={
            "full_name": "Budi Mahasiswa",
            "email": "budi@ui.ac.id",
            "password": "password123",
            "agree_terms": True,
        })
        self.assertEqual(reg.status_code, 200)
        self.assertTrue(reg.get_json()["user"]["is_ui_student"])

        pending = guest.post("/checkout/pending", json={
            "name": "Budi Mahasiswa",
            "email": "budi@ui.ac.id",
            "method": "bca",
        })
        self.assertEqual(pending.status_code, 200)
        order_code = pending.get_json()["order"]["code"]

        checkout_page = guest.get("/checkout/").get_data(as_text=True)
        self.assertIn("Saya sudah bayar, terbitkan e-tiket", checkout_page)
        self.assertIn(order_code, checkout_page)
        self.assertIn('id="pay-submit-btn"', checkout_page)
        self.assertNotIn('id="confirm-paid-btn"', checkout_page)
        self.assertIn('id="payment-error-banner"', checkout_page)

        # Profile renders 3 tabs + pending order countdown.
        profile_html = guest.get("/profile").get_data(as_text=True)
        for token in ("Menunggu Pembayaran", "Riwayat Pemesanan", "Dibatalkan", order_code, "Lanjutkan Pembayaran"):
            self.assertIn(token, profile_html)
        self.assertNotIn(DOUBLE_HYPHEN, visible_text(profile_html))

        # Switch payment method keeps items unlocked without clearing cart.
        unlock_res = guest.post("/checkout/cancel", json={"action": "change_method", "order_code": order_code})
        self.assertEqual(unlock_res.status_code, 200)
        self.assertTrue(unlock_res.get_json()["unlocked"])

        # Re-pay & verify Completed tab shows Lihat E-Tiket modal template.
        paid = guest.post("/checkout/pay", data={"name": "Budi Mahasiswa", "email": "budi@ui.ac.id", "method": "qris"})
        self.assertEqual(paid.status_code, 302)
        profile_paid = guest.get("/profile?tab=completed").get_data(as_text=True)
        self.assertIn("Lihat E-Tiket", profile_paid)
        self.assertIn("QR Code Tiket", profile_paid)

        # New order cancelled -> appears under Dibatalkan tab.
        self.assertEqual(guest.post("/visualizer/api/cart", json={"venue_id": "xxi-regular", "seat_id": seat_two}).status_code, 201)
        p2 = guest.post("/checkout/pending", json={"name": "Budi", "email": "budi@ui.ac.id", "method": "mandiri"}).get_json()["order"]["code"]
        c_res = guest.post("/checkout/cancel", json={
            "action": "cancel_order",
            "reason": "Batal beli / Kembali ke Beranda",
            "order_code": p2,
        })
        self.assertEqual(c_res.status_code, 200)
        profile_cancel = guest.get("/profile?tab=cancelled").get_data(as_text=True)
        self.assertIn("Batal beli / Kembali ke Beranda", profile_cancel)

        # Visualizer telemetry cleanup: no #media-note, audio strictly in #bars.
        viz_html = guest.get("/visualizer/studio/xxi-regular").get_data(as_text=True)
        self.assertNotIn('id="media-note"', viz_html)
        self.assertIn("Musik:", viz_html)

    def test_enterprise_footer_structure_links_and_social_icons(self):
        html = self.get_text("/home")
        footer_match = re.search(r"<footer\b[^>]*>.*?</footer>", html, re.S)
        self.assertIsNotNone(footer_match)
        footer_html = footer_match.group(0)

        for expected in (
            "Perusahaan &amp; Legalitas",
            "PT Titiket Hiburan Nusantara &middot; Terdaftar PSE Kominfo RI.",
            "Gedung Fasilkom UI, Kampus UI Depok, Jawa Barat 16424.",
            "Film Sedang Tayang (XXI, IMAX, CGV)",
            "Film Segera Tayang",
            "Konser Musik &amp; Festival",
            "Simulasi POV 3D Kursi",
            "Sewa Studio &amp; Event Organizer",
            "+62 812-8484-5387 (24/7)",
            "bantuan@titiket.com",
            "Syarat &amp; Ketentuan Tiket Konser",
            "Kebijakan Privasi &amp; Pengembalian Dana",
            "Keamanan Akun &amp; Verifikasi E-Tiket",
            "Seluruh transaksi diamankan dengan enkripsi 256-bit SSL &amp; standar Bank Indonesia.",
        ):
            self.assertIn(expected, footer_html)

        self.assertNotIn("Ikuti Kami:", footer_html)

        for slug in ("youtube", "instagram", "tiktok", "x", "linkedin"):
            icon_rel = f"images/icons/social/{slug}.svg"
            self.assertIn(icon_rel, footer_html)
            with self.client.get(f"/static/{icon_rel}") as resp:
                self.assertEqual(resp.status_code, 200, icon_rel)
                self.assertIn("<svg", resp.get_data(as_text=True))

        # Every internal anchor inside footer must resolve cleanly.
        internal_hrefs = re.findall(r'href="(/[^"]*)"', footer_html)
        self.assertTrue(internal_hrefs)
        for href in internal_hrefs:
            path_only = href.split("#", 1)[0] or "/"
            with self.subTest(href=path_only):
                with self.client.get(path_only, follow_redirects=True) as resp:
                    self.assertEqual(resp.status_code, 200, href)

    def test_ui_refinements_seat_insight_spectrum_and_checkout_aaa(self):
        movie_html = self.get_text("/movie/the-nun")
        bottom_bar = movie_html.split('class="movie-bottom-bar__actions"', 1)[1].split("</div>", 1)[0]
        self.assertIn("Tonton Trailer", bottom_bar)
        self.assertIn("Pilih Jadwal &amp; Kursi", bottom_bar)
        self.assertNotIn("Simulasi POV 3D", bottom_bar)

        viz_html = self.get_text("/visualizer/studio/xxi-regular")
        self.assertNotIn('id="eye-note"', viz_html)
        self.assertNotIn('id="preset-desc"', viz_html)
        self.assertIn('id="score-ring-wrap"', viz_html)
        self.assertIn('class="score-badge"', viz_html)
        self.assertIn('liquid-glass-btn-primary" id="btn-checkout"', viz_html)
        self.assertIn('liquid-glass-badge" id="checkout-count"', viz_html)
        self.assertNotIn("Skor keseluruhan tertinggi", viz_html)

        viz_js = (ROOT / "app/static/js/visualizer_app.js").read_text(encoding="utf-8")
        self.assertNotIn("(Duduk Bernomor)", viz_js)
        self.assertNotIn("Tinggi mata ${fixed", viz_js)
        for token in ("#15803D", "#22C55E", "rgba(34, 197, 94, 0.15)", "#CA8A04", "#EAB308",
                      "rgba(234, 179, 8, 0.15)", "#DC2626", "#EF4444", "rgba(239, 68, 68, 0.15)"):
            self.assertIn(token, viz_js)

        lg_css = (ROOT / "app/static/css/liquid_glass.css").read_text(encoding="utf-8")
        tokens_css = (ROOT / "app/static/css/tokens.css").read_text(encoding="utf-8")
        light_css = (ROOT / "app/static/css/theme-light.css").read_text(encoding="utf-8")
        self.assertIn(".liquid-glass-btn-primary", lg_css)
        self.assertIn(".liquid-glass-badge", lg_css)
        self.assertIn(":not(.liquid-glass-btn-primary)", tokens_css)
        self.assertNotIn(".insight__score,", light_css)

        presets = self.client.get("/visualizer/api/venues/xxi-regular/layout").get_json()["presets"]
        for item in presets:
            self.assertNotIn("Skor keseluruhan tertinggi", item.get("description", ""))

    def test_intro_silhouette_scale_and_balanced_responsive_grids(self):
        intro_css = (ROOT / "app/static/css/intro.css").read_text(encoding="utf-8")
        self.assertIn("padding-bottom: 0;", intro_css)
        self.assertIn("height: clamp(205px, min(62dvh, 108vw), 680px);", intro_css)
        self.assertIn("bottom: clamp(46px, 14.5dvh, 175px);", intro_css)
        self.assertIn("@media (max-height: 460px) and (orientation: landscape)", intro_css)

        landing_html = self.get_text("/home")
        self.assertIn('id="now-playing-grid"\n          data-visible-count="10"', landing_html)
        self.assertIn('id="coming-soon-grid"\n          data-visible-count="5"', landing_html)

        landing_js = (ROOT / "app/static/js/landing.js").read_text(encoding="utf-8")
        self.assertIn("nowPlayingGrid.dataset.visibleCount", landing_js)
        self.assertIn("comingSoonGrid.dataset.visibleCount", landing_js)

        landing_css = (ROOT / "app/static/css/landing.css").read_text(encoding="utf-8")
        self.assertIn("grid-column: 2 / span 2;", landing_css)
        self.assertIn("grid-column: 4 / span 2;", landing_css)
        self.assertIn('.poster-grid[data-visible-count="5"]', landing_css)
        self.assertIn('.poster-grid[data-visible-count="4"]', landing_css)

        detail_css = (ROOT / "app/static/css/detail.css").read_text(encoding="utf-8")
        self.assertNotIn("grid-template-columns: repeat(auto-fit", detail_css)
        self.assertIn(".detail__quick-meta:has(> :nth-child(4):last-child)", detail_css)

        checkout_css = (ROOT / "app/static/css/checkout.css").read_text(encoding="utf-8")
        self.assertNotIn("repeat(auto-fit, minmax(120px, 1fr))", checkout_css)
        self.assertIn(".pov-meta:has(> :nth-child(5):last-child)", checkout_css)

        viz_css = (ROOT / "app/static/css/visualizer.css").read_text(encoding="utf-8")
        self.assertNotIn("repeat(auto-fill, minmax(130px, 1fr))", viz_css)
        self.assertIn("--cat-cols: 3;", viz_css)


if __name__ == "__main__":
    unittest.main()
