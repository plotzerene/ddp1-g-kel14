"""
routes.py (landing) untuk halaman utama titiket.com (Light & Dark Mode).

Menampilkan hero spotlight, carousel promo, katalog 6 film resmi dari
movies_catalog.json, spotlight konser Coldplay GBK, promo SSO UI,
kartu studio Cinema XXI, dan pratinjau titiket.food.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from flask import Blueprint, jsonify, render_template, request, url_for

from ...shared_state import EVENTS, OFFICIAL_MERCH_CATALOG, Cart, MerchCart, price_for_film_venue

landing_bp = Blueprint("landing", __name__, template_folder="templates")
CATALOG_PATH = Path(__file__).resolve().parents[3] / "movies_catalog.json"

STUDIOS = (
    ("regular", "Studio Deluxe", "Nikmati tontonan dengan kursi yang nyaman dan harga terjangkau.",
     "images/xxi_regular_studio.jpg"),
    ("premiere", "The Premiere",
     "Rasakan kemewahan kursi premium serta makanan ala restoran dengan servis terbaik.",
     "images/xxi_the_premiere.jpg"),
    ("imax", "Studio IMAX", "Rasakan bedanya nonton film high definition dengan sistem proyeksi laser 4K.",
     "images/xxi_imax_studio.jpg"),
)

FOOD_HIGHLIGHTS = (
    ("Combo Caramel Large", "1 Popcorn Caramel Jumbo + 2 Minuman Dingin", 68_000),
    ("Truffle Fries Cinema", "Kentang goreng renyah dengan saus keju truffle", 42_000),
    ("Concert Hydration Pack", "2 Air Mineral + Tumbler Edisi Coldplay GBK", 55_000),
)


@lru_cache(maxsize=1)
def _catalog_by_id() -> dict[str, dict]:
    data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return {movie["id"]: movie for movie in data.get("movies", [])}


def _card_from_event(event, catalog: dict[str, dict], *, is_extra: bool = False) -> dict:
    is_concert = event.kind == "concert"
    if is_concert:
        return {
            "event": event,
            "kind": "concert",
            "is_concert": True,
            "is_extra": is_extra,
            "badge": "LIVE",
            "badge_variant": "gold",
            "meta_line": "Stadion Utama GBK \u2022 Konser Musik",
            "detail_endpoint": "events.coldplay_overview",
            "detail_slug": None,
            "rating": 9.4,
            "min_price": 800_000,
            "status_badge": "Konser Musik",
            "trailer_embed": "",
            "is_coming_soon": False,
            "formats": "concert",
            "days": "tomorrow",
            "is_nearby": False,
        }
    meta = catalog.get(event.event_id, {})
    raw_age = str(meta.get("age_rating", "13+"))
    badge = "SU" if raw_age == "SU" else (raw_age if raw_age.startswith("R") else f"R{raw_age}")
    genres = "/".join(meta.get("genres", [])[:2])
    duration = meta.get("duration", "1h 50m")
    min_price = min(
        (price_for_film_venue(event.event_id, v) for v in event.venues),
        default=50_000,
    )
    embed_id = meta.get("embed_id")
    trailer_embed = f"https://www.youtube-nocookie.com/embed/{embed_id}" if embed_id else ""
    is_coming_soon = meta.get("status") == "coming_soon"
    formats = " ".join(event.venues)
    days = "tomorrow" if is_coming_soon else "today tomorrow"
    return {
        "event": event,
        "kind": "film",
        "is_concert": False,
        "is_extra": is_extra,
        "badge": badge,
        "badge_variant": "teal" if badge == "SU" else "gold",
        "meta_line": f"2D \u2022 {duration} \u2022 {genres}" if genres else f"2D \u2022 {duration}",
        "detail_endpoint": "events.movie",
        "detail_slug": event.event_id,
        "rating": meta.get("rating", 8.0),
        "min_price": min_price,
        "status_badge": meta.get("status_badge", "Sedang Tayang"),
        "trailer_embed": trailer_embed,
        "is_coming_soon": is_coming_soon,
        "formats": formats,
        "days": days,
        "is_nearby": not is_coming_soon,
    }


QUICK_FILTER_CHIPS: tuple[tuple[str, str], ...] = (
    ("all", "Semua"),
    ("nearby", "Bioskop Terdekat"),
    ("imax", "IMAX Laser"),
    ("concert", "Konser Musik"),
    ("today", "Hari Ini"),
    ("tomorrow", "Besok"),
)


@landing_bp.get("/")
@landing_bp.get("/home")
def index():
    catalog = _catalog_by_id()
    all_cards = {ev.event_id: _card_from_event(ev, catalog) for ev in EVENTS.values()}

    # Carousel promo 9 slide (3 kartu unggulan awal: Coldplay, The Hunger Games, Midnight Screening The Nun).
    featured_order = [
        ("coldplay-gbk", "KONSER MUSIK"),
        ("the-hunger-games", "SEDANG TAYANG"),
        ("the-nun", "MIDNIGHT SCREENING"),
        ("sore", "SPECIAL CLASSIC SCREENING"),
        ("spiderman-no-way-home", "IMAX & 4DX READY"),
        ("how-to-lose-a-guy-in-10-days", "SPECIAL CLASSIC"),
        ("chiikawa-movie", "LAGI TAYANG \u2022 ANIME"),
        ("zootopia-2", "PRESALE \u2022 IMAX 3D"),
        ("jatuh-cinta-seperti-di-film-film", "PILIHAN PENONTON"),
    ]
    featured_slides = [
        {**all_cards[eid], "carousel_tag": tag}
        for eid, tag in featured_order
        if eid in all_cards
    ]

    # Grid 5 kolom "Lagi tayang" (2 baris utama + kartu lanjutan lewat "Lihat semua").
    now_playing_primary = (
        "how-to-lose-a-guy-in-10-days",
        "the-nun",
        "the-hunger-games",
        "spiderman-no-way-home",
        "chiikawa-movie",
        "sore",
        "jatuh-cinta-seperti-di-film-film",
        "boboiboy-the-movie",
        "ejen-ali-the-movie-2",
        "coldplay-gbk",
    )
    now_playing_cards = [
        _card_from_event(EVENTS[eid], catalog, is_extra=False)
        for eid in now_playing_primary
        if eid in EVENTS
    ] + [
        _card_from_event(ev, catalog, is_extra=True)
        for eid, ev in EVENTS.items()
        if eid not in now_playing_primary and eid != "zootopia-2"
    ] + (
        [_card_from_event(EVENTS["zootopia-2"], catalog, is_extra=True)]
        if "zootopia-2" in EVENTS
        else []
    )

    # Grid 5 kolom "Coming Soon" + tombol "Ingatkan Saya".
    coming_soon_order = (
        "zootopia-2",
        "la-la-land",
        "avengers-endgame",
        "sore",
        "coldplay-gbk",
    )
    coming_soon_cards = [
        _card_from_event(EVENTS[eid], catalog, is_extra=False)
        for eid in coming_soon_order
        if eid in EVENTS
    ]

    return render_template(
        "landing/index.html",
        events=list(EVENTS.values()),
        featured_slides=featured_slides,
        now_playing_cards=now_playing_cards,
        coming_soon_cards=coming_soon_cards,
        quick_filter_chips=QUICK_FILTER_CHIPS,
        concert_event=EVENTS.get("coldplay-gbk"),
        studios=STUDIOS,
        food_items=FOOD_HIGHLIGHTS,
        merch_catalog=OFFICIAL_MERCH_CATALOG,
    )


@landing_bp.post("/api/merch-cart/add")
def api_merch_add():
    data = request.get_json(silent=True) or dict(request.form)
    item_id = str(data.get("item_id", "")).strip()
    delta = int(data.get("delta", 1) or 1)
    merch = MerchCart()
    if not merch.add(item_id, delta):
        return jsonify(ok=False, error="Produk merchandise tidak ditemukan."), 404
    return jsonify(
        ok=True,
        merch_count=merch.count,
        cart_count=Cart().count + merch.count,
        items=merch.items(),
        subtotal=merch.subtotal,
        shipping_fee=merch.shipping_fee,
        total=merch.subtotal + merch.shipping_fee,
    )


@landing_bp.post("/api/merch-cart/update")
def api_merch_update():
    data = request.get_json(silent=True) or dict(request.form)
    item_id = str(data.get("item_id", "")).strip()
    qty = int(data.get("qty", 0) or 0)
    merch = MerchCart()
    if not merch.set_qty(item_id, qty):
        return jsonify(ok=False, error="Produk merchandise tidak ditemukan."), 404
    return jsonify(
        ok=True,
        merch_count=merch.count,
        cart_count=Cart().count + merch.count,
        items=merch.items(),
        subtotal=merch.subtotal,
        shipping_fee=merch.shipping_fee,
        total=merch.subtotal + merch.shipping_fee,
    )


@landing_bp.post("/api/merch-cart/clear")
def api_merch_clear():
    merch = MerchCart()
    merch.clear()
    return jsonify(ok=True, merch_count=0, cart_count=Cart().count)


PROMO_OFFERS: list[dict] = [
    {
        "id": "sso-ui-15",
        "category": "mahasiswa",
        "category_label": "Mahasiswa UI",
        "badge": "DISKON 15%",
        "accent": "teal",
        "period": "Berlaku hingga 31 Desember 2026",
        "code": "Otomatis via SSO UI (@ui.ac.id)",
        "title": "Diskon Sivitas Akademika Universitas Indonesia 15%",
        "highlight": "Hemat 15% Tiket Bioskop & Konser",
        "summary": (
            "Potongan langsung 15% untuk mahasiswa, dosen, dan tenaga kependidikan Universitas "
            "Indonesia yang terverifikasi melalui gerbang resmi SSO UI."
        ),
        "terms": [
            "Wajib masuk menggunakan akun resmi SSO UI (sso.ui.ac.id) berakhiran @ui.ac.id yang masih berstatus aktif.",
            "Berlaku untuk pembelian tiket film bioskop mitra (Regular 2D, The Premiere, IMAX Laser, dan 4DX Motion) serta tiket konser pilihan termasuk Coldplay: Music of the Spheres di Stadion Utama GBK.",
            "Potongan 15% dihitung dari subtotal harga tiket sebelum biaya admin bioskop (Rp 3.000/tiket) atau pajak hiburan daerah 15% dan convenience fee 5% pada tiket konser.",
            "Kuota promo berlaku maksimal 2 transaksi per pekan untuk setiap akun UI, dengan batas maksimal 6 tiket dalam satu keranjang.",
            "Tidak dapat digabungkan dengan kode voucher promo atau program cashback dompet digital lain dalam transaksi yang sama.",
        ],
        "cta_label": "Masuk dengan SSO UI",
        "cta_kind": "sso",
    },
    {
        "id": "qris-ewallet-cashback",
        "category": "pembayaran",
        "category_label": "Pembayaran Digital",
        "badge": "CASHBACK S.D. RP 25.000",
        "accent": "amber",
        "period": "Berlaku setiap hari • Kuota harian terbatas",
        "code": "Otomatis di Checkout (QRIS / Dompet Digital)",
        "title": "Cashback Instan QRIS & Dompet Digital 10%",
        "highlight": "Maksimal Cashback Rp 25.000 per Transaksi",
        "summary": (
            "Dapatkan potongan langsung atau cashback instan saat membayar tiket menggunakan QRIS Instan, "
            "GoPay, OVO, DANA, maupun ShopeePay sebelum batas kunci kursi berakhir."
        ),
        "terms": [
            "Berlaku dengan minimum subtotal transaksi Rp 85.000 sebelum biaya admin bioskop atau biaya layanan konser.",
            "Kanal pembayaran yang berlaku meliputi QRIS Instan, GoPay, OVO, DANA, dan ShopeePay yang tertera di halaman Checkout.",
            "Besaran cashback adalah 10% hingga maksimal Rp 25.000 per transaksi dan dibatasi 1 kali klaim per akun per minggu.",
            "Pembayaran wajib diselesaikan dalam rentang batas waktu kunci kursi 10 menit (10:00) agar kursi tidak dilepas otomatis oleh sistem.",
            "Pesanan yang dibatalkan atau kedaluwarsa sebelum status pembayaran LUNAS tidak memperoleh cashback maupun pengembalian kuota promo.",
        ],
        "cta_label": "Pilih Film & Kursi",
        "cta_kind": "cinema",
    },
    {
        "id": "imax-4dx-hemat",
        "category": "bioskop",
        "category_label": "Bioskop",
        "badge": "POTONGAN RP 15.000",
        "accent": "teal",
        "period": "Setiap Selasa & Kamis • Jam tayang Reguler & Malam",
        "code": "TITIKETIMAX",
        "title": "Hemat Studio IMAX Laser & 4DX Motion",
        "highlight": "Potongan Rp 15.000 untuk Minimal 2 Tiket Imersif",
        "summary": (
            "Nikmati pengalaman layar raksasa IMAX Laser (Rp 85.000) atau efek gerak 4DX Motion (Rp 110.000) "
            "setelah memeriksa jarak pandang dan sudut layar kursi lewat Visualizer 3D POV."
        ),
        "terms": [
            "Berlaku khusus pembelian minimal 2 tiket dalam satu pesanan untuk studio tipe IMAX Laser atau 4DX Motion di bioskop mitra.",
            "Pemilihan kursi dilakukan melalui halaman Visualizer 3D POV; promo hanya berlaku pada kursi yang berstatus tersedia.",
            "Potongan Rp 15.000 diberikan per transaksi dan tetap dikenakan biaya admin bioskop Rp 3.000 per tiket.",
            "E-tiket diterbitkan lengkap dengan QR Code resmi dan wajib dipindai di pintu masuk studio maksimal 15 menit sebelum film dimulai.",
        ],
        "cta_label": "Coba 3D POV IMAX Laser",
        "cta_kind": "imax",
    },
    {
        "id": "gbk-3d-priority",
        "category": "konser",
        "category_label": "Konser Musik",
        "badge": "BEBAS ADMIN VA",
        "accent": "amber",
        "period": "Selama ketersediaan zona tiket konser masih dibuka",
        "code": "Tanpa Kode • Pembayaran Virtual Account",
        "title": "Prioritas Zona Konser & Bebas Biaya Admin VA",
        "highlight": "Nol Biaya Transfer Virtual Account BCA, Mandiri, BNI, BRI",
        "summary": (
            "Amankan kategori zona terbaik Coldplay: Music of the Spheres di Stadion Utama GBK lengkap "
            "dengan pratinjau jarak panggung 3D POV serta pembebasan biaya administrasi Virtual Account."
        ),
        "terms": [
            "Berlaku untuk pembelian seluruh kategori zona resmi Stadion Utama GBK (Festival, CAT 1 s.d. CAT 8, My Universe, dan Ultimate Experience).",
            "Bebas biaya administrasi transfer antarbank berlaku khusus kanal Virtual Account BCA, Mandiri, BNI, dan BRI yang diselesaikan dalam 10 menit.",
            "Total pembayaran tetap memperhitungkan Pajak Hiburan Daerah 15% dan Convenience Fee 5% sesuai ketentuan promotor resmi PK Entertainment.",
            "E-tiket konser diterbitkan menggunakan Barcode Code128 unik, bersifat final (tidak dapat dijadwal ulang), dan wajib disertai kartu identitas asli saat penukaran.",
        ],
        "cta_label": "Lihat Denah & 3D Konser",
        "cta_kind": "concert",
    },
    {
        "id": "food-combo-hemat",
        "category": "kuliner",
        "category_label": "titiket.food",
        "badge": "HEMAT 20%",
        "accent": "teal",
        "period": "Berlaku sepanjang tahun 2026 di konter mitra",
        "code": "FOOD20",
        "title": "Bundling Camilan Bioskop & Stadion titiket.food",
        "highlight": "Diskon 20% Combo Caramel Large & Hydration Pack",
        "summary": (
            "Lengkapi pengalaman menonton dengan potongan 20% untuk Combo Caramel Large (Rp 68.000), "
            "Truffle Fries Cinema (Rp 42.000), atau Concert Hydration Pack (Rp 55.000)."
        ),
        "terms": [
            "Berlaku untuk paket Combo Caramel Large, Truffle Fries Cinema, dan Concert Hydration Pack di konter resmi bertanda titiket.food.",
            "Penukaran promo di konter mewajibkan pembeli menunjukkan E-Tiket aktif pada tanggal penayangan atau tanggal konser yang sama.",
            "Diskon 20% berlaku maksimal untuk 2 paket kuliner per satu E-Tiket aktif dan tidak dapat diuangkan sebagian maupun penuh.",
            "Penggunaan Concert Hydration Pack di Stadion Utama GBK wajib mematuhi standar pemeriksaan keamanan pintu masuk promotor tanpa membawa botol berkemasan keras.",
        ],
        "cta_label": "Jelajahi Film & Acara",
        "cta_kind": "food",
    },
]

PROMO_GENERAL_TERMS: list[str] = [
    "Seluruh program promo hanya berlaku pada situs resmi titiket.com dengan metode pembayaran sah yang tersedia pada halaman Checkout.",
    "Satu keranjang belanja dapat memuat maksimal 6 tiket dalam periode penguncian kursi 10 menit; kursi terlepas otomatis apabila pembayaran belum terkonfirmasi.",
    "Promo potongan persentase atau nominal hanya memotong subtotal harga tiket dasar dan tidak membebaskan kewajiban pajak hiburan daerah maupun biaya administrasi resmi penyelenggara.",
    "Penyalahgunaan akun ganda, manipulasi status SSO UI, atau penggunaan skrip otomatis akan mengakibatkan pembatalan transaksi secara sepihak.",
    "E-Tiket resmi (QR Code untuk bioskop dan Barcode Code128 untuk konser) bersifat pribadi dan tidak boleh dibagikan ke pihak lain sebelum proses pindai gerbang.",
    "titiket.com berhak menyesuaikan kuota, periode berlaku, maupun syarat promo sewaktu-waktu tanpa pemberitahuan sebelumnya apabila kuota harian atau bulanan telah terpenuhi.",
]


@landing_bp.get("/promo")
def promo():
    """Halaman khusus daftar seluruh promo beserta syarat dan ketentuan lengkap."""
    target_urls = {
        "cinema": url_for("visualizer.studio", venue_id="xxi-regular"),
        "imax": url_for("visualizer.studio", venue_id="xxi-imax"),
        "concert": url_for("events.coldplay_tickets"),
        "food": url_for("landing.index") + "#lagi-tayang",
    }
    enriched_offers = []
    for offer in PROMO_OFFERS:
        kind = offer["cta_kind"]
        enriched_offers.append(
            {
                **offer,
                "cta_href": None if kind == "sso" else target_urls.get(kind, url_for("landing.index")),
            }
        )
    return render_template(
        "landing/promo.html",
        offers=enriched_offers,
        general_terms=PROMO_GENERAL_TERMS,
    )
