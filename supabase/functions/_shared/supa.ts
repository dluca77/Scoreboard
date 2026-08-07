// Shared Supabase client helpers for Edge Functions.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Supabase
// platform for every Edge Function — you do NOT set these as secrets yourself.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Full-access client — bypasses RLS. Only ever used inside these trusted
// server functions, never exposed to the browser.
export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// Client scoped to the caller's own JWT — used only to find out who is
// calling (auth.getUser()), never to read/write game data.
export function callerClient(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? '';
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function requireUser(req: Request) {
  const { data, error } = await callerClient(req).auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'Not authenticated');
  return data.user;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handle(req: Request, fn: (req: Request) => Promise<Response>) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  try {
    const res = await fn(req);
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    const res = json({ error: e instanceof Error ? e.message : String(e) }, status);
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
  }
}
