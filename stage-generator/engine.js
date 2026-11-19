// Streaming playback engine on Web Audio.
// Every source (stems and recordings) plays chunk after chunk on one shared clock and loops forever;
// pad changes only ramp gains, so the audio never pauses or re-triggers while the operator plays the grid.
// Gains may be negative: "base - stem" is played as base at +1 and stem at -1, which cancels the stem
// inside the base sample by sample. That needs sample-exact alignment, so:
//   - the context runs at the song's own sample rate (chunks are not resampled one by one),
//   - every chunk boundary lands on a sample frame of the shared clock,
//   - a chunk that arrives late starts at the offset where it should be, never from its beginning.
// Only the chunk playing and the next PREFETCH chunks are held in memory, whatever the song length.

import { Timeline } from "./timeline.js";

const RAMP_TAU = 0.03;       // setTargetAtTime time constant (s) for pad changes; ~95% settled after 3*tau
const START_LEAD = 0.1;      // seconds between scheduling and the first sound
const SCHEDULE_AHEAD = 1.5;  // schedule chunks that start within this many seconds
const PREFETCH = 2;          // chunks fetched ahead of the one being scheduled
const TICK_MS = 200;
const SEEK_FADE = 0.03;      // seconds of fade out/in around a seek
const FEATURE_BANDS = 8;

