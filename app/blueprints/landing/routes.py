"""
routes.py (landing) — FOLDER TEAMMATE 1.

Halaman depan bergaya titiket.com: carousel promo, katalog film & konser dari
`shared_state.EVENTS`, kartu studio, dan banner aplikasi. Semua tombol "Beli tiket"
menuju visualizer lewat `url_for("visualizer.index", ...)`.
"""
from __future__ import annotations

from flask import Blueprint, render_template

from ...shared_state import EVENTS

landing_bp = Blueprint("landing", __name__, template_folder="templates")

# (tipe studio di URL, judul, deskripsi, foto di reference_assets)
STUDIOS = (
    ("regular", "Studio Deluxe", "Nikmati tontonan dengan kursi yang nyaman dan harga terjangkau.",
     "images/xxi_regular_studio.jpg"),
    ("premiere", "The Premiere",
     "Rasakan kemewahan kursi premium serta makanan ala restoran dengan servis terbaik.",
     "images/xxi_the_premiere.jpg"),
    ("imax", "Studio IMAX", "Rasakan bedanya nonton film high-definition dengan sistem proyeksi laser 4K.",
     "images/xxi_imax_studio.jpg"),
)


@landing_bp.get("/")
def index():
    return render_template("landing/index.html", events=list(EVENTS.values()), studios=STUDIOS)
