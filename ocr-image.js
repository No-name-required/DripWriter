/* Prepares a real phone photo for OCR: converts unsupported formats (e.g. HEIC),
   downscales huge images so recognition finishes quickly, and exports a clean
   JPEG. Exposed as window.DripImage.prepare(file). */
(() => {
  "use strict";

  async function prepare(file) {
    if (!file || !file.type || file.type.indexOf("image/") !== 0) {
      throw new Error("That file is not an image.");
    }

    let bitmap = null;
    try {
      if (typeof createImageBitmap === "function") {
        bitmap = await createImageBitmap(file);
      }
    } catch { /* fall back to an <img> below */ }

    if (!bitmap) {
      try {
        const url = URL.createObjectURL(file);
        bitmap = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("This photo format can't be read. Try a JPG or PNG."));
          img.src = url;
        });
        URL.revokeObjectURL(url);
      } catch (error) {
        throw new Error("This photo format can't be read. Try saving it as JPG or PNG first.");
      }
    }

    try {
      const width = bitmap.width || bitmap.naturalWidth;
      const height = bitmap.height || bitmap.naturalHeight;
      if (!width || !height) throw new Error("The image appears to be empty.");

      const maxSide = 2000;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
  }

  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  window.DripImage = { prepare, withTimeout };
})();
