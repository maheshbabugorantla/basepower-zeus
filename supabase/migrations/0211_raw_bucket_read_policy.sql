-- The public web app signs short-lived download links for raw source files
-- (all public datasets) with the publishable key, so it no longer holds the
-- service-role key. This is the only policy on storage.objects: anon may
-- SELECT (read/sign) objects in bucket `raw`. With RLS default-deny and no
-- insert/update/delete policy, anon cannot write or remove anything.
drop policy if exists raw_bucket_anon_read on storage.objects;
create policy raw_bucket_anon_read on storage.objects
  for select to anon
  using (bucket_id = 'raw');
