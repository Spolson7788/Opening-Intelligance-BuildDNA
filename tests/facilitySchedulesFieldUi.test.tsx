// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../field-app/src/lib/api', () => ({ fetchFacilitySchedulesForOpening: state.read }));
import { FacilitySchedulesPage } from '../field-app/src/pages/FacilitySchedulesPage';
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.read.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(
  <MemoryRouter initialEntries={['/opening/op-1/schedules']}><Routes><Route path="/opening/:id/schedules" element={<FacilitySchedulesPage />} /></Routes></MemoryRouter>));

it('lists schedules with kind, filename, versions and current marker, read-only', async () => {
  state.read.mockResolvedValue([{ id: 's1', kind: 'hardware', title: 'Hardware sets', head_version: 2, versions: [
    { id: 'v2', version: 2, original_filename: 'hw-rev2.xlsx', uploaded_at: '2026-10-27T18:00:00Z' },
    { id: 'v1', version: 1, original_filename: 'hw.xlsx', uploaded_at: '2026-10-20T18:00:00Z' }] }]);
  await render();
  expect(state.read).toHaveBeenCalledWith('op-1');
  expect(host.textContent).toContain('Hardware sets');
  expect(host.textContent).toContain('Door hardware schedule');
  expect(host.textContent).toContain('v2 (current)');
  expect(host.textContent).toContain('hw-rev2.xlsx');
  expect(host.textContent).toContain('hw.xlsx');
  expect(host.querySelector('input,button,form')).toBeNull();
});
it('shows empty and failure states without raw errors', async () => {
  state.read.mockResolvedValue([]);
  await render();
  expect(host.textContent).toContain('No schedules have been uploaded');
  state.read.mockRejectedValue(new Error('raw server detail'));
  await act(async () => root.unmount()); root = createRoot(host);
  await render();
  expect(host.textContent).toContain('Schedules could not be loaded.');
  expect(host.textContent).not.toContain('raw server detail');
});