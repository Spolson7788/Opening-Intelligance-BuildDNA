// Edge Function entry (Deno). Deployed with verify_jwt=false because the function authenticates the
// caller itself with the REFERENCE_UPLOAD_KEY secret (fails closed with 503 while it is unset).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle, BUCKET } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(req => handle(req, {
  uploadKey: Deno.env.get('REFERENCE_UPLOAD_KEY'),
  uploader: (Deno.env.get('REFERENCE_UPLOAD_IDENTITY') ?? 'chat').slice(0, 80),
  rpc: async (fn, args) => { const { data, error } = await admin.rpc(fn, args); if (error) throw new Error('rpc_failed'); return data; },
  putObject: async (key, bytes, contentType) => {
    const { error } = await admin.storage.from(BUCKET).upload(key, bytes, { contentType, upsert: false });
    if (!error) return 'created';
    const m = String((error as any).statusCode ?? '') + ' ' + String(error.message ?? '');
    if (/409|already exists|Duplicate/i.test(m)) return 'exists';
    throw new Error('storage_failed');
  },
  getObject: async key => { const { data, error } = await admin.storage.from(BUCKET).download(key); return error || !data ? null : new Uint8Array(await data.arrayBuffer()); },
  sha256: async b => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map(x => x.toString(16).padStart(2, '0')).join(''),
}).catch(() => new Response(JSON.stringify({ error: 'internal_error' }), { status: 500, headers: { 'content-type': 'application/json' } })));
