# DripWriter Mobile (standalone PWA)

A **separate, installable PWA** for your phone. It is not part of the extension popup. It handles the draft, settings and offline photo-to-sentences OCR, then connects to a small bridge endpoint in the extension so the **unchanged `content.js`** typing engine can insert text into a Google Doc.

## Why a separate bridge is needed

A PWA cannot inject scripts into, or dispatch input events on, `docs.google.com` — that is a browser security boundary. The insertion methods in `content.js` (verified `InputEvent`/`KeyboardEvent` + insert) therefore run in the browser tab where the Doc is open. The phone sends commands; the extension bridge forwards them to that tab. Nothing was added to the extension popup UI.

## Setup

1. **Start the relay on the laptop** (the computer with the extension and the Google Doc):

   ```bash
   node pwa/relay/server.js
   ```

   It serves the PWA and the WebSocket pairing relay on port `8787` (`PORT=...` to change).

2. **Open the bridge endpoint** in that browser, with the Google Doc open in another tab:

   - Find your extension ID at `chrome://extensions` (Developer mode → ID).
   - Open `chrome-extension://<extension-id>/bridge/bridge.html`.
   - Enter a pairing code (e.g. `DW-4821`) and keep relay address `ws://localhost:8787`.
   - You can also pass both in the URL: `.../bridge/bridge.html?code=DW-4821&server=ws://localhost:8787` — it auto-connects and remembers them for next time.
   - Keep this tab open. Leave the Google Doc open with the cursor in place.

3. **On your phone**, on the same Wi‑Fi:

   - Open `http://<laptop-LAN-IP>:8787` (this is the PWA).
   - Enter the **same pairing code** and tap **Connect**.
   - Write/paste a draft or use **Upload photo** to scan printed text into sentences, then tap **Start typing**.

## Optional: installable PWA over HTTPS

Browsers only offer "Install app" on HTTPS (or localhost). To install on a phone, expose the relay over an HTTPS tunnel, e.g. `npx localtunnel --port 8787`. Open the HTTPS URL on the phone and set **Relay URL** to the matching `wss://` URL. On the bridge page set **Relay address** to the same `wss://` URL. The code works unchanged.

## What is reused vs. new

- Reused unchanged: `content.js`, `popup.js`, `popup.css`, `manifest.json`, `ocr/`, and the popup's photo-to-sentences feature.
- New connector only (not popup UI): `bridge/bridge.html`, `bridge/bridge.js` — forwards `DW_*` messages to the active tab via `chrome.tabs.sendMessage` and relays `DW_STATUS` back. Auto-connects with saved pairing.
- New standalone app: everything in `pwa/` — installable shell, service worker, offline OCR, pairing UI, and `pwa/relay/server.js`.
