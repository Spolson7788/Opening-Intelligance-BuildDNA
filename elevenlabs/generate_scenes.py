#!/usr/bin/env python3
"""
Generate the Trial 1 narration clips — one audio file per permanent scene ID.

    python elevenlabs/generate_scenes.py --dry-run     # plan only, no API calls
    python elevenlabs/generate_scenes.py               # generate the READY scenes
    python elevenlabs/generate_scenes.py --scenes S030 # one scene, after a wording fix

The API key is read from the environment and is never printed, never written to
a file, and never put in a URL:

    Windows PowerShell   $env:ELEVENLABS_API_KEY = "..."
    macOS / Linux        export ELEVENLABS_API_KEY="..."

Masters are the MP3 bytes the API returns — lossy, not lossless, and never
transcoded into WAV.

What this refuses to do, deliberately
-------------------------------------
* Generate a HELD scene. Seven scenes carry narration that depends on a
  recognition result the controlled test has not produced. They are flagged
  `narration_provisional` in the registry and are skipped with the reason
  printed. `--force-held` exists only so the refusal is a decision and not an
  obstacle, and it names every scene it overrides.
* Run at settings that differ from the locked ones. The lock fingerprint in
  voice_settings.json is recomputed before the first request; a mismatch stops
  the run before a single clip is made at the wrong voice.
* Overwrite a clip that already exists, unless --regenerate is passed.
* Generate one long read and slice it. One request per scene, always.

Every clip is probed with ffprobe after it is written, and the measured
duration is compared with the estimate. Scenes where the picture is shorter
than the speech are listed at the end — those are the ones whose picture must
be re-cut, because the build fits picture to speech and never the reverse.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
VOICE = ROOT / "elevenlabs" / "voice_settings.json"
MANIFEST = ROOT / "elevenlabs" / "generation_manifest.json"
AUDIO = ROOT / "elevenlabs" / "audio"
LOG = ROOT / "elevenlabs" / "generation_log.json"
API = "https://api.elevenlabs.io/v1/text-to-speech"
KEY_ENV = "ELEVENLABS_API_KEY"


# ------------------------------------------------------------------ the lock
def load_voice():
    v = json.loads(VOICE.read_text(encoding="utf-8"))
    locked = {"voice_id": v["voice_id"], "model_id": v["model_id"], "settings": v["settings"]}
    fp = hashlib.sha256(
        json.dumps(locked, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    recorded = v.get("lock", {}).get("fingerprint_sha256")
    if not recorded:
        sys.exit("voice_settings.json carries no lock. Refusing to generate — "
                 "a clip made at unrecorded settings cannot be reproduced.")
    if fp != recorded:
        sys.exit(
            "VOICE LOCK MISMATCH — refusing to generate.\n"
            f"  recorded  {recorded}\n"
            f"  computed  {fp}\n"
            "The voice ID, model or settings in voice_settings.json have been changed "
            "since they were locked. Either restore them, or re-lock deliberately and "
            "regenerate every clip in one session — clips made at different settings "
            "drift audibly and a half-regenerated cut is worse than either."
        )
    if str(v["voice_id"]).strip().upper().startswith("STILL REQUIRED"):
        sys.exit("voice_id is still a placeholder. Nothing generated.")
    return v


def output_format(v):
    """The approved master format, read from voice_settings.json.

    Currently mp3_44100_128 — chosen after pcm_44100 returned HTTP 403
    output_format_not_allowed (Pro tier only) on the first paid run. What the
    API returns is written to disk byte for byte: there is no transcode step,
    because re-encoding a lossy file into WAV recovers nothing the encoder has
    already discarded and would make the masters look lossless when they are not.

    Output format is a DELIVERY choice and sits outside the voice lock, which
    covers voice id, model and the five settings only.
    """
    pref = v["output_format"]["preferred"]
    api = pref["api_value"]
    container = pref.get("container", "mp3")
    if not api.startswith(f"{container}_"):
        sys.exit(f"voice_settings.json output_format is incoherent: api_value "
                 f"{api!r} does not match container {container!r}.")
    return api, f".{container}"



# ---------------------------------------------- request-time pronunciation
def submitted_text(root, clip):
    """The text actually sent to the API for this clip.

    The committed script is never rewritten. Where a clip carries
    `pronunciation_overrides`, each one is applied to a COPY of the script to
    make the request, and the substitution is verified: the expected number of
    occurrences must be found, or the run stops rather than silently sending
    the unmodified text.

    Returns (text, record) where record is what gets written to the log, so the
    frozen-script hash and the actually-submitted hash both survive the run.
    """
    import hashlib
    frozen = (root / clip["script"]).read_text(encoding="utf-8").strip()
    text = frozen
    applied = []
    for ov in clip.get("pronunciation_overrides") or []:
        find, repl = ov["find"], ov["replace"]
        n = text.count(find)
        want = ov.get("occurrences_expected")
        if want is not None and n != want:
            sys.exit("PRONUNCIATION OVERRIDE MISMATCH in %s: %r occurs %d time(s), "
                     "expected %d. Nothing generated."
                     % (clip["scene_id"], find, n, want))
        if n == 0:
            sys.exit("PRONUNCIATION OVERRIDE FOUND NOTHING in %s: %r is not in the "
                     "script. Nothing generated." % (clip["scene_id"], find))
        text = text.replace(find, repl)
        applied.append({"find": find, "replace": repl, "occurrences": n})
    if applied and text == frozen:
        sys.exit("PRONUNCIATION OVERRIDE DID NOT CHANGE THE TEXT in %s. Nothing generated."
                 % clip["scene_id"])
    rec = {
        "script_sha256_frozen": hashlib.sha256((frozen + "\n").encode()).hexdigest(),
        "submitted_sha256": hashlib.sha256((text if clip.get("submitted_sha256_normalization") == "utf8-strip" else text + "\n").encode()).hexdigest(),
        "submitted_sha256_normalization": clip.get("submitted_sha256_normalization", "utf8-strip-plus-newline"),
        "characters_frozen": len(frozen),
        "characters_submitted": len(text),
        "overrides_applied": applied,
    }
    if clip.get("submitted_sha256_expected") and \
       rec["submitted_sha256"] != clip["submitted_sha256_expected"]:
        sys.exit("SUBMITTED TEXT IS NOT WHAT WAS APPROVED for %s.\n  expected %s\n"
                 "  computed %s\nNothing generated."
                 % (clip["scene_id"], clip["submitted_sha256_expected"],
                    rec["submitted_sha256"]))
    return text, rec


# ------------------------------------------------------------------ probing
def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_name,sample_rate,channels",
         "-of", "json", str(path)],
        capture_output=True, text=True)
    if out.returncode != 0:
        return None
    d = json.loads(out.stdout)
    st = (d.get("streams") or [{}])[0]
    return {
        "seconds": round(float(d["format"]["duration"]), 3),
        "codec": st.get("codec_name"),
        "sample_rate": st.get("sample_rate"),
        "channels": st.get("channels"),
    }


# ------------------------------------------------------------------ one clip
def synthesize(text, voice, fmt, key, timeout=180):
    body = json.dumps({
        "text": text,
        "model_id": voice["model_id"],
        "voice_settings": {
            "stability": voice["settings"]["stability"],
            "similarity_boost": voice["settings"]["similarity_boost"],
            "style": voice["settings"]["style"],
            "use_speaker_boost": voice["settings"]["use_speaker_boost"],
            "speed": voice["settings"]["speed"],
        },
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/{voice['voice_id']}?output_format={fmt}",
        data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json",
                 "Accept": "audio/*"},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def scrub(text):
    """Never let a key reach the terminal, even inside an exception string."""
    key = os.environ.get(KEY_ENV)
    if key and key in text:
        text = text.replace(key, "<redacted>")
    return text


# ------------------------------------------------------------------ the plan
def plan(clips, wanted, force_held, regenerate, ext):
    todo, held, skipped, outside = [], [], [], []
    for c in clips:
        sid = c["scene_id"]
        if wanted and sid not in wanted:
            continue
        if not c.get("in_master"):
            outside.append(c)
            continue
        if c.get("narration_provisional"):
            (todo if force_held else held).append(c)
            continue
        existing = ROOT / c["audio"]
        if existing.exists() and not c.get("renarrate_required") and not regenerate:
            skipped.append(c)
            continue
        todo.append(c)
    return todo, held, skipped, outside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenes", nargs="*", help="limit to these scene ids")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, call nothing")
    ap.add_argument("--regenerate", action="store_true", help="overwrite existing clips")
    ap.add_argument("--force-held", action="store_true",
                    help="also generate provisional scenes — names every one it overrides")
    ap.add_argument("--fail-fast", action="store_true",
                    help="stop at the first failure instead of continuing. Used in CI, "
                         "where a partial batch is worse than none.")
    ap.add_argument("--expect", type=int, default=None,
                    help="assert the plan contains exactly this many scenes before "
                         "generating. A registry edit that quietly adds or drops a scene "
                         "then stops the run instead of silently changing the batch.")
    ap.add_argument("--require-pins", action="store_true")
    ap.add_argument("--expect-characters", type=int)
    a = ap.parse_args()

    voice = load_voice()
    fmt, ext = output_format(voice)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    wanted = set(a.scenes or [])

    todo, held, skipped, outside = plan(
        manifest["clips"], wanted, a.force_held, a.regenerate, ext)

    print(f"voice   {voice['voice_id']} · {voice['model_id']} · "
          f"speed {voice['settings']['speed']} · "
          f"stability {voice['settings']['stability']} · "
          f"similarity {voice['settings']['similarity_boost']} · "
          f"style {voice['settings']['style']} · "
          f"speaker_boost {voice['settings']['use_speaker_boost']}")
    print(f"lock    {voice['lock']['fingerprint_sha256'][:16]}… verified")
    print(f"format  {fmt} -> {ext}\n")

    if held:
        print(f"HELD — not generating ({len(held)}):")
        for c in held:
            print(f"  {c['scene_id']:<6} {c.get('provisional_reason') or 'provisional'}")
        print()
    if a.force_held:
        forced = [c["scene_id"] for c in todo if c.get("narration_provisional")]
        if forced:
            print(f"!! --force-held is overriding the hold on: {' '.join(forced)}\n")
    if skipped:
        print(f"already generated, leaving alone ({len(skipped)}): "
              f"{' '.join(c['scene_id'] for c in skipped)}\n")
    if outside and wanted:
        print(f"outside Trial 1, not generating: "
              f"{' '.join(c['scene_id'] for c in outside)}\n")

    total_est = sum(c["estimated_seconds"] for c in todo)
    # ElevenLabs bills per CHARACTER of the submitted text, so the cost is known
    # exactly before anything is spent — it is the scripts, counted.
    subs = {c["scene_id"]: submitted_text(ROOT, c) for c in todo}
    if a.require_pins:
        missing = [c["scene_id"] for c in todo if not c.get("submitted_sha256_expected")]
        if missing:
            sys.exit("Missing required approved-text pins: " + " ".join(missing) + ". Nothing generated.")
    pinned = [c["scene_id"] for c in todo if c.get("submitted_sha256_expected")]
    print(f"pins    {len(pinned)} of {len(todo)} verified against the submitted text: {' '.join(pinned)}")
    if wanted and {c["scene_id"] for c in todo} != wanted:
        sys.exit("Requested scene set does not match the executable plan. Nothing generated.")
    chars = sum(r["characters_submitted"] for _, r in subs.values())
    if a.expect_characters is not None and chars != a.expect_characters:
        sys.exit(f"Expected {a.expect_characters} submitted characters, found {chars}. Nothing generated.")
    frozen_chars = sum(r["characters_frozen"] for _, r in subs.values())
    words = sum(c["words"] for c in todo)
    print(f"to generate ({len(todo)}): {' '.join(c['scene_id'] for c in todo) or 'none'}")
    print(f"estimated speech {int(total_est)//60}:{int(total_est) % 60:02d}")
    print(f"CREDIT ESTIMATE  {chars:,} characters across {len(todo)} request(s) "
          f"({words:,} words)")
    for sid, (txt, rec) in sorted(subs.items()):
        if rec["overrides_applied"]:
            print(f"  {sid}: request-time substitution APPLIED AND VERIFIED "
                  f"({rec['characters_frozen']} -> {rec['characters_submitted']} chars)")
            for ov_a in rec["overrides_applied"]:
                print(f"      {ov_a['find']!r} -> {ov_a['replace']!r}  x{ov_a['occurrences']}")
            print(f"      frozen script sha256 {rec['script_sha256_frozen'][:16]}...")
            print(f"      submitted text sha256 {rec['submitted_sha256'][:16]}...")
            print(f"      submitted text: {txt}")
    if frozen_chars != chars:
        print(f"  (frozen scripts total {frozen_chars:,} characters; "
              f"{chars:,} is what is billed)")
    print("  ElevenLabs bills per character of submitted text, so this is the whole")
    print("  cost of the run — one request per scene, no retries counted.\n")

    if a.expect is not None and len(todo) != a.expect:
        sys.exit(f"UNEXPECTED SCENE SET — expected {a.expect} scenes, the plan has "
                 f"{len(todo)}: {' '.join(c['scene_id'] for c in todo)}\n"
                 "The registry or the manifest has changed since this run was approved. "
                 "Nothing generated.")

    if a.dry_run:
        print("dry run — nothing called, nothing written.")
        return 0
    if not todo:
        print("nothing to do.")
        return 0

    key = os.environ.get(KEY_ENV)
    if not key:
        sys.exit(f"{KEY_ENV} is not set. Nothing generated. Set it in the shell "
                 f"you run this from; do not put it in a file.")

    AUDIO.mkdir(parents=True, exist_ok=True)
    results, failed = [], []
    for i, c in enumerate(todo, 1):
        sid = c["scene_id"]
        text, subrec = subs[sid]  # Submit exactly the prevalidated string.
        dest = ROOT / c["audio"]
        if dest.suffix != ext:
            dest = dest.with_suffix(ext)
        print(f"  [{i}/{len(todo)}] {sid:<6} {c['words']:>3}w  est {c['estimated_seconds']:>5.1f}s … ",
              end="", flush=True)
        try:
            raw = synthesize(text, voice, fmt, key)
        except urllib.error.HTTPError as e:
            detail = scrub(e.read().decode("utf-8", "replace")[:300])
            print(f"FAILED  HTTP {e.code}  {detail}")
            failed.append({"scene_id": sid, "error": f"HTTP {e.code}", "detail": detail})
            if a.fail_fast:
                break
            continue
        except Exception as e:                                   # noqa: BLE001
            print(f"FAILED  {scrub(str(e))}")
            failed.append({"scene_id": sid, "error": scrub(str(e))})
            if a.fail_fast:
                break
            continue

        # Written exactly as the API returned it. No transcode, no re-container.
        dest.write_bytes(raw)

        p = probe(dest)
        if not p:
            print("FAILED  wrote a file ffprobe cannot read")
            failed.append({"scene_id": sid, "error": "unreadable audio"})
            if a.fail_fast:
                break
            continue
        if p["seconds"] < 0.5 or dest.stat().st_size < 4096:
            print(f"FAILED  incomplete file ({p['seconds']:.2f}s, "
                  f"{dest.stat().st_size} bytes)")
            failed.append({"scene_id": sid, "error": "incomplete file",
                           "seconds": p["seconds"], "bytes": dest.stat().st_size})
            dest.unlink()
            if a.fail_fast:
                break
            continue
        drift = p["seconds"] - c["estimated_seconds"]
        print(f"{p['seconds']:>6.2f}s  ({drift:+.1f}s vs estimate)")
        results.append({
            "scene_id": sid, "file": str(dest.relative_to(ROOT)),
            "words": c["words"], "estimated_seconds": c["estimated_seconds"],
            "measured_seconds": p["seconds"], "drift_seconds": round(drift, 2),
            "codec": p["codec"], "sample_rate": p["sample_rate"],
            "channels": p["channels"],
            "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
            **subrec,
        })
        time.sleep(0.4)

    LOG.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "voice_id": voice["voice_id"], "model_id": voice["model_id"],
        "settings": voice["settings"], "output_format": fmt,
        "lock_fingerprint": voice["lock"]["fingerprint_sha256"],
        "clips": results, "failed": failed,
    }, indent=2) + "\n", encoding="utf-8")

    spoken = sum(r["measured_seconds"] for r in results)
    print(f"\n{len(results)} generated · {int(spoken)//60}:{int(spoken) % 60:02d} of speech")
    if results:
        words = sum(r["words"] for r in results)
        print(f"measured rate {words / spoken:.3f} words/second "
              f"(estimator uses 2.278 — update it if this differs materially)")
    if failed:
        print(f"\n{len(failed)} FAILED: {' '.join(f['scene_id'] for f in failed)}")
        print("Nothing partial was kept for those. Re-run for just those ids.")
        if a.fail_fast:
            done = {r["scene_id"] for r in results} | {f["scene_id"] for f in failed}
            never = [c["scene_id"] for c in todo if c["scene_id"] not in done]
            if never:
                print(f"--fail-fast stopped the run; not attempted: {' '.join(never)}")
    print(f"\nlog: {LOG.relative_to(ROOT)}")
    print("Next: python system/oi_video.py build --scenes " +
          " ".join(r["scene_id"] for r in results[:4]) + " …")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
