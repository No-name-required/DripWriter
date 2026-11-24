(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    wpmMin: 54,
    wpmMax: 84,
    speedVariance: 25,
    typoRate: 3,
    fixRate: 80,
    useDuration: false,
    durationMin: 10,
    durationSec: 0
  };

  const STORAGE_KEY = "dripwriterSettings";
  const DRAFT_KEY = "dripwriterDraft";
  const PROMPT_TEXT = `Write as a human would, with natural flow and personality. Avoid overused AI words and phrases like "in conclusion," "it is important to note," "delve into," "tapestry," "testament to," "navigate," "unlock," "comprehensive," "game-changer," "in today's fast-paced world," "revolutionize," "seamless," and "robust." Use varied sentence lengths—some short, some longer—with occasional fragments. Use contractions (don't, can't, we're) and occasional colloquialisms. Avoid perfectly balanced parallel structures and overly formal transitions. Write like a real person with a distinct voice, not a polite assistant.`;

  const $ = (id) => document.getElementById(id);

  const els = {
    tabCompose: $("tabCompose"),
    tabSettings: $("tabSettings"),
    viewCompose: $("viewCompose"),
    viewSettings: $("viewSettings"),
    draft: $("draft"),
    draftWords: $("draftWords"),
    estimate: $("estimate"),
    clearBtn: $("clearBtn"),
    startBtn: $("startBtn"),
    pauseBtn: $("pauseBtn"),
    stopBtn: $("stopBtn"),
    statusPill: $("statusPill"),
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    progressBar: $("progressBar"),
    progressPct: $("progressPct"),
    elapsed: $("elapsed"),
    progressWpm: $("progressWpm"),
    progressWords: $("progressWords"),
    paper: $("paper"),
    paperText: $("paperText"),
    caret: $("caret"),
    previewSub: $("previewSub"),
    logList: $("logList"),
    wpmMin: $("wpmMin"),
    wpmMax: $("wpmMax"),
    speedVariance: $("speedVariance"),
    varianceVal: $("varianceVal"),
    wpmBadge: $("wpmBadge"),
    typoRate: $("typoRate"),
    typoVal: $("typoVal"),
    typoBadge: $("typoBadge"),
    fixRate: $("fixRate"),
    fixVal: $("fixVal"),
    useDuration: $("useDuration"),
    durationRow: $("durationRow"),
    durationMin: $("durationMin"),
    useTargetDuration: $("useTargetDuration"),
    targetMin: $("targetMin"),
    targetSec: $("targetSec"),
    durationNote: $("durationNote"),
    resetSettings: $("resetSettings"),
    promptBtn: $("promptToggle"),
    promptContent: $("promptContent"),
    promptText: $("promptText")
  };

  let settings = { ...DEFAULT_SETTINGS };
  let status = {
    state: "idle",
    detail: "Ready",
    index: 0,
    total: 0,
    totalWords: 0,
    typedWords: 0,
    typed: "",
    corrections: 0,
    keptErrors: 0,
    wpm: 0,
    elapsedMs: 0
  };

  let activeTabId = null;
  let lastLogState = "idle";
  let lastCorrections = 0;
  let lastKeptErrors = 0;
  let saveTimer = null;
  let saveDraftTimer = null;

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

  function countWords(text) {
    const trimmed = String(text || "").trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function fmtDurationShort(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

  const nowClock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function normalizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const wpmMin = clamp(Math.round(Number(s.wpmMin) || DEFAULT_SETTINGS.wpmMin), 20, 149);
    const wpmMax = clamp(Math.round(Number(s.wpmMax) || DEFAULT_SETTINGS.wpmMax), wpmMin + 1, 150);
    return {
      wpmMin,
      wpmMax,
      speedVariance: clamp(Math.round(Number(s.speedVariance) || 0), 0, 80),
      typoRate: clamp(Number(s.typoRate) || 0, 0, 25),
      fixRate: clamp(Number(s.fixRate) || 0, 0, 100),
      useDuration: Boolean(s.useDuration),
      durationMin: clamp(Number(s.durationMin) || 0, 0, 10080),
      durationSec: clamp(Math.round(Number(s.durationSec) || 0), 0, 59)
    };
  }

  // ---- Settings persistence ----

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, DRAFT_KEY]);
      settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] || {}) });
      if (typeof stored[DRAFT_KEY] === "string") els.draft.value = stored[DRAFT_KEY];
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
    applySettingsToUI();
    updateEstimate();
  }

  function saveSettingsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORAGE_KEY]: settings }).catch(() => {});
    }, 200);
  }

  function saveSettingsNow() {
    clearTimeout(saveTimer);
    chrome.storage.local.set({ [STORAGE_KEY]: settings }).catch(() => {});
  }

  function saveDraftSoon() {
    clearTimeout(saveDraftTimer);
    saveDraftTimer = setTimeout(() => {
      chrome.storage.local.set({ [DRAFT_KEY]: els.draft.value }).catch(() => {});
    }, 250);
  }

  function saveDraftNow() {
    clearTimeout(saveDraftTimer);
    chrome.storage.local.set({ [DRAFT_KEY]: els.draft.value }).catch(() => {});
  }

  function totalDurationSec() {
    return Math.max(0, settings.durationMin * 60 + settings.durationSec);
  }

  function fmtDurationClock(totalSec) {
    const total = Math.max(0, Math.round(totalSec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function updateDurationUI() {
    const on = settings.useDuration;
    els.useTargetDuration.checked = on;
    els.targetMin.disabled = !on;
    els.targetSec.disabled = !on;
    const total = totalDurationSec();
    if (!on) {
      els.durationNote.textContent = "Auto pace from WPM";
    } else if (total > 0) {
      els.durationNote.textContent = `Finish near ${fmtDurationClock(total)}`;
    } else {
      els.durationNote.textContent = "Set a time";
    }
  }

  function applySettingsToUI() {
    els.wpmMin.value = settings.wpmMin;
    els.wpmMax.value = settings.wpmMax;
    els.speedVariance.value = settings.speedVariance;
    els.typoRate.value = settings.typoRate;
    els.fixRate.value = settings.fixRate;
    els.useDuration.checked = settings.useDuration;
    els.durationMin.value = settings.durationMin;
    els.durationRow.classList.toggle("hidden", !settings.useDuration);
    els.targetMin.value = Math.floor(settings.durationMin);
    els.targetSec.value = settings.durationSec;
    updateDurationUI();
    updateSettingLabels();
  }

  function updateSettingLabels() {
    els.varianceVal.textContent = `${settings.speedVariance}%`;
    els.typoVal.textContent = `${settings.typoRate}%`;
    els.fixVal.textContent = `${settings.fixRate}%`;
    els.wpmBadge.textContent = `${settings.wpmMin}–${settings.wpmMax} WPM`;
    els.typoBadge.textContent = `${settings.typoRate}% typos`;
  }

  function updateEstimate() {
    const text = els.draft.value;
    const words = countWords(text);
    els.draftWords.textContent = `${words} ${words === 1 ? "word" : "words"}`;

    if (!words) {
      els.estimate.textContent = "No draft yet";
      return;
    }

    if (settings.useDuration && totalDurationSec() > 0) {
      els.estimate.textContent = `~${fmtDurationClock(totalDurationSec())} target`;
      return;
    }

    const avgWpm = (settings.wpmMin + settings.wpmMax) / 2;
    let ms = (words / avgWpm) * 60000 * 1.12;
    const correctionOverhead = (settings.typoRate / 100) * (settings.fixRate / 100) * 350;
    ms += text.length * correctionOverhead;
    els.estimate.textContent = `~${fmtDurationShort(ms)} at ${Math.round(avgWpm)} WPM`;
  }

  // ---- Rendering ----

  function addLog(text) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = nowClock();
    const message = document.createElement("span");
    message.textContent = text;
    li.append(time, message);
    els.logList.appendChild(li);

    while (els.logList.children.length > 30) {
      els.logList.removeChild(els.logList.firstChild);
    }
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  function setLocalError(message) {
    status = {
      ...status,
      state: "error",
      detail: message,
      index: 0,
      total: 0,
      totalWords: 0,
      typedWords: 0,
      typed: "",
      corrections: 0,
      keptErrors: 0,
      wpm: 0,
      elapsedMs: 0
    };
    renderStatus();
  }

  function renderStatus() {
    const state = status.state || "idle";
    const pillClass = {
      typing: "is-active",
      starting: "is-active",
      paused: "is-paused",
      done: "is-done",
      error: "is-error"
    }[state] || "";

    els.statusPill.className = `status-pill ${pillClass}`.trim();
    els.statusDot.className = `status-dot ${pillClass}`.trim();
    els.statusText.textContent = {
      typing: "Typing",
      starting: "Starting",
      paused: "Paused",
      done: "Done",
      stopped: "Stopped",
      error: "Error"
    }[state] || "Idle";

    const total = status.total || 0;
    const index = state === "done" ? total : (status.index || 0);
    const pct = total ? Math.min(100, (index / total) * 100) : 0;

    els.progressBar.style.width = `${pct}%`;
    els.progressPct.textContent = `${Math.round(pct)}%`;
    els.elapsed.textContent = fmtTime(status.elapsedMs || 0);
    els.progressWpm.textContent = status.wpm ? `${Math.round(status.wpm)} WPM` : "— WPM";

    const totalWords = status.totalWords || countWords(els.draft.value);
    const typedWords = status.typedWords || countWords(status.typed || "");
    els.progressWords.textContent = `${typedWords} / ${totalWords} words`;

    const typed = status.typed || "";
    els.paperText.textContent = typed;
    els.caret.classList.toggle("hidden", !["typing", "starting", "paused"].includes(state));
    if (state === "typing") {
      els.paper.scrollTop = els.paper.scrollHeight;
    }
    els.previewSub.textContent = status.detail || "Waiting to start";

    const running = state === "typing" || state === "starting";
    const paused = state === "paused";
    els.startBtn.disabled = running || paused;
    els.pauseBtn.disabled = !(running || paused);
    els.stopBtn.disabled = !(running || paused);
    els.pauseBtn.textContent = paused ? "Resume" : "Pause";

    if (state === "starting" && lastLogState !== "starting") {
      els.logList.innerHTML = "";
      lastCorrections = 0;
      lastKeptErrors = 0;
      addLog("Preparing to type");
    }

    if (state !== lastLogState) {
      if (state === "typing" && lastLogState === "starting") addLog("Started typing");
      if (state === "paused") addLog("Paused");
      if (state === "typing" && lastLogState === "paused") addLog("Resumed");
      if (state === "stopped") addLog("Stopped");
      if (state === "done") addLog("Finished typing");
      if (state === "error") addLog(status.detail || "Stopped with an error");
      lastLogState = state;
    }

    if ((status.corrections || 0) > lastCorrections) {
      const fixed = status.corrections - lastCorrections;
      addLog(fixed === 1 ? "Fixed a typo" : `Fixed ${fixed} typos`);
      lastCorrections = status.corrections;
    }

    if ((status.keptErrors || 0) > lastKeptErrors) {
      const kept = status.keptErrors - lastKeptErrors;
      addLog(kept === 1 ? "Left a typo in place" : `Left ${kept} typos in place`);
      lastKeptErrors = status.keptErrors;
    }
  }

  function showView(name) {
    const isCompose = name === "compose";
    els.tabCompose.classList.toggle("is-active", isCompose);
    els.tabSettings.classList.toggle("is-active", !isCompose);
    els.tabCompose.setAttribute("aria-selected", String(isCompose));
    els.tabSettings.setAttribute("aria-selected", String(!isCompose));
    els.viewCompose.classList.toggle("is-active", isCompose);
    els.viewSettings.classList.toggle("is-active", !isCompose);
  }

  // ---- Content-script bridge ----

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async function ensureContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "DW_PING" });
      if (response?.ok) return true;
    } catch {
      // The page was loaded before the extension; inject the content script.
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const response = await chrome.tabs.sendMessage(tabId, { type: "DW_PING" });
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  }

  async function startTyping() {
    const text = els.draft.value;
    if (!text.trim()) {
      setLocalError("Paste some text first.");
      return;
    }

    saveDraftNow();
    saveSettingsNow();
    const tab = await getActiveTab();
    if (!tab?.id) {
      setLocalError("No active tab found.");
      return;
    }

    activeTabId = tab.id;
    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      setLocalError("DripWriter can't run on this page. Open a Google Doc or a text field and try again.");
      return;
    }

    els.startBtn.disabled = true;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: "DW_START",
        text,
        settings
      });
      if (!result?.ok) {
        setLocalError(result?.error || "Could not start typing.");
        return;
      }
      if (result.status) {
        status = { ...status, ...result.status };
        renderStatus();
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not start typing.");
    }
  }

  async function togglePause() {
    if (!activeTabId) return;
    const resuming = status.state === "paused";
    try {
      const result = await chrome.tabs.sendMessage(activeTabId, {
        type: resuming ? "DW_RESUME" : "DW_PAUSE"
      });
      if (result?.status) {
        status = { ...status, ...result.status };
        renderStatus();
      }
    } catch {
      // The tab may have navigated away; the next status refresh will catch up.
    }
  }

  async function stopTyping() {
    if (!activeTabId) return;
    try {
      const result = await chrome.tabs.sendMessage(activeTabId, { type: "DW_STOP" });
      if (result?.status) {
        status = { ...status, ...result.status };
        renderStatus();
      }
    } catch {
      // The tab may have navigated away.
    }
  }

  async function refreshFromTab() {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    activeTabId = tab.id;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "DW_GET_STATUS" });
      if (response?.ok && response.status) {
        status = { ...status, ...response.status };
        renderStatus();
      }
    } catch {
      // No content script on this page yet.
    }
  }

  // ---- Settings events ----

  function syncWpmInputs() {
    let min = Math.round(Number(els.wpmMin.value));
    let max = Math.round(Number(els.wpmMax.value));
    if (!Number.isFinite(min)) min = DEFAULT_SETTINGS.wpmMin;
    if (!Number.isFinite(max)) max = DEFAULT_SETTINGS.wpmMax;
    min = clamp(min, 20, 149);
    max = clamp(max, min + 1, 150);
    settings.wpmMin = min;
    settings.wpmMax = max;
    els.wpmMin.value = min;
    els.wpmMax.value = max;
    updateSettingLabels();
    updateEstimate();
    saveSettingsSoon();
  }

  function syncTargetInputs() {
    let min = Math.round(Number(els.targetMin.value));
    let sec = Math.round(Number(els.targetSec.value));
    if (!Number.isFinite(min) || min < 0) min = 0;
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    min = clamp(min, 0, 10080);
    sec = clamp(sec, 0, 59);
    settings.durationMin = min;
    settings.durationSec = sec;
    els.targetMin.value = min;
    els.targetSec.value = sec;
    els.durationMin.value = min;
    updateDurationUI();
    updateEstimate();
    saveSettingsSoon();
  }

  els.tabCompose.addEventListener("click", () => showView("compose"));
  els.tabSettings.addEventListener("click", () => showView("settings"));

  els.draft.addEventListener("input", () => {
    updateEstimate();
    saveDraftSoon();
  });

  els.clearBtn.addEventListener("click", () => {
    els.draft.value = "";
    updateEstimate();
    saveDraftNow();
    els.draft.focus();
  });

  els.promptBtn.addEventListener("click", () => {
    const isOpen = els.promptContent.classList.contains("hidden");
    els.promptContent.classList.toggle("hidden", !isOpen);
    els.promptBtn.textContent = isOpen ? "▲" : "▼";
    els.promptBtn.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) els.promptText.textContent = PROMPT_TEXT;
  });

  const scanImportFileBtn = document.getElementById("scanImportFileBtn");
  const scanImportFile = document.getElementById("scanImportFile");
  if (scanImportFileBtn) {
    scanImportFileBtn.addEventListener("click", () => {
      if (scanImportFile) scanImportFile.click();
    });
  }
  if (scanImportFile) {
    scanImportFile.addEventListener("change", async () => {
      const file = scanImportFile.files && scanImportFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        els.draft.value = text;
        updateEstimate();
        saveDraftSoon();
        els.draft.focus();
      } catch {
        setLocalError("Could not read the file.");
      }
    });
  }

  els.startBtn.addEventListener("click", startTyping);
  els.pauseBtn.addEventListener("click", togglePause);
  els.stopBtn.addEventListener("click", stopTyping);

  els.wpmMin.addEventListener("change", syncWpmInputs);
  els.wpmMax.addEventListener("change", syncWpmInputs);

  els.speedVariance.addEventListener("input", () => {
    settings.speedVariance = Number(els.speedVariance.value);
    updateSettingLabels();
    saveSettingsSoon();
  });

  els.typoRate.addEventListener("input", () => {
    settings.typoRate = Number(els.typoRate.value);
    updateSettingLabels();
    updateEstimate();
    saveSettingsSoon();
  });

  els.fixRate.addEventListener("input", () => {
    settings.fixRate = Number(els.fixRate.value);
    updateSettingLabels();
    updateEstimate();
    saveSettingsSoon();
  });

  els.useDuration.addEventListener("change", () => {
    settings.useDuration = els.useDuration.checked;
    els.durationRow.classList.toggle("hidden", !settings.useDuration);
    updateDurationUI();
    updateEstimate();
    saveSettingsSoon();
  });

  els.durationMin.addEventListener("change", () => {
    const value = clamp(Math.round(Number(els.durationMin.value) || 1), 1, 10080);
    settings.durationMin = value;
    els.durationMin.value = value;
    els.targetMin.value = value;
    updateDurationUI();
    updateEstimate();
    saveSettingsSoon();
  });

  els.useTargetDuration.addEventListener("change", () => {
    settings.useDuration = els.useTargetDuration.checked;
    els.useDuration.checked = settings.useDuration;
    els.durationRow.classList.toggle("hidden", !settings.useDuration);
    updateDurationUI();
    updateEstimate();
    saveSettingsSoon();
  });

  els.targetMin.addEventListener("input", syncTargetInputs);
  els.targetMin.addEventListener("change", syncTargetInputs);
  els.targetSec.addEventListener("input", syncTargetInputs);
  els.targetSec.addEventListener("change", syncTargetInputs);

  els.resetSettings.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    applySettingsToUI();
    updateEstimate();
    saveSettingsNow();
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "DW_STATUS" || !message.status) return;
    if (activeTabId && sender?.tab?.id && sender.tab.id !== activeTabId) return;
    status = { ...status, ...message.status };
    renderStatus();
  });

  // Popups are torn down without warning, so flush pending debounced writes.
  window.addEventListener("pagehide", () => {
    saveDraftNow();
    saveSettingsNow();
  });

  async function init() {
    await loadSettings();
    renderStatus();
    await refreshFromTab();
    els.draft.focus();
    const end = els.draft.value.length;
    try {
      els.draft.setSelectionRange(end, end);
    } catch {
      // The textarea always supports selection; this is just defensive.
    }
  }

  void init();
})();
