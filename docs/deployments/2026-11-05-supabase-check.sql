-- Transaction-scoped fixtures test PostgreSQL roles and contracts, not Supabase Auth login.
begin;
set local statement_timeout = '20s';
do $$
declare
  alice uuid := gen_random_uuid();
  bob uuid := gen_random_uuid();
  old_attempt uuid := gen_random_uuid();
  checkpoint_id uuid := gen_random_uuid();
  session_data jsonb;
  saved jsonb;
  finished jsonb;
  actual jsonb;
  ids jsonb;
  args jsonb;
  plan jsonb;
  report jsonb;
  old_payload jsonb;
  message text;
  operation text;
  new_revision text := 'fd302942eb545cdf00a18da322423a2858f800866e614e1a6b6d89e2db7f262b';
begin
  insert into auth.users(id) values(alice), (bob);
  insert into public.iwb_attempts(id,owner_id,problem_id,revision)
    values(old_attempt,alice,'0015-delivery-hold-clusters','d0e746007e964dab25d8fb0584f62821ba1880c6f58ebd39faa7d0da4f5a7503');
  select payload into strict old_payload from public.iwb_content
    where problem_id='0015-delivery-hold-clusters' and revision='d0e746007e964dab25d8fb0584f62821ba1880c6f58ebd39faa7d0da4f5a7503' and not available;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',alice,'role','authenticated')::text,true);
  actual := public.iwb_practice('list_problems','{}');
  if jsonb_array_length(actual)<>5 then raise exception 'list_problems({}): expected 5, actual %',actual; end if;
  actual := public.iwb_practice('list_design_problems','{}');
  if jsonb_array_length(actual)<>5 then raise exception 'list_design_problems({}): expected 5, actual %',actual; end if;
  actual := public.iwb_practice('get_problem_description',jsonb_build_object('attempt_id',old_attempt));
  if position((old_payload->>'description_md') in (actual #>> '{}'))=0 then raise exception 'get_problem_description(%): expected old description, actual %',old_attempt,actual; end if;
  actual := public.iwb_practice('get_local_execution_plan',jsonb_build_object('attempt_id',old_attempt));
  if actual->>'problem_revision' is distinct from 'd0e746007e964dab25d8fb0584f62821ba1880c6f58ebd39faa7d0da4f5a7503' then
    raise exception 'get_local_execution_plan(%): expected old revision, actual %',old_attempt,actual;
  end if;
  actual := public.iwb_practice('start_problem','{"problem_id":"0015-delivery-hold-clusters"}');
  plan := public.iwb_practice('get_local_execution_plan',jsonb_build_object('attempt_id',actual->>'attempt_id'));
  if plan->>'problem_revision' is distinct from new_revision then raise exception 'new get_local_execution_plan: expected revision %, actual %',new_revision,plan; end if;
  select jsonb_agg(jsonb_build_object('index',ordinality-1,'actual',null,'user_stdout','','user_stderr','','error','Deployment smoke test: no code executed','wall_time_ms',0) order by ordinality)
    into report from jsonb_array_elements(plan->'test_cases') with ordinality;
  args := jsonb_build_object('attempt_id',plan->>'attempt_id','execution_id',gen_random_uuid(),'code_digest',repeat('a',64),'submitted',false,'tests',report);
  actual := public.iwb_practice('record_local_execution',args);
  if actual->>'verification' is distinct from 'not_server_verified' or actual->>'all_passed' is distinct from 'false' then
    raise exception 'record_local_execution(failed, unsubmitted): expected unverified failed report, actual %',actual;
  end if;
  if public.iwb_practice('record_local_execution',args) is distinct from actual then raise exception 'record_local_execution repeated ID: expected saved report'; end if;

  session_data := public.iwb_practice('start_design_session','{"problem_id":"design-link-aliases"}');
  ids := jsonb_build_object('session_id',session_data->>'id');
  actual := public.iwb_practice('get_design_session',ids);
  if actual is distinct from session_data or actual->'brief' ? 'hints' then raise exception 'get_design_session(%): expected original session without hints, actual %',ids,actual; end if;
  args := ids || jsonb_build_object('checkpoint_id',checkpoint_id,'scene_digest',repeat('b',64),'notes',jsonb_build_object('requirements','The deployment test checks account ownership and keeps the original completion time.'),'diagram','[]'::jsonb,'label','Deployment test');
  saved := public.iwb_practice('save_design_checkpoint',args);
  if public.iwb_practice('save_design_checkpoint',args) is distinct from saved then raise exception 'save_design_checkpoint(%): expected immutable retry',args; end if;
  ids := ids || jsonb_build_object('checkpoint_id',checkpoint_id);
  message := null;
  begin perform public.iwb_practice('finish_design_session',ids); exception when others then message := sqlerrm; end;
  if message is distinct from 'Review this checkpoint before finishing the session.' then raise exception 'finish_design_session(%), before review: expected rejection, actual %',ids,message; end if;
  actual := public.iwb_practice('evaluate_design',ids);
  if jsonb_array_length(actual->'items')<>6 then raise exception 'evaluate_design(%): expected six review items, actual %',ids,actual; end if;
  finished := public.iwb_practice('finish_design_session',ids);
  if finished->>'status' is distinct from 'completed' or finished->>'completed_at' is null then raise exception 'finish_design_session(%): expected completion timestamp, actual %',ids,finished; end if;
  actual := public.iwb_practice('finish_design_session',ids);
  if actual is distinct from finished then raise exception 'finish_design_session(%), retry: expected %, actual %',ids,finished,actual; end if;
  actual := public.iwb_practice('get_design_session',ids-'checkpoint_id');
  if actual is distinct from finished then raise exception 'get_design_session(%), after finish: expected %, actual %',ids,finished,actual; end if;
  message := null;
  begin perform public.iwb_practice('save_design_checkpoint',args); exception when others then message := sqlerrm; end;
  if message is distinct from 'Start a new practice session to add evidence after finishing.' then raise exception 'save_design_checkpoint(%), after finish: expected rejection, actual %',args,message; end if;
  if public.iwb_practice('get_design_snapshot',ids) is distinct from saved then raise exception 'get_design_snapshot(%): expected unchanged checkpoint',ids; end if;
  message := null;
  begin perform public.iwb_practice('get_design_session',(ids-'checkpoint_id')||jsonb_build_object('owner_id',alice)); exception when others then message := sqlerrm; end;
  if message is distinct from 'These arguments are not permitted.' then raise exception 'get_design_session(owner_id injected): expected argument rejection, actual %',message; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',bob,'role','authenticated')::text,true);
  foreach operation in array array['get_design_session','get_design_brief','get_design_snapshot','evaluate_design','finish_design_session'] loop
    message := null;
    begin perform public.iwb_practice(operation,case when operation in ('get_design_session','get_design_brief') then ids-'checkpoint_id' else ids end); exception when others then message := sqlerrm; end;
    if message is distinct from 'Design session not found.' then raise exception '%(%), other account: expected ownership rejection, actual %',operation,ids,message; end if;
  end loop;
  message := null;
  begin perform public.iwb_practice('get_local_execution_plan',jsonb_build_object('attempt_id',old_attempt)); exception when others then message := sqlerrm; end;
  if message is distinct from 'Attempt not found. Call start_problem first.' then raise exception 'get_local_execution_plan(%), other account: expected ownership rejection, actual %',old_attempt,message; end if;
  message := null;
  begin perform count(*) from public.iwb_content; exception when insufficient_privilege then message := 'denied'; end;
  if message is distinct from 'denied' then raise exception 'direct content SELECT: expected permission denied, actual %',message; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',alice,'role','authenticated','is_anonymous',true)::text,true);
  message := null;
  begin perform public.iwb_practice('get_design_session',ids-'checkpoint_id'); exception when others then message := sqlerrm; end;
  if message is distinct from 'User authentication is necessary.' then raise exception 'anonymous identity: expected rejection, actual %',message; end if;
end $$;
rollback;
select 'passed' as database_contracts, 'rolled_back' as fixture_state;
