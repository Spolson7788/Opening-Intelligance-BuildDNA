import { describe, it, expect } from "vitest";
import { toCsv } from "../src/services/csv";

describe("toCsv", () => {
  it("produces a header row and one line per record", () => {
    const csv = toCsv([{ a: "1", b: "2" }, { a: "3", b: "4" }], ["a", "b"]);
    expect(csv).toBe("a,b\n1,2\n3,4");
  });

  it("quotes fields containing a comma", () => {
    const csv = toCsv([{ name: "Smith, John" }], ["name"]);
    expect(csv).toContain('"Smith, John"');
  });

  it("quotes fields containing a newline", () => {
    const csv = toCsv([{ notes: "line one\nline two" }], ["notes"]);
    expect(csv).toContain('"line one\nline two"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    const csv = toCsv([{ notes: 'She said "hello"' }], ["notes"]);
    expect(csv).toContain('"She said ""hello"""');
  });

  it("renders null/undefined as an empty field, not the literal word", () => {
    const csv = toCsv([{ a: null, b: undefined }], ["a", "b"]);
    expect(csv).toBe("a,b\n,");
  });

  it("does not quote plain fields unnecessarily", () => {
    const csv = toCsv([{ code: "AZ-PHX-0001" }], ["code"]);
    expect(csv).toContain("AZ-PHX-0001");
    expect(csv).not.toContain('"AZ-PHX-0001"');
  });
});
