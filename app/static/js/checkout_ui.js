// checkout_ui.js: logika checkout, penguncian kanal bayar, Modal C, Modal D, dan Error X dinamis.
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

  var instPanel = document.getElementById('payment-instruction-panel');
  var instLogo = document.getElementById('inst-channel-logo');
  var instName = document.getElementById('inst-channel-name');
  var instKindBadge = document.getElementById('inst-kind-badge');
  var instCodeBox = document.getElementById('inst-code-box');
  var instCodeVal = document.getElementById('inst-code-value');
  var instQrisBox = document.getElementById('inst-qris-box');
  var instGuide = document.getElementById('inst-guide-text');
  var copyBtn = document.getElementById('copy-code-btn');
  var copyLabel = document.getElementById('copy-code-label');
  var copyToast = document.getElementById('copy-toast');
  var errorBanner = document.getElementById('payment-error-banner');
  var errorTitleEl = document.getElementById('payment-error-title');
  var errorDescEl = document.getElementById('payment-error-desc');

  var payTimerPill = document.getElementById('pay-timer-pill');
  var countdownEl = document.getElementById('payment-countdown');
  var instCountdownEl = document.getElementById('inst-countdown');
  var paySubmitBtn = document.getElementById('pay-submit-btn');
  var paySubmitLabel = document.getElementById('pay-submit-label');

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
    if (!ssoBox || !grandTotalEl) return;
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

    ssoBox.classList.toggle('is-verified', verified);
    if (ssoStatus) {
      ssoStatus.textContent = verified
        ? 'Aktif \u00b7 Potongan mahasiswa UI 15% otomatis diterapkan.'
        : 'Masuk dengan akun SSO UI untuk menikmati potongan 15% harga dasar tiket.';
    }
    if (ssoActionBtn) ssoActionBtn.hidden = verified;
    if (discountRow) discountRow.hidden = !verified;
    if (discountAmountEl) discountAmountEl.textContent = '- ' + formatRupiah(discount);
    grandTotalEl.textContent = formatRupiah(currentFinalTotal);
    if (payBtnAmountEl) payBtnAmountEl.textContent = formatRupiah(currentFinalTotal);
  }

  function setPaymentRadiosLocked(locked, selectedValue) {
    if (!form) return;
    var radios = form.querySelectorAll('input[name="method"]');
    radios.forEach(function (radio) {
      radio.disabled = locked;
      var card = radio.closest('.pay-channel');
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
    var kind = input.dataset.kind || 'va';
    var label = input.dataset.label || input.value.toUpperCase();
    var logo = input.dataset.logo || '';
    var code = (order && order.payment_code) || input.dataset.code || '88010 0812 9940 112';

    if (instName) instName.textContent = label;
    if (instLogo) {
      if (logo) {
        instLogo.src = logo;
        instLogo.alt = label;
        instLogo.hidden = false;
      } else {
        instLogo.hidden = true;
      }
    }

    var kindLabels = {
      qris: 'QRIS Instan',
      va: 'Virtual Account',
      ewallet: 'Dompet Digital',
      retail: 'Kode Gerai Ritel',
      card: 'Kartu Bank'
    };
    if (instKindBadge) instKindBadge.textContent = kindLabels[kind] || 'Kanal Resmi';

    var isQris = kind === 'qris';
    if (instQrisBox) instQrisBox.hidden = !isQris;
    if (instCodeBox) instCodeBox.hidden = isQris;
    if (instCodeVal) instCodeVal.textContent = code;

    if (instGuide) {
      if (kind === 'qris') {
        instGuide.textContent = 'Pindai kode QR di aplikasi bank atau dompet digital Anda, lalu tekan konfirmasi.';
      } else if (kind === 'retail') {
        instGuide.textContent = 'Tunjukkan kode pembayaran di kasir gerai sebelum batas waktu 15 menit berakhir.';
      } else if (kind === 'ewallet') {
        instGuide.textContent = 'Pastikan nomor ponsel terdaftar pada dompet digital terkait aktif untuk otorisasi.';
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
  }

  function startPaymentCountdown(initialSeconds) {
    stopPaymentCountdown();
    if (payTimerPill) payTimerPill.hidden = false;
    var remaining = initialSeconds > 0 ? Math.floor(initialSeconds) : 900;
    function tick() {
      var formatted = formatClock(remaining);
      if (countdownEl) countdownEl.textContent = formatted;
      if (instCountdownEl) instCountdownEl.textContent = formatted;
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
    if (!holdSeconds || holdSeconds <= 0) return;
    if (seatHoldTimerHandle) window.clearInterval(seatHoldTimerHandle);
    seatHoldTimerHandle = window.setInterval(function () {
      if (holdSeconds > 0) {
        holdSeconds -= 1;
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

    var checked = form ? form.querySelector('input[name="method"]:checked') : null;
    if (!checked) {
      setFieldError(null, methodErrorEl, 'Pilih salah satu metode pembayaran terlebih dahulu.');
      count += 1;
      firstBad = firstBad || (form ? form.querySelector('input[name="method"]') : null);
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

  function unlockMethodSelection() {
    paymentStep = 'review';
    setPaymentRadiosLocked(false, '');
    if (instPanel) instPanel.hidden = true;
    stopPaymentCountdown();
    if (paySubmitLabel) {
      paySubmitLabel.innerHTML = 'Bayar <span id="pay-btn-amount">' + formatRupiah(currentFinalTotal) + '</span>';
      payBtnAmountEl = document.getElementById('pay-btn-amount');
    }
  }

  if (form) {
    var radios = form.querySelectorAll('input[name="method"]');
    radios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        setFieldError(null, methodErrorEl, '');
      });
    });

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
        var finalRadio = form.querySelector('input[name="method"]:checked');
        if (finalRadio) finalRadio.disabled = false;
        var validFinal = validateCheckoutForm();
        if (!validFinal) {
          event.preventDefault();
          if (finalRadio) finalRadio.disabled = true;
        }
        return;
      }

      event.preventDefault();
      var checked = validateCheckoutForm();
      if (!checked) return;

      var res = await postJson('/checkout/pending', {
        name: nameInput ? nameInput.value.trim() : '',
        email: emailInput ? emailInput.value.trim() : '',
        method: checked.value
      });
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
      if (copyLabel) copyLabel.textContent = '\u2713 Tersalin';
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
    var presetRadio = form.querySelector('input[name="method"][value="' + boot.pending_order.method_key + '"]')
      || form.querySelector('input[name="method"]:checked');
    if (presetRadio) {
      presetRadio.checked = true;
      enterInstructionStep(presetRadio, boot.pending_order, false);
    }
  }
})();
