-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 7/8: بذر السياسات الافتراضية (2026)
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  الافتراضات المعتمدة (بلا أي عدد أيام قانوني — يضبطه رئيس القسم):
--    سنوية        → limited     (entitled_days = NULL)
--    عارض         → limited     (entitled_days = NULL)
--    مرضية        → unlimited
--    مرافق مريض   → unlimited
--    دورة تدريبية → unlimited
--    غياب         → tracking_only
--  day_count_basis = calendar · max_carryover = 0
--  idempotent: on conflict (team, year, type) do nothing.
-- =====================================================================
begin;

insert into public.leave_policies(team, year, type, policy_mode, entitled_days, max_carryover, day_count_basis)
select s.team, 2026, d.type, d.mode, null::int, 0, 'calendar'
from (select distinct team from public.settings) s
cross join (values
  ('سنوية',        'limited'),
  ('عارض',         'limited'),
  ('مرضية',        'unlimited'),
  ('مرافق مريض',   'unlimited'),
  ('دورة تدريبية', 'unlimited'),
  ('غياب',         'tracking_only')
) as d(type, mode)
on conflict (team, year, type) do nothing;

commit;
