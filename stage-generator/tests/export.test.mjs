// Tests for mix export: range choice, mixing rule, gain fitting, WAV encoding and naming.
import test from "node:test";
import assert from "node:assert/strict";
import { mixGains, fitGain, encodeWav16, exportFileName } from "../export.js";

/** AudioBuffer stand-in built from per-channel arrays. */
function buf(chans, sampleRate = 10) {
  const data = chans.map((c) => Float32Array.from(c));
  return { sampleRate, length: data[0].length, numberOfChannels: data.length, getChannelData: (c) => data[c] };
}

test("sums sources times their gains; mono sources feed both channels", () => {
  const stems = [
    { id: "a", buffer: buf([[0.1, 0.1, 0.1, 0.1]]) },
    { id: "b", buffer: buf([[0.2, 0.2, 0.2, 0.2], [0.3, 0.3, 0.3, 0.3]]) },
    { id: "c", buffer: buf([[0.5, 0.5, 0.5, 0.5]]) },
  ];
  const { channels, peak } = mixGains(stems, { a: 1, b: 1, c: 0 }, 0.1, 0.3); // samples 1..2
  assert.equal(channels.length, 2);
  assert.deepEqual([...channels[0]].map((x) => +x.toFixed(4)), [0.3, 0.3]);
  assert.deepEqual([...channels[1]].map((x) => +x.toFixed(4)), [0.4, 0.4]);
  assert.ok(Math.abs(peak - 0.4) < 1e-6);
});

test("negative gain subtracts a stem from a base", () => {
  const sources = [
    { id: "base:mix", buffer: buf([[0.5, 0.5, 0.5]]) },
    { id: "v", buffer: buf([[0.2, 0.2, 0.2]]) },
  ];
  const { channels } = mixGains(sources, { "base:mix": 1, v: -1 }, 0, 0.3);
  assert.deepEqual([...channels[0]].map((x) => +x.toFixed(4)), [0.3, 0.3, 0.3]);
});

test("never reads past the shortest stem (the loop seam)", () => {
  const stems = [{ id: "a", buffer: buf([[1, 1, 1]]) }, { id: "b", buffer: buf([[1, 1, 1, 1, 1]]) }];
  assert.equal(mixGains(stems, { a: 1, b: 1 }, 0, 0.5).channels[0].length, 3);
});

test("silence exports as silence at unity gain", () => {
  const { channels, peak } = mixGains([{ id: "a", buffer: buf([[0.5, 0.5]]) }], {}, 0, 0.2);
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

test("file name carries song, setting, pressed mask and any gain", () => {
  assert.equal(exportFileName({ song: "Demo loop (synthesized)", mode: "add", pool: "vocals", selectedMask: "101", db: 0 }),
    "demo-loop-synthesized_add-vocals_sel101.wav");
  assert.equal(exportFileName({ song: "X", mode: "subtract", pool: "mix", selectedMask: "1", db: -1.8 }),
    "x_subtract-mix_sel1_gain-1.8dB.wav");
});
