"""
Tes otomatis mesin Python + route Flask.

Jalankan dari folder proyek:
    python -m unittest discover -s tests -v
"""
from __future__ import annotations

import math
import unittest

from app import create_app
from app.blueprints.visualizer.engine.acoustics import (
    propagation_delay_ms, speed_of_sound, spreading_loss_db,
)
from app.blueprints.visualizer.engine.geometry_3d import (
    AABB, Vec3, angular_size_deg, direction_from_yaw_pitch, euclidean_distance, lens_for,
    yaw_pitch_between,
)
from app.blueprints.visualizer.engine.obstruction import MAX_BODY_CM, MIN_BODY_CM, Anthropometry, Posture
from app.blueprints.visualizer.engine.pov_engine import engine_for
from app.blueprints.visualizer.engine.sightline_ai import SmartSeatRecommender
from app.blueprints.visualizer.models import SeatNotFoundError, get_venue, venue_registry
from app.blueprints.visualizer.models.base_venue import SeatNode, TargetStage, Venue
from app.shared_state import EVENTS

CINEMAS = ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx")
GBK = "gbk-coldplay"


def pov(venue_id: str, selector: dict, body: float = 170, front: float = 170, target: str | None = None):
    venue = get_venue(venue_id)
    return engine_for(venue_id).evaluate(venue.resolve_seat(selector), body, front, target)


class GeometryTests(unittest.TestCase):
    def test_euclidean_distance(self):
        self.assertAlmostEqual(euclidean_distance(Vec3(0, 0, 0), Vec3(3, 4, 12)), 13.0)

    def test_yaw_pitch_round_trip(self):
        eye, target = Vec3(2.0, 1.2, 9.0), Vec3(-3.0, 4.5, 0.0)
        yaw, pitch = yaw_pitch_between(eye, target)
        direction = direction_from_yaw_pitch(yaw, pitch)
        expected = (target - eye).normalized()
        for got, want in zip(direction, expected):
            self.assertAlmostEqual(got, want, places=9)

    def test_looking_straight_ahead_is_zero_yaw(self):
        yaw, pitch = yaw_pitch_between(Vec3(0, 1, 10), Vec3(0, 1, 0))
        self.assertAlmostEqual(yaw, 0.0)
        self.assertAlmostEqual(pitch, 0.0)

    def test_aabb_segment(self):
        box = AABB(Vec3(-1, 0, -1), Vec3(1, 2, 1))
        self.assertTrue(box.segment_hits(Vec3(-5, 1, 0), Vec3(5, 1, 0)))
        self.assertFalse(box.segment_hits(Vec3(-5, 3, 0), Vec3(5, 3, 0)))
        self.assertFalse(box.segment_hits(Vec3(-5, 1, 0), Vec3(-2, 1, 0)))

    def test_angular_size(self):
        self.assertAlmostEqual(angular_size_deg(2.0, 1.0), 90.0)

    def test_lens_fov_order(self):
        self.assertGreater(lens_for("wide").vertical_fov_deg, lens_for("normal").vertical_fov_deg)
        self.assertGreater(lens_for("normal").vertical_fov_deg, lens_for("zoom").vertical_fov_deg)
        self.assertAlmostEqual(lens_for("normal").vertical_fov_deg, 55.0)
        self.assertEqual(lens_for("tidak-ada").mode.value, "normal")


class AnthropometryTests(unittest.TestCase):
    def test_height_is_clamped(self):
        self.assertEqual(Anthropometry.from_cm(999).stature_cm, MAX_BODY_CM)
        self.assertEqual(Anthropometry.from_cm(-5).stature_cm, MIN_BODY_CM)
        self.assertEqual(Anthropometry.from_cm("abc").stature_cm, 170.0)
        self.assertEqual(Anthropometry.from_cm(float("nan")).stature_cm, 170.0)

    def test_eye_height_by_posture(self):
        person = Anthropometry.from_cm(170)
        standing, _ = person.eye_offsets(Posture.STANDING)
        seated, back = person.eye_offsets(Posture.SEATED, 0.44)
        reclined, lean = person.eye_offsets(Posture.RECLINED, 0.44, 22.0)
        self.assertAlmostEqual(standing, 1.5912)
        self.assertAlmostEqual(seated, 0.44 + 0.456 * 1.7)
        self.assertEqual(back, 0.0)
        self.assertLess(reclined, seated)
        self.assertGreater(lean, 0.0)

    def test_taller_viewer_has_higher_eye(self):
        low = pov("xxi-regular", {"seat_id": "F9"}, body=145).eye.y
        high = pov("xxi-regular", {"seat_id": "F9"}, body=195).eye.y
        self.assertAlmostEqual(high - low, 0.456 * 0.50, places=6)


