import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchPublicOpening, type PublicOpeningSummary } from '../lib/qrLanding';

export function QrInformationPage() {
  const { qrToken = '' } = useParams();
  const [result, setResult] = useState<{ token: string; value?: PublicOpeningSummary; failed?: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchPublicOpening(qrToken, controller.signal).then(value => {
      if (active) setResult({ token: qrToken, value });
    }).catch(() => { if (active) setResult({ token: qrToken, failed: true }); });
    return () => { active = false; controller.abort(); };
  }, [qrToken]);
  const current = result?.token === qrToken ? result : null;
  return <main className="screen">
    <h1>Opening information</h1>
    {!current && <p role="status">Loading opening information.</p>}
    {current?.failed && <p role="status">Opening information is unavailable. Check your connection or contact the facility.</p>}
    {current?.value && <>
      <dl>
        <dt>Facility</dt><dd>{current.value.facility_name}</dd>
        <dt>Building</dt><dd>{current.value.building_name}</dd>
        <dt>Opening</dt><dd>{current.value.opening_code}</dd>
      </dl>
      <p>Photos, component details and work records require authorized sign-in.</p>
      <Link className="btn btn-primary" to={`/opening/by-qr/${encodeURIComponent(qrToken)}/details`}>Sign in for protected details</Link>
    </>}
  </main>;
}
