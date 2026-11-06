# Paddle sandbox integration

This branch adds payment code for a proposed USD 10 monthly plan.
Paddle is the selected provider for sandbox tests.
The code defaults to sandbox mode. It does not charge real cards in that mode.
The sandbox catalog, server secrets, and webhook destination are configured.
No live payment service is active.
See the [sandbox deployment record](deployments/2026-11-05-billing.md) for verified results and unfinished checks.
The existing desktop app and MCP routes keep their current behavior.

The new `billing` Edge Function handles checkout, account status, the customer portal, and subscription webhooks.
The website calls this function with the signed-in user's Supabase access token.
The function verifies that token through Supabase Auth. Anonymous users and users without a confirmed email cannot use account routes.
The function derives account ownership from the verified user ID.
It never accepts account IDs, customer IDs, prices, or redirect URLs from browser request bodies.

## Routes

The route prefix is `/functions/v1/billing`.
Account responses have `Cache-Control: no-store`.
`POST` account routes accept an empty JSON object. They reject unknown fields.

| Route | Result | Effect |
| --- | --- | --- |
| `GET /status` | `{mode,status,entitled,currentPeriodEnd,scheduledCancelAt}` | Reads this account's billing state. No subscription returns `status: "none"`. |
| `POST /checkout` | `{transactionId}` | Reserves one checkout, binds a provider customer, and creates or reuses a transaction. |
| `POST /portal` | `{url}` | Creates a temporary portal link for the account's bound customer. The function does not store this link. |
| `POST /webhook` | `{outcome}` | Verifies a Paddle signature and stores a subscription event. It needs no Supabase user token. |

`401` means the identity or webhook signature failed verification.
`403` means the browser origin is not allowed. `400` means input or provider data failed validation.
`409` means a subscription exists or checkout requires reconciliation. The response identifies the reason.
`413` means the body exceeds its limit. `503` means configuration, storage, or a provider service is unavailable.
The webhook returns `503` for an unbound customer and `409` for conflicting events.
Paddle can retry these events. No response contains a provider secret or a raw provider error.

## Price and customer rules

The server reads one configured Paddle price before checkout.
That price must be active, cost `1000` cents in USD, and recur once each month.
It must have no trial or regional price overrides.
The server creates one item with quantity one and automatic payment collection.
Tax follows the configured Paddle price and account rules. This code fixes the base price, not a universal tax-inclusive total.
The browser does not choose a price or a customer.

The database creates a stable binding ID for each account and mode.
The server adds that ID to a new Paddle customer's metadata.
The database binds the customer ID before the server creates a transaction.
An existing binding wins concurrent requests. The server uses that canonical customer ID.
A customer can belong to only one account within each mode.
An account may have no provider customer before its first checkout.

Webhook ownership comes from the stored customer binding.
Provider metadata and the customer's email do not establish ownership.
Sandbox and live records have separate keys. A sandbox event cannot create a live entitlement.
Portal links require the same account check and stored customer binding.

## Subscription events

The handler verifies HMAC-SHA256 over the timestamp and exact request bytes before JSON parsing.
It applies a five-second timestamp tolerance and checks signatures with WebCrypto.
The database stores the event ID and a SHA-256 body hash. It does not store the raw body.
The handler accepts subscription lifecycle events. It ignores other verified event types.
These rules follow Paddle's [signature instructions](https://developer.paddle.com/webhooks/about/signature-verification/).

The database applies each event atomically and compares its provider timestamp with the stored subscription timestamp.
An exact duplicate has no additional effect. An older event cannot replace newer subscription state.
Distinct events with equal timestamps have no additional state effect when all stored subscription facts match.
The comparison includes status, price, price eligibility, billing-period end, and scheduled cancellation.
Dates compare as timestamps, including equivalent time zones and null dates.
Different facts require reconciliation and remove entitlement until a newer event resolves the conflict.
A matching event cannot clear an existing reconciliation flag. Earlier event records remain unchanged.
A reused event ID with different content also produces a conflict.
An unbound event remains available for retry after the server binds its customer.
Paddle documents duplicate delivery and event order in its [access guide](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/).

The initial policy grants entitlement only to an active subscription with the configured plan and a future billing-period end.
Trial, paused, canceled, past-due, changed-price, and unresolved states do not grant entitlement.
A scheduled cancellation keeps access until its effective time or the billing-period end, whichever comes first.
This strict past-due policy is an application choice. Paddle also supports grace-period policies.
Checkout redirects and browser completion events never grant entitlement.
Existing local exercises remain available without a subscription.

## Configuration

