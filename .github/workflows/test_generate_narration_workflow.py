#!/usr/bin/env python3
"""
Tests for the narration generation workflow. Nothing here runs GitHub Actions —
these read the workflow as data and assert the properties that have to hold
before it is installed, plus they compile and run every embedded Python block,
because a syntax error inside a heredoc is invisible until the run fails.

    python .github/workflows/test_generate_narration_workflow.py
"""
import json
import pathlib
import re
import subprocess
import sys
import textwrap
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WF = ROOT / ".github" / "workflows" / "generate-narration.yml"
RAW = WF.read_text(encoding="utf-8")
DOC = yaml.safe_load(RAW)
# PyYAML parses the `on:` key as the boolean True.
TRIGGERS = DOC[True] if True in DOC else DOC["on"]
JOB = DOC["jobs"]["generate"]
STEPS = JOB["steps"]


def runs():
    return [(s.get("name", "?"), s["run"]) for s in STEPS if "run" in s]


def step_named(fragment):
    for i, s in enumerate(STEPS):
        if fragment.lower() in s.get("name", "").lower():
            return i, s
    raise AssertionError(f"no step named like {fragment!r}")


def embedded_python(body):
    """Every `python - <<'PY' ... PY` block in a run body, de-indented.

    YAML block scalars have already stripped their common indentation by the
    time the body reaches us, so the amount to remove is whatever the block
    itself carries — not a fixed number.
    """
    return [textwrap.dedent(b)
            for b in re.findall(r"python - <<'PY'\n(.*?)\n\s*PY\b", body, re.S)]


class TestTriggers(unittest.TestCase):
    def test_manual_dispatch_only(self):
        self.assertEqual(list(TRIGGERS), ["workflow_dispatch"])

    def test_no_automatic_trigger_of_any_kind(self):
        for bad in ("schedule", "push", "pull_request", "pull_request_target",
                    "workflow_call", "repository_dispatch", "issue_comment"):
            self.assertNotIn(bad, TRIGGERS)

    def test_confirmation_input_is_required(self):
        i = TRIGGERS["workflow_dispatch"]["inputs"]["confirm"]
        self.assertTrue(i["required"])
        self.assertEqual(i["default"], "")

    def test_dry_run_defaults_to_true(self):
        i = TRIGGERS["workflow_dispatch"]["inputs"]["dry_run"]
        self.assertIs(i["default"], True)
        self.assertEqual(i["type"], "boolean")

    def test_expected_scene_count_defaults_to_24(self):
        i = TRIGGERS["workflow_dispatch"]["inputs"]["expected_scene_count"]
        self.assertEqual(i["default"], "24")
        self.assertTrue(i["required"])


class TestJobShape(unittest.TestCase):
    def test_runs_in_a_named_environment(self):
        self.assertEqual(JOB["environment"], "elevenlabs-narration")

    def test_contents_permission_is_read_only(self):
        self.assertEqual(DOC["permissions"], {"contents": "read"})

    def test_no_write_permission_anywhere(self):
        blob = json.dumps(DOC)
        self.assertNotIn('"write"', blob)
        self.assertNotIn("write-all", blob)

    def test_concurrency_prevents_two_paid_runs_at_once(self):
        self.assertEqual(DOC["concurrency"]["group"], "elevenlabs-narration")
        self.assertIs(DOC["concurrency"]["cancel-in-progress"], False)

    def test_job_has_a_timeout(self):
        self.assertIsInstance(JOB["timeout-minutes"], int)


class TestSecretHandling(unittest.TestCase):
    def test_no_expression_is_interpolated_into_any_run_body(self):
        """`${{ }}` inside `run:` is a script-injection pattern. Use env:."""
        for name, body in runs():
            self.assertNotIn("${{", body, f"step {name!r} interpolates an expression")

    def test_the_secret_is_only_ever_reached_through_env(self):
        for s in STEPS:
            for v in (s.get("env") or {}).values():
                if "secrets." in str(v):
                    self.assertEqual(str(v).strip(), "${{ secrets.ELEVENLABS_API_KEY }}")
        self.assertNotIn("secrets.", "".join(b for _, b in runs()))

    def test_only_one_secret_is_referenced(self):
        found = set(re.findall(r"secrets\.([A-Za-z0-9_]+)", RAW))
        self.assertEqual(found, {"ELEVENLABS_API_KEY"})

    def test_the_key_is_never_echoed_or_lengthed(self):
        body = "".join(b for _, b in runs())
        for bad in ("echo $ELEVENLABS_API_KEY", "echo \"$ELEVENLABS_API_KEY\"",
                    "${#ELEVENLABS_API_KEY}", "print(key)", "base64"):
            self.assertNotIn(bad, body)

    def test_no_authorization_header_is_ever_set(self):
        """The redaction step searches for these strings; nothing else may use them.

        Checked line by line rather than by cutting the step out of the file:
        the parsed step body is de-indented and no longer matches the raw text.
        """
        for token in ("Authorization", "xi-api-key"):
            for n, line in enumerate(RAW.splitlines(), 1):
                if token in line:
                    self.assertIn("for token in", line,
                                  f"line {n} uses {token!r} outside the redaction check")

    def test_a_redaction_check_runs_before_upload(self):
        red, _ = step_named("Redaction check")
        up, _ = step_named("Upload the WAV masters")
        self.assertLess(red, up)


