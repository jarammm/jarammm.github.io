// Unit tests for the controller state. Run: node --test "stage-generator/tests/*.test.mjs"
import test from "node:test";
import assert from "node:assert/strict";
import { ControllerState, MODES, gridSize } from "../state.js";

const IDS = ["vocals", "drums", "bass", "keys"];

test("gridSize picks the smallest square", () => {
  assert.deepEqual([1, 2, 4, 5, 9, 10, 16].map(gridSize), [1, 2, 2, 3, 3, 4, 4]);
  assert.throws(() => gridSize(0));
});

test("subtract mode starts from the full mix and removes selected stems", () => {
  const s = new ControllerState(IDS, MODES.SUBTRACT);
  assert.equal(s.mask(), "1111");
  s.toggle("drums");
  assert.deepEqual(s.audible(), ["vocals", "bass", "keys"]);
  assert.equal(s.mask(), "1011");
});

test("add mode starts from silence and plays only selected stems", () => {
  const s = new ControllerState(IDS, MODES.ADD);
  assert.equal(s.mask(), "0000");
  s.toggle("bass");
  s.toggle("vocals");
  assert.deepEqual(s.audible(), ["vocals", "bass"]);
  assert.equal(s.mask(), "1010");
});

test("pressing twice deselects", () => {
  const s = new ControllerState(IDS, MODES.ADD);
  assert.equal(s.toggle("keys"), true);
  assert.equal(s.toggle("keys"), false);
  assert.equal(s.mask(), "0000");
});

test("switching mode clears the selection", () => {
  const s = new ControllerState(IDS, MODES.ADD);
  s.toggle("keys");
  s.setMode(MODES.SUBTRACT);
  assert.deepEqual(s.snapshot().selected, []);
  assert.equal(s.mask(), "1111");
});

test("rejects unknown ids, modes and duplicate stems", () => {
  const s = new ControllerState(IDS);
  assert.throws(() => s.toggle("nope"));
  assert.throws(() => s.setMode("mute"));
  assert.throws(() => new ControllerState(["a", "a"]));
});
