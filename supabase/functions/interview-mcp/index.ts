import { createSupabaseAuthenticator } from './auth.ts';
import { createHandler } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const authenticate = url && key ? createSupabaseAuthenticator(url, key) : null;

Deno.serve(
  authenticate
    ? createHandler(authenticate)
    : () => Response.json({ error: 'Authentication is not configured' }, { status: 503 }),
);