class TestPartialBatchSurvives(unittest.TestCase):
    """A failed scene must not throw away the clips already paid for."""

    def test_verify_and_upload_run_even_after_a_failed_generation(self):
        for name in ("Verify every clip", "Upload the WAV masters",
                     "Confirm the voice held"):
            _, s = step_named(name)
            self.assertIn("!cancelled()", s["if"], name)

    def test_upload_is_still_gated_on_not_being_a_dry_run(self):
        _, s = step_named("Upload the WAV masters")
        self.assertIn("inputs.dry_run == false", s["if"])

    def test_successful_clips_are_never_regenerated(self):
        """--regenerate would re-spend on clips already paid for."""
        _, s = step_named("Generate the permitted")
        self.assertNotIn("--regenerate", s["run"])
        for name, body in runs():
            self.assertNotIn("--regenerate", body, f"step {name!r} passes --regenerate")
        # It may appear in a comment explaining its absence, but nowhere else.
        for n, line in enumerate(RAW.splitlines(), 1):
            if "--regenerate" in line:
                self.assertTrue(line.lstrip().startswith("#"),
                                f"line {n} uses --regenerate outside a comment")


class TestOrderOfChecks(unittest.TestCase):
    def test_voicecheck_runs_before_generation(self):
        vc, _ = step_named("Voice lock")
        gen, _ = step_named("Generate the permitted")
        self.assertLess(vc, gen)

    def test_confirmation_gate_is_before_everything_that_spends(self):
        conf, _ = step_named("Confirmation gate")
        gen, _ = step_named("Generate the permitted")
        self.assertLess(conf, gen)

    def test_the_ids_and_the_credit_estimate_print_before_generation(self):
        ids, _ = step_named("permitted and the")
        est, _ = step_named("credit estimate")
        gen, _ = step_named("Generate the permitted")
        self.assertLess(ids, gen)
        self.assertLess(est, gen)

    def test_verification_runs_after_generation(self):
        gen, _ = step_named("Generate the permitted")
        ver, _ = step_named("Verify every clip")
        self.assertLess(gen, ver)


class TestGenerationIsBounded(unittest.TestCase):
    def test_generation_passes_fail_fast_and_expect(self):
        _, s = step_named("Generate the permitted")
        self.assertIn("--fail-fast", s["run"])
        self.assertIn("--expect", s["run"])

    def test_generation_never_forces_held_scenes(self):
        self.assertNotIn("--force-held", RAW)

    def test_generation_is_skipped_on_a_dry_run(self):
        _, s = step_named("Generate the permitted")
        self.assertIn("inputs.dry_run == false", s["if"])

    def test_verification_expects_exactly_the_ready_set(self):
        _, s = step_named("Verify every clip")
        self.assertIn("--expect-set ready", s["run"])


class TestNoCommitting(unittest.TestCase):
    def test_nothing_commits_pushes_or_tags(self):
        body = "".join(b for _, b in runs())
        for bad in ("git commit", "git push", "git tag", "git add"):
            self.assertNotIn(bad, body)

    def test_no_action_that_writes_back_to_the_repo(self):
        for s in STEPS:
            u = s.get("uses", "")
            self.assertNotIn("git-auto-commit", u)
            self.assertNotIn("create-pull-request", u)

    def test_a_step_asserts_the_tree_was_not_committed(self):
        step_named("Nothing was committed")


class TestArtifact(unittest.TestCase):
    def test_uploads_only_audio_manifest_log_and_report(self):
        _, s = step_named("Upload the WAV masters")
        paths = [p.strip() for p in s["with"]["path"].strip().splitlines()]
        self.assertEqual(sorted(paths), sorted([
            "elevenlabs/audio/",
            "elevenlabs/generation_manifest.json",
            "elevenlabs/generation_log.json",
            "validation_report.md"]))

    def test_never_uploads_voice_settings_or_whole_directories(self):
        _, s = step_named("Upload the WAV masters")
        paths = s["with"]["path"]
        for bad in ("scenes/", "recordings/", "audit/", ".git", "prototype/"):
            self.assertNotIn(bad, paths)

    def test_empty_upload_is_an_error_not_a_pass(self):
        _, s = step_named("Upload the WAV masters")
        self.assertEqual(s["with"]["if-no-files-found"], "error")

    def test_artifact_has_a_retention_limit(self):
        _, s = step_named("Upload the WAV masters")
        self.assertLessEqual(int(s["with"]["retention-days"]), 30)


