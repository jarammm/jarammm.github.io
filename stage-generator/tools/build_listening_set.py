# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.5.4", "soundfile==0.14.0", "scipy==1.18.1"]
# ///
"""Build the local listening set for the Stage Generator page from the musical-textsetting outputs.

For each of the four shared songs this writes a 90 s excerpt as FLAC files plus a stems.json manifest:
  bases  : mix (the original recording), accompaniment, vocals  -- what "subtract" removes from
  stems  : vocals (principal characters), ensemble (everyone else), and 8 instrument classes
           (brass, woodwind, bowed_strings, harp, keys, guitar, drums_perc, bass)
Everything is put on the scale of the original mix so that "base - pressed stems" is meaningful:
  - The MelBand files are stored quieter than the mix (vocals + accompaniment at unity leave a
    -10..-20 dB residual; with least-squares scales the residual is about -66 dB). The two scales are
    fitted per song against the mix and applied to the MelBand files and everything derived from them.
  - Instrument classes were separated from the MelBand accompaniment and written with a per-song gain
    (levels.csv `written_gain_db`), which is undone before the accompaniment scale is applied.
  - Character tracks (24 kHz mono, from the MelBand vocals) are resampled to 44.1 kHz and copied to
    both channels. That drops the stereo side (reverb, width; about -6 dB of the vocals) and the band
    above 12 kHz. The missing part, vocals base - (vocals + ensemble), is shared back between the two
    tracks by their smoothed energy share at each moment, so the two voice stems sum to the vocals base
    exactly while the character assignment stays as it was.
The audio is copyrighted cast-recording material. The repository owner chose to publish these excerpts
with the page (2026-11-19); rebuilding or extending the set does not change that decision.

Run: uv run stage-generator/tools/build_listening_set.py [--source DIR] [--out DIR] [--seconds 90]
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
INSTRUMENTS = ["brass", "woodwind", "bowed_strings", "harp", "keys", "guitar", "drums_perc", "bass"]
LABELS = {"vocals": "Vocals", "ensemble": "Ensemble", "brass": "Brass", "woodwind": "Woodwind",
          "bowed_strings": "Bowed strings", "harp": "Harp", "keys": "Keys", "guitar": "Guitar",
          "drums_perc": "Drums & perc", "bass": "Bass"}
COLORS = {"vocals": "#f472b6", "ensemble": "#c084fc", "brass": "#facc15", "woodwind": "#a3e635",
          "bowed_strings": "#2dd4bf", "harp": "#38bdf8", "keys": "#4ade80", "guitar": "#fb923c",
          "drums_perc": "#f87171", "bass": "#818cf8"}
ACTIVE_DB = -30.0   # a stem counts as present in a second when its RMS is within 30 dB of the song mix RMS
FADE_S = 0.01       # identical edge fades on every file keep the loop seam click-free and base - stems exact


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


def pick_window(stems: dict, mix_db: float, downbeats: list, seconds: float, total: float) -> float:
    """Start time (on a downbeat) of the window where the most stems sound, favouring both voices together."""
    n_sec = int(total)
    active = {}
    for k, x in stems.items():
        frames = x[: n_sec * SR].reshape(n_sec, SR, -1)                       # (S, SR, C)
        lv = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=(1, 2)) + 1e-20)  # (S,)
        active[k] = lv - mix_db > ACTIVE_DB
    per_sec = sum(a.astype(int) for a in active.values()) + 2 * (active["vocals"] & active["ensemble"])  # (S,)
    starts = [t for t in downbeats if t + seconds <= total] or list(np.arange(0, total - seconds, 1.0))
    csum = np.concatenate([[0], np.cumsum(per_sec)])
    score = lambda t: csum[min(n_sec, int(t + seconds))] - csum[int(t)]
    return float(max(starts, key=score))


def sections_in(path: Path, t0: float, t1: float) -> list:
    """SongFormer sections clipped to the window, numbered per label over the whole song (verse1, verse2...)."""
    out, seen = [], {}
    with open(path) as f:
        for row in csv.DictReader(f, delimiter="\t"):
            a, b, lab = float(row["start"]), float(row["end"]), row["label"]
            seen[lab] = seen.get(lab, 0) + 1
            if b > t0 and a < t1:
                out.append({"name": f"{lab}{seen[lab]}", "start": round(max(a, t0) - t0, 3),
                            "end": round(min(b, t1) - t0, 3)})
    return out


def build_song(song_dir: Path, vocal_sep: Path, out_root: Path, seconds: float) -> dict:
    song = song_dir.name
    meta = json.loads((song_dir / "song.json").read_text())
    rhythm = json.loads((song_dir / "rhythm/beats_downbeats_meter.json").read_text())

    voc = read(song_dir / "stems/vocals.wav")                       # (T, 2)
    acc = read(song_dir / "stems/accompaniment.wav")                # (T, 2)
    n = len(voc)
    mix48, msr = sf.read(song_dir / "audio.mp3", dtype="float32", always_2d=True)  # (T48, 2)
    mix = resample_poly(mix48, 147, 160, axis=0).astype(np.float32)[:n]           # (T, 2)
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
    bases = {"mix": mix, "accompaniment": ga * acc, "vocals": gv * voc}

    mix_db = rms_db(mix)
    t0 = pick_window(stems, mix_db, rhythm["downbeats"], seconds, n / SR)
    t1 = t0 + seconds
    i0, i1 = int(round(t0 * SR)), int(round(t0 * SR)) + int(round(seconds * SR))
    fade = np.ones(i1 - i0, np.float32)
    k = int(FADE_S * SR)
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))).astype(np.float32)
    fade[:k], fade[-k:] = ramp, ramp[::-1]
    cut = lambda x: x[i0:i1] * fade[:, None]                         # (N, 2)

    files = {f"base_{p}": cut(x) for p, x in bases.items()} | {k: cut(x) for k, x in stems.items()}
    peak = max(float(np.abs(x).max()) for x in files.values())
    file_gain = min(1.0, 0.999 / peak)                                # same gain on every file keeps base - stems exact

    out = out_root / slug(f"{meta['work']} {meta['title']}")
    out.mkdir(parents=True, exist_ok=True)
    for name, x in files.items():
        sf.write(out / f"{name}.flac", x * file_gain, SR, subtype="PCM_16")

    rel = lambda x: round(rms_db(cut(x)) - rms_db(cut(mix)), 1)
    beats = [round(b - t0, 3) for b in rhythm["beats"] if t0 <= b < t1]
    downbeats = [round(b - t0, 3) for b in rhythm["downbeats"] if t0 <= b < t1]
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
        "notice": "Excerpt of the official cast recording, downloaded from YouTube. "
                  "All rights belong to the respective rights holders.",
    }
    manifest = {
        "title": f"{meta['work']} - {meta['title']}",
        "credits": credits,
        "bpm": meta["rhythm"]["bpm"],
        "beats_per_bar": 4,
        "beats": beats,
        "downbeats": downbeats,
        "sections": sections_in(song_dir / "structure/songformer_sections.tsv", t0, t1),
        "bases": {p: f"base_{p}.flac" for p in bases},
        "stems": [{"id": k, "label": LABELS[k], "group": "vocals" if k in ("vocals", "ensemble") else "accompaniment",
                   "color": COLORS[k], "file": f"{k}.flac", "level_db": rel(x)} for k, x in stems.items()],
        "provenance": {
            "excerpt_sec": [round(t0, 3), round(t1, 3)],
            "file_gain_db": round(20 * np.log10(file_gain), 2),
            "melband_scale": {"vocals": round(gv, 4), "accompaniment": round(ga, 4), "mix_residual_db": round(resid_db, 1)},
            "instrument_written_gain_db": levels["written_gain_db"],
            "vocals_tracks": [p.stem for p in chars],
            "ensemble_track": "others",
            "level_db_note": "excerpt RMS relative to the excerpt mix",
            "source": {"mix": "results/share_four_songs/<song>/audio.mp3 (48k -> 44.1k)",
                       "vocals_accompaniment": "results/share_four_songs/<song>/stems/ (MelBand-RoFormer Kim)",
                       "instruments": "temp/vocal_sep/out/mega53_9/<song>/",
                       "characters": "temp/vocal_sep/out/recursive_tagged/<song>/ (24 kHz mono)"},
        },
    }
    (out / "stems.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"{song}: window {t0:.1f}-{t1:.1f} s, scales voc {gv:.3f} acc {ga:.3f} (resid {resid_db:.1f} dB), "
          f"file gain {manifest['provenance']['file_gain_db']} dB, sections {[s['name'] for s in manifest['sections']]}")
    return {"title": manifest["title"], "manifest": f"{out.name}/stems.json"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", type=Path, default=REPO.parent / "musical-textsetting",
                    help="musical-textsetting project root")
    ap.add_argument("--out", type=Path, default=REPO / "stage-generator" / "audio")
    ap.add_argument("--seconds", type=float, default=90.0)
    args = ap.parse_args()
    share = args.source / "results" / "share_four_songs"
    vocal_sep = args.source / "temp" / "vocal_sep" / "out"
    songs = [build_song(d, vocal_sep, args.out, args.seconds) for d in sorted(p for p in share.iterdir() if p.is_dir())]
    (args.out / "songs.json").write_text(json.dumps({"songs": songs}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
