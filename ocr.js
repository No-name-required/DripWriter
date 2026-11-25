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
    draft: $("draft"),
    origRunBtn: $("origRunBtn"),
    origStatus: $("origState"),
    origScore: $("origScore"),
    origCopy: $("origCopy"),
    origList: $("origList")
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

    const lines = text.split("\n").map((line) => line.trim());
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

  /* ---- Originality check: paragraph-by-paragraph analysis ---- */

  const FILLER_PHRASES = [
    "in conclusion",
    "in summary",
    "in conclusion, it is important to note",
    "it is important to note",
    "it is worth noting",
    "it is crucial to note",
    "it is essential to note",
    "delve into",
    "delves into",
    "tapestry",
    "testament to",
    "in the ever-evolving",
    "when it comes to",
    "at the end of the day",
    "needless to say",
    "that being said",
    "with that in mind",
    "moreover",
    "furthermore",
    "additionally",
    "not only but also",
    "a wide range of",
    "a myriad of",
    "plethora of",
    "utilize",
    "leverage",
    "seamless",
    "robust",
    "cutting-edge",
    "game-changer",
    "paradigm shift",
    "on the other hand",
    "overall, it is clear",
    "this essay will",
    "i will discuss",
    "first and foremost",
    "last but not least",
    "as a matter of fact",
    "the fact of the matter is",
    "in this day and age",
    "the bottom line is",
    "keep in mind that",
    "it goes without saying",
    "as previously mentioned",
    "as stated above",
    "landscape",
    "beacon",
    "comprehensive",
    "comprehensive guide",
    "ultimate guide",
    "in today's fast-paced world",
    "in today's rapidly evolving",
    "navigate",
    "unlock",
    "unlocking",
    "unlock the",
    "embark on",
    "embarking on",
    "testament",
    "testament to the",
    "stands as a",
    "stands as",
    "serves as a",
    "serves as",
    "plays a crucial role",
    "plays a vital role",
    "not only... but also",
    "not only ... but also",
    "on one hand",
    "on the other hand",
    "however",
    "nevertheless",
    "nonetheless",
    "consequently",
    "therefore",
    "thus",
    "hence",
    "accordingly",
    "subsequently",
    "meanwhile",
    "furthermore",
    "moreover",
    "in addition",
    "additionally",
    "likewise",
    "similarly",
    "conversely",
    "alternatively",
    "conversely",
    "in contrast",
    "by contrast",
    "in summary",
    "to summarize",
    "to sum up",
    "in brief",
    "briefly",
    "in short",
    "put simply",
    "put differently",
    "in other words",
    "that is to say",
    "namely",
    "specifically",
    "particularly",
    "especially",
    "especially",
    "notably",
    "remarkably",
    "significantly",
    "substantially",
    "considerably",
    "quite",
    "rather",
    "pretty",
    "fairly",
    "rather",
    "pretty much",
    "kind of",
    "sort of",
    "basically",
    "essentially",
    "literally",
    "actually",
    "obviously",
    "clearly",
    "evidently",
    "apparently",
    "presumably",
    "likely",
    "probably",
    "possibly",
    "perhaps",
    "maybe",
    "i think",
    "i believe",
    "i feel",
    "in my opinion",
    "from my perspective",
    "from my point of view",
    "it seems that",
    "it appears that",
    "it seems",
    "it appears",
    "it seems likely",
    "it seems probable",
    "it is likely that",
    "it is probable that",
    "it is possible that",
    "it is possible",
    "it is clear that",
    "it is clear",
    "it is evident that",
    "it is evident",
    "it is obvious that",
    "it is obvious",
    "it is certain that",
    "it is certain",
    "it is undeniable that",
    "it is undeniable",
    "it is incontrovertible that",
    "it is incontrovertible",
    "it is indisputable that",
    "it is indisputable",
    "it is unquestionable that",
    "it is unquestionable",
    "it is beyond doubt that",
    "it is beyond doubt",
    "it goes without saying that",
    "it goes without saying",
    "needless to say",
    "needless to say",
    "it stands to reason that",
    "it stands to reason",
    "common sense dictates that",
    "common sense dictates",
    "common sense tells us that",
    "common sense tells us",
    "we all know that",
    "we all know",
    "everyone knows that",
    "everyone knows",
    "it is universally acknowledged that",
    "it is universally acknowledged",
    "as we all know",
    "as we all know",
    "as everyone knows",
    "as everyone knows",
    "as is well known",
    "as is well known",
    "as is commonly known",
    "as is commonly known",
    "it is a well-known fact that",
    "it is a well-known fact",
    "it is an undeniable fact that",
    "it is an undeniable fact",
    "it is a proven fact that",
    "it is a proven fact",
    "it is an established fact that",
    "it is an established fact",
    "it is a scientific fact that",
    "it is a scientific fact",
    "research has shown that",
    "research has shown",
    "studies have shown that",
    "studies have shown",
    "studies show that",
    "studies show",
    "research shows that",
    "research shows",
    "according to research",
    "according to studies",
    "according to studies",
    "according to experts",
    "according to experts",
    "experts say that",
    "experts say",
    "experts agree that",
    "experts agree",
    "scholars have argued that",
    "scholars have argued",
    "scholars argue that",
    "scholars argue",
    "scholars suggest that",
    "scholars suggest",
    "researchers have found that",
    "researchers have found",
    "researchers found that",
    "researchers found",
    "researchers suggest that",
    "researchers suggest",
    "studies indicate that",
    "studies indicate",
    "research indicates that",
    "research indicates",
    "data shows that",
    "data shows",
    "data indicates that",
    "data indicates",
    "statistics show that",
    "statistics show",
    "statistics indicate that",
    "statistics indicate",
    "evidence shows that",
    "evidence shows",
    "evidence indicates that",
    "evidence indicates",
    "the data suggests that",
    "the data suggests",
    "the evidence suggests that",
    "the evidence suggests",
    "the findings suggest that",
    "the findings suggest",
    "the results suggest that",
    "the results suggest",
    "the results indicate that",
    "the results indicate",
    "the data indicates that",
    "the data indicates",
    "analysis shows that",
    "analysis shows",
    "analysis indicates that",
    "analysis indicates",
    "research suggests that",
    "research suggests",
    "studies suggest that",
    "studies suggest",
    "the study found that",
    "the study found",
    "the study suggests that",
    "the study suggests",
    "the research suggests that",
    "the research suggests",
    "previous research has shown that",
    "previous research has shown",
    "previous research suggests that",
    "previous research suggests",
    "previous studies have shown that",
    "previous studies have shown",
    "previous studies suggest that",
    "previous studies suggest",
    "recent research has shown that",
    "recent research has shown",
    "recent research suggests that",
    "recent research suggests",
    "recent studies have shown that",
    "recent studies have shown",
    "recent studies suggest that",
    "recent studies suggest",
    "recent findings suggest that",
    "recent findings suggest",
    "recent findings show that",
    "recent findings show",
    "recent data shows that",
    "recent data shows",
    "recent data indicates that",
    "recent data indicates",
    "it has been shown that",
    "it has been shown",
    "it has been demonstrated that",
    "it has been demonstrated",
    "it has been established that",
    "it has been established",
    "it has been proven that",
    "it has been proven",
    "it is well established that",
    "it is well established",
    "it is well documented that",
    "it is well documented",
    "it is well known that",
    "it is well known",
    "it is commonly known that",
    "it is commonly known",
    "it is generally accepted that",
    "it is generally accepted",
    "it is widely accepted that",
    "it is widely accepted",
    "it is widely recognized that",
    "it is widely recognized",
    "it is widely acknowledged that",
    "it is widely acknowledged",
    "it is widely understood that",
    "it is widely understood",
    "it is generally understood that",
    "it is generally understood",
    "it is commonly understood that",
    "it is commonly understood",
    "it is commonly accepted that",
    "it is commonly accepted",
    "it is commonly acknowledged that",
    "it is commonly acknowledged",
    "it is commonly recognized that",
    "it is commonly recognized",
    "it is universally accepted that",
    "it is universally accepted",
    "it is universally recognized that",
    "it is universally recognized",
    "it is universally acknowledged that",
    "it is universally acknowledged",
    "it is universally understood that",
    "it is universally understood"
  ];

  function checkOriginality(text) {
    if (!text || !text.trim()) return { score: 0, paragraphs: [] };

    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    if (paragraphs.length === 0) return { score: 0, paragraphs: [] };

    const results = [];
    let totalScore = 0;

    for (const para of paragraphs) {
      const lower = para.toLowerCase();
      let penalty = 0;
      const reasons = [];

      // Check for filler phrases
      for (const phrase of FILLER_PHRASES) {
        if (lower.includes(phrase.toLowerCase())) {
          penalty += 15;
          if (!reasons.includes(`Formulaic phrase: "${phrase}"`)) {
            reasons.push(`Formulaic phrase: "${phrase}"`);
          }
        }
      }

      // Check for repeated phrases within the paragraph (3+ word repetitions)
      const words = lower.replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
      const wordCounts = {};
      for (const w of words) {
        wordCounts[w] = (wordCounts[w] || 0) + 1;
      }
      for (const [w, count] of Object.entries(wordCounts)) {
        if (count >= 3) {
          penalty += 10 * (count - 2);
          if (!reasons.includes(`Repeated word: "${w}" (${count}x)`)) {
            reasons.push(`Repeated word: "${w}" (${count}x)`);
          }
        }
      }

      // Check sentence length consistency (AI tends to use similar-length sentences)
      const sentences = para.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
      if (sentences.length > 2) {
        const lengths = sentences.map(s => s.split(/\s+/).length);
        const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        const variance = lengths.reduce((a, b) => a + Math.pow(b - avgLen, 2), 0) / lengths.length;
        if (variance < 25 && avgLen > 8) {
          penalty += 20;
          if (!reasons.includes("Uniform sentence length (AI-like pacing)")) {
            reasons.push("Uniform sentence length (AI-like pacing)");
          }
        }
      }

      const paraScore = Math.max(0, 100 - penalty);
      totalScore += paraScore;

      results.push({
        paragraph: para.length > 100 ? para.slice(0, 100) + "..." : para,
        fullParagraph: para,
        score: paraScore,
        reasons: reasons
      });
    }

    const overallScore = Math.round(totalScore / paragraphs.length);
    return { score: overallScore, paragraphs: results };
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

  // ---- Originality check handler ----
  els.origRunBtn.addEventListener("click", () => {
    const draftText = els.draft ? els.draft.value : "";
    if (!draftText.trim()) {
      els.origStatus.textContent = "Add text first";
      els.origStatus.className = "orig-status";
      els.origSummary.classList.add("hidden");
      els.origList.innerHTML = "";
      return;
    }

    const result = checkOriginality(draftText);
    els.origScore.textContent = `${result.score}%`;
    els.origCopy.textContent = `${result.paragraphs.length} paragraph(s) checked`;
    els.origSummary.classList.remove("hidden");
    els.origList.innerHTML = "";

    const stateEl = els.origStatus;
    if (result.score >= 80) {
      stateEl.textContent = "Likely human-written";
      stateEl.className = "orig-status good";
    } else if (result.score >= 50) {
      stateEl.textContent = "Mixed signals — review flagged paragraphs";
      stateEl.className = "orig-status warn";
    } else {
      stateEl.textContent = "Likely AI-generated or formulaic";
      stateEl.className = "orig-status bad";
    }

    for (const item of result.paragraphs) {
      const li = document.createElement("li");
      const preview = document.createElement("span");
      preview.textContent = item.paragraph;
      preview.style.display = "block";
      preview.style.fontWeight = "600";
      preview.style.color = "#101828";

      const reasonBox = document.createElement("div");
      reasonBox.style.marginTop = "4px";
      reasonBox.style.fontSize = "10.5px";
      reasonBox.style.color = item.reasons.length ? "#b42318" : "#027a48";
      if (item.reasons.length === 0) {
        reasonBox.textContent = "No flags";
      } else {
        reasonBox.textContent = item.reasons.join(" · ");
      }
      li.appendChild(preview);
      li.appendChild(reasonBox);
      els.origList.appendChild(li);
    }
  });
})();
