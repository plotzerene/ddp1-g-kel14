"""engines: kerangka modul untuk anggota tim.

Setiap file di folder ini berdiri sendiri dan berisi kontrak (kelas, fungsi, dan docstring)
yang akan diisi oleh pemiliknya. Metode yang belum diisi melempar NotImplementedError,
sehingga kode utama tetap berjalan dan tes tetap lulus selama modul belum selesai.

    auth_engine.py          Teman A  autentikasi, SQLite, SSO UI, reset password
    food_engine.py          Teman B  katalog F&B dan keranjang makanan
    payment_engine.py       Teman B  Virtual Account untuk pembayaran
    ticket_pdf_engine.py    Teman B  render e-tiket ke PDF (ReportLab)

Modul-modul ini belum dipanggil dari blueprint. Hubungkan lewat route setelah
implementasinya selesai dan sudah direview.
"""
