#!/usr/bin/env python3
"""
Tests for the narration generator. No ElevenLabs calls — a local HTTP server
stands in for the API, so the request that would be sent is inspected rather
than trusted.

    python elevenlabs/test_generate_scenes.py
"""
import http.server
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gen", ROOT / "elevenlabs" / "generate_scenes.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)


class FakeAPI(http.server.BaseHTTPRequestHandler):
    captured = {}

    def do_POST(self):                                           # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        FakeAPI.captured = {
            "path": self.path,
            # Header names are case-insensitive on the wire and urllib title-cases
            # them, so look them up that way rather than by exact spelling.
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "raw_headers": str(self.headers),
            "body": json.loads(self.rfile.read(n) or b"{}"),
        }
        pcm = b"\x00\x00" * 4410          # 0.1 s of 16-bit mono silence at 44.1k
        self.send_response(200)
        self.send_header("Content-Type", "audio/pcm")
        self.send_header("Content-Length", str(len(pcm)))
        self.end_headers()
        self.wfile.write(pcm)

    def log_message(self, *a):
        pass


class TestLock(unittest.TestCase):
    def test_real_settings_file_passes_its_own_lock(self):
        v = gen.load_voice()
        self.assertEqual(v["voice_id"], "OZxMHsGaBmV5pjMIDIn0")
        self.assertEqual(v["model_id"], "eleven_multilingual_v2")
        self.assertEqual(v["settings"]["speed"], 0.72)
        self.assertEqual(v["settings"]["stability"], 0.60)
        self.assertEqual(v["settings"]["similarity_boost"], 0.75)
        self.assertEqual(v["settings"]["style"], 0.0)
        self.assertIs(v["settings"]["use_speaker_boost"], True)

    def _with_voice(self, mutate):
        v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text())
        mutate(v)
        tmp = pathlib.Path(tempfile.mkdtemp()) / "voice_settings.json"
        tmp.write_text(json.dumps(v))
        old, gen.VOICE = gen.VOICE, tmp
        try:
            return gen.load_voice()
        finally:
            gen.VOICE = old

    def test_changed_speed_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            self._with_voice(lambda v: v["settings"].__setitem__("speed", 1.0))
        self.assertIn("VOICE LOCK MISMATCH", str(e.exception))

    def test_changed_voice_id_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            self._with_voice(lambda v: v.__setitem__("voice_id", "SOMETHINGELSE00000"))
        self.assertIn("VOICE LOCK MISMATCH", str(e.exception))

    def test_changed_model_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            self._with_voice(lambda v: v.__setitem__("model_id", "eleven_turbo_v2"))
        self.assertIn("VOICE LOCK MISMATCH", str(e.exception))

    def test_speaker_boost_off_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            self._with_voice(lambda v: v["settings"].__setitem__("use_speaker_boost", False))
        self.assertIn("VOICE LOCK MISMATCH", str(e.exception))

    def test_missing_lock_block_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            self._with_voice(lambda v: v.pop("lock"))
        self.assertIn("no lock", str(e.exception))

    def test_placeholder_voice_id_is_refused(self):
        def mutate(v):
            v["voice_id"] = "STILL REQUIRED — copy it from the UI"
            import hashlib
            locked = {"voice_id": v["voice_id"], "model_id": v["model_id"],
                      "settings": v["settings"]}
            v["lock"]["fingerprint_sha256"] = hashlib.sha256(
                json.dumps(locked, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        with self.assertRaises(SystemExit) as e:
            self._with_voice(mutate)
        self.assertIn("placeholder", str(e.exception))


class TestPlan(unittest.TestCase):
    def setUp(self):
        self.clips = json.loads(
            (ROOT / "elevenlabs" / "generation_manifest.json").read_text())["clips"]

    def test_held_scenes_are_held(self):
        todo, held, _, _ = gen.plan(self.clips, set(), False, False, ".wav")
        self.assertEqual(sorted(c["scene_id"] for c in held),
                         ["S130", "S130A", "S140", "S180", "S190A", "S210", "S220"])
        self.assertEqual(len(todo), 24)
        for c in todo:
            self.assertFalse(c["narration_provisional"], c["scene_id"])

    def test_the_24_are_exactly_the_trial_1_ready_scenes(self):
        todo, _, _, _ = gen.plan(self.clips, set(), False, False, ".wav")
        self.assertEqual(
            sorted(c["scene_id"] for c in todo),
            sorted(["S010", "S020", "S030", "S040", "S050", "S060", "S070", "S080",
                    "S090", "S100", "S110", "S120", "S130B", "S150", "S155", "S160",
                    "S170", "S190", "S200", "S230", "S240", "S260", "S270", "S275"]))

    def test_scenes_outside_trial_1_are_never_in_todo(self):
        todo, _, _, outside = gen.plan(self.clips, set(), True, True, ".wav")
        ids = {c["scene_id"] for c in todo}
        for sid in ("S130C", "S280", "R010", "R020", "R030", "R040"):
            self.assertNotIn(sid, ids)
        self.assertIn("R010", {c["scene_id"] for c in outside})

    def test_force_held_moves_held_into_todo(self):
        todo, held, _, _ = gen.plan(self.clips, set(), True, False, ".wav")
        self.assertEqual(held, [])
        self.assertEqual(len(todo), 31)

    def test_scene_filter_narrows_to_one(self):
        todo, _, _, _ = gen.plan(self.clips, {"S030"}, False, False, ".wav")
        self.assertEqual([c["scene_id"] for c in todo], ["S030"])

    def test_a_held_scene_asked_for_by_name_is_still_held(self):
        todo, held, _, _ = gen.plan(self.clips, {"S220"}, False, False, ".wav")
        self.assertEqual(todo, [])
        self.assertEqual([c["scene_id"] for c in held], ["S220"])

    def test_every_todo_scene_has_a_script_file_with_text(self):
        todo, _, _, _ = gen.plan(self.clips, set(), False, False, ".wav")
        for c in todo:
            p = ROOT / c["script"]
            self.assertTrue(p.exists(), c["scene_id"])
            self.assertTrue(p.read_text(encoding="utf-8").strip(), c["scene_id"])

    def test_scripts_carry_no_stage_directions(self):
        todo, _, _, _ = gen.plan(self.clips, set(), False, False, ".wav")
        for c in todo:
            t = ROOT / c["script"]
            text = t.read_text(encoding="utf-8")
            for bad in ("[", "]", "SCENE", ".mp4", ".wav", "CH0"):
                self.assertNotIn(bad, text, f"{c['scene_id']} contains {bad!r}")


class TestRequest(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.api_old, gen.API = gen.API, f"http://127.0.0.1:{self.srv.server_port}/v1/text-to-speech"

    def tearDown(self):
        gen.API = self.api_old
        self.srv.shutdown()
        self.srv.server_close()

    def test_request_carries_the_locked_values_and_the_key_in_a_header(self):
        v = gen.load_voice()
        raw = gen.synthesize("a test line", v, "pcm_44100", "test-key-abc")
        cap = FakeAPI.captured
        self.assertEqual(cap["body"]["model_id"], "eleven_multilingual_v2")
        self.assertEqual(cap["body"]["text"], "a test line")
        self.assertEqual(cap["body"]["voice_settings"]["speed"], 0.72)
        self.assertEqual(cap["body"]["voice_settings"]["stability"], 0.60)
        self.assertEqual(cap["body"]["voice_settings"]["similarity_boost"], 0.75)
        self.assertEqual(cap["body"]["voice_settings"]["style"], 0.0)
        self.assertIs(cap["body"]["voice_settings"]["use_speaker_boost"], True)
        self.assertEqual(cap["headers"]["xi-api-key"], "test-key-abc")
        self.assertNotIn("Authorization", cap["raw_headers"])
        self.assertIn("OZxMHsGaBmV5pjMIDIn0", cap["path"])
        self.assertEqual(len(raw), 8820)

    def test_the_key_is_never_in_the_url_or_the_body(self):
        v = gen.load_voice()
        gen.synthesize("x", v, "pcm_44100", "test-key-abc")
        self.assertNotIn("test-key-abc", FakeAPI.captured["path"])
        self.assertNotIn("test-key-abc", json.dumps(FakeAPI.captured["body"]))

    def test_scrub_removes_the_key_from_any_message(self):
        os.environ[gen.KEY_ENV] = "sk-secret-value"
        try:
            self.assertEqual(gen.scrub("failed with sk-secret-value in it"),
                             "failed with <redacted> in it")
        finally:
            del os.environ[gen.KEY_ENV]


class TierAwareAPI(http.server.BaseHTTPRequestHandler):
    """Stands in for ElevenLabs on a non-Pro subscription.

    pcm_* is refused exactly as the real API refused it on the first paid run;
    mp3_44100_128 is served.
    """
    seen = []

    def do_POST(self):                                           # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        fmt = ""
        if "output_format=" in self.path:
            fmt = self.path.split("output_format=")[1].split("&")[0]
        TierAwareAPI.seen.append(fmt)
        if fmt.startswith("pcm_"):
            body = json.dumps({"detail": {
                "status": "output_format_not_allowed",
                "message": (f"Output format '{fmt}' is only available on the "
                            "Pro tier and above.")}}).encode()
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        mp3 = pathlib.Path(__file__).resolve().parents[1] / "elevenlabs" / "_fixture.mp3"
        data = mp3.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class TestTierRefusalAndTheFix(unittest.TestCase):
    """Reproduce the 403, then prove the revised format is accepted."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = ROOT / "elevenlabs" / "_fixture.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        "sine=frequency=220:duration=2:sample_rate=44100",
                        "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k",
                        str(cls.fixture)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.unlink(missing_ok=True)

    def setUp(self):
        TierAwareAPI.seen = []
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), TierAwareAPI)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.old, gen.API = gen.API, f"http://127.0.0.1:{self.srv.server_port}/v1/text-to-speech"

    def tearDown(self):
        gen.API = self.old
        self.srv.shutdown()
        self.srv.server_close()

    def test_pcm_44100_is_refused_exactly_as_the_paid_run_was(self):
        v = gen.load_voice()
        with self.assertRaises(urllib.error.HTTPError) as e:
            gen.synthesize("a line", v, "pcm_44100", "k")
        self.assertEqual(e.exception.code, 403)
        detail = e.exception.read().decode()
        self.assertIn("output_format_not_allowed", detail)
        self.assertIn("Pro tier and above", detail)

    def test_the_approved_format_is_accepted(self):
        v = gen.load_voice()
        raw = gen.synthesize("a line", v, "mp3_44100_128", "k")
        self.assertGreater(len(raw), 8192)
        self.assertEqual(TierAwareAPI.seen, ["mp3_44100_128"])

    def test_the_bytes_are_a_real_mp3_and_are_written_unchanged(self):
        v = gen.load_voice()
        raw = gen.synthesize("a line", v, "mp3_44100_128", "k")
        self.assertEqual(raw, self.fixture.read_bytes(), "bytes were altered in flight")
        d = pathlib.Path(tempfile.mkdtemp()) / "S999.mp3"
        d.write_bytes(raw)
        info = gen.probe(d)
        self.assertEqual(info["codec"], "mp3")
        self.assertEqual(info["sample_rate"], "44100")
        self.assertEqual(info["channels"], 1)

    def test_the_configured_format_is_the_one_sent(self):
        v = gen.load_voice()
        fmt, ext = gen.output_format(v)
        self.assertEqual((fmt, ext), ("mp3_44100_128", ".mp3"))
        gen.synthesize("a line", v, fmt, "k")
        self.assertEqual(TierAwareAPI.seen, ["mp3_44100_128"])


class TestNoTranscoding(unittest.TestCase):
    def test_the_generator_has_no_wav_wrapper_left(self):
        src = (ROOT / "elevenlabs" / "generate_scenes.py").read_text()
        self.assertNotIn("wrap_pcm_as_wav", src)
        self.assertNotIn("import wave", src)

    def test_nothing_shells_out_to_ffmpeg_to_convert(self):
        src = (ROOT / "elevenlabs" / "generate_scenes.py").read_text()
        self.assertNotIn('"ffmpeg"', src)

    def test_the_settings_file_calls_the_masters_lossy(self):
        v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text())
        pref = v["output_format"]["preferred"]
        self.assertIs(pref["lossy"], True)
        self.assertIn("Lossy", pref["honest_description"])
        # "lossless" may appear only inside an instruction NOT to use the word.
        for field in ("api_value", "container", "why"):
            self.assertNotIn("lossless", str(pref[field]).lower(), field)
        self.assertIn("do not describe these masters as lossless",
                      pref["honest_description"].lower())


class TestAudioWriting(unittest.TestCase):
    def test_probe_returns_none_on_a_file_that_is_not_audio(self):
        d = pathlib.Path(tempfile.mkdtemp()) / "junk.wav"
        d.write_bytes(b"not audio at all")
        self.assertIsNone(gen.probe(d))

    def test_output_format_follows_voice_settings(self):
        fmt, ext = gen.output_format(gen.load_voice())
        self.assertEqual((fmt, ext), ("mp3_44100_128", ".mp3"))


class TestCommandLine(unittest.TestCase):
    def run_cli(self, *args, env=None):
        e = dict(os.environ)
        e.pop(gen.KEY_ENV, None)
        e.update(env or {})
        return subprocess.run(
            [sys.executable, str(ROOT / "elevenlabs" / "generate_scenes.py"), *args],
            capture_output=True, text=True, env=e, cwd=ROOT)

    def test_dry_run_needs_no_key_and_calls_nothing(self):
        r = self.run_cli("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("to generate (24)", r.stdout)
        self.assertIn("HELD — not generating (7)", r.stdout)
        self.assertIn("dry run — nothing called, nothing written.", r.stdout)

    def test_dry_run_names_the_locked_voice(self):
        r = self.run_cli("--dry-run")
        self.assertIn("OZxMHsGaBmV5pjMIDIn0", r.stdout)
        self.assertIn("lock", r.stdout)
        self.assertIn("verified", r.stdout)

    def test_missing_key_stops_before_any_clip(self):
        r = self.run_cli("--scenes", "S030")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is not set", r.stdout + r.stderr)
        self.assertIn("Nothing generated", r.stdout + r.stderr)

    def test_no_clip_files_were_created_by_the_test_run(self):
        """.gitkeep is meant to be there; a clip is not."""
        stray = sorted(p.name for p in (ROOT / "elevenlabs" / "audio").glob("*")
                       if p.name != ".gitkeep")
        self.assertEqual(stray, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
