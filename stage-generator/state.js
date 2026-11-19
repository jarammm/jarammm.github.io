// Pure controller state: which pads are pressed, and the gain every source should have.
// Kept free of DOM and Web Audio so it can be unit-tested with `node --test`.
//
// A setting is method x pool:
//   method SUBTRACT: start from the pool's base; a pressed pad removes its stem (gain -1).
//                    A base is a signed sum of sources, e.g. accompaniment = rec:mix - vocals - ensemble.
//                    Without a base, the pool starts from the sum of its stems instead.
//   method ADD:      start from silence; a pressed pad adds its stem (gain +1).
//   pool:            which stems the pads act on -- all stems (mix), instrument stems (accompaniment)
//                    or voice stems (vocals). Pads outside the pool are inactive.

export const MODES = Object.freeze({ SUBTRACT: "subtract", ADD: "add" });
export const POOLS = Object.freeze({ MIX: "mix", ACCOMPANIMENT: "accompaniment", VOCALS: "vocals" });
export const GROUPS = Object.freeze({ ACCOMPANIMENT: "accompaniment", VOCALS: "vocals" });

// Keyboard shortcuts in pad order (row-major). Pads beyond this list get no key.
export const PAD_KEYS = "1234567890QWERTYUIOPASDFGHJKLZXCVBNM".split("");

/** Side length of the smallest square grid that holds `count` pads. */
export function gridSize(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid stem count: ${count}`);
  return Math.ceil(Math.sqrt(count));
}

/** Is a stem of this group part of the pool? Ungrouped stems belong to the mix pool only. */
export function inPool(group, pool) {
  return pool === POOLS.MIX || group === pool;
}

export class ControllerState {
  /**
   * @param {{id:string, group?:string}[]} stems  pad order; order defines the mask bit order
   * @param {{mode?:string, pool?:string, bases?:Object<string,Object<string,number>>}} opts
   *        bases: pool -> {source id: coefficient}; source ids are stem ids or recording ids ("rec:mix")
   */
  constructor(stems, { mode = MODES.SUBTRACT, pool = POOLS.MIX, bases = {} } = {}) {
    const ids = stems.map((s) => s.id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate stem ids");
    this.stems = stems.map((s) => ({ id: s.id, group: s.group ?? null }));
    this.stemIds = ids;
    this.bases = new Map(Object.entries(bases));
    // Every source any setting can touch, so gains() always reports all of them.
    this.sourceIds = [...new Set([...ids, ...[...this.bases.values()].flatMap((e) => Object.keys(e))])];
    this.selected = new Set();
    this.mode = MODES.SUBTRACT;
    this.pool = POOLS.MIX;
    this.setMode(mode);
    this.setPool(pool);
  }

  /** Pools that have at least one stem. */
  availablePools() {
    return Object.values(POOLS).filter((p) => this.stems.some((s) => inPool(s.group, p)));
  }

  /** Switching method clears the selection so the result is the method's start state. */
  setMode(mode) {
    if (!Object.values(MODES).includes(mode)) throw new Error(`unknown mode: ${mode}`);
    this.mode = mode;
    this.selected.clear();
  }

  /** Switching pool clears the selection too: pressed pads may not exist in the new pool. */
  setPool(pool) {
    if (!Object.values(POOLS).includes(pool)) throw new Error(`unknown pool: ${pool}`);
    if (!this.availablePools().includes(pool)) throw new Error(`no stems in pool: ${pool}`);
    this.pool = pool;
    this.selected.clear();
  }

  isActive(id) {
    const s = this.stems.find((x) => x.id === id);
    if (!s) throw new Error(`unknown stem: ${id}`);
    return inPool(s.group, this.pool);
  }

  /** Flip one pad. Pads outside the pool do nothing. Returns the new selected flag. */
  toggle(id) {
    if (!this.isActive(id)) return false;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    return this.selected.has(id);
  }

  clear() {
    this.selected.clear();
  }

  /** The base recording in use, or null (add mode, or subtract without a recorded base). */
  base() {
    return this.mode === MODES.SUBTRACT && this.bases.has(this.pool) ? this.pool : null;
  }

  /**
   * Gain for every source (stems and recordings).
   * @returns {Object<string,number>}  source id -> gain, e.g. {"rec:mix": 1, vocals: -1, ...}
   */
  gains() {
    const g = Object.fromEntries(this.sourceIds.map((id) => [id, 0]));
    const base = this.base();
    if (base) for (const [id, c] of Object.entries(this.bases.get(base))) g[id] += c;
    for (const { id, group } of this.stems) {
      if (!inPool(group, this.pool)) continue;
      const sel = this.selected.has(id);
      if (this.mode === MODES.ADD) g[id] += sel ? 1 : 0;
      else if (base) g[id] -= sel ? 1 : 0;    // base - pressed stems
      else g[id] += sel ? 0 : 1;              // no base: sum of unpressed stems
    }
    return g;
  }

  /** Pool stems that still sound (approximately, for display): pressed in add mode, unpressed in subtract mode. */
  audible() {
    return this.stems
      .filter(({ id, group }) => inPool(group, this.pool) && (this.mode === MODES.ADD) === this.selected.has(id))
      .map((s) => s.id);
  }

  /** '0'/'1' per pad in pad order. */
  mask(ids) {
    const set = new Set(ids);
    return this.stemIds.map((id) => (set.has(id) ? "1" : "0")).join("");
  }

  snapshot() {
    const selected = this.stemIds.filter((id) => this.selected.has(id));
    return {
      mode: this.mode,
      pool: this.pool,
      base: this.base(),
      selected,
      selected_mask: this.mask(selected),
      audible: this.audible(),
      mask: this.mask(this.audible()),
      gains: this.gains(),
    };
  }
}
