-- Account-owned practice records. The public RPC is the only app write path.
create table public.iwb_content (
  kind text not null check (kind in ('coding', 'design')),
  problem_id text not null,
  revision text not null check (revision ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  scaffold jsonb,
  available boolean not null default true,
  primary key (kind, problem_id, revision)
);
create unique index iwb_current_content on public.iwb_content(kind, problem_id) where available;

create table public.iwb_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'coding' check (kind = 'coding'),
  problem_id text not null,
  revision text not null,
  language text not null default 'python' check (language = 'python'),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (kind, problem_id, revision) references public.iwb_content(kind, problem_id, revision),
  unique (id, owner_id)
);
create index iwb_attempt_owner on public.iwb_attempts(owner_id, started_at desc);

create table public.iwb_design_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'design' check (kind = 'design'),
  problem_id text not null,
  revision text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (kind, problem_id, revision) references public.iwb_content(kind, problem_id, revision),
  unique (id, owner_id)
);
create index iwb_design_owner on public.iwb_design_sessions(owner_id, started_at desc);

create table public.iwb_checkpoints (
  id uuid primary key,
  session_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  scene_digest text not null check (scene_digest ~ '^[a-f0-9]{64}$'),
  notes jsonb not null check (jsonb_typeof(notes) = 'object'),
  diagram jsonb not null check (jsonb_typeof(diagram) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, owner_id) references public.iwb_design_sessions(id, owner_id) on delete cascade,
  unique (id, owner_id)
);
create index iwb_checkpoint_session on public.iwb_checkpoints(session_id, created_at desc);

create table public.iwb_design_reviews (
  id uuid primary key default gen_random_uuid(),
  checkpoint_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (checkpoint_id, owner_id) references public.iwb_checkpoints(id, owner_id) on delete cascade
);
create index iwb_review_checkpoint on public.iwb_design_reviews(checkpoint_id);

alter table public.iwb_content enable row level security;
alter table public.iwb_attempts enable row level security;
alter table public.iwb_design_sessions enable row level security;
alter table public.iwb_checkpoints enable row level security;
alter table public.iwb_design_reviews enable row level security;
create policy iwb_own_attempts on public.iwb_attempts for select to authenticated using ((select auth.uid()) = owner_id);
create policy iwb_own_designs on public.iwb_design_sessions for select to authenticated using ((select auth.uid()) = owner_id);
create policy iwb_own_checkpoints on public.iwb_checkpoints for select to authenticated using ((select auth.uid()) = owner_id);
create policy iwb_own_reviews on public.iwb_design_reviews for select to authenticated using ((select auth.uid()) = owner_id);
-- No direct grants: snapshots contain future hints and must not be disclosed.
revoke all on public.iwb_content, public.iwb_attempts, public.iwb_design_sessions,
  public.iwb_checkpoints, public.iwb_design_reviews from anon, authenticated;

create schema if not exists iwb_private;
revoke all on schema iwb_private from public, anon, authenticated;

create function iwb_private.keep_content() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.kind, new.problem_id, new.revision, new.payload, new.scaffold)
     is distinct from (old.kind, old.problem_id, old.revision, old.payload, old.scaffold) then
    raise exception 'Content revisions are immutable.';
  end if;
  return new;
end;
$$;
create trigger iwb_immutable_content before update on public.iwb_content
  for each row execute function iwb_private.keep_content();

create function iwb_private.keep_evidence() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Saved evidence is immutable.';
end;
$$;
create trigger iwb_immutable_checkpoint before update on public.iwb_checkpoints
  for each row execute function iwb_private.keep_evidence();
create trigger iwb_immutable_review before update on public.iwb_design_reviews
  for each row execute function iwb_private.keep_evidence();

create function iwb_private.session_result(row_data public.iwb_design_sessions, content jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', row_data.id, 'problem_id', row_data.problem_id,
    'brief', content - 'hints', 'status', row_data.status,
    'started_at', row_data.started_at, 'completed_at', row_data.completed_at);
