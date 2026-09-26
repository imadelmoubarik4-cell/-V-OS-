"""Static contract checks for the S94C publishing migration, preview and concurrency proof.

Binding documents: docs/marketing/S94_Publishing_Architecture.md and
docs/marketing/research/07-scheduler-design.md. The behaviour itself is proven by
scripts/verify_s94c_publishing_preview.sql and scripts/verify_s94c_claim_concurrency.sh;
these checks pin the shape so a later edit cannot silently drop a guard.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "supabase/migrations/20261004092000_s94c_marketing_publishing.sql"
MIGRATION = MIGRATION_PATH.read_text()
LOWER = MIGRATION.lower()
MEDIA_MIGRATION = ROOT / "supabase/migrations/20261004090000_s94a_marketing_media.sql"
CONNECTIONS_MIGRATION = ROOT / "supabase/migrations/20261004091000_s94b_publishing_connections.sql"
PREVIEW = (ROOT / "scripts/verify_s94c_publishing_preview.sql").read_text()
CONCURRENCY = (ROOT / "scripts/verify_s94c_claim_concurrency.sh").read_text()
RUNNER = (ROOT / "scripts/verify_s90_workflow_integrity_previews.sh").read_text()

PUBLIC_RPCS = {
    "atlas_marketing_delivery_claim": "text, integer, integer",
    "atlas_marketing_delivery_heartbeat": "uuid, uuid, integer",
    "atlas_marketing_delivery_record_step": "uuid, uuid, text, jsonb, jsonb",
    "atlas_marketing_delivery_begin_submit": "uuid, uuid",
    "atlas_marketing_delivery_complete": "uuid, uuid, jsonb",
    "atlas_marketing_delivery_manager_action": "uuid, uuid, text, jsonb",
    "atlas_marketing_publish_now": "uuid, uuid",
    "atlas_marketing_content_cancel": "uuid, uuid, text",
    "atlas_marketing_content_reschedule": "uuid, uuid, integer, timestamptz",
    "atlas_marketing_content_duplicate": "uuid, uuid",
    "atlas_marketing_publication_history": "uuid, uuid",
    "atlas_marketing_update_content": "uuid, uuid, integer, jsonb, text",
}

BINDING_TRANSITIONS = {
    ("queued", "publishing"), ("queued", "cancelled"),
    ("retrying", "publishing"), ("retrying", "cancelled"), ("retrying", "needs_attention"),
    ("publishing", "published"), ("publishing", "processing"), ("publishing", "retrying"),
    ("publishing", "verifying"), ("publishing", "failed"), ("publishing", "needs_attention"),
    ("processing", "published"), ("processing", "failed"), ("processing", "needs_attention"),
    ("processing", "verifying"), ("processing", "publishing"),
    ("verifying", "published"), ("verifying", "retrying"), ("verifying", "needs_attention"),
    ("failed", "queued"), ("failed", "cancelled"),
    ("needs_attention", "queued"), ("needs_attention", "published"), ("needs_attention", "cancelled"),
}
# Added from report 07's own rules (stale queued rows, cancel before any submit); documented in the migration.
ADDED_TRANSITIONS = {("queued", "needs_attention"), ("publishing", "cancelled"), ("processing", "cancelled")}


def function_body(name: str) -> str:
    match = re.search(
        r"create or replace function " + re.escape(name) + r"\(.*?\n\$\$;|create or replace function "
        + re.escape(name) + r"\(.*?\n\$function\$;",
        MIGRATION,
        re.S,
    )
    if not match:
        raise AssertionError(f"{name} not found")
    return match.group(0)


class S94CPublishingMigrationTests(unittest.TestCase):
    def test_migration_orders_after_media_and_connections(self):
        self.assertTrue(MEDIA_MIGRATION.exists())
        self.assertTrue(CONNECTIONS_MIGRATION.exists())
        self.assertLess(MEDIA_MIGRATION.name, CONNECTIONS_MIGRATION.name)
        self.assertLess(CONNECTIONS_MIGRATION.name, MIGRATION_PATH.name)
        # Owner-run rollout steps never live in the migration.
        self.assertNotIn("create extension", LOWER)
        self.assertNotIn("cron.schedule", LOWER)
        self.assertNotIn("vault.create_secret", LOWER)

    def test_content_model_columns(self):
        for column in (
            "add column if not exists version integer not null default 1",
            "add column if not exists platform_options jsonb not null default '{}'::jsonb",
            "add column if not exists approved_fingerprint bytea",
            "add column if not exists approval_id uuid",
        ):
            self.assertIn(column, MIGRATION)
        self.assertIn("marketing_content_items_platforms_check", MIGRATION)
        self.assertIn("approved_scheduled_for timestamptz", MIGRATION)

    def test_delivery_tables_are_private_and_read_only_for_the_service_role(self):
        for table in (
            "marketing_deliveries",
            "marketing_delivery_attempts",
            "marketing_provider_accounts",
            "marketing_delivery_transitions",
        ):
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public, anon, authenticated", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from service_role", MIGRATION)
            self.assertIn(f"grant select on atlas_private.{table} to service_role", MIGRATION)
        self.assertNotIn("to authenticated using (true)", LOWER)

    def test_delivery_vocabulary_matches_the_contract(self):
        for status in ("queued", "publishing", "processing", "verifying", "retrying", "published", "failed",
                       "needs_attention", "cancelled"):
            self.assertIn(f"'{status}'", MIGRATION)
        for kind in ("ig_feed", "ig_carousel", "ig_reel", "fb_page_post", "fb_page_photo", "fb_page_video", "fb_reel",
                     "tiktok_video", "tiktok_inbox_video", "gbp_local_post"):
            self.assertIn(f"'{kind}'", MIGRATION)
        self.assertIn("marketing_deliveries_live_target_uidx", MIGRATION)
        self.assertIn("where status <> 'cancelled'", MIGRATION)
        self.assertIn("max_attempts integer not null default 6", MIGRATION)

    def test_transition_table_is_the_binding_table_plus_documented_additions(self):
        block = re.search(r"insert into atlas_private\.marketing_delivery_transitions \(from_status, to_status\) values(.*?)on conflict do nothing",
                          MIGRATION, re.S).group(1)
        pairs = set(re.findall(r"\('([a-z_]+)','([a-z_]+)'\)", block))
        self.assertEqual(pairs, BINDING_TRANSITIONS | ADDED_TRANSITIONS)
        self.assertFalse({p for p in pairs if p[0] in ("published", "cancelled")})
        guard = function_body("atlas_private.marketing_delivery_guard")
        self.assertIn("illegal delivery transition", guard)
        self.assertIn("unsafe retry after submit; verify first", guard)
        self.assertIn("provider ids are write-once", guard)
        self.assertIn("a delivery that may already be posted cannot be cancelled", guard)

    def test_no_secrets_or_urls_in_stored_rows(self):
        self.assertIn("constraint attempts_steps_no_secrets check", MIGRATION)
        self.assertIn("constraint marketing_deliveries_snapshot_check check", MIGRATION)
        self.assertIn("constraint marketing_deliveries_progress_check check", MIGRATION)
        self.assertIn("constraint marketing_deliveries_error_message_check check", MIGRATION)
        self.assertIn("provider_permalink ~ '^https://", MIGRATION)
        sanitize = function_body("atlas_private.marketing_sanitize_step")
        self.assertIn("'step','http_status','provider_request_id','outcome','code','message','poll_status','detail','attempt'", sanitize)

    def test_claim_is_two_step_skip_locked_with_lease_recovery_and_fairness(self):
        claim = function_body("atlas_private.marketing_delivery_claim")
        self.assertIn("perform atlas_private.marketing_recover_expired_leases()", claim)
        self.assertIn("row_number() over (partition by d.provider_key, d.external_account_id", claim)
        self.assertIn("for no key update skip locked", claim)
        self.assertIn("atlas_private.marketing_delivery_gate_reason(r.id, v_targets)", claim)
        self.assertIn("v_cap := case when r.provider_key = 'google-business-profile' then 1 else 2 end", claim)
        recover = function_body("atlas_private.marketing_recover_expired_leases")
        self.assertIn("r.phase in ('submitting','submitted')", recover)
        self.assertIn("status = 'verifying'", recover)
        self.assertIn("outcome = 'lease_lost'", recover)
        lock = function_body("atlas_private.marketing_delivery_lock_claim")
        self.assertIn("claim_token = p_claim_token and claimed_until > pg_catalog.now()", lock)
        for name in ("heartbeat", "record_step", "begin_submit", "complete"):
            self.assertIn("'lease_lost', true", function_body(f"atlas_private.marketing_delivery_{name}"))

    def test_begin_submit_regates_and_backoff_lives_in_sql(self):
        begin = function_body("atlas_private.marketing_delivery_begin_submit")
        self.assertIn("atlas_private.marketing_delivery_gate_reason(d.id)", begin)
        self.assertIn("phase = 'submitting'", begin)
        self.assertIn("submit_started_at = pg_catalog.now()", begin)
        gate = function_body("atlas_private.marketing_delivery_gate_reason")
        for reason in ("cancel_requested", "content_cancelled", "superseded_by_edit", "stale_schedule",
                       "automatic_publishing_disabled", "no_resource", "provider_not_ready", "cooldown", "rate_limited"):
            self.assertIn(f"'{reason}'", gate)
        self.assertIn("atlas_private.marketing_content_fingerprint(c.id, v_targets) <> d.approved_fingerprint", gate)
        backoff = function_body("atlas_private.marketing_backoff")
        self.assertIn("p_cap_s integer default 3600", backoff)
        self.assertIn("atlas.marketing_backoff_jitter", backoff)
        complete = function_body("atlas_private.marketing_delivery_complete")
        self.assertIn("atlas_private.marketing_backoff(greatest(d.attempt_count, 1), 60, 3600, v_retry_after)", complete)
        self.assertIn("after the submit marker nothing is retried blindly", complete)
        self.assertIn("v_definitive", complete)
        self.assertIn("polls never consume attempts", complete)

    def test_fingerprint_is_canonical_and_frozen_payload_has_no_urls(self):
        payload = function_body("atlas_private.marketing_content_fingerprint_payload")
        self.assertIn("jsonb_build_object(", payload)
        self.assertNotIn("to_jsonb(c)", payload)
        fingerprint = function_body("atlas_private.marketing_content_fingerprint")
        self.assertIn("pg_catalog.sha256(convert_to(", fingerprint)
        delivery_payload = function_body("atlas_private.marketing_delivery_payload")
        self.assertIn("'storage_path'", delivery_payload)
        self.assertNotIn("signed", delivery_payload.lower())
        self.assertIn("marketing_deliveries_create_for_approval(p_content_id, approval_row.id, null, 100)", MIGRATION)

    def test_material_edits_need_re_approval(self):
        guard = function_body("atlas_private.marketing_content_guard")
        for column in ("caption_draft", "platforms", "scheduled_for", "platform_options", "content_type"):
            self.assertIn(f"new.{column} is distinct from old.{column}", guard)
        self.assertIn("atlas:in_flight", guard)
        self.assertIn("'superseded_by_edit'", guard)
        self.assertIn("new.approval_id := null", guard)
        self.assertIn("marketing_content_media_material", MIGRATION)
        patch = function_body("atlas_private.marketing_update_content_patch")
        self.assertIn("atlas:stale_request", patch)
        self.assertIn("errcode = '40001'", patch)
        self.assertIn("case when v_patch ? 'caption_draft'", patch)

    def test_venue_time_replaces_the_hard_coded_zone(self):
        snapshot = function_body("atlas_private.marketing_workspace_snapshot")
        self.assertIn("atlas_private.venue_date(pg_catalog.now())", snapshot)
        self.assertNotIn("Atlantic/Reykjavik", snapshot)
        self.assertNotIn("scheduled_for::date", snapshot)
        # The literal appears only in the rewrite of the occurrence functions and the final guard.
        outside = re.sub(r"do \$venue_time\$.*?\$venue_time\$;", "", MIGRATION, flags=re.S)
        outside = re.sub(r"do \$venue_guard\$.*?\$venue_guard\$;", "", outside, flags=re.S)
        self.assertNotIn("Atlantic/Reykjavik", outside)
        self.assertIn("'atlas_private.venue_date(pg_catalog.now())'", MIGRATION)

    def test_snapshot_additions(self):
        snapshot = function_body("atlas_private.marketing_workspace_snapshot")
        for key in ("'version',content.version", "'platform_options',content.platform_options", "'media',(",
                    "'thumb_storage_path'", "'deliveries',coalesce((", "'publication_state'",
                    "'publish_targets',targets_json", "'automatic_publishing_enabled',automatic_enabled",
                    "'attention',attention_json"):
            self.assertIn(key, snapshot)

    def test_automatic_publishing_is_an_admin_only_switch(self):
        settings = function_body("atlas_private.settings_save_section")
        self.assertNotIn("jsonb_set(jsonb_set(safe_value,'{automatic_publishing_enabled}','false'::jsonb,true)", settings)
        self.assertIn("case when p_actor_role='admin'", settings)
        self.assertIn("'{analytics_ingestion_enabled}','false'::jsonb,true", settings)
        enabled = function_body("atlas_private.marketing_automatic_publishing_enabled")
        self.assertIn("'true'::jsonb", enabled)
        publish_now = function_body("atlas_private.marketing_publish_now")
        self.assertIn("atlas:automatic_publishing_disabled", publish_now)

    def test_notifications_once_per_delivery(self):
        self.assertIn("check (event_type in ('team_message','shift_update','marketing_attention'))", MIGRATION)
        self.assertIn("check (route in ('team','shifts','marketing'))", MIGRATION)
        notify = function_body("atlas_private.marketing_delivery_notify")
        self.assertIn("if d.attention_notified_at is not null then return 0; end if;", notify)
        self.assertIn("'marketing_attention'", notify)
        for event in ("delivery_published", "delivery_needs_attention", "delivery_failed", "delivery_requeued",
                      "delivery_marked_posted", "delivery_cancelled", "publish_now", "approval_invalidated"):
            self.assertIn(f"'{event}'", MIGRATION)

    def test_tick_is_guarded_and_uses_the_vault_secret(self):
        tick = function_body("atlas_private.marketing_publisher_tick")
        self.assertIn("extname = 'pg_net'", tick)
        self.assertIn("'atlas_marketing_publisher_secret'", tick)
        self.assertIn("'x-atlas-publisher-secret'", tick)
        self.assertIn("return null;", tick)
        self.assertIn("revoke all on function %s from service_role", MIGRATION)

    def test_public_wrappers_are_service_role_only_definers(self):
        for name, args in PUBLIC_RPCS.items():
            pattern = re.compile(r"create or replace function public\." + name + r"\((.*?)\)\s*returns jsonb language sql (?:volatile|stable) security definer set search_path = ''", re.S)
            self.assertRegex(MIGRATION, pattern, name)
            self.assertIn(f"revoke all on function public.{name}({args}) from public, anon, authenticated", MIGRATION)
            self.assertIn(f"grant execute on function public.{name}({args}) to service_role", MIGRATION)
        # Legacy callers keep working: the 20-argument update and every older signature stay.
        self.assertNotIn("drop function if exists public.atlas_marketing_update_content", LOWER)
        self.assertIn("'id', result #> '{content,id}'", MIGRATION)

    def test_role_rechecks_in_sql(self):
        for name in ("marketing_delivery_manager_action", "marketing_publish_now", "marketing_content_cancel",
                     "marketing_content_reschedule", "marketing_content_duplicate", "marketing_publication_history"):
            self.assertIn("atlas_private.marketing_actor(p_actor_id, array['admin','manager'])", function_body(f"atlas_private.{name}"))
        actor = function_body("atlas_private.marketing_actor")
        self.assertIn("profile.active is true", actor)
        self.assertIn("errcode = '42501', hint = 'atlas:forbidden'", actor)

    def test_no_model_names_or_real_endpoints(self):
        for text in (MIGRATION, PREVIEW, CONCURRENCY):
            lowered = text.lower()
            for forbidden in ("claude", "gpt-", "graph.facebook.com", "open.tiktokapis.com", "mybusiness.googleapis.com",
                              "supabase.co"):
                self.assertNotIn(forbidden, lowered)


class S94CVerificationScriptTests(unittest.TestCase):
    def test_preview_is_rollback_only_and_in_the_runner(self):
        self.assertTrue(PREVIEW.rstrip().endswith("rollback;"))
        self.assertIn("'s94c_publishing_preview'", PREVIEW)
        self.assertIn("count(*) = 65", PREVIEW)
        self.assertIn("verify_s94c_publishing_preview.sql", RUNNER)
        for topic in ("state machine", "write-once", "fingerprint", "automatic publishing off", "Publish now",
                      "fencing", "lease recovery", "stale guard", "backoff", "poll claim does not consume",
                      "exactly one marketing push", "history", "snapshot", "venue time", "bartender, viewer",
                      "grants", "definitive"):
            self.assertIn(topic, PREVIEW)

    def test_concurrency_proof_uses_a_throw_away_copy_and_real_sessions(self):
        self.assertIn('case "$PGHOST" in 127.0.0.1|localhost|::1)', CONCURRENCY)
        self.assertIn('createdb -T "$SOURCE_DB" "$SCRATCH_DB"', CONCURRENCY)
        self.assertIn("drop database if exists $SCRATCH_DB with (force)", CONCURRENCY)
        self.assertIn("trap cleanup EXIT", CONCURRENCY)
        self.assertIn("create extension if not exists dblink", CONCURRENCY)
        self.assertIn("dblink_send_query", CONCURRENCY)
        self.assertIn("set lock_timeout = ''2s''", CONCURRENCY)
        self.assertIn("pgbench -n -c 8", CONCURRENCY)
        self.assertIn('"s94c_claim_concurrency"', CONCURRENCY)
        self.assertIn("sys.exit(0 if passed else 1)", CONCURRENCY)


if __name__ == "__main__":
    unittest.main()
