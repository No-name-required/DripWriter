/* Originality / plagiarism screening area.
   Local heuristic check + one-click cross-reference with external humanizer
   services. Loaded separately; popup.js and content.js are not modified. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const card = $("origCard");
  if (!card) return;

  const draft = $("draft");
  const runBtn = $("origRunBtn");
  const stateEl = $("origState");
  const summary = $("origSummary");
  const scoreEl = $("origScore");
  const copyEl = $("origCopy");
  const list = $("origList");
  const siteButtons = [...card.querySelectorAll("[data-site]")];

  const SITES = {
    humanize: "https://www.humanizeai.pro/",
    clever: "https://cleverhumanizer.ai/",
    grammarly: "https://www.grammarly.com/"
  };

  // Common clichés / formulaic phrases typical of unoriginal or AI-written prose.
  const CLICHES = [
    "in conclusion", "in today's fast-paced world", "it is important to note",
    "it is worth noting", "delve into", "tapestry", "testament to",
    "in the ever-evolving", "when it comes to", "at the end of the day",
    "needless to say", "that being said", "with that in mind", "moreover",
    "furthermore", "additionally", "not only but also", "a wide range of",
    "a myriad of", "plethora of", "utilize", "leverage", "seamless",
    "robust", "cutting-edge", "game-changer", "paradigm shift",
    "on the other hand", "in summary", "overall, it is clear",
    "this essay will", "i will discuss", "first and foremost",
    "last but not least", "as a matter of fact", "the fact of the matter is",
    "in this day and age", "the bottom line is", "keep in mind that",
    "it goes without saying", "as previously mentioned", "as stated above"
  ];

  let results = [];
  let selectedIndex = -1;

  function setState(text, kind) {
    stateEl.textContent = text;
    stateEl.className = "orig-state" + (kind ? " " + kind : "");
  }

  function sentences(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function ngrams(words, n) {
    const out = [];
    for (let i = 0; i <= words.length - n; i++) out.push(words.slice(i, i + n).join(" ").toLowerCase());
    return out;
  }

  function check(text) {
    const parts = sentences(text);
    const allGrams = new Map();
    parts.forEach((s, i) => {
      const words = s.replace(/[^A-Za-z0-9'\s]/g, "").split(/\s+/).filter(Boolean);
      ngrams(words, 4).forEach((g) => {
        if (!allGrams.has(g)) allGrams.set(g, new Set());
        allGrams.get(g).add(i);
      });
    });

    return parts.map((sentence, i) => {
      const lower = sentence.toLowerCase();
      const reasons = [];
      const hits = CLICHES.filter((p) => lower.includes(p));
      if (hits.length) reasons.push(`Formulaic phrasing: ${hits.slice(0, 3).join(", ")}`);

      const words = sentence.replace(/[^A-Za-z0-9'\s]/g, "").split(/\s+/).filter(Boolean);
      const shared = ngrams(words, 4).filter((g) => (allGrams.get(g)?.size || 0) > 1);
      if (shared.length) reasons.push(`Repeated wording elsewhere in your draft: "${shared[0]}"`);
      if (words.length && words.length < 5) reasons.push("Very short fragment — hard to verify");

      let score = 100 - hits.length * 18 - shared.length * 12;
      if (words.length < 5) score -= 15;
      score = Math.max(0, Math.min(100, score));

      return { sentence, score, reasons };
    });
  }

  function render() {
    if (!results.length) {
      summary.classList.add("hidden");
      list.innerHTML = "";
      setState("No draft", "");
      siteButtons.forEach((b) => (b.disabled = true));
      return;
    }

    summary.classList.remove("hidden");
    const avg = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
    const flagged = results.filter((r) => r.reasons.length).length;
    scoreEl.textContent = `${avg}%`;
    copyEl.textContent = `${results.length} sentences checked · ${flagged} need a closer look. Local score only — use the buttons below to cross-reference.`;
    setState(avg >= 80 ? "Looks original" : avg >= 60 ? "Review advised" : "High risk", avg >= 80 ? "good" : avg >= 60 ? "warn" : "bad");

    list.innerHTML = "";
    results.forEach((r, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "orig-item" + (r.reasons.length ? "" : " clean") + (i === selectedIndex ? " is-selected" : "");
      const text = document.createElement("span");
      text.textContent = r.sentence;
      const why = document.createElement("span");
      why.className = "orig-why";
      why.textContent = r.reasons.length ? r.reasons.join(" · ") : "No common patterns detected";
      btn.append(text, why);
      btn.addEventListener("click", () => {
        selectedIndex = i;
        [...list.children].forEach((el, n) => el.classList.toggle("is-selected", n === i));
        siteButtons.forEach((b) => (b.disabled = false));
      });
      list.appendChild(btn);
    });

    siteButtons.forEach((b) => (b.disabled = selectedIndex < 0));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  runBtn.addEventListener("click", () => {
    const text = draft ? draft.value : "";
    if (!text.trim()) { setState("Add text first", ""); return; }
    results = check(text);
    selectedIndex = -1;
    render();
  });

  siteButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (selectedIndex < 0 || !results[selectedIndex]) return;
      const sentence = results[selectedIndex].sentence;
      const copied = await copyText(sentence);
      const url = SITES[button.dataset.site];
      setState(copied ? "Sentence copied — paste it there" : "Open the site and paste the sentence", copied ? "good" : "warn");
      window.open(url, "_blank", "noopener,noreferrer");
    });
  });

  setState("Ready", "");
})();
