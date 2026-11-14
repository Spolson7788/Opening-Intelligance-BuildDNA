import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import { pool } from "../src/db/pool";
import { createApp } from "../src/app";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { confirmedDimension, measurementReadPresentation } from "../field-app/src/lib/measurementSuggestions";
import type { MeasurementSuggestion } from "../field-app/src/lib/api";
import { parseInches } from "../src/lib/inchMeasure";

const measurePair = readFileSync(new URL("./fixtures/apple-measure-pair-3ft11-8ft.jpg", import.meta.url));

const sample: MeasurementSuggestion = {
  field: "frame_width", inches: 72, confidence: 0.86, bounds: "Outer frame width along the top of the Measure card",
};

const saved = {
  reader: process.env.OI_MEASUREMENT_READER,
  recognition: process.env.OI_RECOGNITION_ENABLED,
  key: process.env.ANTHROPIC_API_KEY,
  model: process.env.OI_MEASUREMENT_READER_MODEL,
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.reader === undefined) delete process.env.OI_MEASUREMENT_READER;
  else process.env.OI_MEASUREMENT_READER = saved.reader;
  if (saved.recognition === undefined) delete process.env.OI_RECOGNITION_ENABLED;
  else process.env.OI_RECOGNITION_ENABLED = saved.recognition;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.model === undefined) delete process.env.OI_MEASUREMENT_READER_MODEL;
  else process.env.OI_MEASUREMENT_READER_MODEL = saved.model;
});

async function openingWithFrame() {
  const org = await signupTestOrg();
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const opening = await createTestOpening(org.token, buildingId);
  const auth = { Authorization: `Bearer ${org.token}` };
  const frame = await request(app).put(`/api/openings/${opening.id}/frame`).set(auth).send({ material: "Hollow metal", width_in: 40 });
  expect(frame.status).toBe(200);
  return { opening, auth, frameId: frame.body.id as string };
}

function anthropicResponse(text: string, status = 200) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status, headers: { "content-type": "application/json" } });
}

it("returns mock suggestions and does not write them until a person confirms", async () => {
  process.env.OI_MEASUREMENT_READER = "mock";
  const { opening, auth, frameId } = await openingWithFrame();
  const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
  });
  expect(reading.status).toBe(200);
  expect(reading.body.written).toBe(false);
  expect(reading.body.provider).toBe("mock");
  expect(reading.body.suggestions.map((item: { field: string }) => item.field)).toContain("frame_width");
  const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frameId]);
  expect(Number(stored.rows[0].width_in)).toBe(40);
  expect(confirmedDimension(sample)).toEqual({ text: "6' 0\"", clear: false });
});

it("reads a Claude messages response into suggestions and does not write them", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-not-real");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    return anthropicResponse(JSON.stringify({ dimensions: [{ label: "6' 0\"", inches: 72, edge: "frame width", confidence: 0.86 }] }));
  });
  const { opening, auth, frameId } = await openingWithFrame();
  vi.stubGlobal("fetch", fetchMock);
  const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
  });
  expect(reading.status).toBe(200);
  expect(reading.body.written).toBe(false);
  expect(reading.body.suggestions).toEqual([
    { field: "frame_width", inches: 72, confidence: 0.86, bounds: "frame width: 6' 0\"" },
  ]);
  expect(fetchMock).toHaveBeenCalledOnce();
  const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frameId]);
  expect(Number(stored.rows[0].width_in)).toBe(40);
});

it("returns no suggestions when Claude's text is not JSON and does not write", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  const { opening, auth, frameId } = await openingWithFrame();
  vi.stubGlobal("fetch", vi.fn(async () => anthropicResponse("I see a door about six feet wide.")));
  const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
  });
  expect(reading.status).toBe(502);
  expect(reading.body.error).toBe("measurement_response_unreadable");
  expect(reading.body.suggestions).toBeUndefined();
  const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frameId]);
  expect(Number(stored.rows[0].width_in)).toBe(40);
});

it("does not call Claude when the recognition key is missing", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  delete process.env.ANTHROPIC_API_KEY;
  const { opening, auth, frameId } = await openingWithFrame();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
  });
  expect(reading.status).toBe(503);
  expect(reading.body.error).toBe("measurement_reader_unconfigured");
  expect(fetchMock).not.toHaveBeenCalled();
  const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frameId]);
  expect(Number(stored.rows[0].width_in)).toBe(40);
});

it("stays off when recognition features are disabled", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  const disabled = createApp({ recognitionFeaturesEnabled: false });
  const org = await signupTestOrg();
  const { buildingId } = await createPortfolioHierarchy(org.token);
  const opening = await createTestOpening(org.token, buildingId);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const reading = await request(disabled).post(`/api/openings/${opening.id}/measurement-reading`).set("Authorization", `Bearer ${org.token}`).send({
    content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
  });
  expect(reading.status).toBe(404);
  expect(reading.body.error).toBe("feature_disabled");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("reads the saved Apple Measure pair screenshot as overall width and height", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  expect(parseInches("3' 11\"")).toBe(47);
  expect(parseInches("8'")).toBe(96);
  const fetchMock = vi.fn(async () => anthropicResponse(JSON.stringify({
    dimensions: [
      { label: "3' 11\"", inches: 47, edge: "frame width", confidence: 0.91 },
      { label: "8'", inches: 96, edge: "frame height", confidence: 0.9 },
    ],
  })));
  const { opening, auth, frameId } = await openingWithFrame();
  vi.stubGlobal("fetch", fetchMock);
  const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: measurePair.toString("base64"),
  });
  expect(reading.status).toBe(200);
  expect(reading.body.written).toBe(false);
  expect(reading.body.suggestions).toEqual([
    { field: "frame_width", inches: 47, confidence: 0.91, bounds: "frame width: 3' 11\"" },
    { field: "frame_height", inches: 96, confidence: 0.9, bounds: "frame height: 8'" },
  ]);
  expect(confirmedDimension(reading.body.suggestions[0])).toEqual({ text: "3' 11\"", clear: false });
  expect(confirmedDimension(reading.body.suggestions[1])).toEqual({ text: "8' 0\"", clear: false });
  const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frameId]);
  expect(Number(stored.rows[0].width_in)).toBe(40);
});

