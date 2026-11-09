import * as pdfjsLib from "./vendor/pdf.min.mjs";

// served from this origin on purpose: a CDN import that fails takes the whole module
// with it, and the CDNs are unreliable from the networks a lot of our readers are on
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

const CFG = Object.assign(
  {
    endpoint: "",
    documentUrl: "guide.pdf",
    documentVersion: "",
    openPromptDelayMs: 900,
    popupSnoozeDays: 7,
  },
  window.BIBL_CONFIG || {},
);
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const ENDPOINT = IS_LOCAL ? "/api/submit" : (CFG.endpoint || "");
const MAX_PAGE_WIDTH = 880;
const EDITOR_EMAIL = CFG.editorEmail || "editor@breakingintobiglaw.com";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage blocked: the page still works */
    }
  },
};

const KEY = {
  name: "bibl.name",
  client: "bibl.client",
  hint: "bibl.hintSeen",
  subscribe: "bibl.subscribe",
  notes: "bibl.notes." + (CFG.documentVersion || "default"),
};

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function clientId() {
  let id = store.get(KEY.client, null);
  if (!id) {
    id = newId();
    store.set(KEY.client, id);
  }
  return id;
}

let notes = store.get(KEY.notes, []);
const saveNotes = () => store.set(KEY.notes, notes);

function readerName() {
  return (store.get(KEY.name, "") || "").trim();
}
function setReaderName(value) {
  const name = (value || "").trim().slice(0, 80);
  store.set(KEY.name, name);
  $("panel-name").value = name;
}

// ---------------------------------------------------------------- backend

async function send(payload) {
  if (!ENDPOINT) throw new Error("not-configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // No custom headers: the body goes as text/plain, which Apps Script
    // accepts without a CORS preflight.
    const res = await fetch(ENDPOINT, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON reply */
    }
    if (!res.ok || !data || data.ok !== true) {
      throw new Error((data && data.error) || "HTTP " + res.status);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function sendErrorText(err) {
  if (err && err.message === "not-configured") {
    return "Comments aren't switched on yet. Please try again later.";
  }
  return "That didn't go through. Check your connection and try again.";
}

// ---------------------------------------------------------------- viewer

const pagesEl = $("pages");
const statusEl = $("status");
const views = []; // one per PDF page
const near = new Set(); // views close enough to the viewport to render
let firstPaint = false;

// Device pixels per CSS pixel. Tracked per render so browser zoom (which
// changes it without changing the page's CSS width) triggers a sharp re-render.
function outputScale() {
  return Math.min(window.devicePixelRatio || 1, 3);
}

// Whole CSS pixels, and an even gap either side, so the centred page starts on
// a device pixel and the canvas is shown 1:1 instead of being resampled.
function pageWidth() {
  let width = Math.floor(Math.min(pagesEl.clientWidth, MAX_PAGE_WIDTH));
  if ((pagesEl.clientWidth - width) % 2) width -= 1;
  return width;
}

function layout() {
  const width = pageWidth();
  const dpr = outputScale();
  for (const v of views) {
    const scale = width / v.base.w;
    if (v.scale === scale && v.dpr === dpr) continue;
    v.scale = scale;
    v.dpr = dpr;
    v.cssW = width;
    v.cssH = Math.round(v.base.h * scale);
    v.div.style.width = v.cssW + "px";
    v.div.style.height = v.cssH + "px";
    v.div.style.setProperty("--scale-factor", scale);
    if (v.task) v.task.cancel();
    if (near.has(v)) renderPage(v);
  }
}

function watchPixelRatio() {
  const query = window.matchMedia("(resolution: " + window.devicePixelRatio + "dppx)");
  query.addEventListener(
    "change",
    () => {
      layout();
      watchPixelRatio();
    },
    { once: true },
  );
}

function buildPage(v) {
  const div = document.createElement("div");
  div.className = "page";
  div.dataset.page = String(v.num);
  div.setAttribute("aria-label", "Page " + v.num);

  const hl = document.createElement("div");
  hl.className = "hl-layer";

  const text = document.createElement("div");
  text.className = "textLayer";

  div.append(hl, text);
  Object.assign(v, { div, hl, text });
  pagesEl.append(div);
}

async function renderPage(v) {
  if (v.busy) {
    v.again = true;
    return;
  }
  if (v.renderedKey === renderKey(v)) return;
  v.busy = true;
  try {
    await paint(v);
  } catch (err) {
    if (!err || err.name !== "RenderingCancelledException") console.error(err);
  } finally {
    v.busy = false;
    if (v.again) {
      v.again = false;
      if (near.has(v)) renderPage(v);
    }
  }
}

function renderKey(v) {
  return v.scale + "@" + v.dpr;
}

async function paint(v) {
  const key = renderKey(v);
  const scale = v.scale;
  const viewport = v.page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  // Exactly the page box in device pixels; the transform maps the PDF onto it.
  canvas.width = Math.round(v.cssW * v.dpr);
  canvas.height = Math.round(v.cssH * v.dpr);

  v.task = v.page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
  });
  try {
    await v.task.promise;
  } finally {
    v.task = null;
  }
  if (renderKey(v) !== key || !near.has(v)) {
    canvas.width = 0;
    v.again = near.has(v);
    return;
  }

  if (v.canvas) {
    v.canvas.width = 0;
    v.canvas.remove();
  }
  v.canvas = canvas;
  v.div.prepend(canvas);

  if (v.textScale !== scale) {
    v.text.replaceChildren();
    const textContent = await v.page.getTextContent();
    const layer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: v.text,
      viewport,
    });
    await layer.render();
    const end = document.createElement("div");
    end.className = "endOfContent";
    v.text.append(end);
    v.textScale = scale;
  }
  v.renderedKey = key;

  if (!firstPaint) {
    firstPaint = true;
    statusEl.hidden = true;
  }
}

