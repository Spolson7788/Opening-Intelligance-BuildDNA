import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchPublicOpening, QrInformationError, type QrFailureKind, type PublicOpeningSummary } from '../lib/qrLanding';
import { siteAccessRenewalUrl } from '../lib/siteAccess';

export function QrInformationPage() {
  const { qrToken = '' } = useParams();
  const [result, setResult] = useState<{ token: string; value?: PublicOpeningSummary; failed?: QrFailureKind } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchPublicOpening(qrToken, controller.signal).then(value => {
      if (active) setResult({ token: qrToken, value });
    }).catch(error => { if (active) setResult({ token: qrToken, failed: error instanceof QrInformationError ? error.kind : 'unavailable' }); });
    return () => { active = false; controller.abort(); };
  }, [qrToken]);
  const current = result?.token === qrToken ? result : null;
  const renewal = current?.failed === 'site_access' ? siteAccessRenewalUrl(window.location.origin) : null;
  return <main className="screen">
    <h1>Opening information</h1>
    {!current && <p role="status">Loading opening information.</p>}
    {current?.failed && <p role="status">{current.failed === 'site_access'
      ? 'Private staging site access needs renewal. This is separate from your OI sign-in.'
      : current.failed === 'network' ? 'Opening information could not be reached. Check your connection and try again later.'
      : current.failed === 'service' ? 'Opening information is temporarily unavailable. Please try again later.'
      : 'Opening information is unavailable. Check your connection or contact the facility.'}</p>}
    {renewal && <a className="btn btn-primary" href={renewal} target="_blank" rel="noreferrer">Renew private site access</a>}
    {current?.value && <>
      <dl>
        <dt>Facility</dt><dd>{current.value.facility_name}</dd>
        <dt>Building</dt><dd>{current.value.building_name}</dd>
      </dl>
      <p>The opening, photos, component details and work records require authorized sign-in.</p>
      <Link className="btn btn-primary" to={`/opening/by-qr/${encodeURIComponent(qrToken)}/details`}>Sign in for protected details</Link>
    </>}
  </main>;
}
