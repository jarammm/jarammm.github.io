# Stage Generator

An n×n pad controller for live stem mixing. Each pad is one stem (an instrument or a voice part).
Pressing a pad selects it; pressing it again deselects it. The page plays the result through Web Audio
and can report it to a show bridge that drives real-time visuals.

## Modes

| Mode | Start state | A selected pad… |
|---|---|---|
| **Subtract** | the full original mix | removes its stem |
| **Add** | silence | adds its stem |

Switching modes clears the selection, so the mix returns to that mode's start state.

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
  "sections": [{ "name": "verse1", "start": 0.0, "end": 32.5 }],
  "stems": [
    { "id": "vocals",   "label": "Vocals",   "file": "vocals.wav",   "color": "#f472b6" },
    { "id": "ensemble", "label": "Ensemble", "file": "ensemble.wav" }
  ]
}
```

Only `stems[].file` is required. Pad order follows `stems` (row-major), and so does the mask bit order.
Keyboard shortcuts follow the same order: `1`–`0`, then `Q`… (physical keys, so they work with any IME).

## Bridge protocol

Open with `?bridge=ws://<host>:<port>/<path>`. Without it the page runs standalone.
The client reconnects with backoff and replays the latest state after reconnecting. Messages are JSON:

```js
// on every change
{ "type": "state", "song": "…", "stems": ["vocals", …], "mode": "subtract" | "add",
  "selected": ["drums"], "audible": ["vocals", …], "mask": "110111111",
  "playhead_sec": 12.3, "section": "verse1", "apply_in_sec": 0.42, "ts": 1763540000.12 }

// ~30 Hz while playing
{ "type": "features", "rms": 0.18, "bands": [8 values in 0..1, low→high], "onset": 1.7,
  "playhead_sec": 12.33, "section": "verse1", "ts": 1763540000.15 }
```

The audio itself is not streamed. The bridge holds the same stems and renders the audible mix from
`mask` and `playhead_sec`, which keeps the link light and the result deterministic.

`onset` is the positive spectral flux divided by its running mean; values well above 1 mark hits.

## Development

```bash
node --test "stage-generator/tests/*.test.mjs"   # state, demo and manifest logic
```

ES modules require serving over HTTP (e.g. `python3 -m http.server`), not opening the file directly.
`window.stageGenerator` exposes the engine and state for console debugging.
