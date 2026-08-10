from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / 'supabase/migrations/20260803173422_atlas_team_profile_photos_checkpoint_e1.sql').read_text()
EDGE = (ROOT / 'supabase/functions/atlas-team-profile-photos/index.ts').read_text()
CONFIG = (ROOT / 'supabase/config.toml').read_text()
BROWSER_CONFIG = (ROOT / 'apps/web/config.js').read_text()
BROWSER = (ROOT / 'apps/web/assets/js/team-profile-photos.js').read_text()


class TeamProfilePhotosContractTests(unittest.TestCase):
    def test_bucket_is_private_and_constrained(self):
        self.assertIn("'atlas-profile-photos'", MIGRATION)
        self.assertIn('false,\n  2097152', MIGRATION)
        for mime in ('image/webp', 'image/jpeg', 'image/png'):
            self.assertIn(mime, MIGRATION)
        self.assertIn("check (bucket_id='atlas-profile-photos')", MIGRATION)
        self.assertIn('check (byte_size between 1 and 2097152)', MIGRATION)

    def test_photo_metadata_is_private_and_rls_protected(self):
        self.assertIn('create table if not exists atlas_private.team_profile_photos', MIGRATION)
        self.assertIn('alter table atlas_private.team_profile_photos enable row level security', MIGRATION)
        self.assertIn('revoke all on atlas_private.team_profile_photos from public,anon,authenticated', MIGRATION)
        self.assertIn('grant all on atlas_private.team_profile_photos to service_role', MIGRATION)
        self.assertNotIn('to authenticated using (true)', MIGRATION.lower())

    def test_photo_mutations_are_self_or_manager_and_audited(self):
        self.assertIn("p_actor_role not in ('admin','manager') and p_profile_id<>p_actor_id", MIGRATION)
        self.assertIn('profile_photo_updated', MIGRATION)
        self.assertIn('profile_photo_removed', MIGRATION)
        self.assertIn('previous_storage_path', MIGRATION)
        self.assertIn('team_profile_events', MIGRATION)

    def test_rpc_surface_is_service_role_only(self):
        signatures = (
            'public.atlas_team_profile_photos_snapshot(uuid[])',
            'public.atlas_team_profile_photo_upsert(uuid,text,text,text,integer,integer,integer,uuid,uuid,text,text)',
            'public.atlas_team_profile_photo_remove(uuid,uuid,text,text)',
        )
        for signature in signatures:
            self.assertIn(f'revoke execute on function {signature} from public,anon,authenticated', MIGRATION)
            self.assertIn(f'grant execute on function {signature} to service_role', MIGRATION)
        self.assertNotIn('security definer', MIGRATION.lower())

    def test_gateway_revalidates_active_profile_and_visible_directory(self):
        self.assertIn('requireActiveProfile', EDGE)
        self.assertIn('This Atlas profile is inactive. Team access has been removed.', EDGE)
        self.assertIn('visibleProfiles', EDGE)
        self.assertIn('profile.active || profile.id === context.user.id', EDGE)
        self.assertIn('Staff may change only their own profile photo.', EDGE)
        self.assertIn('[functions.atlas-team-profile-photos]', CONFIG)
        self.assertIn('verify_jwt = false', CONFIG)

    def test_upload_validates_bytes_and_uses_unique_paths(self):
        self.assertIn('MAX_PHOTO_BYTES = 2 * 1024 * 1024', EDGE)
        self.assertIn('detectedImageType', EDGE)
        self.assertIn('0x89', EDGE)
        self.assertIn('0xff', EDGE)
        self.assertIn('RIFF', EDGE)
        self.assertIn('WEBP', EDGE)
        self.assertIn('const version = crypto.randomUUID()', EDGE)
        self.assertIn('profiles/${profileId}/${version}.${imageType.extension}', EDGE)
        self.assertIn('x-upsert', EDGE)

    def test_storage_access_stays_server_side(self):
        self.assertIn('/storage/v1/object/sign/', EDGE)
        self.assertIn('/storage/v1/object/${PHOTO_BUCKET}/', EDGE)
        self.assertIn('deleteStorageObjects', EDGE)
        self.assertIn('previous_storage_path', EDGE)
        self.assertIn('SUPABASE_SERVICE_ROLE_KEY', EDGE)
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY', BROWSER_CONFIG + BROWSER)
        self.assertNotIn('/storage/v1/object', BROWSER)
        self.assertNotRegex(BROWSER, r'\.from\s*\(')

    def test_browser_prepares_small_square_photos_before_upload(self):
        self.assertIn('const target = 512', BROWSER)
        self.assertIn("canvasBlob(canvas, 'image/webp', 0.86)", BROWSER)
        self.assertIn('MAX_UPLOAD_BYTES = 2 * 1024 * 1024', BROWSER)
        self.assertIn('new FormData()', BROWSER)
        self.assertIn("request('upload'", BROWSER)
        self.assertIn("request('remove'", BROWSER)
        self.assertIn('TEAM_PROFILE_PHOTOS_API', BROWSER_CONFIG)


if __name__ == '__main__':
    unittest.main()
