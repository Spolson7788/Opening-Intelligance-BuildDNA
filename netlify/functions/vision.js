// Opening Intelligence — vision proxy (Netlify Function, zero dependencies).
// Holds the API key server-side; the app POSTs base64 images and gets a structured
// identification back: manufacturer / series / model, transcribed visible text,
// the evidence behind each call, and per-level confidence.
const PROMPT = "You are identifying a piece of commercial door hardware from photographs of an installed door or a loose part.\n\nWORK IN THIS ORDER. Do not skip step 1.\n\nSTEP 1 - TRANSCRIBE BEFORE YOU IDENTIFY.\nExamine every submitted photograph together; a marking may be legible in only one frame. Read and transcribe EVERY legible or partially legible marking you can see: body stamps, cast or forged lettering, adhesive labels, date codes, patent numbers, UL/cUL marks, logos, wordmarks, part numbers, size digits, and fragments. Record fragments exactly as seen, including partials such as \"CR4__\" or \"...441\". Do this before forming any opinion about what the product is.\n\nSTEP 2 - IDENTIFY ONLY FROM EVIDENCE.\nName a manufacturer, series or model ONLY when it is supported by transcribed visible text, or by a distinctive combination of physical features that is specific to that product. If the evidence does not reach a level, return null for that level. Returning null is correct and expected; guessing is a failure.\n\nSTEP 3 - DO NOT COLLAPSE LOOK-ALIKES.\nMany door hardware products are visually similar or are sold as cross-references / replacements for one another. A cross-reference means two products may be interchangeable in an order - it does NOT mean they are the same product, and it is NOT evidence that one is the other. Keep them distinct. Only name a specific member of a look-alike family when a marking or a feature unique to that member supports it.\n\nRETURN ONLY COMPACT JSON, no prose, in exactly this shape:\n{\"component_class\":<one class code>,\"manufacturer\":<brand or null>,\"series\":<series or null>,\"model\":<model or null>,\"visible_text\":[<every legible or partial marking, as a string>],\"attributes\":{<field>:<value>,...},\"evidence\":[{\"observation\":<specific visible feature or transcribed text>,\"supports\":<\"manufacturer\" | \"series\" | \"model\" | the attribute field name>}],\"confidence\":{\"manufacturer\":<0-1>,\"series\":<0-1>,\"model\":<0-1>}}\n\nRULES FOR THE FIELDS.\nvisible_text: an array of strings. Empty array if nothing is legible. Never invent text.\nseries: the product family (for example the base line a model belongs to), or null.\nmodel: the specific model designation, or null. A model is not the same as a series - return the series and a null model when you can read the family but not the exact variant.\nevidence: one entry per observation that actually drove a conclusion. Cite what you saw, not what you inferred.\nconfidence: three independent numbers between 0 and 1. Do not report high manufacturer confidence when several brands remain plausible. Do not report model confidence above 0.6 without a visible model marking.\nattributes: the class-specific attributes below. Omit any attribute you cannot clearly see; never guess a value that is not visible.\n\nUse ONLY these class codes, and for the chosen class ONLY these attribute values.\n\nCOORDINATOR -> coordinator_type: bar | gravity; accessory_role: carry_bar | mounting_bracket | filler_bar | not_applicable\nDOOR_CLOSER -> closer_type: surface | concealed_overhead | concealed_in_door | floor_spring; mounting: regular_arm | parallel_arm | top_jamb (parallel_arm = arm folds back flat against the door on the push side with a bracket on the door face; regular_arm = arm projects out to a shoe on the frame/soffit); arm_type: standard | hold_open | cush_stop | spring_stop | fusible_link (READ THE ARM AND ANY TRACK to choose: cush_stop = heavy forearm that rides INSIDE a metal track/channel with a bumper stop at the end; spring_stop = rigid stop arm with a built-in mechanical dead-stop but NO track; hold_open = a regular two-piece scissor/forearm fitted with a friction knob or slider used to hold the door open; standard = a plain two-piece scissor/forearm with no track, no stop, and no hold-open knob; fusible_link = arm carries a small heat-release fusible link); cover_type: plastic | metal | none\nEDGE_GUARD -> guard_profile: mortise | non_mortise | overlap | semi_overlap | astragal; beveled: yes | no; wrap: none | wrap | bullnose; cutouts_present: yes | no\nEXIT_DEVICE -> device_type: rim | surface_vertical_rod | concealed_vertical_rod | mortise (rim = push bar on the door FACE at latch height, latches to the frame edge, no vertical rods; surface_vertical_rod = metal RODS run UP and DOWN the door face to top and bottom latches; concealed_vertical_rod = top and bottom latch points but rods are hidden inside the door, none visible on the face; mortise = lock case buried in the door EDGE, latches from the edge, no rods); chassis_style: touchpad | crossbar (touchpad = flat push pad or paddle; crossbar = round or square bar that projects off the door, older style); mount: surface | concealed; outside_trim: none_exit_only | lever | night_latch | pull\nEXTERIOR -> guard_style: solid_bar | chain | privacy_swing | not_applicable; device_type: lock_guard | door_guard | door_viewer | knocker | mail_slot\nFLUSH_BOLT -> operation: automatic | constant_latching | manual; lever_present: yes | no; bolt_end_shape: square | round; aux_fire_latch: yes | no; faceplate_shape: rectangular | rounded | narrow\nFLUSH_PULL -> pull_shape: round | rectangular | oblong | square; recess_style: cup | rectangular_recess | edge_pull | flush_ring\nHINGE_BUTT -> knuckle_count: 3 | 5 (count the knuckles on the barrel); bearing_type: ball_bearing | concealed_bearing | plain_bearing | spring (ball_bearing = visible bearing bands between the knuckles; plain_bearing = plain knuckles, no bearing bands; concealed_bearing = smooth barrel with the bearing hidden; spring = spring hinge with a tension-adjust hole in the barrel); leaf_profile: standard | swing_clear | wide_throw | half_mortise | electrified (standard = two flat rectangular leaves set in the door edge; swing_clear = cranked or offset leaf that swings the door clear of the opening; wide_throw = extra-deep leaves; electrified = wires or an electric transfer at the barrel); pin_type: standard | non_removable_pin (non_removable_pin has a small set screw in the barrel)\nHINGE_CONT -> hinge_type: geared | pin_and_barrel; mount_position: full_mortise | full_surface | half_surface; cover_present: yes | no\nLATCH_CATCH_BOLT -> device_type: roller_latch | roller_catch | ball_catch | magnetic_catch | elbow_catch | surface_bolt | angle_stop | invisible_latch\nLOCKSET -> lock_type: cylindrical | mortise | interconnected | deadbolt | tubular (cylindrical = lever or knob on a round rose through a bore in the door FACE, latch in the edge; mortise = large rectangular lock case in the door EDGE with a tall edge faceplate, trim on a rose or escutcheon; interconnected = a lever and a deadbolt linked in one vertical trim; deadbolt = just a bolt with a thumbturn or cylinder, no lever or latch; tubular = light residential-grade latch through a small bore); trim: lever | knob; rose_shape: round | square; keyed: yes | no (a keyway or cylinder visible on the outside = yes)\nPIVOT -> pivot_type: offset | center_hung | intermediate | pocket | power_transfer; electrified: yes | no\nPROTECTION_PLATE -> plate_role: kick | armor | mop | stretcher; bevel_edges: beveled | square\nPULL_PUSH -> form: pull_handle | push_bar | push_plate | pull_plate | offset_pull | flush_pull; mounting_visible: exposed | concealed; grip_profile: round | square | flat | rectangular\nRESCUE -> rescue_type: adjustable | breakaway | removable\nSTOP_HOLDER -> stop_type: floor | wall | hinge_pin | overhead | kick_down | roller_bumper | silencer | crash; hold_open: yes | no; bumper_material: rubber | plastic | none\nVANDAL_TRIM -> trim_function: night_latch | dummy | mortise | passage; grip_edge: with_grip | without_grip; device_compatibility: rim_vertical | mortise_exit | mortise_lock";

