// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('../dashboard/src/lib/api', () => ({ setProviderHistorySharing: state.put }));
import { ProviderHistorySharingToggle, canManageProviderSharing } from '../dashboard/src/components/ProviderHistorySharingToggle';
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.put.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const prop = (o: any = {}) => ({ id: 'p1', name: 'Synthetic', city: null, state: 'CA', buildings: [], ...o });
const render = (el: React.ReactElement) => act(async () => root.render(el));

it('only the owner org admin can manage sharing', () => {
  expect(canManageProviderSharing('admin', { is_owner: true })).toBe(true);
  expect(canManageProviderSharing('admin', { is_owner: false })).toBe(false);
  expect(canManageProviderSharing('admin', {})).toBe(false);
  expect(canManageProviderSharing('technician', { is_owner: true })).toBe(false);
  expect(canManageProviderSharing(undefined, undefined)).toBe(false);
});
it('is hidden for provider admins and owner non-admins', async () => {
  await render(<ProviderHistorySharingToggle property={prop({ is_owner: false })} role="admin" />);
  expect(host.querySelector('input')).toBeNull();
  await render(<ProviderHistorySharingToggle property={prop({ is_owner: true })} role="facilities_manager" />);
  expect(host.querySelector('input')).toBeNull();
});
it('owner admin sees it off by default and turning it on calls the PUT endpoint', async () => {
  state.put.mockResolvedValue({ id: 'p1', share_provider_service_history: true });
  const changed = vi.fn();
  await render(<ProviderHistorySharingToggle property={prop({ is_owner: true })} role="admin" onChanged={changed} />);
  const box = host.querySelector('input') as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(host.textContent).toContain('Off (default)');
  await act(async () => { box.click(); });
  expect(state.put).toHaveBeenCalledWith('p1', true);
  expect(changed).toHaveBeenCalledWith(true);
  expect((host.querySelector('input') as HTMLInputElement).checked).toBe(true);
});
it('shows an error and stays unchanged when the request fails', async () => {
  state.put.mockRejectedValue(new Error('setting_unavailable'));
  await render(<ProviderHistorySharingToggle property={prop({ is_owner: true, share_provider_service_history: true })} role="admin" />);
  await act(async () => { (host.querySelector('input') as HTMLInputElement).click(); });
  expect(state.put).toHaveBeenCalledWith('p1', false);
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Could not change');
  expect((host.querySelector('input') as HTMLInputElement).checked).toBe(true);
});
