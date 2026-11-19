// Procedural demo song: nine sample-aligned stems synthesized in the browser,
// so the public page needs no audio files. Layout mirrors the show song:
// seven instrument stems plus two voice stems (vocals, ensemble).

export const DEMO_MANIFEST = Object.freeze({
  title: "Demo loop (synthesized)",
  bpm: 120,
  beats_per_bar: 4,
  sections: [
    { name: "A", start: 0, end: 4 },
    { name: "B", start: 4, end: 8 },
  ],
  stems: [
    { id: "vocals", group: "vocals", label: "Vocals", color: "#f472b6" },
    { id: "ensemble", group: "vocals", label: "Ensemble", color: "#c084fc" },
    { id: "drums", group: "accompaniment", label: "Drums", color: "#f87171" },
    { id: "percussion", group: "accompaniment", label: "Percussion", color: "#fb923c" },
    { id: "bass", group: "accompaniment", label: "Bass", color: "#facc15" },
    { id: "keys", group: "accompaniment", label: "Keys", color: "#4ade80" },
    { id: "strings", group: "accompaniment", label: "Strings", color: "#2dd4bf" },
    { id: "synth", group: "accompaniment", label: "Synth", color: "#60a5fa" },
    { id: "fx", group: "accompaniment", label: "FX", color: "#a3a3a3" },
  ],
});

const BEAT = 60 / DEMO_MANIFEST.bpm;      // 0.5 s
const BAR = BEAT * 4;                     // 2 s
const BARS = 4;
const LOOP = BAR * BARS;                  // 8 s, sections cover 0-8
const PEAK = 0.22;                        // per-stem peak; nine stems summed stay near full scale

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
// Am - F - C - G, one bar each, as MIDI notes.
const CHORDS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
const ROOTS = [33, 29, 36, 31];

/** Seeded PRNG so the demo renders identically every time. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** Linear attack / linear release envelope in [0,1] for local time x of a note lasting dur. */
function env(x, dur, attack, release) {
  return Math.max(0, Math.min(1, x / attack, (dur - x) / release));
}

/**
 * Add one harmonic tone into `out`.
 * @param {Float32Array} out  (samples,) mono stem buffer
 * @param {object} o  t, dur, f0, amp, harm(k,f)->gain, attack, release, decay (exp tau, s), vib (depth ratio), vibRate
 */
function tone(out, sr, o) {
  const { t, dur, f0, amp = 1, harm = (k) => (k === 1 ? 1 : 0), attack = 0.005, release = 0.05,
          decay = 0, vib = 0, vibRate = 5.5, maxK = 1 } = o;
  const i0 = Math.round(t * sr);
  const n = Math.round(dur * sr);
  const gains = [];
  for (let k = 1; k <= maxK && k * f0 < sr / 2 - 1000; k++) gains.push(harm(k, k * f0));
  let phase = 0;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const x = i / sr;
    // Vibrato fades in so note onsets stay on pitch.
    const f = f0 * (1 + vib * Math.min(1, x / 0.25) * Math.sin(2 * Math.PI * vibRate * x));
    phase += (2 * Math.PI * f) / sr;
    let v = 0;
    for (let k = 0; k < gains.length; k++) if (gains[k]) v += gains[k] * Math.sin((k + 1) * phase);
    const e = env(x, dur, attack, release) * (decay ? Math.exp(-x / decay) : 1);
    out[i0 + i] += amp * e * v;
  }
}

/** Add a noise burst; `hp` uses a first difference as a cheap high-pass for hat-like noise. */
function noise(out, sr, rand, { t, dur, amp = 1, decay = 0.05, hp = false }) {
  const i0 = Math.round(t * sr);
  const n = Math.round(dur * sr);
  let prev = 0;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const w = rand();
    const v = hp ? w - prev : w;
    prev = w;
    const x = i / sr;
    out[i0 + i] += amp * v * Math.exp(-x / decay) * env(x, dur, 0.001, 0.01);
  }
}

/** Vowel-like harmonic weights: sum of resonances at formant frequencies (Hz). */
const formant = (formants) => (k, f) =>
  formants.reduce((acc, [fc, bw, g]) => acc + g * Math.exp(-(((f - fc) / bw) ** 2)), 0) / Math.sqrt(k);
const AH = formant([[700, 130, 1], [1220, 160, 0.5], [2600, 250, 0.25]]);
const OO = formant([[300, 100, 1], [870, 120, 0.35], [2240, 250, 0.1]]);
const SAW = (k) => 1 / k;
const SQUARE = (k) => (k % 2 ? 1 / k : 0);