// Anything the model omits still has to arrive in a predictable shape, because the
// browser reads these fields directly. Never fabricate a value here — absent means null.
function normalizeResult(obj) {
  const out = obj && typeof obj === "object" ? obj : {};
  const conf = (out.confidence && typeof out.confidence === "object") ? out.confidence : {};
  const num = (v) => {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  };
  const str = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "unknown" ? s : null;
  };
  return {
    component_class: str(out.component_class),
    manufacturer: str(out.manufacturer),
    series: str(out.series),
    model: str(out.model),
    visible_text: Array.isArray(out.visible_text)
      ? out.visible_text.map((t) => String(t).trim()).filter(Boolean)
      : [],
    attributes: (out.attributes && typeof out.attributes === "object") ? out.attributes : {},
    evidence: Array.isArray(out.evidence)
      ? out.evidence
          .filter((e) => e && (e.observation || e.supports))
          .map((e) => ({
            observation: String(e.observation == null ? "" : e.observation).trim(),
            supports: String(e.supports == null ? "" : e.supports).trim()
          }))
      : [],
    confidence: {
      manufacturer: num(conf.manufacturer),
      series: num(conf.series),
      model: num(conf.model)
    }
  };
}


// Targeted second pass. The PDFs are NEVER sent to the API — the app stores the
// normalized reference features and asks here only about the specific ones that
// would separate the candidates still in play.
function focusPrompt(features){
  var lines=features.slice(0,24).map(function(f,i){
    return (i+1)+'. field "'+f.field+'" — '+(f.question||('is this present, and what is its value? Documented as: '+f.value));
  }).join("\n");
  return "You are re-examining the SAME photographs for a short list of specific features. "+
    "Do not identify the product. Do not guess. For each numbered feature below, answer ONLY from what is visibly present in the images.\n\n"+
    lines+"\n\n"+
    "Return ONLY compact JSON:\n"+
    '{"observed_features":[{"field":"<the field name exactly as given>","visible":true|false,"value":"<what you actually see, or null>","note":"<where in the image>"}],'+
    '"measurements":{},"visible_text":["<any further legible markings>"]}\n\n'+
    "visible:false means you cannot see it — that is a useful and correct answer. Never report a value you cannot see. "+
    "Do not estimate dimensions from perspective; leave measurements empty unless a rule or scale is visible in frame.";
}


