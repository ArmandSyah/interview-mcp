import { z } from 'zod';

export type Mode = 'sandbox' | 'live';
export type Identity = { userId: string; email: string };
export type Authenticate = (request: Request, token: string) => Promise<Identity | null>;
export type Store = {
  call(operation: string, args: Record<string, unknown>): Promise<unknown>;
};
export const paddleId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{26}$`));
export const priceSchema = z.object({
  id: paddleId('pri'),
  status: z.string(),
  unit_price: z.object({ amount: z.string(), currency_code: z.string() }),
  billing_cycle: z.object({ interval: z.string(), frequency: z.number() }).nullable(),
  trial_period: z.unknown().optional(),
  unit_price_overrides: z.array(z.unknown()),
});
export type Price = z.infer<typeof priceSchema>;
export function matchesPlan(price: Price, configuredId: string): boolean {
  return price.id === configuredId && price.status === 'active' &&
    price.unit_price.amount === '1000' && price.unit_price.currency_code === 'USD' &&
    price.billing_cycle?.interval === 'month' && price.billing_cycle.frequency === 1 &&
    price.trial_period === null && price.unit_price_overrides.length === 0;
}
export const transactionSchema = z.object({
  id: paddleId('txn'),
  status: z.string(),
  customer_id: paddleId('ctm'),
  subscription_id: paddleId('sub').nullable(),
  currency_code: z.string(),
  collection_mode: z.string(),
  discount_id: z.string().nullable(),
  items: z.array(z.object({ quantity: z.number(), price: priceSchema })),
  checkout: z.object({ url: z.string().nullable() }).nullable(),
});
export type Transaction = z.infer<typeof transactionSchema>;
export const subscriptionSchema = z.object({
  id: paddleId('sub'),
  customer_id: paddleId('ctm'),
  status: z.enum(['active', 'canceled', 'past_due', 'paused', 'trialing']),
  canceled_at: z.iso.datetime({ offset: true }).nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export interface Provider {
  price(): Promise<Price>;
  createCustomer(email: string, bindingId: string): Promise<string>;
  createTransaction(customerId: string, reservationId: string): Promise<Transaction>;
  transaction(id: string): Promise<Transaction>;
  subscription(id: string): Promise<Subscription>;
  portal(customerId: string): Promise<string>;
}
export class ProviderError extends Error {
  constructor(readonly uncertain: boolean) {
    super('Payment provider unavailable');
  }
}
