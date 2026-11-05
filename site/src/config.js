export function validateConfig(input) {
  const fields = ['supabaseUrl', 'publishableKey', 'billingUrl', 'paddleClientToken', 'paymentMode'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key)) || Object.values(input).some((value) => typeof value !== 'string')) throw new Error('Only public website settings are permitted.');
  if (input.paymentMode !== 'sandbox') throw new Error('Only sandbox payments are enabled in this preview.');
  if (input.paddleClientToken && !input.paddleClientToken.startsWith('test_')) throw new Error('Use a Paddle sandbox client token.');
  if (!input.supabaseUrl && !input.publishableKey) {
    if (input.billingUrl) throw new Error('Billing must use this Supabase project.');
    return { ...input, accountsReady: false, billingReady: false };
  }
  const project = new URL(input.supabaseUrl);
  if (project.protocol !== 'https:' || project.port || !project.hostname.endsWith('.supabase.co') || project.pathname !== '/' || project.username || project.password || project.search || project.hash) throw new Error('Use the Supabase project HTTPS origin.');
  if (!input.publishableKey || /^(sb_secret_|service_role)/.test(input.publishableKey)) throw new Error('Use a public Supabase key.');
  if (input.publishableKey.startsWith('eyJ')) {
    let payload;
    try { payload = JSON.parse(atob(input.publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw new Error('Invalid public Supabase key.'); }
    if (payload.role !== 'anon') throw new Error('Only the anon project key is permitted.');
  } else if (!input.publishableKey.startsWith('sb_publishable_')) throw new Error('Use a public Supabase key.');
  if (input.billingUrl) {
    const billing = new URL(input.billingUrl);
    if (billing.origin !== project.origin || billing.pathname !== '/functions/v1/billing' || billing.search || billing.hash || billing.username || billing.password) throw new Error('Billing must use this Supabase project.');
  }
  return { ...input, supabaseUrl: project.origin, accountsReady: true, billingReady: !!input.billingUrl && !!input.paddleClientToken };
}

export function portalURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.hostname !== 'sandbox-customer-portal.paddle.com' || url.username || url.password) throw new Error('Unexpected sandbox billing destination.');
  return url.href;
}
