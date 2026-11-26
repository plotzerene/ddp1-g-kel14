// profile.js: manajemen tab status pesanan, buku alamat pengiriman, hitung mundur, dan modal e-tiket.
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-profile-tab]'));
  var eticketModal = document.getElementById('profile-eticket-modal');
  var eticketBody = document.getElementById('profile-eticket-body');
  var eticketClose = document.getElementById('profile-eticket-close');
  var qrisModal = document.getElementById('profile-qris-modal');
  var qrisClose = document.getElementById('profile-qris-close');
  var addressModal = document.getElementById('address-sheet-modal');
  var addressForm = document.getElementById('new-address-form');

  function activateTab(tabName) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-profile-tab') === tabName;
      tab.setAttribute('aria-selected', String(active));
    });
    ['pending', 'completed', 'cancelled', 'addresses', 'account'].forEach(function (name) {
      var panel = document.getElementById('panel-' + name);
      if (panel) panel.hidden = name !== tabName;
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activateTab(tab.getAttribute('data-profile-tab'));
    });
  });

  var countdownNodes = Array.prototype.slice.call(document.querySelectorAll('[data-countdown-sec]'));
  if (countdownNodes.length > 0) {
    window.setInterval(function () {
      countdownNodes.forEach(function (el) {
        var sec = Math.max(0, Number(el.getAttribute('data-countdown-sec') || 0) - 1);
        el.setAttribute('data-countdown-sec', String(sec));
        var mm = String(Math.floor(sec / 60)).padStart(2, '0');
        var ss = String(sec % 60).padStart(2, '0');
        el.textContent = mm + ':' + ss;
      });
    }, 1000);
  }

  document.addEventListener('click', async function (event) {
    var qrisBtn = event.target.closest('[data-open-qris]');
    if (qrisBtn && qrisModal) {
      document.getElementById('profile-qris-code').textContent = qrisBtn.getAttribute('data-open-qris');
      document.getElementById('profile-qris-total').textContent = qrisBtn.getAttribute('data-qris-total') || '';
      if (typeof qrisModal.showModal === 'function') qrisModal.showModal();
      else qrisModal.setAttribute('open', '');
      return;
    }
    var openBtn = event.target.closest('[data-open-eticket]');
    if (openBtn && eticketModal && eticketBody) {
      var code = openBtn.getAttribute('data-open-eticket');
      var tpl = document.getElementById('eticket-tpl-' + code);
      if (tpl) {
        eticketBody.innerHTML = '';
        eticketBody.appendChild(tpl.content.cloneNode(true));
        if (typeof eticketModal.showModal === 'function') eticketModal.showModal();
        else eticketModal.setAttribute('open', '');
      }
      return;
    }

    var cancelBtn = event.target.closest('[data-profile-cancel]');
    if (cancelBtn) {
      var orderCode = cancelBtn.getAttribute('data-profile-cancel');
      await fetch('/checkout/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          action: 'cancel_order',
          reason: 'Dibatalkan melalui halaman Pesanan Saya',
          order_code: orderCode
        })
      });
      window.location.href = '/profile?tab=cancelled';
      return;
    }

    if (event.target.closest('#open-address-sheet-btn') && addressModal) {
      addressModal.hidden = false;
      return;
    }
    if (event.target.closest('[data-address-close]') && addressModal) {
      addressModal.hidden = true;
      return;
    }

    var defBtn = event.target.closest('[data-set-default-addr]');
    if (defBtn) {
      await fetch('/checkout/api/addresses/default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ address_id: defBtn.getAttribute('data-set-default-addr') })
      });
      window.location.href = '/profile?tab=addresses';
    }
  });

  if (addressForm) {
    addressForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var fd = new FormData(addressForm);
      var res = await fetch('/checkout/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          tag: fd.get('tag'),
          label: fd.get('label'),
          recipient: fd.get('recipient'),
          phone: fd.get('phone'),
          street: fd.get('street'),
          city: fd.get('city'),
          make_default: Boolean(fd.get('make_default'))
        })
      });
      if (res.ok) window.location.href = '/profile?tab=addresses';
    });
  }

  if (qrisClose && qrisModal) {
    qrisClose.addEventListener('click', function () {
      if (typeof qrisModal.close === 'function') qrisModal.close();
      else qrisModal.removeAttribute('open');
    });
  }
  if (eticketClose && eticketModal) {
    eticketClose.addEventListener('click', function () {
      if (typeof eticketModal.close === 'function') eticketModal.close();
      else eticketModal.removeAttribute('open');
    });
  }
})();
