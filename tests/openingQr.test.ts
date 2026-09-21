import {afterEach,describe,expect,it,vi} from "vitest";
import {openingQrUrl} from "../src/services/openingQr";
afterEach(()=>vi.unstubAllEnvs());
describe("canonical QR destination",()=>{
 it("preserves the configured app path and encodes token",()=>{vi.stubEnv("OI_FIELD_APP_URL","https://staging.example.test/field");expect(openingQrUrl("a/b")).toBe("https://staging.example.test/field/opening/by-qr/a%2Fb");});
 it("refuses missing configuration",()=>{vi.stubEnv("OI_FIELD_APP_URL","");expect(()=>openingQrUrl("a")).toThrow("field_app_url_not_configured");});
 it.each(["http://example.test/","https://user:password@example.test/","https://example.test/?q=1","https://example.test/#a"])("refuses unsafe base %s",base=>{vi.stubEnv("OI_FIELD_APP_URL",base);expect(()=>openingQrUrl("a")).toThrow();});
});
