"""
Validated selectors for the OI Field App prototype.

Every entry below was resolved against the running application from
"Opening Intelligence v14 NETLIFY DROP.zip" (header: Field identifier · offline · v40)
on 2026-09-13. Nothing here is guessed.

Two rules learned the hard way during validation:

1. Use the onclick attribute, not the visible label, for action buttons.
   `button:has-text('Identify')` matches TWO elements — the hidden
   `identifyFrames()` photo button and the visible `run()` attribute button.
   `button[onclick="run()"]` is unambiguous.

2. The part-type grid buttons carry no id or class. Match them by exact
   accessible name (`get_by_role("button", name="DOOR CLOSER", exact=True)`).
"""

APP = {
    # ---- account / facility (module script — needs the Supabase import to load)
    "email":            "#email",
    "password":         "#pass",
    "signin":           "#signin",
    "facility_select":  "#facSel",
    "facility_add":     "#addFacBtn",
    "facility_create":  "#createFacBtn",
    "who":              "#who",

    # ---- opening identity (classic script — works offline)
    "location":         "#loc",
    "opening_number":   "#opnum",
    "fire_rated":       "#fire",

    # ---- part capture
    "capture_button":   "#capbtn",        # label becomes "Take photo N: <step>"
    "capture_step":     "#capstep",       # "Step 1 of 2: Whole closer on the door"
    "capture_hint":     "#caphint",
    "capture_status":   "#vstatus",
    "photo_input":      "#photo",         # set_input_files() works here
    "library_input":    "#photolib",
    "library_button":   "#caplibbtn",
    "add_angle":        "#addmore",
    "identify_photos":  "button[onclick='identifyFrames()']",

    # ---- model lookup
    "model_query":      "#mq",
    "model_search":     "button[onclick='modelLookup()']",
    "model_results":    "#mqres",
    "model_use_link":   "#mqres a",       # calls loadHit(i) — see note below

    # ---- attributes + identify
    "manufacturer":     "#mfr",
    "identify":         "button[onclick='run()']",
    "result":           "#result",
    "cut_sheet":        "#result a:has-text('View cut sheet')",   # external href
    "send_to_purchasing": "#result button[onclick='sendToPurchasing()']",

    # ---- per-part record
    "condition":        "#cond",
    "true_model":       "#truth",
    "cost":             "#cost",
    "done_date":        "#donedate",
    "save_part":        "button[onclick='logIt()']",
    "add_part":         "button[onclick='addPart()']",
    "next_opening":     "button[onclick='nextOpening()']",
    "log_count":        "#logcount",

    # ---- door & frame (module script — needs sign-in to actually save)
    "door_toggle":      "button[onclick='toggleDoor()']",
    "door_form":        "#doorForm",
    "door_material":    "#doorMat",
    "door_width":       "#doorW",
    "door_height":      "#doorH",
    "door_thickness":   "#doorT",
    "door_handing":     "#doorHand",
    "door_frame":       "#doorFrame",
    "door_save":        "button[onclick='saveDoor()']",
    "door_message":     "#doorMsg",

    # ---- completion
    "finish_opening":   "button[onclick='finishOpening()']",
    "finish_message":   "#finishMsg",
    "generate_qr":      "button[onclick='genOpeningQR()']",

    # ---- outputs
    "send_full_log":    "button[onclick='sendLogToPurchasing()']",
    "export_csv":       "button[onclick='exportCsv()']",
    "service_call":     "#svcToggleBtn",
    "service_save":     "#svcSaveBtn",
}

# Part-type grid: exact accessible names, verified present.
PART_TYPES = [
    "COORDINATOR", "DOOR CLOSER", "EDGE GUARD", "EXIT DEVICE", "EXTERIOR",
    "FLUSH BOLT", "FLUSH PULL", "HINGE BUTT", "HINGE CONT", "LATCH CATCH BOLT",
    "LOCKSET", "PIVOT", "PROTECTION PLATE", "PULL PUSH", "RESCUE",
    "STOP HOLDER", "STRIKE DP", "VANDAL TRIM",
]

# Attribute selects per part type, with their real option values.
ATTRIBUTES = {
    "DOOR CLOSER": {
        "#a_closer_type": ["", "surface", "concealed_overhead", "concealed_in_door", "floor_spring"],
        "#a_mounting":    ["", "regular_arm", "parallel_arm", "top_jamb"],
        "#a_arm_type":    ["", "standard", "hold_open", "cush_stop", "spring_stop", "fusible_link"],
        "#a_cover_type":  ["", "plastic", "metal", "none"],
    },
    "EXIT DEVICE": {
        "#a_device_type":   ["", "rim", "surface_vertical_rod", "concealed_vertical_rod", "mortise"],
        "#a_chassis_style": ["", "touchpad", "crossbar"],
        "#a_mount":         ["", "surface", "concealed"],
        "#a_outside_trim":  ["", "none_exit_only", "lever", "night_latch", "pull"],
    },
    "HINGE BUTT": {
        "#a_knuckle_count": None,   # options not enumerated during validation
        "#a_bearing_type":  None,
        "#a_leaf_profile":  None,
        "#a_pin_type":      None,
    },
}

