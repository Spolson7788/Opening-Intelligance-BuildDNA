// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ fetch: vi.fn(), media: vi.fn(), listeners: new Set<(s: any) => void>(), badgeMounts: 0, navigate: null as any }));
vi.mock('../field-app/src/lib/api', () => ({ fetchOpening: (...a: any[]) => data.fetch(...a), fetchOpeningByQr: (...a: any[]) => data.fetch(...a), fetchOpeningByCode: (...a: any[]) => data.fetch(...a), deletePhoto: vi.fn(), fetchPhotoAccessUrl: vi.fn() }));
vi.mock('../field-app/src/lib/db', () => ({ getAllOfflineMedia: () => data.media(), getSyncOperationsForOpening: async () => [], updateCachedOpening: vi.fn() }));
vi.mock('../field-app/src/lib/sync', () => ({ onSyncStateChange: (cb: (s: any) => void) => { data.listeners.add(cb); cb({ syncing: false }); return () => data.listeners.delete(cb); }, queueOpeningMutation: vi.fn() }));
vi.mock('../field-app/src/components/PhotoCapture', () => ({ PhotoCapture: () => null }));
vi.mock('../field-app/src/components/SyncBadge', () => ({ SyncBadge: () => { useEffect(() => { if (++data.badgeMounts < 8) data.listeners.forEach(cb => cb({ syncing: false })); }, []); return <span>Sync status</span>; } }));
import { OpeningDetailPage } from '../field-app/src/pages/OpeningDetailPage';
let el: HTMLDivElement, root: ReturnType<typeof createRoot>;
function Harness() { data.navigate = useNavigate(); return <Routes><Route path='/opening/:id' element={<OpeningDetailPage />} /></Routes>; }
async function render() { await act(async () => root.render(<MemoryRouter initialEntries={['/opening/A']}><Harness /></MemoryRouter>)); }
async function emit(syncing: boolean) { await act(async () => data.listeners.forEach(cb => cb({ syncing }))); }
function record(id = 'A') { return { opening: { id, opening_code: `SYN-${id}`, opening_type: 'door', photos: [] }, fromCache: false }; }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); data.listeners.clear(); data.badgeMounts = 0; data.fetch.mockReset(); data.media.mockReset().mockResolvedValue([]); el = document.createElement('div'); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it.each([401, 403, 404])('keeps %s denial visible without idle/remount or periodic sync retry', async status => {
  data.fetch.mockRejectedValue({ status }); await render();
  expect(data.fetch).toHaveBeenCalledTimes(1);
  expect(el.querySelector('[role="alert"]')).not.toBeNull();
  expect(el.textContent).not.toContain('Loading.');
  await emit(false); await emit(true); await emit(false);
  expect(data.fetch).toHaveBeenCalledTimes(1);
  expect(data.badgeMounts).toBe(1);
});
it('refreshes an accessible opening once after a real sync cycle, not idle count notifications', async () => {
  data.fetch.mockResolvedValue(record()); await render();
  expect(data.fetch).toHaveBeenCalledTimes(1);
  const localReads = data.media.mock.calls.length;
  await emit(false); expect(data.media.mock.calls.length).toBeGreaterThan(localReads);
  expect(data.fetch).toHaveBeenCalledTimes(1);
  await emit(true); await emit(false); await emit(false);
  expect(data.fetch).toHaveBeenCalledTimes(2);
  expect(el.textContent).toContain('SYN-A');
});
it('removes previously visible opening on authorization loss and stops later automatic reads', async () => {
  data.fetch.mockResolvedValueOnce(record()).mockRejectedValue({ status: 403 }); await render();
  await emit(true); await emit(false);
  expect(el.textContent).not.toContain('SYN-A'); expect(el.textContent).toContain('Access unavailable');
  await emit(true); await emit(false); expect(data.fetch).toHaveBeenCalledTimes(2);
});
it('a new route can load after a terminal failure without reusing the denied opening', async () => {
  data.fetch.mockRejectedValueOnce({ status: 404 }).mockResolvedValue(record('B')); await render();
  await act(async () => data.navigate('/opening/B'));
  expect(data.fetch.mock.calls.map(c => c[0])).toEqual(['A', 'B']);
  expect(el.textContent).toContain('SYN-B');
  await emit(true); await emit(false); expect(data.fetch).toHaveBeenCalledTimes(3);
});
it('keeps transient failure recovery explicit without mount loops', async () => {
  data.fetch.mockRejectedValueOnce(new Error('unexpected_response')).mockResolvedValue(record()); await render();
  expect(data.fetch).toHaveBeenCalledTimes(1);
  const retry = [...el.querySelectorAll('button')].find(b => b.textContent === 'Try again')!;
  await act(async () => retry.click());
  expect(data.fetch).toHaveBeenCalledTimes(2); expect(el.textContent).toContain('SYN-A');
});
