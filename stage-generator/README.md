# Stage Generator

An n×n pad controller for live stem mixing. Each pad is one stem (an instrument or a voice part).
Pressing a pad selects it; pressing it again deselects it. The page plays the result through Web Audio
and can report it to a show bridge that drives real-time visuals. It is a static page: songs stream from
`audio/` next to it, chunk by chunk.

## Settings: method × pool

| Method | Start state | A pressed pad… |
|---|---|---|
| **Subtract** | the pool's base | removes its stem (played at gain −1 against the base) |
| **Add** | silence | adds its stem |

| Pool | Pads that act | Base for Subtract (in the published songs) |
|---|---|---|
| **Mix** | every stem | the original recording |
| **Accompaniment** | stems with `group: "accompaniment"` | original recording − vocals |
| **Vocals** | stems with `group: "vocals"` | vocals |

Pads outside the pool are disabled. A base is a signed sum of sources declared in the manifest; without one,
Subtract starts from the sum of the pool's stems. Separated stems rarely add up to the recording, so
"recording − stem" keeps whatever the separation missed. Switching method or pool clears the selection.

## Playback

- Every source plays chunk after chunk on one clock and loops at the end of the song. Pressing a pad only ramps
  gains (~0.1 s), so audio never pauses.
- Chunks meet exactly on sample frames, and the context runs at the song's own sample rate, so subtraction
  cancels sample by sample. A chunk that arrives late joins at its place on the clock instead of shifting.
- Only the playing chunk and the next two are held in memory, so song length does not matter.
- The seek bar jumps anywhere (short fade out/in); the strip under it shows the song's sections, and clicking
  one jumps to its start. Stop then Start resumes where it stopped.
- Quantize (off / beat / bar) applies a change on the next beat or downbeat of the song's beat track
  (`beats`/`downbeats`), or of a constant `bpm` grid when the song has none.
- The meter under the grid has one bar per pad (same colour and order): the stem's level in what is heard now,
  from −60 dBFS to 0 dBFS, and empty when the stem is out of the output (removed, or not added).
  Each pad's glow follows the same level.

## Songs

The song picker reads `audio/songs.json`. The published set is three numbers from cast recordings; see
Copyright. Every song has one vocals stem (the separated voice, not split into singers); the accompaniment
pads differ per song. Beetlejuice has 9: vocals; drums, bass, piano and guitar from demucs (6 stems); and
bowed strings, woodwind, brass and other, split from demucs' "other" by MVSep's family models. Wicked
still has the earlier 9 (vocals and 8 Mega 53 instrument classes) until its MVSep split is done. Lizzie
has 4: vocals, and drums, bass and guitar from demucs (4 stems; "guitar" is its "other" stem). Demucs'
leftover "vocals" stem is never a pad. `?songs=<url>` points the picker at another list, `?stems=<url of stems.json>` opens one song.

"Other sources (for development)" at the bottom loads a synthesized nine-stem demo or local stems held in
memory (a folder with `stems.json`, or audio files that become pads in name order).

### `stems.json` (streamed)

```json
{
  "title": "Wicked - No One Mourns the Wicked",
  "credits": { "work": "Wicked", "song": "…", "performers": "…", "music": "…", "lyrics": "…",
               "source_url": "https://www.youtube.com/watch?v=…", "notice": "…" },
  "bpm": 96, "beats_per_bar": 4, "beats": [0.41, 1.05], "downbeats": [0.41, 3.02],
  "sections": [{ "name": "verse1", "start": 0.0, "end": 32.5 }],
  "sample_rate": 44100, "length": 17663520,
  "chunks": { "samples": 882000, "count": 21, "path": "{id}/{k}.flac" },
  "recordings": [{ "id": "mix", "label": "Original mix" }],
  "bases": { "mix": { "rec:mix": 1 },
             "accompaniment": { "rec:mix": 1, "vocals": -1, "ensemble": -1 },
             "vocals": { "vocals": 1, "ensemble": 1 } },
  "stems": [
    { "id": "vocals", "label": "Vocals", "group": "vocals", "color": "#f472b6", "level_db": -6.8 },
    { "id": "brass",  "label": "Brass",  "group": "accompaniment" }
  ]
}
```

