-- =====================================================================
--  الإفادات المتقدّمة — التخزين (Migration 2)
--  بكت report-files (خاص) لمرفقات الإفادات + سياسات storage.objects.
--  المسار: {team}/{thread_id}/{uuid}__{filename}  → foldername[1] = الوردية.
--  الرفع/القراءة/الحذف: المسؤول تحت مجلد ورديته، ورئيس القسم لأي مجلد.
-- =====================================================================
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-files','report-files', false, 15728640, array[
  'image/jpeg','image/png','image/webp','image/gif','image/heic',
  'application/pdf','text/plain','text/csv',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists report_files_upload on storage.objects;
drop policy if exists report_files_read   on storage.objects;
drop policy if exists report_files_delete on storage.objects;

create policy report_files_upload on storage.objects for insert to authenticated
  with check ( bucket_id = 'report-files'
    and (public.is_owner() or (storage.foldername(name))[1] = public.audit_current_user_team()) );

create policy report_files_read on storage.objects for select to authenticated
  using ( bucket_id = 'report-files'
    and (public.is_owner() or (storage.foldername(name))[1] = public.audit_current_user_team()) );

create policy report_files_delete on storage.objects for delete to authenticated
  using ( bucket_id = 'report-files'
    and (public.is_owner() or (storage.foldername(name))[1] = public.audit_current_user_team()) );

commit;
