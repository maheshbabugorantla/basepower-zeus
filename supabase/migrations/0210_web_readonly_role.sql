-- The public web app connects as zeus_web_ro, a role that can only read.
-- Belt and braces: (1) only SELECT/EXECUTE grants, no write privileges on
-- any schema; (2) every session starts read-only (default_transaction_
-- read_only), so even a stray INSERT errors with "cannot execute ... in a
-- read-only transaction"; (3) short statement timeout. RLS stays on: the
-- role gets SELECT-only policies. The password is set out of band (never
-- in this file); pipelines keep using the owner role.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
    create role zeus_web_ro nologin noinherit nocreatedb nocreaterole;
  end if;
end $$;

alter role zeus_web_ro set default_transaction_read_only = on;
alter role zeus_web_ro set statement_timeout = '15s';
alter role zeus_web_ro set search_path = api, core, extensions, public;

grant usage on schema api, core, ops, extensions to zeus_web_ro;
grant select on all tables in schema api, core, ops to zeus_web_ro;
grant execute on all functions in schema api to zeus_web_ro;
alter default privileges in schema api grant select on tables to zeus_web_ro;
alter default privileges in schema core grant select on tables to zeus_web_ro;
alter default privileges in schema ops grant select on tables to zeus_web_ro;
alter default privileges in schema api grant execute on functions to zeus_web_ro;

-- SELECT-only RLS policies on every RLS-enabled table in core/ops.
do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relrowsecurity and n.nspname in ('core', 'ops')
  loop
    execute format('drop policy if exists web_ro_select on %I.%I', r.nspname, r.relname);
    execute format('create policy web_ro_select on %I.%I for select to zeus_web_ro using (true)', r.nspname, r.relname);
  end loop;
end $$;
