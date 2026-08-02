# Atlas Organic Design System

This visual layer applies the approved portable system across the current Atlas application without changing its data model, authentication, review workflow or Daily Briefing logic.

## Visual direction

- warm cream application ground;
- terracotta primary accent;
- sage secondary accent;
- Caprasimo display headings;
- Figtree body and interface copy;
- 16-28px rounded surfaces;
- full-pill buttons, search fields, filters and navigation items;
- soft earthy shadows rather than hard black elevation;
- muted photo treatment through the reusable `.washed` class.

## Token contract

The source of truth is `apps/web/assets/css/organic-design-system.css`. It contains:

- base background, surface, text, accent and divider tokens;
- complete neutral, terracotta and sage scales;
- typography, spacing, radius and shadow tokens;
- aliases for the existing `--atlas-*` and legacy inventory variables.

Keeping the aliases means existing modules inherit the new design without rewriting operational JavaScript.

## Portable primitives

New markup should use the shared classes rather than one-off visual declarations:

- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`;
- `.input`;
- `.card`, `.card-kicker`, `.card-title`, `.card-body`;
- `.tag-accent`, `.tag-accent-2`, `.tag-neutral`, `.tag-outline`;
- `.nav`, `.nav-brand`;
- `.table`;
- `.dialog-backdrop`, `.dialog`, `.dialog-title`;
- `.washed` for muted photography.

## Existing Atlas integration

The layer currently covers:

- login and application shell;
- sidebar, navigation, profile and topbar;
- Home and metric cards;
- inventory tables, controls and modals;
- recipe cards and recipe editor;
- Service Mode;
- Atlas Brain hero, metrics and operational cards;
- Daily Atlas Briefing confidence, source and evidence cards;
- Real VÁ Data Review controls, queue, evidence and decisions;
- floating actions and responsive layouts.

## Loading order

`apps/web/config.js` loads Caprasimo, Figtree and the organic stylesheet after the existing Sprint 3 and Sprint 4 styles. This makes the design system an additive, reversible layer and keeps the feature modules independent from visual implementation.

## Guardrails

- No operational data is included in the stylesheet or documentation.
- No Supabase credential or private source row is added.
- Production data behavior is unchanged.
- Focus visibility and reduced-motion handling remain active.
- Desktop, tablet and mobile rules are included.
