import { z } from 'zod';
import {
  type Mode,
  paddleId,
  priceSchema,
  type Provider,
  ProviderError,
  subscriptionSchema,
  transactionSchema,
} from './contracts.ts';

export function createPaddleProvider(
  config: { mode: Mode; apiKey: string; priceId: string; checkoutUrl: string },
  requestFetch: typeof fetch = fetch,
): Provider {
  const base = config.mode === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';
  const expectedCheckout = new URL(config.checkoutUrl);
  const parseTransaction = (value: unknown) => {
    const transaction = transactionSchema.parse(value);
    if (['draft', 'ready'].includes(transaction.status)) {
      try {
        const url = new URL(transaction.checkout?.url ?? '');
        if (
          url.protocol !== 'https:' || url.origin !== expectedCheckout.origin ||
          url.pathname !== expectedCheckout.pathname || url.username || url.password || url.hash ||
          url.searchParams.getAll('_ptxn').length !== 1 ||
          url.searchParams.get('_ptxn') !== transaction.id
        ) throw new Error('Unexpected payment link');
      } catch {
        // Creation may have succeeded. Keep its reservation if the account link is wrong.
        throw new ProviderError(true);
      }
    }
    return transaction;
  };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await requestFetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Paddle-Version': '1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new ProviderError(true);
    }
    if (!response.ok) {
      // A timeout or server failure can follow a committed provider operation.
      throw new ProviderError(response.status >= 500 || response.status === 408);
    }
    try {
      return z.object({ data: z.unknown() }).parse(await response.json()).data;
    } catch {
      throw new ProviderError(true);
    }
  };
  return {
    async price() {
      return priceSchema.parse(await request(`/prices/${config.priceId}`));
    },
    async createCustomer(email, bindingId) {
      const customer = z.object({ id: paddleId('ctm') }).parse(
        await request('/customers', {
          email,
          custom_data: { iwb_binding: bindingId },
        }),
      );
      return customer.id;
    },
    async createTransaction(customerId, reservationId) {
      return parseTransaction(
        await request('/transactions', {
          customer_id: customerId,
          items: [{ price_id: config.priceId, quantity: 1 }],
          currency_code: 'USD',
          collection_mode: 'automatic',
          discount_id: null,
          // Use the account default. A custom checkout.url requires separate domain approval.
          custom_data: { iwb_reservation: reservationId },
        }),
      );
    },
    async transaction(id) {
      paddleId('txn').parse(id);
      return parseTransaction(await request(`/transactions/${id}`));
    },
    async subscription(id) {
      paddleId('sub').parse(id);
      return subscriptionSchema.parse(await request(`/subscriptions/${id}`));
    },
    async portal(customerId) {
      paddleId('ctm').parse(customerId);
      const portal = z.object({
        customer_id: paddleId('ctm'),
        urls: z.object({ general: z.object({ overview: z.string().url() }) }),
      }).parse(await request(`/customers/${customerId}/portal-sessions`, {}));
      const url = new URL(portal.urls.general.overview);
      const host = config.mode === 'sandbox'
        ? 'sandbox-customer-portal.paddle.com'
        : 'customer-portal.paddle.com';
      if (
        portal.customer_id !== customerId || url.protocol !== 'https:' || url.hostname !== host ||
        url.username || url.password || url.port
      ) throw new ProviderError(true);
      return url.href;
    },
  };
}
