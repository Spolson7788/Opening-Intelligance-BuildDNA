import { describe, expect, it } from "vitest";
import { NFPA80_ITEMS } from "../src/services/nfpa80Checklist";
import { orderVisitDoors, visitReportOutline, type VisitDoor } from "../src/services/inspectionVisits";
import { generateNfpaVisitPdf } from "../src/services/nfpa80Report";

function door(code: string, passed: boolean, note?: string): VisitDoor {
  return {
    openingCode: code,
    location: passed ? "Hall" : "Lobby",
    passed,
    notes: note ?? null,
    deficiencies: passed ? [] : [{ section: "5.2.4.2(1)", note: note || "Label missing", photo: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") }],
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
    const pdf = await generateNfpaVisitPdf({
      facilityName: "North Clinic", eventDate: "2026-11-09", inspectorName: "Ada Inspector",
      qualification: "Fire door inspector", licenseNumber: "FD-100", doors,
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
