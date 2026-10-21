import { createClient } from '@supabase/supabase-js';

export type Identity = { userId: string; issuer: string };
export type Authenticate = (request: Request, token: string) => Promise<Identity | null>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validIdentity(identity: Identity): boolean {
  return uuid.test(identity.userId) && identity.issuer.length > 0;
}

export function createSupabaseAuthenticator(
  url: string,
  publishableKey: string,
  requestFetch: typeof fetch = fetch,
): Authenticate {
  const project = new URL(url);
  if (
    !publishableKey || project.username || project.password || project.search || project.hash ||
    (project.protocol !== 'https:' &&
      !(project.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(project.hostname)))
  ) throw new Error('Invalid Supabase authentication configuration');

  return async (request, token) => {
    // Each request has its own user client. No token enters shared worker state.
    const client = createClient(project.origin, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) =>
          requestFetch(input, {
            ...init,
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(5000),
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
      },
    });
    // Do not trust an unverified JWT payload or user-editable account metadata.
    const { data, error } = await client.auth.getUser(token);
    if (error) {
      if ((error.status ?? 0) >= 500 || error.name === 'AuthRetryableFetchError') {
        throw new Error('Authentication service unavailable');
      }
      return null;
    }
    const user = data.user;
    if (!user || user.role !== 'authenticated' || user.is_anonymous || !uuid.test(user.id)) {
      return null;
    }
    return { userId: user.id, issuer: `${project.origin}/auth/v1` };
  };
}
