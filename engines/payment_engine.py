"""payment_engine.py: simulasi pembayaran dan Virtual Account (dikerjakan Teman B).

Yang harus diisi:
- create_virtual_account: nomor VA unik per pesanan. Hasilnya harus deterministik
  (order_id yang sama menghasilkan nomor yang sama) agar mudah diuji.
- Masa berlaku VA dan validasi nominal.

Pembayaran tetap simulasi. Tidak ada koneksi ke bank atau payment gateway.

Kontrak:
- Method yang belum diisi melempar NotImplementedError.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

SUPPORTED_BANKS: tuple[str, ...] = ("bca", "bni", "bri", "mandiri")


@dataclass(frozen=True)
class VirtualAccount:
    bank: str
    number: str
    amount: int  # rupiah, bilangan bulat
    expires_at: datetime


def create_virtual_account(order_id: str, amount: int, bank: str) -> VirtualAccount:
    """Buat Virtual Account untuk satu pesanan. Melempar ValueError jika bank tidak didukung."""
    raise NotImplementedError