it("treats a photo with no measurement labels as an empty reading", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  const { opening, auth, frameId } = await openingWithFrame();
  vi.stubGlobal("fetch", vi.fn(async () => anthropicResponse("This photo has no measurement labels.")));
  const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("plain-opening").toString("base64"),
  });
  expect(reading.status).toBe(200);
  expect(reading.body.suggestions).toEqual([]);
  expect(reading.body.written).toBe(false);
  expect(measurementReadPresentation("measurement_none_found")).toEqual({
    empty: true,
    code: "measurement_none_found",
    message: "No measurements were found in this photo. Use an Apple Measure screenshot that shows the numbers.",
  });
  const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frameId]);
  expect(Number(stored.rows[0].width_in)).toBe(40);
});

it("names a timeout, a provider failure, and an unsupported image type", async () => {
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  const { opening, auth } = await openingWithFrame();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
  const timedOut = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("plain-opening").toString("base64"),
  });
  expect(timedOut.status).toBe(504);
  expect(timedOut.body.error).toBe("measurement_reader_timeout");
  expect(measurementReadPresentation("measurement_reader_timeout").message).toContain("timed out");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad image" } }), { status: 400 })));
  const provider = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: Buffer.from("plain-opening").toString("base64"),
  });
  expect(provider.status).toBe(502);
  expect(provider.body.error).toBe("measurement_reader_rejected");
  expect(measurementReadPresentation("measurement_reader_rejected").message).toContain("rejected this photo");
  expect(measurementReadPresentation("measurement_reader_failed").code).toBe("measurement_reader_failed");
  const heic = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/heic", image_base64: Buffer.from("plain-opening").toString("base64"),
  });
  expect(heic.status).toBe(400);
  expect(heic.body.error).toBe("measurement_image_type");
  expect(measurementReadPresentation("measurement_reader_unconfigured").message).toContain("not available");
  expect(measurementReadPresentation("measurement_network").message).toContain("could not be sent");
});

it("logs Anthropic failures with a distinct code and never the key", async () => {
  const secret = "sk-ant-test-key-must-not-appear";
  process.env.OI_MEASUREMENT_READER = "anthropic";
  process.env.OI_RECOGNITION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = secret;
  const { opening, auth } = await openingWithFrame();
  const image = Buffer.from("plain-opening");
  const logs: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => { logs.push(String(line)); });
  const cases = [
    { status: 401, type: "authentication_error", message: `invalid x-api-key ${secret}`, code: "measurement_reader_auth", phrase: "isn't working" },
    { status: 429, type: "rate_limit_error", message: "rate limited", code: "measurement_reader_rate_limited", phrase: "busy" },
    { status: 529, type: "overloaded_error", message: "overloaded", code: "measurement_reader_overloaded", phrase: "busy" },
    { status: 400, type: "invalid_request_error", message: "image was rejected", code: "measurement_reader_rejected", phrase: "rejected this photo" },
  ];
  for (const item of cases) {
    logs.length = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: item.type, message: item.message } }), {
      status: item.status,
      headers: { "content-type": "application/json", "request-id": `req_${item.status}` },
    })));
    const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
      content_type: "image/jpeg", image_base64: image.toString("base64"),
    });
    expect(reading.status).toBe(502);
    expect(reading.body.error).toBe(item.code);
    expect(measurementReadPresentation(item.code).message).toContain(item.phrase);
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]);
    expect(line).toMatchObject({
      event: "measurement_reader_anthropic",
      status: item.status,
      errorType: item.type,
      requestId: `req_${item.status}`,
      model: "claude-sonnet-4-5-20250929",
      imageBytes: image.length,
      mediaType: "image/jpeg",
    });
    expect(line.errorMessage).not.toContain(secret);
    expect(line.errorMessage.length).toBeLessThanOrEqual(300);
    expect(typeof line.durationMs).toBe("number");
    expect(Object.keys(line).sort()).toEqual(["durationMs", "errorMessage", "errorType", "event", "imageBytes", "mediaType", "model", "requestId", "status"]);
    expect(logs[0]).not.toContain(secret);
    expect(logs[0]).not.toContain(image.toString("base64"));
  }
  logs.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not json</html>", {
    status: 200,
    headers: { "content-type": "text/html", "request-id": "req_html" },
  })));
  const unreadable = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
    content_type: "image/jpeg", image_base64: image.toString("base64"),
  });
  expect(unreadable.status).toBe(502);
  expect(unreadable.body.error).toBe("measurement_reader_failed");
  expect(logs).toHaveLength(1);
  const unreadableLine = JSON.parse(logs[0]);
  expect(unreadableLine.status).toBe(200);
  expect(unreadableLine.errorType).toBe("");
  expect(unreadableLine.requestId).toBe("req_html");
  expect(logs[0]).not.toContain(secret);
  expect(logs[0]).not.toContain("<html>");
  spy.mockRestore();
});