class ObstructionTests(unittest.TestCase):
    def test_front_row_has_no_obstruction(self):
        venue = get_venue("xxi-regular")
        front_row_seat = venue._grid[0][8]
        report = engine_for("xxi-regular").evaluate(front_row_seat, 145, 195)
        self.assertEqual(report.obstruction.blocked_pct, 0.0)
        self.assertFalse(report.front_spectator)

    def test_short_viewer_behind_tall_person_is_blocked(self):
        blocked = pov("xxi-regular", {"seat_id": "A9"}, body=150, front=192)
        clear = pov("xxi-regular", {"seat_id": "A9"}, body=192, front=150)
        self.assertGreater(blocked.obstruction.blocked_height_pct, 10.0)
        self.assertTrue(blocked.obstruction.subtitle_blocked)
        self.assertEqual(clear.obstruction.blocked_height_pct, 0.0)
        self.assertLess(blocked.score.total, clear.score.total)

    def test_festival_obstruction_decreases_with_height(self):
        values = [pov(GBK, {"seat_id": "festival:spot3"}, body=h).obstruction.blocked_pct
                  for h in range(145, 196, 10)]
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertGreater(values[0] - values[-1], 15.0)

    def test_taller_front_person_blocks_more_in_festival(self):
        short = pov(GBK, {"seat_id": "festival:spot3"}, front=150).obstruction.blocked_pct
        tall = pov(GBK, {"seat_id": "festival:spot3"}, front=195).obstruction.blocked_pct
        self.assertGreater(tall, short)


class AcousticsTests(unittest.TestCase):
    def test_speed_of_sound(self):
        self.assertAlmostEqual(speed_of_sound(20.0), 343.2, delta=0.3)

    def test_delay_at_135_m(self):
        self.assertAlmostEqual(propagation_delay_ms(135.0, 28.0), 388.0, delta=3.0)

    def test_inverse_square_law(self):
        self.assertAlmostEqual(spreading_loss_db(20.0, 10.0), 6.02, places=2)

    def test_line_array_near_field_loses_3_db_per_doubling(self):
        self.assertAlmostEqual(spreading_loss_db(20.0, 10.0, line_length_m=9.0), 3.01, places=2)

    def test_far_seat_is_later_and_quieter(self):
        near = pov(GBK, {"seat_id": "festival:spot1"}).acoustics
        far = pov(GBK, {"block_id": "cat6", "band": "belakang", "side": "tengah"}).acoustics
        self.assertGreater(far.delay_ms, near.delay_ms + 300.0)
        self.assertLess(far.spl_db, near.spl_db)
        self.assertLess(far.lowpass_hz, near.lowpass_hz)


class OopTests(unittest.TestCase):
    def test_abstract_classes_cannot_be_instantiated(self):
        for abstract in (Venue, SeatNode, TargetStage):
            with self.assertRaises(TypeError):
                abstract()      # type: ignore[abstract]

    def test_registry_is_polymorphic(self):
        registry = venue_registry()
        self.assertEqual(list(registry), [*CINEMAS, GBK])
        for venue in registry.values():
            self.assertIsInstance(venue, Venue)
            self.assertIsInstance(venue.primary_target, TargetStage)

    def test_seat_counts(self):
        expected = {"xxi-regular": 13 * 18, "xxi-premiere": 5 * 8, "xxi-imax": 14 * 22, "xxi-4dx": 8 * 16}
        for venue_id, count in expected.items():
            self.assertEqual(len(get_venue(venue_id).candidate_seats()), count)

    def test_row_a_is_the_back_row(self):
        venue = get_venue("xxi-regular")
        self.assertGreater(venue.resolve_seat({"seat_id": "A1"}).floor_position.z,
                           venue.resolve_seat({"seat_id": "M1"}).floor_position.z)

    def test_unknown_seat_raises(self):
        with self.assertRaises(SeatNotFoundError):
            get_venue("xxi-regular").resolve_seat({"seat_id": "Z99"})
        with self.assertRaises(SeatNotFoundError):
            get_venue(GBK).resolve_seat({"seat_id": "cat3:R999:S1"})
        with self.assertRaises(SeatNotFoundError):
            get_venue("tidak-ada")