function release(v) {
  if (v.task) v.task.cancel();
  if (v.canvas) {
    v.canvas.width = 0;
    v.canvas.remove();
    v.canvas = null;
  }
  v.renderedKey = null;
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const v = views[Number(entry.target.dataset.page) - 1];
      if (entry.isIntersecting) {
        near.add(v);
        renderPage(v);
      } else {
        near.delete(v);
        release(v);
      }
    }
  },
  { rootMargin: "150% 0px" },
);

async function openDocument() {
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ url: CFG.documentUrl, isEvalSupported: false }).promise;
  } catch (err) {
    console.error(err);
    statusEl.classList.add("error");
    statusEl.innerHTML =
      'The guide couldn&rsquo;t be displayed here. <a href="' +
      encodeURI(CFG.documentUrl) +
      '" download>Download the PDF</a>, or email ' +
      '<a href="mailto:' + EDITOR_EMAIL + '?subject=subscribe">' + EDITOR_EMAIL + '</a> ' +
      'with &ldquo;subscribe&rdquo; in the subject line and we will send you the next edition.';
    return;
  }

  const pages = await Promise.all(
    Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)),
  );
  pages.forEach((page, i) => {
    const vp = page.getViewport({ scale: 1 });
    const v = { num: i + 1, page, base: { w: vp.width, h: vp.height } };
    views.push(v);
    buildPage(v);
  });
  layout();
  watchPixelRatio();
  views.forEach((v) => {
    drawHighlights(v);
    observer.observe(v.div);
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 150);
});

// ---------------------------------------------------------------- highlights

function drawHighlights(v, pendingNote) {
  v.hl.replaceChildren();
  const all = pendingNote ? notes.concat([pendingNote]) : notes;
  for (const note of all) {
    for (const r of note.rects || []) {
      if (r.p !== v.num) continue;
      const el = document.createElement("div");
      el.className = "hl" + (note === pendingNote ? " pending" : "");
      el.dataset.note = note.id;
      el.style.left = r.x * 100 + "%";
      el.style.top = r.y * 100 + "%";
      el.style.width = r.w * 100 + "%";
      el.style.height = r.h * 100 + "%";
      v.hl.append(el);
    }
  }
}

function redrawPages(pageNums, pendingNote) {
  for (const n of pageNums) if (views[n - 1]) drawHighlights(views[n - 1], pendingNote);
}

// Client rects of the selected text only (not of wrapper elements such as
// the text layer's endOfContent div, which would cover the whole page).
function selectedTextRects(range) {
  const out = [];
  const add = (node, start, end) => {
    const parent = node.parentElement;
    if (!parent || !parent.closest(".textLayer")) return;
    const pageDiv = parent.closest(".page");
    const sub = document.createRange();
    sub.setStart(node, start);
    sub.setEnd(node, end);
    for (const rect of sub.getClientRects()) out.push({ rect, pageDiv });
  };

  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) {
    add(root, range.startOffset, range.endOffset);
    return out;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  let node;
  while ((node = walker.nextNode())) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end > start) add(node, start, end);
  }
  return out;
}

