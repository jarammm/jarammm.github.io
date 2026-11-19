// Page wiring: grid rendering, input handling, and the glue between
// ControllerState (what should sound), StemEngine (sound) and BridgeClient (show bridge).
//
// URL parameters:
//   ?stems=<url of stems.json>   load stems from a server instead of picking files
//   ?bridge=<ws url>             report state and audio features to the show bridge

import { ControllerState, MODES, PAD_KEYS, gridSize } from "./state.js";
import { StemEngine } from "./engine.js";
import { renderDemo } from "./demo.js";
import { loadFromFiles, loadFromUrl } from "./loader.js";
import { BridgeClient } from "./bridge.js";

const FEATURE_INTERVAL_MS = 33; // ~30 Hz to the bridge
const PAD_KEY_CODES = PAD_KEYS.map((k) => (/\d/.test(k) ? `Digit${k}` : `Key${k}`));

const $ = (id) => document.getElementById(id);
const ui = {
  title: $("song-title"), audio: $("audio-status"), bridge: $("bridge-status"),
  demo: $("load-demo"), folder: $("load-folder"), files: $("load-files"),
  quantize: $("quantize"), clear: $("clear"), start: $("start"), stop: $("stop"),
  grid: $("grid"), wrap: document.querySelector(".grid-wrap"), hint: $("drop-hint"),
  audible: $("audible-list"), position: $("position"), meter: $("meter"), warnings: $("warnings"),
};

const engine = new StemEngine();
let manifest = null;
let state = null;
let pads = new Map();          // id -> button
let pendingTimer = null;
let lastFeatures = null;

const params = new URLSearchParams(location.search);
const bridge = params.get("bridge")
  ? new BridgeClient(params.get("bridge"), (s, detail) => setChip(ui.bridge, "bridge", s, detail))
  : null;

function setChip(el, name, s, detail) {
  el.dataset.state = s;
  el.textContent = `${name}: ${s}`;
  el.title = detail ?? "";
}

