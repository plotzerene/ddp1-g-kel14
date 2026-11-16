"""events: detail film (/movie/<slug>) dan detail konser Coldplay (/event/coldplay/...).

Teks film dibaca dari movies_catalog.json. Poster dan trailer memakai daftar EVENTS di shared_state.
Tombol beli menuju visualizer, yang sudah berjalan.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from flask import Blueprint, abort, render_template, url_for

from ...assets_sync import asset_url
from ...shared_state import EVENTS, price_for_film_venue
from ..visualizer.models import get_venue

events_bp = Blueprint("events", __name__)

CATALOG_PATH = Path(__file__).resolve().parents[3] / "movies_catalog.json"
COLDPLAY_ID = "coldplay-gbk"
COLDPLAY_INFO = {
    "schedule": "Sabtu, 19 Des 2026 • 18:30 WIB (Open Gate 16:00 WIB)",
    "location": "Stadion Utama Gelora Bung Karno, Jakarta",
    "promoter": "PK Entertainment • Promotor Resmi",
}
COLDPLAY_TABS = (
    ("overview", "Ringkasan", "events.coldplay_overview"),
    ("tickets", "Tiket", "events.coldplay_tickets"),
    ("terms", "Syarat & Ketentuan", "events.coldplay_terms"),
)


@lru_cache(maxsize=1)
def _catalog() -> dict[str, dict]:
    data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return {movie["id"]: movie for movie in data["movies"]}


def _youtube_embed(embed_id: str | None) -> str:
    """URL embed YouTube tanpa cookie, atau string kosong jika ID trailer belum diisi."""
    return f"https://www.youtube-nocookie.com/embed/{embed_id}" if embed_id else ""


MOVIE_PRODUCTION: dict[str, dict] = {
    "sore": {
        "director": "Yandy Laurens",
        "writer": "Yandy Laurens",
        "producer": "Suryana Paramita",
        "studio": "Cerita Films",
        "origin": "Indonesia",
        "cast": ["Sheila Dara Aisha", "Dion Wiyoko", "Goran Bogdan", "Lara Nekic"],
        "trivia": "Salah satu film Indonesia pertama yang mengambil lokasi syuting di Kroasia; lagu tema utamanya berjudul 'Forget Jakarta' karya Adhitia Sofyan.",
        "language": "Indonesia",
        "subtitles": "Bahasa Indonesia",
    },
    "jatuh-cinta-seperti-di-film-film": {
        "director": "Yandy Laurens",
        "writer": "Yandy Laurens",
        "producer": "Ernest Prakasa, Suryana Paramita",
        "studio": "Imajinari & Jagartha",
        "origin": "Indonesia",
        "cast": ["Ringgo Agus Rahman", "Nirina Zubir", "Alex Abbad", "Sheila Dara Aisha", "Dion Wiyoko"],
        "trivia": "Sekitar 80 persen durasi film disajikan dalam visual hitam putih (monokrom) sebelum bertransisi penuh warna di bagian akhir cerita.",
        "language": "Indonesia",
        "subtitles": "Bahasa Inggris",
    },
    "boboiboy-the-movie": {
        "director": "Nizam Razak",
        "writer": "Nizam Razak • Anas Abdul Aziz",
        "producer": "Animonsta Studios",
        "studio": "Animonsta Studios (Monsta)",
        "origin": "Malaysia",
        "cast": ["Nur Fathiah Diaz", "Dzubir Mohammed Zakaria", "Wong Wai Kay", "Fadzli Mohd Rawi"],
        "trivia": "Menjadi salah satu film animasi terlaris di Malaysia dan pertama kali memperkenalkan perubahan Kuasa Tahap Kedua BoBoiBoy di layar lebar.",
        "language": "Melayu",
        "subtitles": "Bahasa Indonesia",
    },
    "ejen-ali-the-movie-2": {
        "director": "Usamah Zaid Yasin",
        "writer": "Usamah Zaid Yasin",
        "producer": "WAU Animation & Primeworks Studios",
        "studio": "WAU Animation & Primeworks Studios",
        "origin": "Malaysia",
        "cast": ["Ida Rahayu Yusoff", "Noorhayati Maslini", "Shafiq Isa", "Azman Zulkiply"],
        "trivia": "Sekuel resmi ini memperluas teknologi proyek IRIS melalui peluncuran kostum tempur taktis Satria berbasis kecerdasan buatan.",
        "language": "Melayu",
        "subtitles": "Bahasa Indonesia",
    },
    "la-la-land": {
        "director": "Damien Chazelle",
        "writer": "Damien Chazelle",
        "producer": "Fred Berger, Jordan Horowitz, Marc Platt",
        "studio": "Summit Entertainment & Black Label Media",
        "origin": "Amerika Serikat",
        "cast": ["Ryan Gosling", "Emma Stone", "John Legend", "Rosemarie DeWitt"],
        "trivia": "Adegan pembuka di jalan layang Los Angeles direkam dalam satu kali pengambilan gambar (one-take) bersama puluhan penari di bawah terik matahari.",
        "language": "Inggris",
        "subtitles": "Bahasa Indonesia",
    },
    "avengers-endgame": {
        "director": "Anthony & Joe Russo",
        "writer": "Christopher Markus & Stephen McFeely",
        "producer": "Kevin Feige",
        "studio": "Marvel Studios",
        "origin": "Amerika Serikat",
        "cast": ["Robert Downey Jr.", "Chris Evans", "Scarlett Johansson", "Mark Ruffalo", "Chris Hemsworth"],
        "trivia": "Seluruh adegan aksi utama film ini direkam penuh menggunakan kamera IMAX digital untuk menghasilkan cakupan layar vertikal yang lebih luas.",
        "language": "Inggris",
        "subtitles": "Bahasa Indonesia",
    },
    "how-to-lose-a-guy-in-10-days": {
        "director": "Donald Petrie",
        "writer": "Kristen Buckley, Brian Regan, Burr Steers",
        "producer": "Lynda Obst, Robert Evans, Christine Peters",
        "studio": "Paramount Pictures",
        "origin": "Amerika Serikat",
        "cast": ["Kate Hudson", "Matthew McConaughey", "Kathryn Hahn", "Annie Parisse", "Adam Goldberg"],
        "trivia": "Special Classic Screening menghadirkan salinan restorasi 4K untuk merayakan ikoniknya komedi romantis awal 2000-an.",
        "language": "Inggris",
        "subtitles": "Bahasa Indonesia",
    },
    "the-nun": {
        "director": "Corin Hardy",
        "writer": "Gary Dauberman, James Wan",
        "producer": "Peter Safran, James Wan",
        "studio": "New Line Cinema & Atomic Monster",
        "origin": "Amerika Serikat",
        "cast": ["Demián Bichir", "Taissa Farmiga", "Jonas Bloquet", "Bonnie Aarons", "Charlotte Hope"],
        "trivia": "Pengambilan gambar dilakukan di Kastil Corvin dan Biara Sighisoara di Transilvania, Rumania, untuk menghadirkan atmosfer gotik autentik.",
        "language": "Inggris",
        "subtitles": "Bahasa Indonesia",
    },
    "the-hunger-games": {
        "director": "Gary Ross",
        "writer": "Gary Ross, Suzanne Collins, Billy Ray",
        "producer": "Nina Jacobson, Jon Kilik",
        "studio": "Lionsgate & Color Force",
        "origin": "Amerika Serikat",
        "cast": ["Jennifer Lawrence", "Josh Hutcherson", "Liam Hemsworth", "Woody Harrelson", "Elizabeth Banks"],
        "trivia": "Jennifer Lawrence menjalani latihan memanah intensif bersama peraih medali Olimpiade demi keakuratan gerak di arena.",
        "language": "Inggris",
        "subtitles": "Bahasa Indonesia",
    },
    "spiderman-no-way-home": {
        "director": "Jon Watts",
        "writer": "Chris McKenna, Erik Sommers",
        "producer": "Kevin Feige, Amy Pascal",
        "studio": "Columbia Pictures & Marvel Studios",
        "origin": "Amerika Serikat",
        "cast": ["Tom Holland", "Zendaya", "Benedict Cumberbatch", "Jacob Batalon", "Willem Dafoe"],
        "trivia": "Menjadi film sinematik pertama yang menyatukan lintas generasi penjahat dan sekutu Spider-Man ke dalam format IMAX with Laser dan 4DX.",
        "language": "Inggris",
        "subtitles": "Bahasa Indonesia",
    },
    "chiikawa-movie": {
        "director": "Kei Oikawa",
        "writer": "Nagano",
        "producer": "Chiikawa Film Committee",
        "studio": "CygamesPictures • Toho",
        "origin": "Jepang",
        "cast": ["Haruka Aoki", "Makoto Tanaka", "Ari Ozawa", "Yuka Iguchi", "Yuma Uchida"],
        "trivia": "Adaptasi layar lebar pertama karya Nagano yang berfokus pada ekspedisi Pulau Putri Duyung penuh momen hangat dan komedi.",
        "language": "Jepang",
        "subtitles": "Bahasa Indonesia",
    },
    "zootopia-2": {
        "director": "Jared Bush, Byron Howard",
        "writer": "Jared Bush",
        "producer": "Yvett Merino",
        "studio": "Walt Disney Animation Studios",
        "origin": "Amerika Serikat",
        "cast": ["Ginnifer Goodwin", "Jason Bateman", "Ke Huy Quan", "Fortune Feimster", "Shakira"],
        "trivia": "Menjelajahi distrik Marsh Market dan dunia reptil Zootopia bersama karakter baru Gary De'Snake dalam format Regular 2D dan IMAX 3D.",
        "language": "Inggris / Indonesia",
        "subtitles": "Bahasa Indonesia",
    },
}

CINEMA_DATES: list[dict] = [
    {"id": "2026-11-14", "day": "Sab", "date": "14 Nov", "badge": "Hari Ini", "chip": "Hari Ini • 14 Nov"},
    {"id": "2026-11-15", "day": "Min", "date": "15 Nov", "badge": "Besok", "chip": "Besok • 15 Nov"},
    {"id": "2026-11-16", "day": "Sen", "date": "16 Nov", "badge": "", "chip": "Sen • 16 Nov"},
    {"id": "2026-11-17", "day": "Sel", "date": "17 Nov", "badge": "", "chip": "Sel • 17 Nov"},
    {"id": "2026-11-18", "day": "Rab", "date": "18 Nov", "badge": "", "chip": "Rab • 18 Nov"},
]

CINEMA_SCHEDULES: list[dict] = [
    {
        "id": "agora-xxi",
        "name": "AGORA MALL XXI • Thamrin Nine",
        "city": "Jakarta Pusat",
        "address": "Jl. M.H. Thamrin No.10, Jakarta Pusat",
        "distance": "1.2 km dari lokasimu",
        "formats_label": "Regular 2D • IMAX Laser • The Premiere",
        "studios": [
            {
                "venue_id": "xxi-regular",
                "type": "Regular 2D",
                "room": "Studio 4",
                "audio": "Dolby 7.1",
                "price": 50000,
                "vip": False,
                "times": ["12:00", "14:30", "17:00", "19:30"],
                "limited_time": "19:30",
            },
            {
                "venue_id": "xxi-imax",
                "type": "IMAX Laser",
                "room": "IMAX Hall",
                "audio": "12-Ch Laser Audio",
                "price": 85000,
                "vip": False,
                "times": ["13:15", "16:00", "18:45", "21:30"],
                "limited_time": "",
            },
            {
                "venue_id": "xxi-premiere",
                "type": "The Premiere",
                "room": "Premiere Suite",
                "audio": "Recliner",
                "price": 150000,
                "vip": True,
                "times": ["14:00", "17:30", "20:30"],
                "limited_time": "",
            },
        ],
    },
    {
        "id": "gi-xxi",
        "name": "Grand Indonesia XXI",
        "city": "Jakarta Pusat",
        "address": "Grand Indonesia West Mall Lt. 8, Jl. M.H. Thamrin",
        "distance": "1.8 km dari lokasimu",
        "formats_label": "Regular 2D • 4DX Motion",
        "studios": [
            {
                "venue_id": "xxi-regular",
                "type": "Regular 2D",
                "room": "Studio 2",
                "audio": "Dolby Digital",
                "price": 50000,
                "vip": False,
                "times": ["12:45", "15:20", "18:00", "20:45"],
                "limited_time": "",
            },
            {
                "venue_id": "xxi-4dx",
                "type": "4DX Motion",
                "room": "4DX Hall",
                "audio": "Kursi Gerak",
                "price": 110000,
                "vip": False,
                "times": ["14:15", "19:00"],
                "limited_time": "",
            },
        ],
    },
    {
        "id": "sency-xxi",
        "name": "Senayan City XXI",
        "city": "Jakarta Selatan",
        "address": "Senayan City Mall Lt. 5, Jl. Asia Afrika Lot 19",
        "distance": "3.4 km dari lokasimu",
        "formats_label": "Regular 2D • The Premiere • 4DX Motion",
        "studios": [
            {
                "venue_id": "xxi-regular",
                "type": "Regular 2D",
                "room": "Studio 1",
                "audio": "Dolby Atmos",
                "price": 50000,
                "vip": False,
                "times": ["13:00", "15:30", "18:00", "20:30"],
                "limited_time": "",
            },
            {
                "venue_id": "xxi-premiere",
                "type": "The Premiere",
                "room": "Premiere Suite",
                "audio": "Recliner",
                "price": 150000,
                "vip": True,
                "times": ["14:15", "17:15", "20:15"],
                "limited_time": "",
            },
            {
                "venue_id": "xxi-4dx",
                "type": "4DX Motion",
                "room": "4DX Hall",
                "audio": "Kursi Gerak",
                "price": 110000,
                "vip": False,
                "times": ["13:45", "16:30", "19:15"],
                "limited_time": "19:15",
            },
        ],
    },
    {
        "id": "pim-xxi",
        "name": "Pondok Indah 2 XXI",
        "city": "Jakarta Selatan",
        "address": "Pondok Indah Mall 2 Lt. 3, Metro Pondok Indah",
        "distance": "6.2 km dari lokasimu",
        "formats_label": "Regular 2D • IMAX Laser",
        "studios": [
            {
                "venue_id": "xxi-regular",
                "type": "Regular 2D",
                "room": "Studio 3",
                "audio": "Dolby 7.1",
                "price": 50000,
                "vip": False,
                "times": ["12:45", "15:30", "18:15", "21:00"],
                "limited_time": "",
            },
            {
                "venue_id": "xxi-imax",
                "type": "IMAX Laser",
                "room": "IMAX Hall",
                "audio": "Laser Projection",
                "price": 85000,
                "vip": False,
                "times": ["13:15", "16:00", "19:30"],
                "limited_time": "",
            },
        ],
    },
    {
        "id": "margo-xxi",
        "name": "Margo City XXI",
        "city": "Depok",
        "address": "Margo City Mall Lt. 3, Jl. Margonda Raya No. 358",
        "distance": "14.5 km dari lokasimu",
        "formats_label": "Regular 2D • The Premiere",
        "studios": [
            {
                "venue_id": "xxi-regular",
                "type": "Regular 2D",
                "room": "Studio 5",
                "audio": "Dolby 7.1",
                "price": 50000,
                "vip": False,
                "times": ["13:00", "15:30", "18:00", "20:30"],
                "limited_time": "",
            },
            {
                "venue_id": "xxi-premiere",
                "type": "The Premiere",
                "room": "Premiere Suite",
                "audio": "Recliner",
                "price": 150000,
                "vip": True,
                "times": ["15:00", "18:30", "21:00"],
                "limited_time": "",
            },
        ],
    },
]

COLDPLAY_STAGE_ZONES: list[dict] = [
    {
        "name": "Main Stage (Sisi Utara)",
        "detail": "Panggung utama selebar 48 meter dengan layar LED melengkung dan 2 menara speaker raksasa.",
    },
    {
        "name": "B-Stage (Catwalk Tengah)",
        "detail": "Panggung bundar di tengah arena Festival dan My Universe, terhubung langsung via runway utama.",
    },
    {
        "name": "C-Stage (Akustik Selatan)",
        "detail": "Panggung intim di sisi selatan lapangan untuk segmen akustik dekat tribun CAT 3.",
    },
]

COLDPLAY_OFFICIAL_RULES: list[dict] = [
    {
        "no": "01",
        "title": "Identitas Asli Wajib Dibawa",
        "body": "Nama pada e-tiket wajib sesuai KTP, SIM, Paspor, atau Kartu Pelajar/Mahasiswa yang masih berlaku saat penukaran gelang maupun masuk gerbang GBK.",
    },
    {
        "no": "02",
        "title": "Batas Maksimal Pembelian",
        "body": "Satu akun terverifikasi dapat memesan maksimal 4 tiket per kategori untuk menjaga pemerataan akses penggemar dan mencegah praktik percaloan.",
    },
    {
        "no": "03",
        "title": "Batas Usia Penonton",
        "body": "Penonton di bawah 14 tahun wajib didampingi pemegang tiket berusia 18 tahun ke atas; area Festival dan My Universe berdiri bebas direkomendasikan minimal usia 12 tahun.",
    },
    {
        "no": "04",
        "title": "Ketentuan Tas & Barang Terlarang",
        "body": "Hanya tas berukuran maksimal A4 yang diizinkan. Dilarang membawa kamera profesional lensa lepas, tongsis, botol kaca, makanan/minuman luar, dan laser pointer.",
    },
    {
        "no": "05",
        "title": "Kebijakan Tanpa Masuk Ulang",
        "body": "Barcode gelang wristband hanya berlaku satu kali pindai masuk stadion. Penonton yang keluar dari area venue tidak diperkenankan masuk kembali.",
    },
    {
        "no": "06",
        "title": "Tiket Non-Refundable & Anti Duplikasi",
        "body": "Tiket yang sudah dibeli tidak dapat dibatalkan atau dipindahtangankan secara sembarangan. Jangan bagikan kode batang maupun QR di media sosial.",
    },
    {
        "no": "07",
        "title": "Kenyamanan & Prosedur Darurat",
        "body": "Ikuti arahan petugas keamanan PK Entertainment, jaga hidrasi di area berdiri, dan kenali jalur evakuasi serta pos medis terdekat di setiap zona tribun.",
    },
]


STUDIO_FORMAT_LABELS: dict[str, str] = {
    "xxi-regular": "Regular 2D",
    "xxi-premiere": "The Premiere",
    "xxi-imax": "IMAX Laser",
    "xxi-4dx": "4DX Motion",
}


def _film_schedules(event, details: dict | None = None) -> tuple[list[dict], list[str], int]:
    """Saring jadwal bioskop sesuai format studio dan tarif resmi film ini."""
    allowed = set(event.venues)
    details = details or {}
    format_labels = details.get("format_labels") or {}
    filtered: list[dict] = []
    min_price: int | None = None
    for cinema in CINEMA_SCHEDULES:
        studios: list[dict] = []
        for st in cinema["studios"]:
            vid = st["venue_id"]
            if vid not in allowed:
                continue
            price = price_for_film_venue(event.event_id, vid, st["price"])
            label = format_labels.get(vid, st["type"])
            audio = st["audio"]
            if "Dolby Atmos" in label:
                audio = "Dolby Atmos"
            min_price = price if min_price is None else min(min_price, price)
            studios.append({
                **st,
                "type": label,
                "audio": audio,
                "price": price,
            })
        if not studios:
            continue
        filtered.append({
            **cinema,
            "studios": studios,
            "formats_label": " • ".join(st["type"] for st in studios),
        })
    available_formats = [
        format_labels.get(v, STUDIO_FORMAT_LABELS[v])
        for v in event.venues
        if v in STUDIO_FORMAT_LABELS
    ]
    if min_price is None:
        min_price = min(
            (price_for_film_venue(event.event_id, v) for v in event.venues),
            default=50_000,
        )
    return filtered, available_formats, min_price


@events_bp.get("/movie/<slug>")
@events_bp.get("/movie/<slug>", endpoint="movie_detail")
def movie(slug: str):
    details = _catalog().get(slug)
    event = EVENTS.get(slug)
    if details is None or event is None or event.kind != "film":
        abort(404)
    filtered_schedules, available_formats, min_price = _film_schedules(event, details)
    return render_template(
        "events/movie.html",
        movie=details,
        production=MOVIE_PRODUCTION.get(slug, {}),
        dates=CINEMA_DATES,
        schedules=filtered_schedules,
        cities=sorted({c["city"] for c in filtered_schedules}),
        available_formats=available_formats,
        min_price=min_price,
        status_badge=details.get("status_badge", "Sedang Tayang di Bioskop"),
        is_coming_soon=details.get("status") == "coming_soon",
        poster_url=asset_url(event.poster),
        trailer_local=asset_url(event.trailer),
        trailer_embed=_youtube_embed(details.get("embed_id")),
        buy_url=url_for("visualizer.index", film=slug),
        studio_pov_url=f"/studio_pov/{slug}",
    )


def _render_coldplay(tab: str):
    event = EVENTS[COLDPLAY_ID]
    venue = get_venue(event.venues[0])
    tabs = [{"key": key, "label": label, "href": url_for(endpoint), "active": key == tab}
            for key, label, endpoint in COLDPLAY_TABS]
    return render_template(
        "events/event.html",
        tab=tab,
        event=event,
        venue=venue,
        tabs=tabs,
        poster_url=asset_url(event.poster),
        buy_url=url_for("visualizer.studio", venue_id=venue.venue_id),
        categories=[
            {
                "block_id": b.block_id,
                "label": b.label,
                "category": getattr(b, "category", b.label),
                "color": b.color,
                "price": b.price,
                "standing": b.standing,
                "restricted": getattr(b, "restricted", False),
                "description": getattr(b, "description", ""),
                "perks": getattr(b, "perks", ()),
                "select_url": url_for("visualizer.studio", venue_id=venue.venue_id, block=b.block_id),
            }
            for b in venue.blocks.values()
        ],
        info=COLDPLAY_INFO,
        stage_zones=COLDPLAY_STAGE_ZONES,
        rules=COLDPLAY_OFFICIAL_RULES,
    )


@events_bp.get("/event/coldplay/overview")
def coldplay_overview():
    return _render_coldplay("overview")


@events_bp.get("/event/coldplay/tickets")
def coldplay_tickets():
    return _render_coldplay("tickets")


@events_bp.get("/event/coldplay/terms")
def coldplay_terms():
    return _render_coldplay("terms")


@events_bp.get("/concerts")
@events_bp.get("/events", endpoint="events_list")
def concerts():
    """Halaman direktori Konser Musik & Festival yang skalabel lintas venue."""
    concert_cards = []
    for ev in EVENTS.values():
        if ev.kind != "concert":
            continue
        venue = get_venue(ev.venues[0])
        min_price = min((b.price for b in venue.blocks.values()), default=800_000)
        concert_cards.append({
            "event": ev,
            "venue": venue,
            "venue_label": COLDPLAY_INFO["location"] if ev.event_id == COLDPLAY_ID else ev.meta,
            "schedule": COLDPLAY_INFO["schedule"] if ev.event_id == COLDPLAY_ID else "",
            "promoter": COLDPLAY_INFO["promoter"] if ev.event_id == COLDPLAY_ID else "",
            "poster_url": asset_url(ev.poster),
            "min_price": min_price,
            "detail_url": url_for("events.coldplay_overview"),
            "tickets_url": url_for("events.coldplay_tickets"),
            "viz_url": url_for("visualizer.studio", venue_id=venue.venue_id),
        })
    return render_template(
        "events/concerts.html",
        concerts=concert_cards,
        rules=COLDPLAY_OFFICIAL_RULES,
    )