function mergeRects(rects) {
  rects.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    const sameLine =
      last && last.p === r.p && Math.abs(last.y - r.y) < Math.min(last.h, r.h) * 0.5;
    if (sameLine && r.x <= last.x + last.w + 0.012) {
      const x = Math.min(last.x, r.x);
      const y = Math.min(last.y, r.y);
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      Object.assign(last, { x, y, w: right - x, h: bottom - y });
    } else {
      out.push({ ...r });
    }
  }
  const round = (n) => Math.round(n * 1e5) / 1e5;
  return out.map((r) => ({ p: r.p, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (quote.length < 2) return null;

  const pieces = selectedTextRects(range).filter((p) => p.rect.width >= 1 && p.rect.height >= 1);
  if (!pieces.length) return null;

  const rects = pieces.map(({ rect, pageDiv }) => {
    const box = pageDiv.getBoundingClientRect();
    return {
      p: Number(pageDiv.dataset.page),
      x: (rect.left - box.left) / box.width,
      y: (rect.top - box.top) / box.height,
      w: rect.width / box.width,
      h: rect.height / box.height,
    };
  });
  return {
    quote: quote.slice(0, 2000),
    rects: mergeRects(rects),
    anchor: pieces[pieces.length - 1].rect,
  };
}

// ---------------------------------------------------------------- selection → button

const floatBtn = $("float-btn");
const coarse = window.matchMedia("(pointer: coarse)").matches;
let pendingSelection = null;
let pointerDown = false;

function hideFloat() {
  floatBtn.hidden = true;
}

function showFloatForSelection() {
  if (document.querySelector("dialog[open]")) return;
  const info = readSelection();
  if (!info) {
    pendingSelection = null;
    hideFloat();
    return;
  }
  pendingSelection = info;
  floatBtn.hidden = false;
  const bw = floatBtn.offsetWidth;
  const bh = floatBtn.offsetHeight;
  const r = info.anchor;
  const gap = coarse ? 28 : 8;
  let top = r.bottom + gap;
  if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - gap);
  const left = Math.min(Math.max(8, r.right - bw), window.innerWidth - bw - 8);
  floatBtn.style.left = left + "px";
  floatBtn.style.top = top + "px";
}

// Mirror pdf.js: while dragging a selection, stretch endOfContent over the
// page so the selection doesn't jump to the end of the layer.
pagesEl.addEventListener("pointerdown", (e) => {
  const layer = e.target.closest && e.target.closest(".textLayer");
  if (layer) layer.classList.add("selecting");
});

document.addEventListener("pointerdown", (e) => {
  if (e.target === floatBtn) return;
  pointerDown = true;
  hideFloat();
});

document.addEventListener("pointerup", (e) => {
  pointerDown = false;
  document.querySelectorAll(".textLayer.selecting").forEach((el) => el.classList.remove("selecting"));
  if (e.target === floatBtn) return;
  setTimeout(showFloatForSelection, 10);
});

document.addEventListener("keyup", (e) => {
  if (e.shiftKey || e.key === "Shift") showFloatForSelection();
});

let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (!pointerDown) showFloatForSelection();
  }, 300);
});

let scrollTimer = null;
window.addEventListener(
  "scroll",
  () => {
    if (!floatBtn.hidden) hideFloat();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!pointerDown && pendingSelection) showFloatForSelection();
    }, 200);
  },
  { passive: true },
);

// Keep the text selection alive when the button is pressed.
floatBtn.addEventListener("pointerdown", (e) => e.preventDefault());
floatBtn.addEventListener("mousedown", (e) => e.preventDefault());
floatBtn.addEventListener("click", () => {
  const info = pendingSelection || readSelection();
  hideFloat();
  if (!info) return;
  openComposer(info);
});

// ---------------------------------------------------------------- composer

const composer = $("composer");
let draft = null; // note being written, drawn as a pending highlight
let composerSent = false;

function openComposer(selection) {
  draft = {
    id: newId(),
    quote: selection ? selection.quote : "",
    rects: selection ? selection.rects : [],
  };
  composerSent = false;
  const quoteEl = $("composer-quote");
  quoteEl.hidden = !draft.quote;
  quoteEl.textContent = draft.quote;
  $("composer-title").textContent = draft.quote ? "Comment on this passage" : "Comment for the author";
  $("composer-text").value = "";
  $("composer-name").value = readerName();
  $("composer-hp").value = "";
  $("composer-error").hidden = true;
  $("composer-submit").disabled = false;
  $("composer-submit").textContent = "Send to author";

  const touched = new Set(draft.rects.map((r) => r.p));
  redrawPages(touched, draft);
  try {
    window.getSelection().removeAllRanges();
  } catch {
    /* ignore */
  }
  pendingSelection = null;
  openModal(composer);
  $("composer-text").focus();
}

