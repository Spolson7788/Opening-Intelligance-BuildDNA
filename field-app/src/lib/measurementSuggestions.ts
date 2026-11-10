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
