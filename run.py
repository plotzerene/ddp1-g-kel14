"""
run.py — titik masuk aplikasi.

    python run.py            → http://127.0.0.1:5000
    PORT=8000 python run.py  → pakai port lain

Di macOS, port 5000 sering dipakai "AirPlay Receiver". Kalau port yang diminta
sedang terpakai, server otomatis pindah ke port kosong berikutnya dan
alamatnya dicetak di terminal.
"""
from __future__ import annotations

import os
import socket

from app import create_app

app = create_app()


def pick_port(preferred: int, attempts: int = 10) -> int:
    """Kembalikan port bebas pertama mulai dari `preferred`."""
    for port in range(preferred, preferred + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return preferred


if __name__ == "__main__":
    wanted = int(os.environ.get("PORT", "5000"))
    is_reloader_child = os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    # Proses anak reloader harus memakai port yang sama dengan induknya.
    port = int(os.environ.get("TIKETPOV_PORT", "0")) if is_reloader_child else 0
    if not port:
        port = pick_port(wanted)
        os.environ["TIKETPOV_PORT"] = str(port)
        if port != wanted:
            print(f" * Port {wanted} sedang dipakai, pindah ke port {port}.")
        print(f" * TiketPOV siap di http://127.0.0.1:{port}")
        print(f" * {app.config['ASSET_REPORT'].summary()}")
    app.run(host="127.0.0.1", port=port, debug=True)
