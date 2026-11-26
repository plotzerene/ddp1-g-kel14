/* ==========================================================================
   eticket.js — Generator file .ics (RFC 5545) murni sisi klien untuk E-Tiket
   ========================================================================== */
(() => {
  const MONTH_MAP = {
    jan: 1, januari: 1, january: 1,
    feb: 2, februari: 2, february: 2,
    mar: 3, maret: 3, march: 3,
    apr: 4, april: 4,
    mei: 5, may: 5,
    jun: 6, juni: 6, june: 6,
    jul: 7, juli: 7, july: 7,
    agu: 8, ags: 8, agustus: 8, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    okt: 10, oktober: 10, oct: 10, october: 10,
    nov: 11, november: 11,
    des: 12, desember: 12, dec: 12, december: 12,
  };

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatUtcStamp(date) {
    return (
      date.getUTCFullYear()
      + pad2(date.getUTCMonth() + 1)
      + pad2(date.getUTCDate())
      + 'T'
      + pad2(date.getUTCHours())
      + pad2(date.getUTCMinutes())
      + pad2(date.getUTCSeconds())
      + 'Z'
    );
  }

  function parseShowDateTime(dateStr, timeStr) {
    const rawDate = String(dateStr || '').trim();
    const rawTime = String(timeStr || '').trim();

    let hour = 19;
    let minute = 0;
    const timeMatch = rawTime.match(/(\d{1,2})[:.](\d{2})/);
    if (timeMatch) {
      hour = Math.min(23, Math.max(0, Number(timeMatch[1])));
      minute = Math.min(59, Math.max(0, Number(timeMatch[2])));
    }

    let year = 2026;
    let month = 11;
    let day = 14;

    const isoMatch = rawDate.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    const idMatch = rawDate.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (isoMatch) {
      year = Number(isoMatch[1]);
      month = Number(isoMatch[2]);
      day = Number(isoMatch[3]);
    } else if (idMatch) {
      day = Number(idMatch[1]);
      const token = idMatch[2].toLowerCase();
      month = MONTH_MAP[token] || MONTH_MAP[token.slice(0, 3)] || 1;
      year = Number(idMatch[3]);
    }

    // Waktu acara menggunakan WIB (UTC+7); konversi ke UTC untuk kompatibilitas universal iOS/Android/Google Calendar.
    const startUtc = new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0));
    return startUtc;
  }

  function escapeIcs(text) {
    return String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  }

  function slugify(text) {
    return String(text || 'acara')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'acara';
  }

  function showToast(message) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const item = document.createElement('div');
    item.className = 'toast toast--success';
    item.textContent = message;
    region.appendChild(item);
    window.setTimeout(() => item.remove(), 3000);
  }

  function buildIcsContent(data) {
    const startUtc = parseShowDateTime(data.show_date, data.show_time);
    const durationHours = data.is_concert ? 3 : 2;
    const endUtc = new Date(startUtc.getTime() + durationHours * 3600 * 1000);
    const nowUtc = new Date();

    const seatsText = Array.isArray(data.seats) && data.seats.length ? data.seats.join(', ') : '-';
    const codesText = Array.isArray(data.ticket_codes) && data.ticket_codes.length ? data.ticket_codes.join(', ') : (data.order_code || '-');
    const seatDescLabel = data.is_concert ? 'Posisi' : 'Kursi';
    const description = `E-Tiket Resmi titiket.com | ${seatDescLabel}: ${seatsText} | Gate: ${data.gate || data.location || '-'} | No. Tiket: ${codesText}`;

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//titiket.com//Ticketing//ID',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${escapeIcs((data.order_code || 'tiket') + '@titiket.com')}`,
      `DTSTAMP:${formatUtcStamp(nowUtc)}`,
      `DTSTART:${formatUtcStamp(startUtc)}`,
      `DTEND:${formatUtcStamp(endUtc)}`,
      `SUMMARY:${escapeIcs(data.title || 'Acara titiket.com')}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      `LOCATION:${escapeIcs(data.location || 'Indonesia')}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ];
    return `${lines.join('\r\n')}\r\n`;
  }

  function downloadIcs(data) {
    const content = buildIcsContent(data);
    const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tiket-${slugify(data.title)}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('File kalender (.ics) berhasil diunduh.');
  }

  async function copyTextSafe(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback textarea copy di bawah.
      }
    }
    try {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand('copy');
      helper.remove();
      return ok;
    } catch {
      return false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('save-calendar-btn');
    const dataNode = document.getElementById('eticket-calendar-data');
    if (btn && dataNode) {
      let payload = null;
      try {
        payload = JSON.parse(dataNode.textContent || '{}');
      } catch {
        payload = null;
      }
      if (payload) {
        btn.addEventListener('click', () => downloadIcs(payload));
      }
    }

    const inviteBtn = document.getElementById('invite-friend-btn');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', async () => {
        const rawUrl = inviteBtn.getAttribute('data-friend-url');
        if (!rawUrl) return;
        const absUrl = new URL(rawUrl, window.location.origin).toString();
        await copyTextSafe(absUrl);
        showToast('Tautan ajak teman berhasil disalin!');
      });
    }
  });
})();
