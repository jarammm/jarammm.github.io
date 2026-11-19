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
import { renderSong, fitGain, encodeWav16, exportFileName } from "./export.js";

const FEATURE_INTERVAL_MS = 33; // ~30 Hz to the bridge
const PAD_KEY_CODES = PAD_KEYS.map((k) => (/\d/.test(k) ? `Digit${k}` : `Key${k}`));
const SILENT_DB = -60;          // a stem quieter than this (vs the mix) is labelled silent
const POOL_LABEL = { mix: "Mix", accompaniment: "Accompaniment", vocals: "Vocals" };

const $ = (id) => document.getElementById(id);
const ui = {
  title: $("song-title"), credit: $("credit"), audio: $("audio-status"), bridge: $("bridge-status"),
  songPicker: $("song-picker"), songSelect: $("song-select"),
  demo: $("load-demo"), folder: $("load-folder"), files: $("load-files"),
  subtractHint: $("subtract-hint"),
  quantize: $("quantize"), clear: $("clear"), start: $("start"), stop: $("stop"), export: $("export"),
  exportInfo: $("export-info"),
  seek: $("seek"), timeCur: $("time-cur"), timeDur: $("time-dur"), sectionBar: $("section-bar"),
  grid: $("grid"), wrap: document.querySelector(".grid-wrap"), hint: $("drop-hint"),
  audible: $("audible-list"), position: $("position"), meter: $("meter"), warnings: $("warnings"),
};
const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];

const engine = new StemEngine((s, detail) => {
  setChip(ui.audio, "audio", s, detail);
  // Phones cannot hover the chip for its tooltip, so errors also go to the visible list.
  if (s === "error") showWarnings([`Audio error: ${detail ?? "unknown"}`]);
});
let manifest = null;
let song = null;               // loader song currently in the engine
let seeking = false;           // the seek bar is being dragged
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
    const loaded = await loader(engine.context());
    engine.setSong(loaded);
    song = loaded;
    const m = loaded.manifest;
    manifest = m;
    const stems = m.stems;
    state = new ControllerState(stems, { mode: checked("mode"), pool: POOLS.MIX, bases: m.bases });
    // Keep the chosen pool when the new song has it.
    const pool = checked("pool");
    if (state.availablePools().includes(pool)) state.setPool(pool);
    else setChecked("pool", POOLS.MIX);
    for (const r of radios("pool")) r.disabled = !state.availablePools().includes(r.value);

    renderGrid(stems);
    renderMeter(stems);
    ui.exportInfo.textContent = "—";
    ui.title.textContent = m.title;
    renderCredit(m.credits);
    ui.quantize.disabled = !beatGrid("beat");
    if (ui.quantize.disabled) ui.quantize.value = "off";
    ui.start.disabled = false;
    ui.stop.disabled = true;
    ui.export.disabled = false;
    ui.hint.hidden = true;
    showWarnings(loaded.warnings);
    setChip(ui.audio, "audio", "ready");
    renderTransport();
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
        b.title = `${s.label}: ${s.level_db} dB vs the whole mix`;
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
  return state.gains();
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

// iOS mutes Web Audio while the ring/silent switch is on, unless the page's audio session is "playback".
// Safari 17+ lets the page say so (navigator.audioSession); older iOS switches the session when an
// <audio> element plays, so a looping silent clip is played alongside. Both must start inside the tap.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let sessionKeeper = null;

/** 0.5 s of 16-bit mono silence as a WAV blob URL. */
function silentWavUrl() {
  const n = 4000;  // 0.5 s at 8 kHz
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([v.buffer], { type: "audio/wav" }));
}

function claimPlaybackSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch { /* not supported */ }
  if (!IS_IOS || navigator.audioSession) return;
  if (!sessionKeeper) {
    sessionKeeper = new Audio(silentWavUrl());
    sessionKeeper.loop = true;
    sessionKeeper.setAttribute("playsinline", "");
  }
  sessionKeeper.play().catch(() => {});
}

async function start() {
  claimPlaybackSession();   // before any await: it has to happen within the user's tap
  ui.start.disabled = true;
  ui.stop.disabled = false;
  await engine.start(sourceGains());
  apply();
}

function stop() {
  sessionKeeper?.pause();
  engine.stop();
  ui.start.disabled = false;
  ui.stop.disabled = true;
  setChip(ui.audio, "audio", "ready");
}

/** Seek bar range and the section strip under it. */
function renderTransport() {
  const dur = engine.loopDur;
  ui.seek.max = String(dur);
  ui.seek.value = "0";
  ui.seek.disabled = false;
  ui.timeDur.textContent = fmt(dur);
  ui.sectionBar.replaceChildren(...manifest.sections.filter((s) => s.end > s.start).map((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "section";
    b.style.left = `${(100 * s.start) / dur}%`;
    b.style.width = `${(100 * (Math.min(s.end, dur) - s.start)) / dur}%`;
    b.textContent = s.name;
    b.title = `${s.name}  ${fmt(s.start)}–${fmt(s.end)}`;
    b.addEventListener("click", () => seekTo(s.start));
    return b;
  }));
}

