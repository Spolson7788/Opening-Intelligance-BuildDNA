import { describe, expect, it } from 'vitest';
import { chooseFacility, describeSync, facilitySyncKey, retryFailedOpenings, selectedFacilityKey, shouldRefresh, syncFacility } from '../field-app/src/lib/facilitySync';
import { facilityOpeningsCacheKey } from '../field-app/src/lib/facilityOpenings';
// M4 v3: download a facility's openings when a signed-in technician selects it. Synthetic data only.
const me = { userId: 'u1', organizationId: 'o1' };
const facility = { id: 'p1', name: 'Synthetic Facility A', buildings: [{ id: 'b1', name: 'North' }, { id: 'b2', name: 'South' }] };
function deps(over: any = {}) {
  const store = new Map<string, any>(), fetched: string[] = [], sleeps: number[] = [];
  const lists: Record<string, any[]> = { b1: [{ id: 'o1', opening_code: '101' }, { id: 'o2', opening_code: '102' }], b2: [{ id: 'o3', opening_code: '201' }] };
  return { store, fetched, sleeps, d: {
    listOpenings: over.listOpenings ?? (async (b: string) => lists[b]),
    fetchOpening: over.fetchOpening ?? (async (id: string) => { fetched.push(id); return { id }; }),
    putSetting: async (k: string, v: unknown) => { store.set(k, v); },
    sleep: async (ms: number) => { sleeps.push(ms); },
    now: () => new Date('2026-10-28T13:00:00Z'),
  } };
}

describe('M4 v3 facility selection', () => {
  it('restores the stored facility, auto-selects the only one, otherwise asks', () => {
    const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' };
    expect(chooseFacility([a, b], 'b')).toBe('b');
    expect(chooseFacility([a, b], 'gone')).toBe(null);
    expect(chooseFacility([a, b], null)).toBe(null);
    expect(chooseFacility([a], null)).toBe('a');
    expect(chooseFacility([a], 'gone')).toBe('a');
    expect(chooseFacility([], null)).toBe(null);
    expect(selectedFacilityKey(me)).toBe('selected-facility:u1:o1');
  });
  it('refreshes on resume only when the last download is old enough', () => {
    const now = Date.parse('2026-10-28T13:00:00Z');
    expect(shouldRefresh(null, now)).toBe(true);
    expect(shouldRefresh('2026-10-28T12:59:30Z', now)).toBe(false);
    expect(shouldRefresh('2026-10-28T12:58:00Z', now)).toBe(true);
    expect(shouldRefresh('garbage', now)).toBe(true);
  });
});

describe('M4 v3 facility download', () => {
  it('downloads every opening in every building, caches lists and the result, and reports progress', async () => {
    const { d, store, fetched } = deps(); const seen: any[] = [];
    const r = await syncFacility(d, me, facility, { onProgress: (p) => seen.push(p) });
    expect(r).toMatchObject({ status: 'complete', openings: 3, saved: 3, failed: 0, failedIds: [], buildingsFailed: [], finishedAt: '2026-10-28T13:00:00.000Z' });
    expect(fetched.sort()).toEqual(['o1', 'o2', 'o3']);
    expect(store.get(facilityOpeningsCacheKey(me, 'b1')).length).toBe(2);
    expect(store.get(facilityOpeningsCacheKey(me, 'b2')).length).toBe(1);
    expect(store.get(facilitySyncKey(me, 'p1')).status).toBe('complete');
    expect(seen[0]).toMatchObject({ phase: 'listing', buildingsTotal: 2 });
    expect(seen.at(-1)).toMatchObject({ phase: 'done', openingsDone: 3, openingsTotal: 3 });
    expect(describeSync(null, r)).toMatch(/^All 3 opening\(s\) saved/);
    expect(describeSync(seen[3], null)).toMatch(/Downloading for offline use: \d of 3/);
  });
  it('retries transient failures with backoff and reports what still failed', async () => {
    const tries: Record<string, number> = {};
    const { d, sleeps } = deps({ fetchOpening: async (id: string) => { tries[id] = (tries[id] ?? 0) + 1;
      if (id === 'o2' && tries[id] < 3) throw new Error('net'); if (id === 'o3') throw new Error('net'); return {}; } });
    const r = await syncFacility(d, me, facility, { retries: 2, backoffMs: 100, concurrency: 1 });
    expect(tries).toEqual({ o1: 1, o2: 3, o3: 3 });
    expect(sleeps).toEqual([100, 200, 100, 200]);
    expect(r).toMatchObject({ status: 'partial', saved: 2, failed: 1, failedIds: ['o3'] });
    expect(describeSync(null, r)).toMatch(/2 of 3 opening\(s\) saved; 1 opening\(s\) failed/);
  });
  it('does not retry a 403/404, and keeps going when one building cannot be listed', async () => {
    let calls = 0;
    const { d } = deps({ listOpenings: async (b: string) => { if (b === 'b2') throw Object.assign(new Error('x'), { status: 403 }); return [{ id: 'o1', opening_code: '101' }]; },
      fetchOpening: async () => { calls++; throw Object.assign(new Error('gone'), { status: 404 }); } });
    const r = await syncFacility(d, me, facility, { retries: 3 });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ status: 'failed', buildingsFailed: ['b2'], failedIds: ['o1'] });
  });
  it('fails cleanly offline and a later retry of failed openings completes it', async () => {
    const off = deps({ listOpenings: async () => { throw new Error('offline'); } });
    expect((await syncFacility(off.d, me, facility, { retries: 0 })).status).toBe('failed');
    let ok = false;
    const { d, store } = deps({ fetchOpening: async () => { if (!ok) throw new Error('net'); return {}; } });
    const first = await syncFacility(d, me, facility, { retries: 0 });
    expect(first).toMatchObject({ status: 'failed', failed: 3 });
    ok = true;
    const again = await retryFailedOpenings(d, me, first, { retries: 0 });
    expect(again).toMatchObject({ status: 'complete', saved: 3, failed: 0, failedIds: [] });
    expect(store.get(facilitySyncKey(me, 'p1')).status).toBe('complete');
  });
  it('stops when cancelled (facility reselected or user signed out) and does not store a result', async () => {
    const ac = new AbortController();
    const { d, store, fetched } = deps({ fetchOpening: async (id: string) => { fetched.push(id); ac.abort(); return {}; } });
    const r = await syncFacility(d, me, facility, { signal: ac.signal, concurrency: 1 });
    expect(r.status).toBe('cancelled'); expect(fetched).toEqual(['o1']);
    expect(store.has(facilitySyncKey(me, 'p1'))).toBe(false);
  });
  it('a facility with no buildings completes with nothing to download', async () => {
    const { d } = deps();
    expect(await syncFacility(d, me, { id: 'p2', name: 'Empty', buildings: [] })).toMatchObject({ status: 'complete', openings: 0 });
  });
});