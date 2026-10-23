import { describe, expect, it } from "vitest";
import { parseOpeningQr, loginReturnPath } from "../field-app/src/lib/qrPayload";
const token = '11111111-1111-4111-8111-111111111111';
const base = 'https://candidate.example.test/field/';
describe('canonical scan and login return', () => {
  it('preserves canonical and bare legacy tokens', () => {
    expect(parseOpeningQr(base+'opening/by-qr/'+token, base)).toBe(token);
    expect(parseOpeningQr(token, base)).toBe(token);
    expect(loginReturnPath('/opening/by-qr/'+token)).toBe('/opening/by-qr/'+token);
  });
  it.each([`https://unrelated.test/field/opening/by-qr/${token}`, `${base}scan/${token}`, `${base}opening/by-qr/${token}?x=1`, `${base}opening/by-qr/${token}#x`, `${base}opening/by-qr/${token}/`, `https://user@candidate.example.test/field/opening/by-qr/${token}`, `${base}opening/by-qr/%2f${token}`, 'not-a-label'])('rejects unsupported payload %s', value => {
    expect(parseOpeningQr(value, base)).toBeNull();
  });
  it.each(['//unrelated.test','/\\unrelated.test','https://unrelated.test','/login','/scan\n','/scan?return=//unrelated.test'])('rejects unsafe return %s', value => {
    expect(loginReturnPath(value)).toBe('/scan');
  });
});
