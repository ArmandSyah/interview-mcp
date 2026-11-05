import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  type Price,
  type Provider,
  ProviderError,
  type Store,
  type Transaction,
} from './contracts.ts';
import { createBillingHandler } from './handler.ts';
import { createPaddleProvider } from './provider.ts';
import { applyWebhook, verifySignature } from './webhook.ts';
import { createBillingAuth, createBillingStore } from './store.ts';

const account = '11111111-1111-4111-8111-111111111111';
const binding = '22222222-2222-4222-8222-222222222222';
const reservation = '33333333-3333-4333-8333-333333333333';
const customer = `ctm_${'a'.repeat(26)}`;
const priceId = `pri_${'a'.repeat(26)}`;
const transactionId = `txn_${'a'.repeat(26)}`;
const origin = 'https://practice.example';
const secret = 'test-only-webhook-secret';
const timestamp = 1800000000000;
const price: Price = {
  id: priceId,
  status: 'active',
  unit_price: { amount: '1000', currency_code: 'USD' },
  billing_cycle: { interval: 'month', frequency: 1 },
  trial_period: null,
  unit_price_overrides: [],
};
const transaction: Transaction = {
  id: transactionId,
  customer_id: customer,
  status: 'ready',
  currency_code: 'USD',
  collection_mode: 'automatic',
  discount_id: null,
  items: [{ quantity: 1, price }],
  checkout: null,
};
function fixture() {
  const calls: { operation: string; args: Record<string, unknown> }[] = [];
  const providerCalls: string[] = [];
  let claim: Record<string, unknown> = { state: 'claimed', reservation_id: reservation };
  let outcome = 'applied';
  const store: Store = {
    call(operation, args) {
      calls.push({ operation, args });
      if (operation === 'customer') {
        return Promise.resolve({ customer_id: customer, binding_id: binding });
      }
      if (operation === 'checkout_claim') {
        const result = claim;
        claim = { state: 'pending' };
        return Promise.resolve(result);
      }
      if (operation === 'checkout_finish') {
        claim = { state: 'ready', transaction_id: args.transaction_id };
      }
      if (operation === 'status') {
        return Promise.resolve({
          mode: 'sandbox',
          status: 'none',
          entitled: false,
          currentPeriodEnd: null,
          scheduledCancelAt: null,
        });
      }
      if (operation === 'apply_event') return Promise.resolve({ outcome });
      return Promise.resolve({});
    },
  };
  const provider: Provider = {
    price: () => Promise.resolve(price),
    createCustomer: () => Promise.resolve(customer),
    createTransaction: () => {
      providerCalls.push('create');
      return Promise.resolve(transaction);
    },
    transaction: () => Promise.resolve(transaction),
    portal: (id) => {
      providerCalls.push(id);
      return Promise.resolve('https://sandbox-customer-portal.paddle.com/example');
    },
  };
  const handler = createBillingHandler(
    { mode: 'sandbox', priceId, webhookSecret: secret, allowedOrigins: [origin] },
    (_request, token) =>
      Promise.resolve(token === 'valid' ? { userId: account, email: 'owner@example.com' } : null),
    store,
    provider,
    () => timestamp,
  );
  return {
    handler,
    store,
    provider,
    calls,
    providerCalls,
    setOutcome: (value: string) => outcome = value,
    setClaim: (value: Record<string, unknown>) => claim = value,
  };
}
function request(route: string, body: unknown = {}, token = 'valid', requestOrigin = origin) {
  return new Request(`https://project.example/functions/v1/billing/${route}`, {
    method: route === 'status' ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: requestOrigin,
      'Content-Type': 'application/json',
    },
    body: route === 'status' ? undefined : JSON.stringify(body),
  });
}
function event(status = 'active', occurredAt = '2026-11-05T12:00:00Z') {
  return {
    event_id: `evt_${'a'.repeat(26)}`,
    event_type: 'subscription.updated',
    occurred_at: occurredAt,
    data: {
      id: `sub_${'a'.repeat(26)}`,
      customer_id: customer,
      status,
      currency_code: 'USD',
      collection_mode: 'automatic',
      items: [{ quantity: 1, price }],
      current_billing_period: { ends_at: '2026-12-05T12:00:00Z' },
      scheduled_change: null,
      custom_data: { account_id: 'attacker-controlled' },
    },
  };
}
async function signed(body: Uint8Array, ts = timestamp / 1000): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prefix = new TextEncoder().encode(`${ts}:`);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix);
  payload.set(body, prefix.length);
  const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return `ts=${ts};h1=${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
async function webhookRequest(payload: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return new Request('https://project.example/functions/v1/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'Paddle-Signature': await signed(body) },
  });
}

Deno.test('browser routes reject missing identity, wrong origin, and caller billing fields', async () => {
  for (
    const [req, expected] of [
      [request('checkout', {}, 'invalid'), 401],
      [request('checkout', {}, 'valid', 'https://attacker.example'), 403],
      [request('checkout', { price_id: 'cheap', account_id: account }), 400],
      [request('portal', { customer_id: customer }), 400],
    ] as const
  ) {
    const f = fixture();
    assertEquals((await f.handler(req)).status, expected);
    assertEquals(f.calls.length, 0);
    assertEquals(f.providerCalls.length, 0);
  }
});
Deno.test('allowlisted preflight and owned status do not grant access', async () => {
  const f = fixture();
  const preflight = await f.handler(
    new Request('https://project.example/billing/checkout', {
      method: 'OPTIONS',
      headers: { Origin: origin },
    }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  const response = await f.handler(request('status'));
  assertEquals((await response.json()).entitled, false);
  assertEquals(f.calls[0].args, { account_id: account, mode: 'sandbox' });
});
Deno.test('checkout reserves once, reuses the transaction, and never writes entitlement', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.handler(request('checkout')),
    f.handler(request('checkout')),
  ]);
  assertEquals(results.map((result) => result.status).sort(), [200, 409]);
  assertEquals(f.providerCalls, ['create']);
  const retry = await f.handler(request('checkout'));
  assertEquals(await retry.json(), { transactionId });
  assertEquals(f.providerCalls, ['create']);
  assert(f.calls.every((call) => call.operation !== 'apply_event'));
});
Deno.test('checkout checks provider price and saved customer ownership', async () => {
  const f = fixture();
  f.provider.price = () =>
    Promise.resolve({ ...price, unit_price: { amount: '100', currency_code: 'USD' } });
  assertEquals((await f.handler(request('checkout'))).status, 503);
  assertEquals(f.calls.length, 0);
  f.provider.price = () => Promise.resolve(price);
  f.setClaim({ state: 'ready', transaction_id: transactionId });
  f.provider.transaction = () =>
    Promise.resolve({ ...transaction, customer_id: `ctm_${'b'.repeat(26)}` });
  assertEquals((await f.handler(request('checkout'))).status, 409);
});
Deno.test('portal uses only the authenticated account customer', async () => {
  const f = fixture();
  assertEquals((await f.handler(request('portal'))).status, 200);
  assertEquals(f.calls[0].args.account_id, account);
  assertEquals(f.providerCalls, [customer]);
});
Deno.test('customer binding uses the stored canonical customer after a concurrent bind', async () => {
  const f = fixture();
  const original = f.store.call;
  const orphan = `ctm_${'b'.repeat(26)}`;
  f.store.call = (operation, args) => {
    if (operation === 'customer') {
      return Promise.resolve({ customer_id: null, binding_id: binding });
    }
    if (operation === 'bind_customer') {
      assertEquals(args.customer_id, orphan);
      assertEquals(args.account_id, account);
      return Promise.resolve({ customer_id: customer });
    }
    return original(operation, args);
  };
  f.provider.createCustomer = (email, bindingId) => {
    assertEquals(email, 'owner@example.com');
    assertEquals(bindingId, binding);
    return Promise.resolve(orphan);
  };
  f.provider.createTransaction = (customerId) => {
    assertEquals(customerId, customer);
    return Promise.resolve(transaction);
  };
  assertEquals((await f.handler(request('checkout'))).status, 200);
});
Deno.test('a failed transaction save never returns checkout or releases the reservation', async () => {
  const f = fixture();
  const original = f.store.call;
  f.store.call = (operation, args) => {
    if (operation === 'checkout_finish') return Promise.reject(new Error('database down'));
    return original(operation, args);
  };
  const response = await f.handler(request('checkout'));
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: 'billing_unavailable' });
  assertEquals(f.calls.find((call) => call.operation === 'checkout_fail')?.args.uncertain, true);
});
Deno.test('provider timeout retains uncertain reservation, definitive rejection releases it', async () => {
  for (const uncertain of [true, false]) {
    const f = fixture();
    f.provider.createTransaction = () => Promise.reject(new ProviderError(uncertain));
    assertEquals((await f.handler(request('checkout'))).status, 503);
    const failure = f.calls.find((call) => call.operation === 'checkout_fail');
    assertEquals(failure?.args.uncertain, uncertain);
  }
});
Deno.test('signature verification rejects changed bytes, stale and future replay, and duplicate timestamps', async () => {
  const body = new TextEncoder().encode('{"amount":10}');
  const header = await signed(body);
  assert(await verifySignature(body, header, secret, timestamp));
  assert(
    !await verifySignature(new TextEncoder().encode('{"amount":1}'), header, secret, timestamp),
  );
  assert(!await verifySignature(body, header, secret, timestamp + 6000));
  assert(!await verifySignature(body, header, secret, timestamp - 6000));
  assert(!await verifySignature(body, `${header};ts=${timestamp / 1000}`, secret, timestamp));
  assert(await verifySignature(body, `${header};h1=${'0'.repeat(64)}`, secret, timestamp));
});
Deno.test('webhook verifies before storage, ignores account metadata, and persists exact event order', async () => {
  const f = fixture();
  const bad = new Request('https://project.example/billing/webhook', {
    method: 'POST',
    body: '{}',
  });
  assertEquals((await f.handler(bad)).status, 401);
  assertEquals(f.calls.length, 0);
  assertEquals((await f.handler(await webhookRequest(event()))).status, 200);
  const args = f.calls[0].args;
  assertEquals(args.customer_id, customer);
  assertEquals(args.account_id, undefined);
  assertEquals(args.occurred_at, '2026-11-05T12:00:00Z');
  assertEquals(args.price_matches, true);
  assertEquals(args.mode, 'sandbox');
  assertEquals(String(args.payload_hash).length, 64);
});
Deno.test('duplicate and stale events acknowledge; unbound and storage failures retry', async () => {
  const f = fixture();
  for (
    const [outcome, status] of [['duplicate', 200], ['stale', 200], ['unbound', 503], [
      'conflict',
      409,
    ]] as const
  ) {
    f.setOutcome(outcome);
    assertEquals((await f.handler(await webhookRequest(event()))).status, status);
  }
  f.store.call = () => Promise.reject(new Error('database down'));
  assertEquals((await f.handler(await webhookRequest(event()))).status, 503);
});
Deno.test('changed price updates entitlement eligibility to false rather than ignoring the event', async () => {
  const f = fixture();
  const payload = event();
  payload.data.items = [{ quantity: 2, price }];
  assertEquals((await f.handler(await webhookRequest(payload))).status, 200);
  assertEquals(f.calls[0].args.price_matches, false);
  const unrelated = { ...event(), event_type: 'transaction.completed' };
  assertEquals(
    await applyWebhook(
      new TextEncoder().encode(JSON.stringify(unrelated)),
      'sandbox',
      priceId,
      f.store,
    ),
    'ignored',
  );
  assertEquals(f.calls.length, 1);
});
Deno.test('HTTP adapter uses sandbox, fixed price, and refuses foreign portal links', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const requestFetch: typeof fetch = (input, init) => {
    seen.push({ url: String(input), init });
    if (String(input).endsWith('/transactions')) {
      return Promise.resolve(Response.json({ data: transaction }));
    }
    return Promise.resolve(
      Response.json({
        data: {
          customer_id: customer,
          urls: { general: { overview: 'https://attacker.example' } },
        },
      }),
    );
  };
  const provider = createPaddleProvider({
    mode: 'sandbox',
    apiKey: 'test-only',
    priceId,
    checkoutUrl: `${origin}/account`,
  }, requestFetch);
  await provider.createTransaction(customer, reservation);
  assertEquals(seen[0].url, 'https://sandbox-api.paddle.com/transactions');
  const payload = JSON.parse(String(seen[0].init?.body));
  assertEquals(payload.items, [{ price_id: priceId, quantity: 1 }]);
  assertEquals(payload.customer_id, customer);
  assertEquals(payload.currency_code, 'USD');
  await assertRejects(() => provider.portal(customer), ProviderError);
});
Deno.test('HTTP adapter treats transport and server failures as uncertain', async () => {
  for (const status of [400, 408, 429, 500]) {
    const provider = createPaddleProvider({
      mode: 'sandbox',
      apiKey: 'test-only',
      priceId,
      checkoutUrl: origin,
    }, () => Promise.resolve(new Response(null, { status })));
    const error = await assertRejects(
      () => provider.createTransaction(customer, reservation),
      ProviderError,
    );
    assertEquals(error.uncertain, status === 408 || status >= 500);
  }
});
Deno.test('Supabase adapters verify users and use the service-only dispatcher', async () => {
  const user = {
    id: account,
    email: 'owner@example.com',
    role: 'authenticated',
    email_confirmed_at: '2026-11-01T00:00:00Z',
    is_anonymous: false,
  };
  const auth = createBillingAuth(
    'https://project.example',
    'public-key',
    () => Promise.resolve(Response.json(user)),
  );
  assertEquals(await auth(request('status'), 'valid'), { userId: account, email: user.email });
  const anonymous = createBillingAuth(
    'https://project.example',
    'public-key',
    () => Promise.resolve(Response.json({ ...user, is_anonymous: true })),
  );
  assertEquals(await anonymous(request('status'), 'valid'), null);
  const unconfirmed = createBillingAuth(
    'https://project.example',
    'public-key',
    () => Promise.resolve(Response.json({ ...user, email_confirmed_at: null })),
  );
  assertEquals(await unconfirmed(request('status'), 'valid'), null);
  const store = createBillingStore('https://project.example', 'service-key', (input, init) => {
    assertEquals(String(input), 'https://project.example/rest/v1/rpc/iwb_billing');
    assertEquals(JSON.parse(String(init?.body)), {
      operation: 'status',
      args: { account_id: account, mode: 'sandbox' },
    });
    return Promise.resolve(Response.json({ status: 'none' }));
  });
  assertEquals(await store.call('status', { account_id: account, mode: 'sandbox' }), {
    status: 'none',
  });
});
