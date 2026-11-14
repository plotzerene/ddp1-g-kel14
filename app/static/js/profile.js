// profile.js: manajemen tab status pesanan, hitung mundur pembayaran, pembatalan, dan modal e-tiket.
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-profile-tab]'));
  var eticketModal = document.getElementById('profile-eticket-modal');
  var eticketBody = document.getElementById('profile-eticket-body');
  var eticketClose = document.getElementById('profile-eticket-close');

  function activateTab(tabName) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-profile-tab') === tabName;
      tab.setAttribute('aria-selected', String(active));
    });
    ['pending', 'completed', 'cancelled'].forEach(function (name) {
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
    }
  });

  if (eticketClose && eticketModal) {
    eticketClose.addEventListener('click', function () {
      if (typeof eticketModal.close === 'function') eticketModal.close();
      else eticketModal.removeAttribute('open');
    });
  }
})();