These values belong to the Edge Function environment unless the table states otherwise.
The sandbox deployment uses these settings. Live settings remain disabled.

| Variable | Purpose |
| --- | --- |
| `BILLING_MODE` | `sandbox` by default. Persistent records include this mode. |
| `BILLING_LIVE_ENABLED` | Must equal `true` before the handler accepts `BILLING_MODE=live`. Leave unset during development. |
| `SUPABASE_URL` | HTTPS project origin. |
| `SUPABASE_ANON_KEY` | Public project key for token verification. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for the private billing dispatcher. Never place it in browser code. |
| `PADDLE_API_KEY` | Server-only key from the matching Paddle environment. |
| `PADDLE_WEBHOOK_SECRET` | Secret for the matching notification destination. |
| `PADDLE_PRICE_ID` | The fixed USD 10 monthly price ID. |
| `PADDLE_CHECKOUT_URL` | Expected account payment page on an allowed HTTPS origin. No query or fragment. |
| `BILLING_ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins. Wildcards are not accepted. |
| Website Paddle token | Public sandbox token with the `test_` prefix. This is separate from the secret API key. |

The server API key needs `price.read`, `customer.write`, `transaction.read`, `transaction.write`, and `customer_portal_session.write`.
Checkout recovery also needs `subscription.read` to verify the subscription's current state.
These permissions belong to the server API key. The public website token does not use them.

The preview origin is `https://interview-workbench-preview.higher-visio-3179.chatgpt.site`.
The webhook needs gateway JWT verification disabled for this function alone.
Its handler verifies Paddle signatures. Account routes still verify Supabase tokens.
The existing MCP function does not need a CORS or authentication change.

