-- offcut 클라우드 백업 테이블 — Supabase SQL Editor에서 실행
-- 사용자당 로그 상태 JSON 한 덩어리 (메타데이터만, 영상 클립은 백업 안 함)

create table if not exists backups (
  user_id uuid primary key references auth.users on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table backups enable row level security;

create policy "본인 백업만 접근" on backups
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
