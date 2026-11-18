/* DripWriter Mobile Bridge (new file; content.js and popup.js are untouched).
   Runs on an extension page on the laptop. Relays DW_* commands from the phone
   to the active tab, where the unchanged content.js insertion engine handles
   them, and relays status messages back to the phone. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const codeEl = $("code");
  const serverEl = $("server");
  const connectBtn = $("connectBtn");
  const logEl = $("log");
  const dot = $("dot");
  const tabLine = $("tabLine");

  const CODE_KEY = "dwBridgeCode";
  const SERVER_KEY = "dwBridgeServer";

  let socket = null;
  let manualClose = false;
  let reconnectTimer = null;

  function log(message) {
    const row = document.createElement("div");
    row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setConnected(on) {
    dot.classList.toggle("on", on);
    connectBtn.textContent = on ? "Disconnect" : "Connect";
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabLine) tabLine.textContent = tabs[0]?.title || "No active tab";
    return tabs[0] || null;
  }

  async function ensureContentScript(tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "DW_PING" });
      if (res?.ok) return true;
    } catch { /* inject below */ }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const res = await chrome.tabs.sendMessage(tabId, { type: "DW_PING" });
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  async function sendToTab(message) {
    const tab = await getActiveTab();
    if (!tab?.id) return { ok: false, error: "No active tab found." };

    if (message.type === "DW_START" || message.type === "DW_PING") {
      const ready = await ensureContentScript(tab.id);
      if (!ready) {
        return { ok: false, error: "Open a Google Doc or text field in this browser, then try again." };
      }
    }
    try {
      const response = await chrome.tabs.sendMessage(tab.id, message);
      return response || { ok: false, error: "No response from the page." };
    } catch (error) {
      return { ok: false, error: error?.message || "Could not reach the page." };
    }
  }

  function reply(message) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!socket && !manualClose) {
        log("Reconnecting…");
        doConnect();
      }
    }, 5000);
  }

  function disconnect(manual) {
    manualClose = Boolean(manual);
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
    socket = null;
    setConnected(false);
    log("Disconnected");
  }

  function doConnect() {
    const code = codeEl.value.trim().toUpperCase();
    const base = serverEl.value.trim().replace(/\/$/, "");
    if (!code) { log("Enter a pairing code first."); return; }
    codeEl.value = code;
    manualClose = false;
    clearTimeout(reconnectTimer);

    let url;
    try { url = new URL(`${base}/ws?code=${encodeURIComponent(code)}&role=bridge`); }
    catch { log("Invalid relay address."); return; }
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol === "http:") url.protocol = "ws:";

    try { socket = new WebSocket(url.href); }
    catch (error) { log(`Could not connect: ${error.message}`); return; }

    try {
      chrome.storage.local.set({ [CODE_KEY]: code, [SERVER_KEY]: base }).catch(() => {});
    } catch { /* storage optional */ }

    socket.onopen = () => {
      setConnected(true);
      log(`Connected to ${code}`);
      void getActiveTab();
    };

    socket.onclose = () => {
      setConnected(false);
      log("Relay connection closed");
      socket = null;
      if (!manualClose) scheduleReconnect();
    };

    socket.onerror = () => log("Relay error — is the relay server running?");

    socket.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      if (message.type === "DW_WELCOME" || message.type === "DW_PRESENCE") {
        log(message.pwa ? "Phone is paired and ready" : "Waiting for the phone to connect");
        return;
      }
      if (!message.type || !message.type.startsWith("DW_")) return;
      if (message.type === "DW_STATUS" || message.type === "DW_REPLY") return;

      log(`Received ${message.type}`);
      const result = await sendToTab(message);
      reply({
        type: "DW_REPLY",
        requestId: message.requestId,
        ok: result.ok !== false,
        status: result.status,
        error: result.error
      });
      if (result.status) reply({ type: "DW_STATUS", status: result.status });
    };
  }

  connectBtn.addEventListener("click", () => {
    if (socket) disconnect(true);
    else doConnect();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "DW_STATUS" && socket && socket.readyState === 1) {
      reply({ type: "DW_STATUS", status: message.status });
    }
  });

  // Restore saved settings (or values passed by the popup) and auto-connect.
  (async function init() {
    const params = new URLSearchParams(location.search);
    let saved = {};
    try { saved = await chrome.storage.local.get([CODE_KEY, SERVER_KEY]); } catch { /* optional */ }
    const code = params.get("code") || saved[CODE_KEY] || "";
    const server = params.get("server") || saved[SERVER_KEY] || "ws://localhost:8787";
    if (code) codeEl.value = code.toUpperCase();
    if (server) serverEl.value = server;
    if (code) {
      log("Auto-connecting with saved pairing…");
      doConnect();
    }
  })();
})();
