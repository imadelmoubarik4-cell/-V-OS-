-- S88 private Atlas AI media bucket.
--
-- Photos, documents and voice notes attached in Atlas AI conversations
-- (docs/ai/Atlas_AI_Architecture.md §7, §9). Same pattern as
-- atlas-profile-photos: the bucket is private and has NO storage.objects
-- policies for anon or authenticated, so browsers can neither list, read nor
-- write objects directly. atlas-ai uploads and signs short-lived URLs with the
-- service role after checking ownership in atlas_private.ai_media. Retention
-- is enforced by public.atlas_ai_media_purge_expired().

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'atlas-ai-media',
  'atlas-ai-media',
  false,
  26214400,
  array[
    'image/jpeg','image/png','image/webp','image/heic','image/heif',
    'application/pdf','text/plain','text/csv',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'
  ]::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();

-- No storage.objects policy is created for this bucket on purpose.
