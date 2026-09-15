#!/usr/bin/env python3
"""
Verify generated narration clips: duration, format, size, hash, and that the set
on disk is exactly the set that was supposed to be generated.

Approved master format: mp3_44100_128 — a valid 44.1 kHz mono MP3 at about
128 kbps. Lossy by design; these files are never transcoded into WAV.

    python elevenlabs/verify_clips.py --expect-set ready
    python elevenlabs/verify_clips.py --expect-set ready --report validation_report.md

Exit 0 only when every check passes. This runs as its own step after generation
so that "the API returned 200" and "we have 24 usable clips" are two separate
claims, established separately.

Nothing here touches the network and nothing here reads the API key.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
AUDIO = ROOT / "elevenlabs" / "audio"
MANIFEST = ROOT / "elevenlabs" / "generation_manifest.json"
VOICE = ROOT / "elevenlabs" / "voice_settings.json"
LOG = ROOT / "elevenlabs" / "generation_log.json"

MIN_SECONDS = 1.0
MIN_BYTES = 8192
# The approved narration-master format, from 2026-09-15: mp3_44100_128.
# pcm_44100 was the earlier choice and is unavailable on this subscription — the
# API answered HTTP 403 output_format_not_allowed (Pro tier and above). These
# masters are LOSSY: one encode here, one AAC encode at assembly. They are never
# transcoded into WAV, which would recover nothing and misrepresent them.
MASTER_CODEC = "mp3"
MASTER_SUFFIX = ".mp3"
MASTER_RATE = 44100
MASTER_CHANNELS = 1
MASTER_BITRATE_KBPS = 128
BITRATE_TOLERANCE = 0.25               # VBR-ish headroom; a 64k clip still fails
AUDIO_SUFFIXES = (".mp3", ".wav")      # what we look at; only .mp3 passes
# A clip more than this far from its estimate is not necessarily wrong, but it
# is worth a human looking at it before the picture is cut to it.
DRIFT_NOTE = 0.30          # 30% either way


def probe(p):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration,size,bit_rate:stream=codec_name,sample_rate,channels",
         "-of", "json", str(p)], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    d = json.loads(r.stdout)
    st = (d.get("streams") or [{}])[0]
    br = d["format"].get("bit_rate")
    return {"seconds": round(float(d["format"]["duration"]), 3),
            "bytes": int(d["format"]["size"]),
            "codec": st.get("codec_name"),
            "sample_rate": int(st["sample_rate"]) if st.get("sample_rate") else None,
            "channels": st.get("channels"),
            "bitrate_kbps": round(int(br) / 1000) if br else None}


def audible(p):
    """True when the clip carries actual signal.

    A WAV of pure silence is readable, valid, the right length and the right
    size — and useless. ffmpeg's volumedetect reports the peak; anything at or
    below -90 dBFS is silence, not narration.
    """
    r = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", str(p), "-af", "volumedetect",
         "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"max_volume:\s*(-?[\d.]+) dB", r.stderr)
    if not m:
        return True          # cannot tell — do not fail the clip on a guess
    return float(m.group(1)) > -90.0


def expected_set(kind, clips):
    if kind == "ready":
        return {c["scene_id"] for c in clips
                if c.get("in_master") and not c.get("narration_provisional")}
    if kind == "held":
        return {c["scene_id"] for c in clips if c.get("narration_provisional")}
    return set()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-set", choices=["ready", "any"], default="ready")
    ap.add_argument("--report", help="write a markdown validation report here")
    a = ap.parse_args()

    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    voice = json.loads(VOICE.read_text(encoding="utf-8"))
    clips = man["clips"]
    by_id = {c["scene_id"]: c for c in clips}
    want = expected_set(a.expect_set, clips)
    held = expected_set("held", clips)

    present = {p.stem: p for p in sorted(AUDIO.glob("*")) if p.suffix in AUDIO_SUFFIXES}
    problems, rows = [], []

    # --- the set itself ---------------------------------------------------
    if a.expect_set != "any":
        missing = sorted(want - present.keys())
        extra = sorted(present.keys() - want)
        if missing:
            problems.append(f"missing {len(missing)} expected clip(s): {' '.join(missing)}")
        for sid in extra:
            if sid in held:
                problems.append(f"HELD scene {sid} has an audio file — it must not "
                                f"have been generated")
            else:
                problems.append(f"unexpected clip on disk: {sid}")

    # --- each file --------------------------------------------------------
    for sid in sorted(present):
        p = present[sid]
        info = probe(p)
        if not info:
            problems.append(f"{sid}: ffprobe cannot read it")
            rows.append((sid, "UNREADABLE", "", "", "", ""))
            continue
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        bad = []
        if info["seconds"] < MIN_SECONDS:
            bad.append(f"only {info['seconds']}s")
        if info["bytes"] < MIN_BYTES:
            bad.append(f"only {info['bytes']} bytes")
        if p.suffix != MASTER_SUFFIX:
            bad.append(f"{p.suffix} file — the approved master format is "
                       f"mp3_44100_128 in a {MASTER_SUFFIX} container")
        if info["codec"] != MASTER_CODEC:
            bad.append(f"codec {info['codec']}, expected {MASTER_CODEC} (mp3_44100_128)")
        br = info.get("bitrate_kbps")
        if br is not None and abs(br - MASTER_BITRATE_KBPS) > \
                MASTER_BITRATE_KBPS * BITRATE_TOLERANCE:
            bad.append(f"{br} kbps, expected about {MASTER_BITRATE_KBPS}")
        if info["sample_rate"] != MASTER_RATE:
            bad.append(f"{info['sample_rate']} Hz, expected {MASTER_RATE}")
        if info["channels"] != MASTER_CHANNELS:
            bad.append(f"{info['channels']} channels, expected mono")
        if info["bytes"] == 0:
            bad.append("zero bytes")
        if not audible(p):
            bad.append("no audio — the file decodes to continuous silence")

        est = by_id.get(sid, {}).get("estimated_seconds")
        note = ""
        if est:
            drift = (info["seconds"] - est) / est
            if abs(drift) > DRIFT_NOTE:
                note = f"{drift * 100:+.0f}% vs estimate — look at this one"
        if bad:
            problems.append(f"{sid}: " + "; ".join(bad))
        rows.append((sid, f"{info['seconds']:.2f}s", f"{info['bytes']:,}",
                     f"{info['codec']} {info['sample_rate']}Hz "
                     f"{info.get('bitrate_kbps') or '?'}k "
                     f"{'mono' if info['channels'] == 1 else info['channels']}",
                     digest[:16], note))

    # --- the clips must have been made at the locked voice -----------------
    locked = {"voice_id": voice["voice_id"], "model_id": voice["model_id"],
              "settings": voice["settings"]}
    fp = hashlib.sha256(json.dumps(locked, sort_keys=True,
                                   separators=(",", ":")).encode()).hexdigest()
    if fp != voice.get("lock", {}).get("fingerprint_sha256"):
        problems.append("voice_settings.json no longer matches its own lock fingerprint")
    if LOG.exists():
        gl = json.loads(LOG.read_text(encoding="utf-8"))
        if gl.get("lock_fingerprint") != fp:
            problems.append("generation_log.json records a different voice lock than "
                            "voice_settings.json — the clips were not all made at the "
                            "locked settings")
        if gl.get("failed"):
            problems.append(f"generation_log.json records {len(gl['failed'])} failure(s): "
                            + " ".join(f["scene_id"] for f in gl["failed"]))

    # --- output -----------------------------------------------------------
    print(f"{'scene':<8}{'duration':<11}{'bytes':<12}{'format':<22}{'sha256':<18}note")
    for r in rows:
        print(f"{r[0]:<8}{r[1]:<11}{r[2]:<12}{r[3]:<22}{r[4]:<18}{r[5]}")
    total = sum(float(r[1][:-1]) for r in rows if r[1].endswith("s"))
    print(f"\n{len(rows)} clip(s) · {int(total) // 60}:{int(total) % 60:02d} of speech")

    if problems:
        print(f"\n{len(problems)} PROBLEM(S):")
        for x in problems:
            print(f"  - {x}")
    else:
        print("\nall checks passed")

    if a.report:
        out = [f"# Narration clip validation",
               "",
               "Approved master format: **mp3_44100_128, MP3 container, 44.1 kHz, "
               "mono, ~128 kbps** — lossy, not lossless.",
               "",
               f"- voice `{voice['voice_id']}` · `{voice['model_id']}`",
               f"- settings {voice['settings']}",
               f"- lock fingerprint `{fp[:16]}…`",
               f"- {len(rows)} clip(s), {int(total) // 60}:{int(total) % 60:02d} of speech",
               f"- expected set: **{a.expect_set}** ({len(want)} scenes)",
               f"- held scenes, which must have no audio: {' '.join(sorted(held))}",
               "",
               "| scene | duration | bytes | format | sha256 (16) | note |",
               "|---|---|---|---|---|---|"]
        out += [f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | `{r[4]}` | {r[5]} |" for r in rows]
        out += ["", "## Result", ""]
        out += ([f"- {x}" for x in problems] if problems else ["All checks passed."])
        out += ["", "_No API key, request header or credential appears in this report._"]
        pathlib.Path(a.report).write_text("\n".join(out) + "\n", encoding="utf-8")
        print(f"\nreport: {a.report}")

    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
