"""intro: halaman pembuka sinematik di /intro.

Tiga lapis kedalaman (pintu bioskop, siluet penonton, judul besar) bergerak mengikuti mouse.
Tombol "Mulai Eksplorasi" memicu dolly zoom lalu menampilkan gerbang masuk.
"""
from __future__ import annotations

from flask import Blueprint, render_template

intro_bp = Blueprint("intro", __name__)


@intro_bp.get("/")
@intro_bp.get("/intro")
def index():
    return render_template("intro.html")
