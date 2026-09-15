# Trial 1 — pronunciation and generation notes

**Not spoken.** These notes are for whoever generates the narration. The
narration master and the per-scene clips contain spoken text only — no scene
headings, no stage directions, no filenames.

---

## The rule behind all of it

**The script is spelled for the ear. The screen keeps the real spelling.**

The synthesiser reads `CR441` as something between "crrr-four-forty-one" and
"see-arr-four-four-one", and it is not consistent between runs. So the narration
files spell these terms out phonetically and the application is never changed to
match. A viewer sees `CR441` on screen and hears "see arr four forty-one" — which
is what a person standing at the door would say.

---

## Model numbers and abbreviations — recommended reading

| Written in the script | On screen | Spoken as | Why |
|---|---|---|---|
| `OI` | OI | "oh eye" | Two letters. Never "oy" — it is an initialism, not a word |
| `C R four forty-one` | CR441 | "see arr four forty-one" | Letters separately, then the number as a person says it. Not "four four one" |
| `A F seventy-seven hundred` | AF7700 | "ay eff seventy-seven hundred" | The trade says "seventy-seven hundred", never "seven thousand seven hundred" |
| `A seventy-seven hundred` | A7700 | "ay seventy-seven hundred" | Same family, non-fire-rated variant |
| `E S C rigid lever escutcheon` | ESC | "ee ess see rigid lever ess-KUTCH-un" | Three letters. **Escutcheon** is the word to test — the common failure is "es-COO-shun" |
| `five bee bee one` | 5BB1 | "five bee bee one" | Digit, two letters, digit. Never "five bee-bee one" run together |
| `N D eighty` | ND80 | "en dee eighty" | Letters, then "eighty". Not "en dee eight zero" |
| `two zero five A` | 205A | "two zero five ay" | **Never "two-oh-five"** — an opening number is read digit by digit in the field, and "oh" would be heard as a letter |
| `three ten B` | 310B | "three ten bee" | Opening 2. Read as spoken in the field, not "three one zero" |
| `E D one three two eight two` | ED-13282 | letters, then digits one at a time | A SKU is dictated, never read as a quantity |
| `S W F D one zero one eight three` | SWFD-10183 | letters, then digits one at a time | Same. "one zero one eight three", never "ten thousand…" |

### Manufacturer and product names

| Term | Spoken as | Note |
|---|---|---|
| **Cal-Royal** | "cal ROY-al" | Two words, light hyphen. Not "cal-roy-AL" |
| **Ives** | "eyes" | **One syllable.** The common error is "EYE-vess". **In S220 the script is spelled `eyes five bee bee one`** — the screen and the caption keep `Ives 5BB1` |
| **Schlage** | "SHLAY-ghee" | Two syllables. Not "shlayg" and not "SHLAH-guh" — this one is worth listening for specifically |
| **Vortex** | as normal | |
| **Valley Medical Center** | as normal | |
| **Opening Intelligence** | as normal, with a beat after it in the tagline | See *Deliberate pauses* below |

### The general rules, if a new term appears

1. **Letters that prefix a number are spelled out**, spaced: `A F`, `C R`, `N D`,
   `E S C`, `S W F D`.
2. **A model number is spoken the way the trade says it** — "seventy-seven
   hundred", "four forty-one", "eighty".
3. **A SKU is dictated digit by digit.** It is a reference, not a quantity, and a
   listener writing it down needs the digits.
4. **An opening number is read digit by digit**, keeping the letter: "two zero
   five A".
5. When in doubt, say it aloud as if reading it to a colleague across a van.

---

## The validation sample — approved, and now the reference

`reference/VOICE_REFERENCE.mp3` · **Amy – Natural and Sweet**
(`OZxMHsGaBmV5pjMIDIn0`) · `eleven_multilingual_v2` · speed **0.72**, stability
**0.60**, similarity **0.75**, style **0.0**, speaker boost **on** · 69.8 s, mono,
44.1 kHz, ~194 kbps (probed, not taken on trust).

**Approved 14 September 2026, and the voice is now locked for the whole OI
Modular Video Production System** — not for Trial 1 alone. Any question about
whether a clip matches the approved voice is answered against this file. It is
never cut into the video.

