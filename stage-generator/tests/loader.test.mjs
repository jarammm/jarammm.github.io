// Tests for manifest validation and the no-manifest fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeManifest, normalizeCredits, manifestFromNames, manifestFiles, codecWarnings, sourceIds, chunkUrl, songFromBuffers } from "../loader.js";

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

test("reads groups, levels, beats; older string bases become recordings", () => {
  const m = normalizeManifest({
    stems: [{ id: "v", file: "v.flac", group: "vocals", level_db: -6.5 }, { file: "b.flac", group: "accompaniment" }],
    bases: { mix: "base_mix.flac", vocals: "base_vocals.flac" },
    beats: [2, 1, "x", 3], downbeats: [1],
  });
  assert.deepEqual(m.stems.map((s) => [s.group, s.level_db]), [["vocals", -6.5], ["accompaniment", null]]);
  assert.deepEqual(m.bases, { mix: { "rec:mix": 1 }, vocals: { "rec:vocals": 1 } });
  assert.deepEqual(m.beats, [1, 2, 3]);
  assert.deepEqual(manifestFiles(m), ["v.flac", "b.flac", "base_mix.flac", "base_vocals.flac"]);
  assert.deepEqual(sourceIds(m), ["v", "b", "rec:mix", "rec:vocals"]);
});

test("chunked manifests: no per-stem files, signed-sum bases, chunk URLs", () => {
  const m = normalizeManifest({
    sample_rate: 44100, length: 100, chunks: { samples: 40, count: 3, path: "{id}/{k}.flac" },
    recordings: [{ id: "mix" }],
    bases: { mix: { "rec:mix": 1 }, accompaniment: { "rec:mix": 1, v: -1 } },
    stems: [{ id: "v", group: "vocals" }, { id: "b", group: "accompaniment" }],
  });
  assert.deepEqual(m.bases.accompaniment, { "rec:mix": 1, v: -1 });
  assert.equal(chunkUrl(m, "https://x.test/audio/song/stems.json", "rec:mix", 2), "https://x.test/audio/song/mix/2.flac");
  assert.equal(chunkUrl(m, "https://x.test/audio/song/stems.json", "v", 0), "https://x.test/audio/song/v/0.flac");
  assert.throws(() => normalizeManifest({ chunks: { samples: 40, count: 3 }, stems: [{ id: "v" }] }), /sample_rate/);
  assert.throws(() => normalizeManifest({ sample_rate: 1, length: 1, chunks: { samples: 1, count: 1 },
    stems: [{ id: "v" }], bases: { mix: { "rec:nope": 1 } } }), /unknown source/);
});

test("in-memory songs are one chunk at the shortest length, with a warning on mismatch", () => {
  const m = normalizeManifest({ stems: [{ file: "a.wav" }, { file: "b.wav" }] });
  const buf = (n) => ({ length: n, sampleRate: 1000 });
  const song = songFromBuffers(m, { a: buf(1000), b: buf(1500) });
  assert.deepEqual(song.timeline, { sampleRate: 1000, length: 1000, chunkSamples: 1000, chunkCount: 1 });
  assert.match(song.warnings[0], /differ by 500\.0 ms/);
});

test("rejects unknown groups and bases", () => {
  assert.throws(() => normalizeManifest({ stems: [{ file: "a.wav", group: "drums" }] }), /group/);
  assert.throws(() => normalizeManifest({ stems: [{ file: "a.wav" }], bases: { drums: "d.wav" } }), /unknown base/);
});

test("credits keep plain strings and only http(s) source links", () => {
  const c = normalizeCredits({ work: " Wicked ", song: "No One Mourns", source_url: "javascript:alert(1)", music: 3 });
  assert.deepEqual([c.work, c.song, c.source_url, c.music], ["Wicked", "No One Mourns", null, null]);
  assert.equal(normalizeCredits({ source_url: "https://www.youtube.com/watch?v=x" }).source_url, "https://www.youtube.com/watch?v=x");
  assert.equal(normalizeCredits(undefined), null);
});
