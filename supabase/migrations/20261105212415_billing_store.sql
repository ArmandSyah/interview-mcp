-- Paddle billing only. Existing practice tables and perpetual pack licenses do not change.
-- Edge Functions verify Auth and Paddle signatures before this service-only RPC.
create table iwb_private.billing_customers (
  mode text not null check (mode in ('sandbox', 'live')),
  binding_id uuid not null default gen_random_uuid(),
  account_id uuid references auth.users(id) on delete set null,
  customer_id text check (char_length(customer_id) between 1 and 200),
  primary key (mode, binding_id),
  unique (account_id, mode),
  unique (mode, customer_id)
);

create table iwb_private.billing_checkouts (
  mode text not null,
  binding_id uuid not null,
  reservation_id uuid not null default gen_random_uuid(),
  state text not null check (state in ('pending', 'uncertain', 'ready')),
  transaction_id text check (char_length(transaction_id) between 1 and 200),
  checkout_url text check (char_length(checkout_url) between 1 and 2000),
  primary key (mode, binding_id),
  unique (mode, reservation_id),
  unique (mode, transaction_id),
  foreign key (mode, binding_id) references iwb_private.billing_customers(mode, binding_id),
  check ((state = 'ready') = (transaction_id is not null)),
  check (state = 'ready' or checkout_url is null)
);

create table iwb_private.billing_events (
  mode text not null check (mode in ('sandbox', 'live')),
  event_id text not null check (char_length(event_id) between 1 and 200),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  outcome text check (outcome in ('applied', 'stale', 'unbound', 'conflict')),
  primary key (mode, event_id)
);

create table iwb_private.billing_subscriptions (
  mode text not null,
  subscription_id text not null check (char_length(subscription_id) between 1 and 200),
  binding_id uuid not null,
  customer_id text not null,
  status text not null check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  price_id text not null check (char_length(price_id) between 1 and 200),
  price_matches boolean not null,
  needs_reconciliation boolean not null default false,
  current_period_end timestamptz check (isfinite(current_period_end)),
  scheduled_cancel_at timestamptz check (isfinite(scheduled_cancel_at)),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  primary key (mode, subscription_id),
  foreign key (mode, binding_id) references iwb_private.billing_customers(mode, binding_id)
);
create index billing_subscription_binding on iwb_private.billing_subscriptions(mode, binding_id);

alter table iwb_private.billing_customers enable row level security;
alter table iwb_private.billing_checkouts enable row level security;
alter table iwb_private.billing_events enable row level security;
alter table iwb_private.billing_subscriptions enable row level security;
revoke all on iwb_private.billing_customers, iwb_private.billing_checkouts,
  iwb_private.billing_events, iwb_private.billing_subscriptions
  from public, anon, authenticated, service_role;

create function public.iwb_billing(operation text, args jsonb) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  selected_mode text := args->>'mode';
  account uuid;
  customer iwb_private.billing_customers%rowtype;
  checkout iwb_private.billing_checkouts%rowtype;
  subscription iwb_private.billing_subscriptions%rowtype;
  recorded iwb_private.billing_events%rowtype;
  facts jsonb;
  occurred timestamptz;
  period_end timestamptz;
  cancel_at timestamptz;
  event_outcome text;
