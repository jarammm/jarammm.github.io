// Page wiring: grid rendering, input handling, and the glue between
// ControllerState (what should sound), StemEngine (sound) and BridgeClient (show bridge).
//
// URL parameters:
//   ?songs=<url of songs.json>   song list for the picker (default: audio/songs.json next to the page, if present)
//   ?stems=<url of stems.json>   load one song from a server instead of picking files
//   ?bridge=<ws url>             report state and audio features to the show bridge

import { ControllerState, MODES, POOLS, PAD_KEYS, gridSize, inPool } from "./state.js";
import { StemEngine } from "./engine.js";
import { renderDemo } from "./demo.js";
import { loadFromFiles, loadFromUrl } from "./loader.js";
import { BridgeClient } from "./bridge.js";
import { exportRange, mixGains, fitGain, encodeWav16, exportFileName } from "./export.js";

const FEATURE_INTERVAL_MS = 33; // ~30 Hz to the bridge
const PAD_KEY_CODES = PAD_KEYS.map((k) => (/\d/.test(k) ? `Digit${k}` : `Key${k}`));
const SILENT_DB = -60;          // a stem quieter than this (vs the mix) is labelled silent
const POOL_LABEL = { mix: "Mix", accompaniment: "Accompaniment", vocals: "Vocals" };
const baseId = (pool) => `base:${pool}`;

const $ = (id) => document.getElementById(id);
const ui = {
  title: $("song-title"), credit: $("credit"), audio: $("audio-status"), bridge: $("bridge-status"),
  songPicker: $("song-picker"), songSelect: $("song-select"),
  demo: $("load-demo"), folder: $("load-folder"), files: $("load-files"),
  subtractHint: $("subtract-hint"),
  quantize: $("quantize"), clear: $("clear"), start: $("start"), stop: $("stop"), export: $("export"),
  exportInfo: $("export-info"),
  grid: $("grid"), wrap: document.querySelector(".grid-wrap"), hint: $("drop-hint"),
  audible: $("audible-list"), position: $("position"), meter: $("meter"), warnings: $("warnings"),
};
const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];

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

const checked = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
const setChecked = (name, value) => radios(name).forEach((r) => { r.checked = r.value === value; });

// ---------- loading ----------

async function load(loader) {
  setChip(ui.audio, "audio", "loading");
  ui.start.disabled = ui.export.disabled = true;
  // Switching songs mid-performance keeps playing: the new song starts as soon as it is decoded.
  const wasRunning = engine.running;
  try {
    const { manifest: m, stems, bases = [], warnings = [] } = await loader(engine.context());
    manifest = { beats: [], downbeats: [], sections: [], bases: {}, ...m };
    const sources = [...stems, ...bases.map((b) => ({ id: baseId(b.pool), buffer: b.buffer }))];
    const alignWarnings = engine.setStems(sources);
    state = new ControllerState(stems, { mode: checked("mode"), pool: POOLS.MIX, bases: bases.map((b) => b.pool) });
    // Keep the chosen pool when the new song has it.
    const pool = checked("pool");
    if (state.availablePools().includes(pool)) state.setPool(pool);
    else setChecked("pool", POOLS.MIX);
    for (const r of radios("pool")) r.disabled = !state.availablePools().includes(r.value);

    renderGrid(stems);
    ui.title.textContent = m.title;
    renderCredit(m.credits);
    ui.quantize.disabled = !beatGrid("beat");
    if (ui.quantize.disabled) ui.quantize.value = "off";
    ui.start.disabled = false;
    ui.stop.disabled = true;
    ui.export.disabled = false;
    ui.hint.hidden = true;
    showWarnings([...warnings, ...alignWarnings]);
    setChip(ui.audio, "audio", "ready");
    apply();
    if (wasRunning) await start();
  } catch (e) {
    console.error(e);
    setChip(ui.audio, "audio", "error", e.message);
    showWarnings([e.message]);
  }
}

/** Fill the song picker from songs.json; silently absent on the public site, where no song audio is hosted. */
async function loadSongList() {
  const url = params.get("songs") ?? "audio/songs.json";
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const { songs } = await res.json();
    if (!songs?.length) return;
    ui.songSelect.replaceChildren(...songs.map((s) =>
      Object.assign(document.createElement("option"), { value: new URL(s.manifest, new URL(url, location.href)).href, textContent: s.title })));
    ui.songPicker.hidden = false;
    if (!params.get("stems")) load((ctx) => loadFromUrl(ctx, ui.songSelect.value));
  } catch {
    // No song list: demo and file loading still work.
  }
}

