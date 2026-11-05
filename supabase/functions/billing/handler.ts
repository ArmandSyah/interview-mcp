import { z } from 'zod';
import {
  type Authenticate,
  matchesPlan,
  type Mode,
  paddleId,
  type Provider,
  ProviderError,
  type Store,
  type Transaction,
} from './contracts.ts';
import { applyWebhook, verifySignature } from './webhook.ts';

export type Config = {
  mode: Mode;
  priceId: string;
  webhookSecret: string;
  allowedOrigins: string[];
};
const customerSchema = z.object({ customer_id: paddleId('ctm').nullable(), binding_id: z.uuid() });
const claimSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('claimed'), reservation_id: z.uuid() }),
  z.object({ state: z.literal('ready'), transaction_id: paddleId('txn') }),
  z.object({ state: z.enum(['pending', 'uncertain', 'subscribed']) }),
]);
const statusSchema = z.object({
  mode: z.enum(['sandbox', 'live']),
  status: z.string(),
  entitled: z.boolean(),
  currentPeriodEnd: z.string().nullable(),
  scheduledCancelAt: z.string().nullable(),
});
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}
async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, 'body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
function checkTransaction(transaction: Transaction, customerId: string, priceId: string): void {
  if (
    transaction.customer_id !== customerId || transaction.items.length !== 1 ||
    transaction.items[0].quantity !== 1 || !matchesPlan(transaction.items[0].price, priceId) ||
    transaction.currency_code !== 'USD' || transaction.collection_mode !== 'automatic' ||
    transaction.discount_id !== null
  ) throw new HttpError(409, 'checkout_requires_reconciliation');
  if (!['draft', 'ready'].includes(transaction.status)) {
    throw new HttpError(409, 'checkout_requires_reconciliation');
  }
}

export function createBillingHandler(
  config: Config,
  authenticate: Authenticate,
  store: Store,
  provider: Provider,
  now: () => number = Date.now,
): (request: Request) => Promise<Response> {
  paddleId('pri').parse(config.priceId);
  return async (request) => {
    const origin = request.headers.get('origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });
    const route = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    if (!['status', 'checkout', 'portal', 'webhook'].includes(route ?? '')) {
      return respond({ error: 'not_found' }, 404);
    }
    if (route !== 'webhook') {
      if (origin && !config.allowedOrigins.includes(origin)) {
        return respond({ error: 'origin_not_allowed' }, 403);
      }
      if (origin) headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set(
        'Access-Control-Allow-Headers',
        'authorization, apikey, content-type, x-client-info',
      );
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    }
    if (request.method !== (route === 'status' ? 'GET' : 'POST')) {
      return respond({ error: 'method_not_allowed' }, 405);
    }
    try {
      if (route === 'webhook') {
        const body = await readBody(request, 1024 * 1024);
        if (
          !await verifySignature(
            body,
            request.headers.get('paddle-signature'),
            config.webhookSecret,
            now(),
          )
        ) {
          return respond({ error: 'invalid_signature' }, 401);
        }
        const outcome = await applyWebhook(body, config.mode, config.priceId, store);
        if (outcome === 'unbound') return respond({ error: 'customer_not_bound' }, 503);
        if (outcome === 'conflict') return respond({ error: 'event_conflict' }, 409);
        return respond({ outcome });
      }
      const match = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i);
      if (!match) return respond({ error: 'sign_in_required' }, 401);
      const identity = await authenticate(request, match[1]);
      if (!identity) return respond({ error: 'sign_in_required' }, 401);
      z.uuid().parse(identity.userId);
      z.email().parse(identity.email);
      const args = { account_id: identity.userId, mode: config.mode };
      if (route === 'status') {
        const status = statusSchema.parse(await store.call('status', args));
        if (status.mode !== config.mode) throw new Error('Billing mode mismatch');
        return respond(status);
      }
      const raw = await readBody(request, 1024);
      z.strictObject({}).parse(JSON.parse(new TextDecoder().decode(raw) || '{}'));
      if (route === 'portal') {
        const customer = customerSchema.parse(await store.call('customer', args));
        if (!customer.customer_id) return respond({ error: 'no_billing_account' }, 409);
        return respond({ url: await provider.portal(customer.customer_id) });
      }
      if (!matchesPlan(await provider.price(), config.priceId)) {
        return respond({ error: 'price_not_configured' }, 503);
      }
      const claim = claimSchema.parse(await store.call('checkout_claim', args));
      if (claim.state !== 'claimed' && claim.state !== 'ready') {
        return respond({
          error: claim.state === 'subscribed'
            ? 'already_subscribed'
            : 'checkout_requires_reconciliation',
        }, 409);
      }
      if (claim.state === 'ready') {
        const customer = customerSchema.parse(await store.call('customer', args));
        if (!customer.customer_id) throw new Error('Missing customer binding');
        const transaction = await provider.transaction(claim.transaction_id);
        checkTransaction(transaction, customer.customer_id, config.priceId);
        return respond({ transactionId: transaction.id });
      }
      try {
        const customer = customerSchema.parse(await store.call('customer', args));
        let customerId = customer.customer_id;
        if (!customerId) {
          const created = await provider.createCustomer(identity.email, customer.binding_id);
          const bound = z.object({ customer_id: paddleId('ctm') }).parse(
            await store.call('bind_customer', {
              ...args,
              binding_id: customer.binding_id,
              customer_id: created,
            }),
          );
          customerId = bound.customer_id;
        }
        const transaction = await provider.createTransaction(customerId, claim.reservation_id);
        checkTransaction(transaction, customerId, config.priceId);
        await store.call('checkout_finish', {
          ...args,
          reservation_id: claim.reservation_id,
          transaction_id: transaction.id,
          checkout_url: null,
        });
        return respond({ transactionId: transaction.id });
      } catch (error) {
        // Never release a claim after an ambiguous provider result or storage failure.
        try {
          await store.call('checkout_fail', {
            ...args,
            reservation_id: claim.reservation_id,
            uncertain: !(error instanceof ProviderError) || error.uncertain,
          });
        } catch {
          // A retained pending claim also blocks an unsafe retry.
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof HttpError) return respond({ error: error.code }, error.status);
      if (
        error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError
      ) {
        return respond({ error: 'invalid_request_or_provider_data' }, 400);
      }
      return respond({ error: 'billing_unavailable' }, 503);
    }
  };
}
