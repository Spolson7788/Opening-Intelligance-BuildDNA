#!/usr/bin/env python3
"""
stability_rules.py — PC-7 stability and semantic rules, revision 2 (prospective).

PROPOSED. Not applied to production. It replaces `compare()` in
system/test_photographs.py and adds two things that did not exist: a semantic
check, and per-component verdicts.

What changed, and why
---------------------
Rule 7 — the old gate failed a run on a 4-point move in a self-reported
confidence percentage while every categorical field was identical. A language
model's confidence output varies between identical calls; gating it at 2 points
gated noise. The tolerance is now 5 points, and it applies ONLY when the
substantive fields are unchanged.

    THIS APPLIES PROSPECTIVELY. The 15 September 2026 run remains a FAILURE
    under the +/-2-point rule that was in force. It is not re-scored.

Rule 6 — categorical values, defensible level and review state must be
identical. Those are what narration rests on. Zero tolerance, unchanged.

Rule 8 — two changes. A semantic contradiction stops immediately, ahead of any
stability question. And a failure is scoped to its component: an incoherent
closer no longer invalidates a stable exit device and a stable hinge, which is
what cost this run two usable results.
"""

CONFIDENCE_TOLERANCE_POINTS = 5          # rule 7, prospective
LEVELS = ("manufacturer", "family", "model")
ORDER = {"component": 0, "manufacturer": 1, "family": 2, "model": 3}


def _lv(x):
    return (x["value"], x["confidence"]) if x else None


def fingerprint(r):
    """The fields a narration branch may rest on."""
    if not r:
        return None
    return {
        "hdl": r.get("highest_defensible_level"),
        "mfr": _lv(r.get("manufacturer")),
        "fam": _lv(r.get("family")),
        "mod": _lv(r.get("model")),
        "review": r.get("needs_review"),
        "top": (r.get("candidates") or [None])[0],
        "evidence": r.get("evidence_requests"),
        "xref": r.get("cross_reference"),
    }


def semantic_check(r):
    """Rules 1-5 and 8, applied to a single result. Returns a list of violations.

    This mirrors app/level_coherence.js. The app should not emit a result that
    fails these; the harness checks anyway, because a demonstration must never
    be built on a card the harness merely assumed was coherent.
    """
    if not r:
        return ["no result produced"]

    out = []
    est = lambda k: bool(r.get(k)) and r[k].get("value") not in (None, "", "Not established")
    mfr, fam, mod = est("manufacturer"), est("family"), est("model")
    hdl = r.get("highest_defensible_level")

    # R1
    if mod and not mfr:
        out.append("R1: model established while manufacturer is not")
    # R2
    if fam and not mfr:
        out.append("R2: family established while manufacturer is not")
    if mod and not fam:
        out.append("R2: model established while family is not")
    if hdl and hdl in ORDER:
        for lv in LEVELS:
            if ORDER[hdl] >= ORDER[lv] and not est(lv):
                out.append(f"R2: highest_defensible_level is '{hdl}' but {lv} is not established")
    # R3
    value = (r.get("model") or {}).get("value") or ""
    if mod and ("·" in value or " / " in value or "," in value):
        out.append(f"R3: the model row holds several values ({value!r}) — that is a "
                   f"candidate group, not an identification")
    if mod and r.get("cross_reference"):
        out.append(f"R3: model claimed while in cross-reference group "
                   f"{r['cross_reference']} — a cross-reference is not an identification")
    # R4
    cands = r.get("candidates") or []
    brands = {str(c).split()[0] for c in cands if c}
    if len(brands) > 1 and not r.get("needs_review"):
        out.append(f"R4: candidates span {len(brands)} manufacturers but needs_review is false")
    # R5
    for e in (r.get("evidence_requests") or []):
        if mod and ("separate brands" in str(e).lower() or "stamp" in str(e).lower()):
            out.append("R5: a model is claimed while an unresolved evidence request could "
                       "still change the brand or model")
            break
    return out


def compare(a, b):
    """Material differences between two fingerprints. Rules 6 and 7."""
    if a is None or b is None:
        return ["one repetition produced no result"]

    out = []
    # Rule 6 — exact match required.
    for k, label in (("hdl", "highest defensible level"), ("review", "review state"),
                     ("top", "top candidate"), ("evidence", "evidence requests"),
                     ("xref", "cross-reference group")):
        if a[k] != b[k]:
            out.append(f"{label}: {a[k]!r} vs {b[k]!r}")

    for k in ("mfr", "fam", "mod"):
        x, y = a[k], b[k]
        if (x is None) != (y is None):
            out.append(f"{k}: {x!r} vs {y!r}")
        elif x and y:
            if x[0] != y[0]:
                out.append(f"{k} value: {x[0]!r} vs {y[0]!r}")      # rule 6
            elif abs(x[1] - y[1]) > CONFIDENCE_TOLERANCE_POINTS:    # rule 7
                out.append(f"{k} confidence drift: {x[1]}% vs {y[1]}% "
                           f"(> {CONFIDENCE_TOLERANCE_POINTS} points)")
    return out


def confidence_drift(a, b):
    """Recorded for the evidence pack, never narrated. Rule 7."""
    if not a or not b:
        return {}
    return {k: abs(a[k][1] - b[k][1]) for k in ("mfr", "fam", "mod")
            if a.get(k) and b.get(k)}


def assess(passes, parts):
    """Rule 8 — one verdict PER COMPONENT, so one bad part cannot sink the others.

    passes: [{"repetition": n, "results": {slot: {"photo_pass": {...}}}}, ...]
    parts:  iterable of slot names
    """
    report = {"components": {}, "stop": False, "stop_reason": None}

    for slot in parts:
        results = [p["results"].get(slot, {}).get("photo_pass") for p in passes]
        entry = {"repetitions": len(results), "semantic_violations": [],
                 "stability": [], "confidence_drift": {}, "verdict": None}

        # Semantic contradictions are checked first and stop immediately.
        for i, r in enumerate(results, 1):
            for v in semantic_check(r):
                entry["semantic_violations"].append(f"rep {i}: {v}")

        fps = [fingerprint(r) for r in results]
        if len(fps) > 1:
            entry["stability"] = compare(fps[0], fps[-1])
            entry["confidence_drift"] = confidence_drift(fps[0], fps[-1])

        if entry["semantic_violations"]:
            entry["verdict"] = "SEMANTIC CONTRADICTION — not narratable"
            report["stop"] = True
            report["stop_reason"] = report["stop_reason"] or (
                f"semantic contradiction in {slot}: {entry['semantic_violations'][0]}")
        elif entry["stability"]:
            entry["verdict"] = "UNSTABLE — not narratable"
            report["stop"] = True
            report["stop_reason"] = report["stop_reason"] or (
                f"{slot} varied materially between repetitions")
        elif len(results) < 2:
            entry["verdict"] = "INCONCLUSIVE — fewer than 2 repetitions"
        else:
            entry["verdict"] = f"STABLE across {len(results)} repetitions"

        report["components"][slot] = entry

    report["narratable"] = sorted(s for s, e in report["components"].items()
                                  if e["verdict"].startswith("STABLE"))
    report["blocked"] = sorted(s for s, e in report["components"].items()
                               if not e["verdict"].startswith("STABLE"))
    report["note"] = ("A component-specific failure does not invalidate stable unrelated "
                      "components. Confidence percentages are recorded and never narrated.")
    return report
