import {useEffect, useState} from 'react';
import {PREVIEW_ACCESS_EVENT, PREVIEW_ACCESS_PATH} from '../lib/previewAccess';

export function PreviewAccessNotice() {
  const [required, setRequired] = useState(false);
  useEffect(() => {
    const show = () => setRequired(true);
    window.addEventListener(PREVIEW_ACCESS_EVENT, show);
    return () => window.removeEventListener(PREVIEW_ACCESS_EVENT, show);
  }, []);
  if (!required) return null;
  return <section className="card" role="alert" aria-label="Staging website access">
    <h2>Renew staging website access</h2>
    <p>The website access check stopped this request before an application decision could be verified. Your app password has not been reported incorrect.</p>
    <p>Open the access check below, complete Netlify sign-in if asked, then sign in to the Field App. Unsaved form entries and selected recognition photographs will need to be entered again. Saved offline work remains on this device.</p>
    <a className="btn btn-primary" href={PREVIEW_ACCESS_PATH}>Renew staging access</a>
  </section>;
}
