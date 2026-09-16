-- Migration 0207: Depoimentos + NPS
-- Tabelas: depoimentos, survey_sessions, nps_respostas
-- RLS tenant_isolation em todas
-- Idempotência: unique(organization_id, contact_id, md5(content)) em depoimentos
-- Aprovação: audit log + crm_lead_activities

-- ========== TABLE: depoimentos ==========
create table public.depoimentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete set null,
  type text not null,
  content text not null,
  media_url text,
  media_file_path text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by_user_id uuid references auth.users(id) on delete set null,
  rating_submitted_at timestamptz,
  constraint depoimentos_type_check check (type in ('texto', 'video', 'audio')),
  constraint depoimentos_status_check check (status in ('pending', 'approved', 'rejected')),
  unique(organization_id, contact_id, md5(content))
);

create index idx_depoimentos_org_created on depoimentos(organization_id, created_at desc);
create index idx_depoimentos_contact on depoimentos(contact_id);
create index idx_depoimentos_status on depoimentos(organization_id, status);

-- ========== TABLE: survey_sessions ==========
create table public.survey_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete set null,
  status text not null default 'in_progress',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  nps_score int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint survey_sessions_status_check check (status in ('in_progress', 'completed', 'abandoned')),
  constraint survey_sessions_nps_score_check check (nps_score is null or (nps_score >= 0 and nps_score <= 10))
);

create index idx_survey_sessions_org_created on survey_sessions(organization_id, created_at desc);
create index idx_survey_sessions_contact on survey_sessions(contact_id);
create index idx_survey_sessions_status on survey_sessions(organization_id, status);

-- ========== TABLE: nps_respostas ==========
create table public.nps_respostas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete set null,
  survey_session_id uuid not null references survey_sessions(id) on delete cascade,
  question_id text not null,
  score int,
  answer text,
  created_at timestamptz not null default now(),
  constraint nps_respostas_score_check check (score is null or (score >= 0 and score <= 10))
);

create index idx_nps_respostas_session on nps_respostas(survey_session_id);
create index idx_nps_respostas_contact on nps_respostas(contact_id);
create index idx_nps_respostas_org_question on nps_respostas(organization_id, question_id);

-- ========== TRIGGER: atualizar nps_score em survey_sessions ==========
create or replace function public.fn_update_survey_session_nps_score()
returns trigger as $$
begin
  update survey_sessions
  set nps_score = (
    select score
    from nps_respostas
    where survey_session_id = new.survey_session_id
      and question_id = 'likelihood_recommend'
    limit 1
  )
  where id = new.survey_session_id;
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_nps_respostas_update_session_score
after insert on nps_respostas
for each row
execute function fn_update_survey_session_nps_score();

revoke execute on function public.fn_update_survey_session_nps_score() from public, anon;
grant execute on function public.fn_update_survey_session_nps_score() to authenticated, service_role;

-- ========== RLS POLICIES ==========
alter table depoimentos enable row level security;
create policy tenant_isolation_depoimentos_all
  on depoimentos for all
  using (organization_id in (select fn_user_org_ids()));

alter table survey_sessions enable row level security;
create policy tenant_isolation_survey_sessions_all
  on survey_sessions for all
  using (organization_id in (select fn_user_org_ids()));

alter table nps_respostas enable row level security;
create policy tenant_isolation_nps_respostas_all
  on nps_respostas for all
  using (organization_id in (select fn_user_org_ids()));