function closeComposer() {
  if (composer.open) closeModal(composer);
}

composer.addEventListener("close", () => {
  if (draft && !composerSent) redrawPages(new Set(draft.rects.map((r) => r.p)));
  draft = null;
  maybePromptAfterDialog();
});

$("composer-cancel").addEventListener("click", closeComposer);

$("composer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!draft) return;
  const comment = $("composer-text").value.trim();
  const name = $("composer-name").value.trim().slice(0, 80);
  const errorEl = $("composer-error");

  if (!comment && !draft.quote) {
    errorEl.textContent = "Write a comment first.";
    errorEl.hidden = false;
    return;
  }
  setReaderName(name);

  const note = {
    id: draft.id,
    quote: draft.quote,
    rects: draft.rects,
    comment: comment.slice(0, 5000),
    name,
    page: draft.rects.length ? draft.rects[0].p : null,
    ts: new Date().toISOString(),
  };

  const button = $("composer-submit");
  button.disabled = true;
  button.textContent = "Sending…";
  errorEl.hidden = true;
  try {
    await send({
      type: "comment",
      noteId: note.id,
      name: note.name,
      comment: note.comment,
      quote: note.quote,
      page: note.page,
      rects: note.rects,
      docVersion: CFG.documentVersion,
      clientId: clientId(),
      pageUrl: location.href,
      ts: note.ts,
      website: $("composer-hp").value,
    });
  } catch (err) {
    console.error(err);
    errorEl.textContent = sendErrorText(err);
    errorEl.hidden = false;
    button.disabled = false;
    button.textContent = "Send to author";
    return;
  }

  composerSent = true;
  notes.push(note);
  saveNotes();
  redrawPages(new Set(note.rects.map((r) => r.p)));
  renderNotes();
  closeComposer();
  toast("Sent to the author. Thank you.");
});

// ---------------------------------------------------------------- notes panel

const notesPanel = $("notes");

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function renderNotes() {
  const list = $("note-list");
  list.replaceChildren();
  const sorted = notes.slice().sort((a, b) => (a.page || 0) - (b.page || 0) || a.ts.localeCompare(b.ts));
  for (const note of sorted) {
    const li = document.createElement("li");
    li.className = "note";

    if (note.quote) {
      const q = document.createElement("button");
      q.type = "button";
      q.className = "note-quote";
      q.textContent = note.quote;
      q.title = "Show this passage";
      q.addEventListener("click", () => scrollToNote(note));
      li.append(q);
    }
    if (note.comment) {
      const p = document.createElement("p");
      p.className = "note-text";
      p.textContent = note.comment;
      li.append(p);
    }

    const meta = document.createElement("div");
    meta.className = "note-meta";
    const where = note.page ? "p. " + note.page : "General";
    const who = note.name ? " · " + note.name : "";
    meta.append(where + " · " + formatDate(note.ts) + who);
    const sent = document.createElement("span");
    sent.className = "sent";
    sent.textContent = "Sent";
    meta.append(sent);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-btn";
    remove.textContent = "Hide";
    remove.title = "Hide from this browser. The author still has your note.";
    remove.addEventListener("click", () => {
      notes = notes.filter((n) => n.id !== note.id);
      saveNotes();
      redrawPages(new Set((note.rects || []).map((r) => r.p)));
      renderNotes();
    });
    meta.append(remove);
    li.append(meta);
    list.append(li);
  }
  $("notes-empty").hidden = notes.length > 0;
  const count = $("notes-count");
  count.textContent = String(notes.length);
  count.classList.toggle("has", notes.length > 0);
}

function scrollToNote(note) {
  const first = (note.rects || [])[0];
  if (!first) return;
  const v = views[first.p - 1];
  if (!v) return;
  setPanel(false);
  const box = v.div.getBoundingClientRect();
  const y = window.scrollY + box.top + first.y * box.height - window.innerHeight * 0.3;
  window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  setTimeout(() => {
    document.querySelectorAll('.hl[data-note="' + note.id + '"]').forEach((el) => {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    });
  }, 350);
}

function setPanel(open) {
  notesPanel.classList.toggle("open", open);
  $("btn-notes").setAttribute("aria-expanded", String(open));
}

