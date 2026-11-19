// Pure controller state: which pads are selected and which stems are audible.
// Kept free of DOM and Web Audio so it can be unit-tested with `node --test`.

export const MODES = Object.freeze({
  SUBTRACT: "subtract", // start from the full mix; a selected pad removes its stem
  ADD: "add",           // start from silence; a selected pad adds its stem
});

// Keyboard shortcuts in pad order (row-major). Pads beyond this list get no key.
export const PAD_KEYS = "1234567890QWERTYUIOPASDFGHJKLZXCVBNM".split("");

/** Side length of the smallest square grid that holds `count` pads. */
export function gridSize(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid stem count: ${count}`);
  return Math.ceil(Math.sqrt(count));
}

export class ControllerState {
  /**
   * @param {string[]} stemIds  stem ids in pad order; order defines the mask bit order
   * @param {string} mode       one of MODES
   */
  constructor(stemIds, mode = MODES.SUBTRACT) {
    if (new Set(stemIds).size !== stemIds.length) throw new Error("duplicate stem ids");
    this.stemIds = [...stemIds];
    this.selected = new Set();
    this.setMode(mode);
  }

  /** Switching mode clears the selection so the result is the mode's start state. */
  setMode(mode) {
    if (!Object.values(MODES).includes(mode)) throw new Error(`unknown mode: ${mode}`);
    this.mode = mode;
    this.selected.clear();
  }

  /** Flip one pad. Returns the new selected flag for that pad. */
  toggle(id) {
    if (!this.stemIds.includes(id)) throw new Error(`unknown stem: ${id}`);
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    return this.selected.has(id);
  }

  clear() {
    this.selected.clear();
  }

  isAudible(id) {
    const sel = this.selected.has(id);
    return this.mode === MODES.ADD ? sel : !sel;
  }

  /** Audible stem ids in pad order. */
  audible() {
    return this.stemIds.filter((id) => this.isAudible(id));
  }

  /** Audible set as a '0'/'1' string in pad order, e.g. "1011". Used as a cache key downstream. */
  mask() {
    return this.stemIds.map((id) => (this.isAudible(id) ? "1" : "0")).join("");
  }

  snapshot() {
    return {
      mode: this.mode,
      selected: this.stemIds.filter((id) => this.selected.has(id)),
      audible: this.audible(),
      mask: this.mask(),
    };
  }
}