async function seekTo(pos) {
  ui.seek.value = String(pos);
  await engine.seek(pos);
}

// ---------- export ----------

/**
 * Download what the current setting plays (even if a quantized change is still pending)
 * over the whole song, whatever the playhead or transport state. Streams the song chunk by chunk,
 * fetching only the sources that sound in this setting.
 */
async function exportMix() {
  if (!state || !song) return;
  ui.export.disabled = true;
  const gains = sourceGains();
  const setting = state.snapshot();
  try {
    const { channels, sampleRate, peak } = await renderSong(song, gains, engine.context(),
      (done, total) => { ui.exportInfo.textContent = `rendering ${done}/${total} chunks…`; });
    download(channels, sampleRate, peak, setting);
  } catch (e) {
    ui.exportInfo.textContent = `export failed: ${e.message}`;
  } finally {
    ui.export.disabled = false;
  }
}

function download(channels, sampleRate, peak, setting) {
  const { gain, db } = fitGain(peak);
  const name = exportFileName({ song: manifest.title, mode: setting.mode, pool: setting.pool,
                                selectedMask: setting.selected_mask, db });
  const url = URL.createObjectURL(new Blob([encodeWav16(channels, sampleRate, gain)], { type: "audio/wav" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  ui.exportInfo.textContent =
    `${name}  ·  ${(channels[0].length / sampleRate).toFixed(1)} s, ${sampleRate} Hz` + (db ? `  ·  scaled ${db} dB to avoid clipping` : "");
}

// ---------- readout and feature stream ----------

const METER_FLOOR_DB = -60;    // bar height runs from -60 dBFS (empty) to 0 dBFS (full)
let meterBars = new Map();     // stem id -> bar element

/** One bar per pad, in pad order and colour, labelled with the stem name. */
function renderMeter(stems) {
  ui.meter.style.setProperty("--m", stems.length);
  meterBars = new Map();
  ui.meter.replaceChildren(...stems.map((s) => {
    const col = document.createElement("div");
    col.className = "col";
    col.title = s.label;
    const well = document.createElement("div");
    well.className = "well";
    const bar = document.createElement("i");
    bar.style.setProperty("--c", s.color);
    well.append(bar);
    const label = Object.assign(document.createElement("span"), { textContent: s.label });
    col.append(well, label);
    meterBars.set(s.id, bar);
    return col;
  }));
}

/**
 * Level of each stem in what is heard now, in [0, 1]: the stem's own RMS on a dB scale if the stem
 * is part of the output (its pad is lit), else 0. Pads light when a change actually lands, so this
 * follows quantized changes too.
 */
function heardLevels() {
  const raw = engine.sourceLevels();
  return Object.fromEntries(manifest.stems.map((s) => {
    const lit = pads.get(s.id)?.classList.contains("audible");
    const db = 20 * Math.log10((raw[s.id] ?? 0) + 1e-9);
    return [s.id, lit ? Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) : 0];
  }));
}

function fmt(t) {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
}

function frame() {
  const ph = engine.playhead();
  if (!seeking && manifest) {
    const at = ph ?? engine.startPos;
    ui.seek.value = String(at);
    ui.timeCur.textContent = fmt(at);
  }
  if (ph !== null) {
    const sec = sectionAt(ph);
    ui.position.textContent = `${fmt(ph)} / ${fmt(engine.loopDur)}${sec ? `  ·  section ${sec}` : ""}`;
  } else {
    ui.position.textContent = "—";
  }
  if (lastFeatures?.levels) {
    for (const [id, v] of Object.entries(lastFeatures.levels)) {
      const bar = meterBars.get(id);
      if (bar) bar.style.height = `${Math.max(2, v * 100)}%`;
      pads.get(id)?.style.setProperty("--level", v.toFixed(3));
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

setInterval(() => {
  if (!engine.running || !manifest) {
    if (lastFeatures) lastFeatures.levels = Object.fromEntries([...meterBars.keys()].map((id) => [id, 0]));
    return;
  }
  lastFeatures = { ...engine.features(), levels: heardLevels() };
  const ph = engine.playhead();
  bridge?.sendFeatures({ ...lastFeatures, playhead_sec: ph, section: sectionAt(ph), ts: Date.now() / 1000 });
}, FEATURE_INTERVAL_MS);

// ---------- inputs ----------

ui.demo.addEventListener("click", () => load(async (ctx) => renderDemo(ctx)));
ui.seek.addEventListener("input", () => { seeking = true; ui.timeCur.textContent = fmt(Number(ui.seek.value)); });
ui.seek.addEventListener("change", async () => { seeking = false; await seekTo(Number(ui.seek.value)); });
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
  get song() { return song; },
  gains: () => Object.fromEntries(engine.sources.map((s) => [s.id, s.gain.gain.value])),
  inPool,
};
