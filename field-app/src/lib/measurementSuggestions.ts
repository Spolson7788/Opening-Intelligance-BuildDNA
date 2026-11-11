import type { MeasurementSuggestion } from "./api";
import { formatInches } from "./inchMeasure";
import type { DimensionDraft } from "./inchMeasure";

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