class TestEmbeddedPython(unittest.TestCase):
    """A syntax error inside a heredoc only shows up when the run fails."""

    def test_every_embedded_block_compiles(self):
        found = 0
        for name, body in runs():
            for block in embedded_python(body):
                found += 1
                try:
                    compile(block, f"<{name}>", "exec")
                except SyntaxError as e:
                    self.fail(f"step {name!r} has a Python syntax error: {e}")
        self.assertGreaterEqual(found, 3)

    def test_the_embedded_blocks_actually_run_here(self):
        for name, body in runs():
            for block in embedded_python(body):
                r = subprocess.run([sys.executable, "-c", block],
                                   capture_output=True, text=True, cwd=ROOT)
                self.assertEqual(r.returncode, 0,
                                 f"step {name!r} failed: {r.stderr[-400:]}")

    def test_the_held_scene_block_names_all_seven(self):
        _, s = step_named("permitted and the")
        r = subprocess.run([sys.executable, "-c", embedded_python(s["run"])[0]],
                           capture_output=True, text=True, cwd=ROOT)
        for sid in ("S130", "S130A", "S140", "S180", "S190A", "S210", "S220"):
            self.assertIn(sid, r.stdout)
        self.assertIn("PERMITTED (24)", r.stdout)


class TestMasterFormat(unittest.TestCase):
    def test_the_locked_output_format_is_pcm_44100(self):
        v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text())
        pref = v["output_format"]["preferred"]
        self.assertEqual(pref["api_value"], "pcm_44100")
        self.assertEqual(pref["container"], "wav")
        self.assertEqual(pref["sample_rate"], 44100)
        self.assertEqual(pref["channels"], 1)

    def test_every_manifest_audio_target_is_a_wav_named_for_its_scene(self):
        man = json.loads((ROOT / "elevenlabs" / "generation_manifest.json").read_text())
        for c in man["clips"]:
            if c["in_master"] and not c["narration_provisional"]:
                self.assertEqual(c["audio"], f"elevenlabs/audio/{c['scene_id']}.wav")

    def test_verification_requires_wav_and_rejects_mp3_as_a_master(self):
        src = (ROOT / "elevenlabs" / "verify_clips.py").read_text()
        self.assertIn('MASTER_CODEC = "pcm_s16le"', src)
        self.assertIn('MASTER_SUFFIX = ".wav"', src)
        self.assertIn("MASTER_RATE = 44100", src)

    def test_verification_rejects_a_silent_clip(self):
        src = (ROOT / "elevenlabs" / "verify_clips.py").read_text()
        self.assertIn("def audible(", src)
        self.assertIn("continuous silence", src)


class TestPreflight(unittest.TestCase):
    def test_preflight_runs_before_any_gate_that_can_spend(self):
        pre, _ = step_named("Preflight")
        gen, _ = step_named("Generate the permitted")
        self.assertLess(pre, gen)

    def test_preflight_passes_on_this_checkout(self):
        r = subprocess.run([sys.executable, ".github/workflows/preflight.py"],
                           capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stdout[-600:])

    def test_dependencies_are_pinned(self):
        req = (ROOT / ".github" / "workflows" / "requirements.txt").read_text()
        pins = [l.strip() for l in req.splitlines()
                if l.strip() and not l.strip().startswith("#")]
        self.assertTrue(pins)
        for line in pins:
            self.assertIn("==", line, f"unpinned dependency: {line}")

    def test_the_workflow_installs_those_pins(self):
        _, s = step_named("Python dependencies")
        self.assertIn("requirements.txt", s["run"])


class TestReferencedFilesExist(unittest.TestCase):
    def test_every_script_the_workflow_calls_is_present(self):
        for rel in ("system/oi_video.py", "system/builder.py",
                    "elevenlabs/generate_scenes.py",
                    "elevenlabs/verify_clips.py",
                    "elevenlabs/generation_manifest.json",
                    "elevenlabs/voice_settings.json",
                    "scenes/scenes.json",
                    ".github/workflows/preflight.py",
                    ".github/workflows/requirements.txt"):
            self.assertTrue((ROOT / rel).exists(), rel)

    def test_the_review_instructions_exist(self):
        self.assertTrue((ROOT / "elevenlabs" / "WORKFLOW_REVIEW.md").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
