# Narration workflow — GitHub deployment

**Nothing here is installed, committed, or dispatchable.** There is no git
repository in the video system — `git rev-parse` returns *fatal: not a git
repository* — so GitHub has never seen any of this. The `elevenlabs-narration`
environment does not exist and no secret has been added to it. Everything below
is what *you* would do to change that.

Approved narration-master format: **`pcm_44100`, WAV container, 44.1 kHz,
mono**, one file per scene.

---

## 1. Files to add to the repository, and where

Every path is repository-relative and must land exactly there — the workflow,
the preflight check and the manifest all address files by these paths.

| Repository path | What it is | Bytes |
|---|---|---|
| `.github/workflows/generate-narration.yml` | the workflow | 11.7 K |
| `.github/workflows/preflight.py` | fails the run if any required file is absent | 6.5 K |
| `.github/workflows/requirements.txt` | pinned dependencies | 0.7 K |
| `.github/workflows/test_generate_narration_workflow.py` | 47 tests over the workflow | 13 K |
| `system/oi_video.py` | `voicecheck`, `inventory`, `scripts` | 24 K |
| `system/builder.py` | imported by `oi_video.py` at start-up | 7.8 K |
| `elevenlabs/generate_scenes.py` | makes the clips | 14 K |
| `elevenlabs/verify_clips.py` | verifies them | 9.2 K |
| `elevenlabs/voice_settings.json` | the locked voice + lock fingerprint | 6.8 K |
| `elevenlabs/generation_manifest.json` | what to generate | 67 K |
| `elevenlabs/scenes/S###.txt` × 24 | the narration sent to the synthesiser | 5.3 K total |
| `elevenlabs/reference/VOICE_REFERENCE.mp3` | approved voice reference; read by the speaker-boost provenance step | 1.65 M |
| `scenes/scenes.json` | the scene registry `oi_video.py` reads | 131 K |
| `elevenlabs/audio/.gitkeep` | so the masters have a home | 0 |
| `elevenlabs/WORKFLOW_REVIEW.md` | how each requirement is met | 7 K |
| `elevenlabs/WORKFLOW_DEPLOYMENT.md` | this file | — |
| `elevenlabs/pronunciation_guide.md` | reference, not executed | 8 K |

**Only the 24 permitted scene scripts are included.** The seven held scenes have
no `.txt` in this package. Their narration still travels inside
`scenes.json`, which is the registry — but nothing in the run reads a held
script, and `--force-held` is not in the workflow at all.

`elevenlabs/reference/VOICE_REFERENCE.mp3` stays MP3. It is the approved voice
*reference*, not a master, and it is never cut into the video.

## 2. Install

```bash
# from the repository root
unzip OI_Narration_GitHub_Deployment.zip
rsync -a OI_Narration_Deployment/ .        # preserves the paths above

python .github/workflows/preflight.py                        # expect: exit 0
python .github/workflows/test_generate_narration_workflow.py # expect: 47 OK

git add .github elevenlabs system scenes
git commit -m "Narration generation workflow, prepared for manual dispatch"
git push
```

The workflow becomes dispatchable only once it is on the **default branch**.
Installing it costs nothing: no schedule, no push trigger, and `dry_run`
defaults to true.

**Recommended `.gitignore`** — so a master can never be committed by accident:

```gitignore
elevenlabs/audio/*.wav
elevenlabs/generation_log.json
validation_report.md
```

## 3. Create the protected environment

Settings → Environments → **New environment** → name it exactly
**`elevenlabs-narration`**.

1. **Required reviewers** — you or Stephan. Nothing spends until a person
   approves the deployment.
2. **Deployment branches** — default branch only.
3. **Environment secrets** → **New secret** → name **`ELEVENLABS_API_KEY`**,
   value your key.

It must be an **environment** secret, not a repository secret. A repository
secret has no reviewer gate and no branch restriction, which is the whole point
of using an environment. `ELEVENLABS_API_KEY` is the only secret the workflow
references anywhere — a test asserts that.

## 4. Dispatch

Actions → **Generate Trial 1 narration (manual)** → Run workflow.

**First: dry run.** Leave `dry_run` checked (it is the default). Calls nothing,
spends nothing, and exercises every gate — preflight, the voice lock, the
speaker-boost provenance, the permitted/held lists, the character estimate, and
whether the secret is present. Expect:

```
PERMITTED (24): S010 S020 … S275
HELD — will NOT be generated (7): S130 S130A S140 S180 S190A S210 S220
CREDIT ESTIMATE  5,310 characters across 24 request(s)
```

**Then: the paid run.** Uncheck `dry_run`, leave `expected_scene_count` at
`24`, and type the confirmation exactly:

```
GENERATE 24 CLIPS
```

Anything else stops the run before a single request.

## 5. What comes back

The run uploads a **private workflow artifact** named
`trial1-narration-<run_id>`, retained **14 days**, downloadable from the run's
summary page. Artifacts follow repository visibility — for a private repo they
are private, and the workflow never makes them public and never commits
anything (`permissions: contents: read`).

It contains:

```
elevenlabs/audio/S010.wav … S275.wav      the 24 masters
elevenlabs/generation_manifest.json       what was asked for
elevenlabs/generation_log.json            settings, lock, per-clip duration + sha256
validation_report.md                      the verification result
```

**A partial batch is still uploaded.** The generation step stops at the first
failure, but verification and upload run under `!cancelled()`, so the clips that
did land are verified and downloadable. The job still fails, and the report
names what is missing — nothing already paid for is thrown away.

**Re-dispatching after a partial run is cheap.** `--regenerate` is never passed,
so a clip already on disk is skipped. Only the missing scenes are charged.

## 6. Putting the verified WAV masters back

```bash
# from the repository root, after downloading and unzipping the artifact
unzip ~/Downloads/trial1-narration-<run_id>.zip -d /tmp/narration

cp /tmp/narration/elevenlabs/audio/*.wav elevenlabs/audio/
cp /tmp/narration/elevenlabs/generation_log.json elevenlabs/

python elevenlabs/verify_clips.py --expect-set ready   # expect: all checks passed
python system/oi_video.py voicecheck
```

Keep the filenames exactly as they arrive — `elevenlabs/audio/<SCENE_ID>.wav`.
The build looks clips up by that name; a renamed file is a missing clip.

`voicecheck` then measures each clip against the picture that exists and names
any scene whose **speech is longer than its picture**. Those need their picture
re-cut: the build fits picture to speech, and the voice is never sped up.

**Do not commit the masters** unless you have decided to — they are large, they
are reproducible, and the `.gitignore` above assumes you would rather keep them
out. The artifact is the delivery.

## 7. The voice configuration, settled

| | |
|---|---|
| Voice ID | `OZxMHsGaBmV5pjMIDIn0` |
| Model | `eleven_multilingual_v2` |
| Speed · Stability · Similarity · Style | 0.72 · 0.60 · 0.75 · 0.0 |
| Speaker boost | **on — user-approved production setting**, 2026-09-14 |
| Lock fingerprint | `6de1f549a5cca453b174c9d6a5527a723e5e64185ed175ba17d111952b44ecb2` |

Speaker boost was the last value carried on inference. It is now approved for
all Trial 1 narration, and its provenance says so. The value did not change, so
**the lock fingerprint did not change** — the provenance step still runs and
still fails if the reference sample's own metadata ever contradicts it.

Nothing about the voice is outstanding.
