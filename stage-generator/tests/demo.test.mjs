// Checks that the procedural demo stems are aligned, normalized and silent at the loop seam.
import test from "node:test";
import assert from "node:assert/strict";
import { renderDemo, DEMO_MANIFEST } from "../demo.js";

// Minimal stand-in for BaseAudioContext: only what renderDemo touches.
const fakeCtx = {
  sampleRate: 48000,
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { length, sampleRate, duration: length / sampleRate, data, copyToChannel(src) { data.set(src); } };
  },
};

const song = renderDemo(fakeCtx);
const stems = await Promise.all(song.manifest.stems.map(async (m) => ({ ...m, buffer: await song.getChunk(null, m.id, 0) })));

test("nine stems including the two voice stems, all the same length", () => {
  assert.equal(stems.length, 9);
  assert.deepEqual(stems.map((s) => s.id).slice(0, 2), ["vocals", "ensemble"]);
  assert.equal(new Set(stems.map((s) => s.buffer.length)).size, 1);
  assert.equal(stems[0].buffer.duration, 8);
});

test("every stem is normalized to the same peak and loops without a click", () => {
  const tail = Math.round(0.002 * fakeCtx.sampleRate);
  for (const s of stems) {
    const d = s.buffer.data;
    let peak = 0;
    for (const v of d) peak = Math.max(peak, Math.abs(v));
    assert.ok(Math.abs(peak - 0.22) < 1e-6, `${s.id} peak ${peak}`);
    let end = 0;
    for (let i = d.length - tail; i < d.length; i++) end = Math.max(end, Math.abs(d[i]));
    assert.ok(end < 0.005, `${s.id} is not silent at the loop seam (${end})`);
  }
});

test("manifest sections cover the loop", () => {
  const { sections } = DEMO_MANIFEST;
  assert.equal(sections[0].start, 0);
  assert.equal(sections.at(-1).end, 8);
});
