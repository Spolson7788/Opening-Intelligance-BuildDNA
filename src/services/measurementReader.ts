export const MEASUREMENT_FIELDS = ["frame_width", "frame_height", "active_width", "active_height", "inactive_width", "inactive_height"] as const;
export type MeasurementField = typeof MEASUREMENT_FIELDS[number];

export type MeasurementSuggestion = {
  field: MeasurementField;
  inches: number;
  confidence: number;
  bounds: string;
};

export class MeasurementReaderError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "MeasurementReaderError";
    this.status = status;
  }
}

/** Sample Apple Measure style reading. Tests use this. It is not written to an opening. */
export const SAMPLE_MEASUREMENT_SUGGESTIONS: MeasurementSuggestion[] = [
  { field: "frame_width", inches: 72, confidence: 0.86, bounds: "Outer frame width along the top of the Measure card" },
  { field: "frame_height", inches: 96, confidence: 0.84, bounds: "Outer frame height along the left of the Measure card" },
  { field: "active_width", inches: 36, confidence: 0.8, bounds: "Active leaf width" },
  { field: "active_height", inches: 84, confidence: 0.81, bounds: "Active leaf height" },
  { field: "inactive_width", inches: 30, confidence: 0.62, bounds: "Inactive leaf width" },
  { field: "inactive_height", inches: 84, confidence: 0.7, bounds: "Inactive leaf height" },
];

export interface MeasurementProvider {
  name: string;
  read(image: { contentType: string; bytes: Buffer }): Promise<MeasurementSuggestion[]>;
}

const mockProvider: MeasurementProvider = {
  name: "mock",
  async read() { return SAMPLE_MEASUREMENT_SUGGESTIONS; },
};

function suggestionList(value: unknown): MeasurementSuggestion[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Partial<MeasurementSuggestion>;
    if (!item.field || !MEASUREMENT_FIELDS.includes(item.field)) return [];
    const inches = Number(item.inches);
    const confidence = Number(item.confidence);
    if (!Number.isFinite(inches) || inches <= 0 || !Number.isFinite(confidence)) return [];
    return [{ field: item.field, inches, confidence, bounds: String(item.bounds ?? "") }];
  });
}

function liveProvider(name: string): MeasurementProvider {
  return {
    name,
    async read(image) {
      const key = process.env.OI_MEASUREMENT_READER_API_KEY;
      const url = process.env.OI_MEASUREMENT_READER_URL;
      if (!key || !url) throw new MeasurementReaderError("measurement_reader_unconfigured");
      const model = process.env.OI_MEASUREMENT_READER_MODEL || "";
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          provider: name, model,
          content_type: image.contentType,
          image_base64: image.bytes.toString("base64"),
        }),
      });
      if (!response.ok) throw new MeasurementReaderError("measurement_reader_failed", 502);
      const body = await response.json() as { suggestions?: unknown };
      return suggestionList(body.suggestions);
    },
  };
}

export function measurementProvider(name = process.env.OI_MEASUREMENT_READER || ""): MeasurementProvider {
  if (name === "mock") return mockProvider;
  if (name === "openai" || name === "anthropic" || name === "gemini") return liveProvider(name);
  throw new MeasurementReaderError("measurement_reader_not_selected");
}
