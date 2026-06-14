-- ============================================================================
-- Phase 1 verification — run AFTER loop_state_layer.sql, on a branch/staging DB.
-- Returns one results table; every `result` should start with PASS.
-- Inserts temporary chk* rows and deletes them at the end (DB stays clean).
-- ============================================================================

drop table if exists _chk;
create temp table _chk(step text, result text);

-- CHECK 1: status CHECK constraint  (PASS = invalid status rejected)
do $$
begin
  begin
    insert into loop_state(agent_key,loop_key,status) values('chk1','chk1','sleeping');
    insert into _chk values('1. status CHECK','FAIL: invalid status accepted');
  exception when check_violation then
    insert into _chk values('1. status CHECK','PASS: invalid status rejected');
  end;
end $$;

-- CHECK 2a: unique(agent_key,loop_key)  (PASS = duplicate rejected)
insert into loop_state(agent_key,loop_key,status,run_count) values('chk2','chk2','idle',0)
  on conflict (agent_key,loop_key) do nothing;
do $$
begin
  begin
    insert into loop_state(agent_key,loop_key,status) values('chk2','chk2','running');
    insert into _chk values('2a. unique','FAIL: duplicate accepted');
  exception when unique_violation then
    insert into _chk values('2a. unique','PASS: duplicate rejected');
  end;
end $$;

-- CHECK 2b: upsert updates, no duplicate  (PASS = 1 row, run_count=1)
insert into loop_state(agent_key,loop_key,status,run_count,updated_at)
  values('chk2','chk2','running',1,now())
  on conflict (agent_key,loop_key) do update
    set status=excluded.status, run_count=excluded.run_count, updated_at=excluded.updated_at;
insert into _chk
  select '2b. upsert',
    case when count(*)=1 and max(run_count)=1 then 'PASS: 1 row, run_count=1'
         else 'FAIL: '||count(*)||' rows' end
  from loop_state where agent_key='chk2' and loop_key='chk2';

-- CHECK 3: loop_board ORDER BY + staleness  (PASS = error first, idle last, staleness set)
insert into loop_state(agent_key,loop_key,status,updated_at) values
  ('chk3','idle_loop','idle',   now()-interval '1 min'),
  ('chk3','run_loop','running', now()-interval '2 min'),
  ('chk3','err_loop','error',   now()-interval '3 min'),
  ('chk3','blk_loop','blocked', now()-interval '4 min')
  on conflict (agent_key,loop_key) do nothing;
insert into _chk
  select '3. board order/staleness',
    case when (select status from loop_board where agent_key='chk3' limit 1)='error'
          and (select status from loop_board where agent_key='chk3' offset 3 limit 1)='idle'
          and (select bool_and(staleness is not null) from loop_board where agent_key='chk3')
         then 'PASS: error first, idle last, staleness set' else 'FAIL' end;

-- CHECK 4: RLS enabled + policies present
insert into _chk
  select '4a. RLS enabled',
    case when bool_and(relrowsecurity) then 'PASS: RLS on loop_state+loop_log' else 'FAIL' end
  from pg_class where relname in ('loop_state','loop_log');
insert into _chk
  select '4b. RLS policies',
    case when count(*)=2 then 'PASS: 2 authenticated SELECT policies'
         else 'FAIL: '||count(*)||' policies' end
  from pg_policies where tablename like 'loop_%';

-- cleanup the temporary check rows
delete from loop_state where agent_key in ('chk1','chk2','chk3');

-- RESULTS
select * from _chk order by step;
