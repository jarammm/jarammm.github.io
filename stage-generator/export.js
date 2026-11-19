// Export what the controller plays as a WAV file, for offline model and prompt tests.
// The mixing rule must match the show bridge's mixer.render so that an exported file and a
// bridge render of the same setting are the same audio:
//   sum of every source (stems and base recordings) times its gain (+1, -1 or 0), no limiter;
//   if the sum exceeds full scale, the whole file is scaled down (never clipped) and the applied
//   gain goes into the file name.

const MAX_CHANNELS = 2;

/**
 * Time range to export: the section under the playhead, or the whole loop.
 * @param {{name:string,start:number,end:number}[]} sections
 * @param {number} loopDur        loop length in seconds
 * @param {number|null} playhead  seconds into the loop, or null when stopped
 * @returns {{start:number, end:number, section:string|null}}
 */
export function exportRange(sections, loopDur, playhead) {
  const sec = playhead === null ? null : sections.find((s) => playhead >= s.start && playhead < s.end);
  if (!sec) return { start: 0, end: loopDur, section: null };
  return { start: Math.max(0, sec.start), end: Math.min(loopDur, sec.end), section: sec.name };
}

/**
 * Sum sources times their gains over [start, end).
 * @param {{id:string, buffer:AudioBuffer}[]} sources  buffers share one sample rate (decoded by one context)
 * @param {Object<string,number>} gains  id -> gain; missing or 0 means the source is skipped
 * @returns {{channels: Float32Array[], sampleRate:number, peak:number}}
 *          channels: (C,) arrays of (end-start)*sr samples, C = max source channels capped at 2
 */
export function mixGains(sources, gains, start, end) {
  const sr = sources[0].buffer.sampleRate;
  const loopLen = Math.min(...sources.map((s) => s.buffer.length));  // loop seam = shortest source
  const i0 = Math.max(0, Math.round(start * sr));
  const i1 = Math.min(loopLen, Math.round(end * sr));
  const n = Math.max(0, i1 - i0);
  const nCh = Math.min(MAX_CHANNELS, Math.max(...sources.map((s) => s.buffer.numberOfChannels)));
  const channels = Array.from({ length: nCh }, () => new Float32Array(n));  // (C, n)

  for (const s of sources) {
    const g = gains[s.id] ?? 0;
    if (!g) continue;
    for (let c = 0; c < nCh; c++) {
      // Mono sources feed every output channel.
      const src = s.buffer.getChannelData(Math.min(c, s.buffer.numberOfChannels - 1));
      const out = channels[c];
      for (let i = 0; i < n; i++) out[i] += g * src[i0 + i];
    }
  }
  let peak = 0;
  for (const ch of channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  return { channels, sampleRate: sr, peak };
}

/** Gain that keeps the mix within full scale, and the same gain in dB (0 when untouched). */
export function fitGain(peak) {
  if (peak <= 1) return { gain: 1, db: 0 };
  const gain = 1 / peak;
  return { gain, db: Math.round(20 * Math.log10(gain) * 10) / 10 };
}

/**
 * Encode as 16-bit PCM WAV (the most widely accepted input format for audio models).
 * @param {Float32Array[]} channels  (C, n)
 * @returns {ArrayBuffer}
 */
export function encodeWav16(channels, sampleRate, gain = 1) {
  const nCh = channels.length;
  const n = channels[0]?.length ?? 0;
  const dataBytes = n * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i] * gain));
      // Round half away from zero so positive and negative samples quantize symmetrically.
      v.setInt16(o, Math.sign(x) * Math.round(Math.abs(x) * 32767), true);
      o += 2;
    }
  }
  return buf;
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

/**
 * e.g. "aladdin-friend-like-me_subtract-mix_chorus5_sel0000000010.wav".
 * (mode, pool, section, pressed mask) is the test-set key, so the section keeps its manifest case.
 */
export function exportFileName({ song, mode, pool, section, selectedMask, db }) {
  return `${slug(song).toLowerCase()}_${mode}-${pool}_${section === null ? "loop" : slug(section)}` +
    `_sel${selectedMask}${db ? `_gain${db}dB` : ""}.wav`;
}
