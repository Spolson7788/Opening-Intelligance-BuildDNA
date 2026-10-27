import { describe, expect, it } from 'vitest';
import { enforceRolePermissions } from '../src/middleware/permissions';

type Row = [method: string, path: string, body?: any];
function decide(role: string, [method, path, body]: Row): number {
  let status = 0;
  const req: any = { auth: { userId: 'u', organizationId: 'o', role }, method, originalUrl: path, body: body ?? {} };
  const res: any = { status: (s: number) => { status = s; return { json: () => res }; } };
  enforceRolePermissions(req, res, () => { status = 200; });
  return status;
}

const INSPECTOR_ALLOWED: Row[] = [
  ['POST', '/api/events/inspection-events'],
  ['POST', '/api/condition-history/observations'],
  ['POST', '/api/sync/operations', { entity_type: 'inspection_event', operation_type: 'create' }],
  ['POST', '/api/photos/presign'],
  ['POST', '/api/photos/offline/reserve'],
  ['POST', '/api/photos/offline/confirm'],
  ['POST', '/api/photos/offline/recover-reservation'],
  ['POST', '/api/photos'],
  ['POST', '/api/documents/presign'],
  ['POST', '/api/documents', { document_type: 'inspection_report' }],
  ['POST', '/api/service-requests'],
];
const INSPECTOR_DENIED: Row[] = [
  ['POST', '/api/hardware'], ['PATCH', '/api/hardware/h1'], ['DELETE', '/api/hardware/h1'],
  ['POST', '/api/sync/components'],
  ['POST', '/api/sync/operations', { entity_type: 'frame', operation_type: 'update' }],
  ['POST', '/api/sync/operations', { entity_type: 'door_leaf', operation_type: 'create' }],
  ['POST', '/api/sync/operations', { entity_type: 'service_event', operation_type: 'create' }],
  ['POST', '/api/sync/operations', { entity_type: 'completion', operation_type: 'complete' }],
  ['PUT', '/api/openings/o1/frame'], ['POST', '/api/openings/o1/door-leaves'], ['POST', '/api/openings/o1/complete'],
  ['POST', '/api/work-orders/w1/status'], ['POST', '/api/openings/o1/recompute-health-score'],
  ['POST', '/api/purchasing/review'],
  ['POST', '/api/openings'], ['POST', '/api/portfolio/properties'], ['POST', '/api/portfolio/buildings'],
  ['POST', '/api/labels/generations'],
  ['DELETE', '/api/photos/p1'], ['DELETE', '/api/documents/d1'],
  ['POST', '/api/documents', { document_type: 'warranty' }],
  ['POST', '/api/events/service-events'],
  ['POST', '/api/facility-schedules/presign'], ['POST', '/api/facility-schedules'],
];

// Technician expectations are the pre-change behavior, written out explicitly.
const TECH_ALLOWED: Row[] = [
  ['POST', '/api/service-requests'], ['POST', '/api/labels/generations'], ['POST', '/api/events/service-events'],
  ['POST', '/api/events/inspection-events'], ['POST', '/api/hardware'], ['PATCH', '/api/hardware/h1'], ['DELETE', '/api/hardware/h1'],
  ['POST', '/api/photos/presign'], ['POST', '/api/photos/offline/reserve'], ['POST', '/api/photos/offline/confirm'],
  ['POST', '/api/photos/offline/recover-reservation'], ['POST', '/api/photos'], ['DELETE', '/api/photos/p1'],
  ['POST', '/api/documents/presign'], ['POST', '/api/documents', { document_type: 'warranty' }], ['DELETE', '/api/documents/d1'],
  ['POST', '/api/work-orders/w1/status'], ['POST', '/api/openings/o1/recompute-health-score'],
  ['POST', '/api/sync/components'], ['POST', '/api/sync/operations', { entity_type: 'frame' }],
  ['PUT', '/api/openings/o1/frame'], ['POST', '/api/openings/o1/door-leaves'], ['POST', '/api/openings/o1/complete'],
  ['POST', '/api/purchasing/review'],
  ['POST', '/api/portfolio/properties'], ['POST', '/api/portfolio/buildings'], ['POST', '/api/openings'],
];
const TECH_DENIED: Row[] = [
  ['POST', '/api/condition-history/observations'], ['POST', '/api/openings/bulk-import'], ['POST', '/api/portfolio/portfolios'],
  ['PATCH', '/api/openings/o1'], ['POST', '/api/work-orders'],
];

describe('role permissions', () => {
  it.each(INSPECTOR_ALLOWED)('inspector allowed %s %s', (...r) => expect(decide('inspector', r as Row)).toBe(200));
  it.each(INSPECTOR_DENIED)('inspector denied %s %s', (...r) => expect(decide('inspector', r as Row)).toBe(403));
  it.each(TECH_ALLOWED)('technician unchanged: allowed %s %s', (...r) => expect(decide('technician', r as Row)).toBe(200));
  it.each(TECH_DENIED)('technician unchanged: denied %s %s', (...r) => expect(decide('technician', r as Row)).toBe(403));
  it('inspector and technician reads stay allowed; viewer stays read-only; admin/manager unrestricted', () => {
    for (const role of ['inspector', 'technician', 'viewer']) expect(decide(role, ['GET', '/api/openings/o1'])).toBe(200);
    expect(decide('viewer', ['POST', '/api/events/inspection-events'])).toBe(403);
    for (const role of ['admin', 'facilities_manager']) expect(decide(role, ['POST', '/api/hardware'])).toBe(200);
  });
});