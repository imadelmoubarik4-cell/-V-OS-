# Phase 4 — Atlas Interface Implementation Guide

The Claude Design prototype is the visual and interaction specification for
Atlas. The existing application remains the implementation and security base.

## Visual source of truth

Phase 4 follows the final `Atlas.dc.html` and handoff decisions for:

- Inter typography;
- neutral floating surfaces;
- restrained teal focus and active states;
- polished light and dark modes;
- grouped navigation;
- thin 1.8-stroke icons;
- responsive desktop, tablet and mobile composition;
- Service Mode;
- contextual actions, modals, sheets and command search;
- purposeful state animation rather than decorative page entrances.

## Functional source of truth

The current application remains authoritative for:

- production Supabase Auth and `public.profiles`;
- RLS, grants and server-derived audit identity;
- redacted staff and commercial views;
- L1 stock-count evidence and manager publication;
- L2 item-master drafts and publication;
- Checkpoint K evidence gates;
- Checkpoint M POS mapping;
- canonical P2 connection state and health evidence;
- private Storage and Edge Functions;
- approval-first recommendations and external actions.

## Porting rule

Existing DOM nodes and event handlers should be retained and restyled wherever
possible. New interface code must call the existing module APIs rather than
copying business logic or creating parallel state.

## Interaction translation

| Design action | Production behavior |
| --- | --- |
| Add item | Item-master create/complete workflow; quantity is not silently verified |
| Scan barcode | Real scanner observation and alias review |
| Start stock count | Private L1 session by location |
| Submit count | Manager verification queue |
| Publish count | Controlled inventory adjustment with evidence |
| Log waste | Authorized explicit waste event |
| Create order | Manager-reviewed purchase draft |
| Publish marketing | Explicit human approval; no automatic publishing |
| Connection badge | Canonical P2 state with freshness evidence |
| Ask Atlas | Evidence-backed Brain response |
| POS mapping | Deterministic Checkpoint M review and approval |

## Prohibited shortcuts

- no Claude `support.js`, `<x-dc>`, runtime React or Babel;
- no fixture business figures in released screens;
- no direct quantity steppers that bypass approved workflows;
- no duplicated role or connection registries;
- no browser service-role key;
- no automatic publishing, ordering, synchronization or mapping approval;
- no weakening of CSP to permit `unsafe-eval`.

## Delivery order

1. Shared shell and design tokens.
2. Home and release-critical Operations.
3. People and Knowledge.
4. Insights, Marketing, Settings and System.
5. Authentication and public menu.
6. Full responsive, keyboard, role and release acceptance.
