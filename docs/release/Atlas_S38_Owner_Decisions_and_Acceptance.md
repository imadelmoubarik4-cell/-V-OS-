# Atlas S38 owner decisions and acceptance record

Source of truth: the owner's 15-page PDF review, supplied screenshots, and the follow-up decisions recorded on 12 September 2026.

## Release boundary

- Implement and publish only to the existing owner-private isolated-staging preview.
- Keep all 18 runtime endpoints on the isolated Supabase staging project.
- Do not change production endpoints, production data, production schema, production functions, or production deployment.
- Preserve current role permissions, authentication, server-backed mutations, and recovery behavior.
- A code change or automated test is not acceptance. Every affected screen must be visibly verified in the hosted private preview before it is called fixed.

## Confirmed design system

- Use one unified, minimal Apple-inspired Atlas design across every affected screen.
- Use white and very light-blue surfaces, Atlas blue for non-destructive primary actions, rounded floating cards, subtle borders and shadows, consistent spacing, and restrained hover lift.
- Remove black primary buttons and gray/beige legacy surfaces. Destructive actions remain clearly red.
- Apply the same component language to desktop and mobile without clipping or unintended horizontal scrolling.
- Keep current functionality unless the PDF or a confirmed owner decision explicitly changes it.

## Page-by-page decisions and acceptance criteria

### 1. Home

- Repair the layout and use the official Atlas robot/mark treatment.
- Daily attention banners pulse only when they contain something requiring attention. They do not blink continuously.
- Routine Priorities is compact and collapsed by default, and opens when clicked.
- Today's Timeline belongs on Home, not inside Atlas Brain.
- Floating cards use the shared subtle hover treatment.

Acceptance: the first viewport is balanced; the robot/mark is crisp and not duplicated; routine content does not waste space; attention motion is conditional and respects reduced-motion preferences.

### 2. Operations Center

- Replace the strong/detached blue glow on scheduled routine cards with a small, subtle Atlas-blue status indicator.
- Replace black non-destructive buttons with Atlas-blue buttons.
- Apply the shared card, spacing, and hover treatment.

Acceptance: routine states remain clear without glow; every primary action is readable and consistent.

### 2. Inventory categories

- Wine has exactly four subcategories: Red, White, Rosé, and Sparkling.
- Do not add Champagne, Orange, Dessert/Fortified, or Alcohol-Free categories.

Acceptance: selecting Wine displays only the four approved subcategories and their correct counts.

### 3. Bottle Scanner / Add Item

- Redesign the entire scanner in the unified Atlas style and remove the black scanner styling.
- Make every scanner control functional.
- The scanner finds and suggests a matching product; the user reviews, edits if needed, and confirms. Nothing is saved automatically.
- Quantity supports minus, plus, and direct numeric entry and never drops below zero.
- X closes immediately when nothing has changed. If entered or scanned information would be lost, show a confirmation before closing.
- Closing stops camera tracks and leaves no active capture state.

Acceptance: recognized data is a suggestion, not an automatic decision; displayed quantity is the submitted quantity; close, backdrop, cancel, and save paths all work on desktop and mobile.

### 4. Current Stock Count

- Redesign the overlay and stock cards in the light Atlas style.
- Stock categories are collapsed by default and expand when clicked.
- X closes immediately when unchanged and warns before discarding unsaved count changes.
- Quantity and count actions remain fully functional.

Acceptance: there are no dark-blue legacy cards, clipped controls, or accidental data loss.

### 5. Purchase Order Form and Import Queue

- Make the purchase-order form compact, aligned, and fully functional.
- Supplier selection, item selection, quantity, price, line removal, note, order submission, and receiving actions work inside the workspace.
- Keep Import Queue functionality and redesign it with the shared Atlas cards, spacing, buttons, and hover states.

Acceptance: users can complete the purchasing flow without leaving the workspace; queue controls are visible and usable at supported widths.

### 6. Recipe Library

- Redesign the Recipe Library and recipe details in the shared Atlas system.
- Replace the oversized search bar with a compact Apple-style search pill.
- Keep recipe categories visible as compact filter chips.
- Open recipe details in a rounded floating Atlas card, with a clear close control, instead of wasting permanent page space.

Acceptance: search remains keyboard accessible; chips wrap cleanly; the floating recipe card fits the viewport and scrolls internally when needed.

### 7. New Recipe and Purchasing layout

- Replace black buttons with Atlas blue and align/compact all fields.
- Inventory Connection, Featured Recommendation, and Public Menu are collapsed by default and open when clicked.
- Each collapsed section shows a small status summary.
- Remove or minimize nonessential features that take space without performing a useful action.

Acceptance: the main recipe-writing flow stays prominent and supporting settings reveal on demand.

### 8. Purchasing tabs

- Suppliers, Orders, and Deliveries are three real tabs. Selecting one replaces the visible workspace; a selected tab must never leave the supplier table underneath it.
- Orders uses these states: Draft, Submitted, Confirmed, Partially Received, Received, and Cancelled.
- Deliveries groups records as Expected, Overdue, Partially Received, and Received.
- Sidebar Orders and Deliveries links open the same working tab views.

Acceptance: all three tabs and sidebar links work, update selected state correctly, display their own content, and refresh their data.

### 8-9. Team Messages