$("btn-notes").addEventListener("click", () => setPanel(!notesPanel.classList.contains("open")));
$("notes-close").addEventListener("click", () => setPanel(false));
$("btn-general").addEventListener("click", () => {
  setPanel(false);
  openComposer(null);
});
$("panel-name").addEventListener("change", (e) => setReaderName(e.target.value));

// ---------------------------------------------------------------- update dialog

const subscribeDialog = $("subscribe");
let subscribeSource = "timer";
let readSeconds = 0;
let promptDue = false;
let clockStarted = false;

function promptAllowed() {
  const state = store.get(KEY.subscribe, null);
  if (!state) return true;
  if (state.state === "subscribed") return false;
  if (state.state === "snoozed") {
    return Date.now() - state.at > CFG.popupSnoozeDays * 86400000;
  }
  return true;
}

// The prompt used to wait for thirty seconds of visible reading. That depended on the
// Page Visibility API, on a timer the browser was willing to run, and on the PDF having
// rendered at all — three things that are not reliable inside an in-app browser, and the
// reader never saw it. It now opens shortly after arrival, once per device.
function startReadingClock() {
  if (clockStarted || !promptAllowed()) return;
  clockStarted = true;
  setTimeout(() => {
    promptDue = true;
    maybePromptAfterDialog();
  }, Math.max(0, Number(CFG.openPromptDelayMs) || 900));
}

function maybePromptAfterDialog() {
  if (!promptDue || document.querySelector("dialog[open]") || pointerDown) return;
  if (!promptAllowed()) {
    promptDue = false;
    return;
  }
  promptDue = false;
  openSubscribe("timer");
}

function openModal(dialog) {
  if (dialog.open) return;
  try {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch {
    dialog.setAttribute("open", "");
  }
  document.body.classList.add("modal-open");
}

function closeModal(dialog) {
  try {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  } catch {
    dialog.removeAttribute("open");
  }
  if (!document.querySelector("dialog[open]")) document.body.classList.remove("modal-open");
}

function openSubscribe(source) {
  subscribeSource = source;
  hideFloat();
  $("subscribe-form").hidden = false;
  $("subscribe-thanks").hidden = true;
  $("subscribe-error").hidden = true;
  $("subscribe-hp").value = "";
  $("subscribe-submit").disabled = false;
  $("subscribe-submit").textContent = "Notify me";
  openModal(subscribeDialog);
}

subscribeDialog.addEventListener("cancel", () => {
  if (subscribeSource === "timer") store.set(KEY.subscribe, { state: "snoozed", at: Date.now() });
});
subscribeDialog.addEventListener("close", () => maybePromptAfterDialog());

$("subscribe-later").addEventListener("click", () => {
  if (subscribeSource === "timer") store.set(KEY.subscribe, { state: "snoozed", at: Date.now() });
  closeModal(subscribeDialog);
});
$("subscribe-done").addEventListener("click", () => closeModal(subscribeDialog));
$("btn-notify").addEventListener("click", () => openSubscribe("header"));

$("subscribe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("subscribe-email");
  const errorEl = $("subscribe-error");
  const email = input.value.trim();
  if (!input.checkValidity() || !email) {
    errorEl.textContent = "Please enter a valid email address.";
    errorEl.hidden = false;
    input.focus();
    return;
  }
  const button = $("subscribe-submit");
  button.disabled = true;
  button.textContent = "Sending…";
  errorEl.hidden = true;
  try {
    await send({
      type: "subscribe",
      email,
      name: readerName(),
      source: subscribeSource,
      docVersion: CFG.documentVersion,
      clientId: clientId(),
      pageUrl: location.href,
      ts: new Date().toISOString(),
      website: $("subscribe-hp").value,
    });
  } catch (err) {
    console.error(err);
    errorEl.textContent = sendErrorText(err);
    errorEl.hidden = false;
    button.disabled = false;
    button.textContent = "Notify me";
    return;
  }
  store.set(KEY.subscribe, { state: "subscribed", at: Date.now() });
  $("subscribe-form").hidden = true;
  $("subscribe-thanks").hidden = false;
  $("subscribe-done").focus();
});

// ---------------------------------------------------------------- misc

let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

if (!store.get(KEY.hint, false)) $("hint").hidden = false;
$("hint-close").addEventListener("click", () => {
  $("hint").hidden = true;
  store.set(KEY.hint, true);
});

$("btn-download").href = CFG.documentUrl;
$("panel-name").value = readerName();
renderNotes();
startReadingClock();
openDocument();