$$;
create function iwb_private.checkpoint_result(row_data public.iwb_checkpoints)
returns jsonb language sql immutable set search_path = '' as $$
  select to_jsonb(row_data) - 'owner_id';
$$;

-- Each call derives ownership from the verified request identity, never arguments.
create function public.iwb_practice(operation text, arguments jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account uuid := auth.uid();
  content public.iwb_content;
  attempt public.iwb_attempts;
  design public.iwb_design_sessions;
  checkpoint public.iwb_checkpoints;
  existing public.iwb_checkpoints;
  item jsonb;
  criterion jsonb;
  result jsonb;
  normalized_notes jsonb := '{}';
  normalized_diagram jsonb := '[]';
  review_items jsonb := '[]';
  note_key text;
  note_text text;
  description text;
  checkpoint_label text;
  allowed_arguments text[];
  depth integer;
  row_limit integer;
  discussed integer := 0;
  completed integer := 0;
  in_progress integer := 0;
  total integer := 0;
begin
  if account is null or coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'User authentication is necessary.' using errcode = '42501';
  end if;
  if jsonb_typeof(arguments) is distinct from 'object' then raise exception 'Arguments must be an object.'; end if;
  allowed_arguments := case operation
    when 'get_problem_catalog' then array[]::text[]
    when 'list_problems' then array['difficulty','tag']
    when 'list_design_problems' then array[]::text[]
    when 'start_problem' then array['problem_id','language']
    when 'start_design_session' then array['problem_id']
    when 'get_progress' then array['limit']
    when 'get_problem_description' then array['attempt_id']
    when 'get_hint' then array['attempt_id','current_code','depth']
    when 'get_design_brief' then array['session_id']
    when 'get_design_hint' then array['session_id','depth']
    when 'list_design_checkpoints' then array['session_id','limit']
    when 'save_design_checkpoint' then array['session_id','checkpoint_id','scene_digest','notes','diagram','label']
    when 'get_design_snapshot' then array['session_id','checkpoint_id']
    when 'evaluate_design' then array['session_id','checkpoint_id']
    when 'finish_design_session' then array['session_id','checkpoint_id']
    else null end;
  if allowed_arguments is null then raise exception 'Tool is not available.'; end if;
  -- Direct REST callers have the same argument boundary as MCP clients.
  if (arguments - allowed_arguments) <> '{}'::jsonb then
    raise exception 'These arguments are not permitted.';
  end if;

  if operation = 'get_problem_catalog' then
    select jsonb_build_object(
      'difficulties', (select coalesce(jsonb_agg(v order by v), '[]') from
        (select distinct payload->>'difficulty' v from public.iwb_content where kind='coding' and available) x),
      'tags', (select coalesce(jsonb_agg(v order by v), '[]') from
        (select distinct jsonb_array_elements_text(payload->'tags') v from public.iwb_content where kind='coding' and available) x),
      'pattern_tags', (select coalesce(jsonb_agg(v order by v), '[]') from
        (select distinct jsonb_array_elements_text(payload->'pattern_tags') v from public.iwb_content where kind='coding' and available) x)
    ) into result;
    return result;
  elsif operation = 'list_problems' then
    select coalesce(jsonb_agg(jsonb_build_object('id', problem_id, 'title', payload->'title',
      'difficulty', payload->'difficulty', 'tags', payload->'tags', 'pattern_tags', payload->'pattern_tags') order by problem_id), '[]')
      into result from public.iwb_content where kind='coding' and available
      and (arguments->>'difficulty' is null or payload->>'difficulty'=arguments->>'difficulty')
      and (arguments->>'tag' is null or payload->'tags' ? (arguments->>'tag'));
    return result;
  elsif operation = 'list_design_problems' then
    select coalesce(jsonb_agg(jsonb_build_object('id', problem_id, 'title', payload->'title',
      'difficulty', payload->'difficulty', 'tags', payload->'tags', 'revision', revision,
      'time_budget_minutes', payload->'time_budget_minutes', 'pack_id', payload->'pack_id') order by problem_id), '[]')
      into result from public.iwb_content where kind='design' and available;
    return result;
  elsif operation in ('start_problem', 'start_design_session') then
    select * into content from public.iwb_content where problem_id=arguments->>'problem_id' and available
      and kind=case when operation='start_problem' then 'coding' else 'design' end;
    if not found then raise exception 'Problem is not available.'; end if;
    if operation='start_problem' then
      if coalesce(arguments->>'language', 'python') <> 'python' then raise exception 'Python is the only supported language.'; end if;
      insert into public.iwb_attempts(owner_id, problem_id, revision)
        values (account, content.problem_id, content.revision) returning * into attempt;
      return jsonb_build_object('attempt_id', attempt.id, 'problem_id', content.problem_id,
        'problem_title', content.payload->'title', 'mode', 'remote', 'files_written', '[]'::jsonb,
        'files_to_create', jsonb_build_array(content.scaffold),
        'instructions', format('Create %s/solution.py in your workspace. Code execution uses local Docker.', content.problem_id));
    end if;
    insert into public.iwb_design_sessions(owner_id, problem_id, revision)
      values (account, content.problem_id, content.revision) returning * into design;
    return iwb_private.session_result(design, content.payload);
  elsif operation = 'get_progress' then
    row_limit := coalesce((arguments->>'limit')::integer, 50);
    if row_limit not between 1 and 500 then raise exception 'limit must be between 1 and 500.'; end if;
    description := E'| Date | Problem | Difficulty | Status |\n|---|---|---|---|';
    for attempt in select * from public.iwb_attempts where owner_id=account order by started_at desc, id limit row_limit loop
      select * into content from public.iwb_content where kind='coding' and problem_id=attempt.problem_id and revision=attempt.revision;
      description := description || E'\n' || format('| %s | %s | %s | %s |',
        to_char(attempt.started_at at time zone 'UTC', 'YYYY-MM-DD'), content.payload->>'title', content.payload->>'difficulty', attempt.status);
      total := total + 1;
      if attempt.status='completed' then completed := completed+1; else in_progress := in_progress+1; end if;
    end loop;
    if total=0 then return to_jsonb('No attempts yet. Call `start_problem` to begin.'::text); end if;
    return to_jsonb(description || E'\n\n' || format('**Summary:** %s completed, %s in progress, %s total.', completed, in_progress, total));
  elsif operation in ('get_problem_description', 'get_hint') then
    if arguments->>'attempt_id' is null and operation='get_hint' then
      select * into attempt from public.iwb_attempts where owner_id=account and status='in_progress' order by started_at desc, id limit 1;
    else
      select * into attempt from public.iwb_attempts where id=(arguments->>'attempt_id')::uuid and owner_id=account;
    end if;
    if not found then raise exception 'Attempt not found. Call start_problem first.'; end if;
    select * into content from public.iwb_content where kind='coding' and problem_id=attempt.problem_id and revision=attempt.revision;
    if operation='get_hint' then
      if octet_length(coalesce(arguments->>'current_code', '')) > 100000 then raise exception 'Solution code must be at most 100 KB.'; end if;
      depth := greatest(1, least(3, coalesce((arguments->>'depth')::integer, 1)));
      return jsonb_build_object('hint', content.payload->'fallback_hints'->(depth-1), 'depth', depth, 'used_fallback', true);
    end if;
    description := '# ' || (content.payload->>'title') || E'\n\n' || (content.payload->>'description_md') || E'\n\n## Examples\n';
    for item in select value from jsonb_array_elements(content.payload->'examples') loop
      description := description || 'Input: ' || (item->>'input') || E'\nOutput: ' || (item->>'output');
      if coalesce(item->>'explanation', '')<>'' then description := description || E'\nExplanation: ' || (item->>'explanation'); end if;
      description := description || E'\n\n';
    end loop;
    description := description || E'## Constraints\n';
    for note_text in select jsonb_array_elements_text(content.payload->'constraints') loop
      description := description || '- ' || note_text || E'\n';
    end loop;
    return to_jsonb(rtrim(description));
  end if;

  if operation not in ('get_design_brief', 'get_design_hint', 'save_design_checkpoint',
    'list_design_checkpoints', 'get_design_snapshot', 'evaluate_design', 'finish_design_session') then
    raise exception 'Tool is not available.';
  end if;
  -- Serialize all checkpoint and completion operations on their parent session.
  select * into design from public.iwb_design_sessions where id=(arguments->>'session_id')::uuid and owner_id=account for update;
  if not found then raise exception 'Design session not found.'; end if;
  select * into content from public.iwb_content where kind='design' and problem_id=design.problem_id and revision=design.revision;
  if operation='get_design_brief' then return content.payload - 'hints'; end if;
  if operation='get_design_hint' then
    depth := coalesce((arguments->>'depth')::integer, 1);
    if depth not between 1 and 3 then raise exception 'Hint depth must be between 1 and 3.'; end if;
    return jsonb_build_object('hint', content.payload->'hints'->(depth-1), 'depth', depth, 'source', 'curated');
  end if;
  if operation='list_design_checkpoints' then
    row_limit := coalesce((arguments->>'limit')::integer, 100);
    if row_limit not between 1 and 500 then raise exception 'Checkpoint limit must be between 1 and 500.'; end if;
    select coalesce(jsonb_agg(iwb_private.checkpoint_result(x) order by x.created_at desc, x.id), '[]') into result
      from (select * from public.iwb_checkpoints where session_id=design.id and owner_id=account order by created_at desc, id limit row_limit) x;
    return result;
  end if;
  if operation='save_design_checkpoint' then
    if design.status<>'in_progress' then raise exception 'Start a new practice session to add evidence after finishing.'; end if;
    if coalesce(arguments->>'scene_digest', '') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid scene fingerprint.'; end if;
    checkpoint_label := btrim(coalesce(arguments->>'label', 'Checkpoint'));
    if char_length(checkpoint_label) not between 1 and 80 then raise exception 'Checkpoint label must contain 1-80 characters.'; end if;
    if jsonb_typeof(arguments->'notes') is distinct from 'object' then raise exception 'Notes must be an object.'; end if;
    for note_key, item in select key, value from jsonb_each(arguments->'notes') loop
      if note_key <> all(array['requirements','api','data','capacity','tradeoffs','failure_modes'])
        or jsonb_typeof(item)<>'string' or char_length(item #>> '{}') > 5000 then
        raise exception 'Use the six design-note sections, at most 5000 characters each.';
      end if;
    end loop;
    foreach note_key in array array['requirements','api','data','capacity','tradeoffs','failure_modes'] loop
      normalized_notes := normalized_notes || jsonb_build_object(note_key, coalesce(arguments->'notes'->>note_key, ''));
    end loop;
    if jsonb_typeof(arguments->'diagram') is distinct from 'array' or jsonb_array_length(arguments->'diagram') > 3000 then
      raise exception 'Diagram summary is too large or invalid.';
    end if;
    for item in select value from jsonb_array_elements(arguments->'diagram') loop
      if jsonb_typeof(item)<>'object' or not (item ?& array['id','type'])
        or (item - array['id','type','label','label_truncated','kind','from_id','to_id']) <> '{}'::jsonb
        or jsonb_typeof(item->'id')<>'string' or char_length(item->>'id') not between 1 and 128
        or jsonb_typeof(item->'type')<>'string' or char_length(item->>'type') not between 1 and 30
        or (item ? 'label' and (jsonb_typeof(item->'label')<>'string' or char_length(item->>'label')>2000))
        or (item ? 'kind' and (jsonb_typeof(item->'kind')<>'string' or char_length(item->>'kind')>60))
        or (item ? 'label_truncated' and jsonb_typeof(item->'label_truncated')<>'boolean')
        or (item ? 'from_id' and (jsonb_typeof(item->'from_id') not in ('null','string') or char_length(item->>'from_id')>128))
        or (item ? 'to_id' and (jsonb_typeof(item->'to_id') not in ('null','string') or char_length(item->>'to_id')>128)) then
        raise exception 'Invalid diagram element.';
      end if;
      normalized_diagram := normalized_diagram || jsonb_build_array(jsonb_build_object(
        'id', item->'id', 'type', item->'type', 'label', coalesce(item->'label', '""'),
        'label_truncated', coalesce(item->'label_truncated', 'false'), 'kind', coalesce(item->'kind', '""'),
        'from_id', coalesce(item->'from_id', 'null'), 'to_id', coalesce(item->'to_id', 'null')));
    end loop;
    -- Seven fields produce 13 separator spaces per object, plus array separators.
    -- Subtract only these structural spaces, never spaces in the user's labels.
    if octet_length(normalized_diagram::text) - greatest(14 * jsonb_array_length(normalized_diagram) - 1, 0) > 700000 then
      raise exception 'Diagram summary is too large.';
    end if;
    select * into existing from public.iwb_checkpoints where id=(arguments->>'checkpoint_id')::uuid;
    if found then
      if existing.owner_id<>account or existing.session_id<>design.id or existing.label<>checkpoint_label
        or existing.scene_digest<>arguments->>'scene_digest' or existing.notes<>normalized_notes or existing.diagram<>normalized_diagram then
        raise exception 'A checkpoint is immutable; create a new revision.';
      end if;
      return iwb_private.checkpoint_result(existing);
    end if;
    insert into public.iwb_checkpoints(id, session_id, owner_id, label, scene_digest, notes, diagram)
      values ((arguments->>'checkpoint_id')::uuid, design.id, account, checkpoint_label,
        arguments->>'scene_digest', normalized_notes, normalized_diagram) returning * into checkpoint;
    return iwb_private.checkpoint_result(checkpoint);
  end if;
  select * into checkpoint from public.iwb_checkpoints where id=(arguments->>'checkpoint_id')::uuid and session_id=design.id and owner_id=account;
  if not found then raise exception 'Design checkpoint not found.'; end if;
  if operation='get_design_snapshot' then return iwb_private.checkpoint_result(checkpoint); end if;
  if operation='finish_design_session' then
    if not exists(select 1 from public.iwb_design_reviews where checkpoint_id=checkpoint.id and owner_id=account) then
      raise exception 'Review this checkpoint before finishing the session.';
    end if;
    update public.iwb_design_sessions set status='completed', completed_at=clock_timestamp() where id=design.id returning * into design;
    return iwb_private.session_result(design, content.payload);
  end if;
  for criterion in select value from jsonb_array_elements(content.payload->'rubric') loop
    note_text := btrim(coalesce(checkpoint.notes->>(criterion->>'key'), ''));
    if char_length(note_text)>=60 then discussed := discussed+1; end if;
    review_items := review_items || jsonb_build_array(jsonb_build_object('key', criterion->'key', 'title', criterion->'title',
      'status', case when note_text='' then 'not_discussed' when char_length(note_text)<60 then 'needs_explanation' else 'discussed' end,
      'evidence', left(note_text, 300), 'question', criterion->'prompt'));
  end loop;
  result := jsonb_build_object('checkpoint_id', checkpoint.id, 'scene_digest', checkpoint.scene_digest,
    'rubric_version', design.revision, 'source', 'curated', 'items', review_items,
    'summary', format('%s/6 sections contain at least 60 characters of explanation. Review the questions against your diagram.', discussed),
    'limitations', 'This offline rubric checks discussion coverage, not architectural correctness or hiring readiness. A filled section can still be wrong; there is no single required diagram.');
  insert into public.iwb_design_reviews(checkpoint_id, owner_id, payload) values (checkpoint.id, account, result);
  return result;
end;
$$;
revoke all on all functions in schema iwb_private from public, anon, authenticated;
revoke all on function public.iwb_practice(text, jsonb) from public, anon, authenticated;
grant execute on function public.iwb_practice(text, jsonb) to authenticated;
