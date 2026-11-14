"""Tes penguncian kursi 10 menit: engine SeatLockStore dan integrasi dengan keranjang."""

from __future__ import annotations

import threading
import unittest

from app import create_app
from app.blueprints.visualizer.engine.seat_lock import LOCK_SECONDS, SeatLockStore


class FakeClock:
    """Jam palsu supaya kedaluwarsa bisa diuji tanpa menunggu 10 menit."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class SeatLockStoreTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = SeatLockStore(clock=self.clock)

    def test_default_lock_lasts_ten_minutes(self):
        self.assertEqual(LOCK_SECONDS, 600)
        self.assertEqual(SeatLockStore().ttl_seconds, 600)

    def test_other_owner_is_blocked_while_lock_is_active(self):
        self.assertTrue(self.store.acquire("xxi-imax|D11", "A"))
        self.assertFalse(self.store.acquire("xxi-imax|D11", "B"))
        self.assertEqual(self.store.holder("xxi-imax|D11"), "A")

    def test_lock_releases_automatically_after_ttl(self):
        self.store.acquire("k", "A")
        self.clock.advance(LOCK_SECONDS - 1)
        self.assertFalse(self.store.acquire("k", "B"))
        self.clock.advance(1)
        self.assertIsNone(self.store.holder("k"))
        self.assertTrue(self.store.acquire("k", "B"))

    def test_owner_refresh_extends_expiry(self):
        self.store.acquire("k", "A")
        self.clock.advance(500)
        self.assertTrue(self.store.acquire("k", "A"))
        self.clock.advance(500)  # 1000 detik sejak kunci pertama, tetapi hanya 500 detik sejak perpanjangan
        self.assertEqual(self.store.holder("k"), "A")

    def test_seconds_left_counts_down_to_zero(self):
        self.store.acquire("k", "A")
        self.clock.advance(100)
        self.assertEqual(self.store.seconds_left("k"), 500)
        self.clock.advance(1000)
        self.assertEqual(self.store.seconds_left("k"), 0.0)

    def test_release_requires_matching_owner(self):
        self.store.acquire("k", "A")
        self.assertFalse(self.store.release("k", "B"))
        self.assertTrue(self.store.release("k", "A"))
        self.assertIsNone(self.store.holder("k"))

    def test_release_all_frees_every_seat_of_one_owner(self):
        self.store.acquire("s1", "A")
        self.store.acquire("s2", "A")
        self.store.acquire("s3", "B")
        self.assertEqual(self.store.release_all("A"), 2)
        self.assertIsNone(self.store.holder("s1"))
        self.assertEqual(self.store.holder("s3"), "B")

    def test_purge_counts_only_expired_locks(self):
        self.store.acquire("lama", "A")
        self.clock.advance(300)
        self.store.acquire("baru", "B")
        self.clock.advance(300)  # "lama" sudah 600 detik, "baru" baru 300 detik
        self.assertEqual(self.store.purge(), 1)
        self.assertEqual(self.store.holder("baru"), "B")

    def test_invalid_ttl_is_rejected(self):
        with self.assertRaises(ValueError):
            SeatLockStore(ttl_seconds=0)

    def test_concurrent_requests_have_exactly_one_winner(self):
        results: list[bool] = []
        guard = threading.Lock()
        barrier = threading.Barrier(20)

        def attempt(owner: str) -> None:
            barrier.wait()
            granted = self.store.acquire("xxi-imax|D11", owner)
            with guard:
                results.append(granted)

        threads = [threading.Thread(target=attempt, args=(f"pembeli-{i}",)) for i in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count(True), 1)
        self.assertEqual(len(results), 20)


class CartLockIntegrationTests(unittest.TestCase):
    PAYLOAD = {"venue_id": "xxi-imax", "selector": {"seat_id": "D11"}, "body_height_cm": 165}
    REMOVE = {"venue_id": "xxi-imax", "seat_id": "D11"}

    def setUp(self):
        self.app = create_app()
        self.buyer = self.app.test_client()
        self.other = self.app.test_client()

    def test_second_buyer_is_blocked_until_first_removes_seat(self):
        first = self.buyer.post("/visualizer/api/cart", json=self.PAYLOAD)
        self.assertEqual(first.status_code, 201)

        second = self.other.post("/visualizer/api/cart", json=self.PAYLOAD)
        self.assertEqual(second.status_code, 409)
        self.assertIn("sedang dipilih pembeli lain", second.get_json()["error"])

        removed = self.buyer.post("/visualizer/api/cart/remove", json=self.REMOVE)
        self.assertEqual(removed.get_json()["status"], "removed")
        self.assertEqual(self.other.post("/visualizer/api/cart", json=self.PAYLOAD).status_code, 201)

    def test_expired_lock_drops_item_and_frees_seat(self):
        clock = FakeClock()
        self.app.config["SEAT_LOCKS"] = SeatLockStore(clock=clock)
        self.assertEqual(self.buyer.post("/visualizer/api/cart", json=self.PAYLOAD).status_code, 201)

        clock.advance(LOCK_SECONDS)
        state = self.buyer.get("/visualizer/api/cart").get_json()
        self.assertEqual(state["count"], 0)
        self.assertEqual(self.other.post("/visualizer/api/cart", json=self.PAYLOAD).status_code, 201)


if __name__ == "__main__":
    unittest.main()
