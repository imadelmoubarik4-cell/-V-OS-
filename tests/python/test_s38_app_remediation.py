from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "apps/web/index.html"
# S88: the S38 rules were split into per-module fragments
# (apps/web/assets/css/legacy/s38-app-remediation--<module>.css), then taken
# over by their modules and the design system; the legacy directory is gone.
LEGACY_CSS = ROOT / "apps/web/assets/css/legacy"
CSS_FRAGMENTS = sorted(LEGACY_CSS.glob("s38-app-remediation--*.css")) if LEGACY_CSS.exists() else []
JS = ROOT / "apps/web/assets/js/s38-app-remediation.js"
# S88: each S38 fix lives in the module that renders the markup.
# S88 Team B: the scanner became the shared capture module, and Inventory and
# Purchasing are rebuilt modules (atlas-inventory.js, atlas-purchasing.js).
CAPTURE = ROOT / "apps/web/assets/js/atlas-capture.js"
INVENTORY = ROOT / "apps/web/assets/js/atlas-inventory.js"
# S88 Team A: Home (home.js) owns the attention rows the retired Checkpoint A layout drew.
HOME = ROOT / "apps/web/assets/js/home.js"
PURCHASING = ROOT / "apps/web/assets/js/atlas-purchasing.js"
MESSAGES = ROOT / "apps/web/assets/js/team-messages.js"
SHIFTS = ROOT / "apps/web/assets/js/shifts-workspace.js"
CHECKLIST = ROOT / "docs/release/Atlas_S38_PDF_App_Remediation_Checklist.md"
DECISIONS = ROOT / "docs/release/Atlas_S38_Owner_Decisions_and_Acceptance.md"


