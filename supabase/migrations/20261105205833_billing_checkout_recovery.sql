-- Keep the original billing dispatcher unchanged. Only the service wrapper is public.
alter function public.iwb_billing(text, jsonb) set schema iwb_private;
alter function iwb_private.iwb_billing(text, jsonb) rename to billing_initial;
revoke all on function iwb_private.billing_initial(text, jsonb)
  from public, anon, authenticated, service_role;

create function public.iwb_billing(operation text, args jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  result jsonb;
  selected_mode text := args->>'mode';
  account uuid;
  customer iwb_private.billing_customers%rowtype;
  checkout iwb_private.billing_checkouts%rowtype;
  canceled_at timestamptz;
begin
  if operation is distinct from 'checkout_recover' then
    result := iwb_private.billing_initial(operation, args);
    if operation = 'checkout_claim' and result->>'state' = 'ready' then
      -- The initial dispatcher holds this customer's row lock until the RPC returns.
      select c.* into checkout from iwb_private.billing_checkouts c
        join iwb_private.billing_customers b using (mode, binding_id)
        where b.mode = args->>'mode' and b.account_id = (args->>'account_id')::uuid
          and c.transaction_id = result->>'transaction_id';
      result := result || jsonb_build_object('reservation_id', checkout.reservation_id);
    end if;
    return result;
  end if;

  if jsonb_typeof(args) is distinct from 'object' or selected_mode is null
     or selected_mode not in ('sandbox', 'live')
     or args - array['mode', 'account_id', 'reservation_id', 'transaction_id', 'customer_id',
       'transaction_status', 'subscription_id', 'subscription_status',
       'subscription_canceled_at'] <> '{}'::jsonb then
    raise exception 'Checkout recovery arguments are invalid.';
  end if;
  account := (args->>'account_id')::uuid;
  if account is null or not exists (select 1 from auth.users where id = account) then
    raise exception 'Billing account does not exist.';
  end if;

  -- Match the initial dispatcher: customer first, then checkout. Events also lock customer.
  select * into customer from iwb_private.billing_customers
    where mode = selected_mode and account_id = account for update;
  if not found or customer.customer_id is distinct from args->>'customer_id' then
    return jsonb_build_object('state', 'uncertain');
  end if;
  select * into checkout from iwb_private.billing_checkouts
    where mode = selected_mode and binding_id = customer.binding_id for update;
  if not found or checkout.state <> 'ready'
     or checkout.reservation_id is distinct from (args->>'reservation_id')::uuid
     or checkout.transaction_id is distinct from args->>'transaction_id' then
    return jsonb_build_object('state', 'uncertain');
  end if;

  -- An expired active row can still represent a pending renewal. Do not create a second charge.
  if exists (select 1 from iwb_private.billing_subscriptions s
      where s.mode = selected_mode and s.binding_id = customer.binding_id
        and (s.needs_reconciliation or s.status <> 'canceled')) then
    return jsonb_build_object('state', 'uncertain');
  end if;

  -- These facts come only from verified provider GET responses in the Edge handler.
  if args->>'transaction_status' = 'canceled' then
    if args->>'subscription_id' is not null or args->>'subscription_status' is not null
       or args->>'subscription_canceled_at' is not null then
      return jsonb_build_object('state', 'uncertain');
    end if;
  elsif args->>'transaction_status' = 'completed' then
    canceled_at := (args->>'subscription_canceled_at')::timestamptz;
    if args->>'subscription_status' is distinct from 'canceled' or canceled_at is null
       or not isfinite(canceled_at) or canceled_at > clock_timestamp()
       or not exists (select 1 from iwb_private.billing_subscriptions s
         where s.mode = selected_mode and s.binding_id = customer.binding_id
           and s.customer_id = customer.customer_id
           and s.subscription_id = args->>'subscription_id' and s.status = 'canceled'
           and not s.needs_reconciliation) then
      return jsonb_build_object('state', 'uncertain');
    end if;
  else
    return jsonb_build_object('state', 'uncertain');
  end if;

  -- Replace the exact saved reservation in one transaction. Concurrent callers cannot reuse it.
  update iwb_private.billing_checkouts set state = 'pending', reservation_id = gen_random_uuid(),
    transaction_id = null, checkout_url = null
    where mode = selected_mode and binding_id = customer.binding_id
    returning * into checkout;
  return jsonb_build_object('state', 'claimed', 'reservation_id', checkout.reservation_id);
end;
$$;
revoke all on function public.iwb_billing(text, jsonb) from public, anon, authenticated;
grant execute on function public.iwb_billing(text, jsonb) to service_role;

comment on function public.iwb_billing(text, jsonb) is
  'Service-only Paddle dispatcher. Checkout recovery requires provider-verified terminal facts and an exact owned reservation match.';
