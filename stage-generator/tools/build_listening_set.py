# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.5.4", "soundfile==0.14.0", "scipy==1.18.1"]
# ///
"""Build the streamed song set for the Stage Generator page from the musical-textsetting outputs.

For each song this writes the full recording, cut into fixed-length FLAC chunks so the page can stream it:
  recording : mix (the original recording)
  stems     : vocals (principal characters), ensemble (everyone else), and 8 instrument classes
              (brass, woodwind, bowed_strings, harp, keys, guitar, drums_perc, bass)
  bases     : what "subtract" removes from, as signed sums of the files above:
              mix = recording; vocals = vocals + ensemble; accompaniment = mix - vocals - ensemble.
              The voice stems sum to the MelBand vocals (-75..-84 dB), and MelBand vocals + accompaniment
              reconstruct the mix (about -66 dB), so these sums stand in for the MelBand files without
              shipping them.
Everything is put on the scale of the original mix so that "base - pressed stems" is meaningful:
  - The MelBand files are stored quieter than the mix (vocals + accompaniment at unity leave a
    -10..-20 dB residual; with least-squares scales the residual is about -66 dB). The two scales are
    fitted per song against the mix and applied to the MelBand files and everything derived from them.
  - Instrument classes were separated from the MelBand accompaniment and written with a per-song gain
    (levels.csv `written_gain_db`), which is undone before the accompaniment scale is applied.
  - Character tracks (24 kHz mono, from the MelBand vocals) are resampled to 44.1 kHz and copied to
    both channels. That drops the stereo side (reverb, width; about -6 dB of the vocals) and the band
    above 12 kHz. The missing part, vocals - (vocals + ensemble), is shared back between the two
    tracks by their smoothed energy share at each moment, so the two voice stems sum to the MelBand
    vocals exactly while the character assignment stays as it was.
Chunks are cut at exact sample multiples and quantized per sample, so concatenating them gives the same
samples as one long file; the page plays them back to back on one clock at 44.1 kHz (no resampling).
The audio is copyrighted cast-recording material. The repository owner chose to publish it with the page
and credit each recording (2026-11-19). Aladdin is left out by default because of its length.

Run: uv run stage-generator/tools/build_listening_set.py [--source DIR] [--out DIR] [--exclude NAME ...]
"""
import argparse
import csv
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

REPO = Path(__file__).resolve().parents[2]
SR = 44100
CHUNK_S = 20                 # seconds per streamed chunk: ~1 MB of FLAC per source, small enough to fetch ahead
INSTRUMENTS = ["brass", "woodwind", "bowed_strings", "harp", "keys", "guitar", "drums_perc", "bass"]
LABELS = {"vocals": "Vocals", "ensemble": "Ensemble", "brass": "Brass", "woodwind": "Woodwind",
          "bowed_strings": "Bowed strings", "harp": "Harp", "keys": "Keys", "guitar": "Guitar",
          "drums_perc": "Drums & perc", "bass": "Bass"}
COLORS = {"vocals": "#f472b6", "ensemble": "#c084fc", "brass": "#facc15", "woodwind": "#a3e635",
          "bowed_strings": "#2dd4bf", "harp": "#38bdf8", "keys": "#4ade80", "guitar": "#fb923c",
          "drums_perc": "#f87171", "bass": "#818cf8"}
FADE_S = 0.01                # identical edge fades on every file keep the loop seam click-free and base - stems exact
DEFAULT_EXCLUDE = ["Aladdin - Friend Like Me"]   # user decision 2026-11-19: too long to stream comfortably


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(np.asarray(x, np.float64) ** 2) + 1e-20))


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def read(path: Path) -> np.ndarray:
    x, sr = sf.read(path, dtype="float32", always_2d=True)  # (T, C)
    if sr != SR:
        raise ValueError(f"{path}: expected {SR} Hz, got {sr}")
    return x


