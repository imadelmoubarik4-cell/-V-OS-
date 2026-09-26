# S94 UX spec: Marketing publishing (Media, composer, approval, calendar, publishing, History, Integrations)

Author: UX agent (read-only). Base: worktree `s94` @ `5120a42`.
Screenshots of the current UI (harness, admin, fixtures from `teamc-fixtures.mjs`): `scratchpad/s94/ux/`
(`desktop-*` 1440 × 900, `phone-*` 390 × 844: marketing overview/calendar/posts/campaigns/history,
editor new + approve, settings integrations). Script: `scratchpad/s94/ux/shots.mjs`.

Scope rule: everything below reuses `atlas-components.css` / `atlas-base.css` / `modal.js` /
`AtlasShell` helpers. New CSS is only module layout in `marketing-workspace.css` (`mk-*`) and
`settings-workspace.css` (`settings-*`). Anything that looks like a new shared component is listed in
§15 as a request to the design-system owner, not built in the module.

---

## 0. What exists today (studied)

| Area | Today | File |
| --- | --- | --- |
| Tabs | Overview · Calendar · Posts (count = waiting approvals) · Campaigns · History | `marketing-workspace.js` `TABS` |
| Header | "Marketing", sub "2 planned · 1 waiting for approval", Ask Atlas (ghost), **New post draft** (primary), caption "Publishing is manual until a social account is connected. Connections in Settings" | `render()` |
| Editor | `atlas-sheet--wide` (640) side sheet / bottom sheet on phone. Title, Type (Post/Story/Reel/Campaign task/Event promotion/Idea/Google post), Campaign, **Channels** as `atlas-check-row` checkboxes, Text, "Photos or video needed" text field ("Atlas doesn't store post media yet."), Post on (venue time) `datetime-local`, Remind me, one generic Preview card, approval note, approval history | `openEditor()` |
| Footer | Draft: Cancel · Save draft · **Submit for approval**. Approver on pending: Reject (ghost, start) · Request changes · **Approve**. Approved/scheduled: **Mark as published** | `openEditor()` |
| Calendar | Month grid (Mon first), 3 title chips per day + "N more", day number opens new draft on that day; phone (<768) swaps to a flat `atlas-list` of the month | `calendarMarkup()`, CSS |
| History | "Published and done" list + "Activity" event list | `historyMarkup()` |
| Integrations | Settings › Integrations cards: pill + status line + facts + Connect/Reconnect/Test connection/Disconnect; states `not_configured, ready, verifying, connected, verification_failed, needs_reauthorization, pending_review` | `settings-workspace.js` `INTEGRATION_STATES`, `providerMarkup()` |
| Reorder precedent | Recipe ingredients: `atlas-icon-btn--sm` arrow-up / arrow-down / trash-2 with `aria-label="Move X up"`, first/last disabled | `recipes.js:1115` |
| Upload precedent | `.atlas-upload` (dashed, 44 thumb, `__body/__title/__help/__error`, `.is-dragover`), `.atlas-progress` (`--thin`) | `atlas-components.css` 6.27 / 6.26 |

---

## 1. Operator workflow map

```
Marketing ─┬─ Media ── Upload (queue) ── Asset detail (alt text, focal point, crops, cover, trim)
           │           └─ Collections ── Collection builder (reorder)
           ├─ New post ── Channels ── Add media (Upload new / Library / Collection)
           │             ── Common caption ── Per-channel options (override disclosure)
           │             ── Previews ── Checks (validation)
           │             ── When: Schedule (Reykjavík time) / Publish now / No time yet
           │             ── Submit for approval ──► Approver: Approve · Request changes · Reject
           │                                          └─ Approved + time → Scheduled
           ├─ Calendar (month grid, thumbnails, channel status dots; phone agenda)
           ├─ [time arrives] Automatic publishing per channel (connected + permission)
           │                  or reminder to post by hand (not connected)
           └─ History ── per-post, per-channel status ── Retry this channel only / Mark posted by hand
Settings › Integrations ── connection state ── publishing permission ── choose Page / account / location
Notifications ── approval requested, changes requested, approved, published, failed, reconnect needed, post by hand
```

Roles: Marketing stays manager and admin only (current gate). "Approver" = `staff.can_approve`.
A manager who is an approver may approve their own post (current behaviour) but the approve step
is still an explicit button (never implicit on save).

---

## 2. Navigation and routes

Tabs (in order): **Overview · Calendar · Posts · Media · Campaigns · History**.

- Media sits next to Posts (the two things people make). Count on Posts stays = waiting for approval.
  Add a count on History = failed channels in the last 7 days (`<span class="count">2</span>`), so a
  failure is visible from any tab.
- Phone: `.atlas-tabs` already scrolls with a fade. Six tabs overflow at 390 (today History is already
  cut off, see `phone-marketing-calendar.png`); the active tab must be scrolled into view on render
  (`scrollIntoView({ inline: 'nearest' })` on `[aria-current]`).
- Routes (all through `AtlasShell.navigate`):
  `#marketing/media` · `#marketing/media?asset=<id>` (opens detail sheet) ·
  `#marketing/media?collection=<id>` · `#marketing/post/new` · `#marketing/post/<id>` ·
  `#marketing/history?post=<id>` (linked target) · `#marketing/calendar?month=2026-10`.
  Closing a sheet that a link opened uses `navigate(hash, { replace: true })`.
- Palette actions (register next to `marketing.post.new`): `marketing.media.upload` "Upload photos or
  videos", `marketing.history.failed` "Show failed posts".

---

## 3. Header and caption (replaces the fixed "manual" copy)

Header stays: title "Marketing", sub, Ask Atlas (ghost), **New post** (primary). Rename the primary
from "New post draft" to **New post** (the composer now does more than drafts; the verb stays short).
Sub: `4 scheduled · 1 waiting for approval · 1 failed` (omit zero parts; "Nothing planned" when all zero).

Caption under the header is derived from channel capability (see §12):

| Situation | Caption |
| --- | --- |
| No channel can publish | "Atlas can't publish yet, so you post by hand and mark it here. Connect accounts in Settings" |
| Some can | "Atlas publishes approved posts to Instagram and Facebook. TikTok and Google Business Profile are posted by hand. Integrations in Settings" |
| All selected-in-use can | "Atlas publishes approved posts at their scheduled time. Integrations in Settings" |
| Automatic publishing switched off (§11) | "Automatic publishing is off. Approved posts wait for someone to press Publish now. Change in Settings" |
| A channel needs reconnecting | `atlas-alert--warning` instead of the caption: title "Instagram needs reconnecting", body "Scheduled Instagram posts won't publish until someone reconnects. 2 posts are affected.", action **Reconnect** (→ `#settings/integrations?provider=instagram`) |

---

## 4. Media tab

### 4.1 Layout (desktop ≥ 768)

