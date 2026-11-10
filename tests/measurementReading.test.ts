import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import { pool } from "../src/db/pool";
import { createApp } from "../src/app";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { confirmedDimension } from "../field-app/src/lib/measurementSuggestions";
import type { MeasurementSuggestion } from "../field-app/src/lib/api";

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
