(() => {
  "use strict";

  const instance = {
    alive: () => {
      try {
        return Boolean(chrome.runtime && chrome.runtime.id);
      } catch {
        return false;
      }
    },
    dispose: null
  };

  // Re-injection (for pages that were already open when the extension loaded or
  // reloaded) must replace the old instance instead of stacking message listeners.
  const previousInstance = window.__dripWriterInstance;
  if (previousInstance && typeof previousInstance.dispose === "function") {
    try {
      previousInstance.dispose();
    } catch {
      // The previous instance may belong to an invalidated extension context.
    }
  }

  window.__dripWriterInstance = instance;
  window.__dripWriterLoaded = true;

  const DEFAULT_SETTINGS = {
    wpmMin: 54,
    wpmMax: 84,
    speedVariance: 25,
    typoRate: 3,
    fixRate: 80,
    useDuration: false,
    durationMin: 10,
    durationSec: 0,
    countdown: 3
  };

  const CANCELLED = { cancelled: true };
  const LOCAL_CARET_CLASS = "docs-text-ui-cursor-blink";

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function countWords(text) {
    const trimmed = String(text || "").trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

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
      durationSec: clamp(Math.round(Number(s.durationSec) || 0), 0, 59),
      countdown: clamp(Math.round(Number(s.countdown) || 0), 0, 5)
    };
  }

  let activeRun = null;
  let wakeLockRelease = null;
  let wakeLockWanted = false;
  let wakeLockPending = false;

  function acquireWakeLock() {
    wakeLockWanted = true;
    if (wakeLockRelease || wakeLockPending) return;
    wakeLockPending = true;
    try {
      if (!navigator.locks || typeof navigator.locks.request !== "function") {
        wakeLockPending = false;
        return;
      }
      void navigator.locks
        .request("dripwriter-active", () => {
          wakeLockPending = false;
          if (!wakeLockWanted) return Promise.resolve();
          return new Promise((resolve) => {
            wakeLockRelease = resolve;
          });
        })
        .catch(() => {
          wakeLockPending = false;
        });
    } catch {
      wakeLockPending = false;
      // The Web Locks API is optional; typing still works without it.
    }
  }

  function releaseWakeLock() {
    wakeLockWanted = false;
    if (!wakeLockRelease) return;
    const release = wakeLockRelease;
    wakeLockRelease = null;
    release();
  }

  let lastStatus = {
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
  let lastEmitAt = 0;
  let emitTimer = null;

  function emitStatus(force) {
    const now = Date.now();
    if (!force && now - lastEmitAt < 120) {
      if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = null;
          emitStatus(true);
        }, 120);
      }
      return;
    }
    lastEmitAt = now;
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
    if (!instance.alive()) {
      if (activeRun) activeRun.cancelled = true;
      return;
    }

    try {
      const result = chrome.runtime.sendMessage({ type: "DW_STATUS", status: lastStatus });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      if (activeRun) activeRun.cancelled = true;
    }
  }

  function setStatus(state, detail, patch, force) {
    lastStatus = { ...lastStatus, state, detail, ...(patch || {}) };
    emitStatus(Boolean(force) || state !== "typing");
  }

  // ---- Editable target discovery ----

  let lastEditable = null;

  function isEditableElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    if (el.hasAttribute("disabled") || el.hasAttribute("readonly")) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      return ["text", "search", "url", "email", "tel", ""].includes(el.type);
    }
    return false;
  }

  document.addEventListener("focusin", (event) => {
    if (isEditableElement(event.target)) lastEditable = event.target;
  }, true);

  function getGenericEditable() {
    const active = document.activeElement;
    if (isEditableElement(active)) return active;
    if (lastEditable && lastEditable.isConnected && isEditableElement(lastEditable)) return lastEditable;
    return null;
  }

  function getDocsContext() {
    const iframe = document.querySelector("iframe.docs-texteventtarget-iframe");
    if (!iframe) return null;
    let doc = null;
    try {
      doc = iframe.contentDocument;
    } catch {
      return null;
    }
    if (!doc) return null;
    const el = doc.querySelector('[contenteditable="true"]');
    if (!el) return null;
    return { kind: "docs", doc, el, win: iframe.contentWindow, iframe };
  }

  function isGoogleDocsPage() {
    return location.hostname === "docs.google.com" && location.pathname.startsWith("/document/");
  }

  function detectTarget() {
    const docs = getDocsContext();
    if (docs) {
      docs.isValid = () => {
        const next = getDocsContext();
        return Boolean(next && next.el === docs.el && next.el.isConnected);
      };
      return docs;
    }

    const el = getGenericEditable();
    if (!el) return null;
    return {
      kind: "generic",
      el,
      doc: el.ownerDocument,
      isValid: () => el.isConnected && isEditableElement(el)
    };
  }

  // ---- Google Docs input engine ----

  function caretSignature() {
    const carets = Array.from(document.querySelectorAll(".kix-cursor")).map((caret) => {
      const style = getComputedStyle(caret);
      const rect = caret.getBoundingClientRect();
      return {
        local: caret.classList.contains(LOCAL_CARET_CLASS),
        sig: `${style.transform}|${style.left}|${style.top}|${Math.round(rect.left)},${Math.round(rect.top)}`
      };
    });
    const local = carets.filter((caret) => caret.local);
    const tracked = local.length ? local : carets;
    return tracked.length ? tracked.map((caret) => caret.sig).join("|") : "no-caret";
  }

  async function waitForCaretChange(before, timeoutMs) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (caretSignature() !== before) return true;
      await sleep(8);
    }
    return false;
  }

  function dispatchInsertEvents(el, text, inputType) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType
      }));
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType
      }));
      return true;
    } catch {
      return false;
    }
  }

  function dispatchPaste(el, text, bubbling) {
    if (!el) return false;
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: Boolean(bubbling),
        cancelable: Boolean(bubbling),
        clipboardData: data
      }));
      return true;
    } catch {
      return false;
    }
  }

  function dispatchKeyboardTyping(el, text) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
      for (const char of text) {
        const key = char === "\n" ? "Enter" : char;
        const upper = char.toUpperCase();
        const code = /^[A-Z]$/.test(upper)
          ? `Key${upper}`
          : char === " "
            ? "Space"
            : char === "\n"
              ? "Enter"
              : "";
        const keyCode = char === "\n"
          ? 13
          : char === " "
            ? 32
            : /^[A-Za-z]$/.test(char)
              ? upper.charCodeAt(0)
              : char.length === 1
                ? char.charCodeAt(0)
                : 0;
        const charCode = char.length === 1 ? char.charCodeAt(0) : 0;
        el.dispatchEvent(new KeyboardEvent("keydown", { key, code, keyCode, which: keyCode, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", {
          key, code, keyCode, which: keyCode, charCode, bubbles: true
        }));
        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, data: char, inputType: "insertText"
        }));
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, data: char, inputType: "insertText"
        }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key, code, keyCode, which: keyCode, bubbles: true }));
      }
      return true;
    } catch {
      return false;
    }
  }

  function dispatchBackspace(el) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true }));
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "deleteContentBackward"
      }));
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "deleteContentBackward"
      }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function dispatchEnter(el) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "insertParagraph"
      }));
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertParagraph"
      }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function tryExec(doc, command, value) {
    try {
      return doc.execCommand(command, false, value);
    } catch {
      return false;
    }
  }

  const DOCS_INSERT_METHODS = [
    { label: "beforeinput", apply: (t, text) => dispatchInsertEvents(t.el, text, "insertText") },
    { label: "paste", apply: (t, text) => dispatchPaste(t.el, text, false) },
    { label: "paste-bubbling", apply: (t, text) => dispatchPaste(t.el, text, true) },
    { label: "keyboard", apply: (t, text) => dispatchKeyboardTyping(t.el, text) },
    {
      label: "execCommand",
      apply: (t, text) => {
        try {
          t.el.focus({ preventScroll: true });
        } catch {
          // Focus is best-effort.
        }
        return tryExec(t.doc, "insertText", text);
      }
    }
  ];

  const DOCS_DELETE_METHODS = [
    { label: "backspace-key", apply: (t) => dispatchBackspace(t.el) },
    {
      label: "execCommand-delete",
      apply: (t) => {
        try {
          t.el.focus({ preventScroll: true });
        } catch {
          // Focus is best-effort.
        }
        return tryExec(t.doc, "delete");
      }
    }
  ];

  const DOCS_NEWLINE_METHODS = [
    { label: "enter-key", apply: (t) => dispatchEnter(t.el) },
    ...DOCS_INSERT_METHODS
  ];

  async function attemptDocsMethod(target, method, text) {
    try {
      target.el.focus({ preventScroll: true });
    } catch {
      // Focus is best-effort; the caret check below is the real verification.
    }
    await sleep(16);
    const before = caretSignature();
    try {
      method.apply(target, [text]);
    } catch {
      return false;
    }
    return waitForCaretChange(before, 400);
  }

  async function tryDocsMethods(target, methods, locked, text) {
    if (locked && await attemptDocsMethod(target, locked, text)) return locked;
    for (const method of methods) {
      if (method === locked) continue;
      if (await attemptDocsMethod(target, method, text)) return method;
    }
    return null;
  }

  // ---- Generic editable input engine ----

  function readGeneric(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return el.innerHTML ?? el.textContent ?? "";
  }

  async function waitForGenericChange(el, before, timeoutMs) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (readGeneric(el) !== before) return true;
      await sleep(16);
    }
    return false;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  function placeCaretAtEnd(el) {
    const doc = el.ownerDocument;
    const selection = doc.getSelection();
    if (!selection) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function selectionInside(el) {
    const selection = el.ownerDocument.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    return { selection, range };
  }

  function insertTextAtCaret(el, text) {
    const doc = el.ownerDocument;
    let context = selectionInside(el);
    if (!context) {
      placeCaretAtEnd(el);
      context = selectionInside(el);
    }
    if (!context) return false;

    const { selection, range } = context;
    range.deleteContents();

    const node = text === "\n" ? doc.createElement("br") : doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
    return true;
  }

  function deleteAtCaret(el) {
    const doc = el.ownerDocument;
    let context = selectionInside(el);
    if (!context) {
      placeCaretAtEnd(el);
      context = selectionInside(el);
    }
    if (!context) return false;

    const { selection, range } = context;
    if (!range.collapsed) {
      range.deleteContents();
    } else {
      const anchor = range.startContainer;
      const offset = range.startOffset;
      if (anchor.nodeType === Node.TEXT_NODE && offset > 0) {
        range.setStart(anchor, offset - 1);
        range.setEnd(anchor, offset);
        range.deleteContents();
      } else {
        try {
          selection.modify("extend", "backward", "character");
          if (!el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) {
            selection.collapse(anchor, offset);
            return false;
          }
          selection.deleteFromDocument();
        } catch {
          return false;
        }
      }
    }

    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward"
    }));
    return true;
  }

  async function insertGeneric(target, text) {
    const el = target.el;
    const before = readGeneric(el);

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;

      const beforeInput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      });
      el.dispatchEvent(beforeInput);
      if (beforeInput.defaultPrevented) return false;

      setNativeValue(el, el.value.slice(0, start) + text + el.value.slice(end));
      const pos = start + text.length;
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        // Some input types (email, number) do not expose a text selection.
      }
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: text
      }));
      return true;
    }

    el.focus({ preventScroll: true });

    if (text === "\n") {
      try {
        if (el.ownerDocument.execCommand("insertParagraph") && readGeneric(el) !== before) return true;
      } catch {
        // Fall through to the event-based paths.
      }
    }

    try {
      const ok = el.ownerDocument.execCommand("insertText", false, text);
      if (ok && readGeneric(el) !== before) return true;
    } catch {
      // Fall through.
    }

    dispatchInsertEvents(el, text, "insertText");
    if (await waitForGenericChange(el, before, 250)) return true;

    if (insertTextAtCaret(el, text) && await waitForGenericChange(el, before, 250)) {
      return true;
    }

    dispatchPaste(el, text, true);
    return waitForGenericChange(el, before, 250);
  }

  async function deleteGeneric(target) {
    const el = target.el;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const end = el.selectionStart ?? el.value.length;
      if (end <= 0) return false;
      const start = end - 1;

      const beforeInput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward"
      });
      el.dispatchEvent(beforeInput);
      if (beforeInput.defaultPrevented) return false;

      setNativeValue(el, el.value.slice(0, start) + el.value.slice(end));
      try {
        el.setSelectionRange(start, start);
      } catch {
        // Some input types do not expose a text selection.
      }
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "deleteContentBackward"
      }));
      return true;
    }

    const before = readGeneric(el);
    el.focus({ preventScroll: true });

    if (deleteAtCaret(el) && await waitForGenericChange(el, before, 250)) return true;

    try {
      if (el.ownerDocument.execCommand("delete") && readGeneric(el) !== before) return true;
    } catch {
      // Fall through.
    }

    dispatchBackspace(el);
    return waitForGenericChange(el, before, 250);
  }

  // Replace the character before the caret in one mutation. Deleting a typo and
  // then typing the correction is fragile in contenteditable: when the typo sits
  // right after a space, the browser trims the temporary trailing space before
  // the next insert, silently swallowing it.
  async function replaceLastGenericChar(target, char) {
    const el = target.el;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const end = el.selectionStart ?? el.value.length;
      if (end <= 0) return false;
      const start = end - 1;

      const beforeInput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertReplacementText",
        data: char
      });
      el.dispatchEvent(beforeInput);
      if (beforeInput.defaultPrevented) return false;

      setNativeValue(el, el.value.slice(0, start) + char + el.value.slice(end));
      const pos = start + char.length;
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        // Some input types do not expose a text selection.
      }
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertReplacementText", data: char
      }));
      return true;
    }

    const before = readGeneric(el);
    el.focus({ preventScroll: true });

    let context = selectionInside(el);
    if (!context) {
      placeCaretAtEnd(el);
      context = selectionInside(el);
    }
    if (!context) return false;

    const { selection, range } = context;
    if (range.collapsed) {
      const anchor = range.startContainer;
      const offset = range.startOffset;
      if (anchor.nodeType === Node.TEXT_NODE && offset > 0) {
        range.setStart(anchor, offset - 1);
        range.setEnd(anchor, offset);
      } else {
        try {
          selection.modify("extend", "backward", "character");
          if (!el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) {
            selection.collapse(anchor, offset);
            return false;
          }
        } catch {
          return false;
        }
      }
    }

    try {
      if (el.ownerDocument.execCommand("insertText", false, char) && readGeneric(el) !== before) {
        return true;
      }
    } catch {
      // Fall through to the Range-based replacement.
    }

    if (insertTextAtCaret(el, char) && await waitForGenericChange(el, before, 250)) {
      return true;
    }
    return false;
  }

  // ---- Typo engine ----

  const KEYBOARD_ROWS = [
    { keys: "1234567890", offset: 0, digitRow: true },
    { keys: "qwertyuiop", offset: 0.3 },
    { keys: "asdfghjkl", offset: 0.8 },
    { keys: "zxcvbnm", offset: 1.3 },
    { keys: ",./", offset: 1.8 }
  ];

  function buildNeighborMap() {
    const positions = new Map();
    KEYBOARD_ROWS.forEach((row, rowIndex) => {
      [...row.keys].forEach((key, columnIndex) => {
        positions.set(key, { row: rowIndex, column: row.offset + columnIndex, digitRow: Boolean(row.digitRow) });
      });
    });

    const map = new Map();
    positions.forEach((position, key) => {
      const neighbors = [];
      positions.forEach((otherPosition, otherKey) => {
        if (key === otherKey) return;
        // Letters are never replaced by digits: a human slips to a nearby
        // letter, not to the number row.
        if (otherPosition.digitRow && !position.digitRow) return;
        const rowDistance = Math.abs(position.row - otherPosition.row);
        const columnDistance = Math.abs(position.column - otherPosition.column);
        if (rowDistance <= 1 && columnDistance <= 1.2) neighbors.push(otherKey);
      });
      map.set(key, neighbors);
    });
    return map;
  }

  const NEIGHBOR_MAP = buildNeighborMap();

  function shouldTypo(char, settings) {
    return /[A-Za-z]/.test(char) && Math.random() * 100 < settings.typoRate;
  }

  function getNearbyTypo(char) {
    const lower = char.toLowerCase();
    const neighbors = NEIGHBOR_MAP.get(lower);
    if (!neighbors || !neighbors.length) return null;
    const typo = neighbors[Math.floor(Math.random() * neighbors.length)];
    return char === lower ? typo : typo.toUpperCase();
  }

  // ---- Timing ----

  function charDelay(run, char) {
    const s = run.settings;

    if (Math.random() < 0.04) {
      run.targetWpm = randomBetween(s.wpmMin, s.wpmMax);
    }
    run.wpm += (run.targetWpm - run.wpm) * 0.08;
    run.wpm = clamp(run.wpm, s.wpmMin, s.wpmMax);

    const base = 60000 / (run.wpm * 5);
    const variance = s.speedVariance / 100;
    let delay = base * randomBetween(Math.max(0.1, 1 - variance), 1 + variance);

    if (char === " ") delay *= 0.55;
    else if (char === "\n") delay *= 3.8;
    else if (/[.,!?;:]/.test(char)) delay *= 2.7;
    else if (/[A-Z]/.test(char)) delay *= 1.15;

    delay = Math.max(8, delay * run.scale);
    return delay;
  }

  function currentWpm(run) {
    return Math.round(run.wpm / (run.scale || 1));
  }

  function estimateRunMs(chars, settings) {
    const text = chars.join("");
    const words = Math.max(1, countWords(text));
    const avgWpm = (settings.wpmMin + settings.wpmMax) / 2;
    let ms = (words / avgWpm) * 60000 * 1.12;
    const correctionOverhead = (settings.typoRate / 100) * (settings.fixRate / 100) * 350;
    ms += chars.length * correctionOverhead;
    return ms;
  }

  // Cumulative expected delay for every character at the average WPM. Used to
  // pace a run so it finishes near a requested wall-clock duration.
  function buildNominalPrefix(chars, settings) {
    const avgWpm = (settings.wpmMin + settings.wpmMax) / 2;
    const base = 60000 / (avgWpm * 5);
    const prefix = new Array(chars.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      let factor = 1;
      if (ch === " ") factor *= 0.55;
      else if (ch === "\n") factor *= 3.8;
      else if (/[.,!?;:]/.test(ch)) factor *= 2.7;
      else if (/[A-Z]/.test(ch)) factor *= 1.15;
      prefix[i + 1] = prefix[i] + base * factor;
    }
    return prefix;
  }

  function durationTargetMs(settings) {
    if (!settings.useDuration) return 0;
    const seconds = settings.durationMin * 60 + settings.durationSec;
    return seconds > 0 ? seconds * 1000 : 0;
  }

  async function waitWhilePaused(run) {
    while (run.paused && !run.cancelled) {
      const pausedAt = performance.now();
      await new Promise((resolve) => {
        run.resumePause = resolve;
      });
      run.pausedAccum += performance.now() - pausedAt;
      run.resumePause = null;
    }
  }

  // Real wall-clock time spent typing, excluding pauses. This counts editor
  // work (Docs insertion + verification) as well as the intentional delays, so
  // duration pacing can compensate when the editor is slower than the WPM math.
  function activeElapsedMs(run) {
    if (!run.clockStart) return 0;
    return Math.max(0, performance.now() - run.clockStart - run.pausedAccum);
  }

  // Words per minute actually achieved so far. In duration mode the WPM range
  // is overridden by the target time, so this is what the user is really seeing.
  function actualWpm(run) {
    const ms = activeElapsedMs(run);
    if (ms < 600) return 0;
    return Math.round((countWords(run.typed) / ms) * 60000);
  }

  function displayWpm(run) {
    return run.durationTargetMs > 0 ? actualWpm(run) : currentWpm(run);
  }

  async function delay(run, ms) {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      if (run.cancelled || !instance.alive()) {
        run.cancelled = true;
        throw CANCELLED;
      }
      await waitWhilePaused(run);
      if (run.cancelled || !instance.alive()) {
        run.cancelled = true;
        throw CANCELLED;
      }

      const slice = Math.min(remaining, 80);
      const start = performance.now();
      await sleep(slice);
      const spent = performance.now() - start;
      remaining -= spent;
      run.sleptMs += spent;
    }
  }

  // ---- Verified insertion ----

  async function docsInsert(run, target, text, remaining) {
    const isNewline = text === "\n";
    const isWhitespace = !isNewline && /^\s+$/.test(text);

    if (isNewline) {
      const winner = await tryDocsMethods(target, DOCS_NEWLINE_METHODS, run.docsNewlineMethod, text);
      if (!winner) {
        throw new Error("Google Docs rejected the line break. Click inside the document and press Start again.");
      }
      run.docsNewlineMethod = winner;
      return { insertedText: text, consumed: 0 };
    }

    let winner = null;
    if (!(isWhitespace && run.docsWhitespaceNeedsPairing)) {
      winner = await tryDocsMethods(
        target,
        DOCS_INSERT_METHODS,
        isWhitespace ? run.docsSpaceMethod : run.docsTextMethod,
        text
      );
    }

    if (!winner && isWhitespace && remaining) {
      run.docsWhitespaceNeedsPairing = true;
      const match = /^(\s*\S)/.exec(remaining);
      if (match && match[1].length <= 8) {
        const suffix = match[1];
        const combined = text + suffix;
        winner = await tryDocsMethods(target, DOCS_INSERT_METHODS, run.docsTextMethod, combined);
        if (winner) {
          run.docsTextMethod = winner;
          return { insertedText: combined, consumed: suffix.length };
        }
      }
    }

    if (!winner && isWhitespace && !remaining) {
      // Trailing whitespace at the very end is not worth failing the run over.
      return { insertedText: "", consumed: 0 };
    }

    if (!winner) {
      throw new Error("Google Docs rejected the input. Click inside the document and press Start again.");
    }

    if (isWhitespace) run.docsSpaceMethod = winner;
    else run.docsTextMethod = winner;

    return { insertedText: text, consumed: 0 };
  }

  async function insertChar(run, target, text, remaining) {
    if (run.cancelled || !instance.alive()) throw CANCELLED;
    if (target.kind === "docs") {
      return docsInsert(run, target, text, remaining);
    }
    const ok = await insertGeneric(target, text);
    if (!ok) throw new Error("The text box stopped accepting text. Click back into it and press Start again.");
    return { insertedText: text, consumed: 0 };
  }

  async function docsDelete(run, target) {
    if (run.docsDeleteMethod && await attemptDocsMethod(target, run.docsDeleteMethod, "")) {
      return true;
    }
    for (const method of DOCS_DELETE_METHODS) {
      if (method === run.docsDeleteMethod) continue;
      if (await attemptDocsMethod(target, method, "")) {
        run.docsDeleteMethod = method;
        return true;
      }
    }
    return false;
  }

  async function deleteOne(run, target) {
    if (run.cancelled || !instance.alive()) throw CANCELLED;
    let ok = false;
    if (target.kind === "docs") {
      ok = await docsDelete(run, target);
    } else {
      ok = await deleteGeneric(target);
    }
    if (!ok) {
      throw new Error("The editor stopped accepting corrections. Click into it and press Start again.");
    }
    await delay(run, randomBetween(35, 90));
  }

  // ---- Typo performance ----

  async function performTypo(run, target, char) {
    if (run.cancelled || !instance.alive()) throw CANCELLED;
    const settings = run.settings;
    const fixed = Math.random() * 100 < settings.fixRate;
    const duplicate = Math.random() < 0.25;

    if (duplicate) {
      let result = await insertChar(run, target, char, "");
      run.typed += result.insertedText;
      run.index += result.consumed;
      await delay(run, charDelay(run, char) * 0.7);

      result = await insertChar(run, target, char, "");
      run.typed += result.insertedText;
      run.index += result.consumed;

      if (fixed) {
        await delay(run, randomBetween(120, 380));
        await deleteOne(run, target);
        run.typed = run.typed.slice(0, -1);
        run.corrections += 1;
        await delay(run, randomBetween(60, 160));
      } else {
        run.keptErrors += 1;
      }
      return;
    }

    const typo = getNearbyTypo(char);
    if (!typo || typo === char) {
      const result = await insertChar(run, target, char, "");
      run.typed += result.insertedText;
      run.index += result.consumed;
      return;
    }

    let result = await insertChar(run, target, typo, "");
    run.typed += result.insertedText;
    run.index += result.consumed;

    if (!fixed) {
      run.keptErrors += 1;
      return;
    }

    await delay(run, randomBetween(120, 420));

    if (target.kind === "docs") {
      await deleteOne(run, target);
      run.typed = run.typed.slice(0, -1);
      run.corrections += 1;
      await delay(run, randomBetween(60, 180));

      result = await insertChar(run, target, char, "");
      run.typed += result.insertedText;
      run.index += result.consumed;
    } else {
      const replaced = await replaceLastGenericChar(target, char);
      if (!replaced) {
        throw new Error("The editor stopped accepting corrections. Click into it and press Start again.");
      }
      run.typed = run.typed.slice(0, -1) + char;
      run.corrections += 1;
      await delay(run, randomBetween(60, 180));
    }
  }

  // ---- Run loop ----

  async function runLoop(run) {
    try {
      for (let step = run.settings.countdown; step > 0; step -= 1) {
        if (run.cancelled || !instance.alive()) return;
        setStatus("starting", `Starting in ${step}...`, {}, true);
        await delay(run, 1000);
      }
      if (run.cancelled || !instance.alive()) return;

      const target = run.target;
      if (!target.isValid()) {
        throw new Error("The editor is no longer available. Click into it and press Start again.");
      }

      const chars = run.chars;
      const total = chars.length;

      run.scale = 1;
      if (run.durationTargetMs > 0) {
        const totalNominal = run.nominalPrefix[total];
        if (totalNominal > 0) {
          run.scale = clamp(run.durationTargetMs / totalNominal, 0.25, 60);
        }
      }

      run.typingStarted = true;
      run.clockStart = performance.now();
      run.pausedAccum = 0;
      run.sleptMs = 0;
      run.overheadPerChar = 0;
      setStatus("typing", "Typing...", {
        index: 0,
        total,
        totalWords: run.totalWords,
        typed: run.typed,
        wpm: displayWpm(run)
      }, true);

      for (; run.index < total; run.index += 1) {
        if (run.cancelled || !instance.alive()) return;
        await waitWhilePaused(run);
        if (run.cancelled || !instance.alive()) return;

        if (run.index % 20 === 0 && !target.isValid()) {
          throw new Error("The editor is no longer available. Click into it and press Start again.");
        }

        if (run.durationTargetMs > 0) {
          const remainingNominal = run.nominalPrefix[total] - run.nominalPrefix[run.index];
          const remainingChars = Math.max(0, total - run.index);
          const overheadBudget = run.overheadPerChar * remainingChars;
          const remainingMs = run.durationTargetMs - activeElapsedMs(run) - overheadBudget;
          if (remainingNominal > 1) {
            const desired = clamp(remainingMs / remainingNominal, 0.25, 60);
            run.scale = clamp(run.scale + (desired - run.scale) * 0.25, 0.25, 60);
          }
        }

        const char = chars[run.index];
        const remaining = chars.slice(run.index + 1).join("");

        if (shouldTypo(char, run.settings)) {
          await performTypo(run, target, char);
        } else {
          const result = await insertChar(run, target, char, remaining);
          run.typed += result.insertedText;
          run.index += result.consumed;
        }

        if (run.cancelled || !instance.alive()) return;

        if (run.durationTargetMs > 0) {
          const overhead = Math.max(0, activeElapsedMs(run) - run.sleptMs);
          const sample = overhead / Math.max(1, run.index + 1);
          run.overheadPerChar = run.overheadPerChar
            ? run.overheadPerChar + (sample - run.overheadPerChar) * 0.15
            : sample;
        }

        setStatus("typing", "Typing...", {
          index: Math.min(total, run.index + 1),
          total,
          typed: run.typed,
          typedWords: countWords(run.typed),
          corrections: run.corrections,
          keptErrors: run.keptErrors,
          wpm: displayWpm(run),
          elapsedMs: activeElapsedMs(run)
        });

        await delay(run, charDelay(run, char));
      }

      if (run.cancelled || !instance.alive()) return;

      setStatus("done", "Finished typing", {
        index: total,
        total,
        typed: run.typed,
        typedWords: countWords(run.typed),
        corrections: run.corrections,
        keptErrors: run.keptErrors,
        wpm: displayWpm(run),
        elapsedMs: activeElapsedMs(run)
      }, true);
    } catch (error) {
      if (run.cancelled || error === CANCELLED) return;
      const message = error instanceof Error ? error.message : "Typing failed.";
      setStatus("error", message, {
        corrections: run.corrections,
        keptErrors: run.keptErrors,
        elapsedMs: activeElapsedMs(run)
      }, true);
    } finally {
      if (activeRun === run) {
        activeRun = null;
        releaseWakeLock();
      }
    }
  }

  // ---- Lifecycle ----

  async function startRun(text, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const source = String(text || "");
    if (!source.trim()) {
      return { ok: false, error: "Add some text first." };
    }

    if (activeRun) {
      activeRun.cancelled = true;
      activeRun.paused = false;
      if (activeRun.resumePause) activeRun.resumePause();
      activeRun = null;
    }

    const target = detectTarget();
    if (!target) {
      releaseWakeLock();
      return {
        ok: false,
        error: isGoogleDocsPage()
          ? "Click inside the Google Doc so the cursor is visible, then press Start."
          : "Click into a text box first, then press Start."
      };
    }

    if (target.kind === "docs") {
      try {
        target.win?.focus();
        target.el.focus({ preventScroll: true });
      } catch {
        // The first verified insert will report a clear error if focus failed.
      }
      await sleep(60);
    }

    acquireWakeLock();

    const chars = Array.from(source);
    const run = {
      cancelled: false,
      paused: false,
      resumePause: null,
      settings,
      target,
      text: source,
      chars,
      index: 0,
      typed: "",
      totalWords: countWords(source),
      corrections: 0,
      keptErrors: 0,
      wpm: randomBetween(settings.wpmMin, settings.wpmMax),
      targetWpm: randomBetween(settings.wpmMin, settings.wpmMax),
      scale: 1,
      clockStart: 0,
      pausedAccum: 0,
      sleptMs: 0,
      overheadPerChar: 0,
      nominalPrefix: buildNominalPrefix(chars, settings),
      durationTargetMs: durationTargetMs(settings),
      docsTextMethod: null,
      docsSpaceMethod: null,
      docsNewlineMethod: null,
      docsDeleteMethod: null,
      docsWhitespaceNeedsPairing: false,
      typingStarted: false
    };

    activeRun = run;
    lastStatus = {
      state: "starting",
      detail: `Starting in ${settings.countdown}...`,
      index: 0,
      total: chars.length,
      totalWords: run.totalWords,
      typedWords: 0,
      typed: "",
      corrections: 0,
      keptErrors: 0,
      wpm: Math.round(run.wpm),
      elapsedMs: 0
    };
    emitStatus(true);

    void runLoop(run);
    return { ok: true, status: lastStatus };
  }

  function pauseRun() {
    const run = activeRun;
    if (!run || run.cancelled) return { ok: false, error: "Nothing is running." };
    run.paused = true;
    setStatus("paused", "Paused", {}, true);
    return { ok: true, status: lastStatus };
  }

  function resumeRun() {
    const run = activeRun;
    if (!run || run.cancelled) return { ok: false, error: "Nothing to resume." };
    if (!run.paused) return { ok: true, status: lastStatus };
    run.paused = false;
    if (run.resumePause) run.resumePause();
    run.resumePause = null;
    setStatus(
      run.typingStarted ? "typing" : "starting",
      run.typingStarted ? "Typing..." : "Starting...",
      {},
      true
    );
    return { ok: true, status: lastStatus };
  }

  function stopRun(detail) {
    const run = activeRun;
    if (run) {
      run.cancelled = true;
      run.paused = false;
      if (run.resumePause) run.resumePause();
      run.resumePause = null;
      activeRun = null;
    }
    releaseWakeLock();
    setStatus("stopped", detail || "Stopped", {}, true);
    return { ok: true, status: lastStatus };
  }

  // ---- Messaging ----

  function handleMessage(message, _sender, sendResponse) {
    if (window.__dripWriterInstance !== instance || !instance.alive()) return;
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "DW_PING":
        sendResponse({ ok: true, status: lastStatus });
        return;
      case "DW_GET_STATUS":
        sendResponse({ ok: true, status: lastStatus });
        return;
      case "DW_START":
        startRun(message.text, message.settings)
          .then(sendResponse)
          .catch((error) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Could not start typing."
          }));
        return true;
      case "DW_PAUSE":
        sendResponse(pauseRun());
        return;
      case "DW_RESUME":
        sendResponse(resumeRun());
        return;
      case "DW_STOP":
        sendResponse(stopRun(message.detail));
        return;
      default:
        return;
    }
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  instance.dispose = () => {
    if (activeRun) {
      activeRun.cancelled = true;
      activeRun.paused = false;
      if (activeRun.resumePause) activeRun.resumePause();
      activeRun = null;
    }
    releaseWakeLock();
    try {
      chrome.runtime.onMessage.removeListener(handleMessage);
    } catch {
      // The old extension context may no longer expose this listener.
    }
  };
})();
