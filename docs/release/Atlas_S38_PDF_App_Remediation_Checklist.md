# Atlas S38 PDF app-remediation checklist

Source: owner review PDF, 15 pages, received 12 September 2026.

## Scope boundary

S38 changes the Atlas web interface and client-side interaction wiring only. It does not add or alter database tables, RLS, migrations, Edge Function behavior, credentials, production endpoints, production data, or production deployments.

## Exact remediation map

| PDF page | Workspace | Requested correction | S38 implementation | Acceptance |
|---|---|---|---|---|
| 1 | Home | Fix layout and Atlas robot mark | Balanced two-column daily brief; official Atlas mark replaces the generic bot glyph | Mark is crisp, aligned, and does not duplicate |
| 1 | Home | Make the daily banner draw attention | Subtle repeating blue attention pulse with a reduced-motion opt-out | Visible motion; no animation when reduced motion is requested |
| 1–15 | Shared | Add hover treatment to floating cards | One shared lift, shadow, and border transition across supported workspaces | Cards move no more than 3 px and retain readable contrast |
| 2 | Operations | Fix the left blue light on scheduled routine cards | Replace the visual flare with a flat four-pixel state rail; blue is the normal scheduled state | No glow or detached light; status colours remain distinct |
| 2 | Operations | Remove black action buttons | Primary operational actions use the Atlas blue token | Destructive actions remain red and visually distinct |
| 2 | Inventory | Add wine subcategories | Preserve and expose the existing wine classifier: Champagne, Sparkling, Rosé, Red, and White | Selecting Wine displays the subcategory strip and counts |
| 3 | Inventory scanner | Match overall design | White/blue panel, lighter idle camera state, consistent radii and controls | Scanner visually matches Inventory on desktop and mobile |
| 3 | Inventory scanner | Repair close control | Capture-phase close bridge calls the scanner’s public close API | Header X and backdrop close the scanner and stop camera tracks |
| 3 | Inventory scanner | Repair quantity control | Deterministic ± bridge updates the decimal field and emits input/change events | Quantity never goes below zero and submits the displayed value |
| 4–5 | Inventory workflows | Align overlays, colours, spacing, and hover | Shared modal/control treatment and card interaction layer | No black primary controls or clipped modal content |
| 6 | Recipes/search | Use a smaller Apple-style search field | Compact pill search with clear focus ring | Search stays under 42 px high and remains keyboard accessible |
| 7 | Purchasing | Align layout, controls, spacing, and colour | Blue active navigation, structured order form/cards, consistent spacing | Supplier, order, and delivery states are visually distinct |
| 8 | Purchasing | Make Orders and Deliveries work | Re-enable both tabs and bridge sidebar subviews to their real purchase-order panels | Each control opens the matching panel and refreshes its data |
| 8–9 | Team Messages | Reduce page scrolling and add internal chat scrolling | Viewport-aware conversation height; independent channel and message scrolling | Composer remains reachable while long chats scroll internally |
| 8–9 | Team Messages | Add starring | Preserve the existing server-backed star action and strengthen its selected state | Star/unstar is visible and survives server refresh |
| 8–9 | Team Messages | Add browser and mobile notifications | Connect the top bell to Settings → Notifications and replace obsolete “coming later” copy | Bell opens notification controls; supported browsers use the configured permission flow |
| 8–9 | Team Messages | Match navigation icon and colour language | Conversation/channel icons use the shared blue-soft icon token | Icons align with the left navigation system |
| 10 | Shifts | Fix spacing and monthly view | Compact white/blue month surface with clear today/selected states | Month is readable without grey blocks or horizontal clipping at supported widths |
| 11–12 | Remaining workspaces | Match overall design and remove black buttons | Shared final-pass card, button, modal, form, and search tokens | Non-destructive primary buttons are Atlas blue |
| 13–14 | Atlas Brain | Improve organisation and polish | Light hierarchy, simplified hero, three-column metrics, balanced content split | Key briefing appears first; panels do not compete visually |
| 15 | Settings | Bring to the same polished standard | Light blue hero, compact spacing, blue tabs/actions, consistent panels | Settings matches the app shell and remains responsive |

## Functional safeguards

- Existing role gates remain authoritative.
- Existing server-backed wine classification, chat stars, notification preferences, and purchase-order mutations remain intact.
- Scanner camera frames and uploaded images remain device-local.
- Destructive actions retain a red treatment.
- Every animated treatment respects `prefers-reduced-motion`.
- Production remains outside the S38 run.
