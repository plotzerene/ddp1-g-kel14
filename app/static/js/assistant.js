/* Floating AI Virtual Assistant (TikBuddy): UI saja. Kunci API hanya ada di server (POST /api/assistant/chat). */
(() => {
  const root = document.getElementById("ai-widget");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const panel = $("ai-panel"), fab = $("ai-fab"), body = $("ai-body");
  const form = $("ai-form"), input = $("ai-text"), chips = $("ai-chips");
  const history = [];   // {role: "user"|"model", text}
  let busy = false;

  const setOpen = (open) => {
    panel.hidden = !open;
    fab.setAttribute("aria-expanded", String(open));
    fab.hidden = open && window.matchMedia("(max-width: 480px)").matches;
    if (open) input.focus();
  };
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Escape dulu, baru ubah **tebal** / *miring* / paragraf: markup dari model tidak pernah lolos sebagai HTML.
  const fmt = (t) => esc(t).trim()
    .replace(/^[ \t]*[*-][ \t]+/gm, "• ")
    .replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  const card = (m) => {
    const a = document.createElement("a");
    a.className = "ai-card";
    a.href = m.url;
    const img = document.createElement("img");
    img.src = m.poster; img.alt = ""; img.loading = "lazy";
    const info = document.createElement("span");
    info.className = "ai-card__info";
    const chips = [m.genre, m.rating && `★ ${m.rating}`].filter(Boolean).map((c) => `<i>${esc(c)}</i>`).join("");
    info.innerHTML = `<b>${esc(m.title)}</b><span class="ai-card__chips">${chips}</span><em>Lihat Jadwal &amp; POV 3D →</em>`;
    a.append(img, info);
    return a;
  };
  const add = (text, who, movies = []) => {
    const el = document.createElement("div");
    el.className = `ai-msg ai-msg--${who}`;
    if (who === "bot" && text) el.innerHTML = fmt(text); else el.textContent = text;
    movies.forEach((m) => el.appendChild(card(m)));
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  };

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    add(text, "user");
    history.push({ role: "user", text });
    input.value = "";
    const typing = add("", "bot");
    typing.classList.add("ai-typing");
    typing.innerHTML = "<i></i><i></i><i></i>";
    let reply = "Koneksi lagi bermasalah, coba lagi ya.", movies = [];
    try {
      const res = await fetch(root.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-10) }),
      });
      const data = await res.json();
      reply = data.reply || data.error || reply;
      movies = Array.isArray(data.movies) ? data.movies : [];
    } catch (e) { /* tetap tampilkan pesan ramah */ }
    typing.remove();
    add(reply, "bot", movies);
    history.push({ role: "model", text: reply });
    busy = false;
  }

  fab.addEventListener("click", () => setOpen(true));
  $("ai-close").addEventListener("click", () => { setOpen(false); fab.focus(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) setOpen(false); });
  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  chips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) send(chip.dataset.q);
  });
})();
