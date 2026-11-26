// checkout_ui.js: add-on inline notes, strict 4-option payment selection, timers, dan modal pembatalan.
(function () {
  var bootEl = document.getElementById('checkout-bootstrap');
  var boot = {};
  if (bootEl) {
    try { boot = JSON.parse(bootEl.textContent || '{}'); } catch (e) { boot = {}; }
  }

  var form = document.querySelector('.buyer-form');
  var ssoBox = document.getElementById('sso-promo-box');
  var ssoStatus = document.getElementById('sso-promo-status');
  var ssoActionBtn = document.getElementById('sso-verify-trigger');
  var discountRow = document.getElementById('sso-discount-row');
  var discountAmountEl = document.getElementById('sso-discount-amount');
  var grandTotalEl = document.getElementById('checkout-grand-total');
  var payBtnAmountEl = document.getElementById('pay-btn-amount');
  var summaryAddonRow = document.getElementById('summary-addon-row');
  var summaryAddonAmount = document.getElementById('summary-addon-amount');

  var instPanel = document.getElementById('payment-instruction-panel');
  var instLogoWrap = document.getElementById('inst-logo-wrap');
  var instLogo = document.getElementById('inst-channel-logo');
  var instName = document.getElementById('inst-channel-name');
  var instKindBadge = document.getElementById('inst-kind-badge');
  var instCodeBox = document.getElementById('inst-code-box');
  var instCodeVal = document.getElementById('inst-code-value');
  var instQrisBox = document.getElementById('inst-qris-box');
  var instEwalletBox = document.getElementById('inst-ewallet-box');
  var instDeeplinkBtn = document.getElementById('inst-deeplink-btn');
  var instGuide = document.getElementById('inst-guide-text');
  var copyBtn = document.getElementById('copy-code-btn');
  var copyLabel = document.getElementById('copy-code-label');
  var copyToast = document.getElementById('copy-toast');
  var errorBanner = document.getElementById('payment-error-banner');
  var errorTitleEl = document.getElementById('payment-error-title');
  var errorDescEl = document.getElementById('payment-error-desc');

  var seatHoldEl = document.getElementById('seat-hold-countdown');
  var payTimerPill = document.getElementById('pay-timer-pill');
  var countdownEl = document.getElementById('payment-countdown');
  var instCountdownEl = document.getElementById('inst-countdown');
  var paySubmitBtn = document.getElementById('pay-submit-btn');
  var paySubmitLabel = document.getElementById('pay-submit-label');

  var sameToggle = document.getElementById('attendee-same-toggle');
  var nameInput = document.getElementById('name');
  var emailInput = document.getElementById('email');
  var nameErrorEl = document.getElementById('name-error');
  var emailErrorEl = document.getElementById('email-error');
  var methodErrorEl = document.getElementById('method-error');
  var formAlertEl = document.getElementById('checkout-form-alert');
  var formAlertTextEl = document.getElementById('checkout-form-alert-text');

  var cancelBtn = document.getElementById('cancel-tx-btn');
  var cancelDialog = document.getElementById('cancel-tx-dialog');
  var cancelCloseBtn = document.getElementById('cancel-tx-close');
  var cancelConfirmYes = document.getElementById('cancel-confirm-yes');
  var cancelBackBtn = document.getElementById('cancel-back-btn');
  var cancelStepConfirm = document.getElementById('cancel-step-confirm');
  var cancelStepReasons = document.getElementById('cancel-step-reasons');

  var addonModal = document.getElementById('addon-catalog-modal');
  var openAddonModalBtn = document.getElementById('open-addon-catalog-btn');
  var addonSummaryBox = document.getElementById('addon-order-summary');
  var addonSummaryCount = document.getElementById('addon-summary-count');
  var addonSummaryList = document.getElementById('selected-addons-list');
  var addonSheetCount = document.getElementById('addon-sheet-total-items');
  var addonSheetPrice = document.getElementById('addon-sheet-total-price');

  var URGENT_SECONDS = 120; // 2 menit terakhir: warna merah + pulse lembut
  var paymentStep = 'review';
  var paymentTimerHandle = null;
  var seatHoldTimerHandle = null;
  var activeOrderCode = boot.pending_order ? boot.pending_order.code : '';
  var currentFinalTotal = grandTotalEl ? Number(grandTotalEl.dataset.total || 0) : 0;

  function formatRupiah(amount) {
    var num = Math.max(0, Math.round(Number(amount) || 0));
    return 'Rp ' + num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function formatClock(seconds) {
    var safe = Math.max(0, Number(seconds) || 0);
    var mm = String(Math.floor(safe / 60)).padStart(2, '0');
    var ss = String(safe % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {})
    });
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    return { ok: res.ok, status: res.status, data: data };
  }

  function applySsoState() {
    if (!grandTotalEl) return;
    var baseSubtotal = Number(grandTotalEl.dataset.subtotal || 0);
    var baseTotal = Number(grandTotalEl.dataset.total || 0);
    var rate = Number(grandTotalEl.dataset.ssoRate || 0.15);
    var verified = false;
    try {
      verified = window.localStorage.getItem('titiket-sso-ui') === 'verified'
        || (document.body && document.body.dataset.userUi === '1');
    } catch (_) {}

    var discount = verified ? Math.round(baseSubtotal * rate) : 0;
    currentFinalTotal = Math.max(0, baseTotal - discount);

    if (ssoBox) ssoBox.classList.toggle('is-verified', verified);
    if (ssoStatus) {
      ssoStatus.textContent = verified
        ? 'Aktif · Potongan mahasiswa UI 15% otomatis diterapkan.'
        : 'Masuk dengan akun SSO UI untuk menikmati potongan 15% harga dasar tiket.';
    }
    if (ssoActionBtn) ssoActionBtn.hidden = verified;
    if (discountRow) discountRow.hidden = !verified;
    if (discountAmountEl) discountAmountEl.textContent = '- ' + formatRupiah(discount);
    grandTotalEl.textContent = formatRupiah(currentFinalTotal);
    var amountEl = document.getElementById('pay-btn-amount');
    if (amountEl) amountEl.textContent = formatRupiah(currentFinalTotal);
  }

  function renderAddonsUI(payload) {
    var addons = (payload && payload.addons) || [];
    var addonSubtotal = Number((payload && payload.addon_subtotal) || 0);
    var addonCount = Number((payload && payload.addon_count) || 0);
    var totals = (payload && payload.totals) || null;
    var byId = {};
    addons.forEach(function (item) { byId[item.item_id] = item; });

    document.querySelectorAll('[data-addon-qty]').forEach(function (el) {
      var id = el.getAttribute('data-addon-qty');
      var entry = byId[id];
      var qty = entry ? Number(entry.qty || 0) : 0;
      el.textContent = String(qty);

      var scope = el.closest('.addon-card') || document;
      var noteArea = scope.querySelector('[data-addon-note-area="' + id + '"]');
      var noteDisplay = scope.querySelector('[data-addon-note-display="' + id + '"]');
      var noteText = scope.querySelector('[data-addon-note-text="' + id + '"]');
      var openNoteBtn = scope.querySelector('[data-addon-open-note="' + id + '"]');
      var editor = scope.querySelector('[data-addon-editor="' + id + '"]');
      var input = scope.querySelector('[data-addon-input="' + id + '"]');

      if (noteArea) noteArea.hidden = qty <= 0;
      var note = entry ? String(entry.note || '') : '';
      if (noteText) noteText.textContent = note;
      if (noteDisplay) noteDisplay.hidden = !note;
      if (openNoteBtn) openNoteBtn.hidden = Boolean(note) || (editor && !editor.hidden);
      if (input && editor && editor.hidden) input.value = note;
    });

    if (addonSummaryBox && addonSummaryList) {
      addonSummaryBox.hidden = addons.length === 0;
      if (addonSummaryCount) addonSummaryCount.textContent = addonCount + ' item';
      addonSummaryList.innerHTML = '';
      addons.forEach(function (a) {
        var li = document.createElement('li');
        li.className = 'addon-summary-item';
        li.setAttribute('data-summary-addon', a.item_id);

        var main = document.createElement('div');
        main.className = 'addon-summary-item__main';
        var titleEl = document.createElement('strong');
        titleEl.textContent = a.name;
        var metaEl = document.createElement('span');
        metaEl.className = 'addon-summary-item__meta num';
        metaEl.textContent = '×' + a.qty + ' · ' + formatRupiah(a.line_total) + ' · ' + a.fulfillment;
        main.appendChild(titleEl);
        main.appendChild(metaEl);

        if (a.note) {
          var noteRow = document.createElement('div');
          noteRow.className = 'addon-summary-item__note';
          var qSpan = document.createElement('span');
          qSpan.textContent = '↳ Catatan: "' + a.note + '"';
          var editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'addon-note-trigger';
          editBtn.setAttribute('data-addon-edit-note', a.item_id);
          editBtn.textContent = 'Ubah';
          noteRow.appendChild(qSpan);
          noteRow.appendChild(editBtn);
          main.appendChild(noteRow);
        } else {
          var addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'addon-note-trigger';
          addBtn.setAttribute('data-addon-open-note', a.item_id);
          addBtn.textContent = '+ Tambah Catatan (opsional)';
          main.appendChild(addBtn);
        }
        li.appendChild(main);
        addonSummaryList.appendChild(li);
      });
    }

    if (addonSheetCount) addonSheetCount.textContent = addonCount + ' item';
    if (addonSheetPrice) addonSheetPrice.textContent = formatRupiah(addonSubtotal);

    if (summaryAddonRow && summaryAddonAmount) {
      summaryAddonRow.hidden = addonSubtotal <= 0;
      summaryAddonAmount.textContent = formatRupiah(addonSubtotal);
    }

    if (totals && grandTotalEl) {
      grandTotalEl.dataset.subtotal = String(totals.subtotal);
      grandTotalEl.dataset.total = String(totals.total);
      grandTotalEl.dataset.addonTotal = String(totals.addon_subtotal || 0);
      applySsoState();
    }
  }

  async function updateAddon(itemId, qty, note) {
    var res = await postJson('/checkout/api/addons', {
      item_id: itemId,
      qty: qty,
      note: note
    });
    if (res.ok) renderAddonsUI(res.data);
  }

  // scope = kartu add-on tempat tombol diklik; ringkasan "Add-on dalam Pesanan" jatuh ke kartu cepat.
  function openInlineNoteEditor(itemId, scope) {
    scope = scope || document;
    var area = scope.querySelector('[data-addon-note-area="' + itemId + '"]');
    var editor = scope.querySelector('[data-addon-editor="' + itemId + '"]');
    var openBtn = scope.querySelector('[data-addon-open-note="' + itemId + '"]');
    var display = scope.querySelector('[data-addon-note-display="' + itemId + '"]');
    var input = scope.querySelector('[data-addon-input="' + itemId + '"]');
    if (area) {
      area.hidden = false;
      area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (editor) editor.hidden = false;
    if (openBtn) openBtn.hidden = true;
    if (display) display.hidden = true;
    if (input) input.focus();
  }

  function closeInlineNoteEditor(itemId, scope) {
    scope = scope || document;
    var editor = scope.querySelector('[data-addon-editor="' + itemId + '"]');
    var openBtn = scope.querySelector('[data-addon-open-note="' + itemId + '"]');
    var display = scope.querySelector('[data-addon-note-display="' + itemId + '"]');
    var noteText = scope.querySelector('[data-addon-note-text="' + itemId + '"]');
    if (editor) editor.hidden = true;
    var hasNote = noteText && noteText.textContent.trim().length > 0;
    if (display) display.hidden = !hasNote;
    if (openBtn) openBtn.hidden = hasNote;
  }

  document.addEventListener('click', async function (event) {
    var qtyBtn = event.target.closest('[data-addon-delta]');
    if (qtyBtn) {
      var id = qtyBtn.getAttribute('data-addon-id');
      var delta = Number(qtyBtn.getAttribute('data-addon-delta') || 0);
      var qtyEl = document.querySelector('[data-addon-qty="' + id + '"]');
      var currentQty = qtyEl ? Number(qtyEl.textContent || 0) : 0;
      var nextQty = Math.max(0, currentQty + delta);
      await updateAddon(id, nextQty, undefined);
      return;
    }

    var openNote = event.target.closest('[data-addon-open-note], [data-addon-edit-note]');
    if (openNote) {
      var noteId = openNote.getAttribute('data-addon-open-note') || openNote.getAttribute('data-addon-edit-note');
      if (noteId) openInlineNoteEditor(noteId, openNote.closest('.addon-card') || document);
      return;
    }

    var saveNote = event.target.closest('[data-addon-save-note]');
    if (saveNote) {
      var saveId = saveNote.getAttribute('data-addon-save-note');
      var saveScope = saveNote.closest('.addon-card') || document;
      var inputEl = saveScope.querySelector('[data-addon-input="' + saveId + '"]');
      var qEl = saveScope.querySelector('[data-addon-qty="' + saveId + '"]');
      var curQty = Math.max(1, Number(qEl ? qEl.textContent : 1));
      await updateAddon(saveId, curQty, inputEl ? inputEl.value.trim() : '');
      closeInlineNoteEditor(saveId, saveScope);
      return;
    }

    var cancelNote = event.target.closest('[data-addon-cancel-note]');
    if (cancelNote) {
      closeInlineNoteEditor(cancelNote.getAttribute('data-addon-cancel-note'), cancelNote.closest('.addon-card') || document);
      return;
    }

    if (event.target.closest('#open-addon-catalog-btn') && addonModal) {
      addonModal.hidden = false;
      return;
    }
    if (event.target.closest('[data-addon-modal-close]') && addonModal) {
      addonModal.hidden = true;
      return;
    }

    var accBtn = event.target.closest('[data-pay-accordion]');
    if (accBtn) {
      var targetGroup = accBtn.getAttribute('data-pay-accordion');
      document.querySelectorAll('.pay-tile').forEach(function (tile) {
        var grp = tile.getAttribute('data-pay-group');
        var isTarget = grp === targetGroup;
        tile.classList.toggle('is-open', isTarget);
        var body = tile.querySelector('.pay-tile__body');
        var toggle = tile.querySelector('[data-pay-accordion]');
        if (body) body.hidden = !isTarget;
        if (toggle) toggle.setAttribute('aria-expanded', String(isTarget));
      });
      var firstSub = document.querySelector('.pay-tile[data-pay-group="' + targetGroup + '"] input[name="method"]');
      if (firstSub && !document.querySelector('.pay-tile[data-pay-group="' + targetGroup + '"] input[name="method"]:checked')) {
        firstSub.checked = true;
      }
      setFieldError(null, methodErrorEl, '');
    }
  });

  var addonSearchInput = document.getElementById('addon-catalog-search');
  var addonCatFilters = Array.from(document.querySelectorAll('[data-addon-cat-filter]'));
  var activeAddonCat = 'all';
  function filterAddonModal() {
    var q = (addonSearchInput ? addonSearchInput.value : '').trim().toLowerCase();
    document.querySelectorAll('[data-addon-modal-item]').forEach(function (card) {
      var cat = card.getAttribute('data-addon-cat') || '';
      var hay = card.getAttribute('data-addon-search') || '';
      var show = (activeAddonCat === 'all' || cat === activeAddonCat) && (!q || hay.includes(q));
      card.hidden = !show;
    });
  }
  if (addonSearchInput) addonSearchInput.addEventListener('input', filterAddonModal);
  addonCatFilters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeAddonCat = btn.getAttribute('data-addon-cat-filter') || 'all';
      addonCatFilters.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
      filterAddonModal();
    });
  });

  function setPaymentRadiosLocked(locked, selectedValue) {
    if (!form) return;
    var radios = document.querySelectorAll('input[name="method"]');
    radios.forEach(function (radio) {
      radio.disabled = locked;
      var card = radio.closest('.pay-channel, .pay-tile');
      if (card) {
        card.classList.toggle('is-locked', locked && radio.value !== selectedValue);
        card.classList.toggle('is-selected-locked', locked && radio.value === selectedValue);
      }
    });
  }

  function showPaymentErrorBanner(title, desc) {
    if (!errorBanner) return;
    if (errorTitleEl && title) errorTitleEl.textContent = title;
    if (errorDescEl && desc) errorDescEl.textContent = desc;
    errorBanner.hidden = false;
    if (paySubmitBtn) paySubmitBtn.disabled = true;
    if (typeof errorBanner.scrollIntoView === 'function') {
      errorBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function populateInstruction(input, order) {
    if (!instPanel || !input) return;
    var kind = input.dataset.kind || 'qris';
    var label = input.dataset.label || input.value.toUpperCase();
    var logo = input.dataset.logo || '';
    var code = (order && order.payment_code) || input.dataset.code || '88010 0812 9940 112';
    var deeplink = (order && order.deeplink) || input.dataset.deeplink || '';

    if (instName) instName.textContent = label;
    if (instLogo && instLogoWrap) {
      if (logo) {
        instLogo.src = logo;
        instLogo.alt = label;
        instLogoWrap.hidden = false;
      } else {
        instLogoWrap.hidden = true;
      }
    }

    var kindLabels = {
      qris: 'QRIS Instan',
      va: 'Virtual Account',
      ewallet: 'Dompet Digital',
      retail: 'Kode Gerai Ritel',
      card: 'Kartu Kredit / Debit'
    };
    if (instKindBadge) instKindBadge.textContent = kindLabels[kind] || 'Kanal Resmi';

    var isQris = kind === 'qris';
    var isEwallet = kind === 'ewallet';
    var isCard = kind === 'card';
    if (instQrisBox) instQrisBox.hidden = !isQris;
    if (instEwalletBox) instEwalletBox.hidden = !isEwallet;
    if (instDeeplinkBtn && deeplink) {
      instDeeplinkBtn.href = deeplink;
      instDeeplinkBtn.textContent = 'Buka Aplikasi ' + label + ' ↗';
    }
    if (instCodeBox) instCodeBox.hidden = isQris || isCard;
    if (instCodeVal) instCodeVal.textContent = code;

    if (instGuide) {
      if (kind === 'qris') {
        instGuide.textContent = 'Pindai kode QR dinamis di atas di aplikasi bank atau dompet digital Anda, lalu tekan konfirmasi.';
      } else if (kind === 'ewallet') {
        instGuide.textContent = 'Klik tombol Buka Aplikasi ' + label + ' atau konfirmasi notifikasi pembayaran di ponsel Anda.';
      } else if (kind === 'card') {
        instGuide.textContent = 'Otorisasi 3D Secure aktif. Tekan konfirmasi untuk menyelesaikan transaksi kartu Anda.';
      } else {
        instGuide.textContent = 'Salin nomor Virtual Account ke menu transfer bank Anda sebelum menekan konfirmasi.';
      }
    }
  }

  function stopPaymentCountdown() {
    if (paymentTimerHandle) {
      window.clearInterval(paymentTimerHandle);
      paymentTimerHandle = null;
    }
    if (payTimerPill) payTimerPill.hidden = true;
    var holdPill = document.getElementById('seat-hold-pill');
    if (holdPill) holdPill.hidden = false;
  }

  function startPaymentCountdown(initialSeconds) {
    stopPaymentCountdown();
    if (payTimerPill) payTimerPill.hidden = false;
    var seatPill = document.getElementById('seat-hold-pill');
    if (seatPill) seatPill.hidden = true;
    var remaining = initialSeconds > 0 ? Math.floor(initialSeconds) : 900;
    function tick() {
      var formatted = formatClock(remaining);
      if (countdownEl) countdownEl.textContent = formatted;
      if (instCountdownEl) instCountdownEl.textContent = formatted;
      if (payTimerPill) payTimerPill.classList.toggle('is-urgent', remaining <= URGENT_SECONDS);
      if (remaining <= 0) {
        stopPaymentCountdown();
        postJson('/checkout/cancel', {
          action: 'payment_expired',
          order_code: activeOrderCode
        }).then(function () {
          showPaymentErrorBanner(
            'Pembayaran Gagal / Kedaluwarsa',
            'Batas waktu pembayaran telah berakhir. Silakan pilih ulang jadwal atau posisi tiket Anda.'
          );
        });
        return;
      }
      remaining -= 1;
    }
    tick();
    paymentTimerHandle = window.setInterval(tick, 1000);
  }

  function startSeatHoldMonitor() {
    var holdSeconds = Number(boot.lock_remaining_seconds);
    if (!holdSeconds || holdSeconds <= 0 || boot.checkout_mode === 'merch') return;
    if (seatHoldTimerHandle) window.clearInterval(seatHoldTimerHandle);
    seatHoldTimerHandle = window.setInterval(function () {
      if (holdSeconds > 0) {
        holdSeconds -= 1;
        if (seatHoldEl) {
          seatHoldEl.textContent = formatClock(holdSeconds);
          var holdPill = document.getElementById('seat-hold-pill');
          if (holdPill) holdPill.classList.toggle('is-urgent', holdSeconds <= URGENT_SECONDS);
        }
        if (holdSeconds <= 0) {
          window.clearInterval(seatHoldTimerHandle);
          seatHoldTimerHandle = null;
          if (paymentStep === 'review' && window.TitiketModals) {
            window.TitiketModals.showExpiredReservation({
              standing: Boolean(boot.is_standing_only),
              onRestart: async function () {
                await postJson('/checkout/cancel', { action: 'expired_hold', order_code: activeOrderCode });
                window.location.href = boot.stepper_viz_href || '/';
              }
            });
          }
        }
      }
    }, 1000);
  }

  function setFieldError(inputEl, errorEl, message) {
    if (errorEl) {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }
    if (inputEl) {
      if (message) inputEl.setAttribute('aria-invalid', 'true');
      else inputEl.removeAttribute('aria-invalid');
    }
  }

  // Data Penonton per Kursi: "Samakan data penonton berikutnya" menyalin Penonton 1 ke penonton 2..N.
  function attendeeFields(n) {
    var box = document.querySelector('[data-attendee="' + n + '"]');
    return box ? box.querySelectorAll('[data-attendee-field]') : [];
  }

  function syncAttendees() {
    var on = !!(sameToggle && sameToggle.checked);
    document.querySelectorAll('[data-attendee]').forEach(function (box) {
      var n = Number(box.getAttribute('data-attendee'));
      if (n < 2) return;
      box.classList.toggle('is-synced', on);
      box.querySelectorAll('[data-attendee-field]').forEach(function (input) {
        var key = input.getAttribute('data-attendee-field');
        var src = document.querySelector('[data-attendee="1"] [data-attendee-field="' + key + '"]');
        input.readOnly = on;
        if (on && src) input.value = src.value;
      });
    });
  }

  function validateExtraAttendees() {
    var bad = 0;
    var first = null;
    document.querySelectorAll('[data-attendee]').forEach(function (box) {
      var n = Number(box.getAttribute('data-attendee'));
      if (n < 2) return;
      var nameEl = box.querySelector('[data-attendee-field="name"]');
      var errEl = nameEl && nameEl.closest('.field').querySelector('.field__error');
      var ok = nameEl && nameEl.value.trim().length >= 3;
      setFieldError(nameEl, errEl, ok ? '' : 'Nama Penonton ' + n + ' minimal 3 karakter.');
      if (!ok) { bad += 1; first = first || nameEl; }
    });
    return { count: bad, first: first };
  }

  function validateCheckoutForm() {
    var count = 0;
    var firstBad = null;
    var emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

    var nameVal = nameInput ? nameInput.value.trim() : '';
    if (nameVal.length < 3) {
      setFieldError(nameInput, nameErrorEl, 'Nama minimal 3 karakter.');
      count += 1;
      firstBad = firstBad || nameInput;
    } else {
      setFieldError(nameInput, nameErrorEl, '');
    }

    var emailVal = emailInput ? emailInput.value.trim() : '';
    if (!emailRe.test(emailVal)) {
      setFieldError(emailInput, emailErrorEl, 'Format email belum benar, contoh: nama@email.com.');
      count += 1;
      firstBad = firstBad || emailInput;
    } else {
      setFieldError(emailInput, emailErrorEl, '');
    }

    var extra = validateExtraAttendees();
    count += extra.count;
    firstBad = firstBad || extra.first;

    var checked = document.querySelector('input[name="method"]:checked');
    if (!checked) {
      setFieldError(null, methodErrorEl, 'Pilih salah satu metode pembayaran terlebih dahulu.');
      count += 1;
      firstBad = firstBad || document.querySelector('input[name="method"]');
    } else {
      setFieldError(null, methodErrorEl, '');
    }

    if (formAlertEl && formAlertTextEl) {
      if (count > 0) {
        formAlertTextEl.textContent = 'Periksa lagi ' + count + ' isian di bawah.';
        formAlertEl.hidden = false;
      } else {
        formAlertEl.hidden = true;
      }
    }
    if (firstBad && typeof firstBad.focus === 'function') firstBad.focus();
    return count === 0 ? checked : null;
  }

  function enterInstructionStep(checkedRadio, pendingOrder, shouldScroll) {
    if (!instPanel || !checkedRadio) return;
    paymentStep = 'instructing';
    if (pendingOrder && pendingOrder.code) activeOrderCode = pendingOrder.code;
    populateInstruction(checkedRadio, pendingOrder);
    instPanel.hidden = false;
    setPaymentRadiosLocked(true, checkedRadio.value);
    var secs = pendingOrder && Number(pendingOrder.remaining_seconds) > 0
      ? Number(pendingOrder.remaining_seconds)
      : 900;
    startPaymentCountdown(secs);
    if (paySubmitLabel) {
      paySubmitLabel.textContent = 'Saya sudah bayar, terbitkan e-tiket';
    }
    if (shouldScroll && typeof instPanel.scrollIntoView === 'function') {
      instPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Status memuat pada tombol Bayar Sekarang (spinner + nonaktif sampai respons server).
  function setPayLoading(on) {
    if (!paySubmitBtn) return;
    paySubmitBtn.classList.toggle('is-loading', on);
    paySubmitBtn.setAttribute('aria-busy', String(on));
    paySubmitBtn.disabled = on;
  }

  function unlockMethodSelection() {
    paymentStep = 'review';
    setPaymentRadiosLocked(false, '');
    if (instPanel) instPanel.hidden = true;
    stopPaymentCountdown();
    if (paySubmitLabel) {
      paySubmitLabel.innerHTML = 'Bayar Sekarang <span id="pay-btn-amount">' + formatRupiah(currentFinalTotal) + '</span>';
      payBtnAmountEl = document.getElementById('pay-btn-amount');
    }
  }

  if (form) {
    var radios = document.querySelectorAll('input[name="method"]');
    radios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        setFieldError(null, methodErrorEl, '');
        var parentTile = radio.closest('.pay-tile');
        document.querySelectorAll('.pay-tile').forEach(function (tile) {
          var isMe = tile === parentTile;
          tile.classList.toggle('is-open', isMe);
          var body = tile.querySelector('.pay-tile__body');
          var toggle = tile.querySelector('[data-pay-accordion]');
          if (body) body.hidden = !isMe;
          if (toggle) toggle.setAttribute('aria-expanded', String(isMe));
        });
      });
    });

    if (sameToggle) sameToggle.addEventListener('change', syncAttendees);
    document.querySelectorAll('[data-attendee="1"] [data-attendee-field]').forEach(function (input) {
      input.addEventListener('input', syncAttendees);
    });
    syncAttendees();

    if (nameInput) {
      nameInput.addEventListener('input', function () {
        if (nameInput.value.trim().length >= 3) setFieldError(nameInput, nameErrorEl, '');
      });
    }
    if (emailInput) {
      emailInput.addEventListener('input', function () {
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailInput.value.trim())) {
          setFieldError(emailInput, emailErrorEl, '');
        }
      });
    }

    form.addEventListener('submit', async function (event) {
      if (paymentStep === 'instructing') {
        var finalRadio = document.querySelector('input[name="method"]:checked');
        if (finalRadio) finalRadio.disabled = false;
        var validFinal = validateCheckoutForm();
        if (!validFinal) {
          event.preventDefault();
          if (finalRadio) finalRadio.disabled = true;
        } else if (paySubmitBtn) {
          paySubmitBtn.classList.add('is-loading');
          paySubmitBtn.setAttribute('aria-busy', 'true');
        }
        return;
      }

      event.preventDefault();
      var checked = validateCheckoutForm();
      if (!checked) return;

      var payload = {
        mode: boot.checkout_mode || 'ticket',
        name: nameInput ? nameInput.value.trim() : '',
        email: emailInput ? emailInput.value.trim() : '',
        method: checked.value
      };
      document.querySelectorAll('[data-attendee-field]').forEach(function (input) {
        if (input.name && input.name !== 'name' && input.name !== 'email') payload[input.name] = input.value.trim();
      });
      setPayLoading(true);
      var res = await postJson('/checkout/pending', payload);
      setPayLoading(false);
      if (!res.ok) {
        if (res.status === 401 && window.TitiketAuth) {
          window.TitiketAuth.requireAuth({ nextUrl: '/checkout/' });
          return;
        }
        if (formAlertEl && formAlertTextEl) {
          formAlertTextEl.textContent = (res.data && res.data.error) || 'Gagal memproses transaksi.';
          formAlertEl.hidden = false;
        }
        return;
      }
      enterInstructionStep(checked, res.data.order, true);
    });
  }

  if (copyBtn && instCodeVal) {
    copyBtn.addEventListener('click', function () {
      var text = (instCodeVal.textContent || '').replace(/\s+/g, '');
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {});
      }
      copyBtn.classList.remove('is-copied');
      void copyBtn.offsetWidth;
      copyBtn.classList.add('is-copied');
      if (copyLabel) copyLabel.textContent = 'Tersalin';
      if (copyToast) {
        copyToast.hidden = true;
        void copyToast.offsetWidth;
        copyToast.hidden = false;
        window.clearTimeout(copyBtn._toastTimer);
        copyBtn._toastTimer = window.setTimeout(function () {
          copyToast.hidden = true;
          copyBtn.classList.remove('is-copied');
          if (copyLabel) copyLabel.textContent = 'Salin';
        }, 2500);
      }
    });
  }

  function showCancelStep(stepName) {
    if (cancelStepConfirm) cancelStepConfirm.hidden = stepName !== 'confirm';
    if (cancelStepReasons) cancelStepReasons.hidden = stepName !== 'reasons';
  }

  if (cancelBtn && cancelDialog) {
    cancelBtn.addEventListener('click', function () {
      showCancelStep('confirm');
      if (typeof cancelDialog.showModal === 'function') cancelDialog.showModal();
      else cancelDialog.setAttribute('open', '');
    });
  }

  function closeCancelDialog() {
    if (!cancelDialog) return;
    if (typeof cancelDialog.close === 'function') cancelDialog.close();
    else cancelDialog.removeAttribute('open');
  }

  if (cancelCloseBtn) cancelCloseBtn.addEventListener('click', closeCancelDialog);
  if (cancelConfirmYes) {
    cancelConfirmYes.addEventListener('click', function () {
      showCancelStep('reasons');
    });
  }
  if (cancelBackBtn) {
    cancelBackBtn.addEventListener('click', function () {
      showCancelStep('confirm');
    });
  }

  if (cancelDialog) {
    cancelDialog.addEventListener('click', async function (event) {
      var actionBtn = event.target.closest('[data-cancel-action]');
      if (!actionBtn) return;
      var action = actionBtn.getAttribute('data-cancel-action');
      var reason = actionBtn.getAttribute('data-cancel-reason') || '';
      var res = await postJson('/checkout/cancel', {
        action: action,
        reason: reason,
        order_code: activeOrderCode
      });
      closeCancelDialog();
      if (action === 'change_method') {
        unlockMethodSelection();
        return;
      }
      window.location.href = (res.data && res.data.redirect) || '/';
    });
  }

  window.addEventListener('titiket:sso-changed', applySsoState);
  applySsoState();
  startSeatHoldMonitor();

  if (boot.pending_order && form) {
    var presetRadio = document.querySelector('input[name="method"][value="' + boot.pending_order.method_key + '"]')
      || document.querySelector('input[name="method"]:checked');
    if (presetRadio) {
      presetRadio.checked = true;
      enterInstructionStep(presetRadio, boot.pending_order, false);
    }
  }
})();
