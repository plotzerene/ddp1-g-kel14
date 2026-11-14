/**
 * landing.js — FOLDER TEAMMATE 1. Tiga interaksi halaman depan:
 *   1. carousel promo (CSS scroll-snap; JS hanya untuk geser otomatis, panah, dan titik)
 *   2. filter kategori + pencarian katalog
 *   3. modal trailer (<dialog> bawaan browser)
 */
const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- 1. Carousel promo ---------- */
const promo = $('promo');
const track = $('promo-track');
const slides = [...track.children];
const dots = slides.map((_, index) => {
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'promo__dot';
  dot.setAttribute('aria-label', `Promo ${index + 1} dari ${slides.length}`);
  dot.addEventListener('click', () => goTo(index));
  $('promo-dots').append(dot);
  return dot;
});

const slideStep = () => (slides[1] ? slides[1].offsetLeft - slides[0].offsetLeft : track.clientWidth);
const currentIndex = () => Math.round(track.scrollLeft / slideStep());

function goTo(index) {
  track.scrollTo({ left: index * slideStep(), behavior: reducedMotion ? 'auto' : 'smooth' });
}

function move(delta) {
  const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  if (delta > 0 && atEnd) goTo(0);                       // sampai ujung → kembali ke awal
  else if (delta < 0 && track.scrollLeft <= 4) goTo(slides.length - 1);
  else goTo(currentIndex() + delta);
}

function syncDots() {
  const active = currentIndex();
  const last = Math.round((track.scrollWidth - track.clientWidth) / slideStep());   // posisi geser terakhir
  dots.forEach((dot, index) => {
    dot.hidden = index > last;
    dot.setAttribute('aria-current', String(index === active));
  });
}

$('promo-prev').addEventListener('click', () => move(-1));
$('promo-next').addEventListener('click', () => move(1));
track.addEventListener('scroll', syncDots, { passive: true });
window.addEventListener('resize', syncDots);
syncDots();
if (!reducedMotion) {
  // Geser tiap 4 detik; berhenti selama kursor atau fokus keyboard ada di carousel.
  window.setInterval(() => {
    if (!promo.matches(':hover, :focus-within') && !document.hidden) move(1);
  }, 4000);
}

/* ---------- 2. Filter kategori + pencarian ---------- */
const cards = [...document.querySelectorAll('.film-card')];
const pills = [...document.querySelectorAll('.category-pill')];
const search = $('catalog-search');
let activeTag = '';                 // kosong = semua kategori

function applyFilter() {
  const query = search.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cards) {
    const match = (!activeTag || card.dataset.tags.split(' ').includes(activeTag)) && card.dataset.title.includes(query);
    card.hidden = !match;
    visible += match;
  }
  $('catalog-empty').hidden = visible > 0;
}

for (const pill of pills) {
  pill.addEventListener('click', () => {
    activeTag = activeTag === pill.dataset.filter ? '' : pill.dataset.filter;      // klik lagi = tampilkan semua
    pills.forEach((other) => other.setAttribute('aria-pressed', String(other.dataset.filter === activeTag)));
    applyFilter();
  });
}
search.addEventListener('input', applyFilter);
applyFilter();

/* ---------- 3. Modal trailer ---------- */
const dialog = $('trailer-dialog');
const video = $('trailer-video');

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-trailer]');
  if (!button) return;
  $('trailer-title').textContent = button.dataset.title;
  video.src = button.dataset.trailer;
  dialog.showModal();
  video.play().catch(() => {});          // bila autoplay ditolak, pengguna tinggal menekan tombol putar
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();           // klik area gelap di luar video
});
dialog.addEventListener('close', () => {
  video.pause();
  video.removeAttribute('src');
  video.load();
});
