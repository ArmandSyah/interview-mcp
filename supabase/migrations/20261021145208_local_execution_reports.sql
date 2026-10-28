-- Local reports are personal practice evidence, not server-verified execution.
create table public.iwb_local_executions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null,
  code_digest text not null check (code_digest ~ '^[a-f0-9]{64}$'),
  is_submission boolean not null,
  report jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (attempt_id, owner_id) references public.iwb_attempts(id, owner_id) on delete cascade
);
create index iwb_execution_attempt on public.iwb_local_executions(attempt_id, created_at desc);
alter table public.iwb_local_executions enable row level security;
create policy iwb_own_executions on public.iwb_local_executions for select to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on public.iwb_local_executions from anon, authenticated;
create trigger iwb_immutable_execution before update on public.iwb_local_executions
  for each row execute function iwb_private.keep_evidence();

-- Keep the earlier contracts unchanged and remove the core from the public API.
alter function public.iwb_practice(text, jsonb) set schema iwb_private;
revoke all on function iwb_private.iwb_practice(text, jsonb) from public, anon, authenticated;

create function public.iwb_practice(operation text, arguments jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account uuid := auth.uid();
  attempt public.iwb_attempts;
  content public.iwb_content;
  saved public.iwb_local_executions;
  plan jsonb;
  report jsonb;
  fixture jsonb;
  cases jsonb := '[]';
  test_run jsonb;
  result jsonb;
  function_name text;
  index_number integer := 0;
  passed_count integer := 0;
  passed boolean;
  all_passed boolean;
  submitted boolean;
begin
  if operation is null or operation not in ('get_local_execution_plan', 'record_local_execution') then
    return iwb_private.iwb_practice(operation, arguments);
  end if;
  if account is null or coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'User authentication is necessary.' using errcode = '42501';
  end if;
  if jsonb_typeof(arguments) is distinct from 'object' then raise exception 'Arguments must be an object.'; end if;
  if (arguments - case when operation='get_local_execution_plan' then array['attempt_id'] else
    array['attempt_id','execution_id','code_digest','submitted','tests'] end) <> '{}'::jsonb then
    raise exception 'These arguments are not permitted.';
  end if;
  select * into attempt from public.iwb_attempts where id=(arguments->>'attempt_id')::uuid
    and owner_id=account for update;
  if not found then raise exception 'Attempt not found. Call start_problem first.'; end if;
  select * into content from public.iwb_content where kind='coding' and problem_id=attempt.problem_id and revision=attempt.revision;
  plan := content.payload->'test_cases'->'python';
  if jsonb_typeof(plan) is distinct from 'array' or jsonb_array_length(plan) not between 1 and 100 then
    raise exception 'The local execution plan is not available.';
  end if;
  function_name := substring(content.payload->'starter_code'->>'python' from
    '(?m)^(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(');
  if function_name is null then raise exception 'The local execution plan is not available.'; end if;
  if operation='get_local_execution_plan' then
    return jsonb_build_object('attempt_id', attempt.id, 'problem_id', attempt.problem_id,
      'problem_revision', attempt.revision, 'function_name', function_name,
      'python_version', '3.12.0', 'test_cases', plan, 'execution_source', 'local_report',
      'verification', 'not_server_verified');
  end if;
  if coalesce(arguments->>'code_digest','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(arguments->'submitted') is distinct from 'boolean'
    or jsonb_typeof(arguments->'tests') is distinct from 'array'
    or jsonb_array_length(arguments->'tests') <> jsonb_array_length(plan)
    or octet_length(arguments::text)>850000 then
    raise exception 'Invalid local execution report.';
  end if;
  submitted := (arguments->>'submitted')::boolean;
  select * into saved from public.iwb_local_executions where id=(arguments->>'execution_id')::uuid;
  if found then
    if saved.owner_id<>account or saved.attempt_id<>attempt.id or saved.code_digest<>arguments->>'code_digest'
      or saved.is_submission<>submitted or saved.report<>arguments->'tests' then
      raise exception 'A local execution report is immutable.';
    end if;
    return saved.result;
  end if;
  for report in select value from jsonb_array_elements(arguments->'tests') loop
    if jsonb_typeof(report) is distinct from 'object'
      or not (report ?& array['index','actual','user_stdout','user_stderr','error','wall_time_ms'])
      or (report - array['index','actual','user_stdout','user_stderr','error','wall_time_ms']) <> '{}'::jsonb
      or jsonb_typeof(report->'index') is distinct from 'number' or report->>'index'<>index_number::text
      or jsonb_typeof(report->'user_stdout') is distinct from 'string' or char_length(report->>'user_stdout')>4000
      or jsonb_typeof(report->'user_stderr') is distinct from 'string' or char_length(report->>'user_stderr')>4000
      or jsonb_typeof(report->'error') not in ('string','null') or char_length(report->>'error')>2000
      or jsonb_typeof(report->'wall_time_ms') is distinct from 'number'
      or (report->>'wall_time_ms') !~ '^[0-9]{1,7}$'
      or octet_length((report->'actual')::text)>16000 then
      raise exception 'Invalid local execution report.';
    end if;
    fixture := plan->index_number;
    passed := report->'error'='null'::jsonb and report->'actual'=fixture->'expected';
    if passed then passed_count := passed_count+1; end if;
    cases := cases || jsonb_build_array(report || jsonb_build_object('passed', passed,
      'input', fixture->'input', 'expected', fixture->'expected'));
    index_number := index_number+1;
  end loop;
  all_passed := passed_count=index_number;
  test_run := jsonb_build_object('attempt_id', attempt.id, 'problem_id', attempt.problem_id,
    'tests_total', index_number, 'tests_passed', passed_count, 'tests', cases, 'all_passed', all_passed,
    'execution_source', 'local_report', 'verification', 'not_server_verified');
  if submitted then
    if all_passed then
      update public.iwb_attempts set status='completed', completed_at=coalesce(completed_at, clock_timestamp()) where id=attempt.id;
    end if;
    result := jsonb_build_object('completed', all_passed, 'test_run', test_run,
      'followup_questions', case when all_passed then
        E'1. What are the time and space costs of your solution?\n2. Which changed constraint would change your approach?' else null end,
      'message', case when all_passed then 'All local tests passed. Attempt completed from your local report.'
        else format('%s/%s local tests passed. Review the results before another submission.', passed_count, index_number) end,
      'execution_source', 'local_report', 'verification', 'not_server_verified');
  else result := test_run;
  end if;
  insert into public.iwb_local_executions(id, owner_id, attempt_id, code_digest, is_submission, report, result)
    values ((arguments->>'execution_id')::uuid, account, attempt.id, arguments->>'code_digest', submitted, arguments->'tests', result);
  return result;
end;
$$;
revoke all on function public.iwb_practice(text, jsonb) from public, anon, authenticated;
grant execute on function public.iwb_practice(text, jsonb) to authenticated;
