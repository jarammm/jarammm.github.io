// Loads a song's stems (and optional base recordings) from local files or a URL, guided by stems.json.
// Song audio never needs to live in the public site: the operator picks files locally or a server provides them.

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

/**
 * Validate and fill defaults. Throws with a readable message on bad input.
 * @param {object} m  parsed stems.json
 * @returns {object}  manifest with every stem having id, label, color, file, group (or null), level_db (or null);
 *                    bases maps pool name -> file for the pools that have a base recording
 */
export function normalizeManifest(m) {
  if (!m || !Array.isArray(m.stems) || m.stems.length === 0) throw new Error(`${MANIFEST_NAME}: "stems" must be a non-empty array`);
  if (m.stems.length > MAX_STEMS) throw new Error(`${MANIFEST_NAME}: at most ${MAX_STEMS} stems`);
  const stems = m.stems.map((s, i) => {
    if (!s.file) throw new Error(`${MANIFEST_NAME}: stem #${i + 1} has no "file"`);
    if (s.group != null && !GROUP_NAMES.includes(s.group)) {
      throw new Error(`${MANIFEST_NAME}: stem #${i + 1} group must be one of ${GROUP_NAMES.join(", ")}`);
    }
    const id = s.id ?? basename(s.file).replace(/\.[^.]+$/, "");
    return {
      id: String(id), label: s.label ?? String(id), color: s.color ?? PALETTE[i % PALETTE.length], file: s.file,
      group: s.group ?? null, level_db: Number.isFinite(s.level_db) ? s.level_db : null,
    };
  });
  const dup = stems.map((s) => s.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new Error(`${MANIFEST_NAME}: duplicate stem id "${dup}"`);
  const bases = {};
  for (const [pool, file] of Object.entries(m.bases ?? {})) {
    if (!POOL_NAMES.includes(pool)) throw new Error(`${MANIFEST_NAME}: unknown base "${pool}"`);
    if (file) bases[pool] = String(file);
  }
  const sections = (m.sections ?? []).map((s) => ({ name: String(s.name), start: Number(s.start), end: Number(s.end) }));
  return {
    title: m.title ?? "Untitled",
    bpm: m.bpm ? Number(m.bpm) : null,
    beats_per_bar: m.beats_per_bar ? Number(m.beats_per_bar) : 4,
    beats: numList(m.beats),
    downbeats: numList(m.downbeats),
    sections,
    bases,
    stems,
  };
}

/** Build a manifest from bare audio file names when no stems.json is given (pad order = name order). */
export function manifestFromNames(names) {
  const audio = names.filter((n) => AUDIO_EXT.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return normalizeManifest({ title: "Local stems", stems: audio.map((file) => ({ file })) });
}

/** Every file the manifest needs: stems then bases. */
export function manifestFiles(manifest) {
  return [...manifest.stems.map((s) => s.file), ...Object.values(manifest.bases)];
}

export function codecWarnings(manifest) {
  const lossy = manifestFiles(manifest).filter((f) => DELAY_PRONE_EXT.test(f));
  return lossy.length
    ? [`Lossy files may be misaligned by encoder delay: ${lossy.join(", ")}. Prefer WAV or FLAC.`]
    : [];
}

async function decodeAll(ctx, manifest, fetchBytes) {
  const decode = async (file) => {
    const bytes = await fetchBytes(file);
    try {
      return await ctx.decodeAudioData(bytes);
    } catch (e) {
      throw new Error(`could not decode ${file}: ${e.message}`);
    }
  };
  const [stems, bases] = await Promise.all([
    Promise.all(manifest.stems.map(async (s) => ({ ...s, buffer: await decode(s.file) }))),
    Promise.all(Object.entries(manifest.bases).map(async ([pool, file]) => ({ pool, file, buffer: await decode(file) }))),
  ]);
  return { manifest, stems, bases, warnings: codecWarnings(manifest) };
}

/**
 * Load from a FileList (folder picker, multi-file picker or drag-and-drop).
 * stems.json is optional; files are matched by base name.
 */
export async function loadFromFiles(ctx, fileList) {
  const files = [...fileList];
  const byName = new Map(files.map((f) => [basename(f.webkitRelativePath || f.name), f]));
  const mf = byName.get(MANIFEST_NAME);
  const manifest = mf ? normalizeManifest(JSON.parse(await mf.text())) : manifestFromNames([...byName.keys()]);
  if (!manifest.stems.length) throw new Error("no audio files found");
  const missing = manifestFiles(manifest).filter((f) => !byName.has(basename(f)));
  if (missing.length) throw new Error(`missing files: ${missing.join(", ")}`);
  return decodeAll(ctx, manifest, (file) => byName.get(basename(file)).arrayBuffer());
}

/** Load from a stems.json URL; file paths resolve relative to it. */
export async function loadFromUrl(ctx, manifestUrl) {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`${manifestUrl}: HTTP ${res.status}`);
  const manifest = normalizeManifest(await res.json());
  return decodeAll(ctx, manifest, async (file) => {
    const url = new URL(file, new URL(manifestUrl, location.href));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
}
