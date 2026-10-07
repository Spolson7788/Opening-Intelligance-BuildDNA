import type {Config} from '@netlify/functions';

// Top-level navigation lets Netlify's existing gate finish its own sign-in.
// This route grants no app access and does not read or change credentials.
export default async function previewAccess(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', {
    status: 405, headers: {Allow: 'GET', 'Cache-Control': 'no-store'},
  });
  return new Response(null, {
    status: 303,
    headers: {Location: '/field/login?preview_access=renewed', 'Cache-Control': 'no-store'},
  });
}

export const config: Config = {path: '/preview-access'};
