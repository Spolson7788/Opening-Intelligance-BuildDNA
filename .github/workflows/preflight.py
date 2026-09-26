#!/usr/bin/env python3
"""
Preflight for the narration workflow. Fails if anything the run needs is absent,
misplaced, or not what it claims to be.

    python .github/workflows/preflight.py

Runs before the workflow spends anything, and can be run by hand on a checkout
to answer "did every file actually make it into the repository?". It reads
only; it writes nothing and calls nothing over the network.

Exit 0 = every required file present and coherent. Exit 1 = do not dispatch.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

REQUIRED = [
    (".github/workflows/generate-narration.yml", "the workflow itself"),
    ("system/oi_video.py", "voicecheck, inventory, scripts, build"),
    ("system/builder.py", "imported by oi_video.py at start-up"),
    ("elevenlabs/generate_scenes.py", "makes the clips"),
    ("elevenlabs/verify_clips.py", "verifies them"),
    ("elevenlabs/voice_settings.json", "the locked voice"),
    ("elevenlabs/generation_manifest.json", "what to generate"),
    ("scenes/scenes.json", "the scene registry oi_video.py reads"),
    ("elevenlabs/reference/VOICE_REFERENCE.mp3", "the approved voice reference"),
]

EXPECTED_VOICE_ID = "OZxMHsGaBmV5pjMIDIn0"
EXPECTED_MODEL = "eleven_multilingual_v2"
EXPECTED_SETTINGS = {"speed": 0.72, "stability": 0.60, "similarity_boost": 0.75,
                     "style": 0.0, "use_speaker_boost": True}
# The approved run's shape, not a constant baked in once. Set these to what the
# authorization says. Leaving them stale is how a preflight blocks a run it was
# never told about — which is what happened on 15 Sep 2026, when four scenes were
# released from the recognition hold and this file still expected seven held.
# Updated 18 Sep 2026 for run 16. The registry gained Opening 2 (6), Opening 3 (8)
# and the service call (5): 28 -> 43 ready, and the four provisional Opening 3
# scenes join the held set. Run 16 is SCOPED to 16 of the 43 via the workflow's
# `scenes` input; this number is the registry's shape, not the run's size.
EXPECTED_READY = int(os.environ.get("OI_EXPECTED_READY", "70"))
APPROVED_FORMAT = "mp3_44100_128"
MASTER_CONTAINER = "mp3"
# S130/S130A/S140 released by the approved 681-character batch, 20 Sep 2026.
# S311/S314/S315/S316 were held because they described screens that did not
# exist. They were rechecked against the working interface at commit
# f7e01a455fc9a98d64875ec36e2add82b2e41c50 and their wording approved by Stephan
# in batch 18 on 18 Sep 2026, so they leave the held set and the ready count
# moves 43 -> 47. This constant is the registry's shape, not the run's size:
# run 18 is SCOPED to 6 of the 47 via the workflow's `scenes` input.
HELD = set(os.environ.get(
    "OI_HELD", "").split())


def main():
    problems, notes = [], []

    # --- 1. the files themselves -----------------------------------------
    for rel, why in REQUIRED:
        p = ROOT / rel
        if not p.exists():
            problems.append(f"MISSING  {rel}  ({why})")
        elif p.stat().st_size == 0:
            problems.append(f"EMPTY    {rel}  ({why})")
        else:
            notes.append(f"ok  {rel:<48}{p.stat().st_size:>10,} bytes")

    if problems:
        report(notes, problems)
        return 1

    # --- 2. tools ---------------------------------------------------------
    for tool in ("ffprobe", "ffmpeg"):
        if shutil.which(tool):
            v = subprocess.run([tool, "-version"], capture_output=True, text=True)
            notes.append(f"ok  {tool:<48}{v.stdout.splitlines()[0][:40]}")
        else:
            problems.append(f"MISSING  {tool} — verification cannot measure or read clips")

    # --- 3. the voice lock ------------------------------------------------
    v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text(encoding="utf-8"))
    if v.get("voice_id") != EXPECTED_VOICE_ID:
        problems.append(f"voice_id is {v.get('voice_id')!r}, expected {EXPECTED_VOICE_ID!r}")
    if v.get("model_id") != EXPECTED_MODEL:
        problems.append(f"model_id is {v.get('model_id')!r}, expected {EXPECTED_MODEL!r}")
    for k, want in EXPECTED_SETTINGS.items():
        got = v.get("settings", {}).get(k)
        if got != want:
            problems.append(f"setting {k} is {got!r}, expected {want!r}")
    locked = {"voice_id": v.get("voice_id"), "model_id": v.get("model_id"),
              "settings": v.get("settings")}
    fp = hashlib.sha256(json.dumps(locked, sort_keys=True,
                                   separators=(",", ":")).encode()).hexdigest()
    recorded = v.get("lock", {}).get("fingerprint_sha256")
    if not recorded:
        problems.append("voice_settings.json carries no lock fingerprint")
    elif fp != recorded:
        problems.append(f"voice lock MISMATCH — recorded {recorded[:16]}…, computed {fp[:16]}…")
    else:
        notes.append(f"ok  voice lock {fp[:16]}… verified")

    # --- 4. the output format is the approved master format ---------------
    pref = v.get("output_format", {}).get("preferred", {})
    if pref.get("api_value") != APPROVED_FORMAT:
        problems.append(f"preferred output format is {pref.get('api_value')!r}, "
                        f"expected {APPROVED_FORMAT!r} — the approved narration-master "
                        "format. pcm_44100 is Pro-tier only and returns HTTP 403 on this "
                        "subscription.")
    elif pref.get("container") != MASTER_CONTAINER:
        problems.append(f"container is {pref.get('container')!r}, expected "
                        f"{MASTER_CONTAINER!r}")
    else:
        notes.append(f"ok  output format {APPROVED_FORMAT} -> .{MASTER_CONTAINER} "
                     "(approved master format, lossy)")

    # --- 5. the manifest --------------------------------------------------
    man = json.loads((ROOT / "elevenlabs" / "generation_manifest.json").read_text(encoding="utf-8"))
    clips = man.get("clips", [])
    ready = [c for c in clips if c.get("in_master") and not c.get("narration_provisional")]
    held = {c["scene_id"] for c in clips if c.get("narration_provisional")}
    if len(ready) != EXPECTED_READY:
        problems.append(f"manifest lists {len(ready)} ready scenes, expected {EXPECTED_READY}")
    else:
        notes.append(f"ok  manifest lists {EXPECTED_READY} ready scenes")
    if held != HELD:
        problems.append(f"held set is {sorted(held)}, expected {sorted(HELD)}")
    else:
        notes.append(f"ok  {len(HELD)} held scenes flagged: {' '.join(sorted(HELD))}")

    if man.get("voice", {}).get("voice_id") != EXPECTED_VOICE_ID:
        problems.append("the manifest carries a different voice_id than voice_settings.json "
                        "— re-run `python system/oi_video.py scripts`")

    # --- 6. every script the manifest points at ---------------------------
    missing_scripts, empty_scripts, chars = [], [], 0
    for c in ready:
        p = ROOT / c["script"]
        if not p.exists():
            missing_scripts.append(c["scene_id"])
            continue
        text = p.read_text(encoding="utf-8").strip()
        if not text:
            empty_scripts.append(c["scene_id"])
        chars += len(text)
        if c["audio"] != f"elevenlabs/audio/{c['scene_id']}.{MASTER_CONTAINER}":
            problems.append(f"{c['scene_id']}: audio target is {c['audio']}, expected "
                            f"elevenlabs/audio/{c['scene_id']}.{MASTER_CONTAINER}")
    if missing_scripts:
        problems.append(f"missing narration script(s): {' '.join(missing_scripts)}")
    if empty_scripts:
        problems.append(f"empty narration script(s): {' '.join(empty_scripts)}")
    if not missing_scripts and not empty_scripts:
        notes.append(f"ok  {len(ready)} narration scripts present, {chars:,} characters")

    # --- 7. held scenes must have no audio, ready scenes may ---------------
    audio_dir = ROOT / "elevenlabs" / "audio"
    present = (sorted(p.stem for p in audio_dir.glob(f"*.{MASTER_CONTAINER}"))
               if audio_dir.exists() else [])
    stray = sorted(set(present) & HELD)
    if stray:
        problems.append(f"HELD scene(s) already have audio: {' '.join(stray)} — "
                        "remove them before dispatching")
    notes.append(f"ok  elevenlabs/audio/ holds {len(present)} clip(s); "
                 f"{EXPECTED_READY - len([p for p in present if p not in HELD])} still to generate")

    report(notes, problems)
    return 1 if problems else 0


def report(notes, problems):
    print("PREFLIGHT\n")
    for n in notes:
        print("  " + n)
    if problems:
        print(f"\n{len(problems)} PROBLEM(S) — do not dispatch:")
        for p in problems:
            print(f"  - {p}")
    else:
        print("\nAll required files present and coherent.")


if __name__ == "__main__":
    sys.exit(main())
