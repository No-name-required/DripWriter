/* DripWriter Mobile — drives the unchanged extension insertion engine through
   the paired relay bridge. All settings, OCR and UI state are local. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE = "dripwriterMobile";

  const DEFAULT_SETTINGS = {
    wpmMin: 54, wpmMax: 84, speedVariance: 25,
    typoRate: 3, fixRate: 80, useDuration: false, durationMin: 10, durationSec: 0
  };

  let settings = { ...DEFAULT_SETTINGS };
  let socket = null;
  let requestSeq = 0;
  const pending = new Map();
  let lastSentences = "";
  let workerPromise = null;
  let status = { state: "idle", detail: "Waiting to start", index: 0, total: 0,
                 totalWords: 0, typedWords: 0, typed: "", wpm: 0, elapsedMs: 0 };

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  const countWords = (t) => (String(t || "").trim() ? String(t).trim().split(/\s+/).length : 0);

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) || "{}");
      if (saved.settings) settings = { ...DEFAULT_SETTINGS, ...saved.settings };
      if (typeof saved.draft === "string") $("draft").value = saved.draft;
      if (typeof saved.code === "string") $("code").value = saved.code;
    } catch { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({
        settings, draft: $("draft").value, code: $("code").value
      }));
    } catch { /* ignore */ }
  }

  /* ---- Relay connection ---- */

  function defaultRelay() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}`;
  }

  function setLink(kind, text) {
    const pill = $("linkPill");
    pill.className = "pill" + (kind ? " " + kind : "");
    $("linkText").textContent = text;
  }

  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    const code = $("code").value.trim().toUpperCase();
    if (!code) { setLink("", "Enter a code"); return; }
    $("code").value = code;

    const base = ($("relay").value.trim() || defaultRelay()).replace(/\/$/, "");
    let url;
    try { url = new URL(`${base}/ws?code=${encodeURIComponent(code)}&role=pwa`); }
    catch { setLink("", "Bad relay URL"); return; }
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol === "http:") url.protocol = "ws:";

    setLink("wait", "Connecting…");
    try { socket = new WebSocket(url.href); }
    catch (e) { setLink("", "Connection failed"); return; }

    socket.onopen = () => { setLink("on", "Paired · " + code); save(); };
    socket.onclose = () => {
      setLink("", "Not paired");
      $("docStatus").textContent = "No Doc detected";
      socket = null;
      for (const { reject } of pending.values()) reject(new Error("Disconnected"));
      pending.clear();
    };
    socket.onerror = () => setLink("", "Relay error");
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      if (message.type === "DW_WELCOME" || message.type === "DW_PRESENCE") {
        if (message.bridge) {
          setLink("on", "Paired · " + code);
          void send("DW_PING").then((r) => {
            $("docStatus").textContent = r?.ok ? "Doc / field ready" : (r?.error || "No Doc detected");
          }).catch(() => {});
        } else {
          setLink("wait", "Waiting for computer…");
        }
        return;
      }
      if (message.type === "DW_STATUS" && message.status) {
        status = { ...status, ...message.status };
        renderStatus();
        return;
      }
      if (message.type === "DW_REPLY") {
        const entry = pending.get(message.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.requestId);
          if (message.ok === false) entry.reject(new Error(message.error || "Failed"));
          else entry.resolve(message);
        }
        if (message.status) { status = { ...status, ...message.status }; renderStatus(); }
      }
    };
  }

  function send(type, extra = {}) {
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("Not paired to a computer yet."));
    }
    const requestId = `m${Date.now()}-${++requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("No reply from the computer."));
      }, 12000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type, requestId, ...extra }));
    });
  }

  /* ---- Rendering ---- */

  function renderStatus() {
    const state = status.state || "idle";
    const total = status.total || 0;
    const index = state === "done" ? total : (status.index || 0);
    const pct = total ? Math.min(100, (index / total) * 100) : 0;
    $("progressBar").style.width = `${pct}%`;
    $("progressPct").textContent = `${Math.round(pct)}%`;
    $("elapsed").textContent = fmtClock(status.elapsedMs || 0);
    $("wpm").textContent = status.wpm ? `${Math.round(status.wpm)} WPM` : "— WPM";
    $("words").textContent = `${status.typedWords || 0} / ${status.totalWords || countWords($("draft").value)} words`;

    const running = state === "typing" || state === "starting";
    const paused = state === "paused";
    $("startBtn").disabled = running || paused;
    $("pauseBtn").disabled = !(running || paused);
    $("stopBtn").disabled = !(running || paused);
    $("pauseBtn").textContent = paused ? "Resume" : "Pause";
    $("startBtn").textContent = state === "error" ? "Retry typing" : "Start typing";
  }

  function updateEstimate() {
    const words = countWords($("draft").value);
    $("draftWords").textContent = `${words} ${words === 1 ? "word" : "words"}`;
    if (!words) { $("estimate").textContent = "No draft yet"; return; }
    const avg = (settings.wpmMin + settings.wpmMax) / 2;
    const minutes = Math.max(1, Math.round((words / avg) * 1.12));
    $("estimate").textContent = `~${minutes} min at ${Math.round(avg)} WPM`;
  }

  function applySettings() {
    $("wpmMin").value = settings.wpmMin;
    $("wpmMax").value = settings.wpmMax;
    $("variance").value = settings.speedVariance;
    $("typoRate").value = settings.typoRate;
    $("fixRate").value = settings.fixRate;
    $("varianceVal").textContent = `${settings.speedVariance}%`;
    $("typoVal").textContent = `${settings.typoRate}%`;
    $("fixVal").textContent = `${settings.fixRate}%`;
    $("wpmBadge").textContent = `${settings.wpmMin}–${settings.wpmMax} WPM`;
    updateEstimate();
  }

  function readSettings() {
    let min = clamp(Math.round(Number($("wpmMin").value) || 54), 20, 149);
    let max = clamp(Math.round(Number($("wpmMax").value) || 84), min + 1, 150);
    settings = {
      ...settings,
      wpmMin: min, wpmMax: max,
      speedVariance: Number($("variance").value),
      typoRate: Number($("typoRate").value),
      fixRate: Number($("fixRate").value)
    };
    $("wpmMin").value = min;
    $("wpmMax").value = max;
    applySettings();
    save();
  }

  /* ---- Commands ---- */

  async function start() {
    const text = $("draft").value;
    if (!text.trim()) { $("docStatus").textContent = "Add some text first"; return; }
    try {
      $("docStatus").textContent = "Starting…";
      const r = await send("DW_START", { text, settings });
      if (r.status) { status = { ...status, ...r.status }; renderStatus(); }
      $("docStatus").textContent = "Typing in your Doc";
    } catch (e) { $("docStatus").textContent = e.message; }
  }

  async function command(type, label) {
    try {
      const r = await send(type);
      if (r.status) { status = { ...status, ...r.status }; renderStatus(); }
    } catch (e) { $("docStatus").textContent = e.message; }
    if (label) $("docStatus").textContent = label;
  }

  /* ---- Photo to sentences (same offline flow as the extension) ---- */

  function toSentences(raw) {
    let text = String(raw || "").replace(/\r\n?/g, "\n").replace(/(\w)-\n(\w)/g, "$1$2");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const bullet = /^(?:[-•*\u2022\u00b7>]|\d+[.)])\s+/;
    const chunks = [];
    let paragraph = [];
    for (const line of lines) {
      if (bullet.test(line)) {
        if (paragraph.length) { chunks.push(paragraph.join(" ")); paragraph = []; }
        chunks.push(line.replace(bullet, ""));
      } else paragraph.push(line);
    }
    if (paragraph.length) chunks.push(paragraph.join(" "));

    const sentences = [];
    for (let chunk of chunks) {
      chunk = chunk
        .replace(/([.!?])(?=[\p{Lu}\p{Lt}\u201c"'(])/gu, "$1 ")
        .replace(/([!?])(?=[\p{Ll}])/gu, "$1 ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/\s+/g, " ").trim();
      if (!chunk) continue;
      for (let part of chunk.split(/(?<=[.!?])\s+(?=[\p{L}\p{N}"'(\u201c])/u)) {
        part = part.trim();
        if (!part) continue;
        part = part.charAt(0).toLocaleUpperCase() + part.slice(1);
        if (!/[.!?]["')\u201d]?$/.test(part)) part = part.replace(/[,;:]$/, "") + ".";
        sentences.push(part);
      }
    }
    return sentences.join(" ");
  }

  function scanStatus(message, kind) {
    $("scanStatus").className = "scan-status" + (kind ? " is-" + kind : "");
    $("scanStatus").textContent = message;
  }

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
      workerPath: new URL("ocr/worker.min.js", document.baseURI).href,
      corePath: new URL("ocr/core", document.baseURI).href,
      langPath: new URL("ocr/lang", document.baseURI).href,
      workerBlobURL: false, gzip: true,
      logger: (m) => {
        if (m.status === "recognizing text") scanStatus(`Reading text ${Math.round((m.progress || 0) * 100)}%`, "working");
      }
    }).catch((e) => { workerPromise = null; throw e; });
    return workerPromise;
  }

  async function handleImage(file) {
    if (!file || !file.type.startsWith("image/")) { scanStatus("Please choose an image.", "error"); return; }
    lastSentences = "";
    $("scanPreviewText").textContent = "";
    $("scanPreview").classList.add("hidden");
    $("useBtn").disabled = true;
    scanStatus("Preparing photo…", "working");
    try {
      scanStatus("Reading your picture…", "working");
      const raw = (typeof DripOCR !== "undefined")
        ? await DripOCR.recognize(file, (pct) => scanStatus(`Reading text ${pct}%`, "working"))
        : await (async () => {
            const worker = await getWorker();
            const result = await DripImage.withTimeout(
              worker.recognize(file), 90000,
              "Reading took too long. Try a smaller, well-lit photo."
            );
            return result?.data?.text || "";
          })();
      const sentences = toSentences(raw);
      if (!sentences) { scanStatus("No readable text found. Try a sharper photo.", "error"); return; }
      lastSentences = sentences;
      $("scanPreviewText").textContent = sentences;
      $("scanPreview").classList.remove("hidden");
      $("useBtn").disabled = false;
      scanStatus("Text ready — add it to your draft.", "done");
    } catch (e) {
      scanStatus(`Could not read the photo: ${e.message || e}`, "error");
    }
  }

  /* ---- Events ---- */

  $("connectBtn").addEventListener("click", () => {
    if (socket && socket.readyState === 1) { socket.close(); setLink("", "Not paired"); }
    else connect();
  });
  $("newCode").addEventListener("click", () => {
    const n = Math.floor(1000 + Math.random() * 9000);
    $("code").value = `DW-${n}`;
    save();
  });

  $("draft").addEventListener("input", () => { updateEstimate(); save(); });
  $("clearBtn").addEventListener("click", () => {
    $("draft").value = ""; updateEstimate(); save(); $("draft").focus();
  });

  $("startBtn").addEventListener("click", start);
  $("pauseBtn").addEventListener("click", () => {
    void command(status.state === "paused" ? "DW_RESUME" : "DW_PAUSE",
                 status.state === "paused" ? "Resuming…" : "Paused");
  });
  $("stopBtn").addEventListener("click", () => void command("DW_STOP", "Stopped"));

  ["wpmMin", "wpmMax", "variance", "typoRate", "fixRate"].forEach((id) => {
    $(id).addEventListener("input", readSettings);
    $(id).addEventListener("change", readSettings);
  });

  $("scanManualBtn").addEventListener("click", () => {
    const value = $("scanManualText").value.trim();
    if (!value) { scanStatus("Type or paste some text first.", "error"); return; }
    lastSentences = toSentences(value) || value;
    $("scanPreviewText").textContent = lastSentences;
    $("scanPreview").classList.remove("hidden");
    $("useBtn").disabled = false;
    scanStatus("Text ready — add it to your draft.", "done");
  });

  $("uploadBtn").addEventListener("click", () => $("uploadInput").click());
  $("uploadInput").addEventListener("change", () => {
    if ($("uploadInput").files?.[0]) void handleImage($("uploadInput").files[0]);
  });
  $("useBtn").addEventListener("click", () => {
    if (!lastSentences) return;
    const existing = $("draft").value.trim();
    $("draft").value = existing ? `${existing} ${lastSentences}` : lastSentences;
    $("draft").dispatchEvent(new Event("input", { bubbles: true }));
    $("useBtn").disabled = true;
    scanStatus("Added to your draft.", "done");
    save();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  load();
  if (!$("relay").value) $("relay").value = defaultRelay();
  if (!$("code").value) $("newCode").click();
  applySettings();
  renderStatus();
})();
