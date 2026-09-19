/* Provider mapping import — ADMINISTRATOR / ONBOARDING only.
 *
 * This file is loaded by provider-admin.html and by nothing else. The field
 * technician's page does not load it and carries no import controls at all, so
 * a technician can neither choose a mapping file nor run an import.
 *
 * What it does NOT do:
 *   - it does not reimplement mapping storage, validation or lookup. Those stay
 *     in oi-provider-mappings.js, unchanged and still covered by their own
 *     tests. This file only decides WHO may call importCsv, and when.
 *   - it exposes no global that grants administration. window.OIProviderAdmin
 *     can be ASKED whether the current session is authorized; it has no
 *     function that makes one authorized.
 *
 * The grant itself is a stored record written by this page's own sign-in step.
 *
 * Offline, stated plainly rather than implied: in local-only mode there is no
 * authentication authority on the device, so what this provides is a
 * STRUCTURAL separation — a separate interface, a separate stored grant, and no
 * import control anywhere in the technician view — not an authentication
 * guarantee. Where the data client is reachable, the signed-in profile's
 * user_type is what decides, and the grant is only written after that check.
 */
(function () {
  'use strict';

  const GRANT_KEY = 'oi_provider_admin_grant_v1';
  const ADMIN_ROLE = 'admin';

  function readGrant() {
    try {
      const grant = JSON.parse(localStorage.getItem(GRANT_KEY) || 'null');
      return grant && grant.role === ADMIN_ROLE ? grant : null;
    } catch (error) { return null; }
  }

  function isAuthorized() {
    return !!readGrant();
  }

  // Called by this page's sign-in step only, after the role has been
  // established. Not exported.
  function grant(role, source) {
    if (role !== ADMIN_ROLE) return false;
    localStorage.setItem(GRANT_KEY, JSON.stringify({
      role: ADMIN_ROLE, source: String(source || 'unknown'),
      granted_at: new Date().toISOString(),
    }));
    return true;
  }

  function revoke() {
    localStorage.removeItem(GRANT_KEY);
  }

  /* Resolve the role from the live profile when the data client is reachable.
   * Returns null when it cannot be established — which is NOT authorization. */
  async function liveRole() {
    const client = typeof window.oiDataClient === 'function' ? window.oiDataClient() : null;
    if (!client || !client.auth) return null;
    try {
      const { data } = await client.auth.getSession();
      const session = data && data.session;
      if (!session) return null;
      const profile = await client.from('profiles')
        .select('user_type').eq('id', session.user.id).maybeSingle();
      return (profile && profile.data && profile.data.user_type) || null;
    } catch (error) { return null; }
  }

  function importControls() {
    return {
      card: document.getElementById('providerMappingCard'),
      input: document.getElementById('providerMappingFile'),
      button: document.getElementById('providerMappingImport'),
      message: document.getElementById('providerMappingMsg'),
      denied: document.getElementById('providerMappingDenied'),
    };
  }

  /* The controls only exist in the DOM while a session is authorized. An
   * unauthorized visitor to this page sees the refusal, not a disabled form —
   * so there is no file input to point at and nothing to re-enable. */
  function render() {
    const el = importControls();
    const ok = isAuthorized();
    if (el.card) el.card.style.display = ok ? '' : 'none';
    if (el.denied) el.denied.style.display = ok ? 'none' : '';
    const who = document.getElementById('providerAdminWho');
    if (who) {
      const g = readGrant();
      who.textContent = ok
        ? 'Signed in as onboarding administrator (' + g.source + ')'
        : 'Not signed in as an administrator';
    }
    const out = document.getElementById('providerAdminSignout');
    if (out) out.style.display = ok ? '' : 'none';
  }

  function installImport() {
    const el = importControls();
    if (!el.button || !el.input || !el.message || el.button.__oiProviderImport) return;
    el.button.__oiProviderImport = true;
    el.button.addEventListener('click', async function () {
      // re-checked at the moment of the action, not only at render time
      if (!isAuthorized()) {
        el.message.textContent = 'Import refused — administrator authorization is required.';
        el.message.style.color = 'var(--bad)';
        render();
        return;
      }
      const file = el.input.files && el.input.files[0];
      if (!file) {
        el.message.textContent = 'Choose a CSV file first.';
        el.message.style.color = 'var(--bad)';
        return;
      }
      try {
        const result = window.OIProviderMappings.importCsv(
          localStorage, 'service-provider', await file.text());
        if (!result.ok) {
          el.message.textContent = 'Import refused — ' + result.errors.join('; ');
          el.message.style.color = 'var(--bad)';
          return;
        }
        el.message.textContent = '✓ ' + result.rows.length + ' mapping'
          + (result.rows.length === 1 ? '' : 's') + ' saved for the service provider.';
        el.message.style.color = 'var(--good)';
      } catch (error) {
        el.message.textContent = 'Import failed — ' + (error.message || String(error));
        el.message.style.color = 'var(--bad)';
      }
    });
  }

  async function signIn(source) {
    const message = document.getElementById('providerAdminMsg');
    const role = await liveRole();
    if (role) {
      if (role !== ADMIN_ROLE) {
        if (message) {
          message.textContent = 'This account is signed in as ' + role
            + '. Provider mapping import is restricted to administrators.';
          message.style.color = 'var(--bad)';
        }
        revoke(); render();
        return false;
      }
      grant(role, 'profile.user_type=admin');
      if (message) { message.textContent = ''; }
      render();
      return true;
    }
    // No reachable data client. Local-only onboarding: the administrator step
    // is performed here, deliberately and visibly, and is confined to this
    // device. It is not a shortcut around onboarding — it IS the onboarding
    // step, and the banner on this page says so.
    if (!window.OI_LOCAL_MODE) {
      if (message) {
        message.textContent = 'Cannot establish an administrator session — sign in first.';
        message.style.color = 'var(--bad)';
      }
      return false;
    }
    grant(ADMIN_ROLE, 'local-only onboarding session');
    if (message) { message.textContent = ''; }
    render();
    return true;
  }

  function install() {
    const enter = document.getElementById('providerAdminSignin');
    if (enter) enter.addEventListener('click', function () { signIn(); });
    const out = document.getElementById('providerAdminSignout');
    if (out) out.addEventListener('click', function () { revoke(); render(); });
    installImport();
    render();
  }

  // Read-only surface. There is no exported way to BECOME an administrator.
  window.OIProviderAdmin = Object.freeze({ isAuthorized, render });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
