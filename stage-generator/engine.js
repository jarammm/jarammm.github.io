// Gapless playback engine on Web Audio.
// Every source (stems and base recordings) starts on one shared clock and loops forever;
// changes only ramp gains, so the audio never pauses or re-triggers while the operator plays the grid.
// Gains may be negative: "base - stem" is played as base at +1 and stem at -1, which cancels the
// stem inside the base sample by sample (all sources are sample-aligned).

const RAMP_TAU = 0.03;      // setTargetAtTime time constant (s); ~95% settled after 3*tau
const START_DELAY = 0.1;    // lead time before the shared start (s) so all sources line up
const FEATURE_BANDS = 8;

export class StemEngine {
  constructor() {
    this.ctx = null;
    this.stems = [];          // [{id, buffer, gain:GainNode, ...meta}] -- every playable source
    this.sources = [];
    this.loopDur = 0;         // seconds; the shortest source, so every source loops at the same point
    this.t0 = null;           // AudioContext time of sample 0 of the current run
    this.prevSpectrum = null;
    this.fluxMean = 0;
  }

  /** Lazily create the context. Browsers only let it run after a user gesture. */
  context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      // Safety limiter only: unity sums reproduce the recording, which should not trip it.
      this.limiter = new DynamicsCompressorNode(this.ctx, {
        threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.1,
      });
      this.master = new GainNode(this.ctx, { gain: 1 });
      this.analyser = new AnalyserNode(this.ctx, { fftSize: 2048, smoothingTimeConstant: 0.6 });
      this.master.connect(this.limiter).connect(this.analyser).connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get running() {
    return this.sources.length > 0;
  }

  /**
   * Replace the loaded sources. Stops playback first.
   * @param {{id:string, buffer:AudioBuffer}[]} sources  stems and base recordings, ids unique
   * @returns {string[]} warnings about alignment problems
   */
  setStems(sources) {
    this.stop(0);
    for (const s of this.stems) s.gain.disconnect();
    const ctx = this.context();
    const warnings = [];
    const lens = sources.map((s) => s.buffer.duration);
    const minDur = Math.min(...lens);
    const maxDur = Math.max(...lens);
    // decodeAudioData resamples to the context rate, so unequal source rates show up as unequal lengths.
    if (maxDur - minDur > 0.001) {
      warnings.push(
        `Stem lengths differ by ${((maxDur - minDur) * 1000).toFixed(1)} ms; ` +
        `looping at the shortest (${minDur.toFixed(3)} s). Export stems with identical start and length.`,
      );
    }
    this.loopDur = minDur;
    this.stems = sources.map((s) => {
      const gain = new GainNode(ctx, { gain: 0 });
      gain.connect(this.master);
      return { ...s, gain };
    });
    return warnings;
  }

  /**
   * Start every source on the same clock.
   * @param {Object<string,number>} gains  source id -> gain from the first sample (missing = 0)
   */
  async start(gains) {
    const ctx = this.context();
    await ctx.resume();
    this.stop(0);
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(1, ctx.currentTime);
    const t0 = ctx.currentTime + START_DELAY;
    this.sources = this.stems.map((s) => {
      s.gain.gain.cancelScheduledValues(ctx.currentTime);
      s.gain.gain.setValueAtTime(gains[s.id] ?? 0, ctx.currentTime);
      const src = new AudioBufferSourceNode(ctx, { buffer: s.buffer, loop: true });
      src.loopStart = 0;
      src.loopEnd = this.loopDur;
      src.connect(s.gain);
      src.start(t0);
      return src;
    });
    this.t0 = t0;
  }

  /** Fade out, then stop. Only for rehearsal; the show path never calls this. */
  stop(fade = 0.3) {
    if (!this.ctx || !this.sources.length) return;
    const now = this.ctx.currentTime;
    const end = now + fade;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, end);
    for (const src of this.sources) src.stop(end + 0.01);
    this.sources = [];
    this.t0 = null;
  }

  /** Seconds into the loop, or null when stopped. */
  playhead() {
    if (this.t0 === null) return null;
    const t = this.ctx.currentTime - this.t0;
    return t <= 0 ? 0 : t % this.loopDur;
  }

  /**
   * Context time at which a change should land.
   * @param {number[]|null} grid  sorted loop-relative times (beats or downbeats), or null for now
   */
  nextBoundary(grid) {
    const now = this.ctx.currentTime;
    const ph = this.playhead();
    if (!grid || !grid.length || ph === null) return now;
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
    for (const s of this.stems) {
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
