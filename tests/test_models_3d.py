"""Tes integrasi model 3D (GLB/glTF) + angka kamera POV bioskop dan konser.

Termasuk kalibrasi SUGBK (lantai 165 × 110 m, buffer lintasan, jarak tribun), The Premiere (baris ≥ 1,9 m,
sandaran kaki rata, mata 1,18 m), dan kunci scroll fullscreen. Yang diuji di sisi server: berkas model & tekstur ada dan disajikan Flask (bukan 404), importmap
`three/addons/` terpasang, FOV bioskop 65–70°, tinggi mata duduk 1,15–1,25 m, tinggi mata berdiri
1,65–1,75 m, dan spot Festival ±28 m dari bibir panggung. Render WebGL-nya diverifikasi di browser.
"""

from __future__ import annotations

import json
import struct
import unittest
from pathlib import Path

from app import create_app
from app.blueprints.visualizer.models import get_venue

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "app" / "static" / "models"


def glb_json(path: Path) -> dict:
    data = path.read_bytes()
    magic, version, _length = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and version == 2
    chunk_length, chunk_type = struct.unpack("<I4s", data[12:20])
    assert chunk_type == b"JSON"
    return json.loads(data[20:20 + chunk_length])


def glb_triangles(path: Path) -> int:
    """Jumlah segitiga di GLB: jumlah indeks akses ÷ 3 untuk tiap primitif."""
    gltf = glb_json(path)
    total = 0
    for mesh in gltf["meshes"]:
        for primitive in mesh["primitives"]:
            total += gltf["accessors"][primitive["indices"]]["count"] // 3
    return total


class ModelFilesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()

    def test_three_model_folders_are_in_static_models(self):
        for folder in ("camp_nou_stadium", "cinema_theater_lounge_sofa", "cinemamovie_theater_interior"):
            self.assertTrue((MODELS / folder).is_dir(), folder)
        # camp_nou_stadium/ boleh tetap ada di disk, tetapi TIDAK dimuat (lihat SceneSourceGuardTests).

    def test_no_zip_left_in_project_root(self):
        self.assertEqual(list(ROOT.glob("*.zip")), [])

    def test_hall_seat_has_4000_to_6000_triangles_and_real_dimensions(self):
        seat = MODELS / "cinemamovie_theater_interior" / "seat.glb"
        triangles = glb_triangles(seat)
        self.assertTrue(4000 <= triangles <= 6000, triangles)          # bantalan/headrest membulat, bukan 1.036 poligon kaku
        gltf = glb_json(seat)
        position = next(a for a in gltf["accessors"] if a["type"] == "VEC3" and "min" in a and a["max"][1] > 0.5)
        self.assertAlmostEqual(position["max"][1], 0.829, delta=0.03)  # tinggi kursi tetap ±0,83 m

    def test_asset_tool_is_runnable_from_repo(self):
        package = json.loads((ROOT / "tools" / "package.json").read_text(encoding="utf-8"))
        for dependency in ("@gltf-transform/core", "@gltf-transform/functions", "meshoptimizer"):
            self.assertIn(dependency, package["dependencies"])
        source = (ROOT / "tools" / "build_model_assets.mjs").read_text(encoding="utf-8")
        self.assertIn("function loopSubdivide(", source)
        self.assertIn("subdivide: /brown/i", source)

    def test_optimized_assets_exist_and_are_light(self):
        seat = MODELS / "cinemamovie_theater_interior" / "seat.glb"
        sofa = MODELS / "cinema_theater_lounge_sofa" / "sofa_lod.glb"
        for path, max_bytes in ((seat, 250_000), (sofa, 3_000_000)):
            self.assertTrue(path.is_file(), path.name)
            self.assertLess(path.stat().st_size, max_bytes, path.name)
            self.assertEqual(glb_json(path)["asset"]["version"], "2.0")
            response = self.client.get(f"/static/models/{path.parent.name}/{path.name}")
            self.assertEqual(response.status_code, 200)
            response.close()

    def test_studio_page_maps_three_addons_for_gltf_loader(self):
        html = self.client.get("/visualizer/studio/xxi-imax").get_data(as_text=True)
        self.assertIn('"three/addons/"', html)
        for vendored in ("loaders/GLTFLoader.js", "utils/BufferGeometryUtils.js"):
            self.assertTrue((ROOT / "app/static/js/vendor/three-addons" / vendored).is_file(), vendored)
        self.assertTrue((ROOT / "app/static/js/model_assets.js").is_file())


class PovCameraNumbersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()

    def pov(self, **body):
        response = self.client.post("/visualizer/api/pov", json=body)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    def test_cinema_fov_is_between_65_and_70_degrees(self):
        for venue_id in ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx"):
            seat = get_venue(venue_id).default_selector()
            fov = self.pov(venue_id=venue_id, selector=seat)["camera"]["fov_deg"]
            self.assertTrue(65.0 <= fov <= 70.0, f"{venue_id}: {fov}")

    def test_cinema_lens_list_follows_base_fov(self):
        layout = self.client.get("/visualizer/api/venues/xxi-imax/layout").get_json()
        normal = next(lens for lens in layout["lenses"] if lens["mode"] == "normal")
        self.assertEqual(normal["vertical_fov_deg"], 68.0)
        self.assertIn("68", normal["label"])
        wide = next(lens for lens in layout["lenses"] if lens["mode"] == "wide")
        self.assertGreater(wide["vertical_fov_deg"], normal["vertical_fov_deg"])

    def test_concert_keeps_default_55_degree_lens(self):
        layout = self.client.get("/visualizer/api/venues/gbk-coldplay/layout").get_json()
        normal = next(lens for lens in layout["lenses"] if lens["mode"] == "normal")
        self.assertEqual(normal["vertical_fov_deg"], 55.0)

    def test_imax_row_f_seat_eye_height_is_seated_adult(self):
        report = self.pov(venue_id="xxi-imax", selector={"seat_id": "F15"}, body_height_cm=170)
        layout = self.client.get("/visualizer/api/venues/xxi-imax/layout").get_json()
        seat = next(s for s in layout["seats"] if s["id"] == "F15")
        eye = report["camera"]["position"]
        self.assertAlmostEqual(eye[0] - seat["x"], 0.0, delta=0.05)           # kamera tepat di kursi (x)
        self.assertAlmostEqual(eye[2], seat["z"], delta=0.05)                 # … dan z
        self.assertTrue(1.15 <= eye[1] - seat["y"] <= 1.25, eye[1] - seat["y"])

    def test_concert_default_viewer_gives_standing_eye_height(self):
        limits = self.client.get("/visualizer/api/venues/gbk-coldplay/layout").get_json()["limits"]
        self.assertEqual(limits["body_default_cm"], 178.0)
        cinema_limits = self.client.get("/visualizer/api/venues/xxi-imax/layout").get_json()["limits"]
        self.assertEqual(cinema_limits["body_default_cm"], 170.0)             # bioskop tidak berubah
        report = self.pov(venue_id="gbk-coldplay", selector={"block_id": "festival", "spot": 3})
        eye_y = report["camera"]["position"][1]
        self.assertTrue(1.65 <= eye_y <= 1.75, eye_y)

    def test_festival_spot_28m_from_stage_lip(self):
        layout = self.client.get("/visualizer/api/venues/gbk-coldplay/layout").get_json()
        spot = next(s for s in layout["standing_spots"] if s["number"] == 5)
        lip_z = layout["stage"]["deck"]["z1"]
        distance = ((spot["x"]) ** 2 + (spot["z"] - lip_z) ** 2) ** 0.5
        self.assertAlmostEqual(distance, 28.0, delta=1.0)
        report = self.pov(venue_id="gbk-coldplay", selector={"block_id": "festival", "spot": 5})
        self.assertTrue(1.65 <= report["camera"]["position"][1] <= 1.75)


class SugbkCalibrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()
        cls.layout = cls.client.get("/visualizer/api/venues/gbk-coldplay/layout").get_json()

    def test_floor_area_is_sugbk_165_by_110(self):
        ring = self.layout["bowl"]["field_edge"]
        width = max(p[0] for p in ring) - min(p[0] for p in ring)
        length = max(p[2] for p in ring) - min(p[2] for p in ring)
        self.assertTrue(105 <= width <= 115, width)
        self.assertTrue(160 <= length <= 170, length)

    def test_running_track_buffer_between_festival_area_and_lower_tier(self):
        bowl = self.layout["bowl"]
        outline = self.layout["field"]["outline"]
        half_x = max(abs(p[0]) for p in outline)
        south_z = max(p[1] for p in outline)
        self.assertTrue(12 <= bowl["rx_inner"] - half_x <= 15.5, bowl["rx_inner"] - half_x)         # sisi
        self.assertTrue(12 <= bowl["rz_inner"] - south_z <= 15.5, bowl["rz_inner"] - south_z)       # ujung selatan
        lower = bowl["tiers"][0]
        self.assertGreaterEqual(min(p[0] for p in lower["inner"] if abs(p[2]) < 1.0) * -1, half_x + 12)

    def test_all_festival_spots_stay_on_decking_clear_of_the_stage(self):
        outline = self.layout["field"]["outline"]
        lip_z = self.layout["stage"]["deck"]["z1"]
        for spot in self.layout["standing_spots"]:
            self.assertLessEqual(abs(spot["x"]), max(abs(p[0]) for p in outline), spot["key"])
            self.assertGreater(spot["z"], lip_z, spot["key"])                       # di luar struktur panggung
            self.assertLess(spot["z"], max(p[1] for p in outline), spot["key"])

    def test_spot5_is_28_4m_from_stage_lip_at_standing_eye_height(self):
        spot = next(s for s in self.layout["standing_spots"] if s["number"] == 5)
        lip_z = self.layout["stage"]["deck"]["z1"]
        self.assertAlmostEqual(((spot["x"]) ** 2 + (spot["z"] - lip_z) ** 2) ** 0.5, 28.4, delta=0.2)
        report = self.client.post("/visualizer/api/pov", json={
            "venue_id": "gbk-coldplay", "selector": {"block_id": "festival", "spot": 5}}).get_json()
        self.assertAlmostEqual(report["camera"]["position"][1], 1.666, delta=0.005)

    def test_tribune_distances_to_stage(self):
        # Sisi/depan/belakang panggung dan CAT 2–4 sisi: 40–130 m. Ujung selatan (CAT 3, 5, 6) fisiknya lebih
        # jauh karena lantai 165 m dengan panggung di satu ujung — diuji tidak melebihi jarak maksimal geometri.
        lip = (0.0, self.layout["stage"]["deck"]["z1"])
        farthest = 0.0
        for block in self.layout["blocks"]:
            if block["standing"]:
                continue
            distances = []
            for band in ("depan", "tengah", "belakang"):
                for side in ("kiri", "tengah", "kanan"):
                    eye = self.client.post("/visualizer/api/pov", json={
                        "venue_id": "gbk-coldplay",
                        "selector": {"block_id": block["id"], "band": band, "side": side}}).get_json()["eye"]
                    distances.append(((eye[0] - lip[0]) ** 2 + (eye[2] - lip[1]) ** 2) ** 0.5)
            farthest = max(farthest, max(distances))
            if block["id"] in ("cat2a", "cat2b_n", "cat4a", "cat4b", "ultimate", "cat1"):
                self.assertTrue(40 <= min(distances) and max(distances) <= 155, (block["id"], min(distances), max(distances)))
        self.assertLess(farthest, 190)


class CinemaPaletteTests(unittest.TestCase):
    """Dinding = panel kain akustik; plafon hitam pekat; jok beludru marun; karpet abu-abu gelap."""

    @classmethod
    def setUpClass(cls):
        client = create_app().test_client()
        cls.themes = {
            venue_id: client.get(f"/visualizer/api/venues/{venue_id}/layout").get_json()["theme"]
            for venue_id in ("xxi-regular", "xxi-premiere", "xxi-imax", "xxi-4dx")
        }

    @staticmethod
    def rgb(hex_color):
        return tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))

    def test_wall_fabric_panels_slate_charcoal_except_premiere_mocha(self):
        for venue_id in ("xxi-regular", "xxi-imax", "xxi-4dx"):
            self.assertIn(self.themes[venue_id]["wall"].upper(), ("#111622", "#161B26"), venue_id)
            r, g, b = self.rgb(self.themes[venue_id]["wall"])
            self.assertGreater(b, r, f"{venue_id}: arang kebiruan (slate)")
        premiere = self.themes["xxi-premiere"]
        self.assertEqual(premiere["wall"].upper(), "#1C1614")                         # dark mocha
        self.assertEqual(premiere["wall_accent"].upper(), "#29211D")                  # pilar walnut gelap

    def test_ceiling_is_pitch_black_everywhere(self):
        for venue_id, theme in self.themes.items():
            self.assertEqual(theme["ceiling"].upper(), "#08090C", venue_id)

    def test_nothing_is_pink_salmon_or_bright(self):
        for venue_id, theme in self.themes.items():
            for name in ("wall", "ceiling", "wall_accent", "carpet"):
                r, g, b = self.rgb(theme[name])
                self.assertLess(max(r, g, b), 0x40, f"{venue_id}.{name} terlalu terang")
                self.assertLessEqual(r - b, 12, f"{venue_id}.{name} kemerahan/pink")

    def test_regular_and_imax_seats_are_burgundy_velvet_and_carpet_charcoal_navy(self):
        self.assertEqual(self.themes["xxi-regular"]["seat"].lower(), "#6b1124")        # deep wine, bukan merah neon
        self.assertEqual(self.themes["xxi-imax"]["seat"].lower(), "#6b1124")
        for venue_id in self.themes:
            self.assertEqual(self.themes[venue_id]["carpet"].upper(), "#0E1118", venue_id)  # charcoal / deep navy


class PremiereAndFullscreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()

    def test_premiere_row_spacing_at_least_1_9_m(self):
        layout = self.client.get("/visualizer/api/venues/xxi-premiere/layout").get_json()
        rows = sorted({row["z"] for row in layout["rows"]})
        gaps = [b - a for a, b in zip(rows, rows[1:])]
        self.assertTrue(gaps and all(gap >= 1.9 - 1e-6 for gap in gaps), gaps)

    def test_premiere_eye_at_1_18_m_with_footrest_retracted(self):
        layout = self.client.get("/visualizer/api/venues/xxi-premiere/layout").get_json()
        report = self.client.post("/visualizer/api/pov", json={
            "venue_id": "xxi-premiere", "selector": {"seat_id": "C4"}, "body_height_cm": 170}).get_json()
        seat = next(s for s in layout["seats"] if s["id"] == "C4")
        self.assertAlmostEqual(report["eye"][1] - seat["y"], 1.18, delta=0.01)
        footrest = report["seat_frame"]["footrest"]
        self.assertFalse(footrest["raised"])
        self.assertLess(footrest["top_y"], 0.2)                                   # rata dengan lantai

    def test_fullscreen_locks_page_scroll_and_header(self):
        css = (ROOT / "app/static/css/visualizer.css").read_text(encoding="utf-8")
        for needle in ("html.is-theater-open", "body.is-theater-open", "overflow: hidden !important;",
                       "touch-action: none;", "z-index: 99999;", "inset: 0;", "width: 100vw;", "height: 100vh;"):
            self.assertIn(needle, css, needle)
        self.assertIn("body.is-theater-open .site-header", css)
        js = (ROOT / "app/static/js/visualizer_app.js").read_text(encoding="utf-8")
        self.assertIn("document.documentElement.classList.toggle('is-theater-open'", js)