function showWarnings(list) {
  ui.warnings.replaceChildren(...list.map((w) => Object.assign(document.createElement("li"), { textContent: w })));
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

// ---------- loading ----------

async function load(loader) {
  setChip(ui.audio, "audio", "loading");
  try {
    engine.stop(0.05);
    const { manifest: m, stems, warnings = [] } = await loader(engine.context());
    manifest = m;
    const alignWarnings = engine.setStems(stems);
    state = new ControllerState(stems.map((s) => s.id), currentMode());
    renderGrid(stems);
    ui.title.textContent = m.title;
    ui.quantize.disabled = !m.bpm;
    if (!m.bpm) ui.quantize.value = "off";
    ui.start.disabled = false;
    ui.stop.disabled = true;
    ui.hint.hidden = true;
    showWarnings([...warnings, ...alignWarnings]);
    setChip(ui.audio, "audio", "ready");
    apply();
  } catch (e) {
    console.error(e);
    setChip(ui.audio, "audio", "error", e.message);
    showWarnings([e.message]);
  }
}

// ---------- grid ----------

function renderGrid(stems) {
  const n = gridSize(stems.length);
  ui.grid.style.setProperty("--n", n);
  pads = new Map();
  const cells = [];
  for (let i = 0; i < n * n; i++) {
    const s = stems[i];
    const b = document.createElement("button");
    b.type = "button";
    if (!s) {
      b.className = "pad empty";
      b.tabIndex = -1;
      b.setAttribute("aria-hidden", "true");
    } else {
      b.className = "pad";
      b.style.setProperty("--c", s.color);
      b.dataset.id = s.id;
      const key = PAD_KEYS[i];
      b.innerHTML = `<span class="key"></span><span class="label"></span>`;
      b.querySelector(".label").textContent = s.label;
      b.querySelector(".key").textContent = key ?? "";
      if (key) b.setAttribute("aria-keyshortcuts", key);
      b.addEventListener("click", () => toggle(s.id));
      pads.set(s.id, b);
    }
    cells.push(b);
  }
  ui.grid.replaceChildren(...cells);
}

function toggle(id) {
  if (!state) return;
  state.toggle(id);
  apply();
}

// ---------- applying state ----------

function quantStep() {
  if (!manifest?.bpm || ui.quantize.value === "off") return null;
  const beat = 60 / manifest.bpm;
  return ui.quantize.value === "bar" ? beat * manifest.beats_per_bar : beat;
}

function sectionAt(t) {
  if (t === null || !manifest) return null;
  return manifest.sections.find((s) => t >= s.start && t < s.end)?.name ?? null;
}

/** Push the current state to audio, pads and bridge. */
function apply() {
  const audible = new Set(state.audible());
  const when = engine.running ? engine.nextBoundary(quantStep()) : engine.context().currentTime;
  engine.applyAudible(audible, when);

  const delay = Math.max(0, when - engine.context().currentTime);
  clearTimeout(pendingTimer);
  for (const [id, b] of pads) {
    b.classList.toggle("selected", state.selected.has(id));
    b.setAttribute("aria-pressed", String(state.selected.has(id)));
    b.classList.toggle("pending", delay > 0.02 && b.classList.contains("audible") !== audible.has(id));
  }
  // Light the pads when the sound actually changes, not when the key is pressed.
  pendingTimer = setTimeout(() => {
    for (const [id, b] of pads) {
      b.classList.toggle("audible", audible.has(id));
      b.classList.remove("pending");
    }
  }, delay * 1000);

  const labels = manifest.stems.filter((s) => audible.has(s.id)).map((s) => s.label);
  ui.audible.textContent = labels.length ? labels.join(", ") : "(silence)";

  const ph = engine.playhead();
  bridge?.sendState({
    song: manifest.title,
    stems: state.stemIds,
    ...state.snapshot(),
    playhead_sec: ph,
    section: sectionAt(ph),
    apply_in_sec: delay,
    ts: Date.now() / 1000,
  });
}

// ---------- transport ----------

async function start() {
  await engine.start(new Set(state.audible()));
  ui.start.disabled = true;
  ui.stop.disabled = false;
  setChip(ui.audio, "audio", "running");
  apply();
}

function stop() {
  engine.stop();
  ui.start.disabled = false;
  ui.stop.disabled = true;
  setChip(ui.audio, "audio", "ready");
}

// ---------- readout and feature stream ----------

const bars = Array.from({ length: 8 }, () => document.createElement("i"));
ui.meter.replaceChildren(...bars);

function fmt(t) {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
}

function frame() {
  const ph = engine.playhead();
  if (ph !== null) {
    const sec = sectionAt(ph);
    ui.position.textContent = `${fmt(ph)} / ${fmt(engine.loopDur)}${sec ? `  ·  section ${sec}` : ""}`;
  } else {
    ui.position.textContent = "—";
  }
  if (lastFeatures) {
    lastFeatures.bands.forEach((v, i) => { bars[i].style.height = `${Math.max(2, v * 100)}%`; });
    for (const b of pads.values()) b.style.setProperty("--level", Math.min(1, lastFeatures.rms * 3).toFixed(3));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

setInterval(() => {
  if (!engine.running) return;
  lastFeatures = engine.features();
  const ph = engine.playhead();
  bridge?.sendFeatures({ ...lastFeatures, playhead_sec: ph, section: sectionAt(ph), ts: Date.now() / 1000 });
}, FEATURE_INTERVAL_MS);

// ---------- inputs ----------

ui.demo.addEventListener("click", () => load(async (ctx) => renderDemo(ctx)));
for (const input of [ui.folder, ui.files]) {
  input.addEventListener("change", () => {
    if (input.files.length) load((ctx) => loadFromFiles(ctx, input.files));
    input.value = "";
  });
}

ui.wrap.addEventListener("dragover", (e) => { e.preventDefault(); ui.wrap.classList.add("dragover"); });
ui.wrap.addEventListener("dragleave", () => ui.wrap.classList.remove("dragover"));
ui.wrap.addEventListener("drop", async (e) => {
  e.preventDefault();
  ui.wrap.classList.remove("dragover");
  const files = await droppedFiles(e.dataTransfer);
  if (files.length) load((ctx) => loadFromFiles(ctx, files));
});

/** Flatten dropped files and folders (one level of folders is enough for a stems folder). */
async function droppedFiles(dt) {
  const entries = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((en) => en.isDirectory)) return [...dt.files];
  const out = [];
  const readFile = (en) => new Promise((res, rej) => en.file(res, rej));
  const readDir = (en) => new Promise((res, rej) => {
    const reader = en.createReader();
    const all = [];
    const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : res(all)), rej);
    next();
  });
  for (const en of entries) {
    if (en.isFile) out.push(await readFile(en));
    else for (const child of await readDir(en)) if (child.isFile) out.push(await readFile(child));
  }
  return out;
}

document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
  if (!state) return;
  state.setMode(currentMode());
  apply();
}));
ui.clear.addEventListener("click", () => { if (state) { state.clear(); apply(); } });
ui.start.addEventListener("click", start);
ui.stop.addEventListener("click", stop);

document.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || !state) return;
  if (e.target.closest("input, select, textarea")) return;
  // Match physical keys (e.code) so shortcuts still work with a Korean IME active.
  const i = PAD_KEY_CODES.indexOf(e.code);
  if (i >= 0 && i < state.stemIds.length) {
    e.preventDefault();
    toggle(state.stemIds[i]);
  }
});

if (params.get("stems")) load((ctx) => loadFromUrl(ctx, params.get("stems")));

// Read-only handle for the browser console and automated checks.
window.stageGenerator = {
  engine,
  get state() { return state; },
  get manifest() { return manifest; },
  gains: () => Object.fromEntries(engine.stems.map((s) => [s.id, s.gain.gain.value])),
};