class ScoreTests(unittest.TestCase):
    def test_scores_are_within_range(self):
        for venue_id in venue_registry():
            for cell in engine_for(venue_id).heatmap():
                self.assertGreaterEqual(cell["score"], 0.0)
                self.assertLessEqual(cell["score"], 100.0)

    def test_center_beats_edge_in_same_row(self):
        center = pov("xxi-imax", {"seat_id": "D11"}).score.total
        edge = pov("xxi-imax", {"seat_id": "D1"}).score.total
        self.assertGreater(center, edge)

    def test_restricted_view_sees_less(self):
        cat3 = pov(GBK, {"block_id": "cat3", "band": "tengah", "side": "tengah"})
        cat8 = pov(GBK, {"block_id": "cat8b", "band": "tengah", "side": "tengah"})
        self.assertGreater(cat3.metrics.visible_pct, cat8.metrics.visible_pct + 40.0)
        self.assertGreater(cat8.targets["b_stage"].stage_visible_pct, 50.0)   # runway/B-Stage tetap terlihat

    def test_target_switch_changes_camera(self):
        main = pov(GBK, {"seat_id": "festival:spot2"}, target="main_stage").to_dict()["camera"]
        b_stage = pov(GBK, {"seat_id": "festival:spot2"}, target="b_stage").to_dict()["camera"]
        self.assertNotAlmostEqual(main["yaw_rad"], b_stage["yaw_rad"], places=2)


class RecommenderTests(unittest.TestCase):
    def _recommender(self, venue_id: str) -> SmartSeatRecommender:
        engine = engine_for(venue_id)
        return SmartSeatRecommender(get_venue(venue_id), lambda seat: engine.evaluate(seat))

    def test_every_preset_returns_three_seats(self):
        for venue_id, venue in venue_registry().items():
            recommender = self._recommender(venue_id)
            for preset in recommender.presets_for(venue.kind.value):
                result = recommender.recommend(preset["key"])
                picks = result["recommendations"]
                self.assertEqual(len(picks), 3, f"{venue_id}/{preset['key']}")
                self.assertEqual(len({p["seat_id"] for p in picks}), 3)
                self.assertTrue(all(p["reasons"] for p in picks))

    def test_recommended_seats_are_not_adjacent(self):
        venue = get_venue("xxi-regular")
        picks = self._recommender("xxi-regular").recommend("ideal_thx")["recommendations"]
        seats = [venue.resolve_seat({"seat_id": p["seat_id"]}) for p in picks]
        for i, seat in enumerate(seats):
            for other in seats[i + 1:]:
                self.assertFalse(seat.is_adjacent_to(other))

    def test_invalid_preset(self):
        with self.assertRaises(ValueError):
            self._recommender("xxi-regular").recommend("closest_bstage")   # hanya untuk konser


