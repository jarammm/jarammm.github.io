// Tests for the chunk timeline math.
import test from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../timeline.js";

// 25 samples at 10 Hz in chunks of 10: chunks of 10, 10, 5 samples; 2.5 s per loop.
const T = new Timeline({ sampleRate: 10, length: 25, chunkSamples: 10, chunkCount: 3 });

test("chunk lengths and loop duration", () => {
  assert.deepEqual([0, 1, 2].map((k) => T.chunkLength(k)), [10, 10, 5]);
  assert.equal(T.duration, 2.5);
});

test("global chunks continue across loops without gaps", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((j) => T.chunkStart(j)), [0, 1, 2, 2.5, 3.5, 4.5, 5]);
  assert.deepEqual([0, 3, 5, 6].map((j) => T.local(j)), [0, 0, 2, 0]);
  // Each chunk ends exactly where the next one starts.
  for (let j = 0; j < 7; j++) {
    assert.equal(T.chunkStart(j) + T.chunkLength(T.local(j)) / T.sampleRate, T.chunkStart(j + 1));
  }
});

test("position lookup and wrapping", () => {
  assert.deepEqual([0, 0.99, 1, 2.4, 99].map((p) => T.chunkAt(p)), [0, 0, 1, 2, 2]);
  assert.ok(Math.abs(T.wrap(2.7) - 0.2) < 1e-9);
  assert.ok(Math.abs(T.wrap(-0.5) - 2.0) < 1e-9);
});

test("frame rounding lands on sample frames", () => {
  assert.equal(T.frame(1.234), 1.2);
});

test("rejects a chunk count that does not cover the song", () => {
  assert.throws(() => new Timeline({ sampleRate: 10, length: 25, chunkSamples: 10, chunkCount: 2 }));
});
