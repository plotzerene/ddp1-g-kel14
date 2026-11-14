"""ticket_pdf_engine.py: render e-tiket ke PDF dengan ReportLab (dikerjakan Teman B).

ReportLab belum ada di requirements.txt. Tambahkan saat modul ini mulai dikerjakan,
dan catat di README.

Kontrak:
- render_ticket_pdf menerima data tiket dan menulis file PDF ke output_path.
- Mengembalikan path file yang sudah ditulis.
- Method yang belum diisi melempar NotImplementedError.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

TICKET_CODE_PREFIX = "TTK"
FILM_FALLBACK_SCHEDULE = "Hari ini • 19:30 WIB"
REQUIRED_ORDER_FIELDS = ("order_id", "seat_id", "event_title", "venue_name",
                         "seat_label", "price", "buyer_name")


@dataclass(frozen=True)
class TicketData:
    code: str
    event_title: str
    venue_name: str
    seat_label: str
    price: int  # rupiah, bilangan bulat
    buyer_name: str


def render_ticket_pdf(ticket: TicketData, output_path: Path) -> Path:
    """Tulis e-tiket sebagai PDF di output_path, lalu kembalikan path tersebut."""
    raise NotImplementedError


def build_ticket_code(order_id: str, seat_id: str) -> str:
    """Format kode tiket TTK-<ORDER_ID>-<SEAT_ID>, contoh TTK-202611-F12.

    Melempar ValueError jika order_id atau seat_id kosong.
    TODO Teman B: pastikan hasilnya hanya berisi huruf dan angka serta tanda hubung tunggal,
    supaya bisa dicetak sebagai barcode Code128.
    """
    raise NotImplementedError


def schedule_text(event_kind: str, schedule: str | None = None) -> str:
    """Teks tanggal dan waktu untuk e-tiket.

    Aturan:
    • Film tanpa jadwal memakai FILM_FALLBACK_SCHEDULE.
    • Konser memakai jadwal resmi yang diberikan, contoh "Sabtu, 19 Des 2026 • 18:30 WIB".
    TODO Teman B: isi aturan ini dan tes di tests/test_ticket_pdf.py.
    """
    raise NotImplementedError


class TicketPDFEngine:
    """Pembuat e-tiket PDF. Hasil ditulis ke memori (io.BytesIO), tidak ke disk server.

    TODO Teman B, panduan ReportLab:
    • SimpleDocTemplate menulis ke BytesIO, lalu isinya diambil dengan getvalue().
    • Paragraph untuk logo titiket.com, status LUNAS / VERIFIED, dan detail tiket.
    • Barcode Code128 dari reportlab.graphics.barcode, dengan teks kode tiket di bawahnya.
    • Spacer untuk jarak antarbagian.
    • Route Flask memakai send_file(buffer, as_attachment=True, mimetype="application/pdf").
    """

    def generate_ticket_pdf(self, order_data: dict) -> io.BytesIO:
        """Buat e-tiket dari order_data dan kembalikan BytesIO dengan posisi awal 0.

        order_data wajib memuat REQUIRED_ORDER_FIELDS. Jika ada yang kurang, lempar ValueError.
        """
        raise NotImplementedError
