import { expect, it } from "vitest";
import request from "supertest";
import { pool } from "../src/db/pool";
import { app, signupTestOrg, createPortfolioHierarchy, createTestOpening } from "./helpers";
import { confirmedDimension } from "../field-app/src/lib/measurementSuggestions";
import type { MeasurementSuggestion } from "../field-app/src/lib/api";

const sample: MeasurementSuggestion = {
  field: "frame_width", inches: 72, confidence: 0.86, bounds: "Outer frame width along the top of the Measure card",
};

it("returns suggestions and does not write them until a person confirms", async () => {
  const previous = process.env.OI_MEASUREMENT_READER;
  process.env.OI_MEASUREMENT_READER = "mock";
  try {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const auth = { Authorization: `Bearer ${org.token}` };
    const frame = await request(app).put(`/api/openings/${opening.id}/frame`).set(auth).send({ material: "Hollow metal", width_in: 40 });
    expect(frame.status).toBe(200);
    const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set(auth).send({
      content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
    });
    expect(reading.status).toBe(200);
    expect(reading.body.written).toBe(false);
    expect(reading.body.provider).toBe("mock");
    expect(reading.body.suggestions.map((item: { field: string }) => item.field)).toContain("frame_width");
    const stored = await pool.query("SELECT width_in FROM opening_frames WHERE id=$1", [frame.body.id]);
    expect(Number(stored.rows[0].width_in)).toBe(40);
    expect(confirmedDimension(sample)).toEqual({ text: "6' 0\"", clear: false });
    expect(confirmedDimension(sample).text).not.toBe("");
  } finally {
    if (previous === undefined) delete process.env.OI_MEASUREMENT_READER;
    else process.env.OI_MEASUREMENT_READER = previous;
  }
});

it("refuses a live reader when no key is configured", async () => {
  const previous = process.env.OI_MEASUREMENT_READER;
  delete process.env.OI_MEASUREMENT_READER_API_KEY;
  delete process.env.OI_MEASUREMENT_READER_URL;
  process.env.OI_MEASUREMENT_READER = "openai";
  try {
    const org = await signupTestOrg();
    const { buildingId } = await createPortfolioHierarchy(org.token);
    const opening = await createTestOpening(org.token, buildingId);
    const reading = await request(app).post(`/api/openings/${opening.id}/measurement-reading`).set("Authorization", `Bearer ${org.token}`).send({
      content_type: "image/jpeg", image_base64: Buffer.from("measure-fixture").toString("base64"),
    });
    expect(reading.status).toBe(503);
    expect(reading.body.error).toBe("measurement_reader_unconfigured");
  } finally {
    if (previous === undefined) delete process.env.OI_MEASUREMENT_READER;
    else process.env.OI_MEASUREMENT_READER = previous;
  }
});
