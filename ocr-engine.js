/* Robust offline OCR engine helper shared by the extension and both PWAs.
   Handles missing/renamed language data, missing image helper, and retries. */
(() => {
  "use strict";

  const STATE = { worker: null, config: null, busy: false };

  function baseUrl() {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL("ocr/");
    }
    return new URL("ocr/", document.baseURI).href;
  }

  async function pickLang(base) {
    // Some builds ship the language data plain (eng.traineddata) instead of
    // gzipped. Probe both so OCR works either way.
    for (const [file, gzip] of [["eng.traineddata.gz", true], ["eng.traineddata", false]]) {
      try {
        const res = await fetch(base + "lang/" + file, { method: "HEAD" });
        if (res.ok) return { langPath: base + "lang", gzip };
      } catch { /* try the next candidate */ }
    }
    return { langPath: base + "lang", gzip: true };
  }

  function makeWorker(config, onProgress) {
    if (typeof Tesseract === "undefined") {
      return Promise.reject(new Error("OCR engine did not load. Reload the page."));
    }
    return Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
      workerPath: config.base + "worker.min.js",
      corePath: config.base + "core",
      langPath: config.langPath,
      workerBlobURL: false,
      gzip: config.gzip,
      logger: (m) => {
        if (!onProgress) return;
        if (m.status === "recognizing text") {
          onProgress(Math.round((m.progress || 0) * 100));
        }
      }
    });
  }

  async function getWorker(onProgress) {
    if (STATE.worker) return STATE.worker;
    if (STATE.busy) {
      // Wait briefly for the in-flight creation to finish.
      for (let i = 0; i < 40 && !STATE.worker && STATE.busy; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (STATE.worker) return STATE.worker;
    }
    STATE.busy = true;
    try {
      const base = baseUrl();
      const lang = await pickLang(base);
      const config = { base, ...lang };
      STATE.config = config;
      STATE.worker = await makeWorker(config, onProgress);
      return STATE.worker;
    } catch (error) {
      STATE.worker = null;
      throw error;
    } finally {
      STATE.busy = false;
    }
  }

  async function prepare(file) {
    if (!file) throw new Error("No image selected.");
    // Prefer the dedicated helper, but fall back to passing the file straight
    // to Tesseract if it is not available for any reason.
    if (typeof DripImage !== "undefined" && DripImage.prepare) {
      try {
        const prepared = await DripImage.prepare(file);
        if (prepared) return prepared;
      } catch { /* fall through to the raw file */ }
    }
    return file;
  }

  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  async function recognize(file, onProgress) {
    const prepared = await prepare(file);
    let worker;
    try {
      worker = await getWorker(onProgress);
      let result = await withTimeout(
        worker.recognize(prepared),
        90000,
        "Reading took too long. Try a smaller, well-lit photo."
      );
      return (result && result.data && result.data.text) || "";
    } catch (error) {
      // A stale or half-initialised worker is the most common cause. Reset and
      // try once more with the original file.
      STATE.worker = null;
      try {
        worker = await getWorker(onProgress);
        const result = await withTimeout(
          worker.recognize(file),
          90000,
          "Reading took too long. Try a smaller, well-lit photo."
        );
        return (result && result.data && result.data.text) || "";
      } catch (retryError) {
        const detail = retryError && retryError.message ? retryError.message : String(retryError);
        throw new Error(detail);
      }
    }
  }

  function reset() {
    STATE.worker = null;
    STATE.config = null;
  }

  window.DripOCR = { baseUrl, getWorker, prepare, withTimeout, recognize, reset };
})();
