import type { MeasurementSuggestion } from "./api";
import { formatInches, parseInches } from "./inchMeasure";
import type { DimensionDraft } from "./inchMeasure";

export const MEASUREMENT_MIN_INCHES = 12;
export const MEASUREMENT_MAX_INCHES = 240;

export type MeasurementDraft = {
  id: string;
  field: MeasurementSuggestion["field"];
  text: string;
  included: boolean;
  readInches: number | null;
  confidence: number | null;
  bounds: string;
};

export type AcceptedMeasurement = {
  field: MeasurementSuggestion["field"];
  inches: number;
  source: "photo" | "edited" | "manual";
};

/** 3' 11", 47, 47in, 8', and 96 are inches. A trailing inch word is optional. */
export function parseEditedInches(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const stripped = String(raw).trim().replace(/\s*(?:inches|inch|in)\.?$/i, "");
  return parseInches(stripped);
}

export function measurementTargets(configuration: "single" | "pair"): MeasurementSuggestion["field"][] {
  const frame = ["frame_width", "frame_height"] as const;
  return configuration === "pair"
    ? [...frame, "active_width", "active_height", "inactive_width", "inactive_height"]
    : [...frame, "active_width", "active_height"];
}

export function targetLabel(field: MeasurementSuggestion["field"], configuration: "single" | "pair"): string {
  if (configuration === "single" && field === "active_width") return "Leaf width";
  if (configuration === "single" && field === "active_height") return "Leaf height";
  return suggestionLabel(field);
}

export function defaultMeasurementTarget(field: MeasurementSuggestion["field"], configuration: "single" | "pair"): MeasurementSuggestion["field"] {
  if (configuration === "pair" || !field.startsWith("inactive_")) return field;
  return field.replace("inactive_", "active_") as MeasurementSuggestion["field"];
}

export function draftSource(draft: MeasurementDraft): "photo" | "edited" | "manual" {
  if (draft.readInches == null) return "manual";
  const inches = parseEditedInches(draft.text);
  if (inches == null || Math.abs(inches - draft.readInches) > 0.01) return "edited";
  return "photo";
}

export function draftsFromSuggestions(suggestions: MeasurementSuggestion[], configuration: "single" | "pair", id: () => string): MeasurementDraft[] {
  return suggestions.map((suggestion) => ({
    id: id(),
    field: defaultMeasurementTarget(suggestion.field, configuration),
    text: formatInches(suggestion.inches),
    included: true,
    readInches: suggestion.inches,
    confidence: suggestion.confidence,
    bounds: suggestion.bounds,
  }));
}

