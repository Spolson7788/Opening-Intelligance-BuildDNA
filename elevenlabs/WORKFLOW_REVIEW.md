# Narration generation workflow — for review

`.github/workflows/generate-narration.yml`

**Prepared, tested, not installed. No secret was added. The workflow has never
been dispatched.** 64 tests pass against it (`python
.github/workflows/test_generate_narration_workflow.py`).

---

## What it does

One manual dispatch generates the 24 approved Trial 1 narration clips at the
locked voice, verifies every file, and uploads them as a private artifact.
Nothing is committed.

## How each requirement is met

| Requirement | How |
|---|---|
| `workflow_dispatch` only | `on:` has exactly one key. A test asserts `schedule`, `push`, `pull_request`, `pull_request_target`, `workflow_call`, `repository_dispatch` and `issue_comment` are all absent |
| Explicit confirmation before spending | `confirm` input, required, empty default, must equal **`GENERATE 24 CLIPS`** exactly. Plus `dry_run`, which **defaults to true** — so a dispatcher who just clicks through spends nothing |
| Key from a protected environment secret | `environment: elevenlabs-narration`; `secrets.ELEVENLABS_API_KEY` is the only secret referenced anywhere |
| Never print, serialize, upload or expose the key | Reached only through `env:`, never interpolated into a shell body. A dedicated step scans every file about to be uploaded for the key value and for `xi-api-key` / `Authorization:` and fails if found. Presence is checked without reporting even its length |
| Lock voice ID, model, and the four settings | `voicecheck` recomputes the SHA-256 over voice ID + model + settings and fails on drift; `generate_scenes.py` recomputes it again before the first request |
| Speaker boost on | **User-approved production setting**, approved 2026-09-14 for all Trial 1 narration — not an inference from the reference filename. Its provenance step still runs and still fails if the sample's own metadata ever contradicts it |
| Run `voicecheck` before any request | Step 7 of 18, before the secret is even read. Run again after generation |
| Print the 24 permitted and 7 held IDs before generating | Its own step, with the held reason printed per scene |
| Refuse all held scenes | `generate_scenes.py` skips `narration_provisional` scenes; asking for one by id does not override. `--force-held` is never passed, and a test asserts the string does not appear in the workflow |
| Report estimated credit use before generating | The dry-run step prints the **character count** — what ElevenLabs actually bills — currently **5,310 characters across 24 requests** |
| Stop on mismatch, API error, incomplete file, unexpected scene | `--expect` stops the run if the plan is not exactly the approved count; `--fail-fast` stops at the first failure; a clip under 0.5 s or 4 KB is deleted and treated as a failure, not a success |
| One audio file per permanent scene ID | One request per scene, named `audio/<SCENE_ID>.mp3`. Never one long read sliced |
| Verify duration, format, size, hash | `verify_clips.py` — its own step, so "the API returned 200" and "we have 24 usable clips" are two separate claims. Also fails if a held scene has audio, or an unexpected file is present |
| Approved master format | **`mp3_44100_128`** — a valid 44.1 kHz mono MP3 at about 128 kbps, **lossy, never transcoded to WAV**. `verify_clips.py` fails a wrong container, codec, sample rate, channel count or bit rate, a zero-byte or unreadable file, and a clip that is readable and valid but decodes to continuous silence. `pcm_44100` was abandoned after HTTP 403 `output_format_not_allowed` (Pro tier only) on the first paid run |
| Partial batch survives a failure | Verification and upload run under `!cancelled()`, so clips that landed before a failure are still verified and still downloadable. The job still fails |
| Never re-spend on a good clip | `--regenerate` is never passed, so an existing clip is skipped. Re-dispatching after a partial run charges only the missing scenes |
| Preflight | `.github/workflows/preflight.py` runs before any gate that can spend, and fails if any required file is absent, empty, or incoherent with the lock |
| Pinned dependencies | `.github/workflows/requirements.txt`; a test asserts every line carries `==` |
| Upload only audio, manifest, and non-sensitive report | Four paths, asserted exactly by a test. `if-no-files-found: error`, 14-day retention. Artifacts follow repository visibility — private for a private repo |
| Do not commit generated audio | `permissions: contents: read`, so a commit cannot succeed. A step asserts the working tree carries only untracked generated output, and a test asserts no `git commit`, `git push`, `git add`, `git tag`, and no committing action |

## What you have to do before it can run

Two things, neither of which I have done or can do:

1. **Put the file on the default branch.** Until then GitHub does not offer it
   in the Actions tab. Installing it is safe on its own: no schedule, no push
   trigger, and `dry_run` defaults to true.
2. **Create the `elevenlabs-narration` environment** (Settings → Environments)
   and add **`ELEVENLABS_API_KEY`** as a secret *in that environment*, not as a
   repository secret. Environment secrets are what let you add required
   reviewers and a branch restriction; a repository secret has neither.
   Recommended: required reviewer = you or Stephan; deployment branch = default
   branch only.
3. Nothing else. Speaker boost — previously the one inferred value — is now a
   user-approved production setting and needs no further confirmation.

Recommended but not required: add `elevenlabs/audio/*.mp3`,
`elevenlabs/generation_log.json` and `validation_report.md` to `.gitignore`, so
a master cannot be committed by hand either. I have not changed `.gitignore`.

**`elevenlabs/WORKFLOW_DEPLOYMENT.md` has the file-by-file install, the exact
repository paths, the dispatch steps, and how to put verified MP3 masters back
into `elevenlabs/audio/`.**

## First run

Dispatch with **dry_run checked** (the default). It calls nothing and spends
nothing, and it exercises every gate: the lock, the speaker-boost provenance,
the permitted/held lists, the character estimate, and whether the secret is
present. Read the output.

Then dispatch again with **dry_run unchecked** and the confirmation typed.

## One thing worth keeping in view

**The runner here is the same script as the local route.** The workflow is a
wrapper around `generate_scenes.py` and `verify_clips.py`, so a clip generated
in CI and a clip generated on your machine are byte-for-byte the same request.
Whichever route you use, do not use both — two runs mean two charges and two
sets of files.