class StadiumSceneTests(unittest.TestCase):
    """Regresi scene 3D GBK: baris depan bersih, tinggi mata tribun, pilar di belakang LED samping."""

    def _row_one(self):
        return next(seat for seat in get_venue(GBK).candidate_seats()
                    if getattr(seat, "row", None) is not None and seat.row.number == 1)

    def test_front_row_has_nobody_in_front(self):
        data = engine_for(GBK).evaluate(self._row_one()).to_dict()
        self.assertTrue(data["seat_frame"]["is_front_row"])
        self.assertEqual(data["seat_frame"]["rows_ahead"], 0)
        self.assertFalse(data["front_spectator"]["present"])
        self.assertEqual(data["obstruction"]["blocked_height_pct"], 0.0)

    def test_tribune_eye_height_and_near_plane(self):
        seat = self._row_one()
        report = engine_for(GBK).evaluate(seat, 170)
        # mata = lantai undakan + 0,45 m (alas duduk) + ±0,75 m (alas duduk → mata)
        self.assertAlmostEqual(report.eye.y - seat.floor_position.y, 0.45 + 0.75, delta=0.03)
        self.assertEqual(report.to_dict()["camera"]["near"], 0.1)

    def test_clear_view_flags_crowd_and_restricted_seats_only(self):
        clear = lambda seat_id: pov(GBK, {"seat_id": seat_id}).clear_view_pct
        self.assertGreaterEqual(clear("cat3:R1:S188"), 85.0)       # tribun tengah baris depan: bebas
        self.assertLess(clear("cat8a:R27:S22"), 85.0)              # restricted view: pilar menutup panggung
        self.assertLess(clear("festival:spot3"), 85.0)             # tengah lapangan: kerumunan di depan
        self.assertEqual(pov("xxi-regular", {"seat_id": "F10"}).clear_view_pct, 100.0)

    def test_scaffold_pillars_sit_two_metres_behind_side_leds(self):
        venue = get_venue(GBK)
        stage = venue.primary_target
        pillar_front_z = max(o.box.max.z for o in venue.occluders() if o.kind == "pillar")
        for led in (stage.left_led, stage.right_led):
            led_rear_z = led.center.z - led.width / 2 * abs(led.normal.x)      # tepi LED yang paling belakang
            self.assertLessEqual(pillar_front_z, led_rear_z - 2.0)


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app({"TESTING": True})

    def setUp(self):
        self.client = self.app.test_client()

    def test_pages_render(self):
        for path in ("/", "/intro", "/home", "/visualizer/studio/xxi-regular", "/visualizer/studio/gbk-coldplay", "/cart"):
            self.assertEqual(self.client.get(path).status_code, 200, path)
        # V2: checkout kosong tidak lagi redirect, melainkan mode pratinjau dengan banner "belum ada tiket".
        empty_checkout = self.client.get("/checkout/")
        self.assertEqual(empty_checkout.status_code, 200)
        self.assertIn("checkout-preview-banner", empty_checkout.get_data(as_text=True))
        self.assertEqual(self.client.get("/visualizer/?event=coldplay-gbk").status_code, 302)
        self.assertEqual(self.client.get("/visualizer/studio/tidak-ada").status_code, 404)

    def test_landing_sends_every_event_to_the_visualizer(self):
        page = self.client.get("/home").get_data(as_text=True)
        for event in EVENTS.values():
            param = "event" if event.kind == "concert" else "film"
            self.assertIn(f"{param}={event.event_id}", page)
        self.assertIn("Lihat trailer", page)
        redirect = self.client.get("/visualizer/?type=cinema&film=la-la-land")
        self.assertIn("/visualizer/studio/xxi-regular?film=la-la-land", redirect.headers["Location"])
        # Trailer film pilihan yang diputar di layar 3D.
        layout = self.client.get("/visualizer/api/venues/xxi-regular/layout?film=la-la-land").get_json()
        self.assertEqual(layout["event"]["event_id"], "la-la-land")
        self.assertEqual(layout["media"]["video_label"], "La La Land")

    def test_visualizer_page_has_no_debug_text(self):
        for venue_id in ("xxi-regular", GBK):
            page = self.client.get(f"/visualizer/studio/{venue_id}").get_data(as_text=True)
            for banned in ("dihitung Python", "dihitung ulang oleh Python", "Upload Video", "Akustik", "THX", "SMPTE"):
                self.assertNotIn(banned, page, f"{venue_id}: {banned}")
            self.assertIn("Lihat Spesifikasi Teknis", page)
        labels = [p["label"] for v in ("cinema", "concert") for p in SmartSeatRecommender.presets_for(v)]
        self.assertFalse([label for label in labels if "Budget" in label or "Audio" in label])

    def test_layout_for_every_venue(self):
        for venue_id in venue_registry():
            response = self.client.get(f"/visualizer/api/venues/{venue_id}/layout")
            self.assertEqual(response.status_code, 200)
            data = response.get_json()
            self.assertEqual(data["venue_id"], venue_id)
            self.assertTrue(data["presets"] and data["lenses"] and data["targets"])

    def test_pov_response_shape(self):
        response = self.client.post("/visualizer/api/pov", json={
            "venue_id": "xxi-imax", "selector": {"seat_id": "D11"}, "body_height_cm": 999})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        for key in ("eye", "camera", "targets", "obstruction", "acoustics", "score", "front_spectator"):
            self.assertIn(key, data)
        self.assertEqual(data["viewer"]["body_height_cm"], MAX_BODY_CM)       # dijepit ke 195
        self.assertTrue(0.0 <= data["score"]["total"] <= 100.0)
        self.assertTrue(math.isfinite(data["camera"]["yaw_rad"]))

    def test_pov_errors(self):
        bad_seat = self.client.post("/visualizer/api/pov", json={"venue_id": "xxi-imax", "seat_id": "ZZ1"})
        self.assertEqual(bad_seat.status_code, 404)
        self.assertIn("error", bad_seat.get_json())
        bad_preset = self.client.post("/visualizer/api/recommend",
                                      json={"venue_id": "xxi-imax", "preset": "ngawur"})
        self.assertEqual(bad_preset.status_code, 400)

    def test_cart_flow_reaches_checkout(self):
        available = next(seat for seat in get_venue("xxi-regular").candidate_seats() if seat.is_available)
        body = {"venue_id": "xxi-regular", "seat_id": available.seat_id, "body_height_cm": 165}
        self.assertEqual(self.client.post("/visualizer/api/cart", json=body).status_code, 201)
        self.assertEqual(self.client.post("/visualizer/api/cart", json=body).get_json()["status"], "exists")
        # V2: tamu melihat halaman checkout; gerbang login berupa sheet modal (#auth-modal), bukan redirect 302.
        guest_checkout = self.client.get("/checkout/")
        self.assertEqual(guest_checkout.status_code, 200)
        self.assertIn('id="auth-modal"', guest_checkout.get_data(as_text=True))
        guest_pay = self.client.post("/checkout/pay", data={"method": "qris"})  # tanpa identitas pemesan
        self.assertEqual(guest_pay.status_code, 302)
        self.assertIn("auth=required", guest_pay.headers["Location"])
        self.assertEqual(
            self.client.post("/auth/login", json={"email": "penguji@example.com", "password": "password123"}).status_code,
            200,
        )
        page = self.client.get("/checkout/").get_data(as_text=True)
        self.assertIn(available.label, page)
        invalid = self.client.post("/checkout/pay", data={"name": "", "email": "x", "method": ""})
        self.assertEqual(invalid.status_code, 400)
        paid = self.client.post("/checkout/pay", data={
            "name": "Penguji DDP", "email": "penguji@example.com", "method": "qris"})
        self.assertEqual(paid.status_code, 302)
        ticket = self.client.get("/checkout/ticket").get_data(as_text=True)
        self.assertIn(available.label, ticket)

    def test_standing_ticket_never_says_kursi(self):
        """Area berdiri (Festival / My Universe): data POV dan pesan keranjang tidak memakai kata "kursi"."""
        self.assertEqual(
            self.client.post("/auth/login", json={"email": "konser@example.com", "password": "password123"}).status_code,
            200,
        )
        body = {"venue_id": GBK, "seat_id": "festival:spot1"}
        pov_json = self.client.post("/visualizer/api/pov", json=body).get_data(as_text=True)
        self.assertNotIn("kursi", pov_json.lower())
        added = self.client.post("/visualizer/api/cart", json=body)
        self.assertEqual(added.status_code, 201)
        again = self.client.post("/visualizer/api/cart", json=body).get_json()
        self.assertEqual(again["status"], "exists")
        for message in (added.get_json()["message"], again["message"]):
            self.assertNotIn("kursi", message.lower())
        checkout_resp = self.client.get("/checkout/")
        self.assertEqual(checkout_resp.status_code, 200)
        self.assertNotIn("kursi", checkout_resp.get_data(as_text=True).lower())
        seated = self.client.post("/visualizer/api/cart", json={"venue_id": GBK, "seat_id": "cat3:R1:S188"})
        self.assertIn("Kursi", seated.get_json()["message"])          # tribun duduk tetap menyebut kursi

    def test_landing_is_light_and_has_no_mtix(self):
        intro_page = self.client.get("/intro").get_data(as_text=True)
        self.assertIn('name="theme-color" content="#08090C"', intro_page)
        page = self.client.get("/home").get_data(as_text=True)
        self.assertIn('name="theme-color" content="#FFFFFF"', page)
        self.assertNotIn("m.tix", page.lower())
        self.assertNotIn("m-tix", page.lower())
        self.assertIn('name="theme-color" content="#FFFFFF"', self.client.get("/cart").get_data(as_text=True))
        self.assertIn('content="#0F0F23"', self.client.get("/visualizer/studio/xxi-regular").get_data(as_text=True))

    def test_static_assets_exist(self):
        for path in ("/static/js/vendor/three.module.min.js", "/static/css/tokens.css",
                     "/static/css/visualizer.css", "/static/js/visualizer_app.js",
                     "/static/js/map_2d_picker.js", "/static/js/pov_3d_three.js"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            response.close()


if __name__ == "__main__":
    unittest.main()
