# Subscription, signup, and download options

Research date: 2026-11-05. Status: proposal. Paddle sandbox is selected for the first integration.
No merchant account, public checkout, or new account service is provisioned by this document.

## Scope and existing behavior

The new requirement is an optional service at USD 10 each month, with website signup and desktop account access.
Hosted AI assistance adds server costs and access checks. It does not replace local practice.
The earlier release plan proposed paid question packs. A subscription needs a separate access contract.

Keep the free editor, whiteboard, saved work, built-in hints, and local execution.
Keep Ollama and user-supplied AI keys available under their existing terms.
Keep installer downloads available without signup. Signup grants an account, not a payment entitlement.
Do not upload existing local practice merely because a user signs in or subscribes.

Existing pack licenses require `perpetual: true` in `server/distribution/manifest.py`.
Their `updates_until` date limits new releases, not continued use.
Do not convert these licenses into subscriptions or remove installed packs after cancellation.

## Recommendation

Use Cloudflare Pages for the static website and GitHub Releases for installers.
Use the existing Supabase project for Auth, account records, and separate billing Edge Functions.
Use Paddle sandbox for the first payment integration, as selected by the owner.
Use provider checkout and the customer portal. Do not build forms that receive card details.
No AWS account or VPS is necessary for this path.

Paddle handles checkout, recurring billing, and indirect sales taxes as merchant of record.
This reduces payment administration for a small US/Canadian launch.
It does not remove product support, refund costs, business taxes, or the owner's other business duties.
See [Paddle pricing](https://www.paddle.com/pricing) and [supplier terms](https://www.paddle.com/legal/terms).

## Merchant country and payment fees

The initial customer market is the US and Canada. The merchant's legal country remains unknown.
Customer location, merchant location, charge currency, and payout currency are different facts.
Before live setup, confirm the seller's legal country, individual/company status, and payout country and currency.
Do not create a US merchant account merely because customers live in the US.

These examples assume one successful, tax-free USD 10 monthly card charge, without a discount.
They exclude refunds, disputes, currency conversion, bank fees, infrastructure, AI, and support.
Taxes can change the fee base. These estimates are not guaranteed payouts.

| Provider | Illustrative transaction fee | Amount before other costs | Responsibility and limits |
| --- | --- | --- | --- |
| Stripe Payments plus Billing, US merchant and domestic card | 2.9% + USD 0.30 + 0.7% = USD 0.66 | USD 9.34 | Merchant handles indirect tax obligations and disputes. |
| Stripe Managed Payments plus Billing, same US baseline | Previous fee + 3.5% = USD 1.01 | USD 8.99 | Stripe handles supported indirect taxes and transaction support. Eligibility review applies. |
| Paddle | 5% + USD 0.50 = USD 1.00 | USD 9.00 | Merchant of record. Payout and conversion conditions still apply. |
| Lemon Squeezy, US buyer and card | 5% + USD 0.50 + 0.5% subscription fee = USD 1.05 | USD 8.95 | Merchant of record. Payout conditions still apply. |
| Lemon Squeezy, Canadian buyer and card | Previous fee + 1.5% outside-US fee = USD 1.20 | USD 8.80 | A non-US merchant bank payout adds 1% of the payout. |

Stripe's [US pricing](https://stripe.com/pricing) and [Billing pricing](https://stripe.com/billing/pricing) support the US examples.
US processing adds 1.5% for international cards and 1% where currency conversion is necessary.

Canadian processing starts at 2.9% + CA$0.30 for domestic cards.
It adds 0.8% for international cards and 2% where currency conversion is necessary.
The fixed Canadian fee is not USD 0.30. Obtain the actual USD charge and settlement terms before estimating Canadian payouts.
See [Canadian pricing](https://stripe.com/en-ca/pricing).

Stripe now offers [Managed Payments](https://docs.stripe.com/payments/managed-payments), a merchant-of-record option.
Both US and Canadian businesses appear in its [eligible locations](https://docs.stripe.com/payments/managed-payments/eligibility), subject to review.
It supports automated digital products. Live individual coaching does not meet its automated-product requirement.
Its [indirect tax coverage](https://docs.stripe.com/payments/managed-payments/tax-compliance) includes the US and Canada, with documented exceptions elsewhere.

Paddle supports US and Canadian sellers, subject to its [country rules](https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle).
It requires [domain and identity review](https://www.paddle.com/help/start/account-verification/what-is-account-verification). Business verification depends on seller type.
Its [monthly payout threshold](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid) starts at USD 100.
Its [payout terms](https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts) describe bank, conversion, and international transfer costs.
This creates a cash-flow delay before a small service receives its first payout.

Lemon Squeezy supports [US and Canadian bank payouts](https://docs.lemonsqueezy.com/help/getting-started/supported-countries).
Its [fee terms](https://docs.lemonsqueezy.com/help/getting-started/fees) add 1.5% for PayPal and 1% for non-US bank payouts.
The platform fee uses the total order value, which can include tax.
Its [refund and dispute terms](https://docs.lemonsqueezy.com/help/payments/refunds-chargebacks) permit provider-issued refunds and dispute deductions.

## Website, signup, and desktop identity

Cloudflare Pages has [free static requests](https://developers.cloudflare.com/pages/functions/pricing/) and [500 Free builds monthly](https://developers.cloudflare.com/pages/platform/limits/).
Its maximum asset size is 25 MiB. Keep the larger installer files in GitHub Releases.
Start with `pages.dev`. A custom domain is optional for the site and can have a separate annual cost.

Display installer version, source commit, architecture, signing status, byte count, checksum, and installation instructions.
GitHub Actions artifacts remain temporary preview downloads. They are not anonymous public release links.

Do not use GitHub Pages for the commercial signup site. Its [usage rules](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) prohibit that use.
Vercel Hobby also limits use to [personal, noncommercial projects](https://vercel.com/docs/plans/hobby).

Supabase Free includes 50,000 monthly active users, but pauses projects after one inactive week.
Pro starts at USD 25 each month. Free is suitable for integration tests, not a promise of paid-service availability.
Review its [pricing and limits](https://supabase.com/pricing) before live billing. Do not upgrade automatically through this plan.

The existing release plan selects GitHub sign-in first. It avoids email signup delivery during the initial prototype.
Public email signup or recovery requires custom SMTP or a configured email hook.
Supabase's [default SMTP](https://supabase.com/docs/guides/auth/auth-smtp) sends only to team addresses, currently at two messages each hour.
An email provider and sender domain can add costs. AWS SES is optional, not a prerequisite.

Website sign-in does not automatically sign the user into the desktop.
Add desktop sign-in through the system browser with Proof Key for Code Exchange (PKCE).
Keep the verifier and token exchange in Electron main. Keep tokens out of the renderer and Python process.

Store refresh tokens through OS secure storage. Without secure storage, do not persist the account session.
Close the callback listener after success, failure, cancellation, or timeout.
Each request needs independent state and a verifier. Supabase codes are [single-use and valid for five minutes](https://supabase.com/docs/guides/auth/sessions/pkce-flow).

Keep account identity as the verified `(issuer, user_id)` pair. Do not identify owners by email or token text.
Token replacement must retain that account's workspace. Another account must not receive its drafts, history, or entitlements.
Sign-out, expired tokens, and payment failures must not delete saved practice.
Keep local practice available during account or network failures.

The existing MCP endpoint rejects browser origins and verifies accounts on each request.
Add separate website billing endpoints with explicit allowed origins. Preserve the MCP boundary.
The current desktop checkout allowlist permits Lemon Squeezy and selected Stripe hosts.
Paddle or website account links require a deliberate allowlist change and tests.
No checkout URL or production content key is configured in the current trust file.

## Billing state and access contract

An account can have no billing customer or subscription. A subscription belongs to exactly one account.
Record provider, test/live mode, customer ID, subscription ID, plan, status, and paid-period boundaries.
Reject duplicate active purchase requests for the same account and plan.
Keep provider identifiers unique within their provider and mode. Never combine test and live records.

An entitlement records the service benefits an account can use and their time limits.
Only verified server operations can change entitlements. Clients can read their own summary.
Do not authorize paid work through editable user metadata or a cached desktop flag.

Server configuration selects the USD 10 monthly price. A client must not supply an arbitrary price or account owner.
Create checkout and portal sessions only for the authenticated account's provider customer.

Verify webhook signatures over the original request bytes before processing payment state.
Deduplicate provider events and reconcile their current resource state. Events can arrive late or out of order.
Commit the event record and access change together. Preserve safe retries after a database or provider failure.

Never grant access because a checkout redirects to a success page.
Use the provider's [customer portal](https://developer.paddle.com/build/customers/integrate-customer-portal/) for invoices, payment details, and cancellation.

Proposed cancellation behavior retains service access through the paid period, then stops new hosted work.
Define refund, dispute, failed-renewal, and any grace-period behavior before live billing.
These operations must preserve saved code, diagrams, review records, and perpetual packs.
The first subscription needs no new offline license format if its paid benefits remain online.

Define the AI allowance before publication, including units, billing period, and behavior at the limit.
Reserve usage atomically before a model call. Concurrent requests must not exceed the allowance.
Define charges for failed or cancelled calls and retries. Do not promise unlimited hosted AI at this price.

Keep model credentials, payment secrets, and signing keys outside the app and website bundle.
Keep user code and diagrams out of payment notifications and billing records.
Account deletion needs an explicit retention policy for financial records and existing local data.

## Implementation and verification milestones

1. Build the static site and verified download metadata. Test keyboard access, phone layout, checksums, and unavailable platform states.
2. Add signup and account sessions. Test successful login, cancellation, expiry, recovery, sign-out, and two-account isolation.
3. Add billing records and owned queries. Test cross-account rejection, duplicate purchase requests, and strict test/live separation.
4. Add sandbox checkout and portal sessions. Test the exact USD price, owner binding, forged redirects, and unauthorized customer IDs.
5. Add signed webhooks. Test invalid signatures, duplicate delivery, reordered events, provider failures, and database failures with retries.
6. Test initial payment, renewal, failed renewal, cancellation, paid-period expiry, refund, and dispute under the agreed access policy.
7. Add desktop PKCE and refresh. Test wrong state, expired/reused codes, concurrent requests, secure-storage failure, and account switches.
8. Add hosted access and usage checks. Test concurrent calls, limits, cancellation, retries, network failure, and unchanged local practice.
9. Verify the real provider sandbox end to end. Record checkout, webhook, portal, cancellation, and resulting account state.
10. Before live billing, verify merchant approval, support details, policies, limits, production secrets, and the provider's current fees.

Paddle has a [separate sandbox](https://developer.paddle.com/sdks/sandbox/) with test cards and no website approval requirement.
Sandbox and live webhook retry schedules differ. Live refunds can require provider approval.
Stripe recommends [general sandboxes](https://docs.stripe.com/testing-use-cases) for new integrations.
Lemon Squeezy supports [test checkout, subscriptions, and webhooks](https://docs.lemonsqueezy.com/help/getting-started/test-mode). Test file downloads are disabled.

Use fixtures while provider credentials are unavailable. Fixtures do not establish that the provider integration works.
Keep live checkout disabled until its prerequisites and verification are complete.
