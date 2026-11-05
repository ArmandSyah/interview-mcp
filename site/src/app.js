import { createClient } from '@supabase/supabase-js';
import { validateConfig, portalURL } from './config.js';
const element = (id) => document.getElementById(id);
let config, client, session = null, epoch = 0, signingUp = false, pendingAuth = false, pendingBilling = false, paddleReady, statusSequence = 0;
const activeRequests = new Set();
function message(id, text) { element(id).textContent = text; }
function controls() {
  element('account-open').textContent = session ? 'Your account' : 'Sign in';
  element('account-panel').hidden = !session;
  element('checkout').disabled = !session || !config?.billingReady || pendingBilling;
  element('portal').disabled = !session || !config?.billingUrl || pendingBilling;
  element('auth-submit').disabled = !config?.accountsReady || pendingAuth;
  element('auth-toggle').disabled = pendingAuth;
  element('sign-out').disabled = pendingBilling;
}
async function billing(path, method = 'GET') {
  if (!session || !config.billingUrl) throw new Error('Sign in after billing configuration is complete.');
  const current = epoch, user = session.user.id;
  const abort = new AbortController(); activeRequests.add(abort);
  try {
    const response = await fetch(`${config.billingUrl}/${path}`, { method, signal: abort.signal,
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: config.publishableKey, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}) });
    const data = await response.json();
    if (current !== epoch || session?.user.id !== user) throw new Error('The account changed. Please retry.');
    if (!response.ok) {
      if (response.status === 401) throw new Error('Sign in with a confirmed account to continue.');
      if (response.status === 409) throw new Error(data.error === 'no_billing_account' ? 'This account has no sandbox billing customer yet.' : data.error === 'subscription_exists' ? 'This account already has a sandbox subscription.' : 'This checkout needs review before another payment can start.');
      throw new Error('The sandbox billing service is unavailable. Please retry later.');
    }
    return data;
  } finally { activeRequests.delete(abort); }
}
async function refreshStatus() {
  if (!session) return;
  if (!config.billingUrl) { message('subscription-status', 'Sandbox billing is not configured yet.'); return; }
  const current = epoch, sequence = ++statusSequence;
  message('subscription-status', 'Reading sandbox status…');
  try {
    const data = await billing('status');
    if (current !== epoch || sequence !== statusSequence) return;
    if (data.mode !== 'sandbox' || typeof data.entitled !== 'boolean' || typeof data.status !== 'string') throw new Error('Invalid sandbox status.');
    message('subscription-status', data.entitled ? 'Sandbox subscription active. This does not grant a live paid service.' : `Sandbox subscription: ${data.status.replaceAll('_', ' ')}.`);
  } catch (error) { if (current === epoch && sequence === statusSequence && session) message('subscription-status', error.message); }
}
function setSession(value) {
  epoch++; for (const request of activeRequests) request.abort(); activeRequests.clear();
  session = value; pendingBilling = false;
  message('account-email', session?.user.email || 'Account');
  message('billing-note', !config?.billingReady ? 'Paddle sandbox configuration is pending.' : session ? 'Test cards only. No real charge.' : 'Sign in to test the sandbox checkout.');
  controls();
  if (session) { element('account-dialog').close(); void refreshStatus(); }
}
function loadPaddle() {
  paddleReady ??= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    script.onload = () => {
      try { window.Paddle.Environment.set('sandbox'); window.Paddle.Initialize({ token: config.paddleClientToken, eventCallback: (event) => { if (event.name === 'checkout.completed') void refreshStatus(); } }); resolve(window.Paddle); } catch { paddleReady = undefined; script.remove(); reject(new Error('Paddle sandbox could not initialize.')); }
    };
    script.onerror = () => { paddleReady = undefined; script.remove(); reject(new Error('Paddle sandbox could not load.')); };
    document.head.append(script);
  });
  return paddleReady;
}
for (const name of ['coding', 'design']) element(`show-${name}`).addEventListener('click', () => {
  for (const other of ['coding', 'design']) element(`show-${other}`).setAttribute('aria-pressed', String(other === name));
  element('workspace-image').src = `${name}-workbench.png`;
  element('workspace-image').alt = name === 'coding' ? 'Coding workspace with a problem, Python editor, test results, and coach panel.' : 'System-design workspace with a whiteboard, architecture components, notes, and discussion review.';
  message('workspace-caption', name === 'coding' ? 'Write Python, run tests in local Docker, and keep your drafts.' : 'Draw your system, record decisions, and review saved checkpoints.');
});
element('account-open').addEventListener('click', () => { if (session) element('account-panel').scrollIntoView({ behavior: 'smooth' }); else element('account-dialog').showModal(); });
element('account-close').addEventListener('click', () => element('account-dialog').close());
element('auth-toggle').addEventListener('click', () => {
  signingUp = !signingUp; message('account-heading', signingUp ? 'Create an account' : 'Sign in');
  message('auth-submit', signingUp ? 'Create account' : 'Sign in'); message('auth-toggle', signingUp ? 'Use an existing account' : 'Create an account');
  element('password').autocomplete = signingUp ? 'new-password' : 'current-password'; message('auth-message', '');
});
element('account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!client || pendingAuth) return; pendingAuth = true; controls();
  const email = element('email').value.trim(), password = element('password').value;
  const create = signingUp;
  message('auth-message', create ? 'Creating your account…' : 'Signing in…');
  try {
    const result = create ? await client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } }) : await client.auth.signInWithPassword({ email, password });
    if (result.error) throw new Error(create ? 'Account creation failed. Public signup requires configured Supabase email delivery.' : 'Sign-in failed. Check your email, password, and email confirmation.');
    element('password').value = '';
    message('auth-message', create && !result.data.session ? 'Check your email to confirm the account. Then sign in.' : 'Signed in.');
  } catch (error) { message('auth-message', error.message); }
  finally { pendingAuth = false; controls(); }
});
element('sign-out').addEventListener('click', async () => {
  if (!client) return;
  const result = await client.auth.signOut({ scope: 'local' });
  if (result.error) { message('subscription-status', 'Sign-out failed. Please retry.'); return; }
  setSession(null);
});
element('checkout').addEventListener('click', async () => {
  if (pendingBilling || !session || !config.billingReady) return;
  const current = epoch; pendingBilling = true; controls(); message('billing-note', 'Preparing sandbox checkout…');
  try {
    const paddle = await loadPaddle(); if (current !== epoch) return;
    const result = await billing('checkout', 'POST'); if (current !== epoch) return;
    if (!/^txn_[a-z0-9]+$/.test(result.transactionId)) throw new Error('Invalid sandbox transaction.');
    paddle.Checkout.open({ transactionId: result.transactionId, settings: { allowLogout: false, showAddDiscounts: false } });
    message('billing-note', 'Complete the sandbox checkout, then refresh your account status. No real charge.');
  } catch (error) { if (current === epoch) message('billing-note', error.message); }
  finally { if (current === epoch) { pendingBilling = false; controls(); } }
});
element('refresh-status').addEventListener('click', () => void refreshStatus());
element('portal').addEventListener('click', async () => {
  if (pendingBilling || !session) return; const current = epoch; pendingBilling = true; controls();
  try { const data = await billing('portal', 'POST'); if (current === epoch) location.assign(portalURL(data.url)); }
  catch (error) { if (current === epoch) message('subscription-status', error.message); }
  finally { if (current === epoch) { pendingBilling = false; controls(); } }
});
try {
  config = validateConfig(await (await fetch('config.json', { cache: 'no-store' })).json());
  if (config.accountsReady) {
    client = createClient(config.supabaseUrl, config.publishableKey, { auth: { flowType: 'pkce', detectSessionInUrl: true } });
    client.auth.onAuthStateChange((_event, value) => { queueMicrotask(() => setSession(value)); });
    const current = epoch; const { data, error } = await client.auth.getSession();
    if (error) throw new Error('The saved account session could not be read.');
    if (current === epoch) setSession(data.session);
  } else { message('auth-message', 'Account configuration is not enabled in this preview.'); controls(); }
} catch { message('auth-message', 'Account configuration is unavailable. Downloads remain available.'); message('billing-note', 'Sandbox billing is not configured.'); controls(); }
