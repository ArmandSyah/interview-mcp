import { createClient } from '@supabase/supabase-js';
import type { Authenticate, Store } from './contracts.ts';

export function createBillingAuth(
  url: string,
  publishableKey: string,
  requestFetch: typeof fetch = fetch,
): Authenticate {
  return async (request, token) => {
    const client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, init) =>
          requestFetch(input, {
            ...init,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
          }),
      },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error) {
      if ((error.status ?? 0) >= 500 || error.name === 'AuthRetryableFetchError') {
        throw new Error('Authentication unavailable');
      }
      return null;
    }
    const user = data.user;
    if (
      !user || user.role !== 'authenticated' || user.is_anonymous || !user.email ||
      !user.email_confirmed_at
    ) {
      return null;
    }
    return { userId: user.id, email: user.email };
  };
}

export function createBillingStore(
  url: string,
  serviceKey: string,
  requestFetch: typeof fetch = fetch,
): Store {
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => requestFetch(input, { ...init, signal: AbortSignal.timeout(3500) }),
    },
  });
  return {
    async call(operation, args) {
      const { data, error } = await client.rpc('iwb_billing', { operation, args });
      if (error) throw new Error('Billing storage unavailable');
      return data;
    },
  };
}
