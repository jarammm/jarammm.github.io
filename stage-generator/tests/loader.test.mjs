// Tests for manifest validation and the no-manifest fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeManifest, manifestFromNames, manifestFiles, codecWarnings } from "../loader.js";

test("fills id, label and color defaults from the file name", () => {
  const m = normalizeManifest({ stems: [{ file: "stems/vocals.wav" }, { id: "ens", file: "ensemble.flac", label: "Ensemble" }] });
  assert.deepEqual(m.stems.map((s) => [s.id, s.label]), [["vocals", "vocals"], ["ens", "Ensemble"]]);
  assert.ok(m.stems.every((s) => /^#/.test(s.color)));
  assert.equal(m.bpm, null);
});

test("rejects empty, file-less and duplicate stems", () => {
  assert.throws(() => normalizeManifest({ stems: [] }));
  assert.throws(() => normalizeManifest({ stems: [{ id: "a" }] }));
  assert.throws(() => normalizeManifest({ stems: [{ file: "a.wav" }, { file: "x/a.wav" }] }), /duplicate/);
});

test("without stems.json, audio files become pads in natural name order", () => {
  const m = manifestFromNames(["10_fx.wav", "2_bass.wav", "notes.txt", "1_vocals.flac"]);
  assert.deepEqual(m.stems.map((s) => s.file), ["1_vocals.flac", "2_bass.wav", "10_fx.wav"]);
});

test("warns about delay-prone lossy codecs only", () => {
  assert.equal(codecWarnings(normalizeManifest({ stems: [{ file: "a.wav" }, { file: "b.flac" }] })).length, 0);
  assert.match(codecWarnings(normalizeManifest({ stems: [{ file: "a.mp3" }] }))[0], /a\.mp3/);
});

test("reads groups, levels, beats and base recordings", () => {
  const m = normalizeManifest({
    stems: [{ id: "v", file: "v.flac", group: "vocals", level_db: -6.5 }, { file: "b.flac", group: "accompaniment" }],
    bases: { mix: "base_mix.flac", vocals: "base_vocals.flac" },
    beats: [2, 1, "x", 3], downbeats: [1],
  });
  assert.deepEqual(m.stems.map((s) => [s.group, s.level_db]), [["vocals", -6.5], ["accompaniment", null]]);
  assert.deepEqual(m.bases, { mix: "base_mix.flac", vocals: "base_vocals.flac" });
  assert.deepEqual(m.beats, [1, 2, 3]);
  assert.deepEqual(manifestFiles(m), ["v.flac", "b.flac", "base_mix.flac", "base_vocals.flac"]);
});

test("rejects unknown groups and bases", () => {
  assert.throws(() => normalizeManifest({ stems: [{ file: "a.wav", group: "drums" }] }), /group/);
  assert.throws(() => normalizeManifest({ stems: [{ file: "a.wav" }], bases: { drums: "d.wav" } }), /base/);
});
