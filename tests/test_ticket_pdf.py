"""Tes TDD untuk e-tiket PDF (dikerjakan Teman B).

Tes ini sengaja gagal (merah) sampai engines/ticket_pdf_engine.py diisi.
Setiap tes mendefinisikan perilaku yang harus dipenuhi.
"""

from __future__ import annotations

import io
import unittest

from engines.ticket_pdf_engine import (
    FILM_FALLBACK_SCHEDULE,
    TicketPDFEngine,
    build_ticket_code,
    schedule_text,
)

ORDER = {
    "order_id": "202611",
    "seat_id": "F12",
    "event_title": "SORE: Istri dari Masa Depan",
    "venue_name": "Cinema XXI · IMAX",
    "seat_label": "Baris F · Kursi 12",
    "price": 85000,
    "buyer_name": "Budi Santoso",
}


class TicketCodeTests(unittest.TestCase):
    def test_code_follows_ttk_order_seat_format(self):
        self.assertEqual(build_ticket_code("202611", "F12"), "TTK-202611-F12")

    def test_empty_order_id_is_rejected(self):
        with self.assertRaises(ValueError):
            build_ticket_code("", "F12")


class ScheduleTextTests(unittest.TestCase):
    def test_film_without_schedule_uses_fallback(self):
        self.assertEqual(schedule_text("film"), "Hari ini • 19:30 WIB")
        self.assertEqual(FILM_FALLBACK_SCHEDULE, "Hari ini • 19:30 WIB")

    def test_concert_uses_official_schedule(self):
        official = "Sabtu, 19 Des 2026 • 18:30 WIB"
        self.assertEqual(schedule_text("concert", official), official)


class PdfGenerationTests(unittest.TestCase):
    def setUp(self):
        self.engine = TicketPDFEngine()

    def test_result_is_in_memory_buffer_at_start(self):
        buffer = self.engine.generate_ticket_pdf(ORDER)
        self.assertIsInstance(buffer, io.BytesIO)
        self.assertEqual(buffer.tell(), 0)

    def test_output_starts_with_pdf_header(self):
        data = self.engine.generate_ticket_pdf(ORDER).getvalue()
        self.assertTrue(data.startswith(b"%PDF-"))

    def test_incomplete_order_is_rejected(self):
        with self.assertRaises(ValueError):
            self.engine.generate_ticket_pdf({"order_id": "202611"})


if __name__ == "__main__":
    unittest.main()