def to_stereo_44k(path: Path, n: int) -> np.ndarray:
    """Character track (24 kHz mono) -> (n, 2) at 44.1 kHz."""
    x, sr = sf.read(path, dtype="float32")          # (T24,)
    y = resample_poly(x, SR // 300, sr // 300)      # 147/80 for 24 kHz; (T44,)
    y = np.pad(y, (0, max(0, n - len(y))))[:n]
    return np.repeat(y[:, None], 2, axis=1).astype(np.float32)  # (n, 2)


def share_residual(tracks: list, target: np.ndarray, smooth_s: float = 0.25) -> list:
    """Add target - sum(tracks) back to the tracks, split by each track's smoothed energy share.

    tracks: list of (T, 2); target: (T, 2). Returns tracks that sum to target. Smoothing over ~0.25 s lets a
    reverb tail follow the voice that just sang instead of flipping frame by frame.
    """
    resid = target - sum(tracks)                                            # (T, 2)
    win = int(smooth_s * SR)

    def moving_mean(x: np.ndarray) -> np.ndarray:
        """Centered moving average via a cumulative sum (direct convolution is far too slow at song length)."""
        c = np.concatenate([[0.0], np.cumsum(x)])                            # (T+1,)
        i = np.arange(len(x))
        lo, hi = np.clip(i - win // 2, 0, len(x)), np.clip(i + win // 2 + 1, 0, len(x))
        return (c[hi] - c[lo]) / (hi - lo)

    env = [moving_mean(t.mean(1).astype(np.float64) ** 2) for t in tracks]  # K x (T,)
    total = sum(env) + 1e-12
    shares = [e / total for e in env]
    # Where every track is silent the share is undefined; split evenly there.
    silent = sum(env) < 1e-10
    for s in shares:
        s[silent] = 1.0 / len(tracks)
    return [t + (s[:, None] * resid).astype(np.float32) for t, s in zip(tracks, shares)]


def fit_scales(mix: np.ndarray, voc: np.ndarray, acc: np.ndarray) -> tuple[float, float, float]:
    """Least-squares gv, ga with mix ~ gv*voc + ga*acc (mono, whole song). Returns gv, ga, residual dB."""
    A = np.stack([voc.mean(1), acc.mean(1)], 1).astype(np.float64)  # (T, 2)
    m = mix.mean(1).astype(np.float64)                               # (T,)
    (gv, ga), *_ = np.linalg.lstsq(A, m, rcond=None)
    return float(gv), float(ga), rms_db(m - A @ np.array([gv, ga])) - rms_db(m)


def song_sections(path: Path) -> list:
    """SongFormer sections, numbered per label over the song (verse1, verse2...)."""
    out, seen = [], {}
    with open(path) as f:
        for row in csv.DictReader(f, delimiter="\t"):
            lab = row["label"]
            seen[lab] = seen.get(lab, 0) + 1
            out.append({"name": f"{lab}{seen[lab]}", "start": round(float(row["start"]), 3),
                        "end": round(float(row["end"]), 3)})
    return out


def write_chunks(x: np.ndarray, folder: Path, chunk: int) -> int:
    """Write x (T, 2) as folder/<k>.flac, `chunk` samples each (the last one shorter). Returns the count."""
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.flac"):
        old.unlink()
    k = 0
    for k, i in enumerate(range(0, len(x), chunk)):
        sf.write(folder / f"{k}.flac", x[i:i + chunk], SR, subtype="PCM_16")
    return k + 1


def build_song(song_dir: Path, vocal_sep: Path, out_root: Path) -> dict:
    song = song_dir.name
    meta = json.loads((song_dir / "song.json").read_text())
    rhythm = json.loads((song_dir / "rhythm/beats_downbeats_meter.json").read_text())

    voc = read(song_dir / "stems/vocals.wav")                       # (T, 2)
    acc = read(song_dir / "stems/accompaniment.wav")                # (T, 2)
    n = len(voc)
    mix48, _ = sf.read(song_dir / "audio.mp3", dtype="float32", always_2d=True)  # (T48, 2)
    mix = resample_poly(mix48, 147, 160, axis=0).astype(np.float32)[:n]         # (T, 2)
    assert len(mix) == n, f"{song}: mix length {len(mix)} != stems {n}"
    gv, ga, resid_db = fit_scales(mix, voc, acc)

    levels = {}
    with open(vocal_sep / "mega53_9" / song / "levels.csv") as f:
        for row in csv.DictReader(f):
            levels[row["class"]] = float(row["level_rel_accomp_db"])
    inst_gain = ga * 10 ** (-levels["written_gain_db"] / 20)

    stems = {}
    char_dir = vocal_sep / "recursive_tagged" / song
    chars = sorted(p for p in char_dir.glob("*.wav") if p.stem != "others")
    stems["vocals"] = gv * sum(to_stereo_44k(p, n) for p in chars)
    stems["ensemble"] = gv * to_stereo_44k(char_dir / "others.wav", n)
    stems["vocals"], stems["ensemble"] = share_residual([stems["vocals"], stems["ensemble"]], gv * voc)
    for k in INSTRUMENTS:
        stems[k] = inst_gain * read(vocal_sep / "mega53_9" / song / f"{k}.flac")[:n]
    del voc, acc, mix48

    fade = np.ones(n, np.float32)
    k = int(FADE_S * SR)
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))).astype(np.float32)
    fade[:k], fade[-k:] = ramp, ramp[::-1]
    files = {"mix": mix * fade[:, None]} | {s: x * fade[:, None] for s, x in stems.items()}
    peak = max(float(np.abs(x).max()) for x in files.values())
    file_gain = min(1.0, 0.999 / peak)                                # same gain on every file keeps base - stems exact

    out = out_root / slug(f"{meta['work']} {meta['title']}")
    chunk = CHUNK_S * SR
    counts = {name: write_chunks(x * file_gain, out / name, chunk) for name, x in files.items()}
    assert len(set(counts.values())) == 1, counts

    rel = lambda x: round(rms_db(x) - rms_db(mix), 1)
    wm = meta.get("work_meta") or {}
    credits = {
        "work": meta["work"],
        "song": meta["title"],
        # YouTube auto-generated artist channels end in " - Topic"; that suffix is not part of the name.
        "performers": re.sub(r"\s*-\s*Topic$", "", meta.get("artist") or ""),
        "album": meta.get("album"),
        "music": wm.get("music"),
        "lyrics": wm.get("lyrics"),
        "source_url": meta.get("youtube_url"),
        "notice": "Official cast recording, downloaded from YouTube. All rights belong to the respective rights holders.",
    }
    manifest = {
        "title": f"{meta['work']} - {meta['title']}",
        "credits": credits,
        "bpm": meta["rhythm"]["bpm"],
        "beats_per_bar": 4,
        "beats": [round(b, 3) for b in rhythm["beats"]],
        "downbeats": [round(b, 3) for b in rhythm["downbeats"]],
        "sections": song_sections(song_dir / "structure/songformer_sections.tsv"),
        "sample_rate": SR,
        "length": n,
        "chunks": {"samples": chunk, "count": counts["mix"], "path": "{id}/{k}.flac"},
        "recordings": [{"id": "mix", "label": "Original mix"}],
        "bases": {
            "mix": {"rec:mix": 1},
            "accompaniment": {"rec:mix": 1, "vocals": -1, "ensemble": -1},
            "vocals": {"vocals": 1, "ensemble": 1},
        },
        "stems": [{"id": s, "label": LABELS[s], "group": "vocals" if s in ("vocals", "ensemble") else "accompaniment",
                   "color": COLORS[s], "level_db": rel(x)} for s, x in stems.items()],
        "provenance": {
            "file_gain_db": round(20 * np.log10(file_gain), 2),
            "melband_scale": {"vocals": round(gv, 4), "accompaniment": round(ga, 4), "mix_residual_db": round(resid_db, 1)},
            "instrument_written_gain_db": levels["written_gain_db"],
            "vocals_tracks": [p.stem for p in chars],
            "ensemble_track": "others",
            "level_db_note": "song RMS relative to the song mix",
            "source": {"mix": "results/share_four_songs/<song>/audio.mp3 (48k -> 44.1k)",
                       "vocals_accompaniment": "results/share_four_songs/<song>/stems/ (MelBand-RoFormer Kim)",
                       "instruments": "temp/vocal_sep/out/mega53_9/<song>/",
                       "characters": "temp/vocal_sep/out/recursive_tagged/<song>/ (24 kHz mono)"},
        },
    }
    (out / "stems.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"{song}: {n / SR:.1f} s, {counts['mix']} chunks x {len(files)} sources, scales voc {gv:.3f} acc {ga:.3f} "
          f"(resid {resid_db:.1f} dB), file gain {manifest['provenance']['file_gain_db']} dB")
    return {"title": manifest["title"], "manifest": f"{out.name}/stems.json"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", type=Path, default=REPO.parent / "musical-textsetting",
                    help="musical-textsetting project root")
    ap.add_argument("--out", type=Path, default=REPO / "stage-generator" / "audio")
    ap.add_argument("--exclude", nargs="*", default=DEFAULT_EXCLUDE, help="song folder names to leave out")
    args = ap.parse_args()
    share = args.source / "results" / "share_four_songs"
    vocal_sep = args.source / "temp" / "vocal_sep" / "out"
    dirs = sorted(p for p in share.iterdir() if p.is_dir() and p.name not in args.exclude)
    songs = [build_song(d, vocal_sep, args.out) for d in dirs]
    (args.out / "songs.json").write_text(json.dumps({"songs": songs}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