**It reset the timing for the whole video.** 159 words in 69.8 s is
**2.278 words per second** — the previous 2.4 was a guess and ran 5.1% fast. Every
scene estimate is now derived from the measurement, and Trial 1's estimate moved
with it. Re-measure if the voice, model or speed ever changes; speed 0.72 is well
below the 1.0 default and is much of the reason.

## What the sample established

`VALIDATION_SCRIPT.txt` — **69.8 seconds as actually read**, containing every term above:
Opening Intelligence, Cal-Royal, CR441, AF7700, the ESC rigid lever escutcheon,
Ives 5BB1, Schlage ND80, opening 205A, and both Vortex SKUs.

It was generated and approved first, before anything else, and it is what the
terminology below was checked against:

- **escutcheon** — the single most likely mispronunciation;
- **Ives** — one syllable, not two;
- **Schlage** — two syllables;
- **"two zero five A"** — that it does not come out as "two hundred five";
- both **SKUs** — that the digits stay separate and are not grouped;
- **"seventy-seven hundred"** — that it is not re-read as "seven thousand seven
  hundred";
- overall pace — unhurried, one person to one person, real pauses at the em
  dashes.

If a term still comes out wrong in a scene clip, fix it in the phonetic spelling
here and in that scene's `narration`, then regenerate **that one clip**. Never by
changing the voice settings, and never by changing the application.

---

## Voice

- **Voice: Amy – Natural and Sweet** — `OZxMHsGaBmV5pjMIDIn0`,
  `eleven_multilingual_v2`, speed 0.72, stability 0.60, similarity 0.75,
  style 0.0, speaker boost on. Recorded in `voice_settings.json`.
- **Speaker boost is on — a user-approved production setting** (2026-09-14),
  not an inference from the reference filename.
- **These values are LOCKED** for the whole video system. `voice_settings.json`
  carries a fingerprint over the voice ID, model and the five settings;
  `python system/oi_video.py voicecheck` recomputes it, and
  `generate_scenes.py` refuses to make a single clip if it does not match.
  Changing any one of them invalidates every clip already made.
- **Never change these settings for a single clip**, and never to make something
  louder — normalise at final assembly instead.
- Generate every clip in one session with identical settings, so the cut does not
  drift in tone between scenes.
- Style: one person explaining a task to one other person at a workbench.
  Unhurried, with real pauses at the em dashes. Not an announcer.

## Clip naming

One file per scene, named for its scene id — `audio/S010.wav` … `audio/S275.wav`.
The build looks clips up by that exact name and fits each scene's picture to the
clip's real length. A corrected line means regenerating one clip and rebuilding
one scene; nothing else moves.

## Two deliberate pauses

- **S030 (tagline)** — a beat after "Opening Intelligence" before "commercial
  door hardware identified right at the opening."
- **S070** — a beat after "two zero five A." before the illustrative-values
  sentence, so the typed fields have time to land.

---

## Seven scenes that must NOT be generated yet

`S130` `S130A` `S140` `S180` `S190A` `S210` `S220`

Six depend on a recognition result the controlled test has not produced.
**`S220`'s wording is now approved**, but it is held until its measured clip is
fitted to the extended 41.5 s picture.

`generate_scenes.py` skips all seven by name and prints the reason for each. It
will not generate one even if it is asked for by id. The generation manifest flags each one, and
`scripts` lists them under **HELD**. See `OI_Trial1_Narration_Review.md` for the
reason on each.

---

## What was removed from the earlier draft, and why

- "the Vortex S K U **you provided**" → the viewer did not provide anything. Now
  spoken as the mapping Elite Sales maintains. The provenance stays in production
  notes, not in the narration.
- Any line reading out the on-screen confidence percentage.
- Any line saying a model was "recognised from your photos" where the technician
  entered the attribute that produced it — corrected in S110, S130 and S180 to
  "the photographs **together with** the visible attributes I entered".
- Any "SKU not mapped" line. The purchasing chapter states both confirmed
  mappings and says plainly what ED-13282 covers.
- Blanket claims about time saved, accuracy, compliance, order-readiness or
  facility-system integration. None are demonstrated by the screens in this trial.
