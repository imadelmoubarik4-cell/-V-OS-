# Phase 4 — Claude Interface Migration

## Decision

The supplied Claude Design project is the visual, navigation and interaction
source of truth for Atlas. The current Phase 2 application remains the data,
security and operational-workflow source of truth.

This is an interface migration, not an application replacement.

## Authority order

1. Current Atlas authentication, `public.profiles`, RLS, grants and Edge Functions.
2. Current L1/L2, Checkpoint K, Checkpoint M and Connection Center contracts.
3. Latest `Atlas.dc.html` visual composition and interaction patterns.
4. Latest Claude handoff decisions.
5. Older screenshots only where they do not conflict with the final design.

The Claude runtime, fixtures, simulated authentication, simulated scanner and
browser-local writes are not production dependencies.

## Phase 4A scope

Phase 4A introduces the shared interface foundation:

- Inter typography and the approved neutral light palette;
- separately designed dark mode;
- teal Atlas focus and active states;
- Claude navigation groups and normalized Lucide icons;
- responsive sidebar and mobile drawer;
- persistent desktop sidebar collapse;
- persistent light/dark preference;
- keyboard command palette with real Atlas navigation actions;
- shared cards, controls, fields, tables, modals, loading and empty states;
- restrained motion and reduced-motion support;
- Service Mode styling aligned with the Claude reference;
- removal of the overlapping global floating action button.

## Navigation contract

### Home

- Home

### Operations

- Inventory
- Recipes
- Purchasing
- Import Center

### Growth

- Marketing

### People

- Messages
- Team
- Shifts
- Knowledge

### Insights

- Atlas Brain
- Business Intelligence
- Reports
- Accounting — explicit unavailable placeholder until real functionality exists

### System

- Settings
- System

Existing buttons and their event handlers are moved into this hierarchy rather
than recreated. Modules that load after the shell are detected and mounted into
the correct group.

## Safety boundary

Phase 4A does not:

- modify a database schema or migration;
- change RLS, grants or role visibility;
- introduce direct browser access to private tables;
- change live stock;
- publish a count;
- create or submit a supplier order;
- publish social content;
- import POS sales;
- enable automatic execution;
- add React, runtime Babel, `eval`, `new Function` or the Claude Design runtime;
- place fixture business data in the production interface.

All existing manager-review and approval-first boundaries remain authoritative.

## Implementation

- `apps/web/assets/js/phase4-shell.js`
- `apps/web/assets/css/phase4-claude.css`
- `apps/web/assets/js/modal.js` — safe bootstrap only
- `tests/node/phase4-claude-shell.test.js`

The interface layer is loaded from the existing modal bundle so the large legacy
`index.html` does not need to be duplicated or replaced.

## Phase 4A acceptance

Phase 4A may close when:

1. the new shell loads after authentication and on the login screen;
2. existing live modules remain navigable;
3. dynamic Phase 1/2 modules appear in the correct menu groups;
4. light and dark themes are both usable;
5. collapse and mobile navigation work;
6. command search is keyboard operable;
7. manager-only and role-redacted controls remain unchanged;
8. no Claude runtime or fixture data is shipped;
9. browser syntax, Node contracts, Python contracts and migration replay pass;
10. the Netlify preview passes desktop, tablet and mobile visual acceptance;
11. production inventory remains unchanged.

## Next implementation units

### Phase 4B — Operations

Home, Inventory, L1 Count, L2 Item Master, scanner, Waste, Recipes,
Purchasing and Service Mode.

### Phase 4C — People and Knowledge

Messages, Team, Profiles, Shifts, Knowledge, Required Reading, Onboarding and
Source Center.

### Phase 4D — Insights and Platform

Brain, Business Intelligence, Reports, Checkpoint M, Marketing, Settings,
Connection Center and System.

### Phase 4E — Authentication and Public Surfaces

Login, invitation completion, password reset, permission-denied states and the
public VÁ menu.

## Production boundary

This record does not authorize merge, production migration or release. The Phase
4 branch remains stacked on the Phase 2 draft until visual, role, CI and release
acceptance are complete.
