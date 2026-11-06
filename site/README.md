# Interview Workbench website

This site presents the desktop app and its development download. It includes Supabase account forms and Paddle sandbox checkout controls.

The checked-in service credentials are blank, and signup is private. Existing accounts can sign in after Supabase is configured. Checkout requires separate billing configuration. No live payment service is available.

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
- `signupMode`: `private` or `public`. An omitted value defaults to `private`.

The build rejects unknown fields, secret keys, live tokens, and billing URLs outside the configured project. These checks also apply when accounts are disabled. The build copies only the listed website assets and removes stale output.

Never add a Supabase service key, Paddle API key, or webhook secret here. Store those secrets in server settings. Do not store card numbers or security codes. Paddle provides HTTPS checkout and its customer portal. The browser sends only a verified transaction identifier to Paddle checkout.

Keep `signupMode` set to `private` while there is no public signup launch. This hides account creation and preserves existing sign-in and billing. Supabase must also disable new signups. The website setting does not replace that server control.

Before public signup, configure a domain, Supabase email delivery, and the approved redirect origins. Enable new signups in Supabase and set `signupMode` to `public` only for that launch.

Deploy the billing migration and function before enabling checkout. Configure the site's HTTPS origin in the billing CORS allowlist and Supabase redirect allowlist. See `docs/paddle-integration.md` in the repository for server setup and remaining blockers.

The account shown here does not connect the desktop app to an account. Desktop sign-in needs its own integration. Checkout completion does not grant access. The server verifies subscription events before it reports access.

## Download limits

The current download is an unsigned Windows development artifact. GitHub requires sign-in and deletes expired artifacts. Replace the link with a stable release before public launch.

## Verification

Configuration tests cover private signup defaults, allowed signup modes, disabled accounts, secret rejection, and billing destinations. Browser checks cover private sign-in, blocked signup attempts, and explicit public signup with mocked services. They do not prove a real provider integration.

Run the browser checks against the local preview:

```sh
npx playwright install chromium
npm run test:browser
```

These checks mock account and payment requests. They do not send email or charge cards. The Website workflow repeats them on pull requests.
