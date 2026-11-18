# DripWriter

Human-paced typing for Google Docs and any text field — now with a phone companion and a phone-only mode.

This repository contains the completed browser extension plus the two mobile options that were built on top of it.

## What's in this repository

| Path | Description |
|---|---|
| `content.js`, `popup.html`, `popup.js`, `popup.css`, `manifest.json`, `icons/` | The original Manifest V3 browser extension. Load it unpacked via `chrome://extensions` → Developer mode → Load unpacked. |
| `ocr/`, `ocr.js`, `ocr.css` | Offline photo-to-sentences feature in the extension popup. Uses a locally bundled Tesseract.js — no network. |
| `bridge/` | Small endpoint page (`bridge/bridge.html`) that lets the phone PWA forward commands to the extension's unchanged `content.js`. Not part of the popup UI. |
| `pwa/` | Standalone installable PWA that connects to the extension on your computer through a local relay. See `pwa/README.md`. |
| `phone only DW/` | A completely standalone PWA that types into Google Docs directly through the Docs API — no computer, relay or bridge. See `phone only DW/README.md`. |

## Quick start — browser extension

1. Download this repository.
2. In Chrome/Edge, open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Open a Google Doc (or any text field), place the cursor, open the DripWriter popup, write or scan text, and press **Start typing**.

## Features

- Human-paced typing with WPM range, speed variance, occasional typos and auto-fixes.
- Optional target duration.
- Live preview, progress and activity log.
- **Photo to sentences**: upload a photo of printed text; OCR runs entirely on the device and the result is split into clean sentences.
- Offline — nothing is sent to a cloud service for OCR.
- Dark/light mode toggle in the popup and both PWAs; the choice is remembered locally.

## Mobile

- **`pwa/`** keeps the original `content.js` insertion engine (real keystrokes) but needs the computer running the relay.
- **`phone only DW/`** runs entirely on the phone and writes through the Google Docs API; it needs a Google OAuth Client ID (see its README).

## Notes

`node_modules/` is intentionally not committed. To run the relay: `cd pwa/relay && npm install && node server.js`.
