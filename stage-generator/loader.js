// Loads a song's stems from a local folder/files or from a URL, guided by stems.json.
// Stems never need to live in the public site: the operator picks them locally or a show bridge serves them.

export const MANIFEST_NAME = "stems.json";
const AUDIO_EXT = /\.(wav|flac|aif|aiff|ogg|opus|webm|mp3|m4a|aac)$/i;
// Lossy codecs add encoder delay/padding that browsers do not always trim, which shifts stems apart.
const DELAY_PRONE_EXT = /\.(mp3|m4a|aac)$/i;
const PALETTE = ["#f472b6", "#c084fc", "#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#60a5fa", "#a3a3a3",
                 "#e879f9", "#34d399", "#fbbf24", "#38bdf8", "#f43f5e", "#a78bfa", "#84cc16"];
const MAX_STEMS = PALETTE.length * 4;

const basename = (p) => p.split(/[\\/]/).pop();

/**
 * Validate and fill defaults. Throws with a readable message on bad input.
 * @param {object} m  parsed stems.json
 * @returns {object}  manifest with every stem having id, label, color, file
 */
export function normalizeManifest(m) {
  if (!m || !Array.isArray(m.stems) || m.stems.length === 0) throw new Error(`${MANIFEST_NAME}: "stems" must be a non-empty array`);
  if (m.stems.length > MAX_STEMS) throw new Error(`${MANIFEST_NAME}: at most ${MAX_STEMS} stems`);
  const stems = m.stems.map((s, i) => {
    if (!s.file) throw new Error(`${MANIFEST_NAME}: stem #${i + 1} has no "file"`);
    const id = s.id ?? basename(s.file).replace(/\.[^.]+$/, "");
    return { id: String(id), label: s.label ?? String(id), color: s.color ?? PALETTE[i % PALETTE.length], file: s.file };
  });
  const dup = stems.map((s) => s.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new Error(`${MANIFEST_NAME}: duplicate stem id "${dup}"`);
  const sections = (m.sections ?? []).map((s) => ({ name: String(s.name), start: Number(s.start), end: Number(s.end) }));
  return {
    title: m.title ?? "Untitled",
    bpm: m.bpm ? Number(m.bpm) : null,
    beats_per_bar: m.beats_per_bar ? Number(m.beats_per_bar) : 4,
    sections,
    stems,
  };
}

/** Build a manifest from bare audio file names when no stems.json is given (pad order = name order). */
export function manifestFromNames(names) {
  const audio = names.filter((n) => AUDIO_EXT.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return normalizeManifest({ title: "Local stems", stems: audio.map((file) => ({ file })) });
}

export function codecWarnings(manifest) {
  const lossy = manifest.stems.filter((s) => DELAY_PRONE_EXT.test(s.file)).map((s) => s.file);
  return lossy.length
    ? [`Lossy files may be misaligned by encoder delay: ${lossy.join(", ")}. Prefer WAV or FLAC.`]
    : [];
}

async function decodeAll(ctx, manifest, fetchBytes) {
  const stems = await Promise.all(manifest.stems.map(async (s) => {
    const bytes = await fetchBytes(s.file);
    try {
      return { ...s, buffer: await ctx.decodeAudioData(bytes) };
    } catch (e) {
      throw new Error(`could not decode ${s.file}: ${e.message}`);
    }
  }));
  return { manifest, stems, warnings: codecWarnings(manifest) };
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
  const missing = manifest.stems.filter((s) => !byName.has(basename(s.file))).map((s) => s.file);
  if (missing.length) throw new Error(`missing files: ${missing.join(", ")}`);
  return decodeAll(ctx, manifest, (file) => byName.get(basename(file)).arrayBuffer());
}

/** Load from a stems.json URL; stem paths resolve relative to it. */
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
