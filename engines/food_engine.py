"""food_engine.py: katalog F&B bioskop (titiket.food) dan keranjang makanan (dikerjakan Teman B).

Yang harus diisi:
- MENU: isi dari data resmi titiket.food. Sumbernya boleh file JSON atau tabel SQLite.
- FoodCart: keranjang makanan. Dipisahkan dari keranjang tiket di shared_state.Cart,
  sehingga kedua modul bisa berjalan sendiri dan diuji terpisah.

Kontrak:
- Harga selalu bilangan bulat dalam rupiah.
- Method yang belum diisi melempar NotImplementedError.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class MenuItem:
    item_id: str
    name: str
    category: str  # contoh: "popcorn", "minuman", "paket"
    price: int     # rupiah, bilangan bulat
    available: bool = True


# Teman B: isi dari data resmi titiket.food.
MENU: tuple[MenuItem, ...] = ()


@dataclass
class FoodLine:
    item: MenuItem
    quantity: int = 1


@dataclass
class FoodCart:
    """Keranjang makanan satu pemesanan."""

    lines: list[FoodLine] = field(default_factory=list)

    def add(self, item_id: str, quantity: int = 1) -> None:
        """Tambahkan item dari MENU. Melempar ValueError jika item tidak ada atau habis."""
        raise NotImplementedError

    def remove(self, item_id: str) -> None:
        """Hapus satu item dari keranjang."""
        raise NotImplementedError

    def total(self) -> int:
        """Total harga semua baris dalam rupiah."""
        raise NotImplementedError


def find_item(item_id: str) -> MenuItem | None:
    """Cari item di MENU berdasarkan item_id."""
    raise NotImplementedError
