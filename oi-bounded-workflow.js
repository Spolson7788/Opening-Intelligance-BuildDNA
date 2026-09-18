/* Opening Intelligence bounded facility/opening workflow and purchasing gates.
 * This file adds product behavior, not a demonstration overlay. It never
 * changes recognition and it never dispatches before an explicit review step.
 */
(function () {
  'use strict';

  const STORE_KEY = 'oi_bounded_workflow_v1';
  const VERSION = 1;

  function readStore() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (value && value.version === VERSION && value.openings) return value;
    } catch (_) {}
    return { version: VERSION, openings: {} };
  }

  function writeStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function activeFacility() {
    if (window.OI_ACTIVE_FACILITY && window.OI_ACTIVE_FACILITY.id) {
      return Object.assign({}, window.OI_ACTIVE_FACILITY);
    }
    const select = document.getElementById('facSel');
    const option = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    return option && option.value ? { id: option.value, name: option.textContent } : null;
  }

  function openingNumber() {
    const input = document.getElementById('opnum');
    return input ? String(input.value || '').trim() : '';
  }

  function openingKey(facilityId, number) {
    return encodeURIComponent(facilityId) + '::' + encodeURIComponent(number);
  }

  function getOpening(facilityId, number, create) {
    const store = readStore();
    const key = openingKey(facilityId, number);
    let opening = store.openings[key];
    if (!opening && create) {
      opening = {
        id: 'local-opening-' + Math.random().toString(16).slice(2) + '-' + Date.now(),
        facility_id: facilityId,
        opening_no: number,
        area: '',
        components: [],
        door_frame: null,
        finished: false,
        finished_at: null,
        local_only: true,
      };
      store.openings[key] = opening;
      writeStore(store);
    }
    return { store, key, opening };
  }

  function saveOpening(context) {
    context.store.openings[context.key] = context.opening;
    writeStore(context.store);
  }

  function makeId(prefix) {
    try { return prefix + '-' + crypto.randomUUID(); }
    catch (_) { return prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
  }

  function parseJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function cleanProduct(product) {
    if (!product) return null;
    const manufacturer = String(product.manufacturer || '').trim();
    const model = String(product.model || '').trim();
    if (!manufacturer || !model) return null;
    return {
      manufacturer,
      model,
      cut_sheet_url: String(product.cut_sheet_url || '').trim(),
    };
  }

  function productForSavedRecord(record) {
    const stored = cleanProduct(record && record.gate_product);
    if (stored) return { product: stored, method: record.how_established || 'saved gate result' };

    const technician = parseJson(record && record.technician_selection_record);
    if (technician && technician.source === 'technician') {
      return { product: null, method: 'technician selected', reason: 'selected product document provenance is missing; review and save this part again' };
    }

    if (record && record.how_established === 'vision identified') {
      const vision = cleanProduct({
        manufacturer: record.topM || record.mfr,
        model: record.topMod || (record.top || '').replace(String(record.topM || '') + ' ', ''),
        cut_sheet_url: record.cutsheet,
      });
      if (vision) return { product: vision, method: 'vision identified' };
    }
    return { product: null, method: record && record.how_established || 'unresolved', reason: 'replacement identity is not gate-approved' };
  }

  function currentContext(create) {
    const facility = activeFacility();
    const number = openingNumber();
    if (!facility) return { error: 'Select a facility first.' };
    if (!number) return { error: 'Enter an Opening # first.' };
    const context = getOpening(facility.id, number, create);
    context.facility = facility;
    return context;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function localStatusText() {
    return window.OI_LOCAL_MODE ? 'Local only — not synchronized' : 'Saved opening record';
  }

  function ensureReviewPanel() {
    let panel = document.getElementById('oiOpeningReview');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'oiOpeningReview';
    panel.style.cssText = 'margin-top:10px;padding:11px;border:1px solid var(--line);border-radius:10px;background:#f7f8fa;font-size:13px';
    const anchor = document.getElementById('finishMsg');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor);
    return panel;
  }

  function renderOpeningReview() {
    const panel = ensureReviewPanel();
    const context = currentContext(false);
    if (context.error || !context.opening) {
      panel.innerHTML = '<b>Opening review</b><div style="color:var(--muted);margin-top:4px">Select a facility and opening to review saved records.</div>';
      updatePurchasingUi();
      return;
    }
    const opening = context.opening;
    let html = '<div style="display:flex;justify-content:space-between;gap:8px"><b>Opening ' + escapeHtml(opening.opening_no) + ' review</b><span style="color:var(--muted)">' + escapeHtml(localStatusText()) + '</span></div>';
    if (!opening.components.length) html += '<div style="color:var(--muted);margin-top:6px">No saved hardware yet.</div>';
    opening.components.forEach((component) => {
      const established = component.how_established === 'technician selected'
        ? 'technician selected — not image recognition'
        : (component.how_established || 'unresolved');
      const identity = component.gate_product
        ? component.gate_product.manufacturer + ' ' + component.gate_product.model
        : 'identity unresolved';
      html += '<div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #e2e5e9;padding:6px 0">' +
        '<span>' + escapeHtml(String(component.CLASS || 'part').replace(/_/g, ' ').toLowerCase()) + '</span>' +
        '<span style="text-align:right">' + escapeHtml(identity) + ' · ' + escapeHtml(component.cond || 'unrated') + '<br><small>' + escapeHtml(established) + '</small></span></div>';
    });
    html += '<div style="border-top:1px solid #e2e5e9;padding-top:6px">Door &amp; frame: ' +
      (opening.door_frame ? 'saved' : 'not saved') + ' · Status: ' + (opening.finished ? 'finished' : 'in progress') + '</div>';
    panel.innerHTML = html;
    updatePurchasingUi();
  }

  function persistSavedRecord(record, gate) {
    const facility = activeFacility();
    if (!facility || !record || !record.opnum) return;
    record.facility_id = facility.id;
    record.facility_name = facility.name;
    record.component_id = record.component_id || makeId('component');
    record.saved_at = record.saved_at || new Date().toISOString();
    record.reviewed_at = record.cond && record.how_established ? record.saved_at : null;
    record.local_only = !!window.OI_LOCAL_MODE;
    const product = gate && gate.purchasing ? cleanProduct(gate.purchasing.product) : null;
    record.gate_product = product;
    record.gate_result_label = gate ? gate.result_label : record.how_established;

    const context = getOpening(facility.id, record.opnum, true);
    context.opening.area = record.loc || context.opening.area || '';
    context.opening.facility_name = facility.name;
    const index = context.opening.components.findIndex((item) => item.component_id === record.component_id);
    const saved = JSON.parse(JSON.stringify(record));
    if (index >= 0) context.opening.components[index] = saved;
    else context.opening.components.push(saved);
    context.opening.finished = false;
    context.opening.finished_at = null;
    saveOpening(context);
    localStorage.setItem('oi_log', JSON.stringify(window.LOG || []));
    renderOpeningReview();
  }

  function currentGate() {
    try {
      if (typeof window.oiGate === 'function') return window.oiGate();
    } catch (_) {}
    const technician = window._tech;
    if (technician && technician.selected && technician.product) {
      return {
        purchasing: { enabled: true, product: technician.product },
        result_label: 'technician selected',
        result_basis: 'a person chose this product; the system did not identify it',
      };
    }
    return null;
  }

  function installSaveWrapper() {
    const original = window.saveEntry;
    if (typeof original !== 'function' || original.__oiBounded) return;
    const wrapped = function () {
      let gate = null;
      try { gate = currentGate(); } catch (_) {}
      const before = (window.LOG || []).length;
      const result = original.apply(this, arguments);
      const records = window.LOG || [];
      if (result && records.length > before) persistSavedRecord(records[records.length - 1], gate);
      return result;
    };
    wrapped.__oiBounded = true;
    window.saveEntry = wrapped;
  }

  function doorValues() {
    const value = (id) => { const element = document.getElementById(id); return element ? element.value : ''; };
    return {
      material: value('doorMat'), width_in: value('doorW'), height_in: value('doorH'),
      thickness: value('doorT'), handing: value('doorHand'), frame: value('doorFrame'),
      fire_rated: !!(document.getElementById('fire') && document.getElementById('fire').checked),
      saved_at: new Date().toISOString(),
    };
  }

  function clearDoorForm() {
    ['doorMat', 'doorW', 'doorH', 'doorT', 'doorHand', 'doorFrame'].forEach((id) => {
      const element = document.getElementById(id); if (element) element.value = '';
    });
  }

  function hydrateDoorForm(door) {
    clearDoorForm();
    if (!door) return;
    const set = (id, value) => { const element = document.getElementById(id); if (element) element.value = value || ''; };
    set('doorMat', door.material); set('doorW', door.width_in); set('doorH', door.height_in);
    set('doorT', door.thickness); set('doorHand', door.handing); set('doorFrame', door.frame);
  }

  function installOpeningFunctions() {
    if (window.toggleDoor && window.toggleDoor.__oiBoundedOpening &&
        window.saveDoor && window.saveDoor.__oiBoundedOpening &&
        window.finishOpening && window.finishOpening.__oiBoundedOpening) return;
    const originalToggle = window.toggleDoor;
    window.toggleDoor = function () {
      if (!window.OI_LOCAL_MODE && typeof originalToggle === 'function') return originalToggle.apply(this, arguments);
      const form = document.getElementById('doorForm');
      if (!form) return;
      const opening = form.style.display === 'none';
      form.style.display = opening ? 'block' : 'none';
      if (opening) {
        const context = currentContext(false);
        hydrateDoorForm(context.opening && context.opening.door_frame);
      } else {
        clearDoorForm();
      }
    };
    window.toggleDoor.__oiBoundedOpening = true;

    const originalSaveDoor = window.saveDoor;
    window.saveDoor = async function () {
      if (!window.OI_LOCAL_MODE && typeof originalSaveDoor === 'function') return originalSaveDoor.apply(this, arguments);
      const context = currentContext(true);
      const message = document.getElementById('doorMsg');
      if (context.error) { if (message) message.textContent = context.error; return; }
      const door = doorValues();
      if (!door.material) { if (message) message.textContent = 'Pick the door material.'; return; }
      context.opening.door_frame = door;
      context.opening.area = (document.getElementById('loc') || {}).value || '';
      context.opening.finished = false;
      context.opening.finished_at = null;
      saveOpening(context);
      if (message) message.textContent = '✓ Door & frame saved to opening ' + context.opening.opening_no + ' · local only';
      renderOpeningReview();
    };
    window.saveDoor.__oiBoundedOpening = true;

    const originalFinish = window.finishOpening;
    window.finishOpening = function () {
      if (!window.OI_LOCAL_MODE && typeof originalFinish === 'function') return originalFinish.apply(this, arguments);
      const context = currentContext(false);
      const message = document.getElementById('finishMsg');
      if (context.error || !context.opening) { if (message) message.textContent = context.error || 'No saved opening record.'; return false; }
      const opening = context.opening;
      const reasons = finishReasons(opening, !!(window._last && !window._saved && openingNumber() === opening.opening_no));
      if (reasons.length) {
        opening.finished = false; opening.finished_at = null; saveOpening(context);
        if (message) { message.textContent = 'Not finished — ' + Array.from(new Set(reasons)).join('; ') + '.'; message.style.color = 'var(--bad)'; }
        updatePurchasingUi();
        return false;
      }
      opening.finished = true;
      opening.finished_at = new Date().toISOString();
      opening.reviewed_at = opening.finished_at;
      saveOpening(context);
      if (message) { message.textContent = '✓ Opening ' + opening.opening_no + ' is inspected, reviewed, saved and finished (' + opening.components.length + ' part' + (opening.components.length === 1 ? '' : 's') + ' + door) · local only'; message.style.color = 'var(--good)'; }
      renderOpeningReview();
      return true;
    };
    window.finishOpening.__oiBoundedOpening = true;

    // Intercept these local-only controls in the capture phase. This prevents
    // their original inline handlers from running after the bounded handler.
    const boundedControls = {
      'toggleDoor()': 'toggleDoor',
      'saveDoor()': 'saveDoor',
      'finishOpening()': 'finishOpening',
    };
    document.addEventListener('click', function (event) {
      if (!window.OI_LOCAL_MODE) return;
      const button = event.target && event.target.closest ? event.target.closest('button') : null;
      const name = button && boundedControls[button.getAttribute('onclick')];
      if (!name) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window[name]();
    }, true);
  }

  function finishReasons(opening, hasUnsavedCurrentPart) {
    const reasons = [];
    if (!opening || !opening.components || !opening.components.length) reasons.push('save at least one hardware record');
    (opening && opening.components || []).forEach((component) => {
      if (!component.saved_at) reasons.push('save ' + String(component.CLASS || 'part').replace(/_/g, ' ').toLowerCase());
      if (!component.reviewed_at) reasons.push('review and condition-rate ' + String(component.CLASS || 'part').replace(/_/g, ' ').toLowerCase());
    });
    if (!opening || !opening.door_frame) reasons.push('save the door and frame record');
    if (hasUnsavedCurrentPart) reasons.push('save the current hardware record');
    return Array.from(new Set(reasons));
  }

  function openingForRecord(record) {
    if (!record || !record.facility_id || !record.opnum) return null;
    return getOpening(record.facility_id, record.opnum, false).opening || null;
  }

  function evaluate(records) {
    const replacements = (records || []).filter((record) => ['worn', 'failed'].includes(String(record.cond || '').toLowerCase()));
    if (!replacements.length) return { allowed: false, noOrder: true, reasons: ['No worn or failed parts require ordering.'], parts: [], openingCount: 0 };
    const reasons = [];
    const eligible = [];
    const openingKeys = new Set();
    replacements.forEach((record) => {
      const label = 'Opening ' + (record.opnum || 'unknown') + ' ' + String(record.CLASS || 'part').replace(/_/g, ' ').toLowerCase();
      if (!record.facility_id || !record.opnum) reasons.push(label + ': facility or opening provenance is missing');
      const opening = openingForRecord(record);
      if (!opening || !opening.finished) reasons.push(label + ': opening is not finished');
      else {
        const saved = opening.components.find((item) => item.component_id === record.component_id);
        if (!saved || !saved.saved_at || !saved.reviewed_at) reasons.push(label + ': part is not reviewed and saved in the finished opening');
      }
      const identity = productForSavedRecord(record);
      if (!identity.product) reasons.push(label + ': ' + identity.reason);
      else eligible.push({ record, product: identity.product, method: identity.method });
      if (record.facility_id && record.opnum) openingKeys.add(openingKey(record.facility_id, record.opnum));
    });
    return {
      allowed: reasons.length === 0,
      noOrder: false,
      reasons: Array.from(new Set(reasons)),
      parts: eligible,
      openingCount: openingKeys.size,
    };
  }

  function logCounts(records) {
    const parts = (records || []).length;
    const openings = new Set();
    (records || []).forEach((record) => {
      const number = String(record && record.opnum || '').trim();
      if (!number) return;
      const facility = String(record && record.facility_id || 'legacy-local-log');
      openings.add(openingKey(facility, number));
    });
    return { parts, openings: openings.size };
  }

  function payloadFor(decision) {
    let total = 0;
    const lines = [
      'Opening Intelligence — replacement parts request',
      'Openings in request: ' + decision.openingCount + ' · Parts to order: ' + decision.parts.length,
      '',
    ];
    decision.parts.forEach((item, index) => {
      const record = item.record;
      const product = item.product;
      const cost = record.cost !== '' && record.cost != null ? Number(record.cost) : null;
      if (cost && isFinite(cost)) total += cost;
      lines.push((index + 1) + '. ' + (record.facility_name || 'Local facility') + ' · Opening ' + record.opnum + (record.loc ? ' · ' + record.loc : ''));
      lines.push('   ' + String(record.CLASS || 'part').replace(/_/g, ' ').toLowerCase() + ' — ' + product.manufacturer + ' ' + product.model + ' · ' + record.cond + (cost ? ' · $' + cost : ''));
      lines.push('   How established: ' + (record.how_established || item.method));
      if (record.oi_original_result) lines.push("   OI's original result: " + record.oi_original_result);
      lines.push('   Cut sheet: ' + (product.cut_sheet_url || 'not on file — review before ordering'));
      lines.push('');
    });
    if (total > 0) lines.push('Estimated total: $' + total, '');
    lines.push('Confirm quantities, finishes and handing before ordering.');
    return {
      title: 'Replacement parts — ' + decision.parts.length + ' part' + (decision.parts.length === 1 ? '' : 's'),
      text: lines.join('\n'),
    };
  }

  function ensurePurchaseOverlay() {
    let overlay = document.getElementById('oiPurchaseReviewOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'oiPurchaseReviewOverlay';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(15,25,45,.72);z-index:9999;align-items:center;justify-content:center;padding:18px';
    overlay.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;max-height:88vh;overflow:auto;padding:16px">' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><b>Purchasing request review</b><button id="oiPurchaseClose" class="btn sec" style="width:auto;margin:0;padding:6px 10px">Close</button></div>' +
      '<div id="oiPurchaseStatus" class="hint" style="margin:8px 0"></div><pre id="oiPurchasePayload" style="white-space:pre-wrap;background:#f7f8fa;border:1px solid var(--line);border-radius:9px;padding:10px;font:12px ui-monospace,monospace"></pre>' +
      '<button id="oiPurchaseDispatch" class="btn">Share / email reviewed request</button></div>';
    document.body.appendChild(overlay);
    document.getElementById('oiPurchaseClose').addEventListener('click', () => { overlay.style.display = 'none'; });
    return overlay;
  }

  async function dispatch(payload) {
    if (navigator.share) {
      try { await navigator.share(payload); return; }
      catch (error) { if (error && error.name === 'AbortError') return; }
    }
    location.href = 'mailto:?subject=' + encodeURIComponent(payload.title) + '&body=' + encodeURIComponent(payload.text);
  }

  function showDecision(decision) {
    window.OI_LAST_PURCHASE_DECISION = JSON.parse(JSON.stringify(decision));
    if (!decision.allowed) {
      const message = 'Not sent — ' + decision.reasons.join('; ');
      document.querySelectorAll('#oiGateReason').forEach((note) => { note.textContent = message; });
      const existing = document.getElementById('oiPurchaseReviewOverlay');
      if (existing) existing.style.display = 'none';
      return false;
    }
    const overlay = ensurePurchaseOverlay();
    const status = document.getElementById('oiPurchaseStatus');
    const pre = document.getElementById('oiPurchasePayload');
    const button = document.getElementById('oiPurchaseDispatch');
    overlay.style.display = 'flex';
    const payload = payloadFor(decision);
    window.OI_LAST_PURCHASE_PAYLOAD = JSON.parse(JSON.stringify(payload));
    status.textContent = 'Review only — nothing has been sent. ' + decision.openingCount + ' opening' + (decision.openingCount === 1 ? '' : 's') + ' · ' + decision.parts.length + ' part' + (decision.parts.length === 1 ? '' : 's') + ' to order.';
    pre.textContent = payload.text;
    button.disabled = false;
    button.onclick = () => dispatch(payload);
    return true;
  }

  function updatePurchasingUi() {
    const records = window.LOG || [];
    const bulk = document.getElementById('sendLogPurchasingBtn');
    if (bulk) {
      const decision = evaluate(records);
      bulk.disabled = !records.length;
      bulk.setAttribute('aria-disabled', String(!records.length));
      bulk.dataset.oiEligibility = decision.allowed ? 'eligible' : 'blocked';
      bulk.textContent = decision.allowed ? '📤 Review purchasing request' : '🔒 Purchasing unavailable — check reason';
      bulk.title = decision.allowed ? 'Review the request before sharing' : decision.reasons.join('; ');
      const note = document.getElementById('oiBulkGateReason');
      if (note) {
        note.textContent = decision.allowed
          ? decision.openingCount + ' opening' + (decision.openingCount === 1 ? '' : 's') + ' complete · ' + decision.parts.length + ' replacement part' + (decision.parts.length === 1 ? '' : 's') + ' eligible for review.'
          : 'Purchasing unavailable — ' + decision.reasons.join('; ');
        note.style.color = decision.allowed ? 'var(--good)' : 'var(--muted)';
      }
    }

    const facility = activeFacility();
    const number = openingNumber();
    const currentClass = window._last && window._last.CLASS;
    const candidates = records.filter((record) => record.facility_id === (facility && facility.id) && record.opnum === number);
    let current = null;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (!currentClass || candidates[i].CLASS === currentClass) { current = candidates[i]; break; }
    }
    const singleDecision = current
      ? evaluate([current])
      : { allowed: false, reasons: ['Save and review this part before purchasing.'] };
    document.querySelectorAll('button[onclick="sendToPurchasing()"],button[onclick="window.sendToPurchasing()"]')
      .forEach((button) => {
        button.dataset.oiEligibility = singleDecision.allowed ? 'eligible' : 'blocked';
        button.textContent = singleDecision.allowed ? '📤 Review purchasing request' : '🔒 Purchasing unavailable — check reason';
        button.title = singleDecision.allowed ? 'Review this request before sharing' : singleDecision.reasons.join('; ');
      });
    document.querySelectorAll('#oiGateReason').forEach((gateNote) => {
      let note = gateNote.parentNode && gateNote.parentNode.querySelector('.oiPurchaseEligibility');
      if (!note && gateNote.parentNode) {
        note = document.createElement('div');
        note.className = 'oiPurchaseEligibility';
        note.style.cssText = 'font-size:12px;color:var(--muted);margin-top:2px';
        gateNote.parentNode.insertBefore(note, gateNote.nextSibling);
      }
      if (note) note.textContent = singleDecision.allowed
        ? 'Purchasing eligible — review is available; nothing is sent until the reviewed request is shared.'
        : 'Purchasing unavailable — ' + singleDecision.reasons.join('; ');
    });
  }

  function installPurchasing() {
    window.sendLogToPurchasing = async function () {
      return showDecision(evaluate(window.LOG || []));
    };
    window.sendToPurchasing = async function () {
      const facility = activeFacility();
      const number = openingNumber();
      const records = (window.LOG || []).filter((record) => record.facility_id === (facility && facility.id) && record.opnum === number);
      let current = null;
      const currentClass = window._last && window._last.CLASS;
      for (let i = records.length - 1; i >= 0; i--) {
        if (!currentClass || records[i].CLASS === currentClass) { current = records[i]; break; }
      }
      if (!current) return showDecision({ allowed: false, noOrder: false, reasons: ['Save and review this part before purchasing.'], parts: [], openingCount: 0 });
      return showDecision(evaluate([current]));
    };
    const originalRenderActions = window.oiRenderActions;
    if (typeof originalRenderActions === 'function') {
      window.oiRenderActions = function () {
        const result = originalRenderActions.apply(this, arguments);
        updatePurchasingUi();
        return result;
      };
    }
  }

  function installNavigationRefresh() {
    ['facSel', 'opnum'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.addEventListener(id === 'facSel' ? 'change' : 'input', renderOpeningReview);
    });
  }

  function init() {
    if (window.OI_LOCAL_MODE) {
      window.cloudSync = async function () {
        const message = document.getElementById('syncMsg');
        if (message) message.textContent = 'Local only — saved on this device, not synchronized';
        return { local_only: true };
      };
    }
    installSaveWrapper();
    installOpeningFunctions();
    installPurchasing();
    installNavigationRefresh();
    renderOpeningReview();
  }

  window.OIBounded = Object.freeze({
    readStore, writeStore, openingKey, getOpening, productForSavedRecord,
    finishReasons, evaluate, payloadFor, hydrateDoorForm, logCounts,
    rebindOpeningControls: installOpeningFunctions,
  });
  // Shared facility resolver for app features loaded in later script blocks.
  // Return a copy so consumers cannot mutate the active selection.
  window.oiActiveFacility = activeFacility;

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();
