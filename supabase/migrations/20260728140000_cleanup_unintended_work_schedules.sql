-- =====================================================================
--  المرحلة 8 — تنظيف تصحيحي: إزالة نطاق جداول العمل المولّد عن غير قصد
--
--  السياق: توليد غير مقصود أنشأ جداول لنطاق 2026-07-26…2026-08-31 (37 يومًا،
--  333 صفًا) بدل النطاق المعتمد 2026-08-01…2026-08-14 (14 يومًا، 126 صفًا).
--  المطلوب: إزالة 207 صفًا خارج النطاق (54 قبل + 153 بعد) و207 سجل تاريخ
--  مرتبط، مع الإبقاء الكامل على 126 صفًا داخل النطاق وسجلّها.
--
--  الأمان:
--   • معاملة واحدة (الهجرة) مع حواجز دفاعية صريحة و RAISE ⇒ Rollback كامل عند
--     أي انحراف.
--   • لا يُحذف أي صف: locked، أو source<>'rotation'، أو له attendance_session،
--     أو له تاريخ غير event_type='generated'.
--   • حذف التاريخ أولًا ثم الجدول (بلا CASCADE، بلا معرّفات مكتوبة يدويًا).
--   • لا مساس بالأيام 2026-08-01…2026-08-14، ولا بأي سياسة (السياستان تبقيان
--     كما هما — versioning صالح غير متداخل).
--   • No-op آمن: إن لم توجد أي صفوف خارج النطاق (قاعدة نظيفة/بيئة جديدة)
--     تنتهي الهجرة دون تغيير — كي تبقى قابلة لإعادة التطبيق وآمنة على أي بيئة.
--
--  ملاحظة توقيت: الطابع 20260728140000 يضع الهجرة بعد
--  20260728120000_work_schedule_policy و20260728130000_..._audit_fix كي توجد
--  الجداول عند أي تطبيق تسلسلي على بيئة جديدة.
-- =====================================================================

do $$
declare
  d_from constant date := date '2026-08-01';
  d_to   constant date := date '2026-08-14';
  v_out int; v_safe int; v_hist int; v_empdate int; v_bad int; v_sess int; v_nongen int;
  v_del_hist int; v_del_sched int;
  v_sched int; v_histc int; v_pol int; v_min date; v_max date; v_days int; v_emp int; v_dup int;
  v_work int; v_off int; v_locked int; v_manual int; v_override int; v_import int; v_rot int;
  v_histgen int; v_orphan int; v_notday9 int; v_w1 int; v_w2 int; v_other int; v_sesslink int;
  v_working_nodef int; v_off_withtimes int; v_overnight_bad int;
