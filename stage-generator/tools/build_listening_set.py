# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.5.4", "soundfile==0.14.0", "scipy==1.18.1"]
# ///
"""Build the streamed song set for the Stage Generator page from the musical-textsetting outputs.

For each song this writes the full recording, cut into fixed-length FLAC chunks so the page can stream it:
  recording : mix (the original recording)
  stems     : vocals (the MelBand vocals as they are; voices are never split from each other, user decision
              2026-11-21) and the accompaniment split one of two ways (ACCOMP_SPLIT, user decisions 2026-11-21):
              demucs6_mvsep: htdemucs_6s gives drums, bass, piano and guitar; its "other" goes through
                MVSep's family models as a chain (Brass, then Woodwind on the rest, then Bowed Strings on that
                rest; temp/vocal_sep/mvsep_families.py), and the last rest is the pad "other";
              demucs6_mvsep_demucs6: as demucs6_mvsep, then that last rest is split by htdemucs_6s once more;
                its drums, bass, piano and guitar are added to those pads and its "other" is the pad "other"
                (user decision 2026-11-21, Say My Name);
              demucs4: htdemucs_ft gives drums, bass, and guitar (its "other" stem).
              Neither keeps demucs' "vocals" stem (the voice the MelBand split left in the accompaniment) as a
              pad; it stays inside the mix base. Demucs stems sum to the accompaniment to -15..-22 dB.
  bases     : what "subtract" removes from, as signed sums of the files above:
              mix = recording; vocals = vocals; accompaniment = mix - vocals.
              MelBand vocals + accompaniment reconstruct the mix (about -66 dB), so mix - vocals stands in for
              the MelBand accompaniment without shipping it.
Everything is put on the scale of the original mix so that "base - pressed stems" is meaningful:
  - The MelBand files are stored quieter than the mix (vocals + accompaniment at unity leave a
    -10..-20 dB residual; with least-squares scales the residual is about -66 dB). The two scales are
    fitted per song against the mix and applied to the MelBand files and everything derived from them.
  - The instrument stems are at the MelBand accompaniment's own scale (demucs and MVSep add no gain), so
    the accompaniment scale is all they need. (The earlier Mega 53 9-class split lost 1.3-2.4 dB and most of
    the band above 6 kHz because its outputs do not sum to its input; both splits here keep a remainder.)
Chunks are cut at exact sample multiples and quantized per sample, so concatenating them gives the same
samples as one long file; the page plays them back to back on one clock at 44.1 kHz (no resampling).
The audio is copyrighted cast-recording material. The repository owner chose to publish it with the page
and credit each recording (2026-11-19).

Run: uv run stage-generator/tools/build_listening_set.py [--source DIR] [--out DIR] [--songs NAME ...]
     [--build NAME ...]   (rebuild only these; the other listed songs keep their published files)
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
# Pad id -> files under temp/vocal_sep/out/ that are summed into it ({song} is the song folder name), in pad order.
# User decisions 2026-11-21: Lizzie's demucs "other" is the guitar; MVSep's family models, not Mega 53.
_MVSEP = {"bowed_strings": ["mvsep/{song}/bowed_strings.flac"], "woodwind": ["mvsep/{song}/woodwind.flac"],
          "brass": ["mvsep/{song}/brass.flac"]}
SPLITS = {
    "demucs6_mvsep": {**{k: [f"demucs6/{{song}}/{k}.wav"] for k in ("drums", "bass", "piano", "guitar")}, **_MVSEP,
                      "other": ["mvsep/{song}/rest_3_after_bowed_strings.flac"]},
    "demucs6_mvsep_demucs6": {**{k: [f"demucs6/{{song}}/{k}.wav", f"demucs6_rest/{{song}}/{k}.wav"]
                                 for k in ("drums", "bass", "piano", "guitar")}, **_MVSEP,
                              "other": ["demucs6_rest/{song}/other.wav"]},
    "demucs4": {"drums": ["demucs4/{song}/drums.wav"], "bass": ["demucs4/{song}/bass.wav"],
                "guitar": ["demucs4/{song}/other.wav"]},
}
LABELS = {"vocals": "Vocals", "drums": "Drums", "bass": "Bass", "piano": "Piano", "guitar": "Guitar",
          "bowed_strings": "Bowed strings", "woodwind": "Woodwind", "brass": "Brass", "other": "Other"}
COLORS = {"vocals": "#f472b6", "drums": "#f87171", "bass": "#818cf8", "piano": "#4ade80", "guitar": "#fb923c",
          "bowed_strings": "#2dd4bf", "woodwind": "#a3e635", "brass": "#facc15", "other": "#94a3b8"}
FADE_S = 0.01                # identical edge fades on every file keep the loop seam click-free and base - stems exact
# User decision 2026-11-21: Say My Name and Somebody Will Do Something replace One Day More and Masquerade.
# Aladdin stays out (2026-11-19: too long to stream comfortably).
DEFAULT_SONGS = ["Beetlejuice - Say My Name", "Lizzie - Somebody Will Do Something", "Wicked - No One Mourns the Wicked"]
ACCOMP_SPLIT = {"Beetlejuice - Say My Name": "demucs6_mvsep_demucs6", "Lizzie - Somebody Will Do Something": "demucs4",
                "Wicked - No One Mourns the Wicked": "demucs6_mvsep"}
# Fields the corpus metadata gets wrong or lacks. The Lizzie upload is a third-party channel with no track
# metadata: its uploader is not a performer, and the music/lyrics credits come from Wikipedia (2026-11-21;
# the lyrics credit lists only the name that could be confirmed there).
CREDITS = {"Lizzie - Somebody Will Do Something": {
    "song": "Somebody Will Do Something", "performers": None,
    "music": "Steven Cheslik-DeMeyer, Alan Stevens Hewitt", "lyrics": "Steven Cheslik-DeMeyer",
    "notice": "Cast recording, downloaded from a third-party YouTube upload. "
              "All rights belong to the respective rights holders."}}


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(np.asarray(x, np.float64) ** 2) + 1e-20))


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def read(path: Path) -> np.ndarray:
    x, sr = sf.read(path, dtype="float32", always_2d=True)  # (T, C)
    if sr != SR:
        raise ValueError(f"{path}: expected {SR} Hz, got {sr}")
    return x


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


def song_folder(song_dir: Path, out_root: Path) -> Path:
    """Published folder of a song: slug of "<work> <title>", with the title fixed by CREDITS."""
    meta = json.loads((song_dir / "song.json").read_text())
    return out_root / slug(f"{meta['work']} {CREDITS.get(song_dir.name, {}).get('song', meta['title'])}")


def published_entry(song_dir: Path, out_root: Path) -> dict:
    """songs.json entry of a song that is not rebuilt, read from its published stems.json."""
    folder = song_folder(song_dir, out_root)
    return {"title": json.loads((folder / "stems.json").read_text())["title"], "manifest": f"{folder.name}/stems.json"}


def build_song(song_dir: Path, vocal_sep: Path, out_root: Path) -> dict:
    """Write one song's chunks and stems.json under out_root; returns its songs.json entry."""
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

    split = ACCOMP_SPLIT[song]
    stems = {"vocals": gv * voc}  # (T, 2)
    for k, fs in SPLITS[split].items():
        stems[k] = ga * sum(read(vocal_sep / f.format(song=song))[:n] for f in fs)  # (T, 2)
    del voc, acc, mix48

    fade = np.ones(n, np.float32)
    k = int(FADE_S * SR)
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))).astype(np.float32)
    fade[:k], fade[-k:] = ramp, ramp[::-1]
    files = {"mix": mix * fade[:, None]} | {s: x * fade[:, None] for s, x in stems.items()}
    peak = max(float(np.abs(x).max()) for x in files.values())
    file_gain = min(1.0, 0.999 / peak)                                # same gain on every file keeps base - stems exact

    out = song_folder(song_dir, out_root)
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
    } | CREDITS.get(song, {})
    manifest = {
        "title": f"{meta['work']} - {credits['song']}",
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
            "accompaniment": {"rec:mix": 1, "vocals": -1},
            "vocals": {"vocals": 1},
        },
        "stems": [{"id": s, "label": LABELS[s], "group": "vocals" if s == "vocals" else "accompaniment",
                   "color": COLORS[s], "level_db": rel(x)} for s, x in stems.items()],
        "provenance": {
            "file_gain_db": round(20 * np.log10(file_gain), 2),
            "melband_scale": {"vocals": round(gv, 4), "accompaniment": round(ga, 4), "mix_residual_db": round(resid_db, 1)},
            "accompaniment_split": split,
            "vocals_tracks": "MelBand vocals, not split by character",
            "level_db_note": "song RMS relative to the song mix",
            "source": {"mix": "results/share_four_songs/<song>/audio.mp3 (48k -> 44.1k)",
                       "vocals_accompaniment": "results/share_four_songs/<song>/stems/ (MelBand-RoFormer Kim)",
                       "instruments": {k: [f"temp/vocal_sep/out/{f}" for f in fs] for k, fs in SPLITS[split].items()}},
        },
    }
    (out / "stems.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"{song}: {n / SR:.1f} s, {counts['mix']} chunks x {len(files)} sources, scales voc {gv:.3f} acc {ga:.3f} ({split}) "
          f"(resid {resid_db:.1f} dB), file gain {manifest['provenance']['file_gain_db']} dB")
    return {"title": manifest["title"], "manifest": f"{out.name}/stems.json"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", type=Path, default=REPO.parent / "musical-textsetting",
                    help="musical-textsetting project root")
    ap.add_argument("--out", type=Path, default=REPO / "stage-generator" / "audio")
    ap.add_argument("--songs", nargs="*", default=DEFAULT_SONGS, help="song folder names in the picker, in order")
    ap.add_argument("--build", nargs="*", help="rebuild only these of --songs (default: all)")
    args = ap.parse_args()
    share = args.source / "results" / "share_four_songs"
    vocal_sep = args.source / "temp" / "vocal_sep" / "out"
    build = set(args.songs if args.build is None else args.build)
    assert build <= set(args.songs), f"--build names not in --songs: {build - set(args.songs)}"
    songs = [build_song(share / name, vocal_sep, args.out) if name in build else published_entry(share / name, args.out)
             for name in args.songs]
    (args.out / "songs.json").write_text(json.dumps({"songs": songs}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
