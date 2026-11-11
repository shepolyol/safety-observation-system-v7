-- Safety Observation System — Supabase schema
-- Run this entire script once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.employees (
  employee_id text primary key,
  full_name text not null,
  department text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_email_format check (email is null or email = '' or email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')
);

create table if not exists public.reports (
  id text primary key,
  type text not null check (type in ('Unsafe Action', 'Unsafe Condition', 'Near Miss', '5S')),
  category text not null,
  dept text not null,
  place text not null,
  equipment text not null default '',
  detail text not null,
  status text not null default 'New Report' check (status in ('New Report', 'Under Review', 'Assigned', 'In Progress', 'Verification', 'Closed')),
  report_date date not null default current_date,
  reporter text not null,
  reporter_id text not null,
  photos jsonb not null default '[]'::jsonb,
  suggestion text not null default '',
  action text not null default '',
  owner_id text references public.employees(employee_id) on update cascade on delete set null,
  owner_name text not null default 'Admin - รอรับเรื่อง',
  rank text check (rank is null or rank in ('A', 'B', 'C')),
  notification_no text not null default '',
  is_cleared boolean not null default false,
  clear_reason text not null default '',
  duplicate_of text,
  cleared_at timestamptz,
  cleared_by text not null default '',
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_logs (
  id uuid primary key default gen_random_uuid(),
  report_id text,
  recipient text,
  subject text not null,
  status text not null,
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_reporter_id_idx on public.reports (reporter_id);
create index if not exists reports_status_idx on public.reports (status);
create index if not exists reports_clear_state_idx on public.reports (is_cleared);
create index if not exists reports_duplicate_of_idx on public.reports (duplicate_of);
create index if not exists employees_full_name_idx on public.employees (full_name);
create index if not exists email_logs_created_at_idx on public.email_logs (created_at desc);

-- Lock direct browser access. The Netlify Function uses the Supabase secret key
-- on the server only, after validating the Admin session where required.
alter table public.employees enable row level security;
alter table public.reports enable row level security;
alter table public.email_logs enable row level security;

revoke all on public.employees from anon, authenticated;
revoke all on public.reports from anon, authenticated;
revoke all on public.email_logs from anon, authenticated;
grant all on public.employees to service_role;
grant all on public.reports to service_role;
grant all on public.email_logs to service_role;
