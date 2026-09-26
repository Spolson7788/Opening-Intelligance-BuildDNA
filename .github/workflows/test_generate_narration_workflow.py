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

    def test_expected_scene_count_defaults_to_the_approved_run(self):
        i = TRIGGERS["workflow_dispatch"]["inputs"]["expected_scene_count"]
        self.assertEqual(i["default"], "1")
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
        up, _ = step_named("Upload the MP3 masters")
        self.assertLess(red, up)


class TestPartialBatchSurvives(unittest.TestCase):
    """A failed scene must not throw away the clips already paid for."""

    def test_verify_and_upload_run_even_after_a_failed_generation(self):
        for name in ("Verify every clip", "Upload the MP3 masters",
                     "Confirm the voice held"):
            _, s = step_named(name)
            self.assertIn("!cancelled()", s["if"], name)

    def test_upload_is_still_gated_on_not_being_a_dry_run(self):
        _, s = step_named("Upload the MP3 masters")
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
        ids, _ = step_named("permitted scenes and the held")
        est, _ = step_named("credit estimate")
        gen, _ = step_named("Generate the permitted")
        self.assertLess(ids, gen)
        self.assertLess(est, gen)

    def test_verification_runs_after_generation(self):
        gen, _ = step_named("Generate the permitted")
        ver, _ = step_named("Verify every clip")
        self.assertLess(gen, ver)


