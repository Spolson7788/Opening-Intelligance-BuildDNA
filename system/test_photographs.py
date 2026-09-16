#!/usr/bin/env python3
"""
Exact-photograph test — controlled deployment run.

Puts each registered photograph through the real OI image-recognition function
on a controlled deploy preview or demonstration deployment, repeats it enough to
judge stability, and records everything the photograph registry asks for.

    python system/test_photographs.py --app "https://<deploy-preview>/index.html" --reps 3
    python system/test_photographs.py --app "<url>" --reps 3 --write

Safety, enforced not assumed:
  * refuses to run against a signed-in session, so nothing can reach live
    customer records (override only with --allow-signed-in, which still never
    saves);
  * never clicks Save this part, Send to purchasing, Send full log or
    Save & next opening;
  * fresh browser context per repetition, storage cleared, nothing persisted.

Stops early and says why if: the recognition function errors, returns 402 / 403
/ 429 (cost or rate limit), or results vary materially between repetitions.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import app_selectors as S
import stability_rules as SR          # ruleset v2, adopted 15 Sep 2026
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "demo_dataset.json"
PHOTOS = ROOT / "assets" / "photos"
VISION = "/.netlify/functions/vision"

PARTS = {
    "closer": {"part_type": "DOOR CLOSER",
               "photos": ["OP1_closer_whole.jpg", "OP1_closer_stamp.jpg"],
               "attrs": {"#a_closer_type": "surface", "#a_mounting": "parallel_arm",
                         "#a_arm_type": "hold_open", "#a_cover_type": "plastic"},
               "mfr": "Cal-Royal"},
    "exit_device": {"part_type": "EXIT DEVICE",
                    "photos": ["OP1_exit_full.jpg", "OP1_exit_stamp.jpg", "OP1_exit_trim.jpg"],
                    "attrs": {"#a_device_type": "rim", "#a_chassis_style": "touchpad",
                              "#a_mount": "surface", "#a_outside_trim": "lever"},
                    "mfr": "Cal-Royal"},
    "hinges": {"part_type": "HINGE BUTT",
               "photos": ["OP1_hinge_full.jpg", "OP1_hinge_knuckle.jpg", "OP1_hinge_stamp.jpg"],
               "attrs": {}, "mfr": "Ives"},
}

READ_RESULT = r"""() => {
  const el = document.getElementById('result');
  if (!el || el.style.display === 'none') return null;
  const t = el.innerText || '';
  const level = (name) => {
    const m = t.match(new RegExp(name + "\\s*\\n([^\\n]*)\\n\\s*(\\d+)%"));
    return m ? {value: m[1].trim(), confidence: parseInt(m[2], 10)} : null;
  };
  const evid = [];
  const ev = t.split('To confirm, capture:')[1];
  if (ev) ev.split('\n').slice(1, 8).forEach(l => { l = l.trim(); if (l.startsWith('•')) evid.push(l.slice(1).trim()); });
  const L = window._lastMatch || {};
  return {
    headline_confidence: parseInt((t.match(/(\d+)%\s*\n?\s*confidence/) || [])[1] || '-1', 10),
    best_matches: parseInt((t.match(/confidence · (\d+) best-match/) || [])[1] || '-1', 10),
    manufacturer: level('Manufacturer'),
    family: level('Family'),
    model: level('Model'),
    highest_defensible_level: (t.match(/Highest defensible level:\s*(\w+)/) || [])[1] || null,
    needs_review: /Needs review/i.test(t),
    cross_reference: (t.match(/Cross-reference group ([A-Z0-9-]+)/) || [])[1] || null,
    evidence_requests: evid,
    candidates: (L.list || []).slice(0, 5).map(x => (x.c ? (x.c.manufacturer + ' ' + x.c.model) : null)),
    cut_sheet: (window._last || {}).cutsheet || null
  };
}"""


def sha256(path):
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


# Stability and semantic rules live in stability_rules.py so that one definition
# governs the run, the report and the offline verifiers. Rules 6 and 7 replaced
# the old +/-2-point gate PROSPECTIVELY on 15 Sep 2026; the run of that date
# remains a failure under the rule then in force and is never re-scored.
fingerprint = SR.fingerprint
compare = SR.compare
semantic_check = SR.semantic_check


class Abort(Exception):
    pass


def one_pass(pg, calls, photos_present):
    results = {}
    pg.fill(S.APP["location"], "East corridor")
    pg.fill(S.APP["opening_number"], "205A")
    for slot, spec in PARTS.items():
        pg.get_by_role("button", name=spec["part_type"], exact=True).click()
        pg.wait_for_timeout(500)
        present = [f for f in spec["photos"] if f in photos_present]
        for fn in present:
            pg.set_input_files(S.APP["photo_input"], str(PHOTOS / fn))
            pg.wait_for_timeout(1200)

        photo_result, service_msg = None, "not attempted — no photographs present"
        if present:
            btn = pg.locator(S.APP["identify_photos"])
            if btn.count() and btn.first.is_visible():
                before = len(calls)
                btn.first.click()
                pg.wait_for_timeout(12000)
                service_msg = pg.locator(S.APP["capture_status"]).first.inner_text().strip()
                photo_result = pg.evaluate(READ_RESULT)
                for c in calls[before:]:
                    if c["status"] in (402, 403, 429):
                        raise Abort(f"recognition function returned {c['status']} "
                                    f"(cost or rate limit) on {slot}")
                    if c["status"] >= 500:
                        raise Abort(f"recognition function errored {c['status']} on {slot}")

        for sel, val in spec["attrs"].items():
            if pg.locator(sel).count():
                try:
                    pg.select_option(sel, val)
                except Exception:
                    pass
        if pg.locator(S.APP["manufacturer"]).count():
            try:
                pg.select_option(S.APP["manufacturer"], spec["mfr"])
            except Exception:
                pass
        pg.click(S.APP["identify"])
        pg.wait_for_timeout(2500)

        results[slot] = {"photos_used": present,
                         "photo_pass": photo_result,
                         "service_message": service_msg,
                         "attribute_baseline": pg.evaluate(READ_RESULT)}
        pg.click(S.APP["add_part"])
        pg.wait_for_timeout(600)
    return results


def run(app_url, reps, write, allow_signed_in):
    data = json.loads(DATA.read_text(encoding="utf-8"))
    reg = {e["filename"]: e for e in data["photograph_registry"]["entries"]}

    photos = {}
    for fn in reg:
        f = PHOTOS / fn
        if f.exists():
            photos[fn] = {"sha256": sha256(f), "bytes": f.stat().st_size}

    report = {
        "run": "exact-photograph test",
        "started": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "deployed_url": app_url,
        "build_version": None,
        "recognition_function_path": VISION,
        "recognition_function_version": None,
        "field_app_version_expected": data["field_app"]["version_id"],
        "repetitions_requested": reps,
        "repetitions_completed": 0,
        "recognition_calls": 0,
        "photographs": {fn: (photos.get(fn) or {"sha256": None, "bytes": None,
                                                "blocking": "image not supplied"})
                        for fn in reg},
        "passes": [],
        "stability": {},
        "stopped_early": None,
        "result_kind": ("workflow demonstration, not field accuracy — these inputs are approved "
                        "demonstration images, and nothing here measures field-recognition performance"),
        "safety": {"signed_in": None, "records_written": False,
                   "actions_avoided": ["Save this part", "Send to purchasing",
                                       "Send full log to purchasing", "Save & next opening"]},
    }

    if not photos:
        report["stopped_early"] = ("no photographs present in assets/photos — nothing to test. "
                                   "The recognition function was not called.")
        out = ROOT / "reports" / "photograph_test_results.json"
        out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(report["stopped_early"])
        print(f"written to {out.relative_to(ROOT)}")
        return report

    calls = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        try:
            for rep in range(1, reps + 1):
                ctx = b.new_context(viewport={"width": 440, "height": 900})
                pg = ctx.new_page()
                pg.on("dialog", lambda d: d.accept())
                pg.on("response", lambda r: calls.append(
                    {"url": r.url, "status": r.status,
                     "version": r.headers.get("x-nf-request-id") or r.headers.get("x-function-version")})
                    if VISION in r.url else None)
                pg.goto(app_url)
                pg.wait_for_load_state("networkidle")
                pg.evaluate("() => { try { localStorage.clear(); sessionStorage.clear(); } catch(e) {} }")
                pg.reload()
                pg.wait_for_load_state("networkidle")
                pg.wait_for_timeout(1500)

                if rep == 1:
                    hdr = pg.locator("header, .hint").first.inner_text()
                    report["build_version"] = next((l.strip() for l in hdr.split("\n")
                                                    if "v" in l and "offline" in l), hdr.strip()[:80])
                    signed_in = pg.locator("#who").count() and bool(
                        pg.locator("#who").first.inner_text().strip())
                    report["safety"]["signed_in"] = bool(signed_in)
                    if signed_in and not allow_signed_in:
                        raise Abort("a signed-in session is present — refusing to run so nothing "
                                    "can reach live customer records. Sign out, or pass "
                                    "--allow-signed-in (this run still never saves).")

                report["passes"].append({"repetition": rep, "results": one_pass(pg, calls, photos)})
                report["repetitions_completed"] = rep
                ctx.close()

                # Rule 8: assess EVERY component, record the verdicts, then stop.
                # A component-specific failure must not invalidate the components
                # that were stable and coherent, so the assessment is written to
                # the report before the run aborts.
                report["assessment"] = SR.assess(report["passes"], PARTS)
                if report["assessment"]["stop"]:
                    report["stability"] = {
                        slot: (e["semantic_violations"] or e["stability"])
                        for slot, e in report["assessment"]["components"].items()
                        if not e["verdict"].startswith("STABLE")}
                    raise Abort(report["assessment"]["stop_reason"] +
                                " — stopping rather than scripting it. Components that "
                                "were stable and coherent are recorded as such in "
                                "report['assessment'].")
        except Abort as e:
            report["stopped_early"] = str(e)
        finally:
            b.close()

    report["recognition_calls"] = len(calls)
    report["recognition_function_version"] = next((c["version"] for c in calls if c["version"]), None)
    report["call_log"] = calls[:50]
    if not report["stability"] and report["repetitions_completed"] > 1:
        report["stability"] = {"verdict": "stable across "
                               f"{report['repetitions_completed']} repetitions"}

    if write and report["repetitions_completed"] and not report["stopped_early"]:
        last = report["passes"][-1]["results"]
        for slot, spec in PARTS.items():
            for fn in spec["photos"]:
                e = reg.get(fn)
                if not e or fn not in photos:
                    continue
                e["version"] = photos[fn]["sha256"][:12]
                e["sha256"] = photos[fn]["sha256"]
                e["bytes"] = photos[fn]["bytes"]
                e["tested_on"] = report["started"]
                e["deployed_url"] = app_url
                e["field_app_version"] = report["build_version"]
                e["recognition_service_version"] = report["recognition_function_version"]
                e["actual_recognition_result"] = last[slot]["photo_pass"]
                e["image_provenance"] = e.get("image_provenance") or "approved demonstration image"
                e["result_kind"] = "workflow demonstration, not field accuracy"
                e["evidence_requested_by_oi"] = (last[slot]["photo_pass"] or {}).get("evidence_requests")
                e["repetitions"] = report["repetitions_completed"]
                e["blocking"] = None
        DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"registry updated: {DATA.relative_to(ROOT)}")

    out = ROOT / "reports" / "photograph_test_results.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\ndeployed url        : {report['deployed_url']}")
    print(f"build version       : {report['build_version']}")
    print(f"function version    : {report['recognition_function_version']}")
    print(f"repetitions         : {report['repetitions_completed']} of {reps}")
    print(f"recognition calls   : {report['recognition_calls']}")
    print(f"photographs present : {len(photos)} of {len(reg)}")
    print(f"stability           : {report['stability'] or 'not evaluated'}")
    if report["stopped_early"]:
        print(f"STOPPED             : {report['stopped_early']}")
    print(f"written to {out.relative_to(ROOT)}")
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True, help="deploy preview / demonstration deployment URL")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--allow-signed-in", action="store_true")
    a = ap.parse_args()
    run(a.app, a.reps, a.write, a.allow_signed_in)
