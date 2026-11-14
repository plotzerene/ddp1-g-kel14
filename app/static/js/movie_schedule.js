(function () {
  var main = document.getElementById('main-content');
  var root = document.getElementById('jadwal-lokasi');
  var tabButtons = document.querySelectorAll('#movie-detail-tabs .detail__navtab');
  var sinopsisSec = document.getElementById('detail-sinopsis');
  var termsSec = document.getElementById('syarat-bioskop');

  function activateTab(target) {
    tabButtons.forEach(function (btn) {
      var active = btn.dataset.tabTarget === target;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (!sinopsisSec || !root || !termsSec) return;
    if (target === 'terms') {
      sinopsisSec.hidden = true;
      root.hidden = true;
      termsSec.hidden = false;
    } else if (target === 'schedule') {
      sinopsisSec.hidden = true;
      root.hidden = false;
      termsSec.hidden = true;
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      sinopsisSec.hidden = false;
      root.hidden = false;
      termsSec.hidden = true;
    }
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activateTab(btn.dataset.tabTarget || 'overview');
    });
  });

  if (!root) return;

  var dateButtons = root.querySelectorAll('.date-chip');
  var citySelect = document.getElementById('filter-city');
  var formatSelect = document.getElementById('filter-format');
  var cinemaCards = root.querySelectorAll('.cinema-card');
  var timeButtons = root.querySelectorAll('.time-pill');
  var summaryCinema = document.getElementById('summary-cinema');
  var summaryMeta = document.getElementById('summary-meta');
  var seatCta = document.getElementById('schedule-seat-cta');

  var activeDate = dateButtons[0] ? dateButtons[0].dataset.dateId : '';
  var activeDateLabel = dateButtons[0] ? dateButtons[0].dataset.dateLabel : '';
  var activeSlot = root.querySelector('.time-pill.is-active') || timeButtons[0];

  function updateSummary() {
    if (!activeSlot || !seatCta) return;
    var cinemaName = activeSlot.dataset.cinemaName || '';
    var studioType = activeSlot.dataset.studioType || '';
    var studioRoom = activeSlot.dataset.studioRoom || '';
    var priceText = activeSlot.dataset.priceText || '';
    var timeVal = activeSlot.dataset.time || '';
    var baseHref = activeSlot.dataset.href || '';
    var studioDisplay = studioRoom ? studioType + ' (' + studioRoom + ')' : studioType;

    if (summaryCinema) summaryCinema.textContent = cinemaName;
    if (summaryMeta) {
      var timeDisplay = timeVal ? timeVal + ' WIB' : '';
      summaryMeta.textContent = ' • ' + [activeDateLabel, studioDisplay, timeDisplay, priceText].filter(Boolean).join(' • ');
    }
    cinemaCards.forEach(function (card) {
      card.classList.toggle('is-selected', card.contains(activeSlot));
    });
    if (baseHref) {
      var url = new URL(baseHref, window.location.origin);
      if (cinemaName) url.searchParams.set('cinema', cinemaName);
      if (activeDate) url.searchParams.set('date', activeDate);
      if (timeVal) url.searchParams.set('time', timeVal);
      seatCta.href = url.pathname + url.search;
    }
  }

  function applyFilters() {
    var chosenCity = citySelect ? citySelect.value : 'all';
    var chosenFmt = formatSelect ? formatSelect.value : 'all';
    cinemaCards.forEach(function (card) {
      var cityOk = chosenCity === 'all' || card.dataset.city === chosenCity;
      var studioRows = card.querySelectorAll('.studio-row');
      var visibleStudios = 0;
      studioRows.forEach(function (row) {
        var fmtOk = chosenFmt === 'all' || row.dataset.format === chosenFmt;
        row.hidden = !fmtOk;
        if (fmtOk) visibleStudios += 1;
      });
      card.hidden = !(cityOk && visibleStudios > 0);
    });
  }

  dateButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      dateButtons.forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      activeDate = btn.dataset.dateId || '';
      activeDateLabel = btn.dataset.dateLabel || '';
      updateSummary();
    });
  });

  if (citySelect) citySelect.addEventListener('change', applyFilters);
  if (formatSelect) formatSelect.addEventListener('change', applyFilters);

  timeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      timeButtons.forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      activeSlot = btn;
      updateSummary();
    });
  });

  if (main && main.dataset.initialTab) {
    activateTab(main.dataset.initialTab);
  }
  updateSummary();
})();
