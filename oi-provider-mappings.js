/* Provider catalog mappings enrich purchasing only. They never identify hardware. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OIProviderMappings = Object.freeze(api);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const STORE_KEY = 'oi_provider_mappings_v1';
  const VERSION = 1;
  function text(value) { return String(value == null ? '' : value).trim(); }
  function key(value) { return text(value).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function productKey(row) { return key(row.manufacturer) + '::' + key(row.product_model); }

  function parseCsv(input) {
    const rows = []; let row = [], cell = '', quoted = false;
    const source = String(input || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '"' && quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
      else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        row.push(cell); cell = '';
        if (row.some((value) => text(value))) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell); if (row.some((value) => text(value))) rows.push(row);
    if (!rows.length) return [];
    const headers = rows.shift().map((value) => key(value));
    const aliases = {
      manufacturer: ['manufacturer'], product_model: ['productmodel', 'model'],
      provider_sku: ['providersku', 'sku'],
      product_description: ['manufacturersuppliedproductdescription', 'productdescription', 'description'],
      configuration_details: ['configurationdetails', 'configuration'],
    };
    return rows.map((values) => {
      const out = {};
      Object.keys(aliases).forEach((field) => {
        const index = headers.findIndex((header) => aliases[field].includes(header));
        out[field] = index >= 0 ? text(values[index]) : '';
      });
      return out;
    });
  }

  function validate(rows) {
    const errors = [], products = new Map(), skus = new Map(), clean = [];
    (rows || []).forEach((source, index) => {
      const row = {
        manufacturer: text(source.manufacturer), product_model: text(source.product_model),
        provider_sku: text(source.provider_sku), product_description: text(source.product_description),
        configuration_details: text(source.configuration_details),
      };
      const label = 'Row ' + (index + 2);
      ['manufacturer', 'product_model', 'provider_sku'].forEach((field) => {
        if (!row[field]) errors.push(label + ': ' + field.replace(/_/g, ' ') + ' is required');
      });
      if (!row.manufacturer || !row.product_model || !row.provider_sku) return;
      const pk = productKey(row), sk = key(row.provider_sku);
      if (products.has(pk) && key(products.get(pk).provider_sku) !== sk) errors.push(label + ': conflicting SKUs for ' + row.manufacturer + ' ' + row.product_model);
      if (skus.has(sk) && productKey(skus.get(sk)) !== pk) errors.push(label + ': provider SKU is ambiguous across different products');
      products.set(pk, row); skus.set(sk, row); clean.push(row);
    });
    if (!clean.length) errors.push('No valid mapping rows were supplied.');
    return { ok: errors.length === 0, errors: Array.from(new Set(errors)), rows: clean };
  }

  function read(storage) {
    try {
      const value = JSON.parse(storage.getItem(STORE_KEY) || 'null');
      return value && value.version === VERSION && value.providers ? value : { version: VERSION, providers: {} };
    } catch (_) { return { version: VERSION, providers: {} }; }
  }
  function importCsv(storage, providerId, csv) {
    const checked = validate(parseCsv(csv));
    if (!checked.ok) return checked;
    const store = read(storage);
    store.providers[text(providerId) || 'service-provider'] = checked.rows;
    storage.setItem(STORE_KEY, JSON.stringify(store));
    return { ok: true, errors: [], rows: checked.rows };
  }
  function lookup(storage, providerId, product) {
    const store = read(storage);
    const rows = store.providers[text(providerId) || 'service-provider'] || [];
    const pk = key(product && product.manufacturer) + '::' + key(product && product.model);
    const matches = rows.filter((row) => productKey(row) === pk);
    if (matches.length !== 1) return { mapping: null, reason: matches.length ? 'ambiguous provider mapping' : 'no provider mapping' };
    const mapping = matches[0];
    if (mapping.configuration_details) {
      const actual = key(product && (product.configuration_details || product.configuration || product.arm_type));
      if (!actual || actual !== key(mapping.configuration_details)) return { mapping: null, reason: 'configuration details do not match' };
    }
    return { mapping: Object.assign({}, mapping), reason: null };
  }
  return { STORE_KEY, parseCsv, validate, read, importCsv, lookup, productKey };
});