begin
  if jsonb_typeof(args) is distinct from 'object'
     or selected_mode is null or selected_mode not in ('sandbox', 'live') then
    raise exception 'Billing mode and object arguments are required.';
  end if;

  if operation = 'apply_event' then
    -- The Edge handler derives price_matches from its configured USD 10 monthly price.
    -- It also rejects trial, currency, quantity, and additional-item mismatches.
    if args - array['mode', 'event_id', 'occurred_at', 'subscription_id', 'customer_id',
         'status', 'price_id', 'current_period_end', 'scheduled_cancel_at',
         'payload_hash', 'price_matches'] <> '{}'::jsonb
       or jsonb_typeof(args->'price_matches') is distinct from 'boolean'
       or coalesce(args->>'status', '') not in ('active', 'trialing', 'past_due', 'paused', 'canceled')
       or coalesce(args->>'payload_hash', '') !~ '^[a-f0-9]{64}$'
       or coalesce(char_length(args->>'event_id'), 0) not between 1 and 200
       or coalesce(char_length(args->>'subscription_id'), 0) not between 1 and 200
       or coalesce(char_length(args->>'customer_id'), 0) not between 1 and 200
       or coalesce(char_length(args->>'price_id'), 0) not between 1 and 200 then
      raise exception 'Billing event fields are invalid.';
    end if;
    occurred := (args->>'occurred_at')::timestamptz;
    period_end := (args->>'current_period_end')::timestamptz;
    cancel_at := (args->>'scheduled_cancel_at')::timestamptz;
    if occurred is null or not isfinite(occurred)
       or not coalesce(isfinite(period_end), true)
       or not coalesce(isfinite(cancel_at), true) then
      raise exception 'Billing event dates are invalid.';
    end if;
    facts := jsonb_build_object(
      'occurred_at', occurred, 'subscription_id', args->>'subscription_id',
      'customer_id', args->>'customer_id', 'status', args->>'status',
      'price_id', args->>'price_id', 'price_matches', args->'price_matches',
      'current_period_end', period_end, 'scheduled_cancel_at', cancel_at
    );
    insert into iwb_private.billing_events(mode, event_id, payload_hash, facts)
      values (selected_mode, args->>'event_id', args->>'payload_hash', facts)
      on conflict do nothing;
    select * into recorded from iwb_private.billing_events
      where mode = selected_mode and event_id = args->>'event_id' for update;
    if recorded.payload_hash <> args->>'payload_hash' or recorded.facts <> facts then
      return jsonb_build_object('outcome', 'conflict');
    end if;
    if recorded.outcome in ('applied', 'stale') then
      return jsonb_build_object('outcome', 'duplicate');
    elsif recorded.outcome = 'conflict' then
      return jsonb_build_object('outcome', 'conflict');
    end if;

    -- Serialize first claims too, before a subscription row exists.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'iwb-paddle:' || selected_mode || ':' || (args->>'subscription_id'), 0));
    -- Event and subscription-key locks precede customer, then subscription or checkout.
    select * into customer from iwb_private.billing_customers
      where mode = selected_mode and customer_id = args->>'customer_id' for update;
    if not found or customer.account_id is null then
      event_outcome := 'unbound';
    else
      select * into subscription from iwb_private.billing_subscriptions
        where mode = selected_mode and subscription_id = args->>'subscription_id' for update;
      if found and (subscription.binding_id <> customer.binding_id
          or subscription.customer_id <> customer.customer_id) then
        event_outcome := 'conflict';
      elsif found and subscription.occurred_at = occurred then
        -- Equal timestamps have no proven order. Stop access until a newer verified event.
        update iwb_private.billing_subscriptions set needs_reconciliation = true
          where mode = selected_mode and subscription_id = args->>'subscription_id';
        event_outcome := 'conflict';
      elsif found and subscription.occurred_at > occurred then
        event_outcome := 'stale';
      else
        insert into iwb_private.billing_subscriptions(
          mode, subscription_id, binding_id, customer_id, status, price_id, price_matches,
          current_period_end, scheduled_cancel_at, occurred_at
        ) values (
          selected_mode, args->>'subscription_id', customer.binding_id, customer.customer_id,
          args->>'status', args->>'price_id', (args->>'price_matches')::boolean,
          period_end, cancel_at, occurred
        ) on conflict (mode, subscription_id) do update set
          status = excluded.status, price_id = excluded.price_id,
          price_matches = excluded.price_matches, current_period_end = excluded.current_period_end,
          scheduled_cancel_at = excluded.scheduled_cancel_at, occurred_at = excluded.occurred_at,
          needs_reconciliation = false;
        event_outcome := 'applied';
      end if;
    end if;
    update iwb_private.billing_events set outcome = event_outcome
      where mode = selected_mode and event_id = args->>'event_id';
    return jsonb_build_object('outcome', event_outcome);
  end if;

  account := (args->>'account_id')::uuid;
  if account is null or not exists (select 1 from auth.users where id = account) then
    raise exception 'Billing account does not exist.';
  end if;

  if operation in ('customer', 'checkout_claim') then
    insert into iwb_private.billing_customers(mode, account_id)
      values (selected_mode, account) on conflict (account_id, mode) do nothing;
  end if;
  select * into customer from iwb_private.billing_customers
    where mode = selected_mode and account_id = account for update;
  if operation = 'status' then
    select * into subscription from iwb_private.billing_subscriptions s
      where s.mode = selected_mode and s.binding_id = customer.binding_id
      order by s.needs_reconciliation desc, (s.status = 'active' and s.price_matches
        and coalesce(s.current_period_end > clock_timestamp(), false)
        and coalesce(s.scheduled_cancel_at > clock_timestamp(), true)) desc,
        s.occurred_at desc, s.subscription_id limit 1;
    return jsonb_build_object(
      'mode', selected_mode, 'status', case when subscription.needs_reconciliation
        then 'needs_reconciliation' else coalesce(subscription.status, 'none') end,
      'entitled', coalesce(subscription.status = 'active' and subscription.price_matches
        and not subscription.needs_reconciliation
        and subscription.current_period_end > clock_timestamp()
        and coalesce(subscription.scheduled_cancel_at > clock_timestamp(), true), false),
      'currentPeriodEnd', subscription.current_period_end,
      'scheduledCancelAt', subscription.scheduled_cancel_at
    );
  elsif operation = 'customer' then
    return jsonb_build_object('customer_id', customer.customer_id, 'binding_id', customer.binding_id);
  elsif operation = 'bind_customer' then
    if customer.binding_id is null
       or customer.binding_id is distinct from (args->>'binding_id')::uuid
       or coalesce(char_length(args->>'customer_id'), 0) not between 1 and 200 then
      raise exception 'Billing customer binding is invalid.';
    end if;
    if customer.customer_id is null then
      update iwb_private.billing_customers set customer_id = args->>'customer_id'
        where mode = selected_mode and binding_id = customer.binding_id
        returning * into customer;
    end if;
    return jsonb_build_object('customer_id', customer.customer_id);
  end if;

  if operation = 'checkout_finish' and customer.customer_id is null then
    raise exception 'Billing customer is not bound.';
  end if;
  select * into checkout from iwb_private.billing_checkouts
    where mode = selected_mode and binding_id = customer.binding_id for update;
  if operation = 'checkout_claim' then
    if exists (select 1 from iwb_private.billing_subscriptions s
        where s.mode = selected_mode and s.binding_id = customer.binding_id
          and s.needs_reconciliation) then
      return jsonb_build_object('state', 'uncertain');
    elsif exists (select 1 from iwb_private.billing_subscriptions s
        where s.mode = selected_mode and s.binding_id = customer.binding_id
          and s.status = 'active' and s.price_matches and s.current_period_end > clock_timestamp()
          and coalesce(s.scheduled_cancel_at > clock_timestamp(), true)) then
      return jsonb_build_object('state', 'subscribed');
    elsif checkout.reservation_id is not null then
      return jsonb_build_object('state', checkout.state, 'transaction_id', checkout.transaction_id,
        'checkout_url', checkout.checkout_url);
    end if;
    insert into iwb_private.billing_checkouts(mode, binding_id, state)
      values (selected_mode, customer.binding_id, 'pending') returning * into checkout;
    return jsonb_build_object('state', 'claimed', 'reservation_id', checkout.reservation_id);
  elsif operation in ('checkout_finish', 'checkout_fail') then
    if checkout.reservation_id is null
       or checkout.reservation_id is distinct from (args->>'reservation_id')::uuid then
      raise exception 'Checkout reservation does not match.';
    end if;
    if operation = 'checkout_finish' then
      if coalesce(char_length(args->>'transaction_id'), 0) not between 1 and 200
         or (args->>'checkout_url' is not null
           and char_length(args->>'checkout_url') not between 1 and 2000) then
        raise exception 'Checkout transaction fields are invalid.';
      end if;
      if checkout.state = 'ready' and (checkout.transaction_id <> args->>'transaction_id'
          or checkout.checkout_url is distinct from args->>'checkout_url') then
        raise exception 'Checkout transaction cannot change.';
      end if;
      update iwb_private.billing_checkouts set state = 'ready',
        transaction_id = args->>'transaction_id', checkout_url = args->>'checkout_url'
        where mode = selected_mode and binding_id = customer.binding_id;
      return jsonb_build_object('state', 'ready');
    end if;
    if jsonb_typeof(args->'uncertain') is distinct from 'boolean' then
      raise exception 'Checkout failure certainty is required.';
    end if;
    -- A late failure cannot remove a ready transaction or release an uncertain claim.
    if checkout.state = 'pending' then
      if (args->>'uncertain')::boolean then
        update iwb_private.billing_checkouts set state = 'uncertain'
          where mode = selected_mode and binding_id = customer.binding_id;
      else
        delete from iwb_private.billing_checkouts
          where mode = selected_mode and binding_id = customer.binding_id;
      end if;
    end if;
    return '{}'::jsonb;
  end if;
  raise exception 'Unknown billing operation.';
end;
$$;
revoke all on function public.iwb_billing(text, jsonb) from public, anon, authenticated;
grant execute on function public.iwb_billing(text, jsonb) to service_role;

comment on function public.iwb_billing(text, jsonb) is
  'Paddle billing service RPC. Edge validates identity, signatures, configured price, and checkout URLs. No client grants.';
