// Run against a built local preview. All account and payment traffic is mocked.
// PLAYWRIGHT_MODULE can point to an existing Playwright installation.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_QA_URL || 'http://127.0.0.1:4173';
const screenshotDir = process.env.SITE_QA_OUTPUT || tmpdir();
const browser = await chromium.launch({ headless: true });
const errors = [];
const checks = [];
const config = { paymentMode: 'sandbox', supabaseUrl: 'https://qa.supabase.co', publishableKey: 'sb_publishable_test', billingUrl: 'https://qa.supabase.co/functions/v1/billing', paddleClientToken: 'test_qa' };
const user = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'qa@example.invalid', email_confirmed_at: '2026-11-01T00:00:00Z', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-11-01T00:00:00Z' };
const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.testsignature`;
const session = { access_token: jwt, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'bearer', user };
const status = { mode: 'sandbox', status: 'none', entitled: false, currentPeriodEnd: null, scheduledCancelAt: null };
const json = (data) => ({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
async function setup(configured = false, viewport = { width: 1440, height: 1000 }, signupMode) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue();
    return route.abort();
  });
  await page.route('**/config.json', (route) => route.fulfill(json(configured ? { ...config, ...(signupMode ? { signupMode } : {}) } : { paymentMode: 'sandbox' })));
  return { page, context };
}
async function signin(page) {
  await page.locator('#account-open').click();
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill('test-password-only');
  await page.locator('#auth-submit').click();
  await page.locator('#account-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#account-email').textContent(), user.email);
}
try {
  const plain = await setup();
  await plain.page.goto(base);
  await plain.page.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('configuration'));
  assert(await plain.page.locator('#checkout').isDisabled());
  await plain.page.locator('#show-design').click();
  assert.equal(await plain.page.locator('#show-design').getAttribute('aria-pressed'), 'true');
  assert((await plain.page.locator('#workspace-image').getAttribute('src')).includes('design'));
  await plain.page.locator('#show-coding').click();
  await plain.page.locator('#account-open').click();
  assert(await plain.page.locator('#auth-submit').isDisabled());
  await plain.page.keyboard.press('Escape');
  assert(!(await plain.page.locator('#account-dialog').isVisible()));
  await plain.page.screenshot({ path: `${screenshotDir}/interview-site-desktop.png`, fullPage: true });
  checks.push('Blank configuration, workspace switch, disabled auth/checkout, dialog escape');
  const mobile = await setup(false, { width: 390, height: 844 });
  await mobile.page.goto(base);
  await mobile.page.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('configuration'));
  assert(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile horizontal overflow');
  await mobile.page.screenshot({ path: `${screenshotDir}/interview-site-mobile.png`, fullPage: true });
  checks.push('Mobile layout has no horizontal overflow at 390 px');

  for (const [configured, transactionId, shouldInitialize] of [
    [true, `txn_${'b'.repeat(26)}`, true],
    [true, 'txn_invalid', false],
    [false, `txn_${'b'.repeat(26)}`, false],
  ]) {
    const paymentLink = await setup(configured);
    const billingRequests = [];
    await paymentLink.page.route('https://qa.supabase.co/functions/v1/billing/**', (route) => {
      billingRequests.push(route.request().method());
      return route.fulfill(json(status));
    });
    await paymentLink.page.route('https://cdn.paddle.com/paddle/v2/paddle.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Paddle={Environment:{set:(value)=>{window.qaEnvironment=value}},Initialize:(value)=>{window.qaPaddleInit=value;window.qaAutoTransaction=new URL(location.href).searchParams.get('_ptxn')},Checkout:{open:()=>{throw new Error('Payment links must not call Checkout.open')}}};` }));
    await paymentLink.page.goto(`${base}/?_ptxn=${transactionId}`);
    await paymentLink.page.waitForLoadState('networkidle');
    if (shouldInitialize) {
      assert.equal(await paymentLink.page.evaluate(() => window.qaAutoTransaction), transactionId);
      assert.equal(await paymentLink.page.evaluate(() => window.qaEnvironment), 'sandbox');
      assert.equal(await paymentLink.page.evaluate(() => window.qaPaddleInit.checkout.settings.allowLogout), false);
      await paymentLink.page.evaluate(() => window.qaPaddleInit.eventCallback({ name: 'checkout.completed' }));
    } else assert.equal(await paymentLink.page.evaluate(() => window.qaPaddleInit), undefined);
    assert.deepEqual(billingRequests, [], 'A signed-out payment link must not create a checkout or grant account access');
    assert(!(await paymentLink.page.locator('#account-panel').isVisible()));
    assert(await paymentLink.page.locator('#checkout').isDisabled());
    await paymentLink.context.close();
  }
  checks.push('Configured payment links initialize sandbox Paddle without creating a transaction or granting access; malformed and unconfigured links stay inactive');

  for (const signupMode of [undefined, 'private']) {
    const privateSite = await setup(true, undefined, signupMode);
    const { page } = privateSite;
    let signupCount = 0, signinCount = 0, checkoutCount = 0;
    await page.route('https://qa.supabase.co/auth/v1/**', (route) => {
      const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
      if (endpoint === 'signup') { signupCount++; return route.fulfill(json(user)); }
      if (endpoint === 'token') { signinCount++; return route.fulfill(json(session)); }
      if (endpoint === 'user') return route.fulfill(json(user));
      throw new Error(`Unexpected private auth route ${endpoint}`);
    });
    await page.route('https://qa.supabase.co/functions/v1/billing/**', (route) => {
      assert.equal(route.request().headers().authorization, `Bearer ${jwt}`);
      const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
      if (endpoint === 'status') return route.fulfill(json(status));
      if (endpoint === 'checkout') { checkoutCount++; return route.fulfill(json({ transactionId: `txn_${'c'.repeat(26)}` })); }
      throw new Error(`Unexpected private billing route ${endpoint}`);
    });
    await page.route('https://cdn.paddle.com/paddle/v2/paddle.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Paddle={Environment:{set:()=>{}},Initialize:()=>{},Checkout:{open:(value)=>{window.qaPrivateCheckout=value}}};` }));
    await page.goto(base);
    await page.locator('#account-open').click();
    await page.waitForFunction(() => !document.querySelector('#auth-submit').disabled);
    assert(await page.locator('#auth-toggle').isHidden());
    assert(await page.locator('#auth-toggle').isDisabled());
    // Force the disabled control to dispatch its event. DOM changes must not enable signup.
    await page.locator('#auth-toggle').evaluate((toggle) => {
      toggle.hidden = false; toggle.disabled = false; toggle.click();
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await page.locator('#account-heading').textContent(), 'Sign in');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill('test-password-only');
    await page.locator('#auth-submit').click();
    await page.locator('#account-panel').waitFor({ state: 'visible' });
    assert.equal(signinCount, 1);
    assert.equal(signupCount, 0);
    await page.locator('#checkout').click();
    await page.waitForFunction(() => !!window.qaPrivateCheckout);
    assert.equal(checkoutCount, 1);
    assert.equal(signupCount, 0);
    await privateSite.context.close();
  }
  checks.push('Missing and private signup modes block forced signup toggles while existing sign-in and sandbox checkout work');

  const { page, context } = await setup(true, undefined, 'public');
  let signupBody;
  let statusWaiter;
  let observeDelayedStatus = () => {};
  let delayStatus = false;
  let checkoutCount = 0;
  let portalCount = 0;
  await page.route('https://qa.supabase.co/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/signup')) {
      signupBody = route.request().postDataJSON();
      return route.fulfill(json(user));
    }
    if (url.pathname.endsWith('/token')) return route.fulfill(json(session));
    if (url.pathname.endsWith('/logout')) return route.fulfill(json({}));
    if (url.pathname.endsWith('/user')) return route.fulfill(json(user));
    throw new Error(`Unexpected mocked auth route ${url.pathname}`);
  });
  await page.route('https://qa.supabase.co/functions/v1/billing/**', async (route) => {
    assert.equal(route.request().headers().authorization, `Bearer ${jwt}`);
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
    if (endpoint === 'status') {
      if (delayStatus) await new Promise((resolve) => { statusWaiter = resolve; observeDelayedStatus(); });
      return route.fulfill(json(status)).catch(() => {});
    }
    assert.deepEqual(route.request().postDataJSON(), {});
    if (endpoint === 'checkout') {
      checkoutCount++;
      return route.fulfill(json({ transactionId: `txn_${'a'.repeat(26)}` }));
    }
    if (endpoint === 'portal') {
      portalCount++;
      return route.fulfill(json({ url: 'https://sandbox-customer-portal.paddle.com/test-session' }));
    }
    throw new Error(`Unexpected mocked billing route ${endpoint}`);
  });
  await page.route('https://cdn.paddle.com/paddle/v2/paddle.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.qaPaddleCalls=[];window.Paddle={Environment:{set:(value)=>window.qaPaddleCalls.push(['environment',value])},Initialize:(value)=>{window.qaPaddleInit=value},Checkout:{open:(value)=>window.qaPaddleCalls.push(['checkout',value])}};` }));
  await page.route('https://sandbox-customer-portal.paddle.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Mock sandbox portal</h1>' }));
  await page.goto(base);
  await page.locator('#account-open').click();
  await page.locator('#auth-toggle').click();
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill('test-password-only');
  await page.locator('#auth-submit').click();
  await page.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('Check your email'));
  assert(signupBody.code_challenge, 'Signup must use a PKCE challenge');
  assert.equal(signupBody.code_challenge_method, 's256');
  assert(!(await page.locator('#account-panel').isVisible()));
  await page.locator('#auth-toggle').click();
  await page.locator('#password').fill('test-password-only');
  await page.locator('#auth-submit').click();
  await page.locator('#account-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#subscription-status').textContent.includes('none'));
  checks.push('Explicit public signup creates PKCE challenge and requires confirmation; signin loads owned status');
  await page.locator('#checkout').click();
  await page.waitForFunction(() => window.qaPaddleCalls?.some(([type]) => type === 'checkout'));
  const calls = await page.evaluate(() => window.qaPaddleCalls);
  assert.deepEqual(calls[0], ['environment', 'sandbox']);
  assert.equal(calls[1][1].transactionId, `txn_${'a'.repeat(26)}`);
  assert.equal(calls[1][1].settings.allowLogout, false);
  assert.equal(checkoutCount, 1);
  assert((await page.locator('#subscription-status').textContent()).includes('none'), 'Opening checkout must not grant entitlement');
  checks.push('Checkout uses authenticated empty request, sandbox Paddle, fixed server transaction; no redirect entitlement');
  await page.locator('#sign-out').click();
  await page.locator('#account-panel').waitFor({ state: 'hidden' });
  assert(await page.locator('#checkout').isDisabled());
  const statusStarted = new Promise((resolve) => { observeDelayedStatus = resolve; });
  delayStatus = true;
  await signin(page);
  await statusStarted;
  assert(statusWaiter, 'Expected a delayed status request');
  await page.locator('#sign-out').click();
  await page.locator('#account-panel').waitFor({ state: 'hidden' });
  statusWaiter();
  await page.waitForTimeout(100);
  assert(!(await page.locator('#account-panel').isVisible()));
  assert.equal(await page.locator('#account-email').textContent(), 'Account');
  checks.push('Signout clears account; late billing response cannot restore previous account');
  delayStatus = false;
  await signin(page);
  await page.locator('#portal').click();
  await page.waitForURL('https://sandbox-customer-portal.paddle.com/test-session');
  assert.equal(portalCount, 1);
  checks.push('Owned portal request opens only the sandbox portal');
  assert.deepEqual(errors, [], 'Browser errors');
  await context.close();
  console.log(JSON.stringify({ passed: checks, screenshots: [`${screenshotDir}/interview-site-desktop.png`, `${screenshotDir}/interview-site-mobile.png`] }, null, 2));
} catch (error) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) console.error(await page.evaluate(() => ({auth:document.querySelector('#auth-message')?.textContent,billing:document.querySelector('#billing-note')?.textContent,paddle:window.qaPaddleCalls})).catch(() => 'Page unavailable'));
  }
  throw error;
} finally {
  await browser.close();
}
