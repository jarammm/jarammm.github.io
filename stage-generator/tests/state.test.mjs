// Unit tests for the controller state. Run: node --test "stage-generator/tests/*.test.mjs"
import test from "node:test";
import assert from "node:assert/strict";
import { ControllerState, MODES, POOLS, gridSize } from "../state.js";

const STEMS = [
  { id: "vocals", group: "vocals" },
  { id: "ensemble", group: "vocals" },
  { id: "drums", group: "accompaniment" },
  { id: "bass", group: "accompaniment" },
];
const ALL_BASES = ["mix", "accompaniment", "vocals"];

test("gridSize picks the smallest square", () => {
  assert.deepEqual([1, 2, 4, 5, 9, 10, 16].map(gridSize), [1, 2, 2, 3, 3, 4, 4]);
  assert.throws(() => gridSize(0));
});

test("subtract from a recorded base: base at +1, pressed stems at -1", () => {
  const s = new ControllerState(STEMS, { mode: MODES.SUBTRACT, pool: POOLS.MIX, bases: ALL_BASES });
  assert.deepEqual(s.gains(), { stems: { vocals: 0, ensemble: 0, drums: 0, bass: 0 },
                                bases: { mix: 1, accompaniment: 0, vocals: 0 } });
  s.toggle("drums");
  assert.equal(s.gains().stems.drums, -1);
  assert.equal(s.base(), "mix");
});

test("subtract inside a pool uses that pool's base and ignores pads outside it", () => {
  const s = new ControllerState(STEMS, { pool: POOLS.ACCOMPANIMENT, bases: ALL_BASES });
  assert.equal(s.toggle("vocals"), false);       // not in the accompaniment pool
  s.toggle("bass");
  const g = s.gains();
  assert.deepEqual(g.bases, { mix: 0, accompaniment: 1, vocals: 0 });
  assert.deepEqual(g.stems, { vocals: 0, ensemble: 0, drums: 0, bass: -1 });
});

test("subtract without a recorded base sums the unpressed pool stems", () => {
  const s = new ControllerState(STEMS, { pool: POOLS.VOCALS });
  assert.deepEqual(s.gains().stems, { vocals: 1, ensemble: 1, drums: 0, bass: 0 });
  s.toggle("ensemble");
  assert.deepEqual(s.gains().stems, { vocals: 1, ensemble: 0, drums: 0, bass: 0 });
  assert.equal(s.base(), null);
});

test("add mode starts from silence and plays only pressed pool stems", () => {
  const s = new ControllerState(STEMS, { mode: MODES.ADD, pool: POOLS.VOCALS, bases: ALL_BASES });
  assert.deepEqual(Object.values(s.gains().bases), [0, 0, 0]);
  s.toggle("vocals");
  s.toggle("drums");                             // outside the pool: ignored
  assert.deepEqual(s.gains().stems, { vocals: 1, ensemble: 0, drums: 0, bass: 0 });
  assert.equal(s.mask(s.audible()), "1000");
});

test("pressing twice deselects; switching method or pool clears", () => {
  const s = new ControllerState(STEMS, { mode: MODES.ADD });
  assert.equal(s.toggle("bass"), true);
  assert.equal(s.toggle("bass"), false);
  s.toggle("bass");
  s.setPool(POOLS.ACCOMPANIMENT);
  assert.deepEqual(s.snapshot().selected, []);
  s.toggle("bass");
  s.setMode(MODES.SUBTRACT);
  assert.deepEqual(s.snapshot().selected, []);
});

test("snapshot carries the setting, pressed mask and gains", () => {
  const s = new ControllerState(STEMS, { mode: MODES.SUBTRACT, pool: POOLS.MIX, bases: ALL_BASES });
  s.toggle("ensemble");
  const snap = s.snapshot();
  assert.equal(snap.selected_mask, "0100");
  assert.equal(snap.mask, "1011");
  assert.equal(snap.base, "mix");
  assert.equal(snap.gains.stems.ensemble, -1);
});

test("rejects unknown ids, modes, pools, empty pools and duplicate stems", () => {
  const s = new ControllerState(STEMS);
  assert.throws(() => s.toggle("nope"));
  assert.throws(() => s.setMode("mute"));
  assert.throws(() => s.setPool("drums"));
  assert.throws(() => new ControllerState([{ id: "a", group: "accompaniment" }], { pool: POOLS.VOCALS }));
  assert.throws(() => new ControllerState([{ id: "a" }, { id: "a" }]));
});
