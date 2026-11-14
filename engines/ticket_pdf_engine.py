"""ticket_pdf_engine.py: render e-tiket ke PDF dengan ReportLab (dikerjakan Teman B).

ReportLab belum ada di requirements.txt. Tambahkan saat modul ini mulai dikerjakan,
dan catat di README.

Kontrak:
- render_ticket_pdf menerima data tiket dan menulis file PDF ke output_path.
- Mengembalikan path file yang sudah ditulis.
- Method yang belum diisi melempar NotImplementedError.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
