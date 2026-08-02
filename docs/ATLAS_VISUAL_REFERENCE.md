# Atlas Visual Reference

This document records the visual design extracted from the supplied `Atlas project veiw(3).mp4`. It is a design reference, not a code specification.

## Product character

Atlas should feel calm, premium, operational and hospitality-led. The interface is restrained and editorial rather than playful, highly decorative or conventionally “tech blue”. Information is easy to scan, with generous whitespace and clear hierarchy.

## Palette

- Warm off-white or light ivory application background.
- White content cards and table surfaces.
- Charcoal text and near-black primary controls.
- Muted antique-gold accent used sparingly for selected states, small indicators and the floating action button.
- Soft neutral grey borders and secondary text.
- Sage, amber and red reserved for meaningful status communication rather than broad decoration.
- The Atlas Brain may use one dark charcoal hero surface for emphasis; the rest of the application remains light.

## Typography

- Editorial serif for page titles, major numbers and important section headings.
- Clean neutral sans-serif for navigation, labels, forms, tables and body copy.
- Small uppercase labels use restrained tracking.
- Headings should be elegant and readable, not novelty display typography.
- Numeric data should remain compact, aligned and easy to compare.

## Layout

- Fixed left navigation rail on desktop, approximately one-fifth of the viewport width.
- Compact sticky topbar with page title, search, notifications and Service Mode.
- Main content uses a centered wide canvas with generous 24–32px gutters.
- Cards align to consistent grids with balanced whitespace.
- Dense operational pages use tables; decision and summary pages use cards.
- The bottom-right floating action button is a recurring navigation/action anchor.

## Geometry and elevation

- Moderate corner radii, generally 10–16px.
- Pill geometry is reserved for filters, search, compact chips and status controls.
- Primary action buttons remain compact rather than fully rounded everywhere.
- Thin one-pixel neutral borders define surfaces.
- Shadows are subtle and used only where hierarchy needs reinforcement.
- Avoid heavily inflated 28–32px rounding across all surfaces.

## Navigation

- Light neutral sidebar with a centered Atlas identity block.
- Active navigation is shown by a white rounded rectangle with dark text.
- Secondary navigation is indented and lower contrast.
- Icons are simple outline symbols with consistent stroke weight.
- The user profile remains anchored at the bottom of the sidebar.

## Core components

### Metric cards

- White cards with thin borders and moderate rounding.
- Small neutral icon tile.
- Large serif number.
- Short sans-serif label.

### Tables

- White bordered container.
- Uppercase micro-label headers.
- Airy rows with subtle separators.
- Inline quantity controls and small action icons.
- Filters appear as compact pills above the table.

### Forms and dialogs

- White modal surface over a soft darkened backdrop.
- Clear title and close control.
- Two-column form layouts on desktop, one column on mobile.
- Near-black primary action and quiet secondary action.

### Atlas Brain

- One dark editorial hero for greeting, briefing and service countdown.
- Warm gold details inside the hero.
- Light cards below for evidence, readiness, sources and recommendations.
- The dark treatment should not spread across the whole application.

### Service Mode

- Light operational dashboard with large, simple task cards.
- Near-black exit/control button.
- Minimal decoration and fast scanning.

## Motion

- Small hover lift or border emphasis only.
- Fast transitions, roughly 150–200ms.
- No large parallax, elastic motion or decorative animation in operational workflows.
- Reduced-motion preferences remain supported.

## Responsive behaviour

- Desktop keeps the fixed sidebar and multi-column grids.
- Tablet reduces grid columns and content density.
- Mobile replaces the sidebar with a menu/drawer and stacks cards into one column.
- Tables may hide secondary columns, but primary operational actions remain accessible.

## Design guardrails

- Preserve the original Atlas light-neutral system.
- Do not replace the application with a terracotta/sage theme.
- Do not make every card, input and button a full pill.
- Do not use novelty display fonts across operational screens.
- Do not add broad gradients or heavy shadows to standard content cards.
- Use the video for hierarchy, spacing, density and component behaviour—not as a source of implementation code.