- Keep the channel/header and message composer fixed.
- Only the conversation history scrolls, using a clearly visible internal scrollbar.
- The composer is always fully visible and is never overlapped by a floating action button.
- Apply the same structure to every chat.
- A pin belongs to an individual conversation, not the whole chat or channel header. Do not use the word “Starred.”
- Provide a Pinned action/filter for finding individually pinned conversations.
- Preserve the server-backed pin/unpin state across refresh.
- Match chat icons and colours to the left navigation system.

Acceptance: long conversations scroll internally on desktop and mobile; the page itself does not need to scroll merely to reach the composer; conversation pinning is unambiguous and persistent.

### 9. Notifications and Team Profiles

- Support notifications for new direct messages, mentions, shift changes, assigned tasks, purchase-order or delivery updates, and low-stock alerts.
- Do not expose separate user toggles for every notification type.
- Settings contains one master Notifications On/Off control.
- Redesign Team Profiles with compact Atlas cards and consistent spacing while preserving profile functionality.

Acceptance: the notification bell routes to the real notification controls; supported browser/mobile permission flow works; notification delivery remains disabled in isolated staging unless explicitly enabled for a test.

### 10. Shifts

- Keep the current full-month calendar structure and functionality, but redesign it completely in the unified Atlas style.
- Weeks begin on Monday.
- Use the approved floating Atlas month-control toolbar: Today, previous month, month/year, next month, and Month selector.
- Each shift card shows only the employee name and start-end time; do not show the role.
- Each employee has one consistent soft colour across all of their shifts.
- Clicking a shift opens a rounded floating Atlas view/edit card, not a side panel.
- Clicking an empty date opens the create-shift flow for that date in the same floating-card language.
- Remove gray/beige surfaces and horizontal clipping.

Acceptance: the full month is readable at supported desktop widths; mobile uses a usable responsive presentation; existing create/edit/delete and navigation behavior still works.

### 11. Availability and Knowledge

- Redesign Availability in the unified Atlas system without changing its existing weekly availability workflow.
- Keep existing day-level editing behavior.
- Knowledge category controls wrap onto additional lines; they never clip or require horizontal scrolling.
- Knowledge navigation sections are compact and collapsed by default, and expand when clicked.
- Selecting a Knowledge category shows its articles in the main workspace while navigation remains available.

Acceptance: Availability contains no gray legacy cards; Knowledge navigation and article content both fit in the first useful workspace without oversized empty regions.

### 12. New Knowledge Article

- Replace black actions with Atlas-blue actions and make the editor cleaner and more compact.
- Keep the main writing area large and visible.
- Supporting properties such as category, visibility, tags, and attachments use compact, expandable controls so they do not dominate the page.

Acceptance: writing is the primary task; supporting properties remain available without creating excessive page length.

### 13-14. Atlas Brain

- Replace the disorganized layout with a polished, scan-friendly Atlas structure.
- Keep Ask Atlas open and visible near the top.
- Present compact overview status for Brain health, items needing review, recommendations, and data coverage.
- Sort items requiring attention by urgency, most urgent first.
- Present review items and recommended actions with clear actions and calm visual hierarchy.
- Keep Evidence and Sources available below the decision surfaces.
- Recommendations, Stock Intelligence, Featured Recipe, and Data Coverage stay collapsed until clicked.
- Today's Timeline is removed from Atlas Brain and shown on Home.

Acceptance: the most important decision is visible first; Ask Atlas is not buried; secondary intelligence does not create a long cluttered page; the result follows the approved visual mockup direction.

### 15. Settings

- Preserve current Settings categories and functionality.
- Reorganize them into compact Atlas cards with clean toggles and smaller tab controls.
- Keep advanced and rarely used settings collapsed until clicked.
- Include one master Notifications On/Off control.

Acceptance: Settings matches the rest of Atlas, has no black primary buttons, and remains responsive.

### Sign-in page

- Replace the existing dark green/gold screen with a minimal Atlas sign-in experience.
- Use the Atlas logo, a short “Welcome back” heading, email and password fields, an Atlas-blue Sign in button, and Forgot password.
- Remove “VÁ BAR · STAFF ONLY,” the oversized decorative A, black/dark surfaces, gold accents, and unnecessary text.
- Preserve the existing Supabase authentication and recovery behavior.

Acceptance: sign-in is minimal, readable, responsive, and visually consistent with the authenticated Atlas application; no credential or session behavior changes.

## Final acceptance gate

The private preview is ready for owner approval only when all of the following are true:

1. Every item above is implemented in the exact hosted bundle.
2. Desktop and mobile screenshots visibly match the requirements.
3. All named controls are interacted with in the hosted/private test surface.
4. Existing role, Auth, Storage, recovery, and isolated-staging safeguards still pass.
5. No production endpoint, project reference, data, function, or deployment is changed.
6. The owner reviews and explicitly approves the private preview before any next stage.

## Final owner touch-ups

- The Bottle Scanner contains no black action or footer bar; its complete surface uses the shared light Atlas-blue design.
- The Shifts Month tab is permanently present and opens the full-month workspace without relying on a delayed injected control.
- Today's Timeline is visible on Home only and is hidden from every other Atlas workspace.
- The functional Shifts Month calendar is fully reskinned as an Atlas workspace: light-blue floating calendar surface, rounded day cards, Atlas-blue controls and selection states, readable Add shift actions, and consistent soft employee colours. The legacy beige table, brown selection border, and overlapping global quick-action button are removed.
- Month day cards use a tight four-pixel gutter. Every per-day plus control is a centered compact light-blue Atlas button with a clear blue hover state.
