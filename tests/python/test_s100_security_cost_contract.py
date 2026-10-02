"""S100 security & cost hardening — static contract over the migration, the edge
wiring, the security gate and the acceptance harness. Proves the shape of the new
controls without a database (the behavioural proof is
scripts/verify_s100_security_cost.sh, run in migration-replay CI).
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIG = (ROOT / "supabase/migrations/20261017090000_s100_security_cost_hardening.sql").read_text()
HTTP = (ROOT / "supabase/functions/atlas-ai/http.mjs").read_text()
CHAT = (ROOT / "supabase/functions/atlas-ai/chat.mjs").read_text()
GATE = (ROOT / "scripts/verify_phase1_security_gate.sql").read_text()
TEST_SQL = (ROOT / "tests/sql/s100_security_cost_hardening.sql").read_text()
REPLAY = (ROOT / ".github/workflows/migration-replay.yml").read_text()


class S100MigrationContractTests(unittest.TestCase):
    def test_budget_and_throttle_tunables_are_added_nullable_safe(self):
        self.assertIn("alter table atlas_private.ai_settings", MIG)
        for col in ("chat_requests_per_minute", "chat_burst_limit",
                    "daily_budget_usd", "monthly_budget_usd"):
            self.assertIn(col, MIG)
        # budgets are nullable so the owner is never locked out (NULL = no cap)
        self.assertIn("daily_budget_usd is null or daily_budget_usd >= 0", MIG)
        self.assertIn("monthly_budget_usd is null or monthly_budget_usd >= 0", MIG)

    def test_pilot_cost_defaults_not_the_high_first_draft_values(self):
        # the pilot ships a $5 daily backstop + $30 monthly hard cap, never 50/500
        self.assertIn("daily_budget_usd numeric(12,2) default 5", MIG)
        self.assertIn("monthly_budget_usd numeric(12,2) default 30", MIG)
        self.assertNotIn("default 50", MIG)
        self.assertNotIn("default 500", MIG)
        # run_start's defensive fallback matches the pilot turn cap, not 200
        self.assertIn("coalesce(v_settings.daily_turn_limit_per_user, 40)", MIG)

    def test_pilot_baseline_update_is_guarded_against_owner_customizations(self):
        # each pilot value is applied only where the column still equals its ship
        # default (CASE ... else <column> end), so owner-tuned caps are preserved.
        for pair in (
            ("daily_turn_limit_per_user = 200 then 40"),
            ("voice_sessions_per_day = 20 then 5"),
            ("voice_minutes_per_day = 60 then 15"),
            ("upload_files_per_day = 100 then 20"),
            ("upload_bytes_per_day = 262144000 then 52428800"),
            ("recognition_identifications_per_hour = 60 then 20"),
            ("recognition_vision_per_day = 150 then 30"),
            ("recognition_vision_budget_usd_per_day = 5 then 1"),
            ("media_retention_days = 30 then 14"),
            ("daily_budget_usd = 50 then 5"),
            ("monthly_budget_usd = 500 then 30"),
        ):
            self.assertIn(pair, MIG)
        self.assertIn("else daily_turn_limit_per_user end", MIG)

    def test_text_chat_throttle_reuses_the_durable_limiter(self):
        # race-safe sliding window, not a per-isolate counter
        self.assertIn("atlas_private.ai_rate_take(p_actor_id, 'chat_request'", MIG)
        self.assertIn("atlas_private.ai_rate_take(p_actor_id, 'chat_burst'", MIG)
        self.assertIn("interval '1 minute'", MIG)
        self.assertIn("interval '10 seconds'", MIG)
        self.assertIn("rate_limited: too many AI requests, slow down", MIG)
        # throttle only applies to the text-chat path
        self.assertIn("if v_channel = 'text' then", MIG)
        # the shared limiter's bucket CHECK must allow the new chat buckets (else every
        # text turn would fail the constraint instead of being throttled).
        self.assertIn("drop constraint if exists ai_rate_events_bucket_check", MIG)
        self.assertIn("'chat_request','chat_burst'", MIG)
        self.assertIn("'voice_mint','voice_tool','voice_append','chat_request','chat_burst'", MIG)

    def test_usd_budget_reads_back_recorded_cost_and_blocks(self):
        self.assertIn("sum(r.est_cost_usd)", MIG)
        self.assertIn("rate_limited: daily AI budget reached", MIG)
        self.assertIn("rate_limited: monthly AI budget reached", MIG)
        self.assertIn("date_trunc('month', pg_catalog.now())", MIG)

    def test_run_start_still_revalidates_actor_and_keeps_existing_guards(self):
        # the added checks never drop S88's actor re-check, kill-switch or turn cap
        self.assertIn("atlas_private.ai_require_actor(p_actor_id, p_actor_role)", MIG)
        self.assertIn("not_configured: Atlas AI is disabled", MIG)
        self.assertIn("rate_limited: daily Atlas AI limit reached", MIG)
        self.assertIn("atlas_private.ai_lock_user(p_actor_id, 'turns')", MIG)
        self.assertIn("security invoker", MIG)
        self.assertIn("set search_path = ''", MIG)

    def test_new_rpcs_are_service_role_only(self):
        for fn in ("public.atlas_ai_run_start(uuid,text,uuid,text,jsonb)",
                   "public.atlas_ai_record_block(uuid,text,text,text,jsonb)",
                   "public.atlas_ai_usage_summary(uuid,text)",
                   "public.atlas_ai_limits_set(uuid,text,jsonb)"):
            self.assertIn(f"revoke execute on function {fn} from public, anon, authenticated", MIG)
            self.assertIn(f"grant execute on function {fn} to service_role", MIG)

    def test_usage_summary_and_limits_set_are_manager_gated(self):
        self.assertEqual(MIG.count("forbidden: manager access required"), 2)
        self.assertIn("p_actor_role not in ('admin','manager')", MIG)

    def test_block_event_trail_is_sealed_and_append_only(self):
        self.assertIn("create table if not exists atlas_private.ai_block_events", MIG)
        self.assertIn("revoke all on atlas_private.ai_block_events from public, anon, authenticated", MIG)
        self.assertIn("grant select, insert on atlas_private.ai_block_events to service_role", MIG)
        self.assertIn("revoke update, delete, truncate on atlas_private.ai_block_events from service_role, authenticated, anon", MIG)
        self.assertIn("enable row level security", MIG)
        self.assertIn("private.audit_append_only('user_id')", MIG)

    def test_recipe_price_audit_is_a_sealed_append_only_definer_trigger(self):
        self.assertIn("create table if not exists atlas_private.recipe_price_events", MIG)
        self.assertIn("revoke all on atlas_private.recipe_price_events from public, anon, authenticated", MIG)
        self.assertIn("revoke update, delete, truncate on atlas_private.recipe_price_events from service_role, authenticated, anon", MIG)
        # the audit runs SECURITY DEFINER so no frontend PostgREST write can skip it
        self.assertIn("create or replace function private.recipe_commercial_audit()", MIG)
        self.assertIn("security definer", MIG)
        self.assertIn("after update on public.recipes", MIG)
        self.assertIn("recipes_s100_commercial_audit", MIG)
        for field in ("menu_price", "happy_hour_price", "glass_price",
                      "bottle_price", "active", "show_on_menu"):
            self.assertIn(field, MIG)
        self.assertIn("is distinct from", MIG)

    def test_migration_reloads_schema_and_bounds_locks(self):
        self.assertIn("set lock_timeout = '5s'", MIG)
        self.assertIn("set statement_timeout = '2min'", MIG)
        self.assertTrue(MIG.rstrip().endswith("notify pgrst, 'reload schema';"))

    def test_migration_does_not_touch_mfa_bookings_or_s96(self):
        low = MIG.lower()
        # strip comment lines so the scope-note ("does not activate bookings/mfa") is
        # not mistaken for an actual reference.
        sql = "\n".join(l for l in low.splitlines() if not l.strip().startswith("--"))
        # scope guard: no MFA enforcement, no bookings activation in actual SQL
        self.assertNotIn("require_all_staff_mfa", sql)
        self.assertNotIn("require_privileged_mfa", sql)
        self.assertNotIn("booking", sql)
        # S96 non-weakening: every `drop trigger` in this migration is immediately
        # re-created in the same migration (it only replaces its own triggers; it
        # never leaves an existing S96 guard dropped).
        import re
        for name in re.findall(r"drop trigger if exists (\S+) on \S+", low):
            self.assertIn(f"create trigger {name}", low)


class S100EdgeWiringContractTests(unittest.TestCase):
    def test_rate_limited_is_classified_into_vetted_reasons(self):
        self.assertIn("rateLimitReason", HTTP)
        for reason in ("slow_down", "budget_daily", "budget_monthly", "turn_limit"):
            self.assertIn(reason, HTTP)
        self.assertIn('reason: rateLimitReason(message)', HTTP)

    def test_retry_after_header_on_rate_limited_responses(self):
        self.assertIn("retryAfterFor", HTTP)
        self.assertIn('"retry-after"', HTTP)
        self.assertIn('error.code !== "rate_limited"', HTTP)

    def test_start_run_records_a_block_out_of_band_on_429(self):
        self.assertIn("atlas_ai_record_block", CHAT)
        self.assertIn("error.status === 429", CHAT)
        self.assertIn("BLOCK_KIND_BY_REASON", CHAT)
        # best-effort via safeRpc so the 429 still surfaces to the browser
        self.assertIn("safeRpc(services, \"atlas_ai_record_block\"", CHAT)
        self.assertIn("throw error", CHAT)

    def test_password_is_never_proxied_through_the_edge(self):
        low = CHAT.lower() + HTTP.lower()
        self.assertNotIn("password", low)


class S100GateAndHarnessContractTests(unittest.TestCase):
    def test_gate_has_actor_param_tripwire_and_recipe_assertions(self):
        self.assertIn("actor_param_exposure", GATE)
        self.assertIn("p_actor_(id|role)", GATE)
        self.assertIn("recipe_write_boundary", GATE)
        self.assertIn("writes_manager_only", GATE)
        self.assertIn("recipe_price_audit", GATE)
        self.assertIn("recipes_s100_commercial_audit", GATE)
        for blocker in (
            "actor-spoofing exposure",
            "recipe writes are not strictly manager-only under RLS",
            "recipe price/flag audit trail is installed but not sealed",
        ):
            self.assertIn(blocker, GATE)

    def test_acceptance_test_is_wired_into_replay_ci(self):
        self.assertIn("scripts/verify_s100_security_cost.sh", REPLAY)
        self.assertIn("all authorization and integrity checks passed", TEST_SQL)
        # the harness also asserts the security gate reports no blockers
        self.assertIn("security_lint_blockers", (ROOT / "scripts/verify_s100_security_cost.sh").read_text())


if __name__ == "__main__":
    unittest.main()