begin
  -- عدد الصفوف خارج النطاق المعتمد
  select count(*) into v_out from public.employee_work_schedule
    where work_date < d_from or work_date > d_to;

  -- No-op آمن: لا شيء لتنظيفه (قاعدة نظيفة / بيئة جديدة / أُطبّقت سابقًا)
  if v_out = 0 then
    raise notice 'cleanup_unintended_work_schedules: لا صفوف خارج النطاق — لا تغيير (no-op).';
    return;
  end if;

  -- ===== حواجز ما قبل الحذف (تتوقع الحالة المعتمدة بالضبط) =====
  if v_out <> 207 then
    raise exception 'CLEANUP_ABORT: صفوف خارج النطاق = % (المتوقع 207)', v_out;
  end if;

  -- مرشّحون آمنون فقط: خارج النطاق + rotation + غير مقفول + بلا جلسة + تاريخهم generated فقط
  select count(*) into v_safe from public.employee_work_schedule s
    where (s.work_date < d_from or s.work_date > d_to)
      and s.source = 'rotation'
      and s.locked_at is null
      and not exists (select 1 from public.attendance_sessions a where a.schedule_id = s.id)
      and not exists (select 1 from public.work_schedule_history h where h.schedule_id = s.id and h.event_type <> 'generated');
  if v_safe <> 207 then
    raise exception 'CLEANUP_ABORT: مرشّحون آمنون = % (المتوقع 207) — يوجد صف خارج النطاق غير آمن', v_safe;
  end if;

  select count(*) into v_hist from public.work_schedule_history h
    join public.employee_work_schedule s on s.id = h.schedule_id
    where s.work_date < d_from or s.work_date > d_to;
  if v_hist <> 207 then
    raise exception 'CLEANUP_ABORT: تاريخ المرشّحين = % (المتوقع 207)', v_hist;
  end if;

  select count(*) into v_empdate from (
    select 1 from public.employee_work_schedule
    where work_date < d_from or work_date > d_to
    group by employee_id, work_date) x;
  if v_empdate <> 207 then
    raise exception 'CLEANUP_ABORT: (employee,date) مميّزة للمرشّحين = % (المتوقع 207)', v_empdate;
  end if;

  select count(*) into v_bad from public.employee_work_schedule
    where (work_date < d_from or work_date > d_to)
      and (source <> 'rotation' or locked_at is not null);
  if v_bad <> 0 then
    raise exception 'CLEANUP_ABORT: manual/override/import/locked ضمن المرشّحين = %', v_bad;
  end if;

  select count(*) into v_sess from public.attendance_sessions a
    join public.employee_work_schedule s on s.id = a.schedule_id
    where s.work_date < d_from or s.work_date > d_to;
  if v_sess <> 0 then
    raise exception 'CLEANUP_ABORT: جلسات مرتبطة بالمرشّحين = %', v_sess;
  end if;

  select count(*) into v_nongen from public.work_schedule_history h
    join public.employee_work_schedule s on s.id = h.schedule_id
    where (s.work_date < d_from or s.work_date > d_to)
      and h.event_type <> 'generated';
  if v_nongen <> 0 then
    raise exception 'CLEANUP_ABORT: تاريخ غير generated ضمن المرشّحين = %', v_nongen;
  end if;

  -- ===== الحذف: التاريخ أولًا (بلا CASCADE) =====
  delete from public.work_schedule_history h
    using public.employee_work_schedule s
    where h.schedule_id = s.id
      and (s.work_date < d_from or s.work_date > d_to);
  get diagnostics v_del_hist = row_count;
  if v_del_hist <> 207 then
    raise exception 'CLEANUP_ABORT: تاريخ محذوف = % (المتوقع 207)', v_del_hist;
  end if;

  -- ثم الجدول — بنفس الحواجز الآمنة
  delete from public.employee_work_schedule s
    where (s.work_date < d_from or s.work_date > d_to)
      and s.source = 'rotation'
      and s.locked_at is null
      and not exists (select 1 from public.attendance_sessions a where a.schedule_id = s.id);
  get diagnostics v_del_sched = row_count;
  if v_del_sched <> 207 then
    raise exception 'CLEANUP_ABORT: جداول محذوفة = % (المتوقع 207)', v_del_sched;
  end if;

  -- ===== حواجز ما بعد الحذف =====
  select count(*) into v_sched from public.employee_work_schedule;
  select count(*) into v_histc from public.work_schedule_history;
  select count(*) into v_pol from public.attendance_policies;
  select min(work_date), max(work_date), count(distinct work_date), count(distinct employee_id)
    into v_min, v_max, v_days, v_emp from public.employee_work_schedule;
  select count(*) into v_dup from (
    select 1 from public.employee_work_schedule group by employee_id, work_date having count(*) > 1) d;
  select count(*) filter (where is_working_day),
         count(*) filter (where not is_working_day),
         count(*) filter (where locked_at is not null),
         count(*) filter (where source = 'manual'),
         count(*) filter (where source = 'override'),
         count(*) filter (where source = 'import'),
         count(*) filter (where source = 'rotation'),
         count(*) filter (where team = 'w1'),
         count(*) filter (where team = 'w2'),
         count(*) filter (where team not in ('w1','w2')),
         count(*) filter (where is_working_day and shift_definition_id is null),
         count(*) filter (where (not is_working_day) and (expected_start_at is not null or expected_end_at is not null)),
         count(*) filter (where is_overnight and shift_code is distinct from 'ليل')
    into v_work, v_off, v_locked, v_manual, v_override, v_import, v_rot, v_w1, v_w2, v_other,
         v_working_nodef, v_off_withtimes, v_overnight_bad
    from public.employee_work_schedule;
  select count(*) into v_histgen from public.work_schedule_history where event_type = 'generated';
  select count(*) into v_orphan from public.work_schedule_history h
    where not exists (select 1 from public.employee_work_schedule s where s.id = h.schedule_id);
  select count(*) into v_notday9 from (
    select 1 from public.employee_work_schedule group by work_date having count(*) <> 9) x;
  select count(*) into v_sesslink from public.attendance_sessions where schedule_id is not null;

  if v_sched  <> 126 then raise exception 'CLEANUP_ABORT: جداول بعد = % (المتوقع 126)', v_sched; end if;
  if v_histc  <> 126 then raise exception 'CLEANUP_ABORT: تاريخ بعد = % (المتوقع 126)', v_histc; end if;
  if v_pol    <> 2   then raise exception 'CLEANUP_ABORT: سياسات = % (المتوقع 2 — يجب ألا تتغيّر)', v_pol; end if;
  if v_min <> d_from or v_max <> d_to then
    raise exception 'CLEANUP_ABORT: نطاق التواريخ %..% (المتوقع %..%)', v_min, v_max, d_from, d_to;
  end if;
  if v_days   <> 14  then raise exception 'CLEANUP_ABORT: أيام مميّزة = % (المتوقع 14)', v_days; end if;
  if v_emp    <> 9   then raise exception 'CLEANUP_ABORT: موظفون مميّزون = % (المتوقع 9)', v_emp; end if;
  if v_dup    <> 0   then raise exception 'CLEANUP_ABORT: تكرارات (emp,date) = %', v_dup; end if;
  if v_work   <> 72  then raise exception 'CLEANUP_ABORT: أيام عمل = % (المتوقع 72)', v_work; end if;
  if v_off    <> 54  then raise exception 'CLEANUP_ABORT: أيام راحة = % (المتوقع 54)', v_off; end if;
  if v_locked <> 0 or v_manual <> 0 or v_override <> 0 or v_import <> 0 then
    raise exception 'CLEANUP_ABORT: مصدر/قفل غير متوقّع locked=% manual=% override=% import=%', v_locked, v_manual, v_override, v_import;
  end if;
  if v_rot    <> 126 then raise exception 'CLEANUP_ABORT: rotation = % (المتوقع 126)', v_rot; end if;
  if v_histgen<> 126 then raise exception 'CLEANUP_ABORT: تاريخ generated = % (المتوقع 126)', v_histgen; end if;
  if v_orphan <> 0   then raise exception 'CLEANUP_ABORT: تاريخ يتيم = %', v_orphan; end if;
  if v_notday9<> 0   then raise exception 'CLEANUP_ABORT: أيام بعدد صفوف <>9 = %', v_notday9; end if;
  if v_w1 <> 112 or v_w2 <> 14 or v_other <> 0 then
    raise exception 'CLEANUP_ABORT: توزيع الفرق w1=% w2=% other=% (المتوقع 112/14/0)', v_w1, v_w2, v_other;
  end if;
  if v_sesslink <> 0 then raise exception 'CLEANUP_ABORT: جلسات مرتبطة بعد = %', v_sesslink; end if;
  if v_working_nodef <> 0 then raise exception 'CLEANUP_ABORT: يوم عمل بلا تعريف وردية = %', v_working_nodef; end if;
  if v_off_withtimes <> 0 then raise exception 'CLEANUP_ABORT: يوم راحة بأوقات = %', v_off_withtimes; end if;
  if v_overnight_bad <> 0 then raise exception 'CLEANUP_ABORT: overnight لغير ليل = %', v_overnight_bad; end if;

  raise notice 'cleanup_unintended_work_schedules: حُذف 207 جدول + 207 تاريخ؛ أُبقي 126/126 (2026-08-01..2026-08-14).';
end $$;
