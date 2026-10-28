import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALL_AREAS, areaOptions, defaultAreaFilter, filterFacilitiesByArea, sameArea } from '../field-app/src/lib/facilityArea';
import type { FacilityProperty } from '../field-app/src/lib/facilityOpenings';
// t97 item 1: the "California branch default" process. The picker starts on the tech's home
// area and is one tap from All authorized; filtering only narrows the authorized list.
const list: FacilityProperty[] = [
  { id: 'ca1', name: 'LA Plant', state: 'CA', service_territory: 'SoCal' },
  { id: 'ca2', name: 'SF Depot', state: 'ca ', service_territory: 'NorCal' },
  { id: 'fl1', name: 'Miami DC', state: 'FL', service_territory: 'South FL' },
  { id: 'nx', name: 'No state site', state: null },
];
describe('facility area filter', () => {
  it('defaults to the branch/home territory, then home state, else All', () => {
    expect(defaultAreaFilter({ home_territory: 'SoCal', home_state: 'FL' }, list)).toEqual({ kind: 'territory', value: 'SoCal' });
    expect(defaultAreaFilter({ home_state: 'ca' }, list)).toEqual({ kind: 'state', value: 'CA' });
    expect(defaultAreaFilter({ home_state: 'TX' }, list)).toEqual(ALL_AREAS);
    expect(defaultAreaFilter(null, list)).toEqual(ALL_AREAS);
    expect(defaultAreaFilter({ home_territory: 'Gone' }, list)).toEqual(ALL_AREAS);
  });
  it('a California tech sees CA first and Florida customers are one step away under All', () => {
    const ca = filterFacilitiesByArea(list, { kind: 'state', value: 'CA' });
    expect(ca.map(f => f.id)).toEqual(['ca1', 'ca2']);
    expect(filterFacilitiesByArea(list, ALL_AREAS).map(f => f.id)).toEqual(['ca1', 'ca2', 'fl1', 'nx']);
    expect(filterFacilitiesByArea(list, { kind: 'state', value: 'FL' }).map(f => f.id)).toEqual(['fl1']);
  });
  it('keeps the selected facility visible even outside the area, and never adds unauthorized ones', () => {
    expect(filterFacilitiesByArea(list, { kind: 'state', value: 'CA' }, 'fl1').map(f => f.id)).toEqual(['ca1', 'ca2', 'fl1']);
    expect(filterFacilitiesByArea(list, ALL_AREAS, 'not-authorized').length).toBe(list.length);
  });
  it('options come only from the authorized list', () => {
    expect(areaOptions(list)).toEqual({ states: ['CA', 'FL'], territories: ['NorCal', 'SoCal', 'South FL'] });
    expect(sameArea({ kind: 'state', value: 'CA' }, { kind: 'state', value: 'CA' })).toBe(true);
  });
  it('the picker offers All authorized, My Territory and State, plus a one-tap Show all button', () => {
    const src = readFileSync('field-app/src/components/FacilitySelector.tsx', 'utf8');
    expect(src).toContain('<option value="all">All authorized facilities</option>');
    expect(src).toContain('label="My Territory"');
    expect(src).toContain('label="State"');
    expect(src).toContain('onClick={() => s.setArea(ALL_AREAS)}>Show all authorized</button>');
    expect(src).toContain('filterFacilitiesByArea(properties, s.area, selectedId)');
    // Facilities still come from the server's authorized list; the filter is client-side narrowing only.
    expect(src).toContain('list = await listFieldProperties()');
  });
});
describe('public QR shows outsiders only facility and building', () => {
  it('server query and response carry no opening code', () => {
    const src = readFileSync('src/routes/publicQr.ts', 'utf8');
    expect(src).not.toContain('opening_code');
    expect(src).toContain('facility_name: row.facility_name, building_name: row.building_name,');
  });
  it('the landing page and client accept and render only the two names', () => {
    const lib = readFileSync('field-app/src/lib/qrLanding.ts', 'utf8');
    const page = readFileSync('field-app/src/pages/QrInformationPage.tsx', 'utf8');
    expect(lib).not.toContain('opening_code'); expect(page).not.toContain('opening_code');
    expect(page).toContain('<dt>Facility</dt>'); expect(page).toContain('<dt>Building</dt>');
  });
});
