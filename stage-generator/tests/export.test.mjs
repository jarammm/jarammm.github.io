// Tests for mix export: range choice, mixing rule, gain fitting, WAV encoding and naming.
import test from "node:test";
import assert from "node:assert/strict";
import { exportRange, mixAudible, fitGain, encodeWav16, exportFileName } from "../export.js";

/** AudioBuffer stand-in built from per-channel arrays. */
function buf(chans, sampleRate = 10) {
  const data = chans.map((c) => Float32Array.from(c));
  return { sampleRate, length: data[0].length, numberOfChannels: data.length, getChannelData: (c) => data[c] };
}

const SECTIONS = [{ name: "A", start: 0, end: 4 }, { name: "B", start: 4, end: 8 }];

test("range is the section under the playhead, else the whole loop", () => {
  assert.deepEqual(exportRange(SECTIONS, 8, 5.2), { start: 4, end: 8, section: "B" });
  assert.deepEqual(exportRange(SECTIONS, 8, null), { start: 0, end: 8, section: null });
  assert.deepEqual(exportRange([], 8, 3), { start: 0, end: 8, section: null });
  assert.deepEqual(exportRange(SECTIONS, 6, 5), { start: 4, end: 6, section: "B" }); // clipped to loop
});

test("sums only audible stems; mono stems feed both channels", () => {
  const stems = [
    { id: "a", buffer: buf([[0.1, 0.1, 0.1, 0.1]]) },
    { id: "b", buffer: buf([[0.2, 0.2, 0.2, 0.2], [0.3, 0.3, 0.3, 0.3]]) },
    { id: "c", buffer: buf([[0.5, 0.5, 0.5, 0.5]]) },
  ];
  const { channels, peak } = mixAudible(stems, new Set(["a", "b"]), 0.1, 0.3); // samples 1..2
  assert.equal(channels.length, 2);
  assert.deepEqual([...channels[0]].map((x) => +x.toFixed(4)), [0.3, 0.3]);
  assert.deepEqual([...channels[1]].map((x) => +x.toFixed(4)), [0.4, 0.4]);
  assert.ok(Math.abs(peak - 0.4) < 1e-6);
});

test("never reads past the shortest stem (the loop seam)", () => {
  const stems = [{ id: "a", buffer: buf([[1, 1, 1]]) }, { id: "b", buffer: buf([[1, 1, 1, 1, 1]]) }];
  assert.equal(mixAudible(stems, new Set(["a", "b"]), 0, 0.5).channels[0].length, 3);
});

test("silence exports as silence at unity gain", () => {
  const { channels, peak } = mixAudible([{ id: "a", buffer: buf([[0.5, 0.5]]) }], new Set(), 0, 0.2);
  assert.equal(peak, 0);
  assert.deepEqual(fitGain(peak), { gain: 1, db: 0 });
  assert.deepEqual([...channels[0]], [0, 0]);
});

test("over full scale is scaled down, not clipped", () => {
  assert.deepEqual(fitGain(0.9), { gain: 1, db: 0 });
  const { gain, db } = fitGain(2);
  assert.equal(gain, 0.5);
  assert.equal(db, -6);
});

test("WAV header and samples are correct", () => {
  const wav = new DataView(encodeWav16([Float32Array.from([0, 1, -1]), Float32Array.from([0.5, 0, 2])], 48000, 0.5));
  const tag = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(o + i)));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(wav.getUint16(22, true), 2);          // channels
  assert.equal(wav.getUint32(24, true), 48000);      // sample rate
  assert.equal(wav.getUint16(34, true), 16);         // bits
  assert.equal(wav.getUint32(40, true), 3 * 2 * 2);  // data bytes
  const s = (i) => wav.getInt16(44 + i * 2, true);   // interleaved L,R
  assert.deepEqual([s(0), s(1), s(2), s(3), s(4), s(5)], [0, 8192, 16384, 0, -16384, 32767]);
});

test("file name carries song, section, mask and any gain", () => {
  assert.equal(exportFileName({ song: "Demo loop (synthesized)", section: "A", mask: "101", db: 0 }), "demo-loop-synthesized_A_101.wav");
  assert.equal(exportFileName({ song: "S", section: "verse 1", mask: "0", db: 0 }), "s_verse-1_0.wav");
  assert.equal(exportFileName({ song: "X", section: null, mask: "1", db: -1.8 }), "x_loop_1_gain-1.8dB.wav");
});