# Guided capture steps, read from CAPTURE_STEPS in the application source.
CAPTURE_STEPS = {
    "DOOR CLOSER": ["Whole closer on the door", "Body stamp / label"],
    "EXIT DEVICE": ["Full device across the door", "End cap / chassis stamp", "Outside trim"],
    "HINGE BUTT":  ["Full hinge on the door", "Knuckle close-up", "Leaf stamp"],
    "LOCKSET":     ["Whole lock + cylinder", "Inside trim", "Stamp / model #"],
}

# Fixed option values used by the controlled demo dataset.
CONDITION = {"good": "Good — serviceable",
             "worn": "Worn — aging / degraded",
             "failed": "Failed — not working / unsafe"}

DOOR_MATERIALS = ["Hollow Metal", "Wood", "FRP", "Aluminum", "Other"]
DOOR_HANDING = ["LH", "RH", "LHR", "RHR"]
DOOR_FRAMES = ["Hollow Metal", "Wood", "Aluminum", "Other"]

# ---------------------------------------------------------------------------
# Behaviour confirmed by running the application. These are the facts the
# scene list and narration must respect.
# ---------------------------------------------------------------------------
BEHAVIOUR = {
    "module_script_gate":
        "toggleDoor, saveDoor, finishOpening and genOpeningQR are defined inside the "
        "<script type=\"module\"> block that begins `import { createClient } from "
        "'https://esm.sh/@supabase/supabase-js@2'`. If esm.sh is unreachable the whole "
        "module fails to execute and all four are undefined — Door & frame spec, Save "
        "door & frame, Finish opening and Generate opening QR are dead buttons. Part "
        "logging is in a classic script and keeps working, which makes the failure easy "
        "to miss.",
    "door_save_requires_auth":
        "saveDoor() returns early with 'Sign in to save the door to the opening record.' "
        "unless a Supabase session and a facility exist. It upserts into the `openings` "
        "table and only then sets window._doorDone[op].",
    "finish_requires_door":
        "finishOpening() alerts 'Capture and save the Door & frame spec before finishing "
        "the opening.' unless _doorDone[op] is set, and requires at least one saved part.",
    "qr_requires_finish":
        "genOpeningQR() alerts 'Please finish the entire opening before creating a QR "
        "code.' unless _openingDone[op] is set.",
    "no_model_level_id_offline":
        "With attributes only, the engine reports 'Model: Not established' and 'Highest "
        "defensible level: family' (closer) or 'component' (hinge). A model-level result "
        "needs the OI image-recognition service reading a stamp. /.netlify/functions/vision "
        "returns 501 "
        "when undeployed and the app says 'Couldn't auto-identify (service 501).' "
        "(The app's own string says \"vision service\"; that wording is quoted here, never spoken.)",
    "loadHit_does_not_identify":
        "The 'use →' link in model lookup calls loadHit(i), which only selects the part "
        "class and sets the manufacturer dropdown, then scrolls to the form. It does not "
        "set the model or run identification.",
    "model_search_is_substring":
        "modelLookup() strips non-alphanumerics and substring-matches, so 'AF7700' also "
        "returns 'Ives 700 · hinge cont' and 'Cal-Royal 700 · door closer' ahead of "
        "'Cal-Royal A7700 / AF7700 · exit device'. The correct row is third.",
    "purchasing_has_no_screen":
        "sendToPurchasing() and sendLogToPurchasing() build text and hand it to "
        "navigator.share(), falling back to a mailto: URL. Neither renders anything in "
        "the application. There is no 'Full log → Purchasing' panel in this build.",
    "purchasing_list_is_condition_driven":
        "sendLogToPurchasing() selects entries whose condition is 'worn' or 'failed', and "
        "falls back to every logged entry if none match. It is not driven by pressing "
        "'Send to purchasing' on a part.",
    "cut_sheet_is_external":
        "'View cut sheet' is an anchor to the manufacturer's site (for CR441: "
        "https://cal-royal.com/api/media/file/CR441_Series_Installation_Instruction_.pdf). "
        "It opens a new tab and needs internet. Nothing renders inside the app.",
    "af7700_cut_sheet_is_an_index_page":
        "The catalog entry 'Cal-Royal A7700 / AF7700' carries cut_sheet_url "
        "https://www.cal-royal.com/resources/templates-and-installation-instructions/exit-devices "
        "— a listing page, not the installation PDF.",
    "log_count_wording":
        "logIt() writes `LOG.length + ' opening(s) logged on this device. ✓ saved'`, but "
        "LOG holds one entry per PART. After three parts on one opening the screen reads "
        "'3 opening(s) logged on this device.'",
    "no_save_confirmation":
        "'Save this part' produces no per-part confirmation beyond that counter line, and "
        "there is no saved-part list to reopen.",
}
