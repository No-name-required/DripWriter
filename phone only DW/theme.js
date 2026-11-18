/* DripWriter theme toggle. Adds a button to the header and stores the choice
   locally. Works in extension pages (chrome.storage) and PWAs (localStorage). */
(() => {
  "use strict";

  const KEY = "dwTheme";
  const root = document.documentElement;

  function getSaved() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local?.get) {
          chrome.storage.local.get([KEY], (result) => resolve(result?.[KEY] || "light"));
          return;
        }
      } catch { /* fall through */ }
      try { resolve(localStorage.getItem(KEY) || "light"); }
      catch { resolve("light"); }
    });
  }

  function save(value) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local?.set) {
        chrome.storage.local.set({ [KEY]: value });
        return;
      }
    } catch { /* fall through */ }
    try { localStorage.setItem(KEY, value); } catch { /* ignore */ }
  }

  function apply(theme) {
    const dark = theme === "dark";
    root.setAttribute("data-theme", dark ? "dark" : "light");
    const button = document.getElementById("themeToggle");
    if (button) {
      button.textContent = dark ? "\u2600" : "\u263E";
      button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      button.title = dark ? "Light mode" : "Dark mode";
    }
  }

  function init() {
    if (document.getElementById("themeToggle")) return;
    const host = document.querySelector(".brand") || document.querySelector("header") || document.body;
    const button = document.createElement("button");
    button.id = "themeToggle";
    button.className = "theme-toggle";
    button.type = "button";
    host.appendChild(button);
    button.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      save(next);
    });
    getSaved().then(apply);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
