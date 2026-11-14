import { describe, expect, it } from "vitest";
import type { FacilityProperty } from "../field-app/src/lib/facilityOpenings";
import { chooseFacility, selectedFacilityKey } from "../field-app/src/lib/facilitySync";
import {
  confirmationKey, countiesFrom, describeLocation, facilitiesFrom, initialDraft, isDirectOpeningPath,
  homeAfterSignIn, narrowDraft, postAuthLanding, readLocationConfirmation, statesFrom, writeLocationConfirmation,
} from "../field-app/src/lib/locationChoice";
import { loginReturnPath } from "../field-app/src/lib/qrPayload";

const list: FacilityProperty[] = [
  { id: "a", name: "Alpha", state_code: "CA", state: "CA", state_name: "California", county_fips: "037", county_name: "Los Angeles" },
  { id: "b", name: "Beta", state_code: "CA", state: "CA", state_name: "California", county_fips: "073", county_name: "San Diego" },
  { id: "c", name: "Gamma", state_code: "NV", state: "NV", state_name: "Nevada", county_fips: "003", county_name: "Clark" },
  { id: "d", name: "Delta", state_code: null, state: null, state_name: null, county_fips: null, county_name: null },
];
const qr = "/opening/by-qr/11111111-1111-4111-8111-111111111111/details";

describe("location cascade", () => {
  it("keeps a facility that has no state or county", () => {
    expect(statesFrom(list).map((item) => item.label)).toEqual(["California", "Nevada", "State not set"]);
    expect(countiesFrom(list, "").map((item) => item.label)).toEqual(["County not set"]);
    expect(facilitiesFrom(list, "", "").map((item) => item.id)).toEqual(["d"]);
    expect(describeLocation(list, "d")).toBe("Delta — State not set, County not set");
  });
  it("auto-selects the only state, county, and facility, and resets the county when the state changes", () => {
    const only = [list[0]];
    expect(initialDraft(only, null)).toEqual({ stateKey: "CA", countyKey: "037", facilityId: "a" });
    const many = initialDraft(list, null);
    expect(many.facilityId).toBe("");
    const california = narrowDraft(list, { ...many, stateKey: "CA" }, "state");
    expect(california.countyKey).toBeNull();
    expect(california.facilityId).toBe("");
    const county = narrowDraft(list, { ...california, countyKey: "037" }, "county");
    expect(county.facilityId).toBe("a");
    const moved = narrowDraft(list, { ...county, stateKey: null }, "state");
    expect(moved).toEqual({ stateKey: null, countyKey: null, facilityId: "" });
  });
  it("shows the last authorized facility and ignores an id from another company", () => {
    expect(initialDraft(list, "c")).toMatchObject({ stateKey: "NV", facilityId: "c" });
    expect(initialDraft(list, "other-company").facilityId).toBe("");
    expect(chooseFacility(list, "other-company")).toBeNull();
    expect(selectedFacilityKey({ userId: "tech", organizationId: "org-a" })).not.toBe(selectedFacilityKey({ userId: "tech", organizationId: "org-b" }));
    expect(confirmationKey({ userId: "tech", organizationId: "org-a" })).not.toBe(confirmationKey({ userId: "other", organizationId: "org-a" }));
  });
});

describe("sign-in landing", () => {
  it("sends a normal landing to the chooser and keeps an explicit door target", () => {
    expect(postAuthLanding(undefined, false)).toBe("/choose-location");
    expect(postAuthLanding("/scan", false)).toBe("/choose-location");
    expect(postAuthLanding("/scan", true)).toBe("/scan");
    expect(postAuthLanding(qr, false)).toBe(qr);
    expect(isDirectOpeningPath(qr)).toBe(true);
    expect(postAuthLanding("//evil.example", false)).toBe("/choose-location");
    expect(loginReturnPath("//evil.example")).toBe("/scan");
    expect(postAuthLanding("/opening/test?next=//evil", false)).toBe("/choose-location");
    expect(homeAfterSignIn(true, undefined, false)).toBe("/tasks/day");
    expect(homeAfterSignIn(true, "/choose-location", true)).toBe("/tasks/day");
    expect(homeAfterSignIn(true, "/scan", false)).toBe("/tasks/day");
    expect(homeAfterSignIn(true, qr, false)).toBe(qr);
  });
  it("does not treat another account's confirmation as this account's", () => {
    const storage = new Map<string, string>();
    const memory = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: () => {} } as Storage;
    const tech = { userId: "tech", organizationId: "org-a" };
    writeLocationConfirmation(memory, tech, "a");
    expect(readLocationConfirmation(memory, tech)).toBe("a");
    expect(readLocationConfirmation(memory, { userId: "tech", organizationId: "org-b" })).toBeNull();
  });
});