class SceneSourceGuardTests(unittest.TestCase):
    """Penjaga regresi di pov_3d_three.js: lampu gaya bar/diskotik tidak boleh kembali."""

    @classmethod
    def setUpClass(cls):
        cls.js = (ROOT / "app/static/js/pov_3d_three.js").read_text(encoding="utf-8")

    def test_no_bar_style_lights_in_cinema(self):
        for forbidden in ("theme.sconce", "theme.lamp", "theme.step_light", "HemisphereLight(new THREE.Color(theme",
                          "0x1fbf62", "const lens = new THREE.Sprite", "SphereGeometry(0.06"):
            self.assertNotIn(forbidden, self.js, forbidden)

    def test_cinema_lighting_standard(self):
        self.assertIn("const floorTint = new THREE.Color(0x141926);", self.js)                # ambient lantai biru-malam sejuk
        self.assertIn("new THREE.AmbientLight(floorTint, ENTRANCE.floor * ENTRANCE.floorGain)", self.js)
        self.assertIn("new THREE.SpotLight(0xf0f0ff", self.js)

    def test_aisle_led_lights_are_amber_unlit_and_never_dimmed(self):
        self.assertIn("color: 0xf59e0b, transparent: true, opacity: 0.4", self.js)   # pendar amber lembut
        self.assertIn("this._basic(0xfef3c7", self.js)                                # inti LED
        # Lampu lorong tidak boleh disentuh updater dimming: tidak ada referensinya setelah updater didaftarkan.
        updaters = self.js[self.js.index("const seq = ENTRANCE;"):self.js.index("this._buildCinemaSeats(L);")]
        self.assertNotIn("ledGlow", updaters)
        self.assertNotIn("ledCore", updaters)

    def test_entrance_sequence_constants_match_spec(self):
        block = self.js[self.js.index("const ENTRANCE = {"):self.js.index("const XYLO_PALETTES")]
        for needle in ("hold: 0,", "dim: 3", "houseOff: 0,", "ignite: 2", "igniteFade: 1", "level: 0.65"):
            self.assertIn(needle, block, needle)
        self.assertNotIn("standby:", block)                                          # layar hitam total, bukan "redup"
        self.assertIn("new THREE.AmbientLight(0xffe8d6, 0)", self.js)                    # ambient warm champagne

    def test_entrance_state_machine_order(self):
        # ENTRANCE: layar hitam + video dijeda di frame 0 + proyektor mati; DIMMING: proyektor di detik 9 + layar
        # fade-in; SHOWTIME: video.play() hanya setelah lampu padam.
        self.assertIn("screenMesh.material.color.setScalar(state.screen)", self.js)
        self.assertIn("q.projector = smooth((t - seq.ignite) / seq.igniteFade)", self.js)
        self.assertIn("q.screen = smooth((t - seq.ignite) / (showtime - seq.ignite))", self.js)
        self.assertIn("if (!q.started && t >= showtime)", self.js)
        self.assertIn("this.media.start()", self.js)
        self.assertIn("this.media.standby()", self.js)
        standby = self.js[self.js.index("  standby() {"):self.js.index("  /** Akhiri standby")]
        self.assertIn("video.pause();", standby)
        self.assertIn("video.currentTime = 0;", standby)
        self.assertNotIn("teaser", standby.lower())

    def test_projector_beam_is_additive_blue_white_and_starts_off(self):
        self.assertIn("new THREE.Color(0xcfdcff)", self.js)
        self.assertIn("blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,\n    });\n    const beam", self.js)
        self.assertIn("beam.visible = false;", self.js)
        self.assertIn("(0.12 + 0.08 * clamp(c.luma * 1.6, 0, 1))", self.js)           # opacity akhir 0,12–0,20

    def test_fabric_panels_replace_slats_and_downlights(self):
        for needle in ("panels.setColorAt", "const panelZ = [];", "makeCeilingTexture", "makeCarpetTexture", "scaleUv(",
                       "speakerBody", "0x090a0f", "makeCoveTexture",
                       "roughness: 0.98, metalness: 0, map: ceilingTexture"):
            self.assertIn(needle, self.js, needle)
        for forbidden in ("slats", "slatZ", "charcoalSlat", "const downlights", "PointLight(houseColor", "downGain"):
            self.assertNotIn(forbidden, self.js, forbidden)

    def test_overhead_key_light_and_neutral_fill(self):
        for needle in ("const houseFill = new THREE.AmbientLight(0xa9a9a9, 0);",          # fill abu-abu netral
                       "new THREE.DirectionalLight(0xfff1e0, 0)",                         # warm white 3200K
                       "houseKey.position.set(0, Math.min(H - 0.4, 6.5), 2);",            # [0, 6.5, 2]
                       "houseKey.intensity = seq.key * seq.keyGain * state.house;"):      # 1,4 → 0 mengikuti house
            self.assertIn(needle, self.js, needle)
        block = self.js[self.js.index("const ENTRANCE = {"):self.js.index("const XYLO_PALETTES")]
        for needle in ("key: 1.4", "fill: 0.35"):
            self.assertIn(needle, block, needle)
        cinema = self.js[self.js.index("  _buildCinema(L) {"):self.js.index("/** Bagian-bagian kursi per tipe")]
        self.assertNotIn("HemisphereLight", cinema)                                       # hemisfer bioskop sudah diganti

    def test_4dx_uses_the_seat_model_on_a_round_hydraulic_base_not_boxes(self):
        block = self.js[self.js.index("async _upgradeCinemaSeats(L)"):self.js.index("_buildSpectators(L) {")]
        self.assertIn("motion: 'hallSeat'", block)
        for needle in ("material.color.set(0x1c1e24);", "material.roughness = 0.75;", "material.metalness = 0.15;",
                       "this._motionBaseGeometry(baseHeight)", "geometry.translate(0, baseHeight, 0)"):
            self.assertIn(needle, block, needle)
        base = self.js[self.js.index("_motionBaseGeometry(height) {"):self.js.index("async _upgradeCinemaSeats(L)")]
        self.assertIn("CylinderGeometry", base)
        self.assertNotIn("BoxGeometry", base)                                              # tidak ada balok kotak
        # Placeholder prosedural 4DX tidak pernah tampil kecuali model gagal dimuat.
        self.assertIn("if (L.seat_type === 'motion') for (const mesh of meshes) mesh.visible = false;", self.js)

    def test_seat_upgrade_method_is_defined_once(self):
        # Regresi: edit berbasis indeks pernah menduplikasi method ini sehingga definisi lama yang menang.
        self.assertEqual(self.js.count("async _upgradeCinemaSeats(L)"), 1)
        self.assertEqual(self.js.count("_buildCinemaSeats(L) {"), 1)

    def test_seat_fabric_is_matte_wine_with_no_emissive(self):
        block = self.js[self.js.index("async _upgradeCinemaSeats(L)"):self.js.index("_buildSpectators(L) {")]
        for needle in ("material.emissive.set(0x000000);", "material.emissiveIntensity = 0;", "material.emissiveMap = null;",
                       "material.color.set(L.theme.seat);", "material.roughness = 0.95;", "material.metalness = 0;",
                       "material.color.set(0x18181b);"):                                   # rangka plastik doff
            self.assertIn(needle, block, needle)
        self.assertNotIn("material.roughness = 0.88", block)                               # versi lama tak boleh kembali

    def test_premiere_sofa_is_one_untextured_leather_override(self):
        block = self.js[self.js.index("async _upgradeCinemaSeats(L)"):self.js.index("_buildSpectators(L) {")]
        self.assertIn("color: 0x1a1816, roughness: 0.65, metalness: 0.12, flatShading: false", block)
        self.assertIn("override: leather", block)
        assets = (ROOT / "app/static/js/model_assets.js").read_text(encoding="utf-8")
        self.assertIn("override = null", assets)
        self.assertIn("geometry.deleteAttribute('uv')", assets)                            # seam UV dibuang bersama tekstur
        for forbidden in ("wireframe: true", "EdgesGeometry", "LineSegments(new THREE.EdgesGeometry"):
            self.assertNotIn(forbidden, block, forbidden)

    def test_showtime_has_ambient_and_bounce_baseline_floor(self):
        block = self.js[self.js.index("const ENTRANCE = {"):self.js.index("const XYLO_PALETTES")]
        for needle in ("floor: 0.14", "bounceFloor: 0.10", "bounceMax: 1.2"):
            self.assertIn(needle, block, needle)
        self.assertGreater(float(block.split("floorGain: ")[1].split(",")[0]), 1)            # pengali fisik > 1
        # Pantulan = lantai 0,10 + dinamis 0,0–1,2: frame hitam TIDAK lagi menghasilkan intensitas 0.
        self.assertIn("(seq.bounceFloor + clamp(c.luma * 2.4, 0, seq.bounceMax)) * state.screen", self.js)
        self.assertNotIn("clamp(c.luma * 2.4, 0, 1.8) * state.screen", self.js)
        # Ambient lantai tidak dikalikan faktor lampu ruangan: tidak pernah turun ke 0 saat showtime.
        line = next(l for l in self.js.splitlines() if "ambient.intensity = seq.floor" in l)
        self.assertNotIn("state.house", line)

    def test_audience_silhouettes_are_matte_0b0c10(self):
        self.assertGreaterEqual(self.js.count("0x0b0c10"), 2)                               # silhouette baris terjual + penonton depan
        self.assertIn("_std(0x0b0c10, { roughness: 1, metalness: 0 })", self.js)

    def test_camp_nou_model_is_not_loaded_anywhere(self):
        assets = (ROOT / "app/static/js/model_assets.js").read_text(encoding="utf-8")
        app = (ROOT / "app/static/js/visualizer_app.js").read_text(encoding="utf-8")
        for source in (self.js, assets, app):
            for forbidden in ("campNou", "camp_nou", "Camp Nou", "_neutralizeArena", "_upgradeStadiumWithModel",
                              "bowlGroup", "CAMP_NOU_FIT"):
                self.assertNotIn(forbidden, source, forbidden)

    def test_procedural_gbk_bowl_and_concert_atmosphere_still_built(self):
        for needle in ("_buildStadium(L)", "this._ringStrip(tier.inner, tier.outer, seatMaterial",
                       "this._buildStage(L, accent, accentDim)", "this._buildXylobands(L, rand)",
                       "makeDeckTexture", "makeBeamAlphaTexture"):
            self.assertIn(needle, self.js, needle)
        self.assertNotIn("BoxGeometry(0.075, 0.15, 0.012)", self.js)                # ponsel putih padat tetap dihapus
        self.assertIn("opacity: 0.17, alphaMap: beamAlpha, blending: THREE.AdditiveBlending", self.js)


if __name__ == "__main__":
    unittest.main()
