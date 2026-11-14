"""Tes TDD untuk integrasi SSO UI (dikerjakan Teman A).

Tes ini sengaja gagal (merah) sampai implementasi di engines/auth_engine.py diisi.
Setiap tes mendefinisikan perilaku yang harus dipenuhi.
"""

from __future__ import annotations

import unittest

from engines.auth_engine import OTP_LENGTH, AuthManager


class SsoEmailDomainTests(unittest.TestCase):
    def setUp(self):
        self.auth = AuthManager(":memory:")

    def test_ui_email_is_accepted(self):
        self.assertTrue(self.auth.verify_sso_email("mahasiswa@ui.ac.id"))

    def test_domain_check_ignores_letter_case(self):
        self.assertTrue(self.auth.verify_sso_email("Mahasiswa@UI.AC.ID"))

    def test_other_domains_are_rejected(self):
        for email in ("mahasiswa@gmail.com", "mahasiswa@ui.ac.id.com", "mahasiswa@ui.ac.idx"):
            with self.subTest(email=email):
                self.assertFalse(self.auth.verify_sso_email(email))

    def test_email_without_local_part_is_rejected(self):
        self.assertFalse(self.auth.verify_sso_email("@ui.ac.id"))


class OtpTests(unittest.TestCase):
    def setUp(self):
        self.auth = AuthManager(":memory:")
        self.email = "mahasiswa@ui.ac.id"

    def test_otp_has_six_digits(self):
        code = self.auth.issue_otp(self.email)
        self.assertEqual(len(code), OTP_LENGTH)
        self.assertTrue(code.isdigit())

    def test_correct_code_verifies(self):
        code = self.auth.issue_otp(self.email)
        self.assertTrue(self.auth.validate_otp(self.email, code))

    def test_wrong_code_is_rejected(self):
        code = self.auth.issue_otp(self.email)
        wrong = "000000" if code != "000000" else "111111"
        self.assertFalse(self.auth.validate_otp(self.email, wrong))

    def test_code_is_single_use(self):
        code = self.auth.issue_otp(self.email)
        self.assertTrue(self.auth.validate_otp(self.email, code))
        self.assertFalse(self.auth.validate_otp(self.email, code))


class StudentDiscountTests(unittest.TestCase):
    def setUp(self):
        self.auth = AuthManager(":memory:")

    def test_fifteen_percent_off_base_ticket_price_for_students(self):
        self.assertEqual(self.auth.apply_student_discount(100000, is_ui_student=True), 85000)

    def test_non_students_pay_full_price(self):
        self.assertEqual(self.auth.apply_student_discount(100000, is_ui_student=False), 100000)


if __name__ == "__main__":
    unittest.main()
