# Alcedo Polish — documented follow-ups

From the UI polish + animation pass (PR #113). These were intentionally **not**
changed in that patch and are recorded here for a later, separate change.
Taxonomy, audit records and pricing data must be preserved when they are done.

## Deferred UI/data follow-ups (from item 7)
- **Category-label inconsistencies** — some category labels are inconsistent
  across screens (casing/wording). Reconcile at the taxonomy/label layer, not by
  editing stored category keys. Preserve the taxonomy.
- **Raw UUID descriptions** — a few places surface a raw UUID as a description.
  Replace with a human label at display time; do not alter stored ids or audit
  records.
- **Offer-price JSON editing** — an offer price is edited as raw JSON in the UI.
  Replace with a structured, validated editor; preserve existing pricing data and
  formats.

## Resilience program (the "11 checks" guide — separate, reviewed effort)
The polish pass covered the guide's in-scope items (press/hover/**disabled**
states, transitions, skeleton polish, reduced-motion, gentle toast motion). Dark
mode (check 10) is already handled by the rebrand. The remaining resilience items
are their own features and should each run the guide's method — a no-code
"finding pass", owner review, then one small change per item with its own commit:

1. Empty states for new accounts (main action always rendered) — **highest value**.
2. Double-submit protection (disable-on-submit + server idempotency key).
3. User-facing error mapping (one place turns errors into plain sentences; raw errors to logs only).
4. Press/disabled states — largely done in this pass; audit for any gaps.
5. Keyboard-aware forms (focused field stays above the on-screen keyboard).
6. Skeletons over spinners on remaining unbounded/blank loads.
7. Lost-draft protection (draft-as-you-type for long/free-text forms; clear on submit + logout).
8. Optimistic UI on safe writes only (never on money/availability/permissions).
9. Local cache with a logout-clear (per-user, timestamped) — needs careful testing.
10. Offline write queue with idempotency keys — a full feature; test heavily.

Recommended pre-launch subset (per the guide): 1, 2, 3, plus the press/disabled
and skeleton polish already landed. The rest are high-priority immediately after.
