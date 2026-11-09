// Highlight-and-comment for the reading edition.
//
// The PDF reader anchors a highlight to rectangles on a page, which is the only thing a
// canvas can offer. Here the text is in the DOM, so a note is anchored to character
// offsets inside its chapter and checked against the quoted words when it is restored.
// Reflow, zoom and a different font size therefore cost nothing: the offsets do not move.

(function () {
  "use strict";

  var CFG = Object.assign(
    { endpoint: "", documentVersion: "", readVersion: "", editorEmail: "editor@breakingintobiglaw.com" },
    window.BIBL_CONFIG || {}
  );
  // localhost posts to the dev server even when a live endpoint is configured:
  // a test row in the real sheet is a test row the editors have to clean out
  var IS_LOCAL = ["localhost", "127.0.0.1"].indexOf(location.hostname) >= 0;
  var ENDPOINT = IS_LOCAL ? "/api/submit" : (CFG.endpoint || "");
  var VERSION = CFG.readVersion || CFG.documentVersion || "v";
  var KEY = { notes: "bibl.read.notes." + VERSION, name: "bibl.name", client: "bibl.client" };

  var store = {
    get: function (k, f) {
      try { var r = localStorage.getItem(k); return r == null ? f : JSON.parse(r); } catch (e) { return f; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked: the page still works */ }
    },
  };

  var notes = store.get(KEY.notes, []);
  var $ = function (id) { return document.getElementById(id); };

  function clientId() {
    var id = store.get(KEY.client, "");
    if (!id) { id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); store.set(KEY.client, id); }
    return id;
  }

  // ------------------------------------------------------------- anchoring

  function sectionOf(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    return el && el.closest ? el.closest("section.sec") : null;
  }

  function textNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function offsetOf(section, node, offset) {
    var nodes = textNodes(section), total = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return total + offset;
      total += nodes[i].nodeValue.length;
    }
    return -1;
  }

  // wraps [start, end) of the section's flat text in <mark>; splitting text nodes keeps
  // the flat text identical, so every other note's offsets survive this
  function paint(section, start, end, id) {
    var nodes = textNodes(section), pos = 0, painted = false;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], len = node.nodeValue.length, from = pos, to = pos + len;
      pos = to;
      if (to <= start || from >= end) continue;
      if (node.parentNode && node.parentNode.tagName === "MARK") { painted = true; continue; }
      var a = Math.max(0, start - from), b = Math.min(len, end - from);
      var target = node;
      if (b < len) target.splitText(b);
      if (a > 0) target = target.splitText(a);
      var mark = document.createElement("mark");
      mark.className = "hl";
      mark.dataset.note = id;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      painted = true;
    }
    return painted;
  }

  function restore() {
    notes.forEach(function (n) {
      var section = document.getElementById(n.sec);
      if (!section) return;
      var flat = section.textContent;
      var start = n.start;
      if (flat.slice(n.start, n.end) !== n.quote) {
        // the text moved between editions: fall back to the first exact match
        var found = flat.indexOf(n.quote);
        if (found < 0) return;
        start = found;
      }
      paint(section, start, start + n.quote.length, n.id);
    });
    countNotes();
  }

  function countNotes() {
    var el = $("notes-count");
    if (el) { el.textContent = String(notes.length); el.hidden = notes.length === 0; }
  }

  // ------------------------------------------------------------- dialogs

  function openModal(d) {
    if (d.open) return;
    try { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); }
    catch (e) { d.setAttribute("open", ""); }
    document.body.classList.add("modal-open");
  }
  function closeModal(d) {
    try { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); }
    catch (e) { d.removeAttribute("open"); }
    if (!document.querySelector("dialog[open]")) document.body.classList.remove("modal-open");
  }

  // ------------------------------------------------------------- selection

  var draft = null;
  var floatBtn = $("float-comment");

  function hideFloat() { if (floatBtn) floatBtn.hidden = true; }

  function onSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideFloat();
    var range = sel.getRangeAt(0);
    var quote = sel.toString().replace(/\s+/g, " ").trim();
    if (quote.length < 3) return hideFloat();
    var section = sectionOf(range.startContainer);
    if (!section || section !== sectionOf(range.endContainer)) return hideFloat();

    var start = offsetOf(section, range.startContainer, range.startOffset);
    var end = offsetOf(section, range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return hideFloat();

    draft = { sec: section.id, start: start, end: end, quote: section.textContent.slice(start, end) };

    var r = range.getBoundingClientRect();
    floatBtn.hidden = false;
    var top = r.top + window.scrollY - floatBtn.offsetHeight - 10;
    if (top < window.scrollY + 8) top = r.bottom + window.scrollY + 10;
    var left = r.left + r.width / 2 - floatBtn.offsetWidth / 2;
    left = Math.max(10, Math.min(left, document.documentElement.clientWidth - floatBtn.offsetWidth - 10));
    floatBtn.style.top = top + "px";
    floatBtn.style.left = left + "px";
  }

  document.addEventListener("selectionchange", function () {
    clearTimeout(onSelection.t);
    onSelection.t = setTimeout(onSelection, 180);
  });

  // ------------------------------------------------------------- backend

  function send(payload) {
    if (!ENDPOINT) return Promise.reject(new Error("not-configured"));
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    // text/plain by default: Apps Script accepts it without a CORS preflight
    return fetch(ENDPOINT, { method: "POST", body: JSON.stringify(payload), signal: controller.signal })
      .then(function (res) { return res.json().catch(function () { return null; }).then(function (d) { return { res: res, d: d }; }); })
      .then(function (o) {
        if (!o.res.ok || !o.d || o.d.ok !== true) throw new Error((o.d && o.d.error) || "HTTP " + o.res.status);
        return o.d;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function errorText(err) {
    if (err && err.message === "not-configured") return "Comments aren’t switched on yet. Please try again later.";
    if (err && err.name === "AbortError") return "That took too long. Please try again.";
    return "Something went wrong sending that. Please try again, or email " + CFG.editorEmail + ".";
  }

  // ------------------------------------------------------------- composer

  var composer = $("composer");

  function openComposer() {
    if (!draft) return;
    hideFloat();
    $("composer-quote").textContent = draft.quote.length > 400 ? draft.quote.slice(0, 400) + "…" : draft.quote;
    $("composer-name").value = store.get(KEY.name, "") || "";
    $("composer-text").value = "";
    $("composer-error").hidden = true;
    $("composer-hp").value = "";
    var b = $("composer-submit");
    b.disabled = false; b.textContent = "Send to the editors";
    openModal(composer);
  }

  if (floatBtn) floatBtn.addEventListener("click", openComposer);
  $("composer-cancel").addEventListener("click", function () { closeModal(composer); });

  $("composer-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!draft) return;
    var comment = $("composer-text").value.trim();
    var name = $("composer-name").value.trim().slice(0, 80);
    var errorEl = $("composer-error");
    if (!comment) {
      errorEl.textContent = "Write a comment first.";
      errorEl.hidden = false;
      return;
    }
    store.set(KEY.name, name);
    var id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var anchor = { sec: draft.sec, start: draft.start, end: draft.end };
    var link = location.origin + location.pathname + "#" + draft.sec;
    var button = $("composer-submit");
    button.disabled = true; button.textContent = "Sending…";
    errorEl.hidden = true;

    send({
      type: "comment",
      noteId: id,
      name: name,
      comment: comment.slice(0, 5000),
      quote: draft.quote,
      page: null,
      rects: [anchor],
      docVersion: VERSION,
      clientId: clientId(),
      pageUrl: link,
      ts: new Date().toISOString(),
      website: $("composer-hp").value,
    }).then(function () {
      var note = { id: id, sec: draft.sec, start: draft.start, end: draft.end, quote: draft.quote, comment: comment, name: name };
      notes.push(note);
      store.set(KEY.notes, notes);
      var section = document.getElementById(note.sec);
      if (section) paint(section, note.start, note.end, note.id);
      countNotes();
      closeModal(composer);
      toast("Sent. Your highlight stays on this device.");
      window.getSelection().removeAllRanges();
      draft = null;
    }).catch(function (err) {
      console.error(err);
      errorEl.textContent = errorText(err);
      errorEl.hidden = false;
      button.disabled = false; button.textContent = "Send to the editors";
    });
  });

  // ------------------------------------------------------------- notes list

  var list = $("notes");
  $("btn-notes").addEventListener("click", function () {
    var body = $("notes-body");
    body.innerHTML = "";
    if (!notes.length) {
      body.innerHTML = "<p class='empty'>Highlight any passage to send the editors a comment. Your highlights stay on this device.</p>";
    } else {
      notes.slice().reverse().forEach(function (n) {
        var item = document.createElement("div");
        item.className = "note-item";
        var q = document.createElement("blockquote");
        q.textContent = n.quote.length > 180 ? n.quote.slice(0, 180) + "…" : n.quote;
        var c = document.createElement("p");
        c.textContent = n.comment;
        var go = document.createElement("button");
        go.type = "button"; go.className = "ghost"; go.textContent = "Go to passage";
        go.addEventListener("click", function () {
          closeModal(list);
          var mark = document.querySelector('mark[data-note="' + n.id + '"]');
          (mark || document.getElementById(n.sec)).scrollIntoView({ block: "center", behavior: "smooth" });
        });
        item.appendChild(q); item.appendChild(c); item.appendChild(go);
        body.appendChild(item);
      });
    }
    openModal(list);
  });
  $("notes-close").addEventListener("click", function () { closeModal(list); });

  // ------------------------------------------------------------- toast

  var toastTimer;
  function toast(text) {
    var el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  restore();
})();