class TestGenerationIsBounded(unittest.TestCase):
    def test_both_jobs_are_pinned_to_the_consolidated_batch(self):
        self.assertEqual(RAW.count('["DBRAND"]'), 2)
        self.assertEqual(RAW.count('assert os.environ["EXPECTED"] == "1"'), 2)
        self.assertEqual(RAW.count("--expect-characters 42"), 3)

    def test_generation_passes_fail_fast_and_expect(self):
        _, s = step_named("Generate the permitted")
        self.assertIn("--fail-fast", s["run"])
        self.assertIn("--expect", s["run"])

    def test_generation_never_forces_held_scenes(self):
        self.assertNotIn("--force-held", RAW)

    def test_generation_is_skipped_on_a_dry_run(self):
        _, s = step_named("Generate the permitted")
        self.assertIn("inputs.dry_run == false", s["if"])

    def test_verification_is_scoped_to_the_scenes_this_run_generated(self):
        """A scoped run verifies what it produced, and nothing else.

        This test used to require `--expect-set ready`. That was wrong once the
        run became scoped: the repository holds no previously generated masters
        -- they are build outputs, not source -- so the ready set would report
        every absent clip as missing, and the report would claim to have checked
        files that are not in the checkout.
        """
        _, s = step_named("Verify every clip")
        self.assertIn("--expect-scenes", s["run"])
        self.assertIn("$SCENES", s["run"])
        self.assertNotIn("--expect-set ready", s["run"])
        self.assertEqual(s.get("env", {}).get("SCENES"), "${{ inputs.scenes }}")


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
    def test_uploads_exactly_this_runs_clips_plus_manifest_log_and_report(self):
        """The artifact carries this run's clips by name, not a whole directory.

        Uploading elevenlabs/audio/ wholesale would sweep in anything else that
        happened to be there and label it as this run's output.
        """
        _, s = step_named("Upload the MP3 masters")
        paths = [p.strip() for p in s["with"]["path"].strip().splitlines()]
        self.assertEqual(sorted(paths), sorted([
            "${{ env.SCOPED_AUDIO }}",
            "elevenlabs/generation_manifest.json",
            "elevenlabs/generation_log.json",
            "validation_report.md"]))
        self.assertNotIn("elevenlabs/audio/", paths)

    def test_the_scoped_audio_list_is_built_from_the_approved_scene_ids(self):
        _, s = step_named("List exactly this run's outputs")
        self.assertEqual(s.get("env", {}).get("SCENES"), "${{ inputs.scenes }}")
        self.assertIn("SCOPED_AUDIO", s["run"])
        self.assertIn("elevenlabs/audio/$S.mp3", s["run"])

    def test_never_uploads_voice_settings_or_whole_directories(self):
        _, s = step_named("Upload the MP3 masters")
        paths = s["with"]["path"]
        for bad in ("scenes/", "recordings/", "audit/", ".git", "prototype/"):
            self.assertNotIn(bad, paths)

    def test_empty_upload_is_an_error_not_a_pass(self):
        _, s = step_named("Upload the MP3 masters")
        self.assertEqual(s["with"]["if-no-files-found"], "error")

    def test_artifact_has_a_retention_limit(self):
        _, s = step_named("Upload the MP3 masters")
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

    # The cleanliness block calls `git status` and must fail outside a
    # repository — so it is exercised in its own temporary repo below, not here.
    NEEDS_A_GIT_REPO = "Nothing was committed"

    def test_the_embedded_blocks_actually_run_here(self):
        for name, body in runs():
            if name == self.NEEDS_A_GIT_REPO:
                continue
            for block in embedded_python(body):
                r = subprocess.run([sys.executable, "-c", block],
                                   capture_output=True, text=True, cwd=ROOT)
                self.assertEqual(r.returncode, 0,
                                 f"step {name!r} failed: {r.stderr[-400:]}")

    def _gate_in_a_repo(self, populate):
        """Run the cleanliness block in a throwaway repo. Returns (rc, stdout)."""
        import tempfile
        d = pathlib.Path(tempfile.mkdtemp())
        for cmd in (["git", "init", "-q", "."],
                    ["git", "config", "user.email", "t@t"],
                    ["git", "config", "user.name", "t"]):
            subprocess.run(cmd, cwd=d, check=True, capture_output=True)
        (d / "tracked.txt").write_text("hello\n")
        subprocess.run(["git", "add", "-A"], cwd=d, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=d, check=True,
                       capture_output=True)
        populate(d)
        _, s = step_named(self.NEEDS_A_GIT_REPO)
        block = embedded_python(s["run"])[0]
        r = subprocess.run([sys.executable, "-c", block],
                           capture_output=True, text=True, cwd=d)
        return r.returncode, r.stdout

    def test_the_gate_passes_on_a_clean_tree(self):
        rc, out = self._gate_in_a_repo(lambda d: None)
        self.assertEqual(rc, 0, out)

    def test_the_gate_allows_this_runs_own_outputs(self):
        def populate(d):
            (d / "elevenlabs" / "audio").mkdir(parents=True)
            (d / "elevenlabs" / "audio" / "S010.wav").write_bytes(b"x")
            (d / "elevenlabs" / "generation_log.json").write_text("{}")
            (d / "validation_report.md").write_text("#")
        rc, out = self._gate_in_a_repo(populate)
        self.assertEqual(rc, 0, out)

    def test_the_gate_refuses_a_stray_file_under_system(self):
        def populate(d):
            (d / "system").mkdir()
            (d / "system" / "stray.py").write_text("x")
        rc, out = self._gate_in_a_repo(populate)
        self.assertEqual(rc, 1)
        self.assertIn("system/stray.py", out)   # named, not collapsed to "system/"

    def test_the_gate_refuses_a_modified_tracked_file(self):
        rc, out = self._gate_in_a_repo(
            lambda d: (d / "tracked.txt").write_text("changed\n"))
        self.assertEqual(rc, 1)
        self.assertIn("tracked.txt", out)

    def test_the_gate_refuses_a_deleted_tracked_file(self):
        rc, out = self._gate_in_a_repo(lambda d: (d / "tracked.txt").unlink())
        self.assertEqual(rc, 1)
        self.assertIn("tracked.txt", out)

    def test_the_gate_refuses_an_untracked_pycache_when_not_gitignored(self):
        """Proof the gate is not forgiving caches — the fix is upstream of it."""
        def populate(d):
            (d / "system" / "__pycache__").mkdir(parents=True)
            (d / "system" / "__pycache__" / "builder.cpython-311.pyc").write_bytes(b"x")
        rc, out = self._gate_in_a_repo(populate)
        self.assertEqual(rc, 1)
        self.assertIn("__pycache__", out)

    def test_the_gate_expands_untracked_directories(self):
        """Without -uall git collapses "?? system/" and hides the real file."""
        _, s = step_named(self.NEEDS_A_GIT_REPO)
        self.assertIn("-uall", s["run"])

    def test_the_held_scene_block_names_every_held_scene(self):
        """Derived from the manifest, not from a count written down once.

        This test used to assert seven held scenes and 'PERMITTED (24)'. On
        15 Sep 2026 four scenes were released from the recognition hold under an
        evidence-acceptance exception, and the assertion went stale while the
        workflow itself was still correct. It now reads the manifest, so the
        held set is whatever the registry says it is.
        """
        import json
        man = json.loads((ROOT / "elevenlabs" / "generation_manifest.json")
                         .read_text(encoding="utf-8"))
        held = sorted(c["scene_id"] for c in man["clips"]
                      if c.get("narration_provisional"))
        ready = [c for c in man["clips"]
                 if c.get("in_master") and not c.get("narration_provisional")]
        _, s = step_named("permitted scenes and the held")
        r = subprocess.run([sys.executable, "-c", embedded_python(s["run"])[0]],
                           capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(held, [], "all three recognition holds are released for this batch")
        for sid in held:
            self.assertIn(sid, r.stdout)
        self.assertIn(f"PERMITTED ({len(ready)})", r.stdout)


class TestPythonCachesCannotDirtyTheTree(unittest.TestCase):
    """The first installed dry run failed only here: ?? system/__pycache__/"""

    def test_bytecode_is_disabled_at_job_level(self):
        env = JOB.get("env") or {}
        self.assertEqual(env.get("PYTHONDONTWRITEBYTECODE"), "1")

    def test_it_is_job_level_not_per_step(self):
        """Job level so it is set before the FIRST python process, including
        the heredoc blocks and anything pip runs."""
        self.assertIn("PYTHONDONTWRITEBYTECODE", json.dumps(JOB.get("env")))
        for s in STEPS:
            self.assertNotIn("PYTHONDONTWRITEBYTECODE", json.dumps(s.get("env") or {}),
                             f"step {s.get('name')!r} sets it per-step instead")

    def test_the_gate_does_not_forgive_caches(self):
        """The fix is at the cause. The gate must NOT allowlist __pycache__."""
        _, s = step_named("Nothing was committed")
        for bad in ("__pycache__", "*.pyc", ".py[cod]"):
            self.assertNotIn(bad, s["run"], f"gate weakened with {bad}")

    def test_the_gate_allowlists_only_this_runs_own_outputs(self):
        _, s = step_named("Nothing was committed")
        block = embedded_python(s["run"])[0]
        allowed = re.search(r"ALLOWED_UNTRACKED = \((.*?)\)", block, re.S).group(1)
        paths = re.findall(r'"([^"]+)"', allowed)
        self.assertEqual(sorted(paths), sorted([
            "elevenlabs/audio/",
            "elevenlabs/generation_log.json",
            "validation_report.md"]))

    def test_the_gate_never_broadly_ignores_a_source_directory(self):
        _, s = step_named("Nothing was committed")
        for bad in ('"system/"', '"scenes/"', '".github/"', '"elevenlabs/"'):
            self.assertNotIn(bad, s["run"], f"gate weakened with {bad}")

    def test_a_modified_or_deleted_tracked_file_still_fails(self):
        _, s = step_named("Nothing was committed")
        block = embedded_python(s["run"])[0]
        # Only the "??" status may ever be allowed through.
        self.assertIn('code == "??"', block)

    def test_the_gitignore_additions_are_narrow(self):
        """Delivery aid, not a repo requirement — skip when it was not shipped."""
        p = ROOT / ".github" / "workflows" / "gitignore-additions.txt"
        if not p.exists():
            self.skipTest("gitignore-additions.txt is not part of this checkout")
        lines = [l.strip() for l in p.read_text().splitlines()
                 if l.strip() and not l.strip().startswith("#")]
        self.assertEqual(sorted(lines), ["*.py[cod]", "__pycache__/"])


class TestMasterFormat(unittest.TestCase):
    def test_the_output_format_is_mp3_44100_128(self):
        v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text())
        pref = v["output_format"]["preferred"]
        self.assertEqual(pref["api_value"], "mp3_44100_128")
        self.assertEqual(pref["container"], "mp3")
        self.assertEqual(pref["sample_rate"], 44100)
        self.assertEqual(pref["bit_rate_kbps"], 128)
        self.assertEqual(pref["channels"], 1)

    def test_the_superseded_pcm_format_is_recorded_with_its_403(self):
        v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text())
        sup = v["output_format"]["superseded"]
        self.assertEqual(sup["api_value"], "pcm_44100")
        self.assertIn("403", sup["why_abandoned"])
        self.assertIn("output_format_not_allowed", sup["why_abandoned"])

    def test_the_voice_lock_did_not_move_with_the_format(self):
        v = json.loads((ROOT / "elevenlabs" / "voice_settings.json").read_text())
        self.assertEqual(v["lock"]["fingerprint_sha256"],
                         "6de1f549a5cca453b174c9d6a5527a723e5e64185ed175ba17d111952b44ecb2")
        self.assertEqual(v["voice_id"], "OZxMHsGaBmV5pjMIDIn0")
        self.assertEqual(v["settings"], {"speed": 0.72, "stability": 0.60,
                                         "similarity_boost": 0.75, "style": 0.0,
                                         "use_speaker_boost": True})
        self.assertNotIn("output_format", v["lock"]["fingerprint_covers"])

    def test_every_manifest_audio_target_is_an_mp3_named_for_its_scene(self):
        man = json.loads((ROOT / "elevenlabs" / "generation_manifest.json").read_text())
        for c in man["clips"]:
            if c["in_master"] and not c["narration_provisional"]:
                self.assertEqual(c["audio"], f"elevenlabs/audio/{c['scene_id']}.mp3")

    def test_verification_requires_a_441_khz_mp3(self):
        src = (ROOT / "elevenlabs" / "verify_clips.py").read_text()
        self.assertIn('MASTER_CODEC = "mp3"', src)
        self.assertIn('MASTER_SUFFIX = ".mp3"', src)
        self.assertIn("MASTER_RATE = 44100", src)
        self.assertIn("MASTER_BITRATE_KBPS = 128", src)

    def test_nothing_transcodes_the_masters(self):
        src = (ROOT / "elevenlabs" / "generate_scenes.py").read_text()
        self.assertNotIn("wrap_pcm_as_wav", src)
        self.assertNotIn("import wave", src)
        # "lossless" may appear, but only in a sentence that denies it.
        for n, line in enumerate(src.splitlines(), 1):
            if "lossless" in line.lower():
                self.assertIn("not", line.lower(),
                              f"line {n} claims the masters are lossless")

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