const RENDER = {
  vocals(out, sr) {
    // [MIDI, beats] per bar
    const melody = [
      [[76, 2], [74, 1], [72, 1]],
      [[72, 2], [69, 2]],
      [[76, 1], [79, 1], [76, 2]],
      [[74, 2], [71, 2]],
    ];
    melody.forEach((bar, b) => {
      let beat = 0;
      for (const [m, len] of bar) {
        tone(out, sr, { t: b * BAR + beat * BEAT, dur: len * BEAT - 0.04, f0: hz(m), harm: AH, maxK: 24,
                        attack: 0.04, release: 0.12, vib: 0.006 });
        beat += len;
      }
    });
  },
  ensemble(out, sr) {
    CHORDS.forEach((chord, b) => chord.forEach((m, j) => {
      tone(out, sr, { t: b * BAR, dur: BAR - 0.02, f0: hz(m) * (1 + (j - 1) * 0.002), harm: OO, maxK: 20,
                      attack: 0.35, release: 0.35, vib: 0.004, vibRate: 4.8 + j * 0.4 });
    }));
  },
  drums(out, sr) {
    const rand = rng(7);
    for (let beat = 0; beat < BARS * 4; beat++) {
      const t = beat * BEAT;
      // Kick: falling-pitch sine.
      const n = Math.round(0.35 * sr), i0 = Math.round(t * sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const x = i / sr;
        ph += (2 * Math.PI * (45 + 75 * Math.exp(-x / 0.03))) / sr;
        out[i0 + i] += Math.sin(ph) * Math.exp(-x / 0.12) * env(x, 0.35, 0.001, 0.02);
      }
      if (beat % 2 === 1) {
        noise(out, sr, rand, { t, dur: 0.25, amp: 0.6, decay: 0.07 });
        tone(out, sr, { t, dur: 0.2, f0: 190, amp: 0.4, decay: 0.05 });
      }
    }
  },
  percussion(out, sr) {
    const rand = rng(11);
    for (let s = 0; s < BARS * 16; s++) {
      const t = s * (BEAT / 4);
      if (s % 2 === 0) noise(out, sr, rand, { t, dur: 0.08, amp: s % 4 === 2 ? 0.9 : 0.45, decay: 0.02, hp: true });
      else noise(out, sr, rand, { t, dur: 0.05, amp: 0.25, decay: 0.012, hp: true });
    }
  },
  bass(out, sr) {
    ROOTS.forEach((m, b) => {
      for (let e = 0; e < 8; e++) {
        const oct = e === 3 || e === 6 ? 12 : 0;
        tone(out, sr, { t: b * BAR + e * (BEAT / 2), dur: 0.22, f0: hz(m + oct), harm: SAW, maxK: 8,
                        attack: 0.004, release: 0.04 });
      }
    });
  },
  keys(out, sr) {
    CHORDS.forEach((chord, b) => {
      for (let beat = 0; beat < 4; beat++) {
        for (const m of chord) {
          // Stabs end before the next beat so the last one does not cross the loop seam.
          tone(out, sr, { t: b * BAR + (beat + 0.5) * BEAT, dur: BEAT / 2 - 0.01, f0: hz(m),
                          harm: (k) => [1, 0.3, 0.1][k - 1] || 0, maxK: 3, decay: 0.15 });
        }
      }
    });
  },
  strings(out, sr) {
    CHORDS.forEach((chord, b) => chord.forEach((m) => {
      for (const det of [-0.003, 0.003]) {
        tone(out, sr, { t: b * BAR, dur: BAR - 0.02, f0: hz(m - 12) * (1 + det), harm: SAW, maxK: 12,
                        attack: 0.4, release: 0.3, vib: 0.002, vibRate: 5 });
      }
    }));
  },
  synth(out, sr) {
    CHORDS.forEach((chord, b) => {
      const pattern = [0, 1, 2, 1];
      for (let s = 0; s < 16; s++) {
        tone(out, sr, { t: b * BAR + s * (BEAT / 4), dur: 0.11, f0: hz(chord[pattern[s % 4]] + 12 + (s >= 8 ? 12 : 0)),
                        harm: SQUARE, maxK: 9, attack: 0.002, release: 0.03, amp: 0.7 });
      }
    });
  },
  fx(out, sr) {
    // Two rising filtered-noise swells, each ending in a short fade so the loop seam is silent.
    const rand = rng(23);
    const segLen = 2 * BAR;
    for (let seg = 0; seg < BARS / 2; seg++) {
      const i0 = Math.round(seg * segLen * sr);
      const n = Math.round(segLen * sr);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const a = 0.002 + 0.25 * p * p;        // one-pole coefficient opens the filter over time
        lp += a * (rand() - lp);
        out[i0 + i] += lp * p * p * env(i / sr, segLen, 0.01, 0.1) * 4;
      }
    }
  },
};

/**
 * Render all demo stems at the context's sample rate.
 * @param {BaseAudioContext} ctx
 * @returns {{manifest:object, stems:{id,label,color,buffer:AudioBuffer}[]}}
 */
export function renderDemo(ctx) {
  const sr = ctx.sampleRate;
  const len = Math.round(LOOP * sr);
  const stems = DEMO_MANIFEST.stems.map((meta) => {
    const data = new Float32Array(len);                   // (LOOP*sr,)
    RENDER[meta.id](data, sr);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < len; i++) data[i] *= PEAK / peak;
    const buffer = ctx.createBuffer(1, len, sr);
    buffer.copyToChannel(data, 0);
    return { ...meta, buffer };
  });
  return { manifest: DEMO_MANIFEST, stems };
}
