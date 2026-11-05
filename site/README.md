# Interview Workbench website

This site presents the desktop app and its development download. It includes Supabase account forms and Paddle sandbox checkout controls.

The checked-in configuration is empty. Account creation and checkout remain disabled until the required services are configured. No live payment service is available.

## Build and preview

```sh
npm ci
npm test
npm run build
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:4173`.

## Public configuration

Edit `public/config.json` with public values only:

- `supabaseUrl`: the HTTPS Supabase project URL.
- `publishableKey`: a Supabase publishable key or legacy anonymous key.
- `billingUrl`: the same project's `/functions/v1/billing` URL.
- `paddleClientToken`: a Paddle sandbox client token that starts with `test_`.
- `paymentMode`: `sandbox`.

The build rejects unknown fields, secret keys, live tokens, and billing URLs outside the configured project.

Never add a Supabase service key, Paddle API key, or webhook secret here. Store those secrets in server settings. Do not store card numbers or security codes. Paddle provides HTTPS checkout and its customer portal. The browser sends only a verified transaction identifier to Paddle checkout.

Deploy the billing migration and function before enabling checkout. Configure the site's HTTPS origin in the billing CORS allowlist and Supabase redirect allowlist. Configure Supabase email delivery before public signup. See `docs/paddle-integration.md` in the repository for server setup and remaining blockers.

The account shown here does not connect the desktop app to an account. Desktop sign-in needs its own integration. Checkout completion does not grant access. The server verifies subscription events before it reports access.

## Download limits

The current download is an unsigned Windows development artifact. GitHub requires sign-in and deletes expired artifacts. Replace the link with a stable release before public launch.

## Verification

Configuration tests cover disabled defaults, secret rejection, billing destinations, and portal destinations. Browser checks use mocked account and payment services. They do not prove a real provider integration.
