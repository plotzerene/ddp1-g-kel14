/* Interaksi Landing Page titiket.com sesuai Artboard FigCraft 01_Home. */

(() => {
  const REMIND_STORAGE_KEY = "titiket-reminders";

  /* 1. Helper Toast Ringan */
  const toastRegion = document.getElementById("toast-region");
  function showToast(message) {
    if (!toastRegion) return;
    const item = document.createElement("div");
    item.className = "toast toast--info";
    item.textContent = message;
    toastRegion.appendChild(item);
    window.setTimeout(() => {
      item.remove();
    }, 2800);
  }

  /* 3. Featured Mini Carousel */
  const carousel = document.getElementById("promo");
  const track = document.getElementById("promo-track");
  const prevBtn = document.getElementById("promo-prev");
  const nextBtn = document.getElementById("promo-next");
  const dotsWrap = document.getElementById("promo-dots");

  if (track) {
    const slides = Array.from(track.querySelectorAll(".featured-slide"));
    const dotButtons = [];
    let activeSlide = 0;

    function getStepSize() {
      if (!slides.length) return 380;
      const firstWidth = slides[0].getBoundingClientRect().width || 360;
      const style = window.getComputedStyle(track);
      const gap = parseFloat(style.columnGap || style.gap || "16") || 16;
      return firstWidth + gap;
    }

    function setActiveDot(index) {
      activeSlide = Math.max(0, Math.min(index, slides.length - 1));
      dotButtons.forEach((dot, idx) => {
        const isCurrent = idx === activeSlide;
        dot.classList.toggle("is-active", isCurrent);
        dot.setAttribute("aria-current", isCurrent ? "true" : "false");
      });
    }

    function scrollToSlide(index) {
      if (!slides.length) return;
      const targetIndex = ((index % slides.length) + slides.length) % slides.length;
      const step = getStepSize();
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      const targetLeft = Math.min(maxScroll, Math.round(targetIndex * step));
      track.scrollTo({ left: targetLeft, behavior: "smooth" });
      setActiveDot(targetIndex);
    }

    if (dotsWrap && slides.length > 1) {
      slides.forEach((_, idx) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = idx === 0 ? "promo__dot is-active" : "promo__dot";
        dot.setAttribute("aria-current", idx === 0 ? "true" : "false");
        dot.setAttribute("aria-label", `Sorotan ${idx + 1}`);
        dot.addEventListener("click", () => scrollToSlide(idx));
        dotsWrap.appendChild(dot);
        dotButtons.push(dot);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (track.scrollLeft <= 8) {
          track.scrollTo({ left: Math.max(0, track.scrollWidth - track.clientWidth), behavior: "smooth" });
          setActiveDot(slides.length - 1);
          return;
        }
        scrollToSlide(Math.max(0, activeSlide - 1));
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
        if (atEnd) {
          track.scrollTo({ left: 0, behavior: "smooth" });
          setActiveDot(0);
          return;
        }
        scrollToSlide(activeSlide + 1);
      });
    }

    let scrollTick = null;
    track.addEventListener("scroll", () => {
      if (scrollTick) window.cancelAnimationFrame(scrollTick);
      scrollTick = window.requestAnimationFrame(() => {
        const step = getStepSize();
        const approxIndex = Math.round(track.scrollLeft / Math.max(1, step));
        setActiveDot(approxIndex);
      });
    }, { passive: true });

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion && slides.length > 1) {
      let paused = false;
      const pause = () => { paused = true; };
      const resume = () => { paused = false; };
      if (carousel) {
        carousel.addEventListener("mouseenter", pause);
        carousel.addEventListener("mouseleave", resume);
        carousel.addEventListener("focusin", pause);
        carousel.addEventListener("focusout", resume);
      }
      window.setInterval(() => {
        if (paused || document.hidden) return;
        const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
        if (atEnd) {
          track.scrollTo({ left: 0, behavior: "smooth" });
          setActiveDot(0);
        } else {
          scrollToSlide(activeSlide + 1);
        }
      }, 6500);
    }
  }

  /* 4. Filter, Search & Expand ("Lagi tayang" + "Coming Soon") */
  const searchInput = document.getElementById("catalog-search");
  const nowPlayingChips = Array.from(document.querySelectorAll('[data-filter-group="now-playing"] .filter-chip'));
  const comingSoonChips = Array.from(document.querySelectorAll('[data-filter-group="coming-soon"] .filter-chip'));
  const expandBtn = document.getElementById("now-playing-expand");
  const nowPlayingGrid = document.getElementById("now-playing-grid");
  const comingSoonGrid = document.getElementById("coming-soon-grid");
  const nowPlayingCards = Array.from(document.querySelectorAll('.poster-card[data-grid="now-playing"]'));
  const comingSoonCards = Array.from(document.querySelectorAll('.poster-card[data-grid="coming-soon"]'));
  const emptyState = document.getElementById("catalog-empty");

  const state = {
    nowPlayingFilter: "all",
    comingSoonFilter: "all",
    expandedNowPlaying: false,
    searchQuery: searchInput ? searchInput.value : "",
  };

  function syncChipGroup(chips, activeValue) {
    chips.forEach((chip) => {
      const isMatch = chip.dataset.filter === activeValue;
      chip.setAttribute("aria-pressed", String(isMatch));
    });
  }

  function matchesQuickFilter(card, filterKey) {
    if (!filterKey || filterKey === "all") return true;
    if (filterKey === "film" || filterKey === "nearby") return card.dataset.kind === "film";
    if (filterKey === "concert") return card.dataset.kind === "concert";
    if (filterKey === "imax") return (card.dataset.formats || "").includes("xxi-imax");
    if (filterKey === "today") return (card.dataset.days || "").includes("today");
    if (filterKey === "tomorrow") return (card.dataset.days || "").includes("tomorrow");
    return card.dataset.kind === filterKey;
  }

  function applyCatalogState() {
    const query = state.searchQuery.trim().toLowerCase();
    const revealExtra = state.expandedNowPlaying || Boolean(query) || state.nowPlayingFilter !== "all";
    let visibleNowCount = 0;

    nowPlayingCards.forEach((card) => {
      const isExtra = card.dataset.extra === "true";
      card.classList.toggle("is-revealed", isExtra && revealExtra);

      const matchesFilter = matchesQuickFilter(card, state.nowPlayingFilter);
      const haystack = (card.dataset.search || "").toLowerCase();
      const matchesSearch = !query || haystack.includes(query);
      const visible = matchesFilter && matchesSearch && (!isExtra || revealExtra);

      card.hidden = !matchesFilter || !matchesSearch;
      if (visible) visibleNowCount += 1;
    });

    let visibleSoonCount = 0;
    comingSoonCards.forEach((card) => {
      const matchesFilter = matchesQuickFilter(card, state.comingSoonFilter);
      const haystack = (card.dataset.search || "").toLowerCase();
      const matchesSearch = !query || haystack.includes(query);
      const isVisible = matchesFilter && matchesSearch;
      card.hidden = !isVisible;
      if (isVisible) visibleSoonCount += 1;
    });

    if (nowPlayingGrid) {
      nowPlayingGrid.dataset.visibleCount = String(visibleNowCount);
    }
    if (comingSoonGrid) {
      comingSoonGrid.dataset.visibleCount = String(visibleSoonCount);
    }

    if (emptyState) {
      emptyState.hidden = visibleNowCount > 0;
    }

    if (expandBtn) {
      expandBtn.setAttribute("aria-expanded", String(state.expandedNowPlaying));
      const labelSpan = expandBtn.querySelector("span");
      if (labelSpan) {
        labelSpan.textContent = state.expandedNowPlaying ? "Ringkas" : "Lihat semua \u203A";
      }
    }
  }

  nowPlayingChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.nowPlayingFilter = chip.dataset.filter || "all";
      syncChipGroup(nowPlayingChips, state.nowPlayingFilter);
      applyCatalogState();
    });
  });

  comingSoonChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.comingSoonFilter = chip.dataset.filter || "all";
      syncChipGroup(comingSoonChips, state.comingSoonFilter);
      applyCatalogState();
    });
  });

  if (expandBtn) {
    expandBtn.addEventListener("click", () => {
      state.expandedNowPlaying = !state.expandedNowPlaying;
      applyCatalogState();
    });
  }

  if (searchInput) {
    const onSearch = () => {
      state.searchQuery = searchInput.value || "";
      applyCatalogState();
    };
    searchInput.addEventListener("input", onSearch);
    searchInput.addEventListener("search", onSearch);
    if (state.searchQuery.trim()) {
      applyCatalogState();
    }

    /* Placeholder berganti tiap 3 detik dengan efek pudar (CSS di landing.css).
       Label aksesibel tetap aria-label statis; placeholder hanya contoh pencarian.
       Berhenti saat kolom fokus/terisi atau tab tidak terlihat. */
    const SEARCH_HINTS = [
      "Cari film Spider-Man: No Way Home...",
      "Cari film The Hunger Games...",
      "Cari film Chiikawa Movie...",
      "Cari film Zootopia 2...",
      "Cari film How to Lose a Guy in 10 Days...",
      "Cari film The Nun...",
      "Cari film SORE: Istri dari Masa Depan...",
      "Cari konser Coldplay di GBK...",
      "Cari bioskop Studio IMAX...",
      "Cari film Jatuh Cinta Seperti di Film Film...",
    ];
    const HINT_FADE_MS = 220;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let hintIndex = 0;
    searchInput.placeholder = SEARCH_HINTS[hintIndex];

    window.setInterval(() => {
      if (document.hidden || document.activeElement === searchInput || searchInput.value) return;
      hintIndex = (hintIndex + 1) % SEARCH_HINTS.length;
      if (reduceMotion.matches) {
        searchInput.placeholder = SEARCH_HINTS[hintIndex];
        return;
      }
      searchInput.classList.add("is-hint-out");
      window.setTimeout(() => {
        searchInput.placeholder = SEARCH_HINTS[hintIndex];
        searchInput.classList.remove("is-hint-out");
      }, HINT_FADE_MS);
    }, 3000);
  }

  /* 5. 5 Category Quick Actions + Modal Info ("titiket.food" & "Sewa Tempat") */
  const quickCats = Array.from(document.querySelectorAll(".quick-cat[data-category]"));
  const quickInfoModal = document.getElementById("quick-info-modal");
  const quickInfoTitle = document.getElementById("quick-info-title");
  const quickInfoClose = document.getElementById("quick-info-close");
  const quickInfoFood = document.getElementById("quick-info-food");
  const quickInfoSewa = document.getElementById("quick-info-sewa");
  const nowPlayingSection = document.getElementById("lagi-tayang");

  function openQuickInfo(mode) {
    if (!quickInfoModal || !quickInfoFood || !quickInfoSewa || !quickInfoTitle) return;
    if (mode === "food") {
      quickInfoTitle.textContent = "titiket.food \u2022 Pre-Order Bioskop";
      quickInfoFood.hidden = false;
      quickInfoSewa.hidden = true;
    } else {
      quickInfoTitle.textContent = "Sewa Tempat & Studio Bioskop";
      quickInfoFood.hidden = true;
      quickInfoSewa.hidden = false;
    }
    if (typeof quickInfoModal.showModal === "function") {
      quickInfoModal.showModal();
    }
  }

  quickCats.forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.category || "";
      quickCats.forEach((item) => item.setAttribute("aria-pressed", String(item === btn)));

      if (cat === "bioskop" || cat === "film") {
        state.nowPlayingFilter = "film";
        syncChipGroup(nowPlayingChips, "film");
        applyCatalogState();
        if (nowPlayingSection) {
          nowPlayingSection.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      if (cat === "konser" || cat === "konser-musik") {
        state.nowPlayingFilter = "concert";
        syncChipGroup(nowPlayingChips, "concert");
        applyCatalogState();
        if (nowPlayingSection) {
          nowPlayingSection.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      if (cat === "food" || cat === "sewa") {
        openQuickInfo(cat);
      }
    });
  });

  if (quickInfoClose && quickInfoModal) {
    quickInfoClose.addEventListener("click", () => quickInfoModal.close());
    quickInfoModal.addEventListener("click", (event) => {
      if (event.target === quickInfoModal) quickInfoModal.close();
    });
  }

  /* 6. "Ingatkan Saya" Toggle Persistence (Coming Soon) */
  const remindButtons = Array.from(document.querySelectorAll(".remind-btn[data-remind-id]"));
  let savedReminders = new Set();

  try {
    const raw = JSON.parse(localStorage.getItem(REMIND_STORAGE_KEY) || "[]");
    if (Array.isArray(raw)) {
      savedReminders = new Set(raw);
    }
  } catch {
    savedReminders = new Set();
  }

  function renderRemindButton(btn) {
    const id = btn.dataset.remindId || "";
    const active = savedReminders.has(id);
    btn.setAttribute("aria-pressed", String(active));
    const label = btn.querySelector("span");
    if (label) {
      label.textContent = active ? "Pengingat Aktif \u2713" : "Ingatkan Saya";
    }
  }

  remindButtons.forEach((btn) => {
    renderRemindButton(btn);
    btn.addEventListener("click", () => {
      const id = btn.dataset.remindId || "";
      const title = btn.dataset.remindTitle || "judul ini";
      if (!id) return;

      if (savedReminders.has(id)) {
        savedReminders.delete(id);
        showToast(`Pengingat untuk ${title} dimatikan.`);
      } else {
        savedReminders.add(id);
        showToast(`Kami akan mengingatkan saat tiket ${title} tersedia.`);
      }

      try {
        localStorage.setItem(REMIND_STORAGE_KEY, JSON.stringify(Array.from(savedReminders)));
      } catch {
        /* Abaikan */
      }
      renderRemindButton(btn);
    });
  });

  /* 7. Modal Trailer Native & YouTube Resmi */
  const trailerDialog = document.getElementById("trailer-dialog");
  const trailerTitle = document.getElementById("trailer-title");
  const trailerVideo = document.getElementById("trailer-video");
  const trailerEmbedFrame = document.getElementById("trailer-embed-frame");
  const trailerClose = document.getElementById("landing-trailer-close");

  if (trailerDialog && (trailerVideo || trailerEmbedFrame)) {
    function stopLandingTrailer() {
      if (trailerVideo) {
        trailerVideo.pause();
        try {
          trailerVideo.currentTime = 0;
        } catch {
          /* Abaikan jika metadata belum termuat */
        }
        trailerVideo.removeAttribute("src");
        trailerVideo.load();
        trailerVideo.hidden = true;
      }
      if (trailerEmbedFrame) {
        trailerEmbedFrame.src = "";
        trailerEmbedFrame.hidden = true;
      }
    }

    function closeLandingTrailer() {
      stopLandingTrailer();
      if (typeof trailerDialog.close === "function" && trailerDialog.open) {
        trailerDialog.close();
      } else {
        trailerDialog.removeAttribute("open");
      }
    }

    document.querySelectorAll("[data-trailer], [data-trailer-embed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const src = btn.dataset.trailer || "";
        const embed = btn.dataset.trailerEmbed || "";
        const title = btn.dataset.title || "Film";
        if (!src && !embed) return;
        stopLandingTrailer();
        if (trailerTitle) trailerTitle.textContent = `Trailer: ${title}`;
        if (src && trailerVideo) {
          trailerVideo.hidden = false;
          trailerVideo.src = src;
        } else if (embed && trailerEmbedFrame) {
          const sep = embed.includes("?") ? "&" : "?";
          trailerEmbedFrame.hidden = false;
          trailerEmbedFrame.src = `${embed}${sep}autoplay=1&rel=0`;
        }
        if (typeof trailerDialog.showModal === "function") {
          trailerDialog.showModal();
        } else {
          trailerDialog.setAttribute("open", "open");
        }
        if (src && trailerVideo) {
          trailerVideo.play().catch(() => {});
        }
      });
    });

    if (trailerClose) {
      trailerClose.addEventListener("click", (event) => {
        event.preventDefault();
        closeLandingTrailer();
      });
    }

    trailerDialog.addEventListener("click", (event) => {
      if (event.target === trailerDialog) closeLandingTrailer();
    });

    trailerDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeLandingTrailer();
    });

    trailerDialog.addEventListener("close", stopLandingTrailer);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && (trailerDialog.open || trailerDialog.hasAttribute("open"))) {
        event.preventDefault();
        closeLandingTrailer();
      }
    });
  }

  applyCatalogState();
})();
