"""seat_lock.py: penguncian kursi sementara selama 10 menit untuk keranjang.

Kursi yang masuk keranjang dikunci atas nama satu pemilik (token sesi pembeli). Selama kunci
masih berlaku, pembeli lain tidak bisa mengambil kursi itu. Kunci berakhir otomatis setelah
LOCK_SECONDS, sehingga kursi kembali tersedia tanpa tindakan apa pun.

Mekanisme:
- Setiap kunci menyimpan pemilik dan waktu kedaluwarsa (berbasis time.monotonic).
- Kunci yang sudah kedaluwarsa dibuang setiap kali store diakses, atau lewat purge().
- Semua operasi dijaga satu threading.Lock, aman untuk server multi-thread.
- Jam bisa diganti saat tes, sehingga kedaluwarsa bisa diuji tanpa menunggu 10 menit.
- Kunci hanya ada di memori. Restart server berarti semua kunci hilang.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable

LOCK_SECONDS = 10 * 60


class SeatLockStore:
    """Penyimpan kunci kursi. Kunci dikenali dengan seat_key, misalnya "xxi-imax|D11"."""

    def __init__(self, ttl_seconds: float = LOCK_SECONDS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds harus lebih dari 0.")
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._locks: dict[str, tuple[str, float]] = {}
        self._guard = threading.Lock()

    def _purge_locked(self) -> int:
        """Buang kunci kedaluwarsa. Pemanggil harus sudah memegang _guard."""
        now = self._clock()
        expired = [key for key, (_, until) in self._locks.items() if now >= until]
        for key in expired:
            del self._locks[key]
        return len(expired)

    def purge(self) -> int:
        """Buang semua kunci yang sudah kedaluwarsa. Mengembalikan jumlah kunci yang dibuang."""
        with self._guard:
            return self._purge_locked()

    def acquire(self, seat_key: str, owner: str) -> bool:
        """Kunci kursi untuk pemilik ini, atau perpanjang kunci milik sendiri.

        Mengembalikan False jika kursi sedang dikunci pembeli lain.
        """
        with self._guard:
            self._purge_locked()
            holder = self._locks.get(seat_key)
            if holder is not None and holder[0] != owner:
                return False
            self._locks[seat_key] = (owner, self._clock() + self.ttl_seconds)
            return True

    def release(self, seat_key: str, owner: str) -> bool:
        """Lepas kunci kursi, hanya jika pemiliknya cocok. Mengembalikan True jika berhasil."""
        with self._guard:
            self._purge_locked()
            holder = self._locks.get(seat_key)
            if holder is None or holder[0] != owner:
                return False
            del self._locks[seat_key]
            return True

    def release_all(self, owner: str) -> int:
        """Lepas semua kursi milik pemilik ini. Mengembalikan jumlah kursi yang dilepas."""
        with self._guard:
            self._purge_locked()
            mine = [key for key, (holder, _) in self._locks.items() if holder == owner]
            for key in mine:
                del self._locks[key]
            return len(mine)

    def holder(self, seat_key: str) -> str | None:
        """Pemilik kunci yang berlaku saat ini, atau None jika kursi tidak dikunci."""
        with self._guard:
            self._purge_locked()
            found = self._locks.get(seat_key)
            return found[0] if found else None

    def is_locked_by(self, seat_key: str, owner: str) -> bool:
        return self.holder(seat_key) == owner

    def seconds_left(self, seat_key: str) -> float:
        """Sisa waktu kunci dalam detik. Mengembalikan 0 jika kursi tidak dikunci."""
        with self._guard:
            self._purge_locked()
            found = self._locks.get(seat_key)
            if found is None:
                return 0.0
            return max(0.0, found[1] - self._clock())
