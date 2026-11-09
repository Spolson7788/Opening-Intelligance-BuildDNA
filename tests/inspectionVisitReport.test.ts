import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { NFPA80_ITEMS } from "../src/services/nfpa80Checklist";
import { orderVisitDoors, visitReportOutline, type VisitDoor } from "../src/services/inspectionVisits";
import { CONCEPT, drawablePhoto, generateNfpaVisitPdf, pdfRgb } from "../src/services/nfpa80Report";

function door(code: string, passed: boolean, note?: string): VisitDoor {
  return {
    openingId: code,
    openingCode: code,
    location: passed ? "Hall" : "Lobby",
    passed,
    notes: note ?? null,
    deficiencies: passed ? [] : [{ section: "5.2.4.2(1)", description: "The labels on the fire door and frame are in place and can be read.", note: note || "Label missing", photo: null }],
    checklist: NFPA80_ITEMS.map((item) => ({ section: item.section, result: passed || item.key !== "labels" ? "PASS" : "FAIL", note: null })),
  };
}

describe("combined fire door visit report", () => {
  it("puts failed doors before passed doors for a 50-door visit", async () => {
    const doors = Array.from({ length: 50 }, (_, index) => door(`D-${String(index + 1).padStart(2, "0")}`, index % 5 !== 0, `Note ${index + 1}`));
    const ordered = orderVisitDoors(doors);
    const firstPassed = ordered.findIndex((item) => item.passed);
    expect(ordered.slice(0, firstPassed).every((item) => !item.passed)).toBe(true);
    expect(ordered.slice(firstPassed).every((item) => item.passed)).toBe(true);
    const lines = visitReportOutline({
      facilityName: "North Clinic", eventDate: "2026-11-09", inspectorName: "Ada Inspector",
      qualification: "Fire door inspector", licenseNumber: "FD-100", doors,
    });
    const failedHeading = lines.indexOf("Failed doors");
    const detailsHeading = lines.indexOf("Door details");
    expect(failedHeading).toBeGreaterThan(-1);
    expect(detailsHeading).toBeGreaterThan(failedHeading);
    const failedSection = lines.slice(failedHeading + 1, detailsHeading);
    expect(failedSection).toContain("D-01");
    expect(failedSection).not.toContain("D-02");
    expect(lines.slice(detailsHeading)).toContain("D-02");
    expect(lines).toContain("Inspected 50");
    expect(lines).toContain("Failed 10");
    expect(lines).toContain("Passed 40");
    expect(lines).toContain("The labels on the fire door and frame are in place and can be read.");
    expect(lines).toContain("Photograph stored with this inspection");
    const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    expect(drawablePhoto(tiny)).toBeNull();
    expect(drawablePhoto(null)).toBeNull();
    const pdf = await generateNfpaVisitPdf({
      facilityName: "North Clinic", eventDate: "2026-11-09", inspectorName: "Ada Inspector",
      qualification: "Fire door inspector", licenseNumber: "FD-100", doors,
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
    const raw = pdf.toString("latin1");
    const streams = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) => {
      try { return inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"); } catch { return match[1]; }
    }).join("\n");
    const text = [...streams.matchAll(/<([0-9A-Fa-f]+)>/g)].map((match) => Buffer.from(match[1], "hex").toString("latin1")).join("");
    expect(streams).toContain(pdfRgb(CONCEPT.green));
    expect(streams).toContain(pdfRgb(CONCEPT.cyan));
    expect(streams).toContain(pdfRgb(CONCEPT.red));
    expect(text).toContain("Page 1 of");
    expect(text).toContain("North Clinic");
    expect(text).toContain("Failed doors");
    expect(text).toContain("Photograph stored with this inspection");
  });

  it("names a repeated door and shows a location only when one was recorded", async () => {
    const early = door("210A", false);
    early.location = "Lobby";
    early.inspectedAt = "2026-11-09T10:57:00.000Z";
    const later = door("210A", true);
    later.location = null;
    later.openingId = early.openingId;
    later.inspectedAt = "2026-11-09T12:07:00.000Z";
    const lines = visitReportOutline({
      facilityName: "North Clinic", eventDate: "2026-11-09", inspectorName: "Stephan Olson",
      qualification: "Fire door inspector", licenseNumber: "FD-100", doors: [later, early],
    });
    expect(lines).toContain("210A, inspection 1 of 2 at 10:57");
    expect(lines).toContain("210A, inspection 2 of 2 at 12:07");
    expect(lines).toContain("Lobby");
    expect(lines).not.toContain("Location not recorded");
    const pdf = await generateNfpaVisitPdf({
      facilityName: "North Clinic", eventDate: "2026-11-09", inspectorName: "Stephan Olson",
      qualification: "Fire door inspector", licenseNumber: "FD-100", doors: [later, early],
    });
    const raw = pdf.toString("latin1");
    const text = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].flatMap((match) => {
      try { return [inflateSync(Buffer.from(match[1], "latin1")).toString("latin1")]; } catch { return [match[1]]; }
    }).join("\n");
    const visible = [...text.matchAll(/<([0-9A-Fa-f]+)>/g)].map((match) => Buffer.from(match[1], "hex").toString("latin1")).join("");
    expect(visible).toContain("210A, inspection 1 of 2 at 10:57");
    expect(visible).toContain("Lobby");
    expect(visible).not.toContain("Location not recorded");
  });
});
