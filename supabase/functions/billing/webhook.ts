import { z } from 'zod';
import { matchesPlan, type Mode, paddleId, priceSchema, type Store } from './contracts.ts';

export async function verifySignature(
  body: Uint8Array,
  header: string | null,
  secret: string,
  now: number,
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(';').map((part) => part.trim().split('='));
  const timestamps = parts.filter(([name]) => name === 'ts');
  if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0][1] ?? '')) return false;
  const ts = timestamps[0][1];
  if (Math.abs(now / 1000 - Number(ts)) > 5) return false;
  const prefix = new TextEncoder().encode(`${ts}:`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  for (const [name, signature] of parts) {
    if (name !== 'h1' || !/^[a-f0-9]{64}$/i.test(signature ?? '')) continue;
    const bytes = Uint8Array.from(signature.match(/../g)!, (hex) => parseInt(hex, 16));
    if (await crypto.subtle.verify('HMAC', key, bytes, message)) return true;
  }
  return false;
}

const envelope = z.object({
  event_id: paddleId('evt'),
  event_type: z.string(),
  occurred_at: z.iso.datetime({ offset: true }),
  data: z.unknown(),
});
const subscription = z.object({
  id: paddleId('sub'),
  customer_id: paddleId('ctm'),
  status: z.enum(['active', 'canceled', 'past_due', 'paused', 'trialing']),
  currency_code: z.string(),
  collection_mode: z.string(),
  items: z.array(z.object({ quantity: z.number(), price: priceSchema })),
  current_billing_period: z.object({ ends_at: z.iso.datetime({ offset: true }) }).nullable(),
  scheduled_change: z.object({
    action: z.string(),
    effective_at: z.iso.datetime({ offset: true }),
  }).nullable(),
});
const eventTypes = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.canceled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.past_due',
  'subscription.trialing',
]);

export async function applyWebhook(
  body: Uint8Array,
  mode: Mode,
  priceId: string,
  store: Store,
): Promise<string> {
  const event = envelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  if (!eventTypes.has(event.event_type)) return 'ignored';
  const data = subscription.parse(event.data);
  const item = data.items[0];
  const matches = data.items.length === 1 && item.quantity === 1 &&
    data.currency_code === 'USD' && data.collection_mode === 'automatic' &&
    matchesPlan(item.price, priceId);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body))),
  )
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const result = z.object({
    outcome: z.enum(['applied', 'duplicate', 'stale', 'unbound', 'conflict']),
  }).parse(
    await store.call('apply_event', {
      mode,
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      subscription_id: data.id,
      customer_id: data.customer_id,
      status: data.status,
      price_id: item?.price.id ?? priceId,
      current_period_end: data.current_billing_period?.ends_at ?? null,
      scheduled_cancel_at: data.scheduled_change?.action === 'cancel'
        ? data.scheduled_change.effective_at
        : null,
      payload_hash: hash,
      price_matches: matches,
    }),
  );
  return result.outcome;
}
