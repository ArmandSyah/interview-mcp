import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, portalURL } from '../src/config.js';
const config = { paymentMode: 'sandbox', supabaseUrl: 'https://example.supabase.co', publishableKey: 'sb_publishable_test', billingUrl: 'https://example.supabase.co/functions/v1/billing', paddleClientToken: 'test_example' };
test('missing account configuration never enables signup or checkout', () => {
  const value = validateConfig({ paymentMode: 'sandbox' });
  assert.equal(value.accountsReady, false);
  assert.equal(value.billingReady, false);
});
test('billing cannot receive a user token on another host or route', () => {
  for (const billingUrl of ['https://attacker.invalid/functions/v1/billing', 'https://example.supabase.co/functions/v1/other', 'https://example.supabase.co/functions/v1/billing?destination=other']) assert.throws(() => validateConfig({ ...config, billingUrl }), /Billing must use/);
});
test('production and secret credentials cannot enter the sandbox site', () => {
  assert.throws(() => validateConfig({ ...config, paymentMode: 'live' }), /sandbox/);
  assert.throws(() => validateConfig({ ...config, publishableKey: 'sb_secret_example' }), /public/);
  assert.throws(() => validateConfig({ ...config, paddleClientToken: 'live_example' }), /sandbox/);
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  assert.throws(() => validateConfig({ ...config, publishableKey: `eyJ.${payload}.signature` }), /anon/);
});
test('a complete sandbox config enables the integration', () => {
  assert.equal(validateConfig(config).billingReady, true);
});
test('signup defaults to private without disabling existing accounts or billing', () => {
  const value = validateConfig(config);
  assert.equal(value.signupMode, 'private');
  assert.equal(value.accountsReady, true);
  assert.equal(value.billingReady, true);
  assert.equal(validateConfig({ paymentMode: 'sandbox' }).signupMode, 'private');
});
test('signup accepts only explicit private or public string values', () => {
  for (const signupMode of ['private', 'public']) assert.equal(validateConfig({ ...config, signupMode }).signupMode, signupMode);
  for (const signupMode of ['', 'PUBLIC', 'enabled', true, null]) assert.throws(() => validateConfig({ ...config, signupMode }));
});
test('portal redirects stay on Paddle sandbox', () => {
  assert.equal(portalURL('https://sandbox-customer-portal.paddle.com/session/example'), 'https://sandbox-customer-portal.paddle.com/session/example');
  for (const value of ['javascript:alert(1)', 'https://sandbox-customer-portal.paddle.com.attacker.invalid/', 'https://user:secret@sandbox-customer-portal.paddle.com/', 'https://sandbox-customer-portal.paddle.com:8443/']) assert.throws(() => portalURL(value));
});

test('disabled accounts still reject nonpublic Paddle values and unbound billing URLs', () => {
  for (const paddleClientToken of ['pdl_sdbx_apikey_example', 'live_example']) {
    assert.throws(() => validateConfig({ paymentMode: 'sandbox', paddleClientToken }), /sandbox/);
  }
  assert.throws(() => validateConfig({ paymentMode: 'sandbox', billingUrl: 'https://attacker.invalid' }), /Billing must use/);
});
test('Supabase projects cannot use alternate ports', () => {
  assert.throws(() => validateConfig({ ...config, supabaseUrl: 'https://example.supabase.co:8443' }), /HTTPS origin/);
});
