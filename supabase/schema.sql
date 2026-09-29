-- Skill Ledger: schema per la sincronizzazione.
-- Incolla tutto nel SQL Editor del tuo progetto Supabase ed esegui una volta.

create table if not exists public.records (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  bigint not null,               -- orologio del dispositivo (ms), decide chi vince
  deleted     boolean not null default false,
  synced_at   timestamptz not null default clock_timestamp()  -- orologio del server, cursore di sync
);

create index if not exists records_user_synced_idx on public.records (user_id, synced_at);

-- Ogni scrittura aggiorna synced_at; un aggiornamento più vecchio di quello salvato viene ignorato.
create or replace function public.records_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;               -- tieni la versione più recente già sul server
    end if;
    new.user_id := old.user_id;  -- un record non cambia mai proprietario
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists records_before_write on public.records;
create trigger records_before_write
  before insert or update on public.records
  for each row execute function public.records_before_write();

-- Ognuno vede e modifica solo i propri dati.
alter table public.records enable row level security;

drop policy if exists "records_select_own" on public.records;
create policy "records_select_own" on public.records
  for select using (auth.uid() = user_id);

drop policy if exists "records_insert_own" on public.records;
create policy "records_insert_own" on public.records
  for insert with check (auth.uid() = user_id);

drop policy if exists "records_update_own" on public.records;
create policy "records_update_own" on public.records
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "records_delete_own" on public.records;
create policy "records_delete_own" on public.records
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Allegati (foto e PDF): bucket privato. Ogni utente legge e scrive solo
-- nella propria cartella, che ha come nome il suo id utente.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)  -- 50 MB per file (foto, audio, video, PDF)
on conflict (id) do nothing;
update storage.buckets set file_size_limit = 52428800 where id = 'attachments';

drop policy if exists "attachments_select_own" on storage.objects;
create policy "attachments_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachments_insert_own" on storage.objects;
create policy "attachments_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachments_update_own" on storage.objects;
create policy "attachments_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachments_delete_own" on storage.objects;
create policy "attachments_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