Chunk `k` of source `id` is `<id>/<k>.flac` (recordings use their own id, e.g. `mix/0.flac`). Every chunk is
`chunks.samples` long except the last. Pad order follows `stems` (row-major), and so does the mask bit order.
`level_db` (stem level vs the mix) is shown on the pad; below −60 dB the pad reads "silent".
A per-file layout (`file` on every stem and recording, no `chunks`) also works and is loaded whole.
Keyboard shortcuts follow the pad order: `1`–`0`, then `Q`… (physical keys, so they work with any IME).

### Building the set

`tools/build_listening_set.py` builds the songs from the lab's `musical-textsetting` outputs into
`stage-generator/audio/` (FLAC, about 350 MB for three songs). The accompaniment is split per song, either
by htdemucs_6s with its "other" split again by MVSep's Brass, Woodwind and Bowed Strings models in a chain
(`musical-textsetting/temp/vocal_sep/mvsep_families.py`, which uploads to mvsep.com with the account token in
`~/.config/mvsep/token`), or by htdemucs_ft's 4 stems. Run it with `uv run`; `--build <song>` rebuilds only
that song. Its header documents how the stems are scaled onto the original mix and how the bases are formed.

### Copyright

The songs in `audio/` are cast recordings downloaded from YouTube: *Beetlejuice* "Say My Name" and *Wicked*
"No One Mourns the Wicked" (official uploads), and *Lizzie* "Somebody Will Do Something" (a third-party
upload). All rights belong to the respective rights holders (composers, lyricists, performers and labels). Each song's
`stems.json` carries a `credits` block (work, song, performers, music, lyrics, source URL), and the page shows
it under the song title. The separated stems derived from them are for research listening only.

## Export mix

**Export mix** downloads what the current setting plays as a 16-bit WAV, for testing caption and generation
models offline.

- Range: always the whole song, whether playing or stopped. Only sources with a non-zero gain are fetched.
- Content: the target setting, i.e. what will sound once any quantized change lands.
- Mixing rule: sum of every source times its gain (+1, −1 or 0), no limiter. If the sum exceeds full scale,
  the whole file is scaled down instead of clipped, and the gain is written into the name.
  The show bridge renders with the same rule, so the same setting gives the same audio.
- Name: `<song>_<method>-<pool>_sel<pressed mask>[_gain<dB>dB].wav`,
  e.g. `wicked-no-one-mourns-the-wicked_subtract-mix_sel0000000010.wav`.
- Sample rate: the song's own (44.1 kHz for the published songs).

## Bridge protocol

Open with `?bridge=ws://<host>:<port>/<path>`. Without it the page runs standalone.
The client reconnects with backoff and replays the latest state after reconnecting. Messages are JSON:

```js
// on every change
{ "type": "state", "song": "…", "stems": ["vocals", …], "mode": "subtract" | "add",
  "pool": "mix" | "accompaniment" | "vocals", "base": "mix" | … | null,
  "selected": ["drums_perc"], "selected_mask": "0000000010", "audible": ["vocals", …], "mask": "1111111101",
  "gains": { "rec:mix": 1, "drums_perc": -1, … },
  "playhead_sec": 12.3, "section": "verse1", "apply_in_sec": 0.42, "ts": 1763540000.12 }

// ~30 Hz while playing
{ "type": "features", "rms": 0.18, "bands": [8 values in 0..1, low→high], "onset": 1.7,
  "levels": { "vocals": 0.66, "drums_perc": 0, … },
  "playhead_sec": 12.33, "section": "verse1", "ts": 1763540000.15 }
```

The audio itself is not sent. The bridge holds the same files and renders the result from `gains` and
`playhead_sec`, which keeps the link light and the result deterministic. `mask`/`audible` are the pool stems
that still sound, for display; with a recording as base they ignore what the separation missed.

`bands` are the output level in 8 log-spaced frequency bands from 40 Hz up. `levels` are the per-stem heard
levels shown by the meter (0..1). `onset` is the positive spectral flux divided by its running mean; values
well above 1 mark hits.

## Development

```bash
node --test "stage-generator/tests/*.test.mjs"   # state, timeline, demo, manifest and export logic
```

ES modules require serving over HTTP, not opening the file directly.
`window.stageGenerator` exposes the engine, song and state for console debugging.
