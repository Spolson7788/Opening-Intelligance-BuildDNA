"""
Scene builder for the OI Modular Video Production System.

One scene in, one scene MP4 out. The master is always an assembly of scene
modules — never a re-export of a flattened video.

Rules enforced here:
  * Speech is never sped up or slowed down. If a scene's picture is shorter
    than its narration the last frame is held; if longer, the tail is trimmed.
    Both are reported.
  * A scene MP4 is rebuilt only when its inputs are newer than it, unless it is
    named explicitly.
  * Missing assets stop that scene and are reported, never silently skipped.
"""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
CANVAS = (1080, 1920)
BG = "0x0F2044"
APP_H = 1740
APP_H_CARD = 1150
FPS = 30
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def sh(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(f"ffmpeg failed:\n{' '.join(map(str, cmd))}\n{p.stderr[-2000:]}")
    return p.stdout


def duration(path):
    return float(sh(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                     "-of", "csv=p=0", str(path)]).strip())


def esc(t):
    for a, b in [("\\", "\\\\"), (":", "\\:"), ("'", "’"), ("%", "\\%")]:
        t = t.replace(a, b)
    return t


def audio_for(scene):
    """Narration clip: .wav preferred, .mp3 accepted."""
    wav = ROOT / scene["narration_file"]
    if wav.exists():
        return wav
    mp3 = wav.with_suffix(".mp3")
    return mp3 if mp3.exists() else wav


def inputs_for(scene):
    """Every file this scene needs, whether or not it exists."""
    need = [audio_for(scene)]
    if scene.get("still"):
        need.append(ROOT / "assets" / scene["still"])
    else:
        need.append(ROOT / scene["screen_recording"])
    if scene.get("overlay_card"):
        need.append(ROOT / "assets" / scene["overlay_card"])
    return need


def missing_inputs(scene):
    return [p for p in inputs_for(scene) if not p.exists()]


def is_stale(scene):
    """True when the built scene is older than any of its inputs."""
    out = ROOT / "builds" / "scenes" / f"{scene['scene_id']}.mp4"
    if not out.exists():
        return True
    m = out.stat().st_mtime
    return any(p.exists() and p.stat().st_mtime > m for p in inputs_for(scene))


