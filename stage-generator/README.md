# Stage Generator

An n×n pad controller for live stem mixing. Each pad is one stem (an instrument or a voice part).
Pressing a pad selects it; pressing it again deselects it. The page plays the result through Web Audio
and can report it to a show bridge that drives real-time visuals.

## Settings: method × pool

| Method | Start state | A pressed pad… |
|---|---|---|
| **Subtract** | the pool's original recording | removes its stem (played at gain −1 against the recording) |
| **Add** | silence | adds its stem |

| Pool | Pads that act | Original recording for Subtract |
|---|---|---|
| **Mix** | every stem | `bases.mix` |
| **Accompaniment** | stems with `group: "accompaniment"` | `bases.accompaniment` |
| **Vocals** | stems with `group: "vocals"` | `bases.vocals` |

Pads outside the pool are disabled. If the manifest has no recording for a pool, Subtract starts from the
sum of that pool's stems instead. Separated stems rarely add up to the recording, so the two differ:
"recording − stem" keeps whatever the separation missed. Switching method or pool clears the selection.

## Playback guarantees

- All stems start on one clock and loop forever. Toggling only ramps gains (~0.1 s), so audio never pauses.
- Optional quantize applies a change on the next beat or bar (needs `bpm` in the manifest).
- Stems must share start time and length. Unequal lengths raise a warning and loop at the shortest.
  Prefer WAV/FLAC: MP3/AAC encoder delay can shift stems apart.

## Loading stems

- **Load demo**: nine synthesized stems (vocals, ensemble and seven instruments), no files needed.
- **Open stems folder… / Open files… / drag and drop**: local files. Include `stems.json` to set order,
  names and colors; without it, audio files become pads in name order.
- **`?stems=<url of stems.json>`**: fetch from a server. Stem paths resolve relative to the manifest.

Song stems do not need to be published with the site.

### `stems.json`

```json
{
  "title": "Song title",
  "bpm": 96,
  "beats_per_bar": 4,
  "beats": [0.41, 1.05],
  "downbeats": [0.41, 3.02],
  "sections": [{ "name": "verse1", "start": 0.0, "end": 32.5 }],
  "bases": { "mix": "base_mix.flac", "accompaniment": "base_accompaniment.flac", "vocals": "base_vocals.flac" },
  "stems": [
    { "id": "vocals",   "label": "Vocals",   "file": "vocals.flac",   "group": "vocals", "color": "#f472b6", "level_db": -6.8 },
    { "id": "ensemble", "label": "Ensemble", "file": "ensemble.flac", "group": "vocals" },
    { "id": "brass",    "label": "Brass",    "file": "brass.flac",    "group": "accompaniment" }
  ]
}
```

Only `stems[].file` is required. Pad order follows `stems` (row-major), and so does the mask bit order.
`beats`/`downbeats` (seconds) drive Quantize; without them a constant `bpm` grid is used.
`level_db` (stem level vs the mix) is shown on the pad; below −60 dB the pad reads "silent".
All files, bases included, must share start time and length so that subtraction cancels sample by sample.

### Copyright

The four excerpts in `audio/` are taken from official cast recordings downloaded from YouTube:
*Aladdin* "Friend Like Me", *Les Misérables* "One Day More", *The Phantom of the Opera*
"Masquerade / Why So Silent" and *Wicked* "No One Mourns the Wicked". All rights belong to the respective
rights holders (composers, lyricists, performers and labels). Each song's `stems.json` carries a `credits`
block (work, song, performers, music, lyrics, source URL), and the page shows it under the song title.
The separated stems derived from them are for research listening only.

### Song set

`tools/build_listening_set.py` builds 90 s excerpts of four musical numbers from the lab's
`musical-textsetting` outputs into `stage-generator/audio/` (FLAC, about 215 MB). The excerpts are cast
recordings under copyright, included here for research listening. When `audio/songs.json` exists next to
the page, a song picker appears and the first song loads (about 50 MB per song). Run it with `uv run`; the
script header documents how the stems are scaled onto the original mix.
Keyboard shortcuts follow the same order: `1`–`0`, then `Q`… (physical keys, so they work with any IME).

## Export mix

**Export mix** downloads what the current setting plays as a 16-bit WAV, for testing caption and generation
models offline.

- Range: always the whole loop, whether playing or stopped.
- Content: the target setting, i.e. what will sound once any quantized change lands.
- Mixing rule: sum of every source (stems and recordings) times its gain (+1, −1 or 0), no limiter. If the sum
  exceeds full scale, the whole file is scaled down instead of clipped, and the gain is written into the name.
  The show bridge renders with the same rule, so the same setting gives the same audio.
- Name: `<song>_<method>-<pool>_sel<pressed mask>[_gain<dB>dB].wav`,
  e.g. `aladdin-friend-like-me_subtract-mix_sel0000000010.wav`.
- Sample rate is the browser's audio rate (stems are resampled on decode). Use stems at that rate (usually 48 kHz)
  to keep exports bit-comparable with bridge renders.

## Bridge protocol

Open with `?bridge=ws://<host>:<port>/<path>`. Without it the page runs standalone.
The client reconnects with backoff and replays the latest state after reconnecting. Messages are JSON:

```js
// on every change
{ "type": "state", "song": "…", "stems": ["vocals", …], "mode": "subtract" | "add",
  "pool": "mix" | "accompaniment" | "vocals", "base": "mix" | … | null,
  "selected": ["drums"], "selected_mask": "001000000", "audible": ["vocals", …], "mask": "110111111",
  "gains": { "stems": { "drums": -1, … }, "bases": { "mix": 1, … } },
  "playhead_sec": 12.3, "section": "verse1", "apply_in_sec": 0.42, "ts": 1763540000.12 }

// ~30 Hz while playing
{ "type": "features", "rms": 0.18, "bands": [8 values in 0..1, low→high], "onset": 1.7,
  "playhead_sec": 12.33, "section": "verse1", "ts": 1763540000.15 }
```

The audio itself is not streamed. The bridge holds the same files and renders the result from `gains` and
`playhead_sec`, which keeps the link light and the result deterministic. `mask`/`audible` are the pool stems
that still sound, for display; with a recording as base they ignore what the separation missed.

`onset` is the positive spectral flux divided by its running mean; values well above 1 mark hits.

## Development

```bash
node --test "stage-generator/tests/*.test.mjs"   # state, demo and manifest logic
```

ES modules require serving over HTTP (e.g. `python3 -m http.server`), not opening the file directly.
`window.stageGenerator` exposes the engine and state for console debugging.
