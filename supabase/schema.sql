-- ============================================================
--  計算道場 — テーブル定義（ドリル型テンプレ共通 + 計算道場の追加分）（何度実行しても安全）
--  Supabase の SQL Editor で実行する。
--  ★ drill_records / drill_progress は joshiki-dojo・tokushuzan-dojo・unit-drill と共用のテーブル。
--    アプリの区別は APP.id（theme の接頭辞 / drill_progress.app 列）で行うので、
--    すでに同じSupabaseプロジェクトにある場合は何も変更されない（create if not exists）。
--  認証なし運用: あだな(user_id)で絞り込む。RLSは anon に全許可（家庭内・個人利用向け）
-- ============================================================

-- セッション記録（1回の練習 = 1行）。theme = "アプリID:モジュールID:レベル"
create table if not exists public.drill_records (
  id         bigint generated always as identity primary key,
  user_id    text        not null,
  score      integer     not null,            -- 正答率(0〜100)
  theme      text        not null,
  played_at  timestamptz not null default now(),
  total_q    integer                          -- 出題数（正解数 = score/100 * total_q）
);
create index if not exists drill_records_user_idx on public.drill_records (user_id, played_at);

-- 項目ごとの習熟度（正解カウント 0〜clearCount）
create table if not exists public.drill_progress (
  user_id    text        not null,
  app        text        not null,            -- APP.id
  item_key   text        not null,            -- 例: 'warizan:lv08:s1'
  count      smallint    not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, app, item_key)
);
create index if not exists drill_progress_app_idx on public.drill_progress (app);

alter table public.drill_records  enable row level security;
alter table public.drill_progress enable row level security;

drop policy if exists "drill_records anon all"  on public.drill_records;
drop policy if exists "drill_progress anon all" on public.drill_progress;
create policy "drill_records anon all"  on public.drill_records  for all to anon, authenticated using (true) with check (true);
create policy "drill_progress anon all" on public.drill_progress for all to anon, authenticated using (true) with check (true);

-- ============================================================
--  計算道場（keisan-dojo）の追加分（何度実行しても安全）
-- ============================================================
-- 連続モードのタイム（秒）。他の道場アプリは使わない（null のまま）
alter table public.drill_records add column if not exists time_sec integer;

-- 進捗メールの送信ログ（Edge Function keisan-report がレート制限に使う）
-- RLS有効・ポリシーなし = anon からは読めない/書けない。service_role（Edge Function）だけが触る
create table if not exists public.drill_report_logs (
  id         bigint generated always as identity primary key,
  app        text        not null,
  user_id    text        not null,
  email      text        not null,
  status     text        not null,            -- 'sent' | 'failed'
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists drill_report_logs_idx on public.drill_report_logs (created_at);
alter table public.drill_report_logs enable row level security;
