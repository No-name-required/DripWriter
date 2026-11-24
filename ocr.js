/* Photo-to-sentences feature.
   Self-contained and loaded alongside (but never modifying) popup.js.
   Uses a locally vendored Tesseract.js so it works with no network access. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    card: $("scanCard"),
    uploadBtn: $("scanUploadBtn"),
    uploadInput: $("scanUploadInput"),
    status: $("scanStatus"),
    preview: $("scanPreview"),
    previewText: $("scanPreviewText"),
    useBtn: $("scanUseBtn"),
    cleanBtn: $("scanCleanBtn"),
    clearBtn: $("scanClearBtn"),
    manualInput: $("scanManualText"),
    manualBtn: $("scanManualBtn"),
    draft: $("draft")
  };

  // All existing markup is optional-guarded: if this file is dropped into a
  // page without the new UI, it simply does nothing.
  if (!els.card || !els.uploadInput || !els.draft) return;

  let lastSentences = "";
  let workerPromise = null;

  function ocrBase() {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL("ocr/");
    }
    return new URL("ocr/", document.baseURI).href;
  }

  function setStatus(message, kind) {
    els.status.className = "scan-status" + (kind ? " is-" + kind : "");
    els.status.textContent = "";
    if (kind === "working") {
      const spinner = document.createElement("span");
      spinner.className = "scan-spinner";
      els.status.appendChild(spinner);
    }
    els.status.appendChild(document.createTextNode(message));
  }

  /* ---- Turn raw OCR output into clean sentences ---- */

  function toSentences(raw) {
    let text = String(raw || "").replace(/\r\n?/g, "\n");

    // Rejoin words that OCR split across a line break, e.g. "exam-\nple".
    text = text.replace(/(\w)-\n(\w)/g, "$1$2");

    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const bullet = /^(?:[-•*\u2022\u00b7>]|\d+[.)])\s+/;
    const chunks = [];
    let paragraph = [];

    for (const line of lines) {
      if (bullet.test(line)) {
        if (paragraph.length) {
          chunks.push(paragraph.join(" "));
          paragraph = [];
        }
        chunks.push(line.replace(bullet, ""));
      } else {
        paragraph.push(line);
      }
    }
    if (paragraph.length) chunks.push(paragraph.join(" "));

    const sentences = [];
    for (let chunk of chunks) {
      chunk = chunk
        .replace(/([.!?])(?=[\p{Lu}\p{Lt}\u201c"'(])/gu, "$1 ")
        .replace(/([!?])(?=[\p{Ll}])/gu, "$1 ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (!chunk) continue;

      // Break a run-on block at real sentence boundaries.
      const parts = chunk.split(/(?<=[.!?])\s+(?=[\p{L}\p{N}"'(\u201c])/u);
      for (let part of parts) {
        part = part.trim();
        if (!part) continue;
        part = part.charAt(0).toLocaleUpperCase() + part.slice(1);
        if (!/[.!?]["')\u201d]?$/.test(part)) {
          part = part.replace(/[,;:]$/, "") + ".";
        }
        sentences.push(part);
      }
    }

    return sentences.join(" ");
  }

  /* ---- Offline OCR engine ---- */

  function getWorker() {
    const onProgress = (pct) => setStatus("Reading text " + pct + "%", "working");
    if (typeof DripOCR !== "undefined") return DripOCR.getWorker(onProgress);
    if (workerPromise) return workerPromise;
    if (typeof Tesseract === "undefined") {
      return Promise.reject(new Error("OCR engine did not load. Reload the page."));
    }
    const base = ocrBase();
    workerPromise = Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
      workerPath: base + "worker.min.js",
      corePath: base + "core",
      langPath: base + "lang",
      workerBlobURL: false,
      gzip: true,
      logger: (msg) => {
        if (msg.status === "recognizing text") {
          onProgress(Math.round((msg.progress || 0) * 100));
        }
      }
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
    return workerPromise;
  }

  async function handleImage(file) {
    if (!file || !file.type || file.type.indexOf("image/") !== 0) {
      setStatus("Please choose an image file.", "error");
      return;
    }

    lastSentences = "";
    els.previewText.textContent = "";
    els.preview.classList.add("hidden");
    els.useBtn.disabled = true;
    setStatus("Preparing photo…", "working");

    try {
      setStatus("Reading your picture…", "working");
      let raw = "";
      if (typeof DripOCR !== "undefined") {
        raw = await DripOCR.recognize(file, (pct) => setStatus("Reading text " + pct + "%", "working"));
      } else {
        let prepared = file;
        if (typeof DripImage !== "undefined" && DripImage.prepare) {
          try { prepared = await DripImage.prepare(file) || file; } catch { /* use raw file */ }
        }
        const worker = await getWorker();
        const withTimeout = (typeof DripImage !== "undefined" && DripImage.withTimeout)
          ? DripImage.withTimeout
          : (p, ms, msg) => new Promise((resolve, reject) => {
              const t = setTimeout(() => reject(new Error(msg)), ms);
              p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
            });
        const result = await withTimeout(
          worker.recognize(prepared),
          90000,
          "Reading took too long. Try a smaller, well-lit photo."
        );
        raw = (result && result.data && result.data.text) || "";
      }
      const sentences = toSentences(raw);

      if (!sentences) {
        setStatus("No readable text found. Try a sharper, well-lit picture.", "error");
        return;
      }

      lastSentences = sentences;
      els.previewText.textContent = sentences;
      els.preview.classList.remove("hidden");
      els.useBtn.disabled = false;
      setStatus("Text ready — add it to your draft.", "done");
    } catch (error) {
      setStatus("Could not read the picture: " + (error && error.message ? error.message : error), "error");
    }
  }

  /* ---- Clean text: strip invisible formatting characters ---- */

  function cleanText(text) {
    if (!text) return "";
    return text
      // Zero-width spaces, byte order mark, LTR/RTL marks
      .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "")
      // Bidirectional formatting overrides
      .replace(/[\u202A-\u202E]/g, "")
      // Other invisible format / variation characters
      .replace(/[\u2060-\u206F\uFE00-\uFE0F]/g, "")
      // Collapse multiple spaces/tabs into one
      .replace(/[ \t\r\f\v]+/g, " ")
      .trim();
  }

  // Every source (upload, drop, paste) runs the exact same OCR flow.
  function bindInput(input) {
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) void handleImage(input.files[0]);
    });
  }

  if (els.uploadBtn && els.uploadInput) {
    const manualText = $("scanManualText");
    const manualBtn = $("scanManualBtn");
    if (manualBtn && manualText) {
      manualBtn.addEventListener("click", () => {
        const value = manualText.value.trim();
        if (!value) { setStatus("Type or paste some text first.", "error"); return; }
        lastSentences = toSentences(value) || value;
        els.previewText.textContent = lastSentences;
        els.preview.classList.remove("hidden");
        els.useBtn.disabled = false;
        setStatus("Text ready — add it to your draft.", "done");
      });
      // Auto-clean pasted text in the manual input
      manualText.addEventListener("paste", (event) => {
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData).getData("text");
        if (text) {
          manualText.value = cleanText(text);
        }
      });
    }

    els.uploadBtn.addEventListener("click", () => els.uploadInput.click());
    bindInput(els.uploadInput);
  }

  els.cleanBtn.addEventListener("click", () => {
    const target = els.preview.classList.contains("hidden")
      ? els.manualInput
      : els.previewText;
    if (!target) return;
    const current = target.textContent || target.value || "";
    if (!current.trim()) {
      setStatus("No text to clean.", "error");
      return;
    }
    const cleaned = cleanText(current);
    if (els.preview.classList.contains("hidden")) {
      els.manualInput.value = cleaned;
    } else {
      els.previewText.textContent = cleaned;
      lastSentences = cleaned;
    }
    setStatus("Text cleaned.", "done");
  });

  // Dropping a photo transferred from a phone, or pasting one from the
  // clipboard, works too.
  let dragDepth = 0;
  els.card.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    els.card.classList.add("is-dragover");
  });
  els.card.addEventListener("dragover", (event) => event.preventDefault());
  els.card.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.card.classList.remove("is-dragover");
  });
  els.card.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.card.classList.remove("is-dragover");
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files[0]) void handleImage(files[0]);
  });

  document.addEventListener("paste", (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.indexOf("image/") === 0) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void handleImage(file);
        }
        break;
      }
    }
  });

  els.useBtn.addEventListener("click", () => {
    if (!lastSentences) return;
    const existing = els.draft.value.trim();
    els.draft.value = existing ? existing + " " + lastSentences : lastSentences;
    // Let popup.js react (word count, estimate and draft saving) unchanged.
    els.draft.dispatchEvent(new Event("input", { bubbles: true }));
    els.useBtn.disabled = true;
    els.draft.focus();
    els.draft.setSelectionRange(els.draft.value.length, els.draft.value.length);
    setStatus("Added to your draft.", "done");
  });

  els.clearBtn.addEventListener("click", () => {
    els.uploadInput.value = "";
    lastSentences = "";
    els.previewText.textContent = "";
    els.preview.classList.add("hidden");
    els.useBtn.disabled = true;
    setStatus("No image yet");
  });
})();