// Label-blind physical analysis. Text is deliberately quarantined: the model is
// told to describe construction only, and any writing it happens to see goes into
// a SEPARATE channel the physical scorer never reads.
var PHYSICAL_PROMPT = [
"You are describing the PHYSICAL CONSTRUCTION of a commercial door closer from photographs.",
"",
"ABSOLUTE RULE: do not identify the product, and do not let any writing influence your description.",
"Ignore manufacturer names, logos, series numbers, model numbers, stamped text, labels and stickers when describing construction.",
"If writing is visible, do NOT use it to decide what the part is. Report it separately in label_observations, which is kept apart from the physical analysis.",
"",
"Examine ALL submitted photographs together. Describe only what is physically visible.",
"",
"STEP 1 — CLASSIFY EVERY IMAGE BEFORE DESCRIBING ANYTHING.",
"For each image, decide which of these it is:",
"  field_photograph          — a real photograph of an installed or in-hand unit",
"  studio_product_photograph — a real photograph taken against a plain backdrop",
"  cad_rendering             — a computer-generated 3D image (flat infinite backdrop, faceted curves,",
"                              default untextured materials, ghosted or translucent parts, exploded",
"                              floating components, a 3D-viewer toolbar)",
"  installation_diagram      — a line drawing showing how the part is fitted",
"  dimensioned_drawing       — an orthographic drawing carrying dimension lines or callouts",
"  unknown                   — you cannot tell",
"Say WHY, by naming the indicators you actually saw. If you are unsure, say unknown and give",
"the alternative you considered — do not guess a type to look decisive. Preserve that uncertainty;",
"a wrong classification is worse than an admitted one.",
"Also rate each image's quality: clear (sharp, well framed, adequate resolution), partial",
"(small, soft, oblique or cropped), or poor (blurred, dark, or mostly obscured).",
"",
"WHY THIS MATTERS: a rendering or drawing that OMITS a small feature is not evidence that the",
"product lacks it — draughtsmen leave out screws, seams and fasteners routinely. Only a clear real",
"photograph can support a statement that something is NOT there.",
"",
"ONE OBSERVATION, ONE IMAGE. Every entry in physical_observations describes what you see in a",
"single image, named in photo_index, and carries the region of that image it came from: region is",
"{x,y,w,h} as fractions of the image width and height, x,y being the top-left corner of the area",
"you looked at. If you cannot locate the area, set region to null rather than guessing a box.",
"Never write one observation that summarises several images. If two images show the same feature,",
"write two observations. Conclusions across images are drawn later, by the application, from these",
"individual records — do not pre-merge them, because a merged claim cannot be audited back to the",
"image that supports it.",
"",
"So: when you report that a feature is ABSENT, the observation must rest on ONE real photograph",
"that clearly shows the area where the feature would be, and its photo_index must be that image.",
"Never write 'in any view', 'in all images' or 'anywhere on the part' for an absence — that fuses",
"renderings into the claim. If no single real photograph shows the area clearly, omit the feature",
"entirely rather than reporting it as absent.",
"",
"Report these physical features where observable. This list is what separates one closer",
"from another; a description that only establishes 'it is a surface closer' identifies nothing.",
"",
"INSTALLATION STATE",
"exposed versus covered: is the decorative cover fitted, partly fitted, or removed;",
"mounting orientation (regular/hinge pull side, top jamb push side, parallel arm push side, track, concealed);",
"body position relative to the door leaf and the frame head — on the leaf, on the frame, how far from the hinge;",
"handedness and installation configuration, but ONLY where the hinge side and swing are both visible;",
"",
"COVER AND BODY",
"cover silhouette and the shape of each end (square, radiused, tapered, stepped, faceted);",
"cover seams, joints, clips and retaining screws with their positions;",
"body length-to-height ratio as a RELATIVE proportion (never inches unless a scale is in the same plane);",
"body depth relative to its height; distinctive casting, housing or cover details — ribs, recesses, bosses,",
"notches, raised pads, parting lines, cast lettering panels;",
"",
"SPINDLE, VALVES, FASTENERS",
"spindle and pinion position along the body, as a fraction of body length from each end;",
"pinion boss or collar shape; which end of the body carries the spring tube;",
"visible adjustment-valve location (which face, which end) and arrangement (count, spacing, in a row or grouped);",
"fastener positions and count on the body, the cover, the shoe and the bracket;",
"",
"ARM",
"arm type (regular, long, heavy duty, hold open, cush/stop, track) and arm geometry — straight, elbowed,",
"the angle it makes, whether the forearm is slotted and length-adjustable;",
"arm shoe shape and its hole pattern (count and layout); bracket or drop-plate geometry where one is fitted;",
"",
"body silhouette; body length-to-height ratio; body depth; end profiles (rectangular, rounded, tapered, stepped, irregular);",
"cover shape; cover length and proportions; cover seams; cover clips; cover screws and their locations; end caps;",
"spindle position along the body; spindle offset from door or frame; adjustment valve count; valve sequence; valve grouping;",
"valve location by body face or end; spring power adjustment position; backcheck selector position; pinion cap shape;",
"main arm profile; forearm profile; arm joint construction; arm shoe shape; arm shoe hole pattern; parallel arm bracket shape;",
"drop plates or mounting plates; visible mounting hole positions; fastener count and arrangement; body orientation relative to hinge;",
"tube or spring end orientation; mounting configuration (regular arm, parallel arm, top jamb, track, concealed);",
"arm construction (standard, hold open, stop, cush); and any distinctive casting, contour, recess, boss, ridge, notch or adjustment opening.",
"",
"DIMENSIONS: do not state a dimension in inches or millimetres unless a ruler, tape or object of known size is in the SAME PLANE as the part.",
"Without a scale reference, use relative descriptions and set estimated:true. Relative proportions between two things in the same photograph are acceptable.",
"",
"Return ONLY compact JSON:",
'{"images":[{"index":<0-based>,"image_type":"field_photograph|studio_product_photograph|cad_rendering|installation_diagram|dimensioned_drawing|unknown","image_type_confidence":<0-1>,"image_type_alternative":"<the other type you considered, or null>","quality":"clear|partial|poor","indicators":["<what you saw that decided it>"],"what_it_shows":"<one sentence>"}],',
'"physical_observations":[{"feature":"<feature name from the list above>","value":"<what you actually see>","photo_index":<0-based index of the ONE image this observation comes from>,"region":{"x":<0-1>,"y":<0-1>,"w":<0-1>,"h":<0-1>},"visibility":"clear|partial|poor","confidence":<0-1>,"estimated":true|false,"basis":"direct_observation|perspective_estimate|scale_reference"}],',
'"mounting_configuration":"regular_arm|parallel_arm|top_jamb|track|concealed|unknown",',
'"arm_construction":"standard|hold_open|stop|cush|track|unknown",',
'"cover_state":"installed|removed|partial|unknown",',
'"scale_reference_present":true|false,',
'"label_observations":{"text_seen":["<any legible text, kept OUT of the physical analysis>"],"logo_seen":<true|false>},',
'"physical_notes":"<anything distinctive that has no field above>"}',
"",
"Omit any feature you cannot see. An empty physical_observations array is a valid answer for an unusable photograph.",
"A feature hidden behind the cover, cut off by the frame edge, or lost to glare is UNKNOWN. Do not infer it",
"from what closers usually look like. Unknown is the correct answer and is more useful than a guess.",
"Do not report a feature that is merely typical of surface closers as though you had observed it: every",
"observation must be something you can point at in one named photograph.",
"Never describe a feature because it is typical of door closers — only because it is visible in these images."
].join("\n");

