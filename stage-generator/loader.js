// Loads a song described by stems.json and returns it in one shape for the engine, whether the audio is
// streamed in chunks from a server or held whole in memory (demo, local files, single-file manifests):
//   { manifest, timeline, sources: [{id}], getChunk(ctx, id, k) -> Promise<AudioBuffer>, warnings }
// Source ids are stem ids, and "rec:<id>" for recordings (e.g. the original mix).

export const MANIFEST_NAME = "stems.json";
const AUDIO_EXT = /\.(wav|flac|aif|aiff|ogg|opus|webm|mp3|m4a|aac)$/i;
// Lossy codecs add encoder delay/padding that browsers do not always trim, which shifts stems apart.
const DELAY_PRONE_EXT = /\.(mp3|m4a|aac)$/i;
const PALETTE = ["#f472b6", "#c084fc", "#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#60a5fa", "#a3a3a3",
                 "#e879f9", "#34d399", "#fbbf24", "#38bdf8", "#f43f5e", "#a78bfa", "#84cc16"];
const MAX_STEMS = PALETTE.length * 4;
const POOL_NAMES = ["mix", "accompaniment", "vocals"];
const GROUP_NAMES = ["accompaniment", "vocals"];

const basename = (p) => p.split(/[\\/]/).pop();
const numList = (xs) => (Array.isArray(xs) ? xs.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : []);
export const recId = (id) => `rec:${id}`;

/**
 * Attribution for recorded material: plain strings only, and a source link only if it is http(s),
 * since the page renders it as a link.
 * @returns {object|null}  {work, song, performers, album, music, lyrics, source_url, notice} or null
 */
export function normalizeCredits(c) {
  if (!c || typeof c !== "object") return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const url = str(c.source_url);
  return {
    work: str(c.work), song: str(c.song), performers: str(c.performers), album: str(c.album),
    music: str(c.music), lyrics: str(c.lyrics), notice: str(c.notice),
    source_url: url && /^https?:\/\//i.test(url) ? url : null,
  };
}

/**
 * Validate and fill defaults. Throws with a readable message on bad input.
 * Two layouts:
 *   chunked  : `chunks: {samples, count, path:"{id}/{k}.flac"}` with `sample_rate` and `length`; files are implied.
 *   per-file : every stem and recording has `file`.
 * `bases` maps a pool to a signed sum of sources ({"rec:mix": 1, "vocals": -1}). The older form
 * `bases: {pool: "file"}` is read as a recording named after the pool.
 * @param {{requireFiles?:boolean}} opts  false for audio already in memory (e.g. the synthesized demo)
 * @returns {object}  normalized manifest
 */
