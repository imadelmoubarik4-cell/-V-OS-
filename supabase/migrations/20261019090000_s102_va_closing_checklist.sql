-- S102: Replace the generic closing checklist with the VÁ Bar closing checklist.
--
-- Companion to S101 (opening). The closing checklist is the S88 shared routine
-- template `daily-closing-checklist` (atlas_private.routine_templates) whose steps
-- are rows in atlas_private.routine_template_items. This migration swaps the 9
-- generic items for the 22 VÁ-specific closing steps. Content only — no schema
-- change, no new table.
--
-- History-safe: the daily view (atlas_private.operations_today) filters
-- item.active=true, and routine_item_results FK to template items with ON DELETE
-- CASCADE, so we DEACTIVATE the superseded items (active=false) rather than delete
-- them — past check-offs are kept. The new items carry the short action in `label`
-- and the detail in `description`.
-- Re-runnable: deactivate-not-in-set, then upsert on (template_id,item_key).

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. Deactivate every current closing-checklist item not in the new VÁ set.
update atlas_private.routine_template_items
set active = false, updated_at = pg_catalog.now()
where template_id = (select id from atlas_private.routine_templates where template_key = 'daily-closing-checklist')
  and item_key not like 'va-%';

-- 2. Insert/refresh the 22 VÁ closing steps (action in label, detail in description).
with template as (
  select id from atlas_private.routine_templates where template_key = 'daily-closing-checklist'
)
insert into atlas_private.routine_template_items
  (template_id, item_key, section, label, description, evidence_type, required, active, display_order, metadata)
select template.id, item_key, 'Closing', label, description, 'none', true, true, display_order, '{}'::jsonb
from template cross join (values
  ('va-close-store-perishables', 'Store all perishables downstairs',
    'Store all cakes, purées, juices, fresh produce and other refrigerated prep items in their designated fridges downstairs. Cover or seal everything securely.', 10),
  ('va-close-dehydrated', 'Cover and store the dehydrated garnishes',
    'Cover the dehydrated garnish containers with plastic film and return them to their designated storage.', 20),
  ('va-close-wine', 'Seal and refrigerate open wine and pre-batches',
    'Seal open wines and Prosecco with suitable stoppers and refrigerate them. Store the Espresso Martini pre-batch and other items needing refrigeration downstairs.', 30),
  ('va-close-bottles', 'Wipe the bottles and close the spirits tray',
    'Wipe the bottles and clean the spirits tray. Fit rubber pour-spout covers ("condoms") over all exposed bottle pourers and close the syrup bottles.', 40),
  ('va-close-ice', 'Empty and drain the ice sections',
    'Empty both ice sections. Clean, rinse and leave them drained.', 50),
  ('va-close-tools', 'Wash and put away bar tools and equipment',
    'Wash and put away all bar tools, garnish trays, cutting boards, knives and preparation equipment.', 60),
  ('va-close-glasses', 'Wash and return all glassware',
    'Wash all remaining glasses and return clean, dry glasses to their designated places.', 70),
  ('va-close-coffee-machine', 'Clean the coffee machine',
    'Clean and rinse the coffee machine''s removable parts, clean the machine according to its cleaning procedure, and wipe the steam wand and drip tray.', 80),
  ('va-close-coffee-grinder', 'Clean and shut down the coffee grinder',
    'Clean the coffee grinder and turn it off. Leave the coffee machine in its designated overnight setting.', 90),
  ('va-close-dishwasher', 'Finish and shut down the dishwasher',
    'Complete the final dishwasher cycle. Drain and clean the dishwasher, including its filters, then turn it off according to its closing procedure.', 100),
  ('va-close-menus', 'Wipe and store the menus',
    'Wipe and dry the menus, then collect and store them neatly.', 110),
  ('va-close-surfaces', 'Clean and sanitize the bar surfaces',
    'Clean and sanitize the bar counter, preparation surfaces, sinks and service stations.', 120),
  ('va-close-rubbish', 'Take out rubbish and recycling',
    'Take out all rubbish and recycling. Clean any dirty bins and fit fresh bin liners.', 130),
  ('va-close-pos', 'Run the POS end-of-day and turn off',
    'Complete the POS end-of-day procedure, then turn off the tablet and POS system.', 140),
  ('va-close-tvs', 'Turn off TVs 1, 2 and 3', null::text, 150),
  ('va-close-tap-lights', 'Turn off the draft beer tap lights, including Guinness', null::text, 160),
  ('va-close-coolers', 'Turn off cooler lights and lock the wine cooler',
    'Turn off the lights in the big wine cooler, the small alcoholic-beverages cooler and the soda cooler. Lock the wine cooler. Leave all refrigeration running.', 170),
  ('va-close-lamps', 'Turn off and charge the golden lamps',
    'Turn off the golden lamps. Check their battery levels and put any lamps that need charging on charge.', 180),
  ('va-close-logo-light', 'Turn off the VÁ logo light and illuminated wall', null::text, 190),
  ('va-close-walkthrough', 'Complete the final walkthrough',
    'Confirm that everything is stored, all fridge and cooler doors are fully closed, taps are off, and equipment is in its correct overnight state.', 200),
  ('va-close-floor', 'Sweep and mop the bar floor',
    'As the final cleaning task, sweep and mop the bar floor.', 210),
  ('va-close-lockup', 'Turn off remaining lights, exit and lock up',
    'Turn off the remaining bar lights, exit, and lock the door.', 220)
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