/** Attribution line for recorded material, e.g. official cast recordings. Built with textContent only. */
function renderCredit(c) {
  ui.credit.hidden = !c;
  if (!c) return ui.credit.replaceChildren();
  const parts = [
    c.work && c.song ? `"${c.song}" from ${c.work}` : (c.song ?? c.work),
    c.performers && `performed by ${c.performers}`,
    c.album && `(${c.album})`,
    c.music && `music: ${c.music}`,
    c.lyrics && `lyrics: ${c.lyrics}`,
  ].filter(Boolean);
  const nodes = [document.createTextNode(`${parts.join(", ")}. `)];
  if (c.notice) nodes.push(document.createTextNode(`${c.notice} `));
  if (c.source_url) {
    nodes.push(Object.assign(document.createElement("a"), {
      href: c.source_url, textContent: "Source", target: "_blank", rel: "noopener noreferrer",
    }));
  }
  ui.credit.replaceChildren(...nodes);
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
      b.innerHTML = `<span class="key"></span><span class="level"></span><span class="label"></span>`;
      b.querySelector(".label").textContent = s.label;
      b.querySelector(".key").textContent = key ?? "";
      if (s.level_db !== null && s.level_db !== undefined) {
        b.querySelector(".level").textContent = s.level_db < SILENT_DB ? "silent" : `${s.level_db.toFixed(0)} dB`;
        b.title = `${s.label}: ${s.level_db} dB vs the mix in this excerpt`;
      }
      if (key) b.setAttribute("aria-keyshortcuts", key);
      b.addEventListener("click", () => toggle(s.id));
      pads.set(s.id, b);
    }
    cells.push(b);
  }
  ui.grid.replaceChildren(...cells);
}

function toggle(id) {
  if (!state || !state.isActive(id)) return;
  state.toggle(id);
  apply();
}

// ---------- applying state ----------

/** Loop-relative boundary times for quantizing: recorded beats/downbeats, else a constant-BPM grid. */
function beatGrid(unit) {
  if (!manifest) return null;
  const listed = unit === "bar" ? manifest.downbeats : manifest.beats;
  if (listed.length) return listed;
  if (!manifest.bpm) return null;
  const step = (60 / manifest.bpm) * (unit === "bar" ? manifest.beats_per_bar : 1);
  return Array.from({ length: Math.ceil(engine.loopDur / step) }, (_, i) => i * step);
}

function sectionAt(t) {
  if (t === null || !manifest) return null;
  return manifest.sections.find((s) => t >= s.start && t < s.end)?.name ?? null;
}

/** Source id -> gain, for the engine and the exporter. */
function sourceGains() {
  const g = state.gains();
  return { ...g.stems, ...Object.fromEntries(Object.entries(g.bases).map(([p, v]) => [baseId(p), v])) };
}

/** One line describing what is playing, e.g. "Mix (original) − Drums & perc". */
function describe() {
  const label = (id) => manifest.stems.find((s) => s.id === id).label;
  const pressed = state.stemIds.filter((id) => state.selected.has(id)).map(label);
  if (state.mode === MODES.ADD) return pressed.length ? pressed.join(" + ") : "(silence)";
  const base = state.base()
    ? `${POOL_LABEL[state.pool]} (original)`
    : `${POOL_LABEL[state.pool]} (sum of its stems)`;
  return pressed.length ? `${base} − ${pressed.join(" − ")}` : base;
}

/** Push the current state to audio, pads and bridge. */
function apply() {
  const gains = sourceGains();
  const q = ui.quantize.value === "off" ? null : beatGrid(ui.quantize.value);
  const when = engine.running ? engine.nextBoundary(q) : engine.context().currentTime;
  engine.applyGains(gains, when);

  const audible = new Set(state.audible());
  const delay = Math.max(0, when - engine.context().currentTime);
  clearTimeout(pendingTimer);
  for (const [id, b] of pads) {
    const active = state.isActive(id);
    b.classList.toggle("inactive", !active);
    b.disabled = !active;
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

  ui.subtractHint.textContent = state.bases.has(checked("pool")) ? "from original" : "from stem sum";
  ui.audible.textContent = describe();

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
  await engine.start(sourceGains());
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

// ---------- export ----------

/**
 * Download what the current setting plays (even if a quantized change is still pending)
 * for the section under the playhead, or the whole loop when stopped.
 */
function exportMix() {
  if (!state) return;
  const { start, end, section } = exportRange(manifest.sections, engine.loopDur, engine.playhead());
  const { channels, sampleRate, peak } = mixGains(engine.stems, sourceGains(), start, end);
  const { gain, db } = fitGain(peak);
  const name = exportFileName({ song: manifest.title, mode: state.mode, pool: state.pool, section,
                                selectedMask: state.snapshot().selected_mask, db });
  const url = URL.createObjectURL(new Blob([encodeWav16(channels, sampleRate, gain)], { type: "audio/wav" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  ui.exportInfo.textContent =
    `${name}  ·  ${(end - start).toFixed(2)} s, ${sampleRate} Hz` + (db ? `  ·  scaled ${db} dB to avoid clipping` : "");
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
ui.songSelect.addEventListener("change", () => load((ctx) => loadFromUrl(ctx, ui.songSelect.value)));
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

radios("mode").forEach((r) => r.addEventListener("change", () => {
  if (!state) return;
  state.setMode(checked("mode"));
  apply();
}));
radios("pool").forEach((r) => r.addEventListener("change", () => {
  if (!state) return;
  state.setPool(checked("pool"));
  apply();
}));
ui.clear.addEventListener("click", () => { if (state) { state.clear(); apply(); } });
ui.export.addEventListener("click", exportMix);
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
loadSongList();

// Read-only handle for the browser console and automated checks.
window.stageGenerator = {
  engine,
  get state() { return state; },
  get manifest() { return manifest; },
  gains: () => Object.fromEntries(engine.stems.map((s) => [s.id, s.gain.gain.value])),
  inPool,
};
