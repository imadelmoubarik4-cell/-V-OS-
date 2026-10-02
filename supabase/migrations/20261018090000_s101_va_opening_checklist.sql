-- S101: Replace the generic opening checklist with the VÁ Bar opening checklist.
--
-- The opening checklist is the S88 shared routine template `daily-opening-checklist`
-- (atlas_private.routine_templates) whose steps are rows in
-- atlas_private.routine_template_items. This migration swaps the 9 generic items for
-- the 22 VÁ-specific steps. It is content only — no schema change, no new table.
--
-- History-safe: the daily view (atlas_private.operations_today) filters item.active=true,
-- and routine_item_results FK to template items with ON DELETE CASCADE, so we DEACTIVATE
-- the superseded items (active=false) rather than delete them — past check-offs are kept.
-- The new items carry the short action in `label` and the detail in `description`.
-- Re-runnable: deactivate-not-in-set, then upsert on (template_id,item_key).
--
-- NOTE — three product/section names were flagged "(confirm)" by the owner and are kept
-- as visible notes, not guessed: "Policemento" (#12), the "Quest" ice-pan section (#18),
-- and "Sartes" vs Sarti (#21). Update them in a follow-up once confirmed.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. Deactivate every current opening-checklist item not in the new VÁ set.
update atlas_private.routine_template_items
set active = false, updated_at = pg_catalog.now()
where template_id = (select id from atlas_private.routine_templates where template_key = 'daily-opening-checklist')
  and item_key not like 'va-%';

-- 2. Insert/refresh the 22 VÁ opening steps (action in label, detail in description).
with template as (
  select id from atlas_private.routine_templates where template_key = 'daily-opening-checklist'
)
insert into atlas_private.routine_template_items
  (template_id, item_key, section, label, description, evidence_type, required, active, display_order, metadata)
select template.id, item_key, 'Opening', label, description, 'none', true, true, display_order, '{}'::jsonb
from template cross join (values
  ('va-unlock-door', 'Unlock the door', null::text, 10),
  ('va-lights', 'Turn on bar lights, VÁ logo light, illuminated wall and lamps', null::text, 20),
  ('va-tablet-pos', 'Turn on the tablet and POS system', null::text, 30),
  ('va-tvs', 'Turn on TVs 1, 2 and 3', null::text, 40),
  ('va-tap-lights', 'Turn on the draft beer tap lights, including Guinness', null::text, 50),
  ('va-coolers', 'Unlock the wine cooler and turn on cooler lights',
    'Turn on the lights in the big wine cooler, the small alcoholic-beverages cooler and the soda cooler.', 60),
  ('va-dishwasher', 'Turn on the dishwasher', null::text, 70),
  ('va-coffee', 'Check and start the coffee equipment',
    'Confirm the coffee equipment was washed and rinsed. Turn on the grinder, check the machine''s pressure, and confirm both are working properly.', 80),
  ('va-supplies-up', 'Bring up supplies from downstairs',
    'Cakes, produce, juices, purées and all other supplies needed for service.', 90),
  ('va-restock-fridges', 'Restock all fridges for service', null::text, 100),
  ('va-menus', 'Set up the menus',
    'Wipe dirty menus with a damp cloth and dry them. Place one menu per chair, alternating Icelandic and English, 2 cm from the bar''s edge with a gap between menus; set a golden lamp centred in each gap, directly in front of it.', 110),
  ('va-wine-prebatch', 'Set up wine and pre-batches',
    'Open Prosecco, limoncello, "Policemento" (confirm product name) and the Espresso Martini pre-batch.', 120),
  ('va-gloves', 'Wear gloves for herbs, garnishes and juices',
    'Use gloves when handling herbs, foliage, garnishes or juices — including cutting or grating carrots.', 130),
  ('va-juice-check', 'Check juice and purée freshness and date labels',
    'Make sure strawberry, passion fruit, pineapple and pear purées are stocked.', 140),
  ('va-juice-refill', 'Refill juice containers correctly',
    'Discard old leftovers, then thoroughly wash and rinse containers before refilling. Never top up old juice with new juice.', 150),
  ('va-juice-labels', 'Label juices and purées with dates',
    'Label freshly prepared or newly opened juices and purées with the prep/opening date. Keep original date labels on previously opened items.', 160),
  ('va-syrup-station', 'Set up the juice and syrup station',
    'Lime juice, lemon juice, simple syrup, basil syrup and pear syrup. Place the simple syrup in the middle, together with honey syrup and agua fresca.', 170),
  ('va-ice', 'Fill the ice pans',
    'Fill the ice pan and the "Quest" ice-pan section (confirm section name) with ice.', 180),
  ('va-fresh-garnish', 'Prepare fresh garnishes',
    'Wash and pick the mint; wash and cut grapefruit, oranges, lemons and limes.', 190),
  ('va-dehydrated-garnish', 'Check the dehydrated garnishes',
    'Confirm they are in good condition, fully stocked and ready for service.', 200),
  ('va-spirits-tray', 'Restock the first spirits tray',
    'Arrange left to right: Vodka, White rum, Gin, Tequila, Bourbon, Amaretto, Aperol, "Sartes" (confirm whether separate from Sarti), Sarti, St-Germain elderflower liqueur, Campari, Strawberry liqueur, Malibu, Strawberry syrup, Coconut syrup.', 210),
  ('va-glasses', 'Restock the glasses for service', null::text, 220)
) as items(item_key, label, description, display_order)
on conflict (template_id, item_key) do update
  set section = excluded.section,
      label = excluded.label,
      description = excluded.description,
      evidence_type = excluded.evidence_type,
      required = excluded.required,
      active = true,
      display_order = excluded.display_order,
      updated_at = pg_catalog.now();

notify pgrst, 'reload schema';