```
[Search photos and videos      ] [All] [Photos] [Videos] [Collections] [Used] [Unused]  [Tag ▾]   [Upload]
Uploads (collapsible, only while items are in the queue)                                    
┌────┬────┬────┬────┬────┬────┐   .mk-media-grid (= .atlas-auto-grid, --grid-min 168px, gap 12)
│    │    │ ▶0:24 │ …                square tiles, object-fit cover at the asset's focal point
└────┴────┴────┴────┴────┴────┘
 espresso-martini.jpg  · Used in 2 posts
```

- Toolbar: `.atlas-toolbar` > `.atlas-search` (placeholder "Search by name, tag or caption") +
  filter `.atlas-chips` (six filters are too many for `.atlas-segmented`; chips are single-select here,
  `aria-pressed`) + **Tag** chip that opens `AtlasShell.menu` with the venue's tags (multi-select,
  selected tags appear as `.atlas-chip` with `__clear`) + `.atlas-toolbar__end` with **Upload**
  (`atlas-btn--secondary`, icon `upload`; the header keeps the page's one primary).
- Filters: All · Photos · Videos · Collections · Used · Unused. "Used" = in any non-cancelled post;
  "Unused" = in none. Collections shows collection tiles (2×2 mosaic of the first four + name + count).
- Sort: menu in toolbar end, "Newest first" (default) · "Oldest first" · "Name".
- Tile (`button.mk-asset`, whole tile opens detail): image, bottom-left `atlas-badge` "0:24" for video
  (icon `play`), bottom-right `atlas-badge--muted` "Used" when used, top-left check in selection mode.
  Below: name (one line, ellipsis, full name in `title`), meta "Used in 2 posts" / "Not used yet".
  `aria-label="espresso-martini.jpg, photo, used in 2 posts"`.
- Selection mode: long-press (phone) or the **Select** ghost button (toolbar) → bulk bar
  (`.atlas-bulkbar--sticky`): "3 selected · Add to post · Add to collection · Add tag · Delete".
- Desktop drag and drop: dropping files anywhere on the grid adds the `.is-dragover` wash to a
  full-width `.atlas-upload` target at the top: "Drop photos and videos to upload".

### 4.2 Phone (390)

- Toolbar scrolls sideways (existing rule); search is first and keeps 240 px; Upload becomes an
  `atlas-icon-btn` with `aria-label="Upload photos or videos"` at the end, **or** better: on the Media
  tab the header action row swaps "New post" for **Upload** (still one primary). Recommend the swap.
- Grid: 3 columns (`--grid-min: 104px`, gap 4, no names under tiles; names in detail sheet).
- File input: `<input type="file" multiple accept="image/jpeg,image/png,image/heic,image/webp,video/mp4,video/quicktime">`.
  No `capture` attribute, so iOS/Android offer Photo Library, Take Photo and Files.

### 4.3 Empty and filtered states

| State | Copy |
| --- | --- |
| No media | `atlas-empty`, icon `images`: **"No photos or videos yet"** / "Upload the photos and videos you post, then reuse them in any post." / [Upload photos or videos] (secondary) |
| Filtered empty | "No videos match "martini"." [Clear filters] |
| Unused filter empty | "Every photo and video is in a post." |
| Collections empty | icon `layers`: **"No collections yet"** / "Group photos in the order you want them, such as a carousel for the autumn menu." [New collection] |
| Load error | `atlas-alert--danger` "Media couldn't be loaded. Your files are safe." [Try again] |

### 4.4 Upload queue

Shown as a section above the grid ("Uploads", `atlas-section__meta` "2 of 5 done") and also inline in
the composer media strip. Each row is `.atlas-row` with `.atlas-upload__thumb` (local preview from
`URL.createObjectURL`), `__title` file name, `__meta` + `.atlas-progress--thin`:

| Row state | Meta | End control |
| --- | --- | --- |
| Waiting | "Waiting · 12.4 MB" | `atlas-icon-btn` x, `aria-label="Cancel upload of IMG_2231.MOV"` |
| Uploading | "45% · 5.6 of 12.4 MB" + progress | same Cancel |
| Processing | "Preparing preview…" (server makes thumbnails, converts HEIC) | none |
| Done | row leaves the queue; toast once per batch "5 files uploaded." | — |
| Failed | `.atlas-field__error` style text, see below | **Retry** (`atlas-btn--secondary --sm`) + Remove (x) |
| Cancelled | removed silently | — |

- Uploads run 2 at a time; the queue survives switching Marketing tabs; leaving the page while
  uploading shows the browser's leave prompt. Offline: queue pauses, meta "Waiting for connection".
- Collapse control: `details > summary` "Uploads (3)" once all rows are done or failed.

Error copy (what failed + what is safe + what to do):

- "IMG_2231.MOV is larger than 1 GB. Nothing was uploaded. Trim or compress it, then try again."
- "menu.pdf isn't a photo or video. Choose a JPEG, PNG, HEIC, MP4 or MOV file."
- "The upload stopped. The other files are fine. Retry this one."
- "This video's format can't be read. Export it as MP4 (H.264) and upload again."
- "You've reached today's upload limit for your account (Settings › Atlas AI › Files per person per day)." (limits already exist in settings: `upload_files_per_day`, `upload_bytes_per_day`)
- "Media storage isn't set up for this venue yet. An administrator can set it up." (404 / not configured)

### 4.5 Asset detail sheet

`atlas-sheet atlas-sheet--wide atlas-sheet--full-phone`, title = file name (editable in the Name
field), desc "Photo · 3024 × 4032 · 2.1 MB · uploaded by Sara, Thu 24 Sep" / "Video · 1080 × 1920 · 0:24 · 18 MB".

Body (`atlas-form`, groups = `fieldset.atlas-form-group`):

1. **Preview** – image fitted to 360 px tall; video with native `<video controls muted playsinline>`.
2. **Details** – Name; **Alt text** (`textarea`, 2 rows, max 1000) help: "Describes the photo for
   people who use screen readers. Instagram and Facebook post it with the photo." Warning when empty
   and used in a scheduled post: "Add alt text — 2 scheduled posts use this photo."; **Tags**:
   `.atlas-chips` of tags with `__clear`, then an `atlas-chip--dashed` "Add tag" that becomes an input.
3. **Focal point** (photos and video cover) – "Tap the part of the photo that must stay in every crop."
   Tapping/clicking the preview places a 24 px ring (`mk-focal`); keyboard: the ring is a focusable
   `role="slider"`-like control with `aria-label="Focal point"` and `aria-valuetext="42% across, 30% down"`;
   arrow keys move 2%, Shift+arrow 10%. Button "Reset to centre" (ghost sm).
4. **Crops** – "Atlas makes these copies for posting. The original is never changed." Grid of preset
   thumbnails (`.atlas-auto-grid`, `--grid-min 96px`), each a card with label and state:
   Square 1:1 · Portrait 4:5 · Story and Reel 9:16 · Landscape 1.91:1 · Google 4:3.
   Each tile: thumbnail derived from focal point, caption "Auto" or "Adjusted", button **Adjust** →
   crop dialog (`atlas-dialog--form` wide: image with fixed-ratio frame, drag or arrow keys to move,
   `atlas-range` to zoom 100–300%, [Reset] [Save crop]). Warning pill on a preset when the crop would
   upscale: `atlas-pill--warning` "Low resolution" with tooltip "This crop is 640 px wide; Instagram
   recommends 1080 px."
5. **Video** (videos only)
   - **Cover frame**: `atlas-range` scrubber over the duration with live frame preview + time label
     "0:07"; [Use this frame]. Or "Upload a cover image" (link). Help: "Instagram, Facebook and TikTok
     show this before the video plays."
   - **Trim**: two `input type="text" inputmode="numeric"` fields "Start at" / "End at" (m:ss) with
     the range under them; help: "Trim is saved as a setting. The video file isn't cut; each
     platform gets the trimmed part." Error: "End must be after start." / "The trimmed video is
     2 seconds; Reels need at least 3 seconds."
   - Facts: codec/frame rate only in a closed `details` "File details".
6. **Used in** – `.atlas-record-chip` per post ("Friday quiz night reel · Scheduled Sat 26 Sep").

Footer: `atlas-sheet__foot-start` **Delete** (ghost danger) · [Close] (ghost) · **Use in new post**
(secondary) · **Save** (primary, only when dirty). Delete confirm via `AtlasModal.confirm`:
title "Delete espresso-martini.jpg?", body "It's removed from the library. Posts already published
keep their copy.", confirm "Delete photo", danger. If used in a scheduled or waiting post: button
disabled with tooltip "It's in 2 scheduled posts. Remove it from those posts first."

Phone: full-screen sheet, sticky footer, Preview at the top max 50vh; crops grid 2 columns.

### 4.6 Collection builder

Sheet `atlas-sheet--wide --full-phone`, title "New collection" / collection name.

- Name field (required: "Give the collection a name.").
- Ordered list: `ol.atlas-list` rows (`atlas-row--compact`): 44 thumb (`atlas-row__icon` slot), title
  = asset name, meta "1 of 7 · Cover" for the first; end: `atlas-icon-btn--sm` **arrow-up** / **arrow-down**
  (`aria-label="Move espresso-martini.jpg up"`, first/last disabled) + **x** "Remove from collection".
  Exactly the recipes pattern (`recipes.js:1115`). Touch targets become 44 automatically.
- Desktop only: a `grip-vertical` handle at row start (`draggable="true"` on the row, pointer: fine);
  the drop position shows a 2 px `--accent` line. Drag is an extra; buttons always work.
- After each move: focus stays on the moved row's same button; live region announces
  "espresso-martini.jpg moved to position 2 of 7."
- [Add photos or videos] (secondary) → library picker (§5.3).
- Help: "The first item is the cover. Instagram carousels take up to 10." Warning at 11+: "Instagram
  and Facebook use the first 10. TikTok photo posts use up to 35."
- Footer: Delete collection (ghost start, confirm) · Cancel · **Save collection**.

---

## 5. Composer (new post / edit post)

### 5.1 Container decision

The current 640 px sheet cannot hold a form **and** live per-channel previews. Recommend:

- Desktop ≥ 1024: a routed page `#marketing/post/<id|new>` (`.atlas-page.page--wide`), page head with
  back link "Marketing" (`atlas-link`, icon `chevron-left`), title = post title or "New post",
  sub = status pill + "Saved 17:02". Two columns: form (min 0, max 720) | previews (360, `position: sticky`
  top under the top bar). Footer = sticky action bar `[data-atlas-sticky-actions]` (so toasts sit above it).
- 768–1023 and phone: single column; a `.atlas-segmented` at the top **Edit | Preview** (44 px touch)
  switches panes; sticky footer as above above the tab bar.
- Opening from calendar day, suggestion "Plan this", palette and Overview rows navigates to this route
  (prefilling date/suggestion via params). Keep `AtlasMarketingWorkspace.openContent()` working by
  navigating.
- Unsaved changes: navigating away asks `AtlasModal.confirm` "Leave without saving?" / "Your changes to
  this post will be lost." / [Keep editing] [Leave without saving] (danger). Autosave drafts every 10 s
  when valid title exists; sub shows "Saved 17:02" / "Saving…" / "Not saved — offline".

### 5.2 Form groups (in order)

1. **Title** — label "Title", help "Only your team sees this." Required.
2. **Campaign** (optional) — select, unchanged.
3. **Channels** — `fieldset.atlas-form-group`, legend "Channels". Replace check-rows with toggle chips
   (`button.atlas-chip[aria-pressed]`, text label only; no brand logos) — spec §7.13 already says
   "channel chips". Under each selected chip a one-line capability note in the group help:
   "Instagram and Facebook: Atlas publishes. TikTok: you post it by hand (not connected)." with link
   "Integrations in Settings". For a channel that is connected but needs a choice:
   "Facebook: choose which Page to post to in Settings."
4. **Media** — see §5.3.
5. **Caption** — label "Caption", `textarea` 6 rows. Counter under it (right-aligned `help`):
   "182 / 2,200 · Instagram is the shortest limit" — the counter uses the strictest selected channel
   that uses the common caption; it turns `--danger` text over the limit. Second line when relevant:
   "12 hashtags" (warning at > 30: "Instagram allows up to 30 hashtags.").
   Buttons under the field: **Ask Atlas** ghost sm ("Suggest a caption") — reuse `AtlasAI.askAbout`.
6. **Per-channel options** — one `details.mk-channel` per selected channel, collapsed by default
   (`summary` 44 px, has touch hit area already). Summary line = channel name + state text on the right:
   "Uses the common caption · Portrait 4:5" or "Custom caption · Reel" or `atlas-pill--danger` "1 problem".
   Inside (common to all):
   - **Format** (`atlas-segmented`, only the channel's valid formats; see table §5.5).
   - Toggle row `atlas-toggle-row` "Write a different caption for Instagram". On: textarea prefilled
     with the common caption + counter for that channel + `atlas-link` "Use the common caption again"
     (confirm not needed; undo toast "Instagram uses the common caption again. [Undo]").
   - **Crop** select (photos): "Portrait 4:5 (recommended)", "Square 1:1", "Landscape 1.91:1", "Original".
   - Channel-specific controls (TikTok §5.6, Google §5.7).
7. **When** — `fieldset` legend "When":
   `atlas-segmented` role=radiogroup: **At a time** · **As soon as it's approved** · **No time yet**.
   - At a time: `datetime-local step=60` label "Post on (Reykjavík time)"; `min` = now. Under it, always
     in Atlas 24 h format: "Posts Sat 26 Sep at 17:00 Reykjavík time." (the native field may show 12 h
     on en-US devices — this line is the source of truth). If the browser zone differs:
     "That's 13:00 your time (New York)." Quick chips: "Today 17:00" · "Tomorrow 12:00" · "Fri 20:00".
   - The label uses the venue zone's city from `AtlasVenueClock` (fallback "venue time").
   - "Remind me" moves inside a `details` "Reminder" (only matters for by-hand channels):
     default "30 minutes before" select (Off / 15 min / 30 min / 1 hour / 1 day before).
8. **Note for the approver** (optional, only when submitting) / **Note for the team** (approver).
9. **Approval history** — unchanged list, now also lists publish events.

### 5.3 Add media and the media strip

- Button **Add media** (secondary, icon `image-plus`) opens `AtlasShell.menu` with:
  **Upload new** (opens file picker; files go into the library and the post) · **From library** ·
  **From a collection**. On phone the menu renders as the standard menu (44 px items).
- Library picker: `atlas-sheet --wide --full-phone` "Add from library": Media toolbar (search + chips,
  no Collections chip) and grid in selection mode; selecting shows the order number (1, 2, 3) on the
  tile; footer "3 selected · [Cancel] [Add 3]". Items already in the post are shown selected-disabled
  with "In this post".
- Collection picker: list of collections (`atlas-row` with 44 mosaic thumb, "7 photos"); choosing one
  adds its items in order (copies; later collection edits don't change the post). Toast "7 photos added
  from Autumn menu."
- **Media strip** (`ol.mk-strip`, horizontal, scrolls sideways inside the form on phone, wraps on desktop):
  88 px square thumbs; badge "1" order + `atlas-badge` "Cover" on the first; video badge "0:24";
  per-item `atlas-icon-btn--sm` `ellipsis` menu: **Make cover** (moves to first) · **Move left** ·
  **Move right** · **Edit crop and alt text** (opens asset detail) · **Remove from post**.
  Desktop: drag to reorder (same line indicator as §4.6). Uploading items sit in the strip with a
  `.atlas-progress--thin` and Cancel.
- Empty strip: `.atlas-upload` target: thumb icon `image-plus`, title "Add photos or videos",
  help "Instagram and TikTok need at least one. Up to 10 for a carousel.", button **Add media**.

### 5.4 Previews (lightweight)

Right column (desktop) / Preview pane (phone). `atlas-segmented` of the selected channels (≤ 4). Label
above: "Preview" + `help` "Approximate. Each platform decides the final look." One card per channel,
`mk-preview` variants built from existing card tokens (1 px line, 12 radius, white, no shadow):

| Channel | Card shape |
| --- | --- |
| Instagram post/carousel | header row: 28 avatar (`atlas-avatar`) + account name from the connection ("vabar.reykjavik"); media at chosen crop ratio; carousel dots under media; caption truncated after 2 lines with "… more"; time "Sat 26 Sep, 17:00" |
| Instagram Reel/Story | 9:16 frame (max 320 tall) with cover, caption overlay 2 lines (Reel) / none (Story) |
| Facebook | page name + "Sat 26 Sep at 17:00"; caption first (5 lines then "See more"), media under (grid of up to 4 for multi-photo, "+3") |
| TikTok | 9:16 frame, cover frame, caption overlay; privacy under the frame: "Visible to: Friends" (or "Choose who can see it" warning if unset) |
| Google Business Profile | 4:3 photo, summary (truncated ~ 4 lines), CTA as a text button "Book", event/offer title + dates |

No platform chrome icons (hearts, share glyphs) — keeps it clearly "approximate" and avoids brand
assets. When there is no connection, account name reads "Your Instagram account".
Media missing: grey frame with icon `image` and text "No media yet".

### 5.5 Formats and checks per channel (server supplies the numbers)

The limits below are defaults for copy and layout; the server's platform rules are the source of
truth and must be re-verified against the platform docs at build time.

| Channel | Formats | Media rule | Caption | Other |
| --- | --- | --- | --- | --- |
| Instagram | Post · Carousel (auto when > 1 item) · Reel · Story | ≥ 1 required; photos 4:5–1.91:1; carousel ≤ 10; Reel video 3 s–15 min, 9:16 recommended | 2,200 chars, ≤ 30 hashtags, ≤ 20 @mentions | 100 API posts / 24 h per account |
| Facebook | Post · Reel · Story | optional for Post | 63,206 chars (practically unlimited; no counter until 2,000) | Page must be chosen |
| TikTok | Video · Photo post | ≥ 1 required; video length ≤ creator's max from TikTok; photo post ≤ 35 | 2,200 chars (video title / photo description) | privacy required, see §5.6 |
| Google Business Profile | Update · Event · Offer | ≤ 1 photo; no video | 1,500 chars; phone numbers in text are rejected by Google | CTA/event/offer fields §5.7 |

### 5.6 TikTok controls (inside the TikTok disclosure; TikTok's content-sharing UX rules)

Header line: 28 avatar + "Posting as **@vabar.rvk**" (creator nickname from TikTok, always shown).

1. **Who can see this video** — `select` with **no default**: first option disabled + selected
   "Choose who can see it"; options only from TikTok's `privacy_level_options` for the account:
   "Everyone", "Friends", "Only me". Required. Error: "Choose who can see it on TikTok."
   When the app is unaudited (server flag): only "Only me" is available, plus info alert:
   "Until TikTok approves Atlas, TikTok posts are private (Only me). You can make them public in the
   TikTok app afterwards."
2. **Allow people to** — three `atlas-check-row`, all **unchecked by default**: "Comment" · "Duet" ·
   "Stitch". Duet and Stitch are hidden for photo posts. A control TikTok has turned off for the account
   is disabled with help "Turned off in your TikTok settings."
3. **Disclose commercial content** — `atlas-toggle-row`, off by default, help "Turn on if this post
   promotes your venue, a brand, product or service." When on, two check rows (at least one required):
   - "Your brand" — help "You're promoting yourself or your own business. The post is labelled
     'Promotional content'."
   - "Branded content" — help "You're promoting another brand or a third party. The post is labelled
     'Paid partnership'."
   Error when on with neither: "Choose whether this promotes your brand, another brand, or both."
   Branded content cannot be private: selecting it with "Only me" → "Branded content can't be private.
   Choose Everyone or Friends." and "Only me" becomes disabled with that reason.
4. **Consent line** (plain `help` text right above the footer when TikTok is selected, not a checkbox):
   - Default: "By posting, you agree to TikTok's Music Usage Confirmation."
   - With Branded content: "By posting, you agree to TikTok's Branded Content Policy and Music Usage
     Confirmation." (both names are links to TikTok's pages, `target="_blank" rel="noopener"`).
5. After TikTok accepts: toast "Sent to TikTok. It can take a few minutes to appear on your profile."
   Per-channel status shows "Processing on TikTok" until TikTok confirms.
6. Atlas adds no watermark or logo to TikTok media (note for engineering; nothing in UI).

### 5.7 Google Business Profile options

- **Post type** `atlas-segmented`: **Update** · **Event** · **Offer**.
- **Location**: read-only line "Posting to VÁ Bar, Laugavegur 1" (from the chosen location, §12.3);
  if several locations are connected: select "Location".
- **Button** (Update and Event): select "No button" (default) · "Book" · "Order online" · "Buy" ·
  "Learn more" · "Sign up" · "Call now". Link field "Button link" (url, required unless "Call now";
  help for Call now: "Uses the phone number on your Business Profile."). Error: "Add the link the
  button opens." / "Enter a full link starting with https://".
- **Event**: "Event title" (required, 58 chars), "Starts" / "Ends" (`datetime-local`, Reykjavík time,
  end `data-atlas-min-from`), toggle "All day". Error "The event ends before it starts."
- **Offer**: "Offer title" (required), "Starts" / "Ends" (date), "Coupon code" (optional),
  "Redeem online link" (optional url), "Terms" (optional textarea). No button field for offers
  (Google shows "View offer").
- Help under summary: "Google removes posts with phone numbers in the text. Use the Call now button."

### 5.8 Validation

- Run on every change (debounced 300 ms) and on each footer action. Results in a **Checks** panel
  above the footer (desktop: top of the preview column; phone: bottom of Edit pane, and a badge on the
  Preview segment).
- Two levels: **Must fix** (blocks Submit for approval, Approve, Publish now; not Save draft) and
  **Worth checking** (never blocks).
- Panel: `atlas-alert--danger` title "2 things to fix before this can be approved" (or
  `atlas-alert--warning` "1 thing worth checking"), body = `ul` of `atlas-link` buttons; clicking one
  opens the right disclosure, marks the field `aria-invalid`, focuses and scrolls to it (design-system
  submit-check rule). All clear: `help` line with `circle-check` "Ready for Instagram, Facebook and TikTok."
- Each message names the channel first. Exact copy:

| Check | Level | Copy |
| --- | --- | --- |
| No channel | must | "Choose at least one channel." |
| No title | must | "Give the post a title." (existing) |
| IG/TikTok no media | must | "Instagram needs at least one photo or video." |
| IG too many | must | "Instagram carousels take up to 10 photos or videos. Remove 2." |
| IG aspect | must | "Instagram: photo 3 is taller than 4:5. Choose the Portrait 4:5 crop." |
| Reel too short/long | must | "Instagram Reels must be 3 seconds to 15 minutes. This video is 2 seconds." |
| Story with caption | worth | "Instagram Stories don't show captions. The caption is only saved in Atlas." |
| Caption too long | must | "Instagram caption is 2,340 characters; the limit is 2,200. Shorten it or write a shorter Instagram caption." |
| Hashtags | must | "Instagram allows up to 30 hashtags. This caption has 34." |
| TikTok privacy | must | "Choose who can see it on TikTok." |
| TikTok commercial | must | "Choose whether this promotes your brand, another brand, or both." |
| TikTok video too long | must | "TikTok: this account can post videos up to 10 minutes. This one is 12:40." |
| Google video | must | "Google Business Profile can't post videos. Remove the video or turn off Google Business Profile." |
| Google > 1 photo | worth | "Google Business Profile uses only the first photo." |
| Google phone in text | must | "Google removes posts with a phone number in the text. Use the Call now button instead." |
| Google event dates | must | "Add when the event starts and ends." |
| Missing alt text | worth | "Photo 2 has no alt text. Add it so people using screen readers know what it shows." |
| Time in the past | must | "Choose a time in the future." |
| Time too soon | worth | "This is in 4 minutes. If approval takes longer, it posts as soon as it's approved." |
| Channel cannot publish | worth | "TikTok isn't connected, so you'll post it by hand. Atlas reminds you 30 minutes before." |
| Channel needs reconnecting | must (for Publish now) / worth (for schedule) | "Instagram needs reconnecting before it can publish. Reconnect in Settings." |
| Low resolution crop | worth | "Photo 1 is 640 px wide. It may look soft on Instagram (1080 px recommended)." |
| Upload still running | must | "Wait for 2 uploads to finish." |
| Daily limit | worth | "Instagram allows 100 posts a day from one account; 98 are already scheduled for Sat 26 Sep." |

### 5.9 Footer actions by state

One primary per state. `atlas-sheet__foot-start` pattern for the destructive/secondary-left action.

| Post state | Who | Buttons (left → right) |
| --- | --- | --- |
| New / Draft / Changes requested | author (manager) | Delete draft (ghost, start) · Save draft · **Submit for approval** |
| same | approver who is also author | Delete draft · Save draft · **Approve and schedule** (or **Approve and publish now** when When = "As soon as it's approved"; **Approve** when "No time yet") |
| Waiting for approval | approver | Reject (ghost, start) · Request changes · **Approve** (label follows When as above) |
| Waiting for approval | author, not approver | Withdraw (ghost, start) · **Close** (secondary) — form read-only with info alert "Waiting for approval from Imad or Þórdís." |
| Approved, no time | any manager | Edit · Schedule… · **Publish now** |
| Scheduled | any manager | Unschedule (ghost, start) · Edit · **Publish now** |
| Publishing | — | **Close**; status lines live |
| Partly published / Failed | any manager | **Retry failed channels** · Mark posted by hand (secondary, per channel in the Publishing section) |
| Published | — | Duplicate as new post (secondary) · **Close** |
| By-hand channel, time reached | any manager | **Mark posted by hand** (existing `mark-published`, now per channel) |

Behaviour and copy:

- **Edit after approval** (Approved or Scheduled): `AtlasModal.confirm` "Edit this approved post?" /
  "Any change sends it back for approval and it won't publish until it's approved again." /
  [Keep it as is] [Edit post]. Non-content edits (time only) by an approver skip re-approval.
- **Publish now**: confirm "Publish to Instagram and Facebook now?" / "It goes live straight away.
  TikTok is posted by hand." / [Cancel] [Publish now]. Toast "Publishing to 2 channels…" then result
  toast (§9).
- **Request changes / Reject** keep the required note (existing copy "Add a note so the team knows
  what to change.").
- **Unschedule**: toast "Unscheduled. It stays approved. [Undo]".
- Busy: the pressed button `is-loading` + `aria-busy`, others disabled (existing `busy()`).
- Offline: all write buttons disabled, tooltip "You're offline. Changes can't be saved."
- Remove the fixed sheet desc "Nothing is posted automatically." (see §14).

### 5.10 Post status vocabulary (pills)

Post-level (`STATUS` map additions):
Draft (neutral) · Waiting for approval (info) · Changes requested (warning) · Approved (positive) ·
Scheduled (positive) · **Publishing** (info) · Published (positive) · **Partly published** (warning) ·
**Failed** (danger) · Rejected (neutral) · Cancelled (neutral). "Done" stays for campaign tasks.

Channel-level (new, used in calendar dots, History, post Publishing section):

| Key | Label | Tone | Dot |
| --- | --- | --- | --- |
| waiting_approval | Waiting for approval | info | hollow `--info` ring |
| scheduled | Scheduled | neutral | `--text-3` filled |
| by_hand_due | Post by hand | warning | `--warning` ring |
| publishing | Publishing | info | `--info` filled, no pulse (motion calm) |
| processing | Processing on TikTok | info | same |
| published | Published | positive | `--positive` filled |
| posted_by_hand | Posted by hand | positive | `--positive` ring |
| failed | Failed | danger | `--danger` filled |
| skipped | Not posted | neutral | line-strong ring |

Dots never carry meaning by colour alone: each dot has a channel letter (I, F, T, G) inside a 16 px
circle (`mk-chan`) and an `aria-label` / tooltip "Instagram: Published 17:00".

---

## 6. Approval

- Overview "Waiting for approval" keeps its list but each row gets a 44 thumb of the cover and channel
  dots; row action **Review** opens the composer route.
- Approver view = composer read-only (fields disabled, previews and checks visible) + note field +
  footer from §5.9. A post with "Must fix" checks can't be approved: Approve disabled with tooltip
  "Fix 2 problems first" and the checks panel explains; approver can **Request changes** instead.
- Approval banner in the composer (`atlas-alert--info`): "Sara sent this for approval on Thu 24 Sep,
  14:10. Note: 'Can we post before the quiz starts?'"
- After changes requested, author sees `atlas-alert--warning` "Imad asked for changes: 'Use the
  portrait crop.'" at top.
- Approval history rows: "Approved by Imad · Thu 24 Sep, 15:02", "Changes requested by Imad · note",
  "Sent for approval by Sara", "Published to Instagram by Atlas · Sat 26 Sep, 17:00".

---

## 7. Calendar

### 7.1 Desktop month grid (keeps `mk-calendar`)

- Toolbar: existing month navigation + month title; add channel filter chips (All · Instagram ·
  Facebook · TikTok · Google) and a legend `details` "What the dots mean".
- Day cell (min-height 120): day number button (new post on that day, existing). Up to 3 entries as
  `button.mk-day__item` rows: 24 px cover thumb (radius 4) · time "17:00" (`--type-caption`,
  `.num`) · title (ellipsis) · channel dots at the end. Entry background stays neutral (`--bg-subtle`),
  not `--accent-soft` for all (today every entry is blue regardless of state). A failed entry gets a
  `--danger` 2 px inline-start edge; waiting-for-approval entries a dashed outline.
- "+2 more" becomes a `atlas-link` that opens a popover (`.atlas-popover`) listing the day.
- Past days: published items show; past unpublished (failed / by-hand not marked) show their state.
- Drag-to-reschedule: out of scope for S94 (flag for later); rescheduling goes through the composer.

### 7.2 Phone (< 768): agenda

- Replace the flat `mk-calendar-list` with grouped days: each day is an `atlas-section__head`
  (`h3`, `--type-label`) "Sat 26 Sep · Tomorrow" followed by an `atlas-list` of rows:
  44 cover thumb (`atlas-row__icon` slot, image) · title · meta "17:00 · Reel" · channel dots row ·
  end: post status pill. Days with nothing are skipped; "Today" header always shown ("Nothing today").
- Month navigation stays at top; add **Jump to today** when scrolled. Past days of the current month
  collapse under `details` "Earlier this month (4)".
- Tap a day number is not available on phone; "New post" in the header covers it.

### 7.3 Empty

"Nothing planned in October" / "Plan a post and it shows here." [New post] (secondary).

---

## 8. Automatic publishing (runtime behaviour the UI must explain)

- At the scheduled time, each channel that is **Connected + Publishing allowed + account chosen**
  publishes automatically; each other selected channel becomes **Post by hand** and the reminder fires.
- Nothing publishes unless the post is Approved (server rule; UI never offers a path around it).
- If a post is still Waiting for approval at its time: it stays waiting; the approver gets a
  notification "Friday quiz night reel was due at 17:00 and still needs approval." When approved later
  with "At a time" in the past, the approve button reads **Approve and publish now** and the confirm says so.
- The post's **Publishing** section (composer, read-only, above Approval history) lists channels with
  their channel-level status (same rows as History §9), updating every 10 s while any channel is
  Publishing/Processing.

---

## 9. History

Replace "Published and done" + "Activity" with:

- Toolbar: chips **All · Failed · Published · Posted by hand**; count in History tab = failed (7 days).
- List of posts, newest first, grouped by day headers like the phone agenda. Post row: cover thumb,
  title, meta "Sat 26 Sep, 17:00 · Reel", end pill (post-level). Under it (always expanded, indented
  list `atlas-list` with `atlas-row--compact`), one row per channel:

```
Instagram      ● Published 17:00          View on Instagram ↗
Facebook       ● Published 17:01          View on Facebook ↗
TikTok         ● Failed 17:00             [Retry TikTok]
               TikTok didn't accept the video: it is longer than this account's 10-minute limit.
Google         ○ Posted by hand 17:20 · Sara
```

- **Retry** only on failed channel rows: `atlas-btn--secondary --sm` "Retry TikTok". Never re-posts
  channels that published. Pressing it: button `is-loading`; toast "Retrying TikTok. Instagram and
  Facebook are already published and won't post again." Result toast "Published to TikTok." or row
  error updated. Retry is disabled with the reason when the cause needs a fix first:
  "Reconnect TikTok first" (links to Settings) or "Edit the post first" (links to composer; the edit
  confirm says only the failed channel will be published after approval).
- Secondary action on failed rows (menu `ellipsis`): **Mark posted by hand** · **Don't post to TikTok**
  (→ Not posted) · **Edit post**.
- Failure copy pattern: "<Channel> didn't accept the <photo|video|post>: <plain reason>." + safe/next:
  - "Instagram needs reconnecting. Nothing was posted to Instagram. Reconnect, then retry."
  - "Facebook was busy and didn't answer. Nothing was posted. Retry in a few minutes."
  - "Instagram's daily limit of 100 posts was reached. Retry after 17:00 tomorrow."
  - "Google Business Profile rejected the text (phone number). Edit the post, then retry."
  - "TikTok is still processing the video after 30 minutes. Check your TikTok profile; if it isn't
    there, retry."
- **Activity** moves to a closed `details` "All activity" at the bottom (existing event list), with new
  labels: `publish_started` "Publishing started", `channel_published` "Published to Instagram",
  `channel_failed` "Instagram failed", `channel_retry` "Retried Instagram", `posted_by_hand`
  "Marked as posted by hand on TikTok" (replaces "Marked as published").
- `#marketing/history?post=<id>` highlights the post with `.is-linked-target`.
- Empty: "Nothing published yet" / "Posts appear here once they go out, with each channel's result."

---

## 10. Notifications (AtlasShell.notify; filter "Needs action" where marked)

| Event | To | Needs action | Title | Body | Link |
| --- | --- | --- | --- | --- | --- |
| Sent for approval | approvers | yes | "Post waiting for your approval" | "Friday quiz night reel · Sara · Sat 26 Sep, 17:00" | composer |
| Changes requested | author | yes | "Changes requested" | "Imad: 'Use the portrait crop.' · Friday quiz night reel" | composer |
| Approved | author | no | "Post approved" | "Friday quiz night reel publishes Sat 26 Sep at 17:00." | composer |
| Rejected | author | no | "Post rejected" | note | composer |
| Due but not approved | approvers | yes | "Post still needs approval" | "It was due at 17:00. It publishes when approved." | composer |
| Published (all) | author | no | "Published to Instagram and Facebook" | title | history |
| Partly published / failed | author + approvers | yes (danger icon) | "TikTok didn't publish" | "Friday quiz night reel. Instagram and Facebook are live." | history?post |
| Post by hand due | author | yes | "Time to post on TikTok" | "Friday quiz night reel · 17:00. Mark it posted when it's done." | composer |
| Reconnect needed | managers | yes | "Instagram needs reconnecting" | "3 scheduled posts won't publish until it's reconnected." | settings/integrations?provider |
| Access expiring | managers | yes | "Facebook access ends in 7 days" | "Reconnect to keep scheduled posts publishing." | settings |

Device push uses the same title/body. Toasts only for the user's own completed actions (design rule).

---

## 11. Settings › Operational rules › Marketing approvals (automatic publishing switch)

Extend the existing "Marketing approvals" rule form (`settings-workspace.js:606`):

- `atlas-toggle-row` **Publish approved posts automatically**, help "At the scheduled time Atlas posts
  to every connected channel that allows publishing. Off: approved posts wait for someone to press
  Publish now." Default **on** once any channel can publish; disabled with reason "Connect a channel
  that allows publishing first." otherwise.
- Read-only line (lock icon): "Every post needs approval before Atlas publishes it."
- Select "Default reminder for posting by hand": Off / 15 / 30 (default) / 60 minutes before.
- Replace the line "Publishing and analytics stay off until an account is connected in Integrations."
  with capability-derived copy (§3). Brand voice stays (help already says it moves to Marketing).

---

## 12. Settings › Integrations

### 12.1 Card anatomy (keeps `settings-provider`)

Head: name + one status pill. Status line. Facts (Account, Connected by, Last checked). **New:** a
capability list `ul.settings-provider__can` (2–3 rows, icon + text): "Show account details" ✓,
"Publish posts" ✓ / lock "Not allowed yet", "Choose where to post": "VÁ Bar (Page)". Actions row.

### 12.2 States (pill · status line · actions)

| State | Pill | Status line (owner copy) | Actions |
| --- | --- | --- | --- |
| Not configured | neutral "Not set up yet" | `enables` sentence, e.g. "Lets Atlas publish approved posts to Instagram." Admin: "Setup details" disclosure | none |
| Ready to connect | neutral "Not connected" | "Ready to connect." | **Connect** (primary) |
| Checking | warning "Checking" | "Atlas is checking the connection." | Test connection · Disconnect |
| Connected, publishing allowed | positive "Can publish" | "Connected as @vabar.reykjavik. Approved posts publish here." | Test connection · Change account · Disconnect |
| Connected, publishing not allowed | warning "Can't publish yet" | "Connected, but posting wasn't allowed. Reconnect and allow Atlas to post." | **Allow publishing** (primary; restarts consent with publish scopes) · Disconnect |
| Connected, no account chosen | warning "Choose a Page" / "Choose an account" / "Choose a location" | "Connected. Choose which Facebook Page Atlas posts to." | **Choose Page** (primary) |
| Needs reauthorization | warning "Reconnect needed" | "Access expired or was removed on Instagram. Scheduled posts won't publish until you reconnect." | **Reconnect** (primary) · Disconnect |
| Verification failed | warning "Check failed" | `last_error` in plain words, else "The last check failed. Test again, or reconnect." | Test connection · Reconnect · Disconnect |
| App review required | neutral "Waiting on the platform" | Manager: "Instagram hasn't approved Atlas for posting yet. Plan and approve posts as usual and post them by hand until then." Admin adds "Setup details" (which permissions need App Review) | none (Connect still available if reading works) |
| Platform review pending | info "Review in progress" | "The platform is reviewing Atlas's access. Nothing to do until it finishes." (existing) | none |
| TikTok unaudited (sub-state of Can publish) | positive "Can publish" + fact line | "Posts are private (Only me) until TikTok approves Atlas." | as Connected |

Today `verification_failed` and `needs_reauthorization` both read "Needs attention" and `ready` reads
"Not connected" beside "Ready to connect." — split as above so the pill alone says what to do.

Footer note under the list replaces "Connected accounts never publish anything by themselves.
Planning in Marketing works without them." with: "Atlas only publishes posts someone approved.
Planning in Marketing works without any connection." (still `lock` icon).

### 12.3 Account / Page / location picker

After OAuth returns (existing `?integration=…&result=connected` notice) and when the provider exposes
more than one target, open a sheet automatically (and from **Choose Page** / **Change account**):

- `atlas-sheet` title "Choose the Facebook Page" / "Choose the Instagram account" / "Choose the
  Business Profile location"; desc "Atlas posts only to the one you choose. You can change it later."
- `fieldset` of `atlas-check-row` radios (44 px), each: `atlas-avatar` (image or initials) + name +
  meta ("Page · 2,340 followers" / "@vabar.reykjavik · linked to VÁ Bar Page" / "Laugavegur 1,
  101 Reykjavík · Verified"). Disabled options with reason: "Not a professional account — switch it to
  Business in Instagram." / "Not linked to a Facebook Page." / "Not verified on Google yet." /
  "You're not a manager of this Page."
- Footer: Cancel · **Use this Page**. Success toast "Posts go to VÁ Bar on Facebook."
- Empty: "No Pages found" / "The Facebook account you connected doesn't manage any Pages. Connect with
  the account that manages VÁ Bar's Page." [Reconnect].
- Instagram depends on Facebook (same Meta app): if Facebook isn't connected the Instagram card's
  status line says "Connecting Instagram also connects your Facebook Page." (one consent flow).
- Changing account with scheduled posts: confirm "Change to another Page?" / "4 scheduled posts will
  publish to the new Page." [Keep current] [Change Page].

### 12.4 Phone

Cards stack (current layout works at 390); actions wrap; the picker sheet is a bottom sheet
(`--full-phone` when > 5 options).

---

## 13. Phone summary (390)

- Every control ≥ 44 px (shared touch rules already apply to chips, segmented, summary, links,
  icon buttons). Module never adds its own touch sizes.
- Composer: Edit | Preview segmented, sticky footer above tab bar, per-channel disclosures closed.
- Media strip scrolls sideways inside its container only (no page horizontal scroll); strip items
  use the ellipsis menu (no drag on touch).
- Collection/asset reorder: arrow buttons only.
- Calendar: agenda. History: channel rows stack name/status on one line, error text below, Retry
  full-width `atlas-btn--block` under the error.
- Upload: header primary becomes **Upload** on the Media tab.

---

## 14. Conflicts in the current UI (must change)

1. **"Nothing is posted automatically" copy is hard-coded** in five places and becomes false:
   editor desc (`marketing-workspace.js:321`), Suggestions meta "nothing is posted automatically"
   (`:183`), caption "Publishing is manual until…" (`:252`), Settings integrations footer
   "Connected accounts never publish anything by themselves." (`settings-workspace.js:867`), Marketing
   approvals rule "Publishing and analytics stay off until…" (`:611`). Also `connectionCaption()` reads
   `display_status === 'connected'` and says "posting is still marked by hand here" — must be driven by
   publish capability. Suggestions meta can stay "Suggestions are never posted without approval."
2. **"Photos or video needed" text field** + help "Attach media when you post; Atlas doesn't store
   post media yet." (`:330`) conflicts with real media. Replace with the media strip; keep the old text
   as an optional "Shot list" (brief) only if content teams use it (data: `media_requirements.notes`).
3. **Type select** (Post/Story/Reel/Google post…) is one type for all channels and is locked after
   creation (`disabled` when editing). Publishing needs a **format per channel** (§5.5). Keep top-level
   type only for non-publishable items (Campaign task, Idea, Event promotion); for posts derive from
   channel formats. The lock-after-create also blocks switching Post → Reel after feedback.
4. **Channels are check-rows**, not chips as spec §7.13 says; at 390 "Google Business Profile" wraps
   onto its own line (`phone-editor-approve.png`). Use chips.
5. **Single generic preview** ("No channel / Your text appears here") — replace with per-channel
   previews; `mk-preview__card` max 360 stays as the card width.
6. **Status set lacks** Publishing / Partly published / Failed and per-channel status; `FINAL` treats
   `published` as final, but a partly-published post is not final (retry).
7. **"Mark as published" is post-level** (`mark-published` with `external_publication_ids: {}`); must
   become per channel ("Mark posted by hand" on TikTok) and hidden for channels Atlas published.
   Toast "Marked as published. Nothing was posted by Atlas." stays correct only for by-hand channels.
8. **Editing an approved/scheduled post**: today `can_edit` decides; there is no warning that edits
   need re-approval. Add the confirm (§5.9).
9. **Integration pills**: `verification_failed` and `needs_reauthorization` share "Needs attention";
   no publishing-permission, account-chosen or app-review states (`INTEGRATION_STATES`).
10. **Calendar**: all entries are `--accent-soft` blue regardless of status; title only (no time, no
    thumbnail, no channel); phone list has no day grouping and shows the full month flat.
11. **Time label "(venue time)"** — use the zone city ("Reykjavík time") and always echo the chosen
    time in 24 h under the native field; the native control shows 12 h mm/dd on en-US devices
    (`desktop-editor-new.png` shows "mm/dd/yyyy, --:-- --").
12. **Posts tab count** shows waiting-for-approval (1) while the Posts default filter is "Active":
    tapping the badge doesn't land on the waiting items. Either default the filter to "Waiting" when
    the count is > 0 or move the count to Overview.
13. **Phone tabs**: History is off-screen at 390 already; a sixth tab (Media) makes it worse — ensure
    the active tab scrolls into view.
14. **History labels**: `content_published: 'Marked as published'` must split into Atlas-published vs
    posted by hand; "Connection changed" event lacks which channel/state.
15. **Editor is a 640 px sheet**: too narrow for form + previews; recommend the routed page (§5.1).
    Palette action `marketing.post.new` and `openContent()` must navigate to the route.
16. **Approve on a post with no time** silently becomes "Approved"; with publishing, the button label
    must say what happens ("Approve and schedule" / "Approve and publish now" / "Approve").

---

## 15. Reusable components and classes

Existing, reuse as-is:
`page-head` (+ actions), `atlas-tabs` + `.count`, `atlas-toolbar` / `__end`, `atlas-search`,
`atlas-chips` / `atlas-chip` (`aria-pressed`, `--dashed`, `__clear`), `atlas-segmented`,
`atlas-btn` (`--primary/--secondary/--ghost/--danger`, `--sm`, `--block`, `.is-loading`),
`atlas-icon-btn` (`--sm`), `atlas-list` / `atlas-row` (`--compact`, `--link`, `__icon`, `__body`,
`__title`, `__meta`, `__end`, `__action`), `atlas-pill` tones, `atlas-badge` (`--muted`),
`atlas-avatar`, `atlas-record-chip`, `atlas-sheet` (`--wide`, `--full-phone`, `__foot-start`),
`atlas-dialog--form`, `AtlasModal.confirm/prompt/form/layer`, `AtlasShell.menu`, `AtlasShell.toast`
(with Undo action), `atlas-form`, `atlas-form-group`, `atlas-field` / `.help` / `.error`,
`atlas-input` / `atlas-select` / `atlas-textarea`, `atlas-toggle-row`, `atlas-check-row` +
`atlas-check` / `atlas-radio`, `atlas-range`, `atlas-upload` (`.is-dragover`, `__thumb`, `__body`,
`__title`, `__help`, `__error`), `atlas-progress--thin`, `atlas-alert` tones, `atlas-empty`
(`--inline`), `atlas-skel`, `atlas-bulkbar--sticky`, `atlas-popover`, `[data-atlas-tooltip]`,
`.is-linked-target`, `atlas-auto-grid` (`--grid-min`, `--grid-gap`), `atlas-stack`, `atlas-cluster`,
`atlas-link`, `details > summary`, `[data-atlas-sticky-actions]`, `.sr-only`, `.num`.
Recipes reorder pattern (`recipes.js:1115`).

New module layout classes (`marketing-workspace.css`, tokens only):
`mk-media-grid`, `mk-asset` (+ `__img`, `__badge`, `__name`, `__meta`, `.is-selected`),
`mk-collection-tile`, `mk-queue`, `mk-focal`, `mk-crops`, `mk-strip` / `mk-strip__item`,
`mk-composer` (two-column page layout), `mk-channel` (per-channel disclosure), `mk-checks`,
`mk-preview` + `--instagram/--facebook/--tiktok/--google` and `--vertical`, `mk-chan` (16 px channel
letter dot with status tone), `mk-day__item` (thumb + time + dots), `mk-agenda`, `mk-history-channel`.
Settings: `settings-provider__can`, `settings-picker`.

Candidates to file with the design-system owner (don't build locally):
1. **Media tile** (square image button with corner badges and selection check) — also useful for
   Team profile photos and Inventory capture results.
2. **Reorder list** (arrow buttons + optional drag handle + live announcement) — Recipes already
   hand-rolls it.
3. **Upload queue row** (`atlas-upload` + progress + cancel/retry) — `atlas-upload` has no progress
   state today.
4. **Status dot with label** (tone + letter) if other modules need multi-channel status.

---

## 16. Accessibility checklist

- Thumbnails have `alt` = asset alt text or "Photo: <name>"; decorative badges `aria-hidden`.
- Reorder: buttons with names including the item; live region announcements; drag never required.
- Focal point and crop frame operable by keyboard.
- Checks panel links move focus to the field; fields get `aria-invalid` + `aria-describedby`.
- Channel status never by colour alone (letter + text/tooltip).
- Previews are `aria-label="Instagram preview (approximate)"`, contain real text.
- Upload progress: `role="progressbar"` with `aria-valuenow` and file name.
- Reduced motion: no pulse on Publishing; progress bar width transition only.