export function validateMeasurementDrafts(drafts: MeasurementDraft[], configuration: "single" | "pair"): { ok: true; accepted: AcceptedMeasurement[] } | { ok: false; problems: string[] } {
  const included = drafts.filter((draft) => draft.included);
  if (!included.length) return { ok: false, problems: ["Choose at least one size to save."] };
  const allowed = new Set(measurementTargets(configuration));
  const seen = new Set<string>();
  const problems: string[] = [];
  const accepted: AcceptedMeasurement[] = [];
  for (const draft of included) {
    const field = defaultMeasurementTarget(draft.field, configuration);
    const label = targetLabel(field, configuration);
    if (!allowed.has(field)) {
      problems.push(`${label} is not a size on this opening.`);
      continue;
    }
    const inches = parseEditedInches(draft.text);
    if (inches == null || inches <= 0) problems.push(`${label} could not be read. Use feet and inches, such as 3' 11\", or a number of inches.`);
    else if (inches < MEASUREMENT_MIN_INCHES || inches > MEASUREMENT_MAX_INCHES) problems.push(`${label} must be between ${MEASUREMENT_MIN_INCHES} and ${MEASUREMENT_MAX_INCHES} inches.`);
    else if (seen.has(field)) problems.push(`${label} is selected more than once.`);
    else {
      seen.add(field);
      accepted.push({ field, inches, source: draftSource(draft) });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, accepted };
}

export type MeasurementSaveGroup = {
  kind: "opening_frame" | "door_leaf";
  role: string | null;
  width_in?: number;
  height_in?: number;
  lines: string[];
};

export function planMeasurementSave(accepted: AcceptedMeasurement[], configuration: "single" | "pair"): MeasurementSaveGroup[] {
  const groups = new Map<string, MeasurementSaveGroup>();
  for (const row of accepted) {
    const frame = row.field === "frame_width" || row.field === "frame_height";
    const role = frame ? null : configuration === "pair" ? (row.field.startsWith("inactive_") ? "inactive" : "active") : "single";
    const key = frame ? "frame" : `leaf:${role}`;
    const group = groups.get(key) ?? { kind: frame ? "opening_frame" : "door_leaf", role, lines: [] };
    const dimension = row.field.endsWith("height") ? "height_in" : "width_in";
    group[dimension] = row.inches;
    const origin = row.source === "photo" ? "from the measurement photo" : row.source === "edited" ? "edited" : "added";
    group.lines.push(`${targetLabel(row.field, configuration)} ${formatInches(row.inches)} ${origin}.`);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function suggestionLabel(field: MeasurementSuggestion["field"]): string {
  switch (field) {
    case "frame_width": return "Frame width";
    case "frame_height": return "Frame height";
    case "active_width": return "Active leaf width";
    case "active_height": return "Active leaf height";
    case "inactive_width": return "Inactive leaf width";
    case "inactive_height": return "Inactive leaf height";
  }
}

export function confirmedDimension(suggestion: MeasurementSuggestion): DimensionDraft {
  return { text: formatInches(suggestion.inches), clear: false };
}

export function measurementErrorCode(error: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "measurement_offline";
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "measurement_reader_timeout";
  if (error instanceof TypeError) return "measurement_network";
  if (error && typeof error === "object" && "status" in error && "message" in error) {
    const status = Number((error as { status: unknown }).status);
    const message = String((error as { message: unknown }).message || "");
    if (status === 413 || message === "media_too_large") return "measurement_image_too_large";
    if (message === "unexpected_response" || message === "site_access_required") return "measurement_network";
    if (message) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "measurement_reader_failed";
}

export function measurementReadPresentation(code: string): { message: string; code: string; empty: boolean } {
  if (code === "measurement_none_found") {
    return { empty: true, code, message: "No measurements were found in this photo. Use an Apple Measure screenshot that shows the numbers." };
  }
  if (code === "measurement_offline") {
    return { empty: false, code, message: "Reading a measurement photo needs a connection. The photo can still be saved on this phone." };
  }
  if (code === "measurement_reader_not_selected" || code === "measurement_reader_unconfigured" || code === "feature_disabled") {
    return { empty: false, code, message: "The measurement reader is not available on this site. The opening was not changed." };
  }
  if (code === "measurement_reader_timeout") {
    return { empty: false, code, message: "Reading the measurement photo timed out. The opening was not changed." };
  }
  if (code === "measurement_reader_auth") {
    return { empty: false, code, message: "The measurement reader's key isn't working on this site. The opening was not changed." };
  }
  if (code === "measurement_reader_rate_limited" || code === "measurement_reader_overloaded") {
    return { empty: false, code, message: "The measurement reader is busy. Try again in a minute. The opening was not changed." };
  }
  if (code === "measurement_reader_rejected") {
    return { empty: false, code, message: "The measurement reader rejected this photo. The opening was not changed." };
  }
  if (code === "measurement_network") {
    return { empty: false, code, message: "The measurement photo could not be sent. Check the connection and try again. The opening was not changed." };
  }
  if (code === "measurement_image_unreadable" || code === "unreadable_image" || code === "measurement_image_type" || code === "measurement_image_too_large") {
    return { empty: false, code, message: "This photo could not be prepared for reading. Choose a saved screenshot or take another photo. The opening was not changed." };
  }
  return { empty: false, code: code || "measurement_reader_failed", message: "The measurement reader could not use this photo. The opening was not changed." };
}