function normalizePhysical(parsed){
  var p = parsed && typeof parsed === "object" ? parsed : {};
  var num = function(v){var n=typeof v==="number"?v:parseFloat(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;};
  var obs = Array.isArray(p.physical_observations) ? p.physical_observations : [];
  var TYPES = ["field_photograph","studio_product_photograph","cad_rendering",
               "installation_diagram","dimensioned_drawing","unknown"];
  var imgs = Array.isArray(p.images) ? p.images : [];
  return {
    // Per-image classification. An unrecognised or missing type becomes "unknown",
    // never a guess — the absence rule treats unknown as unable to prove absence.
    images: imgs.filter(function(im){return im && Number.isFinite(im.index);}).map(function(im){
      var t = TYPES.indexOf(im.image_type) >= 0 ? im.image_type : "unknown";
      var q = ["clear","partial","poor"].indexOf(im.quality) >= 0 ? im.quality : "unknown";
      return {
        index: im.index,
        image_type: t,
        image_type_confidence: num(im.image_type_confidence),
        image_type_alternative: im.image_type_alternative == null ? null : String(im.image_type_alternative).trim(),
        quality: q,
        indicators: Array.isArray(im.indicators) ? im.indicators.map(function(s){return String(s).trim();}).filter(Boolean) : [],
        what_it_shows: im.what_it_shows == null ? null : String(im.what_it_shows).trim(),
        // Derived, not asserted by the model: only a clear real photograph can prove an absence.
        absence_capable: (t === "field_photograph" || t === "studio_product_photograph") && q === "clear"
      };
    }),
    physical_observations: obs.filter(function(o){return o&&o.feature;}).map(function(o){
      // Each observation stays attached to one image, one region of it, and that
      // image's type and quality. A record that cannot be traced back to a single
      // image cannot be audited, so nothing here is merged or inferred across images.
      var pi = Number.isFinite(o.photo_index) ? o.photo_index : null;
      var src = null;
      for (var z = 0; z < imgs.length; z++) if (imgs[z] && imgs[z].index === pi) src = imgs[z];
      var srcType = src ? (TYPES.indexOf(src.image_type) >= 0 ? src.image_type : "unknown") : "unknown";
      var srcQual = src ? (["clear","partial","poor"].indexOf(src.quality) >= 0 ? src.quality : "unknown") : "unknown";
      var frac = function(v){var n=typeof v==="number"?v:parseFloat(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;};
      var rg = o.region && typeof o.region === "object" ? {
        x: frac(o.region.x), y: frac(o.region.y), w: frac(o.region.w), h: frac(o.region.h)
      } : null;
      if (rg && (rg.x == null || rg.y == null || rg.w == null || rg.h == null)) rg = null;
      return {
        feature: String(o.feature).trim(),
        value: o.value == null ? null : String(o.value).trim(),
        photo_index: pi,
        // Crop coordinates of the area looked at, as fractions of that image. null
        // when the model could not locate it — never a fabricated box.
        region: rg,
        // Resolved from images[], carried on the observation so it survives every
        // downstream step and never has to be re-derived.
        image_type: srcType,
        image_quality: srcQual,
        // Flagged, not silently dropped: language that spans images cannot be
        // attributed to the one image this record names.
        fused_claim: /\b(in any (view|image|frame|photo)|across (all|the) (views|images|frames)|anywhere (in|on)|none of the (views|images|frames)|nowhere|no view)\b/i
                     .test(String(o.value == null ? "" : o.value)),
        visibility: ["clear","partial","poor"].indexOf(o.visibility) >= 0 ? o.visibility : "partial",
        confidence: num(o.confidence),
        estimated: o.estimated === true,
        basis: ["direct_observation","perspective_estimate","scale_reference"].indexOf(o.basis) >= 0 ? o.basis : "direct_observation"
      };
    }),
    mounting_configuration: p.mounting_configuration || "unknown",
    arm_construction: p.arm_construction || "unknown",
    cover_state: p.cover_state || "unknown",
    scale_reference_present: p.scale_reference_present === true,
    // Quarantined. The physical scorer must never read this.
    label_observations: {
      text_seen: Array.isArray(p.label_observations && p.label_observations.text_seen)
        ? p.label_observations.text_seen.map(function(t){return String(t).trim();}).filter(Boolean) : [],
      logo_seen: !!(p.label_observations && p.label_observations.logo_seen)
    },
    physical_notes: p.physical_notes == null ? null : String(p.physical_notes).trim()
  };
}

// ---------------------------------------------------------------------------
// mode: "marking_regions"
// WHERE the markings are, before anything reads them. This pass is deliberately
// blind to product identity: it is asked to localise surfaces bearing markings,
// not to interpret them. Locating and reading are separated so that a failure to
// find a marking is distinguishable from a failure to read one.
// ---------------------------------------------------------------------------
var MARKING_PROMPT = [
"Locate every region of this image that carries a PRODUCT MARKING.",
"",
"A product marking is any applied or formed identification on the hardware itself:",
"printed or adhesive labels; stamped, cast, etched, engraved or embossed lettering;",
"date or lot codes; certification marks and listing stamps; logos and wordmarks;",
"moulded-in text; barcodes, QR codes and serial plates; coloured certification stickers.",
"",
"Do NOT report: background objects, packaging, watermarks, image captions added outside",
"the product, reflections, or surface scratches that merely resemble text.",
"",
"YOUR TASK IS LOCATION, NOT READING.",
"Report where each marking is and what kind of marking it appears to be. Transcribe text only",
"where it is plainly legible, and mark legibility honestly. A region you can see carries writing",
"but cannot read is a SUCCESS for this pass — report it with text:null and legible:false.",
"Never guess at characters. Never infer a manufacturer or model from shape, style or context.",
"",
"For each region give a bounding box as fractions of the image: x and y are the top-left corner,",
"w and h the width and height, each between 0 and 1. Be tight around the marking itself, not the",
"component carrying it.",
"",
"Also state, for each region, which part of the product carries it (for example: cylinder or spring",
"tube, cast body, cover, arm, forearm, shoe, bracket, end cap) using only what you can see.",
"",
"Return ONLY compact JSON:",
'{"marking_regions":[{"x":<0-1>,"y":<0-1>,"w":<0-1>,"h":<0-1>,"marking_kind":"printed_label|adhesive_label|stamped|cast|etched|engraved|embossed|logo|barcode|certification_sticker|unknown","carrier":"<part of the product carrying it>","legible":true|false,"text":"<exact characters, or null>","confidence":<0-1>,"why":"<what made you call this a marking>"}],',
'"regions_found":<integer>,',
'"image_supports_marking_detection":true|false,',
'"limiting_factor":"<resolution, angle, glare, occlusion, or null>"}',
"",
"An empty marking_regions array is a valid and useful answer. Report every region you can see,",
"including ones too small or too soft to read — those are exactly the regions a technician should",
"be told to re-photograph."
].join("\n");

function normalizeMarkings(parsed){
  var p = parsed && typeof parsed === "object" ? parsed : {};
  var frac = function(v){var n=typeof v==="number"?v:parseFloat(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;};
  var num = function(v){var n=typeof v==="number"?v:parseFloat(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;};
  var KINDS = ["printed_label","adhesive_label","stamped","cast","etched","engraved","embossed",
               "logo","barcode","certification_sticker","unknown"];
  var rs = Array.isArray(p.marking_regions) ? p.marking_regions : [];
  var out = rs.map(function(r){
    var x=frac(r&&r.x), y=frac(r&&r.y), w=frac(r&&r.w), h=frac(r&&r.h);
    if(x==null||y==null||w==null||h==null||w<=0||h<=0) return null;
    return {
      x:x, y:y, w:w, h:h,
      // Clamped to the frame so a box can never extend past the image.
      x2: Math.min(1, x+w), y2: Math.min(1, y+h),
      marking_kind: KINDS.indexOf(r.marking_kind) >= 0 ? r.marking_kind : "unknown",
      carrier: r.carrier == null ? null : String(r.carrier).trim(),
      legible: r.legible === true,
      // Text is only kept when the model called it legible. An illegible region
      // reporting characters is reporting a guess.
      text: (r.legible === true && r.text != null && String(r.text).trim()) ? String(r.text).trim() : null,
      confidence: num(r.confidence),
      why: r.why == null ? null : String(r.why).trim()
    };
  }).filter(Boolean);
  return {
    marking_regions: out,
    regions_found: out.length,
    legible_regions: out.filter(function(r){return r.legible;}).length,
    image_supports_marking_detection: p.image_supports_marking_detection !== false,
    limiting_factor: p.limiting_factor == null ? null : String(p.limiting_factor).trim()
  };
}

// ---------------------------------------------------------------------------
// mode: "hardware_regions"
// WHERE the hardware is, before anything looks at it closely. Runs first so the
// detailed passes can be given component crops from the original pixels rather
// than a whole door.
// ---------------------------------------------------------------------------
var HARDWARE_PROMPT = [
"Locate each piece of door hardware in this image. You are LOCATING, not identifying.",
"",
"Do not name any manufacturer, model, series or product family anywhere in your answer.",
"Do not describe construction detail — that is a later pass. Boxes and component types only.",
"",
"Find each of these SEPARATELY where present. One box per component, not one box for the lot:",
"  closer_body            the metal body or cylinder of a door closer",
"  decorative_cover       the shell over the body, if one is fitted",
"  arm_segment            each arm segment individually — a two-piece arm is TWO boxes",
"  arm_shoe               the foot or shoe at the end of the arm",
"  track_channel          a track or slide channel, where the arm runs in one",
"  bracket_drop_plate     a bracket or drop plate between the closer and the door or frame",
"  spindle_pinion_area    where the arm meets the body, around the spindle",
"  valve_end              the end of the body carrying adjustment valves",
"  marking_label          a printed or adhesive label",
"  marking_stamp          stamped or struck characters",
"  marking_cast           characters formed in the casting",
"  logo                   a wordmark or emblem",
"  sticker                a certification or inspection sticker",
"  neighbouring_hardware  other hardware ONLY where it shows the installation configuration",
"                         (a hinge that establishes the hinge side, a strike, a stop)",
"",
"For each region give a bounding box as fractions of the image: x and y are the top-left",
"corner, w and h the size, each between 0 and 1. Box the component itself, not the door around it.",
"",
"State for each region:",
"  visibility   clear | partial | poor",
"  truncated    true if the component runs out of the frame",
"  confidence   0-1, your confidence that the box contains what you say it does",
"",
"If you cannot locate a component, DO NOT GUESS A BOX. Omit it, or return it with",
"box null and confidence low. A missing box is a useful answer; an invented one is not.",
"",
"Also estimate, for the closer body if you can see one, roughly how many pixels across it is",
"in this image. Say null if you cannot judge it.",
"",
"Return ONLY compact JSON:",
'{"regions":[{"component":"<type from the list>","x":<0-1>,"y":<0-1>,"w":<0-1>,"h":<0-1>,"visibility":"clear|partial|poor","truncated":true|false,"confidence":<0-1>,"why":"<what made you call it this>"}],',
'"closer_body_px_across":<integer or null>,',
'"regions_found":<integer>,',
'"image_supports_localization":true|false,',
'"limiting_factor":"<resolution, framing, occlusion, or null>"}',
"",
"An empty regions array is valid. Report every component you can actually see."
].join("\n");

function normalizeHardwareRegions(parsed){
  var p = parsed && typeof parsed === "object" ? parsed : {};
  var TYPES = ["closer_body","decorative_cover","arm_segment","arm_shoe","track_channel",
    "bracket_drop_plate","spindle_pinion_area","valve_end","marking_label","marking_stamp",
    "marking_cast","logo","sticker","neighbouring_hardware","unknown"];
  var frac = function(v){var n=typeof v==="number"?v:parseFloat(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;};
  var num = function(v){var n=typeof v==="number"?v:parseFloat(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;};
  var rs = Array.isArray(p.regions) ? p.regions : [];
  var out = rs.map(function(r, i){
    var x=frac(r&&r.x), y=frac(r&&r.y), w=frac(r&&r.w), h=frac(r&&r.h);
    var boxed = !(x==null||y==null||w==null||h==null||w<=0||h<=0);
    var t = TYPES.indexOf(r&&r.component) >= 0 ? r.component : "unknown";
    return {
      region_id: t + "_" + i,
      component: t,
      // A region with no usable box is KEPT, with box null. Losing it would hide
      // that the localizer saw something it could not place.
      box: boxed ? {x:x, y:y, w:w, h:h, x2:Math.min(1,x+w), y2:Math.min(1,y+h)} : null,
      box_status: boxed ? "located" : "uncertain",
      visibility: ["clear","partial","poor"].indexOf(r&&r.visibility) >= 0 ? r.visibility : "partial",
      truncated: (r && r.truncated) === true,
      confidence: num(r&&r.confidence),
      is_marking: ["marking_label","marking_stamp","marking_cast","logo","sticker"].indexOf(t) >= 0,
      why: (r && r.why != null) ? String(r.why).trim() : null
    };
  });
  var px = (p.closer_body_px_across!=null && Number.isFinite(Number(p.closer_body_px_across)))
    ? Math.max(0, Math.round(Number(p.closer_body_px_across))) : null;
  return {
    regions: out,
    located: out.filter(function(r){return r.box_status==="located";}).length,
    uncertain: out.filter(function(r){return r.box_status==="uncertain";}).length,
    marking_regions: out.filter(function(r){return r.is_marking;}).length,
    closer_body_px_across: px,
    regions_found: out.length,
    image_supports_localization: p.image_supports_localization !== false,
    limiting_factor: p.limiting_factor == null ? null : String(p.limiting_factor).trim()
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  try {
    const body = JSON.parse(event.body || "{}");
    const media_type = body.media_type;
    const imgs = (Array.isArray(body.images) && body.images.length) ? body.images.slice(0,5) : (body.image ? [body.image] : []);
    if (!imgs.length) return { statusCode: 400, body: JSON.stringify({ error: "no image" }) };
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { statusCode: 500, body: JSON.stringify({ error: "server missing ANTHROPIC_API_KEY" }) };
    // mode: "label_blind" -> physical construction only, text quarantined
    const labelBlind = body.mode === "label_blind";
    // mode: "marking_regions" -> locate markings, do not identify the product
    const markingMode = body.mode === "marking_regions";
    // mode: "hardware_regions" -> locate components, identify nothing
    const hardwareMode = body.mode === "hardware_regions";
    // focus_features present -> targeted feature pass instead of identification
    const focus = Array.isArray(body.focus_features) ? body.focus_features : null;
    const multi = imgs.length > 1
      ? "You are given " + imgs.length + " photographs of the SAME piece of hardware from a short sweep. Examine ALL of them together before answering. A stamp, label or distinguishing feature may be legible in only one frame; transcribe it from whichever frame shows it. Do not treat the frames as separate products. "
      : "";
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: labelBlind ? 2500 : (markingMode ? 1800 : (hardwareMode ? 2000 : 1200)),
        messages: [{ role: "user", content: [
          ...imgs.map(function(d){ return { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: d } }; }),
          { type: "text", text: hardwareMode ? HARDWARE_PROMPT
                                : markingMode ? MARKING_PROMPT
                                : (labelBlind ? (multi + PHYSICAL_PROMPT)
                                : (focus ? (multi + focusPrompt(focus)) : (multi + PROMPT))) }
        ]}]
      })
    });
    const responseText = await resp.text();
    let j;
    try {
      j = responseText ? JSON.parse(responseText) : {};
    } catch (_) {
      console.error("Anthropic returned non-JSON", {
        status: resp.status,
        body: responseText.slice(0, 1000)
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Anthropic returned an unreadable response", upstream_status: resp.status })
      };
    }

    if (!resp.ok) {
      const upstreamMessage = (j.error && j.error.message) || "Anthropic request failed";
      console.error("Anthropic API error", {
        status: resp.status,
        type: j.error && j.error.type,
        message: upstreamMessage
      });
      return {
        statusCode: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: upstreamMessage,
          upstream_status: resp.status,
          upstream_type: (j.error && j.error.type) || null
        })
      };
    }

    const txt = (j.content && j.content[0] && j.content[0].text) || "";
    const firstBrace = txt.indexOf("{");
    const lastBrace = txt.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      console.error("Anthropic response did not contain JSON", {
        stop_reason: j.stop_reason,
        response_preview: txt.slice(0, 500)
      });
      return {
        statusCode: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Recognition response did not contain valid JSON" })
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(txt.slice(firstBrace, lastBrace + 1));
    } catch (err) {
      console.error("Recognition JSON failed to parse", {
        stop_reason: j.stop_reason,
        response_preview: txt.slice(0, 500)
      });
      return {
        statusCode: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Recognition response was not valid JSON" })
      };
    }

    if (hardwareMode) {
      const out = normalizeHardwareRegions(parsed);
      console.log("Vision hardware-localization pass", {
        frames: imgs.length, regions: out.regions_found, located: out.located,
        uncertain: out.uncertain, markings: out.marking_regions,
        closer_px_across: out.closer_body_px_across
      });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }

    if (markingMode) {
      const out = normalizeMarkings(parsed);
      console.log("Vision marking-region pass", {
        frames: imgs.length,
        regions: out.regions_found,
        legible: out.legible_regions,
        limiting_factor: out.limiting_factor
      });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }

    if (labelBlind) {
      const out = normalizePhysical(parsed);
      console.log("Vision label-blind pass", {
        frames: imgs.length,
        observations: out.physical_observations.length,
        clear: out.physical_observations.filter((o) => o.visibility === "clear").length,
        estimated: out.physical_observations.filter((o) => o.estimated).length,
        mounting: out.mounting_configuration,
        cover_state: out.cover_state,
        scale_reference: out.scale_reference_present,
        text_quarantined: out.label_observations.text_seen.length
      });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }

    if (focus) {
      const feats = Array.isArray(parsed.observed_features) ? parsed.observed_features : [];
      const out = {
        observed_features: feats
          .filter((f) => f && f.field)
          .map((f) => ({
            field: String(f.field).trim(),
            visible: f.visible === true,
            value: (f.value == null || String(f.value).toLowerCase() === "null") ? null : String(f.value).trim(),
            note: f.note == null ? null : String(f.note).trim()
          })),
        measurements: (parsed.measurements && typeof parsed.measurements === "object") ? parsed.measurements : {},
        visible_text: Array.isArray(parsed.visible_text) ? parsed.visible_text.map((t) => String(t).trim()).filter(Boolean) : []
      };
      console.log("Vision focus pass", {
        frames: imgs.length,
        asked: focus.length,
        reported_visible: out.observed_features.filter((f) => f.visible).length,
        reported_not_visible: out.observed_features.filter((f) => !f.visible).length
      });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }

    const obj = normalizeResult(parsed);
    console.log("Vision result", {
      frames: imgs.length,
      component_class: obj.component_class,
      manufacturer: obj.manufacturer,
      series: obj.series,
      model: obj.model,
      visible_text_count: obj.visible_text.length,
      evidence_count: obj.evidence.length,
      confidence: obj.confidence,
      stop_reason: j.stop_reason
    });
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
  } catch (e) {
    console.error("Vision function error", {
      name: e && e.name,
      message: e && e.message
    });
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: (e && e.message) || String(e) })
    };
  }
};
