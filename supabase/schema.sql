-- PRV Swedish Trademark Database
-- Run once in Supabase SQL editor to create the table.

create table if not exists se_trademarks (
  id                  bigserial primary key,
  application_number  text unique not null,
  registration_number text,
  mark_text           text,
  mark_feature        text,   -- "Word", "Figurative", "Combined", etc.
  mark_status         text,   -- "Registered", "Application filed", "Ended", etc.
  applicant_name      text,
  application_date    date,
  registration_date   date,
  expiry_date         date,
  nice_classes        int[],
  kind_mark           text,   -- "Individual", "Collective", etc.
  updated_at          timestamptz default now()
);

-- Index for case-insensitive name search (used by ilike query)
create index if not exists idx_se_tm_mark_lower
  on se_trademarks (lower(mark_text));

-- Index for class filtering
create index if not exists idx_se_tm_classes
  on se_trademarks using gin (nice_classes);

-- Allow public read access (edge function uses anon key)
alter table se_trademarks enable row level security;

create policy "Public read" on se_trademarks
  for select using (true);
