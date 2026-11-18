/* DripWriter — Phone Only. A standalone PWA that types into Google Docs
   through the Docs API. No relay, no bridge, no computer. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const KEY = "dripwriterPhoneOnly";
  const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const DOCS = "https://docs.googleapis.com/v1/documents";
  const SCOPE = "https://www.googleapis.com/auth/documents";

  const DEFAULTS = {
    wpmMin: 54, wpmMax: 84, speedVariance: 25, typoRate: 3, fixRate: 80
  };

  let settings = { ...DEFAULTS };
  let token = null;            // { value, expires }
  let running = false;
  let paused = false;
  let stopped = false;
  let typedCount = 0;
  let totalChars = 0;
  let startedAt = 0;
  let elapsedBefore = 0;
  let pauseAt = 0;
  let lastSentences = "";
  let workerPromise = null;

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const countWords = (t) => (String(t || "").trim() ? String(t).trim().split(/\s+/).length : 0);
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      settings = { ...DEFAULTS, ...(saved.settings || {}) };
      if (typeof saved.draft === "string") $("draft").value = saved.draft;
      if (typeof saved.clientId === "string") $("clientId").value = saved.clientId;
      if (typeof saved.docLink === "string") $("docLink").value = saved.docLink;
      if (saved.token && saved.token.value) token = saved.token;
    } catch { /* ignore */ }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        settings, draft: $("draft").value, clientId: $("clientId").value,
        docLink: $("docLink").value, token
      }));
    } catch { /* ignore */ }
  }

  /* ---- Google sign-in (Authorization Code + PKCE) ---- */

  function redirectUri() {
    return location.origin + location.pathname;
  }

  async function signIn() {
    const clientId = $("clientId").value.trim();
    if (!clientId) {
      $("setupHint").textContent = "Add your Google OAuth Client ID first (see the README).";
      return;
    }
    save();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem("dwVerifier", verifier);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "consent",
      include_granted_scopes: "true"
    });
    location.href = `${AUTH_URL}?${params.toString()}`;
  }

  async function finishSignIn() {
    const code = new URLSearchParams(location.search).get("code");
    if (!code) return;
    history.replaceState({}, document.title, location.pathname);
    const verifier = sessionStorage.getItem("dwVerifier");
    sessionStorage.removeItem("dwVerifier");
    if (!verifier) { $("setupHint").textContent = "Sign-in expired. Please try again."; return; }

    try {
      const body = new URLSearchParams({
        code, client_id: $("clientId").value.trim(),
        redirect_uri: redirectUri(), code_verifier: verifier,
        grant_type: "authorization_code"
      });
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Sign-in failed");
      token = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
      save();
      setAuth(true);
      await loadDocInfo();
    } catch (e) {
      $("setupHint").textContent = e.message;
    }
  }

  function setAuth(on) {
    $("authPill").className = "pill" + (on ? " on" : "");
    $("authText").textContent = on ? "Signed in" : "Not signed in";
  }
  function signOut() {
    token = null; save(); setAuth(false);
    $("docName").textContent = "No document";
    $("setupHint").textContent = "Signed out.";
  }

  async function api(url, options = {}) {
    if (!token || Date.now() >= token.expires) {
      throw new Error("Session expired — sign in again.");
    }
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.value}`, ...(options.headers || {}) }
    });
    if (!res.ok) {
      let detail = "";
      try { const d = await res.json(); detail = d.error?.message || ""; } catch { /* ignore */ }
      throw new Error(`Google Docs error ${res.status}${detail ? ": " + detail : ""}`);
    }
    return res.json();
  }

  function docId() {
    const match = $("docLink").value.match(/\/document\/d\/([\w-]+)/);
    return match ? match[1] : null;
  }

  async function loadDocInfo() {
    const id = docId();
    if (!id) { $("docName").textContent = "Paste a Doc link"; return false; }
    try {
      const doc = await api(`${DOCS}/${id}?fields=title,body.content(endIndex)`);
      $("docName").textContent = doc.title || "Untitled";
      return true;
    } catch (e) {
      $("docName").textContent = "Could not open Doc";
      $("runStatus").textContent = e.message;
      return false;
    }
  }

  function insertionIndex(doc) {
    const content = doc.body?.content || [];
    const last = content[content.length - 1];
    return Math.max(1, (last?.endIndex || 1) - 1);
  }

  async function insertText(index, text) {
    const id = docId();
    if (!id) throw new Error("No document selected.");
    return api(`${DOCS}/${id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ insertText: { text, location: { index } } }] })
    });
  }

  async function deleteRange(start, end) {
    const id = docId();
    return api(`${DOCS}/${id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ deleteTextRange: { range: { startIndex: start, endIndex: end } } }] })
    });
  }

  /* ---- Render ---- */

  function renderEstimate() {
    const words = countWords($("draft").value);
    $("draftWords").textContent = `${words} ${words === 1 ? "word" : "words"}`;
    if (!words) { $("estimate").textContent = "No draft yet"; return; }
    const avg = (settings.wpmMin + settings.wpmMax) / 2;
    $("estimate").textContent = `~${Math.max(1, Math.round(words / avg))} min at ${Math.round(avg)} WPM`;
  }

  function renderSettings() {
    $("wpmMin").value = settings.wpmMin;
    $("wpmMax").value = settings.wpmMax;
    $("variance").value = settings.speedVariance;
    $("typoRate").value = settings.typoRate;
    $("fixRate").value = settings.fixRate;
    $("varianceVal").textContent = `${settings.speedVariance}%`;
    $("typoVal").textContent = `${settings.typoRate}%`;
    $("fixVal").textContent = `${settings.fixRate}%`;
    $("wpmBadge").textContent = `${settings.wpmMin}–${settings.wpmMax} WPM`;
    renderEstimate();
  }

  function renderProgress() {
    const pct = totalChars ? Math.min(100, (typedCount / totalChars) * 100) : 0;
    $("progressBar").style.width = `${pct}%`;
    $("progressPct").textContent = `${Math.round(pct)}%`;
    const ms = running ? (Date.now() - startedAt - elapsedBefore) : elapsedBefore;
    $("elapsed").textContent = fmtClock(ms);
    $("wpm").textContent = ms > 1000 ? `${Math.round((typedCount / 5) / (ms / 60000))} WPM` : "— WPM";
    $("words").textContent = `${countWords($("draft").value.slice(0, typedCount))} / ${countWords($("draft").value)} words`;
    $("startBtn").disabled = running || !token;
    $("pauseBtn").disabled = !running;
    $("stopBtn").disabled = !running;
    $("pauseBtn").textContent = paused ? "Resume" : "Pause";
    $("startBtn").textContent = "Start typing";
  }

  /* ---- Typing engine (human-paced via the Docs API) ---- */

  async function waitWhilePaused() {
    while (paused && !stopped) await sleep(120);
    if (stopped) throw new Error("stopped");
  }

  async function run() {
    if (running) return;
    if (!token) { $("runStatus").textContent = "Sign in to Google first."; return; }
    const text = $("draft").value;
    if (!text) { $("runStatus").textContent = "Add some text first."; return; }
    if (!await loadDocInfo()) return;

    running = true; paused = false; stopped = false;
    typedCount = 0; totalChars = Array.from(text).length;
    startedAt = Date.now(); elapsedBefore = 0; pauseAt = 0;
    $("runStatus").textContent = "Typing into Google Docs…";
    renderProgress();

    let index = insertionIndex(await api(`${DOCS}/${docId()}?fields=body.content(endIndex)`));
    const chars = Array.from(text);

    try {
      for (let i = 0; i < chars.length; i++) {
        await waitWhilePaused();
        const ch = chars[i];

        const avg = (settings.wpmMin + settings.wpmMax) / 2;
        const variance = 1 + (Math.random() * 2 - 1) * (settings.speedVariance / 100);
        const delay = (60000 / (avg * 5)) * variance;
        await sleep(delay);
        await waitWhilePaused();

        if (ch !== "\n" && Math.random() * 100 < settings.typoRate) {
          const wrong = "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)];
          await insertText(index, wrong);
          index += 1;
          await sleep(180 + Math.random() * 250);
          await waitWhilePaused();
          if (Math.random() * 100 < settings.fixRate) {
            await deleteRange(index, index + 1);
            index -= 1;
            await insertText(index, ch);
          } else {
            typedCount += 1;
          }
        } else {
          await insertText(index, ch);
        }
        index += 1;
        typedCount += 1;
        renderProgress();
      }
      $("runStatus").textContent = "Finished typing";
    } catch (e) {
      if (e.message === "stopped") $("runStatus").textContent = "Stopped";
      else $("runStatus").textContent = e.message;
    } finally {
      if (paused) { elapsedBefore += Date.now() - pauseAt; pauseAt = 0; }
      running = false; paused = false;
      renderProgress();
    }
  }

  function togglePause() {
    if (!running) return;
    if (paused) { elapsedBefore += Date.now() - pauseAt; pauseAt = 0; paused = false; }
    else { pauseAt = Date.now(); paused = true; }
    $("runStatus").textContent = paused ? "Paused" : "Typing into Google Docs…";
    renderProgress();
  }

  function stop() {
    stopped = true;
    $("runStatus").textContent = "Stopping…";
  }

  /* ---- Photo to sentences (offline OCR) ---- */

  function toSentences(raw) {
    let text = String(raw || "").replace(/\r\n?/g, "\n").replace(/(\w)-\n(\w)/g, "$1$2");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const bullet = /^(?:[-•*\u2022\u00b7>]|\d+[.)])\s+/;
    const chunks = [];
    let para = [];
    for (const line of lines) {
      if (bullet.test(line)) {
        if (para.length) { chunks.push(para.join(" ")); para = []; }
        chunks.push(line.replace(bullet, ""));
      } else para.push(line);
    }
    if (para.length) chunks.push(para.join(" "));
    const sentences = [];
    for (let chunk of chunks) {
      chunk = chunk.replace(/([.!?])(?=[\p{Lu}\p{Lt}\u201c"'(])/gu, "$1 ")
        .replace(/([!?])(?=[\p{Ll}])/gu, "$1 ")
        .replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
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
      logger: (m) => { if (m.status === "recognizing text") scanStatus(`Reading text ${Math.round((m.progress || 0) * 100)}%`, "working"); }
    }).catch((e) => { workerPromise = null; throw e; });
    return workerPromise;
  }

  async function handleImage(file) {
    if (!file || !file.type.startsWith("image/")) { scanStatus("Please choose an image.", "error"); return; }
    lastSentences = "";
    $("scanPreviewText").textContent = "";
    $("scanPreview").classList.add("hidden");
    $("useBtn").disabled = true;
    scanStatus("Reading your picture…", "working");
    try {
      const worker = await getWorker();
      const result = await worker.recognize(file);
      const sentences = toSentences(result?.data?.text || "");
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

  $("signInBtn").addEventListener("click", () => void signIn());
  $("signOutBtn").addEventListener("click", signOut);
  ["clientId", "docLink"].forEach((id) => $(id).addEventListener("change", () => {
    save();
    if (id === "docLink" && token) void loadDocInfo();
  }));

  $("draft").addEventListener("input", () => { renderEstimate(); save(); });
  $("clearBtn").addEventListener("click", () => { $("draft").value = ""; renderEstimate(); save(); });
  $("startBtn").addEventListener("click", () => void run());
  $("pauseBtn").addEventListener("click", togglePause);
  $("stopBtn").addEventListener("click", stop);

  ["wpmMin", "wpmMax", "variance", "typoRate", "fixRate"].forEach((id) => {
    $(id).addEventListener("input", () => {
      let min = clamp(Math.round(Number($("wpmMin").value) || 54), 20, 149);
      let max = clamp(Math.round(Number($("wpmMax").value) || 84), min + 1, 150);
      settings = {
        ...settings, wpmMin: min, wpmMax: max,
        speedVariance: Number($("variance").value),
        typoRate: Number($("typoRate").value), fixRate: Number($("fixRate").value)
      };
      renderSettings(); save();
    });
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
  renderSettings();
  renderProgress();
  setAuth(Boolean(token && token.expires > Date.now()));
  void finishSignIn();
  if (token && token.expires > Date.now()) void loadDocInfo();
})();
