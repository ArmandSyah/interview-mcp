import { createBillingHandler } from './handler.ts';
import { createPaddleProvider } from './provider.ts';
import { createBillingAuth, createBillingStore } from './store.ts';

function configuredHandler(): (request: Request) => Promise<Response> {
  const mode = Deno.env.get('BILLING_MODE') ?? 'sandbox';
  if (mode !== 'sandbox' && mode !== 'live') throw new Error('Invalid mode');
  // An explicit second flag prevents accidental live use of copied configuration.
  if (mode === 'live' && Deno.env.get('BILLING_LIVE_ENABLED') !== 'true') {
    throw new Error('Live billing disabled');
  }
  const required = (name: string): string => {
    const value = Deno.env.get(name);
    if (!value) throw new Error('Missing configuration');
    return value;
  };
  const url = required('SUPABASE_URL');
  const publishableKey = required('SUPABASE_ANON_KEY');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = required('PADDLE_API_KEY');
  const webhookSecret = required('PADDLE_WEBHOOK_SECRET');
  const priceId = required('PADDLE_PRICE_ID');
  const checkoutUrl = new URL(required('PADDLE_CHECKOUT_URL'));
  const allowedOrigins = required('BILLING_ALLOWED_ORIGINS').split(',').map((value) =>
    value.trim()
  );
  if (
    checkoutUrl.protocol !== 'https:' || checkoutUrl.username || checkoutUrl.password ||
    checkoutUrl.hash || checkoutUrl.search ||
    !allowedOrigins.includes(checkoutUrl.origin) || allowedOrigins.some((origin) => {
      const parsed = new URL(origin);
      return parsed.origin !== origin || parsed.protocol !== 'https:';
    })
  ) throw new Error('Invalid browser configuration');
  const project = new URL(url);
  if (project.protocol !== 'https:' || project.origin !== url) {
    throw new Error('Invalid project URL');
  }
  return createBillingHandler(
    { mode, priceId, webhookSecret, allowedOrigins },
    createBillingAuth(url, publishableKey),
    createBillingStore(url, serviceKey),
    createPaddleProvider({ mode, apiKey, priceId, checkoutUrl: checkoutUrl.href }),
  );
}

let handler: (request: Request) => Promise<Response>;
try {
  handler = configuredHandler();
} catch {
  handler = () =>
    Promise.resolve(Response.json({ error: 'billing_not_configured' }, { status: 503 }));
}
Deno.serve(handler);