export function normalizeManifest(m, { requireFiles = true } = {}) {
  if (!m || !Array.isArray(m.stems) || m.stems.length === 0) throw new Error(`${MANIFEST_NAME}: "stems" must be a non-empty array`);
  if (m.stems.length > MAX_STEMS) throw new Error(`${MANIFEST_NAME}: at most ${MAX_STEMS} stems`);
  const chunked = m.chunks != null;
  const needFile = requireFiles && !chunked;
  if (chunked) {
    const c = m.chunks;
    if (!(c.samples > 0 && c.count > 0 && m.sample_rate > 0 && m.length > 0)) {
      throw new Error(`${MANIFEST_NAME}: chunked songs need chunks.samples, chunks.count, sample_rate and length`);
    }
  }
  const stems = m.stems.map((s, i) => {
    if (needFile && !s.file) throw new Error(`${MANIFEST_NAME}: stem #${i + 1} has no "file"`);
    if (s.group != null && !GROUP_NAMES.includes(s.group)) {
      throw new Error(`${MANIFEST_NAME}: stem #${i + 1} group must be one of ${GROUP_NAMES.join(", ")}`);
    }
    const id = s.id ?? (s.file ? basename(s.file).replace(/\.[^.]+$/, "") : null);
    if (!id) throw new Error(`${MANIFEST_NAME}: stem #${i + 1} has no "id"`);
    return {
      id: String(id), label: s.label ?? String(id), color: s.color ?? PALETTE[i % PALETTE.length], file: s.file ?? null,
      group: s.group ?? null, level_db: Number.isFinite(s.level_db) ? s.level_db : null,
    };
  });
  const dup = stems.map((s) => s.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new Error(`${MANIFEST_NAME}: duplicate stem id "${dup}"`);

  const recordings = (m.recordings ?? []).map((r) => {
    if (!r?.id) throw new Error(`${MANIFEST_NAME}: a recording has no "id"`);
    if (needFile && !r.file) throw new Error(`${MANIFEST_NAME}: recording "${r.id}" has no "file"`);
    return { id: String(r.id), label: r.label ?? String(r.id), file: r.file ?? null };
  });
  const bases = {};
  for (const [pool, def] of Object.entries(m.bases ?? {})) {
    if (!POOL_NAMES.includes(pool)) throw new Error(`${MANIFEST_NAME}: unknown base "${pool}"`);
    if (typeof def === "string") {                     // older form: one recorded file per pool
      if (!recordings.some((r) => r.id === pool)) recordings.push({ id: pool, label: pool, file: def });
      bases[pool] = { [recId(pool)]: 1 };
    } else if (def && typeof def === "object") {
      bases[pool] = Object.fromEntries(Object.entries(def).map(([k, v]) => [k, Number(v)]));
    }
  }
  const known = new Set([...stems.map((s) => s.id), ...recordings.map((r) => recId(r.id))]);
  for (const [pool, expr] of Object.entries(bases)) {
    for (const [ref, c] of Object.entries(expr)) {
      if (!known.has(ref)) throw new Error(`${MANIFEST_NAME}: base "${pool}" refers to unknown source "${ref}"`);
      if (!Number.isFinite(c)) throw new Error(`${MANIFEST_NAME}: base "${pool}" has a non-numeric coefficient`);
    }
  }
  const sections = (m.sections ?? []).map((s) => ({ name: String(s.name), start: Number(s.start), end: Number(s.end) }));
  return {
    title: m.title ?? "Untitled",
    credits: normalizeCredits(m.credits),
    bpm: m.bpm ? Number(m.bpm) : null,
    beats_per_bar: m.beats_per_bar ? Number(m.beats_per_bar) : 4,
    beats: numList(m.beats),
    downbeats: numList(m.downbeats),
    sections,
    chunks: chunked
      ? { samples: Number(m.chunks.samples), count: Number(m.chunks.count), path: String(m.chunks.path ?? "{id}/{k}.flac") }
      : null,
    sample_rate: m.sample_rate ? Number(m.sample_rate) : null,
    length: m.length ? Number(m.length) : null,
    recordings,
    bases,
    stems,
  };
}

/** Build a manifest from bare audio file names when no stems.json is given (pad order = name order). */
export function manifestFromNames(names) {
  const audio = names.filter((n) => AUDIO_EXT.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return normalizeManifest({ title: "Local stems", stems: audio.map((file) => ({ file })) });
}

/** Files of a per-file manifest: stems then recordings. */
export function manifestFiles(manifest) {
  return [...manifest.stems.map((s) => s.file), ...manifest.recordings.map((r) => r.file)].filter(Boolean);
}

export function codecWarnings(manifest) {
  const lossy = manifestFiles(manifest).filter((f) => DELAY_PRONE_EXT.test(f));
  return lossy.length
    ? [`Lossy files may be misaligned by encoder delay: ${lossy.join(", ")}. Prefer WAV or FLAC.`]
    : [];
}

/** All source ids in engine order: stems, then recordings. */
export function sourceIds(manifest) {
  return [...manifest.stems.map((s) => s.id), ...manifest.recordings.map((r) => recId(r.id))];
}

/** URL of chunk k of a source in a chunked manifest. */
export function chunkUrl(manifest, baseUrl, id, k) {
  const dir = id.startsWith("rec:") ? id.slice(4) : id;
  return new URL(manifest.chunks.path.replace("{id}", encodeURIComponent(dir)).replace("{k}", String(k)), baseUrl).href;
}

/**
 * Wrap whole decoded buffers as a one-chunk song.
 * @param {object} manifest  normalized
 * @param {Object<string,AudioBuffer>} buffers  source id -> buffer
 */
export function songFromBuffers(manifest, buffers, warnings = []) {
  const ids = sourceIds(manifest);
  const lens = ids.map((id) => buffers[id].length);
  const rates = new Set(ids.map((id) => buffers[id].sampleRate));
  const minLen = Math.min(...lens);
  const maxLen = Math.max(...lens);
  const sampleRate = [...rates][0];
  const w = [...warnings];
  // decodeAudioData resamples to the context rate, so unequal source rates show up as unequal lengths.
  if (maxLen - minLen > sampleRate / 1000) {
    w.push(`Stem lengths differ by ${(((maxLen - minLen) / sampleRate) * 1000).toFixed(1)} ms; looping at the shortest ` +
           `(${(minLen / sampleRate).toFixed(3)} s). Export stems with identical start and length.`);
  }
  return {
    manifest,
    timeline: { sampleRate, length: minLen, chunkSamples: minLen, chunkCount: 1 },
    sources: ids.map((id) => ({ id })),
    getChunk: async (_ctx, id) => buffers[id],
    warnings: w,
  };
}

async function decode(ctx, bytes, name) {
  try {
    return await ctx.decodeAudioData(bytes);
  } catch (e) {
    throw new Error(`could not decode ${name}: ${e.message}`);
  }
}

async function decodeFiles(ctx, manifest, fetchBytes) {
  const entries = [
    ...manifest.stems.map((s) => [s.id, s.file]),
    ...manifest.recordings.map((r) => [recId(r.id), r.file]),
  ];
  const buffers = Object.fromEntries(await Promise.all(
    entries.map(async ([id, file]) => [id, await decode(ctx, await fetchBytes(file), file)])));
  return songFromBuffers(manifest, buffers, codecWarnings(manifest));
}

/**
 * Load from a FileList (folder picker, multi-file picker or drag-and-drop).
 * stems.json is optional; files are matched by base name. Chunked manifests are not supported here.
 */
export async function loadFromFiles(ctx, fileList) {
  const files = [...fileList];
  const byName = new Map(files.map((f) => [basename(f.webkitRelativePath || f.name), f]));
  const mf = byName.get(MANIFEST_NAME);
  const manifest = mf ? normalizeManifest(JSON.parse(await mf.text())) : manifestFromNames([...byName.keys()]);
  if (manifest.chunks) throw new Error("chunked songs stream from a URL; open the folder's stems.json via ?stems=");
  if (!manifest.stems.length) throw new Error("no audio files found");
  const missing = manifestFiles(manifest).filter((f) => !byName.has(basename(f)));
  if (missing.length) throw new Error(`missing files: ${missing.join(", ")}`);
  return decodeFiles(ctx, manifest, (file) => byName.get(basename(file)).arrayBuffer());
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/**
 * Load from a stems.json URL; paths resolve relative to it. Chunked songs return immediately and
 * fetch audio on demand; per-file songs are downloaded and decoded whole.
 */
export async function loadFromUrl(ctx, manifestUrl) {
  const base = new URL(manifestUrl, location.href);
  const res = await fetch(base);
  if (!res.ok) throw new Error(`${manifestUrl}: HTTP ${res.status}`);
  const manifest = normalizeManifest(await res.json());
  if (!manifest.chunks) return decodeFiles(ctx, manifest, (file) => fetchBytes(new URL(file, base)));
  const c = manifest.chunks;
  return {
    manifest,
    timeline: { sampleRate: manifest.sample_rate, length: manifest.length, chunkSamples: c.samples, chunkCount: c.count },
    sources: sourceIds(manifest).map((id) => ({ id })),
    // Decoding with a context at the song's own rate keeps chunks sample-exact (no per-chunk resampling).
    getChunk: async (decodeCtx, id, k) => {
      const url = chunkUrl(manifest, base, id, k);
      return decode(decodeCtx, await fetchBytes(url), url);
    },
    warnings: [],
  };
}