def build_scene(scene, report):
    sid = scene["scene_id"]
    out = ROOT / "builds" / "scenes" / f"{sid}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)

    gone = missing_inputs(scene)
    if gone:
        report.append({"scene": sid, "result": "missing-assets",
                       "detail": [str(p.relative_to(ROOT)) for p in gone]})
        return None

    audio = audio_for(scene)
    a_len = duration(audio)
    target = max(a_len + 0.35, 1.5)
    app_h = APP_H_CARD if scene.get("overlay_card") else APP_H

    if scene.get("still"):
        src = ROOT / "assets" / scene["still"]
        # still_max_height caps the presented height, so a low-resolution asset is
        # shown at a modest size instead of being stretched across the whole pane.
        cap = scene.get("still_max_height")
        if cap:
            from PIL import Image as _I
            nat_h = _I.open(src).size[1]
            app_h = min(app_h, int(cap))
            fit = (f"still, presented {app_h}px tall = {app_h / nat_h:.2f}x native {nat_h}px"
                   + (" — upscale adds no detail" if app_h > nat_h else ""))
        else:
            fit = "still"
        inputs = ["-loop", "1", "-t", f"{target:.3f}", "-i", str(src)]
        chain = [f"fps={FPS}", f"scale=-2:{app_h}:flags=lanczos"]
    else:
        clip = ROOT / scene["screen_recording"]
        v_len = duration(clip)
        inputs = ["-i", str(clip)]
        chain = [f"fps={FPS}", f"scale=-2:{app_h}:flags=lanczos"]
        if v_len < target - 0.05:
            chain.append(f"tpad=stop_mode=clone:stop_duration={target - v_len:.3f}")
            fit = f"held last frame {target - v_len:.1f}s"
        elif v_len > target + 0.05:
            fit = f"trimmed {v_len - target:.1f}s of tail"
        else:
            fit = "exact"

    filt = [f"[0:v]{','.join(chain)}[app]",
            f"color=c={BG}:s={CANVAS[0]}x{CANVAS[1]}:d={target:.3f}:r={FPS}[bg]"]
    y_app = 40 if scene.get("overlay_card") else (CANVAS[1] - 140 - app_h) // 2
    filt.append(f"[bg][app]overlay=x=(W-w)/2:y={y_app}:shortest=1[v0]")
    last, idx = "v0", 1

    if scene.get("overlay_card"):
        inputs += ["-loop", "1", "-i", str(ROOT / "assets" / scene["overlay_card"])]
        filt.append(f"[{idx}:v]scale=960:-1[card]")
        filt.append(f"[{last}][card]overlay=x=(W-w)/2:y={APP_H_CARD + 90}:shortest=1[v1]")
        last, idx = "v1", idx + 1

    cap = scene.get("caption")
    if cap:
        size = min(40, int((CANVAS[0] - 80) / (len(cap) * 0.52)))
        if size < 26:
            report.append({"scene": sid, "result": "caption-too-long", "detail": cap})
            return None
        filt.append(f"[{last}]drawtext=fontfile={FONT}:text='{esc(cap)}':fontcolor=white@0.92:"
                    f"fontsize={size}:x=(w-text_w)/2:y={CANVAS[1]-100}[v2]")
        last = "v2"

    sh(["ffmpeg", "-y", *inputs, "-i", str(audio),
        "-filter_complex", ";".join(filt),
        "-map", f"[{last}]", "-map", f"{idx}:a", "-t", f"{target:.3f}",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(out)])

    report.append({"scene": sid, "result": "built", "seconds": round(target, 2),
                   "narration": round(a_len, 2), "fit": fit, "status": scene["status"]})
    return target


def assemble(registry, quality, report):
    """Concatenate built scene modules into a master. Never re-encodes."""
    scenes = [s for s in registry["scenes"] if s.get("in_master")]
    parts, lengths, blockers = [], {}, []
    for s in scenes:
        mp4 = ROOT / "builds" / "scenes" / f"{s['scene_id']}.mp4"
        if not mp4.exists():
            blockers.append({"scene": s["scene_id"], "why": "no built module",
                             "status": s["status"], "blocked_reason": s.get("blocked_reason")})
            continue
        if quality == "delivery" and s["status"] != "Approved":
            blockers.append({"scene": s["scene_id"], "why": f"status is {s['status']}, delivery needs Approved"})
            continue
        parts.append(mp4)
        lengths[s["scene_id"]] = duration(mp4)

    if blockers and quality == "delivery":
        report.append({"assemble": "refused", "quality": quality, "blockers": blockers})
        return None

    outdir = ROOT / "builds" / quality
    outdir.mkdir(parents=True, exist_ok=True)
    v = registry["video_version"]
    out = outdir / f"OpeningIntelligence_{quality}_v{v}.mp4"
    lst = outdir / "concat.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
    sh(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
        "-c", "copy", "-movflags", "+faststart", str(out)])

    total, lines, run = sum(lengths.values()), [], 0.0
    seen = set()
    for s in scenes:
        if s["scene_id"] not in lengths:
            continue
        if s["chapter"] not in seen:
            seen.add(s["chapter"])
            title = next(c["title"] for c in registry["chapters"] if c["id"] == s["chapter"])
            lines.append(f"{int(run)//60:02d}:{int(run)%60:02d}  {title}")
        run += lengths[s["scene_id"]]
    (outdir / "chapters.txt").write_text("\n".join(lines) + "\n")

    report.append({"assemble": "built", "quality": quality, "file": str(out.relative_to(ROOT)),
                   "scenes": len(parts), "runtime": f"{int(total)//60}:{int(total)%60:02d}",
                   "incomplete": blockers})
    return out