class S38AppRemediationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = INDEX.read_text(encoding="utf-8")
        cls.css = "\n".join(path.read_text(encoding="utf-8") for path in CSS_FRAGMENTS)
        cls.javascript = JS.read_text(encoding="utf-8")
        cls.checklist = CHECKLIST.read_text(encoding="utf-8")
        cls.decisions = DECISIONS.read_text(encoding="utf-8")
        cls.owners = {path.name: path.read_text(encoding="utf-8") for path in (CAPTURE, INVENTORY, HOME, PURCHASING, MESSAGES, SHIFTS)}

    def test_remediation_script_no_longer_patches_the_page(self):
        # The fixes moved to their owners; the script keeps only its marker.
        for pattern in ("new MutationObserver", "addEventListener(", "stopImmediatePropagation", "atlas:view-change"):
            self.assertNotIn(pattern, self.javascript)
        self.assertIn("window.AtlasS38Remediation", self.javascript)
        self.assertIn("s38-owner-remediation-v9", self.javascript)

    def test_remediation_assets_load_last(self):
        js_reference = "assets/js/s38-app-remediation.js"
        # S88 design-system consolidation: no S38 stylesheet fragment remains.
        self.assertEqual(CSS_FRAGMENTS, [])
        self.assertFalse(LEGACY_CSS.exists())
        self.assertNotIn("s38-app-remediation--", self.index)
        self.assertEqual(self.index.count(js_reference), 1)
        self.assertLess(self.index.index("assets/js/atlas-purchasing.js"), self.index.index(js_reference))
        self.assertIn(js_reference + "?v=20260926-s88", self.index)
        self.assertLess(self.index.index(js_reference), self.index.index("</body>"))

    def test_shared_visual_contract(self):
        # S88: the S38 blue is an alias of the single Atlas blue (--accent; Brand v1.0 #2563eb).
        tokens = (ROOT / "apps/web/assets/css/atlas-tokens.css").read_text(encoding="utf-8")
        self.assertIn("--s38-blue: var(--accent);", tokens)
        self.assertIn("--accent: #2563eb;", tokens)
        self.assertNotIn("--s38-blue: #4f7df3", self.css)
        # The S38 card, pulse and reduced-motion rules are retired: cards are the
        # .atlas-card component and reduced motion is atlas-base.css.
        self.assertIn("@media (prefers-reduced-motion: reduce)", (ROOT / "apps/web/assets/css/atlas-base.css").read_text(encoding="utf-8"))
        self.assertNotIn("s38-attention-pulse", self.index)
        self.assertNotIn("background: #000", self.css)
        self.assertNotIn("background:#000", self.css)
        # S88: Messages and Shifts were rebuilt as atlas.modules sheets; their
        # S38 fragments are deleted, not merged.
        for retired in (".team-message-list", ".shift-month-cell"):
            self.assertNotIn(retired, self.css)

    def test_home_attention_and_removed_brain_card_follow_owner_contract(self):
        # S88 Team A: Home lists what needs attention as rows from every module
        # (AtlasShell.home.contribute); the Brain page and its card are retired.
        home = self.owners["home.js"]
        self.assertIn("shell()?.home?.rows?.({ role: role() })", home)
        self.assertIn("Nothing needs you right now", home)
        self.assertNotIn("s38-attention-pulse", home)
        self.assertNotIn('id="home-focus"', self.index)
        self.assertNotIn("installHomeMark", self.javascript)
        self.assertNotIn("getElementById('home-focus').style.display", self.index)
        self.assertFalse((ROOT / "apps/web/assets/js/brain.js").exists())

    def test_scanner_controls_are_wired(self):
        # The capture overlay owns its close and manual-entry controls; the
        # count stepper lives in the stock-count flow and never goes below zero.
        capture = self.owners["atlas-capture.js"]
        for contract in ("data-capture-close", "data-capture-manual", 'inputmode="numeric"', "setTabBarHidden?.('capture', true)"):
            self.assertIn(contract, capture)
        stock = (ROOT / "apps/web/assets/js/stock-count-workspace.js").read_text(encoding="utf-8")
        self.assertIn("Math.max(0, current + Number(button.dataset.step))", stock)
        self.assertIn('inputmode="decimal"', stock)
        inventory_css = (ROOT / "apps/web/assets/css/inventory.css").read_text(encoding="utf-8")
        self.assertIn(".atlas-capture", inventory_css)

    def test_purchasing_and_message_controls_are_wired(self):
        purchasing = self.owners["atlas-purchasing.js"]
        # Purchasing sections are routes (#purchasing/orders, /deliveries, /suppliers).
        self.assertIn("['orders', 'Orders', '#purchasing/orders'], ['deliveries', 'Deliveries', '#purchasing/deliveries']", purchasing)
        messages = self.owners["team-messages.js"]
        self.assertIn('data-team-message-list role="log" aria-live="polite" aria-relevant="additions text"', messages)
        self.assertNotIn("Push notifications off", messages)
        # S88 redesign: no trust footer or FAB workaround; phones hide the tab
        # bar inside a conversation instead (spec §7.3, §8.5).
        self.assertIn("chrome?.setTabBarHidden?.('messages', inThread)", messages)
        self.assertNotIn("s38-team-active", messages)
        # S88 redesign: the bell opens the notifications panel (spec §4.9), which
        # lists unread messages and links to #settings/notifications.
        chrome = (ROOT / "apps/web/assets/js/atlas-chrome.js").read_text(encoding="utf-8")
        self.assertIn("shell.notify.setPanel(notifyPanel)", chrome)
        self.assertIn("navigate('#settings/notifications', action)", chrome)
        # S88 Team A: one notification item per conversation with unread messages.
        self.assertNotIn("shell.notify.contribute('messages-unread'", chrome)
        self.assertIn("notify.contribute('messages', messageItems)", self.owners["home.js"])

    def test_existing_server_backed_features_remain_present(self):
        purchase_orders = self.owners["atlas-purchasing.js"]
        inventory = self.owners["atlas-inventory.js"]
        team_messages = (ROOT / "apps/web/assets/js/team-messages.js").read_text(encoding="utf-8")
        notifications = (ROOT / "apps/web/assets/js/notifications.js").read_text(encoding="utf-8")
        self.assertIn("function inventorySubcategory", inventory)
        self.assertIn("group === 'wine'", inventory)
        self.assertIn("atlas_purchase_order_command_v2", purchase_orders)
        self.assertIn("data-team-star", team_messages)
        self.assertIn("subscribe", notifications)

    def test_checklist_covers_all_pdf_pages_and_production_boundary(self):
        mapped = ((1, 15), (4, 5), (8, 9), (11, 12), (13, 14))
        for page in range(1, 16):
            direct = f"| {page} |" in self.checklist
            ranged = any(
                f"| {start}–{end} |" in self.checklist and start <= page <= end
                for start, end in mapped
            )
            self.assertTrue(direct or ranged, f"PDF page {page} is not mapped")
        self.assertIn("Production remains outside the S38 run.", self.checklist)
        self.assertNotIn("supabase.co", self.javascript)
        self.assertNotIn("supabase.co", self.css)

    def test_owner_corrections_are_the_authoritative_contract(self):
        for requirement in (
            "exactly four subcategories: Red, White, Rosé, and Sparkling",
            "Do not use the word “Starred.”",
            "Today's Timeline belongs on Home",
            "Each employee has one consistent soft colour",
            "one master Notifications On/Off control",
            "Welcome back",
        ):
            self.assertIn(requirement, self.decisions)
        self.assertIn("Superseded by `Atlas_S38_Owner_Decisions_and_Acceptance.md`", self.checklist)

    def test_visible_owner_requirements_are_implemented(self):
        inventory = self.owners["atlas-inventory.js"]
        stock = (ROOT / "apps/web/assets/js/stock-count-workspace.js").read_text(encoding="utf-8")
        purchasing = self.owners["atlas-purchasing.js"]
        messages = (ROOT / "apps/web/assets/js/team-messages.js").read_text(encoding="utf-8")
        shifts = (ROOT / "apps/web/assets/js/shifts-workspace.js").read_text(encoding="utf-8")
        recipes = (ROOT / "apps/web/assets/js/recipes.js").read_text(encoding="utf-8")
        knowledge = (ROOT / "apps/web/assets/js/knowledge-workspace.js").read_text(encoding="utf-8")
        home = self.owners["home.js"]
        settings = (ROOT / "apps/web/assets/js/settings-workspace.js").read_text(encoding="utf-8")

        self.assertNotIn("VÁ Bar · Staff only", self.index)
        self.assertIn("Welcome back", self.index)
        # Wine offers exactly four types (owner decision), from atlas-inventory.js.
        self.assertIn("const WINE_TYPES = ['Red', 'White', 'Rosé', 'Sparkling'];", inventory)
        self.assertIn("return 'Sparkling'", inventory)
        self.assertNotIn("return 'Champagne'", inventory)
        # Leaving a count keeps the work: it pauses, it is not discarded.
        self.assertIn("function leave()", stock)
        self.assertIn("'Suppliers'", purchasing)
        self.assertIn("Partly received", purchasing)
        self.assertIn('<p class="msg-side__group">Pinned</p>', messages)
        self.assertNotIn("Conversation starred", messages)
        # One consistent colour per person (avatar tint from the person id).
        self.assertIn("function avatarTint(key)", shifts)
        self.assertIn("avatarTint(person?.id || name)", shifts)
        self.assertIn("data-shifts-add", shifts)
        self.assertIn("function openShiftEditor({ date, shift = null } = {})", shifts)
        self.assertIn("addShift: (date) => openShiftEditor({ date })", shifts)
        self.assertIn('data-shifts-mode="month"', shifts)
        # S88 Recipes (spec §7.7): tiles with availability replace the foundation cards.
        self.assertIn("class=\"recipe-tile\"", recipes)
        self.assertNotIn("recipe-foundation-card", recipes)
        self.assertIn("data-knowledge-editor-form", knowledge)
        # Today's timeline belongs on Home (owner decision); it renders inside home.js.
        self.assertIn("Opening and closing", home)
        # One master On/Off control for notifications on this device.
        self.assertIn("Turn notifications on", settings)
        self.assertIn("Turn notifications off", settings)
        # The message history owns its scrolling (now the Messages module sheet).
        messages_css = (ROOT / "apps/web/assets/css/team-messages.css").read_text(encoding="utf-8")
        self.assertIn(".msg-thread__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto;", messages_css)

    def test_month_view_is_part_of_shifts_on_the_design_system(self):
        css = (ROOT / "apps/web/assets/css/shifts-workspace.css").read_text(encoding="utf-8")
        for contract in (
            "@layer atlas.modules {",
            ".shifts-month__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }",
            ".shifts-month__chip.is-unpublished { border-style: dashed;",
        ):
            self.assertIn(contract, css)
        self.assertNotIn("!important", css)
        self.assertFalse((ROOT / "apps/web/assets/css/shifts-month-editor.css").exists())
        self.assertFalse((ROOT / "apps/web/assets/js/shifts-month-calendar.js").exists())
        shifts = self.owners["shifts-workspace.js"]
        self.assertIn("function monthScheduleMarkup()", shifts)
        self.assertNotIn("s38-month-active", shifts)
        # S88 redesign: the floating action is retired (spec §4.12); nothing to hide.
        self.assertNotIn(".fab-wrap", self.css)


if __name__ == "__main__":
    unittest.main()
