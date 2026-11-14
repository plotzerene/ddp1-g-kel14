"""
TiketPOV — pemesanan tiket dengan visualizer POV 3D (proyek DDP 1).

`create_app()` adalah application factory yang mendaftarkan 3 Blueprint:

    /            → landing     (Teammate 1)
    /visualizer  → visualizer  (peta 2D + POV 3D + mesin Python)
    /checkout    → checkout    (Teammate 2)
"""
from __future__ import annotations

import os
from urllib.parse import quote

from flask import Flask, jsonify, render_template, request

from .assets_sync import asset_url, sync_reference_assets
from .shared_state import Cart, current_user, format_rupiah

SSO_UI_CAS_LOGIN = "https://sso.ui.ac.id/cas2/login"


def create_app(config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("TIKETPOV_SECRET_KEY", "dev-ddp1-ganti-sebelum-deploy"),
        MAX_CONTENT_LENGTH=1 * 1024 * 1024,     # body JSON kecil saja; video upload tetap di browser
        SESSION_COOKIE_SAMESITE="Lax",
    )
    app.json.sort_keys = False
    app.json.ensure_ascii = False
    if config:
        app.config.update(config)

    # Salin ./reference_assets → ./app/static/reference_assets (hanya file yang berubah).
    report = sync_reference_assets()
    app.config["ASSET_REPORT"] = report
    app.logger.info(report.summary())

    from .blueprints.auth import auth_bp
    from .blueprints.checkout import checkout_bp
    from .blueprints.events import events_bp
    from .blueprints.intro import intro_bp
    from .blueprints.landing import landing_bp
    from .blueprints.visualizer import visualizer_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(intro_bp)
    app.register_blueprint(events_bp)
    app.register_blueprint(landing_bp)
    app.register_blueprint(visualizer_bp, url_prefix="/visualizer")
    app.register_blueprint(checkout_bp)

    app.jinja_env.filters["rupiah"] = format_rupiah

    @app.context_processor
    def inject_globals() -> dict:
        # `asset_url("images/x.jpg")` -> URL statis, atau None bila filenya tidak ada.
        try:
            service_url = f"{request.url_root.rstrip('/')}/auth/callback/ui"
            sso_ui_login_url = f"{SSO_UI_CAS_LOGIN}?service={quote(service_url, safe='')}"
        except RuntimeError:
            sso_ui_login_url = SSO_UI_CAS_LOGIN
        user = current_user()
        return {
            "cart_count": Cart().count,
            "asset_url": asset_url,
            "sso_ui_login_url": sso_ui_login_url,
            "current_user": user,
            "is_authenticated": bool(user),
        }

    @app.errorhandler(404)
    def not_found(error):
        if "/api/" in request.path:
            return jsonify(error="Endpoint tidak ditemukan."), 404
        return render_template("error.html", code=404,
                               message="Halaman yang kamu cari tidak ada."), 404

    @app.errorhandler(500)
    def server_error(error):
        if "/api/" in request.path:
            return jsonify(error="Terjadi kesalahan di server."), 500
        return render_template("error.html", code=500,
                               message="Terjadi kesalahan di server. Coba muat ulang."), 500

    return app
