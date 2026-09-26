---
title: User Guide
subtitle: Restaurant & Hospitality Operating System
tagline: Everything your team needs to run the venue.
version: Atlas User Guide · Version 0.8 · September 2026
release: Based on Atlas production release 0.8.0 (main 51e4fe8, 26 September 2026)
footer: Atlas User Guide · Version 0.8 · September 2026 · Component showcase
doc-title: Atlas manual component showcase
cover: full
---

::toc{depth=2}

:::chapter{number=1 icon=layout-grid}
# Components at a glance {#components}
Every building block of the Atlas manuals on a few pages, so a change to the theme can be checked in one place.
:::

## Text and inline pieces {#inline .quick}

Body text is IBM Plex Sans at 10.5 pt. **Bold** marks the important word, *italic* adds a light touch, and `code` is for things you type exactly. Links look like [the Atlas website](https://example.com). Name what people press with a UI label such as :ui[Add to order] or :ui[Opening checklist]{icon=clipboard-check}, and where they go with a path: :path[Inventory > Stock count]. Keyboard shortcuts use :kbd[Ctrl K]. Inline icons sit in the text: :icon[sparkles] Atlas AI.

Roles are always written out: :role[admin] :role[manager] :role[bartender] :role[viewer] :role[schedule_only]. Badges: :badge[New]{tone=new} :badge[Live]{tone=live}.

Raw HTML is shown as text, never run: <script>alert(1)</script> & <b>not bold</b>.

### A procedure {roles="admin manager"}

1. Open :path[Inventory] from the side bar.
2. Choose :ui[Stock count].
3. Count each shelf and enter the quantity.
   - Nested bullet under a step.
   - Another one.
4. Press :ui[Finish count].

- A plain bullet list
- With a second item that is long enough to wrap onto a second line so the hanging indent can be checked properly.

> Quote: short, in the display serif, for a line worth pausing on.

## Callouts {#callouts}

:::tip Keep the count moving
Count one area at a time. Atlas keeps what you have entered if you step away.
:::

:::important
Finish a stock count before you close for the night. An unfinished count is not used.
:::

:::admin-only
Only administrators see **Settings**. Managers and bartenders do not.
:::

:::roles{roles="admin manager"}
Managers and administrators can create purchase orders.
:::

:::ai Ask about stock
Atlas AI can answer questions about stock, orders and shifts using the records your role can see.
:::

:::example A quiet Tuesday
Sara opens the opening checklist at 16:00, ticks off the fridge temperatures, and Atlas marks the checklist 4 of 9 done.
:::

:::coming-later Accounting
Accounting is being built and is not part of this release.
:::

:::warning
Deleting a supplier removes it from every open order.
:::

## Workflow {#workflow .quick}

:::workflow Receive a delivery
1. Open the order — Find the purchase order in Purchasing.
2. Check the goods — Compare what arrived with the order lines.
3. Record differences — Note short or damaged items.
4. Receive — Stock updates from what you received.
:::

:::workflow{layout=vertical}
1. Start a count — Choose the area you are counting.
2. Count — Enter each quantity as you go.
3. Review — Check anything that looks unusual.
4. Finish — The count becomes your stock evidence.
:::

## Do and don't {#do-dont}

::::do-dont
:::do
- Count what is on the shelf, not what the system says.
- Finish the count in one session.
:::
:::dont
- Don't copy last week's numbers.
- Don't leave a count open overnight.
:::
::::

## Feature cards {#cards}

:::cards{cols=3}
### Home {icon=house}
What needs you now: attention items, the briefing and tonight's team.

### Atlas AI {icon=sparkles}
Ask questions in plain language and get answers from your venue's records.

### Messages {icon=messages-square}
Talk to your team in conversations, with names and photos.

### Inventory {icon=package roles="admin manager"}
Items, stock levels, par levels and stock counts.

### Recipes {icon=martini}
Specs, costs and what can be served right now.

### Shifts {icon=calendar-days}
Who works when, and who is on tonight.
:::

## Screenshots {#screenshots}

:::figure{src="assets/screenshots/showcase/home-desktop.png" device=desktop caption="Home on a desktop: what needs you now, the briefing and tonight's team."}
- [21%, 3%] **Search or ask Atlas** opens search and Atlas AI.
- [96%, 3%] **Notifications** shows what changed.
- [46%, 21%] **Needs attention** lists what to act on first.
- [30%, 71%] **Today's briefing** summarises the day.
:::

::::figures
:::figure{src="assets/screenshots/showcase/home-phone.png" device=phone caption="Home on a phone."}
- [50%, 94%] The tab bar: Home, Inventory, Atlas, Recipes and More.
:::
:::figure{src="assets/screenshots/showcase/home-phone.png" device=phone caption="The same screen, second frame."}
:::
::::

::figure[A screenshot that has not been captured yet shows a placeholder.]{src="assets/screenshots/not-yet.png" device=desktop width=70%}

## Diagrams {#diagrams}

::diagram[Atlas brings every part of the venue into one shared picture.]{src="assets/diagrams/atlas-ecosystem.svg"}

::diagram[Stock truth: where your numbers come from.]{src="assets/diagrams/stock-truth.svg"}

::diagram[Purchase order lifecycle (placeholder labels).]{src="assets/diagrams/purchase-order-lifecycle.svg"}

:::chapter{number=2 art="assets/brand/atlas-bot.png" art-crop=left icon=sparkles}
# Atlas AI {#atlas-ai}
Ask a question in plain language. Atlas answers from your venue's own records.
:::

## Example questions {#prompts .quick}

:::prompts Try asking
- What is below par tonight? — Checks stock against par levels.
- Who is working on Friday? — Reads the shift plan.
- How many limes did we use last week? — Uses stock counts and deliveries.
- Which suppliers have open orders? — Looks at Purchasing.
:::

## Who can do what {#roles}

:::role-matrix Purchasing permissions
| Task | admin | manager | bartender | viewer |
| --- | --- | --- | --- | --- |
| Create a purchase order | yes | yes | no | no |
| Receive a delivery | yes | yes | yes | no |
| See supplier prices | yes | yes | view | view |
| Edit a supplier | yes | limited (own venue) | no | no |
:::

## Quick reference {#quick-ref}

:::quick-ref Everyday shortcuts
| To do this | Go here |
| --- | --- |
| Search or ask Atlas | :kbd[Ctrl K] or the search bar |
| Start a stock count | :path[Inventory > Stock count] |
| See tonight's team | :path[Home > Tonight] |
:::

A plain table:

| Column | Right aligned | Centre |
| :--- | ---: | :---: |
| Limes | 40 | each |
| Campari | 2 | bottle |

## Glossary {#glossary}

:::glossary
Par level
: The quantity you want on hand before service. Atlas flags items below it.

Stock count
: A count of what is physically on the shelf, recorded by a team member.

Evidence
: A record that supports a stock number, such as a count or an import.
:::