export class StemEngine {
  /** @param {(state:string, detail?:string)=>void} onStatus  "buffering" | "running" | "error" */
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.ctx = null;
    this.song = null;          // loader song: {timeline, sources, getChunk}
    this.tl = null;            // Timeline
    this.sources = [];         // [{id, gain:GainNode}] in song.sources order
    this.cache = new Map();    // local chunk k -> {promise, ready, buffers}
    this.nodes = new Set();    // scheduled AudioBufferSourceNodes
    this.t0 = null;            // context time of global position 0 (frame-aligned); null when not playing
    this.nextJ = 0;            // next global chunk to schedule
    this.minPos = 0;           // global position playback (re)started from
    this.startPos = 0;         // song position for the next start()
    this.runToken = 0;         // bumps on start/seek/stop so stale async work is dropped
    this.buffering = false;
    this.ticker = null;
    this.prevSpectrum = null;
    this.fluxMean = 0;
  }

  /**
   * The audio context, created on first use or recreated when a song needs another sample rate.
   * Browsers only let it run after a user gesture; start() resumes it.
   */
  context(sampleRate = null) {
    if (this.ctx && (!sampleRate || this.ctx.sampleRate === sampleRate)) return this.ctx;
    if (this.ctx) {
      this.stop(0);
      this.ctx.close();
    }
    this.ctx = new AudioContext(sampleRate ? { latencyHint: "interactive", sampleRate } : { latencyHint: "interactive" });
    // Safety limiter only: unity sums reproduce the recording, which should not trip it.
    this.limiter = new DynamicsCompressorNode(this.ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    this.master = new GainNode(this.ctx, { gain: 1 });
    this.analyser = new AnalyserNode(this.ctx, { fftSize: 2048, smoothingTimeConstant: 0.6 });
    this.master.connect(this.limiter).connect(this.analyser).connect(this.ctx.destination);
    this.sources = this.sources.map((s) => ({ id: s.id, gain: this.sourceGain() }));
    return this.ctx;
  }

  sourceGain() {
    const g = new GainNode(this.ctx, { gain: 0 });
    g.connect(this.master);
    return g;
  }

  get running() {
    return this.t0 !== null || this.buffering;
  }

  /** Seconds per loop. */
  get loopDur() {
    return this.tl?.duration ?? 0;
  }

  /** Number of scheduled chunk nodes (for checks). */
  get activeNodes() {
    return this.nodes.size;
  }

  /** Replace the song. Stops playback; the context follows the song's sample rate. */
  setSong(song) {
    this.stop(0);
    this.song = song;
    this.tl = new Timeline(song.timeline);
    this.context(this.tl.sampleRate);
    for (const s of this.sources) s.gain.disconnect();
    this.sources = song.sources.map((s) => ({ id: s.id, gain: this.sourceGain() }));
    this.cache.clear();
    this.startPos = 0;
  }

  /** Fetch (or reuse) local chunk k of every source. */
  fetchChunk(k) {
    let e = this.cache.get(k);
    if (e) return e;
    const song = this.song;
    const ctx = this.ctx;
    e = { ready: false, buffers: null };
    e.promise = Promise.all(this.sources.map((s) => song.getChunk(ctx, s.id, k))).then(
      (buffers) => { e.buffers = buffers; e.ready = true; return buffers; },
      (err) => { if (this.cache.get(k) === e) this.cache.delete(k); throw err; },
    );
    e.promise.catch(() => {});   // failures surface where the chunk is awaited or retried
    this.cache.set(k, e);
    return e;
  }

  setBuffering(b, detail) {
    if (b === this.buffering) return;
    this.buffering = b;
    this.onStatus(b ? "buffering" : "running", detail);
  }

  /**
   * Start every source on the same clock.
   * @param {Object<string,number>} gains  source id -> gain from the first sample (missing = 0)
   * @param {number} pos  song position in seconds (default: where it last stopped or was seeked to)
   */
  async start(gains, pos = this.startPos) {
    const ctx = this.context(this.tl.sampleRate);
    await ctx.resume();
    this.halt(0);
    for (const s of this.sources) {
      s.gain.gain.cancelScheduledValues(ctx.currentTime);
      s.gain.gain.setValueAtTime(gains[s.id] ?? 0, ctx.currentTime);
    }
    await this.beginAt(pos);
  }

  /** Begin playback at song position pos once its chunk is in memory. */
  async beginAt(pos) {
    const token = ++this.runToken;
    const j = this.tl.chunkAt(pos);
    this.startPos = pos;
    this.setBuffering(true);
    try {
      await this.fetchChunk(this.tl.local(j)).promise;
    } catch (e) {
      if (token === this.runToken) {
        this.buffering = false;
        this.onStatus("error", e.message);
      }
      return;
    }
    if (token !== this.runToken) return;   // a newer start/seek/stop took over
    const now = this.ctx.currentTime;
    this.t0 = this.tl.frame(now + START_LEAD - pos);
    this.minPos = pos;
    this.nextJ = j;
    // Fade in from the first sample (also covers the seek fade-out that preceded this).
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0, now);
    this.master.gain.linearRampToValueAtTime(1, this.t0 + pos + SEEK_FADE);
    this.setBuffering(false);
    this.schedule();
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.schedule(), TICK_MS);
  }

  /** Schedule every chunk that starts soon, prefetch the ones after, and drop chunks no longer needed. */
  schedule() {
    if (this.t0 === null) return;
    const now = this.ctx.currentTime;
    for (let d = 0; d <= PREFETCH; d++) this.fetchChunk(this.tl.local(this.nextJ + d));
    while (this.t0 + this.tl.chunkStart(this.nextJ) < now + SCHEDULE_AHEAD) {
      const k = this.tl.local(this.nextJ);
      const e = this.cache.get(k);
      if (!e?.ready) {
        this.setBuffering(true, `waiting for chunk ${k}`);
        break;
      }
      this.setBuffering(false);
      const chunkPos = this.tl.chunkStart(this.nextJ);
      const dur = this.tl.chunkLength(k) / this.tl.sampleRate;
      // Late or mid-chunk starts keep their place on the clock: skip into the chunk instead of delaying it.
      const fromPos = Math.max(chunkPos, this.minPos, now + 0.02 - this.t0);
      const offset = fromPos - chunkPos;
      if (offset < dur) {
        e.buffers.forEach((buffer, i) => {
          const node = new AudioBufferSourceNode(this.ctx, { buffer });
          node.connect(this.sources[i].gain);
          node.start(this.t0 + fromPos, offset, dur - offset);
          node.onended = () => { this.nodes.delete(node); node.disconnect(); };
          this.nodes.add(node);
        });
      }
      this.nextJ++;
    }
    const keep = new Set(Array.from({ length: PREFETCH + 1 }, (_, d) => this.tl.local(this.nextJ + d)));
    for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
  }

  /** Stop scheduled nodes (after `fade` seconds) without touching the start position. */
  halt(fade) {
    this.runToken++;
    clearInterval(this.ticker);
    this.ticker = null;
    if (this.ctx) {
      const end = this.ctx.currentTime + fade;
      for (const n of this.nodes) {
        try { n.stop(end); } catch { /* already stopped */ }
      }
    }
    this.nodes.clear();
    this.t0 = null;
    this.buffering = false;
  }

  /** Fade out, then stop; the next start() resumes from here. */
  stop(fade = 0.3) {
    if (!this.ctx || !this.running) return;
    const pos = this.playhead();
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + fade);
    this.halt(fade);
    if (pos !== null) this.startPos = pos;
  }

  /** Jump to song position pos (seconds). While stopped, only sets where start() begins. */
  async seek(pos) {
    pos = Math.min(Math.max(0, pos), this.loopDur - 1e-3);
    if (!this.running) {
      this.startPos = pos;
      return;
    }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + SEEK_FADE);
    this.halt(SEEK_FADE);
    await this.beginAt(pos);
  }

  /** Seconds into the song, or null when stopped. */
  playhead() {
    if (this.t0 === null) return this.buffering ? this.startPos : null;
    const g = this.ctx.currentTime - this.t0;
    return this.tl.wrap(Math.max(g, this.minPos));
  }

  /**
   * Context time at which a change should land.
   * @param {number[]|null} grid  sorted song-relative times (beats or downbeats), or null for now
   */
  nextBoundary(grid) {
    const now = this.ctx.currentTime;
    const ph = this.playhead();
    if (!grid || !grid.length || ph === null || this.t0 === null) return now;
    // Never cross the loop seam late: past the last grid point, the change lands on the seam.
    const next = grid.find((t) => t > ph + 1e-3) ?? this.loopDur;
    return now + Math.min(next, this.loopDur) - ph;
  }

  /**
   * Ramp each source toward its target gain starting at `when`.
   * Re-scheduling cancels any not-yet-started change, so rapid tapping keeps only the last state.
   * @param {Object<string,number>} gains  source id -> gain (missing = 0)
   */
  applyGains(gains, when) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const s of this.sources) {
      const p = s.gain.gain;
      p.cancelScheduledValues(now);
      p.setTargetAtTime(gains[s.id] ?? 0, Math.max(when, now), RAMP_TAU);
    }
  }

  /**
   * Cheap audio features of the master output for audio-reactive visuals.
   * @returns {{rms:number, bands:number[], onset:number}}  rms in [0,1], bands (FEATURE_BANDS,) in [0,1],
   *          onset = positive spectral flux relative to its running mean (>1 means a hit)
   */
  features() {
    const a = this.analyser;
    if (!a) return { rms: 0, bands: new Array(FEATURE_BANDS).fill(0), onset: 0 };
    const time = new Float32Array(a.fftSize);                // (fftSize,)
    a.getFloatTimeDomainData(time);
    let sq = 0;
    for (const v of time) sq += v * v;
    const rms = Math.sqrt(sq / time.length);

    const spec = new Float32Array(a.frequencyBinCount);      // (fftSize/2,) dB
    a.getFloatFrequencyData(spec);
    const mag = spec.map((db) => (Number.isFinite(db) ? Math.pow(10, db / 20) : 0));

    // Log-spaced bands from ~40 Hz to Nyquist, mapped to [0,1] over a 70 dB range.
    const nyq = this.ctx.sampleRate / 2;
    const binHz = nyq / mag.length;
    const bands = [];
    for (let b = 0; b < FEATURE_BANDS; b++) {
      const lo = 40 * Math.pow(nyq / 40, b / FEATURE_BANDS);
      const hi = 40 * Math.pow(nyq / 40, (b + 1) / FEATURE_BANDS);
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.max(i0 + 1, Math.floor(hi / binHz));
      let peak = 0;
      for (let i = i0; i < i1 && i < mag.length; i++) peak = Math.max(peak, mag[i]);
      const db = 20 * Math.log10(peak + 1e-9);
      bands.push(Math.min(1, Math.max(0, (db + 80) / 70)));
    }

    let flux = 0;
    if (this.prevSpectrum) {
      for (let i = 0; i < mag.length; i++) flux += Math.max(0, mag[i] - this.prevSpectrum[i]);
    }
    this.prevSpectrum = mag;
    this.fluxMean = 0.95 * this.fluxMean + 0.05 * flux;
    const onset = this.fluxMean > 1e-6 ? flux / this.fluxMean : 0;

    return { rms: Math.min(1, rms), bands, onset };
  }
}
