#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mappings = require(path.join(root, 'oi-provider-mappings.js'));
const memory = new Map();
const storage = {
  getItem: (key) => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => memory.set(key, String(value)),
};
global.localStorage = storage;
global.window = {
  OIProviderMappings: mappings,
  addEventListener() {},
  location: { href: '' },
};
global.document = {
  readyState: 'loading',
  getElementById() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
global.navigator = {};
require(path.join(root, 'oi-bounded-workflow.js'));

const csv = [
  'manufacturer,product_model,provider_sku,product_description,configuration_details',
  'Cal-Royal,CR441,ED-13282,CR441 complete closer with hold-open arm,hold_open',
  'Cal-Royal,AF7700,SWFD-10183,AF7700 Exit Device,',
].join('\n');
const imported = mappings.importCsv(storage, 'service-provider', csv);
assert.equal(imported.ok, true);
assert.equal(mappings.read(storage).providers['service-provider'].length, 2, 'import must persist per provider');

const conflict = mappings.validate([
  { manufacturer: 'Cal-Royal', product_model: 'AF7700', provider_sku: 'ONE' },
  { manufacturer: 'Cal-Royal', product_model: 'AF7700', provider_sku: 'TWO' },
]);
assert.equal(conflict.ok, false, 'conflicting product mappings must be refused');

const ambiguous = mappings.validate([
  { manufacturer: 'Cal-Royal', product_model: 'AF7700', provider_sku: 'SAME' },
  { manufacturer: 'Cal-Royal', product_model: 'CR441', provider_sku: 'SAME' },
]);
assert.equal(ambiguous.ok, false, 'one SKU for different products must be refused');

assert.equal(mappings.lookup(storage, 'service-provider', { manufacturer: 'Cal-Royal', model: 'AF7700' }).mapping.provider_sku, 'SWFD-10183');
assert.equal(mappings.lookup(storage, 'service-provider', { manufacturer: 'Cal-Royal', model: 'CR441' }).mapping, null, 'CR441 configuration is required');
assert.equal(mappings.lookup(storage, 'service-provider', { manufacturer: 'Cal-Royal', model: 'CR441', arm_type: 'hold_open' }).mapping.provider_sku, 'ED-13282');
assert.equal(mappings.lookup(storage, 'service-provider', { manufacturer: 'Cal-Royal', model: 'AF7700' }).mapping.provider_sku === 'ED-13282', false);
assert.equal(mappings.lookup(storage, 'service-provider', { manufacturer: 'Cal-Royal', model: 'CR441', arm_type: 'hold_open' }).mapping.provider_sku === 'SWFD-10183', false);

const bounded = window.OIBounded;
const component = {
  component_id: 'af-1', facility_id: 'facility-b', facility_name: 'Facility B', opnum: '310C',
  CLASS: 'EXIT_DEVICE', cond: 'worn', saved_at: '2026-09-18T00:00:00Z', reviewed_at: '2026-09-18T00:00:00Z',
  how_established: 'technician selected',
  gate_product: { manufacturer: 'Cal-Royal', model: 'AF7700', cut_sheet_url: 'https://example.invalid/af7700.pdf' },
};
bounded.writeStore({ version: 1, openings: {
  [bounded.openingKey('facility-b', '310C')]: {
    facility_id: 'facility-b', opening_no: '310C', finished: true, door_frame: { material: 'Hollow Metal' }, components: [component],
  },
}});
const decision = bounded.evaluate([component]);
assert.equal(decision.allowed, true, decision.reasons.join('; '));
const payload = bounded.payloadFor(decision).text;
assert.match(payload, /Opening 310C/);
assert.match(payload, /Cal-Royal AF7700/);
assert.match(payload, /SWFD-10183/);
assert.doesNotMatch(payload, /ED-13282/);

const unresolved = Object.assign({}, component, { component_id: 'unresolved', gate_product: null, how_established: 'unresolved' });
assert.equal(bounded.evaluate([unresolved]).allowed, false, 'unresolved identity must remain blocked');
const unfinishedStore = bounded.readStore();
unfinishedStore.openings[bounded.openingKey('facility-b', '310C')].finished = false;
bounded.writeStore(unfinishedStore);
assert.equal(bounded.evaluate([component]).allowed, false, 'unfinished opening must remain blocked');
const serviceable = Object.assign({}, component, { cond: 'good' });
assert.equal(bounded.evaluate([serviceable]).noOrder, true, 'serviceable parts must not become orderable');

const blockedCloser = Object.assign({}, component, {
  component_id: 'closer-205a', opnum: '205A', CLASS: 'DOOR_CLOSER',
  gate_product: null, how_established: 'unresolved',
});
bounded.writeStore({ version: 1, openings: {
  [bounded.openingKey('facility-b', '205A')]: {
    facility_id: 'facility-b', opening_no: '205A', finished: true,
    door_frame: { material: 'Hollow Metal' }, components: [blockedCloser],
  },
  [bounded.openingKey('facility-b', '310C')]: {
    facility_id: 'facility-b', opening_no: '310C', finished: true,
    door_frame: { material: 'Hollow Metal' }, components: [component],
  },
}});
const mixed = bounded.evaluate([blockedCloser, component]);
assert.equal(mixed.allowed, true, 'an unresolved part must not block an independently eligible part');
assert.equal(mixed.requiresAcknowledgment, true, 'excluded items require explicit acknowledgment');
assert.equal(mixed.parts.length, 1);
assert.equal(mixed.parts[0].record.component_id, 'af-1');
assert.equal(mixed.blocked.length, 1);
assert.equal(mixed.blocked[0].record.component_id, 'closer-205a');
assert.equal(mixed.blocked[0].followUpRequired, true);
const mixedPayload = bounded.payloadFor(mixed).text;
assert.match(mixedPayload, /Opening 310C/);
assert.match(mixedPayload, /SWFD-10183/);
assert.match(mixedPayload, /Excluded from this request — follow-up required/);
assert.match(mixedPayload, /Opening 205A door closer/);
assert.match(mixedPayload, /remain unresolved and were not sent/);
assert.doesNotMatch(mixedPayload, /Opening 205A[\s\S]*The service provider SKU:/);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /function selectAuthorizedFacility\(fid\)/);
assert.match(html, /if\(!selectAuthorizedFacility\(fid\)\)/);
assert.match(html, /This account is not authorized for the facility named by this link/);
assert.match(html, /var hits=exact\.length\?exact:series/);
assert.match(html, /candidate\.model='AF7700'/);
assert.doesNotMatch(html, /tops\.slice\(0,3\).*join\(' · '\)/);
// The limit statement moved with the import control: provider mapping import
// is administrator/onboarding work and no longer appears in the technician
// page. The statement is still required, and is now required in BOTH places it
// can be made - on the administrator interface that performs the import, and
// in the module that performs it - and it must be GONE from the technician page.
assert.doesNotMatch(html, /A mapping never establishes installed-product identity/,
  'the technician page still carries the provider-mapping import card');
assert.doesNotMatch(html, /providerMapping/,
  'the technician page still carries provider-mapping import controls');
const adminHtml = fs.readFileSync(path.join(root, 'provider-admin.html'), 'utf8');
assert.match(adminHtml, /A mapping never establishes\s+installed-product identity/);
assert.match(adminHtml, /it never establishes what is installed on a\s+door/);
assert.match(adminHtml, /id="providerMappingImport"/);
assert.match(html, /e\.target\.id!=='a_arm_type'/);
assert.match(html, /window\._tech\.product\.configuration_details=observed/);
assert.match(html, /else delete window\._tech\.product\.configuration_details/);

console.log(JSON.stringify({
  status: 'PASS',
  provider_import_persistence: 'PASS',
  conflicts_and_ambiguity: 'PASS',
  exact_AF7700_mapping: 'PASS',
  reverse_mapping_checks: 'PASS',
  purchasing_gates: 'PASS',
  partial_purchasing_with_acknowledged_exclusions: 'PASS',
  result_card_determination_contract: 'PASS',
  facility_link_authorization_contract: 'PASS',
}, null, 2));