Paddle requires a payment page and account configuration for checkout.
Configure the page as the payment link in the matching Paddle environment.
Set the account's `default_url` to the same page as `PADDLE_CHECKOUT_URL`.
The transaction request omits `checkout.url` and uses that account default.
An explicit transaction override requires domain approval and can return `transaction_checkout_url_domain_is_not_approved` even when the sandbox default accepts the URL.
Paddle documents the [override error](https://developer.paddle.com/errors/transactions/transaction_checkout_url_domain_is_not_approved/) and [sandbox default URL rules](https://developer.paddle.com/api-reference/settings/update-checkout-url/).

Before returning a draft or ready transaction, the adapter checks its payment link.
The link must use the configured HTTPS origin and path. Its `_ptxn` parameter must identify that transaction.
A missing or mismatched link retains the reservation because Paddle may already have created the transaction.
`PADDLE_CHECKOUT_URL` remains a destination check. It does not override the provider's account setting.
Use the [transaction API](https://developer.paddle.com/api-reference/transactions/create-transaction/) for server-created checkout transactions.
Use the [portal API](https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session/) for temporary customer links.

The website initializes Paddle.js with its public sandbox token.
It calls `Paddle.Environment.set('sandbox')` before `Paddle.Initialize({token})`.
After `/checkout` succeeds, it calls `Paddle.Checkout.open({transactionId,settings:{allowLogout:false,showAddDiscounts:false}})`.
The website must read `/status` after checkout. A browser callback is not proof of payment.
See Paddle's [overlay guide](https://developer.paddle.com/build/checkout/build-overlay-checkout/) and [client token guide](https://developer.paddle.com/paddle-js/about/client-side-tokens/).

## Storage contract

### Payment data and secrets

Paddle hosts checkout and the HTTPS customer portal. The application does not receive or store card numbers or security codes.
The application does not store cardholder names, card expiry dates, payment-method tokens, or billing addresses.
Supabase Auth stores the account email. The server sends that email to Paddle when it creates a customer.
Billing tables contain account links, provider identifiers, normalized subscription facts, and event hashes.
They contain no customer email or raw webhook body. The billing code does not log request bodies, tokens, or provider responses.

Keep payment API keys, webhook secrets, and Supabase service keys in the Edge Function environment.
The website accepts only public Supabase keys and a public Paddle sandbox client token.
Both server and website restrict portal links to the exact HTTPS Paddle host for their environment.
Do not log authorization headers, signed portal links, passwords, or payment data in later changes.

On 2026-11-05, Gitleaks found no secrets in 120 commits reachable from the branch head.
Separate scans found none in the new billing source, website public files, or generated website bundle.
The inspected public website configuration contained empty credential fields and sandbox mode.
These checks cover the local source and build. They do not inspect future deployment secrets or provider accounts.

### Dispatcher

The service role calls `public.iwb_billing(operation text, args jsonb)`.
Each operation includes `mode`. Account operations also include the verified `account_id`.
The browser cannot call this dispatcher with its public key or user token.

| Operation | Additional arguments | Result |
| --- | --- | --- |
| `customer` | None | `{customer_id,binding_id}`. Customer ID may be null. |
| `bind_customer` | `binding_id,customer_id` | `{customer_id}` with the canonical binding. |
| `checkout_claim` | None | `claimed` with `reservation_id`, `ready` with `reservation_id` and `transaction_id`, or `pending`, `uncertain`, or `subscribed`. |
| `checkout_finish` | `reservation_id,transaction_id,checkout_url` | Persists the transaction against its reservation. This handler passes a null URL. |
| `checkout_fail` | `reservation_id,uncertain` | Releases a definite failure or retains an uncertain reservation. |
| `checkout_recover` | Provider facts and saved identifiers listed below | `claimed` with a new `reservation_id`, or `uncertain` with no state change. |
| `status` | None | The account status response described above. |
| `apply_event` | Event fields listed below | `{outcome}` as `applied`, `duplicate`, `stale`, `unbound`, or `conflict`. |

`apply_event` accepts `event_id`, `occurred_at`, `subscription_id`, `customer_id`, `status`, and `price_id`.
It also accepts `current_period_end`, `scheduled_cancel_at`, `payload_hash`, and the server-checked `price_matches` flag.
Period and cancellation dates may be null.
The dispatcher resolves account ownership from the customer ID. It does not accept an event account ID.

`checkout_recover` accepts `reservation_id`, `transaction_id`, `customer_id`, and `transaction_status`.
It also accepts `subscription_id`, `subscription_status`, and `subscription_canceled_at`.
The Edge Function supplies these facts from authenticated provider reads. The browser supplies none of them.
For a canceled transaction without a subscription, all three subscription fields are null.
For a completed transaction, the subscription fields identify its canceled subscription and cancellation date.
The date must be present, finite, and no later than the current time.

## Checkout recovery

A checkout reservation prevents concurrent requests from creating separate transactions.
A repeat request reuses a draft or ready transaction after provider validation.
The server verifies the saved transaction ID, bound customer, currency, item quantity, and configured price.
The [transaction API](https://developer.paddle.com/api-reference/transactions/get-transaction/) supplies the transaction state and related subscription ID.

The handler can replace a canceled transaction that has no subscription.
It can also replace a completed transaction whose exact subscription Paddle confirms as canceled.
The server verifies the subscription ID, customer ID, cancellation status, and cancellation date.
The database must already contain that subscription's cancellation event for the same account.
Paddle supplies these fields through its [subscription API](https://developer.paddle.com/api-reference/subscriptions/get-subscription/).
Paddle does not permit a canceled subscription to restart, as its [cancellation guide](https://developer.paddle.com/api-reference/subscriptions/cancel-subscription/) explains.

The database rejects recovery if another subscription for the account is unresolved or has any status except canceled.
An expired active subscription remains blocked because a renewal can still occur.
An active subscription with a scheduled cancellation also remains blocked until cancellation takes effect and its webhook arrives.
Recovery compares the saved reservation and transaction IDs before it reserves a replacement.
That comparison and the replacement occur in one database transaction. Concurrent requests can produce only one replacement reservation.
Recovery does not grant entitlement or erase subscription history.

## Remaining recovery limits and validation

Timeouts, uncertain provider responses, and failed database writes retain the reservation.
The handler does not clear reservations after a timer.
Pending and uncertain reservations still require operator recovery. This branch does not yet provide those commands.
Missing cancellation webhooks also prevent replacement until the database receives the event.

Future operator recovery must inspect provider state using the saved transaction or server-created reservation metadata.
It must confirm ownership before it repairs a reservation. It must not create a replacement after an unverified timeout.
Refunds, disputes, missed-event reconciliation, request limits, and launch policies need separate work before live billing.
Provider credentials, catalog setup, and notification setup are complete in sandbox.
The real sandbox checkout opens, but the browser test stopped before payment submission.
Payment completion, webhook delivery, portal access, cancellation, and replacement checkout still need real provider tests.
No paid service is active.

The focused Deno tests use injected HTTP responses. They make no Paddle network requests.
They cover account access, customer ownership, fixed prices, concurrent checkout, signatures, retries, and storage failures.
They also cover canceled subscriptions, replacement races, changed ownership, missing cancellation proof, and uncertain replacement results.
Separate PostgreSQL tests verify event order, reservation replacement, and a subscription event that arrives during recovery.

```sh
cd supabase
deno check functions/billing/*.ts
deno test --allow-env functions/billing/
```

Sources checked: 2026-11-05.
