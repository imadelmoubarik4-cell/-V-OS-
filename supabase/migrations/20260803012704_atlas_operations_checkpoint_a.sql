-- Atlas Operations Checkpoint A
-- Weekly routines, daily temperature logs and connection-readiness boundaries.
-- Public-safe schema and default templates only; contains no private operational history.

create table if not exists atlas_private.routine_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  name text not null,
  description text,
  routine_type text not null check (routine_type in ('inventory','deep_cleaning','storage','temperature','other')),
  recurrence text not null check (recurrence in ('daily','weekly')),
  days_of_week smallint[] not null default '{}',
  available_from time,
  due_time time,
  assigned_role text check (assigned_role is null or assigned_role in ('admin','manager','bartender','viewer','any_active_staff')),
  requires_manager_signoff boolean not null default false,
  allow_photo_evidence boolean not null default false,
  active boolean not null default true,
  display_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.routine_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references atlas_private.routine_templates(id) on delete cascade,
  item_key text not null,
  section text,
  label text not null,
  description text,
  evidence_type text not null default 'none'
    check (evidence_type in ('none','note','photo','stock_count','temperature','maintenance')),
  required boolean not null default true,
  active boolean not null default true,
  display_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id,item_key)
);

create table if not exists atlas_private.routine_instances (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references atlas_private.routine_templates(id) on delete cascade,
  scheduled_date date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','in_progress','completed','overdue','skipped')),
  assigned_to uuid,
  assigned_to_label text,
  started_at timestamptz,
  started_by uuid,
  started_by_label text,
  completed_at timestamptz,
  completed_by uuid,
  completed_by_label text,
  completion_notes text,
  manager_signed_off_at timestamptz,
  manager_signed_off_by uuid,
  manager_signed_off_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id,scheduled_date)
);

create table if not exists atlas_private.routine_item_results (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references atlas_private.routine_instances(id) on delete cascade,
  template_item_id uuid not null references atlas_private.routine_template_items(id) on delete cascade,
  completed boolean not null default false,
  note text,
  evidence jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  completed_by uuid,
  completed_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instance_id,template_item_id)
);

create table if not exists atlas_private.temperature_points (
  id uuid primary key default gen_random_uuid(),
  point_key text not null unique,
  name text not null,
  location text,
  equipment_type text not null default 'refrigerator'
    check (equipment_type in ('refrigerator','freezer','wine_cooler','cooler_table','other')),
  min_temp_c numeric,
  max_temp_c numeric,
  active boolean not null default true,
  display_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_temp_c is null or max_temp_c is null or min_temp_c <= max_temp_c)
);

create table if not exists atlas_private.temperature_logs (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references atlas_private.temperature_points(id) on delete cascade,
  reading_date date not null,
  reading_at timestamptz not null default now(),
  temperature_c numeric not null check (temperature_c between -60 and 120),
  range_status text not null
    check (range_status in ('within_range','outside_range','range_unconfigured')),
  corrective_action text,
  note text,
  logged_by uuid,
  logged_by_label text,
  source text not null default 'manual' check (source in ('manual','sensor','import')),
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.operations_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  actor_id uuid,
  actor_label text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.integration_connections (
  provider_key text primary key,
  label text not null,
  category text not null check (category in ('social','reputation','business_profile','other')),
  status text not null default 'not_connected'
    check (status in ('not_connected','authorization_required','pending_review','connected','degraded','expired','not_applicable')),
  capabilities jsonb not null default '{}'::jsonb,
  requirements jsonb not null default '{}'::jsonb,
  external_account_id text,
  external_account_label text,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists routine_templates_schedule_idx
  on atlas_private.routine_templates(active,display_order);
create index if not exists routine_template_items_order_idx
  on atlas_private.routine_template_items(template_id,active,display_order);
create index if not exists routine_instances_date_status_idx
  on atlas_private.routine_instances(scheduled_date,status,template_id);
create index if not exists routine_item_results_instance_idx
  on atlas_private.routine_item_results(instance_id,completed,template_item_id);
create index if not exists temperature_logs_date_point_idx
  on atlas_private.temperature_logs(reading_date,point_id,reading_at desc);
create index if not exists temperature_logs_point_time_idx
  on atlas_private.temperature_logs(point_id,reading_at desc);
create index if not exists operations_events_entity_idx
  on atlas_private.operations_events(entity_type,entity_id,created_at desc);

alter table atlas_private.routine_templates enable row level security;
alter table atlas_private.routine_template_items enable row level security;
alter table atlas_private.routine_instances enable row level security;
alter table atlas_private.routine_item_results enable row level security;
alter table atlas_private.temperature_points enable row level security;
alter table atlas_private.temperature_logs enable row level security;
alter table atlas_private.operations_events enable row level security;
alter table atlas_private.integration_connections enable row level security;

drop policy if exists "service role manages routine templates" on atlas_private.routine_templates;
create policy "service role manages routine templates" on atlas_private.routine_templates
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages routine template items" on atlas_private.routine_template_items;
create policy "service role manages routine template items" on atlas_private.routine_template_items
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages routine instances" on atlas_private.routine_instances;
create policy "service role manages routine instances" on atlas_private.routine_instances
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages routine item results" on atlas_private.routine_item_results;
create policy "service role manages routine item results" on atlas_private.routine_item_results
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages temperature points" on atlas_private.temperature_points;
create policy "service role manages temperature points" on atlas_private.temperature_points
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages temperature logs" on atlas_private.temperature_logs;
create policy "service role manages temperature logs" on atlas_private.temperature_logs
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages operations events" on atlas_private.operations_events;
create policy "service role manages operations events" on atlas_private.operations_events
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages integration connections" on atlas_private.integration_connections;
create policy "service role manages integration connections" on atlas_private.integration_connections
  for all to service_role using (true) with check (true);

revoke all on atlas_private.routine_templates from public,anon,authenticated;
revoke all on atlas_private.routine_template_items from public,anon,authenticated;
revoke all on atlas_private.routine_instances from public,anon,authenticated;
revoke all on atlas_private.routine_item_results from public,anon,authenticated;
revoke all on atlas_private.temperature_points from public,anon,authenticated;
revoke all on atlas_private.temperature_logs from public,anon,authenticated;
revoke all on atlas_private.operations_events from public,anon,authenticated;
revoke all on atlas_private.integration_connections from public,anon,authenticated;
grant all on atlas_private.routine_templates to service_role;
grant all on atlas_private.routine_template_items to service_role;
grant all on atlas_private.routine_instances to service_role;
grant all on atlas_private.routine_item_results to service_role;
grant all on atlas_private.temperature_points to service_role;
grant all on atlas_private.temperature_logs to service_role;
grant select,insert on atlas_private.operations_events to service_role;
grant all on atlas_private.integration_connections to service_role;

drop trigger if exists routine_templates_touch on atlas_private.routine_templates;
create trigger routine_templates_touch before update on atlas_private.routine_templates
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists routine_template_items_touch on atlas_private.routine_template_items;
create trigger routine_template_items_touch before update on atlas_private.routine_template_items
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists routine_instances_touch on atlas_private.routine_instances;
create trigger routine_instances_touch before update on atlas_private.routine_instances
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists routine_item_results_touch on atlas_private.routine_item_results;
create trigger routine_item_results_touch before update on atlas_private.routine_item_results
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists temperature_points_touch on atlas_private.temperature_points;
create trigger temperature_points_touch before update on atlas_private.temperature_points
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists integration_connections_touch on atlas_private.integration_connections;
create trigger integration_connections_touch before update on atlas_private.integration_connections
  for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.routine_templates (
  template_key,name,description,routine_type,recurrence,days_of_week,
  available_from,due_time,assigned_role,requires_manager_signoff,
  allow_photo_evidence,active,display_order,metadata
) values
  ('daily-temperature-log','Daily temperature log','Record every active refrigeration point once each day. Additional readings may be added whenever needed.','temperature','daily',array[0,1,2,3,4,5,6]::smallint[],'11:00','12:30','any_active_staff',false,false,true,5,'{"auto_complete_when_all_points_logged":true,"target_ranges_require_manager_confirmation":true}'::jsonb),
  ('sunday-inventory-reminder','Sunday inventory reminder','Complete the weekly inventory count and review below-par or unexplained differences.','inventory','weekly',array[0]::smallint[],'11:30','18:00','manager',true,false,true,10,'{"action_target":"inventory","alert_label":"Inventory count due today"}'::jsonb),
  ('monday-deep-cleaning','Monday deep cleaning','Complete the full bar and equipment deep-cleaning checklist and report maintenance issues.','deep_cleaning','weekly',array[1]::smallint[],'11:00','17:00','any_active_staff',true,true,true,20,'{"alert_label":"Deep cleaning due today","photo_evidence_optional":true}'::jsonb),
  ('tuesday-storage-cleaning','Tuesday storage cleaning and organisation','Clean, organise and inspect every active storage zone using FIFO/FEFO principles.','storage','weekly',array[2]::smallint[],'11:00','17:00','any_active_staff',true,true,true,30,'{"alert_label":"Storage cleaning due today","photo_evidence_optional":true}'::jsonb)
on conflict (template_key) do update set
  name=excluded.name,
  description=excluded.description,
  routine_type=excluded.routine_type,
  recurrence=excluded.recurrence,
  days_of_week=excluded.days_of_week,
  available_from=excluded.available_from,
  due_time=excluded.due_time,
  assigned_role=excluded.assigned_role,
  requires_manager_signoff=excluded.requires_manager_signoff,
  allow_photo_evidence=excluded.allow_photo_evidence,
  display_order=excluded.display_order,
  metadata=excluded.metadata,
  updated_at=now();

with template as (select id from atlas_private.routine_templates where template_key='sunday-inventory-reminder')
insert into atlas_private.routine_template_items (template_id,item_key,section,label,description,evidence_type,required,display_order,metadata)
select template.id, item_key, section, label, description, evidence_type, required, display_order, metadata
from template cross join (values
  ('count-back-bar','Stock count','Count back-bar spirits and liqueurs','Record open and sealed bottle quantities.','stock_count',true,10,'{"target":"inventory"}'::jsonb),
  ('count-wine','Stock count','Count wine, sparkling and fortified wine','Include open bottles and note any quality concern.','stock_count',true,20,'{"target":"inventory"}'::jsonb),
  ('count-beer','Stock count','Count beer bottles, cans and kegs','Record keg quantity or best available remaining-volume estimate.','stock_count',true,30,'{"target":"inventory"}'::jsonb),
  ('count-mixers','Stock count','Count mixers, juices, syrups, purées and non-alcoholic products','Include opened prep bottles and backup stock.','stock_count',true,40,'{"target":"inventory"}'::jsonb),
  ('count-coffee-food','Stock count','Count coffee, garnish, food, tapas and service consumables','Include perishables and items approaching expiry.','stock_count',true,50,'{"target":"inventory"}'::jsonb),
  ('count-cleaning','Stock count','Count cleaning supplies, paper goods and packaging','Flag any critical supply below the operating minimum.','stock_count',true,60,'{"target":"inventory"}'::jsonb),
  ('review-variance','Review','Review unusual differences and record an explanation','Do not silently correct a material variance.','note',true,70,'{}'::jsonb),
  ('review-below-par','Review','Review below-par items and purchasing needs','Open the purchasing workflow for anything that requires action.','note',true,80,'{"target":"operations-orders"}'::jsonb)
) as items(item_key,section,label,description,evidence_type,required,display_order,metadata)
on conflict (template_id,item_key) do update set
  section=excluded.section,label=excluded.label,description=excluded.description,
  evidence_type=excluded.evidence_type,required=excluded.required,display_order=excluded.display_order,
  metadata=excluded.metadata,active=true,updated_at=now();

with template as (select id from atlas_private.routine_templates where template_key='monday-deep-cleaning')
insert into atlas_private.routine_template_items (template_id,item_key,section,label,description,evidence_type,required,display_order,metadata)
select template.id, item_key, section, label, description, evidence_type, required, display_order, metadata
from template cross join (values
  ('clear-stations','Bar stations','Remove mats, trays and loose equipment from both bar stations','Keep clean and dirty equipment separated during the task.','none',true,10,'{}'::jsonb),
  ('wash-stations','Bar stations','Wash and sanitise bar tops, speed rails, bottle wells and drip trays','Remove syrup, citrus and sticky residue before sanitising.','none',true,20,'{}'::jsonb),
  ('clean-sinks','Bar stations','Clean sinks, taps, rinser areas, drain baskets and visible drains','Report slow drainage, leaks or damaged fittings.','maintenance',true,30,'{}'::jsonb),
  ('clean-glasswasher','Equipment','Clean the glasswasher filter, spray arms, seals and interior','Follow the manufacturer cleaning instructions and never mix cleaning chemicals.','maintenance',true,40,'{}'::jsonb),
  ('clean-ice-area','Equipment','Clean the ice scoop and holder; wipe the ice-machine exterior, vents and surrounding area','Do not disassemble the machine. Record internal sanitation or maintenance that is due.','maintenance',true,50,'{}'::jsonb),
  ('clean-cooler-table','Cold storage','Empty and clean the large cooler table','Clean shelves, seals, handles and spills; return products organised.','none',true,60,'{}'::jsonb),
  ('clean-wine-coolers','Cold storage','Clean the large and small wine coolers','Clean shelves, seals, handles, interior spills and exterior glass.','none',true,70,'{}'::jsonb),
  ('clean-soda-coolers','Cold storage','Clean both soda coolers','Clean shelves, seals, handles and interior spills.','none',true,80,'{}'::jsonb),
  ('clean-storage-coolers','Cold storage','Clean both storage coolers','Clean shelves, seals, handles and interior spills.','none',true,90,'{}'::jsonb),
  ('coffee-station','Coffee station','Deep-clean the coffee machine exterior, drip tray, steam wands and surrounding counter','Clean grinder hoppers and follow manufacturer instructions for internal cleaning.','maintenance',true,100,'{}'::jsonb),
  ('small-equipment','Equipment','Clean blender jugs, blender base, small appliances and charging areas','Inspect cables and plugs for damage.','maintenance',true,110,'{}'::jsonb),
  ('tools-containers','Bar tools','Wash and sanitise bar tools, garnish containers, pourers and reusable prep bottles','Allow items to air dry before storage.','none',true,120,'{}'::jsonb),
  ('wipe-bottles','Shelves and bottles','Wipe bottles and remove sticky residue; face labels forward','Separate damaged or leaking bottles for manager review.','none',true,130,'{}'::jsonb),
  ('display-surfaces','Guest and display areas','Dust and wipe shelves, display surfaces, screens and the illuminated wall','Use suitable products for screens and electrical surfaces.','none',true,140,'{}'::jsonb),
  ('under-counter','Hidden areas','Clean under counters, around cables and in hard-to-reach corners','Report water, mould, pest evidence or damaged surfaces.','maintenance',true,150,'{}'::jsonb),
  ('wash-bins','Waste areas','Empty, wash and sanitise waste and recycling bins and lids','Replace liners only after surfaces are dry.','none',true,160,'{}'::jsonb),
  ('floors-drains','Floors','Scrub floors, skirting, corners and accessible drains behind and under equipment','Keep guest and staff walkways safe while floors are wet.','none',true,170,'{}'::jsonb),
  ('high-touch','High-touch surfaces','Clean doors, handles, switches, payment terminals and other high-touch points','Use electronics-safe cleaning where required.','none',true,180,'{}'::jsonb),
  ('maintenance-inspection','Final inspection','Inspect for leaks, pests, damaged seals, broken glass and maintenance issues','Record every issue requiring follow-up.','maintenance',true,190,'{}'::jsonb),
  ('restock-cleaning','Final reset','Refill soap, sanitiser, paper, cleaning chemicals and protective supplies','Flag any cleaning supply below the required level.','none',true,200,'{}'::jsonb),
  ('temperature-after-clean','Final reset','Record temperatures after refrigerated equipment returns to stable operation','Use the Daily Temperature Log and add corrective action for any out-of-range reading.','temperature',true,210,'{"target":"temperature-log"}'::jsonb),
  ('final-reset','Final reset','Return equipment safely, clear exits and complete the final sign-off','Optional before/after photo evidence may be attached later.','photo',true,220,'{}'::jsonb)
) as items(item_key,section,label,description,evidence_type,required,display_order,metadata)
on conflict (template_id,item_key) do update set
  section=excluded.section,label=excluded.label,description=excluded.description,
  evidence_type=excluded.evidence_type,required=excluded.required,display_order=excluded.display_order,
  metadata=excluded.metadata,active=true,updated_at=now();

with template as (select id from atlas_private.routine_templates where template_key='tuesday-storage-cleaning')
insert into atlas_private.routine_template_items (template_id,item_key,section,label,description,evidence_type,required,display_order,metadata)
select template.id, item_key, section, label, description, evidence_type, required, display_order, metadata
from template cross join (values
  ('clear-access','Safety','Clear walkways, doors, exits and access to safety equipment','Nothing may block an exit, extinguisher or electrical panel.','none',true,10,'{}'::jsonb),
  ('separate-chemicals','Safety','Keep cleaning chemicals separated from food, drink and service items','Check labels, lids and secondary containers.','none',true,20,'{}'::jsonb),
  ('clean-shelves','Cleaning','Remove stock section by section and clean shelving','Dry shelves before returning products.','none',true,30,'{}'::jsonb),
  ('clean-floor','Cleaning','Sweep and wash storage floors, corners and skirting','Report leaks, pest evidence or damaged surfaces.','maintenance',true,40,'{}'::jsonb),
  ('fifo-fefo','Organisation','Rotate stock using FIFO/FEFO and move shortest-dated items forward','Record products approaching expiry.','note',true,50,'{}'::jsonb),
  ('category-zones','Organisation','Group products by category and keep labels visible','Use stable zones for spirits, wine, beer, mixers, coffee, food and consumables.','none',true,60,'{}'::jsonb),
  ('open-cases','Organisation','Consolidate open cases and remove empty or damaged packaging','Keep supplier and product labels where identification is needed.','none',true,70,'{}'::jsonb),
  ('keg-area','Beer and kegs','Clean and organise the keg area','Keep full, connected and empty kegs clearly separated.','none',true,80,'{}'::jsonb),
  ('glassware-zone','Glassware','Clean and organise stored glassware','Remove chipped or damaged glassware from service.','note',true,90,'{}'::jsonb),
  ('cooler-organisation','Cold storage','Organise storage coolers and maintain airflow around products','Do not overfill vents or place products directly against cooling outlets.','none',true,100,'{}'::jsonb),
  ('expiry-damage','Inspection','Check expiry dates, damaged packaging, leaks and quality concerns','Move anything uncertain to a clearly marked manager-review area.','note',true,110,'{}'::jsonb),
  ('location-labels','Organisation','Confirm shelf and bin-location labels are accurate','Update Atlas location details where the physical location changed.','note',true,120,'{}'::jsonb),
  ('low-stock-notes','Review','Record low stock, missing items and unexpected differences','Open purchasing or inventory review where needed.','note',true,130,'{"target":"inventory"}'::jsonb),
  ('final-storage-signoff','Final reset','Photograph or note the final organisation and complete sign-off','Photo evidence is optional; notes are required for unresolved issues.','photo',true,140,'{}'::jsonb)
) as items(item_key,section,label,description,evidence_type,required,display_order,metadata)
on conflict (template_id,item_key) do update set
  section=excluded.section,label=excluded.label,description=excluded.description,
  evidence_type=excluded.evidence_type,required=excluded.required,display_order=excluded.display_order,
  metadata=excluded.metadata,active=true,updated_at=now();

insert into atlas_private.temperature_points (
  point_key,name,location,equipment_type,min_temp_c,max_temp_c,active,display_order,metadata
) values
  ('large-wine-cooler','Large wine cooler','Bar / wine storage','wine_cooler',null,null,true,10,'{"range_status":"manager_configuration_required","source":"known_va_equipment"}'::jsonb),
  ('small-wine-cooler','Small wine cooler','Bar / wine storage','wine_cooler',null,null,true,20,'{"range_status":"manager_configuration_required","source":"known_va_equipment"}'::jsonb),
  ('large-cooler-table','Large cooler table','Main bar','cooler_table',null,null,true,30,'{"range_status":"manager_configuration_required","source":"known_va_equipment"}'::jsonb),
  ('soda-cooler-1','Soda cooler 1','Main bar','refrigerator',null,null,true,40,'{"range_status":"manager_configuration_required","source":"supplier_provided_equipment"}'::jsonb),
  ('soda-cooler-2','Soda cooler 2','Main bar','refrigerator',null,null,true,50,'{"range_status":"manager_configuration_required","source":"supplier_provided_equipment"}'::jsonb),
  ('storage-cooler-1','Storage cooler 1','Back storage','refrigerator',null,null,true,60,'{"range_status":"manager_configuration_required","source":"supplier_provided_equipment"}'::jsonb),
  ('storage-cooler-2','Storage cooler 2','Back storage','refrigerator',null,null,true,70,'{"range_status":"manager_configuration_required","source":"supplier_provided_equipment"}'::jsonb)
on conflict (point_key) do update set
  name=excluded.name,location=excluded.location,equipment_type=excluded.equipment_type,
  display_order=excluded.display_order,metadata=excluded.metadata,updated_at=now();

insert into atlas_private.integration_connections (
  provider_key,label,category,status,capabilities,requirements,metadata
) values
  ('instagram','Instagram','social','not_connected','{"content_planning":"available","draft_generation":"shadow","publishing":"requires_oauth_and_platform_permissions","insights":"requires_oauth_and_permissions"}'::jsonb,'{"business_or_creator_account":true,"meta_app":true,"oauth":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('facebook','Facebook','social','not_connected','{"content_planning":"available","draft_generation":"shadow","publishing":"requires_oauth_and_page_permissions","insights":"requires_oauth_and_permissions"}'::jsonb,'{"facebook_page":true,"meta_app":true,"oauth":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('tiktok','TikTok','social','not_connected','{"content_planning":"available","draft_generation":"shadow","publishing":"requires_platform_approval_and_oauth","analytics":"requires_platform_permissions"}'::jsonb,'{"developer_app":true,"oauth":true,"approved_scopes":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('google-business-profile','Google Business Profile','business_profile','not_connected','{"content_planning":"available","posts":"requires_oauth_and_account_access","reviews_read":"requires_oauth_and_account_access","review_response":"requires_oauth_and_account_access","metrics":"requires_supported_api_access"}'::jsonb,'{"verified_business_profile":true,"google_cloud_project":true,"oauth":true}'::jsonb,'{"credentials_stored_outside_table":true}'::jsonb),
  ('tripadvisor','Tripadvisor','reputation','not_connected','{"content_read":"available_via_terra_or_content_api_subject_to_plan","reviews_read":"subject_to_api_access_and_terms","response_drafting":"shadow","response_submission":"manual_management_center_until_supported_write_api_is_verified","social_post_publishing":"not_applicable"}'::jsonb,'{"claimed_listing":true,"management_center_access":true,"api_key_and_billing_for_content_api":true}'::jsonb,'{"credentials_stored_outside_table":true,"review_responses_must_follow_tripadvisor_guidelines":true,"no_incentivized_reviews":true,"no_review_gating":true}'::jsonb)
on conflict (provider_key) do update set
  label=excluded.label,category=excluded.category,capabilities=excluded.capabilities,
  requirements=excluded.requirements,metadata=excluded.metadata,updated_at=now();

create or replace function atlas_private.ensure_routine_instances(p_local_date date)
returns bigint
language plpgsql
security invoker
set search_path=''
as $$
declare inserted_count bigint;
begin
  insert into atlas_private.routine_instances (template_id,scheduled_date,status)
  select template.id,p_local_date,'scheduled'
  from atlas_private.routine_templates template
  where template.active=true
    and extract(dow from p_local_date)::smallint = any(template.days_of_week)
  on conflict (template_id,scheduled_date) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function atlas_private.operations_today(p_local_date date)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  local_now timestamp := pg_catalog.now() at time zone 'Atlantic/Reykjavik';
  routines_json jsonb := '[]'::jsonb;
  points_json jsonb := '[]'::jsonb;
  temperature_summary jsonb := '{}'::jsonb;
  alerts_json jsonb := '[]'::jsonb;
  connections_json jsonb := '[]'::jsonb;
begin
  perform atlas_private.ensure_routine_instances(p_local_date);

  update atlas_private.routine_instances instance
  set status='overdue'
  from atlas_private.routine_templates template
  where instance.template_id=template.id
    and instance.scheduled_date=p_local_date
    and instance.status in ('scheduled','in_progress')
    and template.due_time is not null
    and p_local_date = local_now::date
    and local_now::time > template.due_time;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',instance.id,'template_id',template.id,'template_key',template.template_key,
    'name',template.name,'description',template.description,'routine_type',template.routine_type,
    'available_from',template.available_from,'due_time',template.due_time,
    'assigned_role',template.assigned_role,'requires_manager_signoff',template.requires_manager_signoff,
    'allow_photo_evidence',template.allow_photo_evidence,'status',instance.status,
    'scheduled_date',instance.scheduled_date,'started_at',instance.started_at,
    'completed_at',instance.completed_at,'completed_by_label',instance.completed_by_label,
    'completion_notes',instance.completion_notes,
    'progress',jsonb_build_object(
      'required',coalesce(counts.required_count,0),'completed',coalesce(counts.completed_count,0),
      'percent',case when coalesce(counts.required_count,0)=0 then
        case when template.routine_type='temperature' then 0 else 100 end
        else round((counts.completed_count::numeric/counts.required_count::numeric)*100) end),
    'items',coalesce(items.items,'[]'::jsonb),'metadata',template.metadata
  ) order by template.display_order,template.name),'[]'::jsonb)
  into routines_json
  from atlas_private.routine_instances instance
  join atlas_private.routine_templates template on template.id=instance.template_id
  left join lateral (
    select count(*) filter (where item.required and item.active)::bigint as required_count,
      count(*) filter (where item.required and item.active and coalesce(result.completed,false))::bigint as completed_count
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance.id
    where item.template_id=template.id
  ) counts on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'id',item.id,'item_key',item.item_key,'section',item.section,'label',item.label,
      'description',item.description,'evidence_type',item.evidence_type,'required',item.required,
      'completed',coalesce(result.completed,false),'note',result.note,
      'evidence',coalesce(result.evidence,'{}'::jsonb),'completed_at',result.completed_at,
      'completed_by_label',result.completed_by_label,'metadata',item.metadata
    ) order by item.display_order,item.label) as items
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance.id
    where item.template_id=template.id and item.active=true
  ) items on true
  where instance.scheduled_date=p_local_date;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',point.id,'point_key',point.point_key,'name',point.name,'location',point.location,
    'equipment_type',point.equipment_type,'min_temp_c',point.min_temp_c,'max_temp_c',point.max_temp_c,
    'range_configured',(point.min_temp_c is not null or point.max_temp_c is not null),
    'logged_today',(latest.id is not null),
    'latest_log',case when latest.id is null then null else jsonb_build_object(
      'id',latest.id,'temperature_c',latest.temperature_c,'range_status',latest.range_status,
      'corrective_action',latest.corrective_action,'note',latest.note,
      'reading_at',latest.reading_at,'logged_by_label',latest.logged_by_label) end,
    'metadata',point.metadata
  ) order by point.display_order,point.name),'[]'::jsonb)
  into points_json
  from atlas_private.temperature_points point
  left join lateral (
    select log.* from atlas_private.temperature_logs log
    where log.point_id=point.id and log.reading_date=p_local_date
    order by log.reading_at desc limit 1
  ) latest on true
  where point.active=true;

  select jsonb_build_object(
    'required_points',count(*)::bigint,
    'logged_points',count(*) filter (where latest.id is not null)::bigint,
    'outstanding_points',count(*) filter (where latest.id is null)::bigint,
    'outside_range_points',count(*) filter (where latest.range_status='outside_range')::bigint,
    'range_unconfigured_points',count(*) filter (where point.min_temp_c is null and point.max_temp_c is null)::bigint,
    'complete',(count(*)>0 and count(*) filter (where latest.id is not null)=count(*))
  ) into temperature_summary
  from atlas_private.temperature_points point
  left join lateral (
    select log.* from atlas_private.temperature_logs log
    where log.point_id=point.id and log.reading_date=p_local_date
    order by log.reading_at desc limit 1
  ) latest on true
  where point.active=true;

  select coalesce(jsonb_agg(alert order by priority,sort_name),'[]'::jsonb)
  into alerts_json
  from (
    select case when instance.status='overdue' then 1 else 10 end as priority,
      template.name as sort_name,
      jsonb_build_object(
        'key','routine:'||instance.id::text,'kind','routine',
        'severity',case when instance.status='overdue' then 'high' else 'medium' end,
        'title',coalesce(template.metadata->>'alert_label',template.name),
        'detail',case when instance.status='overdue' then 'This routine is overdue.' else 'This routine is scheduled for today.' end,
        'routine_id',instance.id,'status',instance.status,'due_time',template.due_time,'target','routines') as alert
    from atlas_private.routine_instances instance
    join atlas_private.routine_templates template on template.id=instance.template_id
    where instance.scheduled_date=p_local_date and template.routine_type<>'temperature'
      and instance.status not in ('completed','skipped')
    union all
    select 5,'Daily temperature log',jsonb_build_object(
      'key','temperature:'||p_local_date::text,'kind','temperature',
      'severity',case when (temperature_summary->>'outside_range_points')::bigint>0 then 'high' else 'medium' end,
      'title','Daily temperature log',
      'detail',format('%s of %s active points logged.',temperature_summary->>'logged_points',temperature_summary->>'required_points'),
      'status',case when (temperature_summary->>'complete')::boolean then 'completed' else 'due' end,
      'target','temperature-log')
    where not (temperature_summary->>'complete')::boolean
       or (temperature_summary->>'outside_range_points')::bigint>0
  ) alerts;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',provider_key,'label',label,'category',category,'status',status,
    'capabilities',capabilities,'requirements',requirements,
    'external_account_label',external_account_label,'last_verified_at',last_verified_at,'metadata',metadata
  ) order by category,label),'[]'::jsonb)
  into connections_json
  from atlas_private.integration_connections;

  return jsonb_build_object(
    'version','atlas-operations-checkpoint-a/0.1.0','venue_date',p_local_date,
    'generated_at',pg_catalog.now(),'routines',routines_json,
    'temperature',jsonb_build_object('summary',temperature_summary,'points',points_json),
    'alerts',alerts_json,'connections',connections_json,
    'trust',jsonb_build_object('private_branch',true,'manager_review_for_settings',true,
      'quantity_mutation',false,'temperature_logs_audited',true,'routine_history_preserved',true));
end;
$$;

create or replace function atlas_private.set_routine_item(
  p_instance_id uuid,p_template_item_id uuid,p_completed boolean,p_note text,p_evidence jsonb,
  p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_item_row atlas_private.routine_template_items;
begin
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  if instance_row.status in ('completed','skipped') then raise exception 'Completed or skipped routines cannot be edited'; end if;
  select * into template_item_row from atlas_private.routine_template_items
  where id=p_template_item_id and template_id=instance_row.template_id and active=true;
  if not found then raise exception 'Routine checklist item not found'; end if;

  insert into atlas_private.routine_item_results (
    instance_id,template_item_id,completed,note,evidence,completed_at,completed_by,completed_by_label
  ) values (
    p_instance_id,p_template_item_id,p_completed,nullif(trim(coalesce(p_note,'')),''),coalesce(p_evidence,'{}'::jsonb),
    case when p_completed then pg_catalog.now() else null end,
    case when p_completed then p_actor_id else null end,
    case when p_completed then p_actor_label else null end)
  on conflict (instance_id,template_item_id) do update set
    completed=excluded.completed,note=excluded.note,evidence=excluded.evidence,
    completed_at=excluded.completed_at,completed_by=excluded.completed_by,
    completed_by_label=excluded.completed_by_label,updated_at=pg_catalog.now();

  update atlas_private.routine_instances
  set status=case when status='scheduled' and p_completed then 'in_progress' else status end,
      started_at=case when started_at is null and p_completed then pg_catalog.now() else started_at end,
      started_by=case when started_at is null and p_completed then p_actor_id else started_by end,
      started_by_label=case when started_at is null and p_completed then p_actor_label else started_by_label end
  where id=p_instance_id;

  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_item_updated','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object('template_item_id',p_template_item_id,'completed',p_completed,'note',p_note));
  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

create or replace function atlas_private.complete_routine(
  p_instance_id uuid,p_notes text,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_row atlas_private.routine_templates;
  incomplete_count bigint;
  missing_temperatures bigint;
begin
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  select * into template_row from atlas_private.routine_templates where id=instance_row.template_id;
  if template_row.routine_type='temperature' then
    select count(*) into missing_temperatures
    from atlas_private.temperature_points point
    where point.active=true and not exists (
      select 1 from atlas_private.temperature_logs log
      where log.point_id=point.id and log.reading_date=instance_row.scheduled_date);
    if missing_temperatures>0 then raise exception '% temperature points still need a reading',missing_temperatures; end if;
  else
    select count(*) into incomplete_count
    from atlas_private.routine_template_items item
    where item.template_id=instance_row.template_id and item.active=true and item.required=true
      and not exists (
        select 1 from atlas_private.routine_item_results result
        where result.instance_id=instance_row.id and result.template_item_id=item.id and result.completed=true);
    if incomplete_count>0 then raise exception '% required checklist items are incomplete',incomplete_count; end if;
  end if;
  update atlas_private.routine_instances
  set status='completed',completed_at=pg_catalog.now(),completed_by=p_actor_id,
      completed_by_label=p_actor_label,completion_notes=nullif(trim(coalesce(p_notes,'')),'')
  where id=p_instance_id;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_completed','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object('notes',p_notes,'template_key',template_row.template_key));
  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

create or replace function atlas_private.skip_routine(
  p_instance_id uuid,p_reason text,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare instance_row atlas_private.routine_instances;
begin
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A skip reason is required'; end if;
  select * into instance_row from atlas_private.routine_instances where id=p_instance_id for update;
  if not found then raise exception 'Routine instance not found'; end if;
  update atlas_private.routine_instances
  set status='skipped',completion_notes=p_reason,completed_at=pg_catalog.now(),
      completed_by=p_actor_id,completed_by_label=p_actor_label
  where id=p_instance_id;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_skipped','routine_instance',p_instance_id,p_actor_id,p_actor_label,jsonb_build_object('reason',p_reason));
  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

create or replace function atlas_private.log_temperature(
  p_point_id uuid,p_temperature_c numeric,p_note text,p_corrective_action text,
  p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare
  point_row atlas_private.temperature_points;
  local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
  calculated_status text;
  missing_count bigint;
  temperature_template_id uuid;
begin
  select * into point_row from atlas_private.temperature_points where id=p_point_id and active=true;
  if not found then raise exception 'Temperature point not found or inactive'; end if;
  if p_temperature_c < -60 or p_temperature_c > 120 then raise exception 'Temperature reading is outside the accepted input range'; end if;
  calculated_status := case
    when point_row.min_temp_c is null and point_row.max_temp_c is null then 'range_unconfigured'
    when point_row.min_temp_c is not null and p_temperature_c < point_row.min_temp_c then 'outside_range'
    when point_row.max_temp_c is not null and p_temperature_c > point_row.max_temp_c then 'outside_range'
    else 'within_range' end;
  if calculated_status='outside_range' and nullif(trim(coalesce(p_corrective_action,'')),'') is null then
    raise exception 'Corrective action is required for an out-of-range temperature';
  end if;
  insert into atlas_private.temperature_logs (
    point_id,reading_date,temperature_c,range_status,corrective_action,note,logged_by,logged_by_label
  ) values (
    p_point_id,local_date,p_temperature_c,calculated_status,
    nullif(trim(coalesce(p_corrective_action,'')),''),nullif(trim(coalesce(p_note,'')),''),p_actor_id,p_actor_label);
  perform atlas_private.ensure_routine_instances(local_date);
  select id into temperature_template_id from atlas_private.routine_templates where template_key='daily-temperature-log';
  select count(*) into missing_count
  from atlas_private.temperature_points point
  where point.active=true and not exists (
    select 1 from atlas_private.temperature_logs log where log.point_id=point.id and log.reading_date=local_date);
  if missing_count=0 then
    update atlas_private.routine_instances
    set status='completed',completed_at=coalesce(completed_at,pg_catalog.now()),
        completed_by=coalesce(completed_by,p_actor_id),completed_by_label=coalesce(completed_by_label,p_actor_label),
        completion_notes=coalesce(completion_notes,'All active temperature points logged.')
    where template_id=temperature_template_id and scheduled_date=local_date and status<>'skipped';
  else
    update atlas_private.routine_instances
    set status=case when status='scheduled' then 'in_progress' else status end,
        started_at=coalesce(started_at,pg_catalog.now()),started_by=coalesce(started_by,p_actor_id),
        started_by_label=coalesce(started_by_label,p_actor_label)
    where template_id=temperature_template_id and scheduled_date=local_date and status not in ('completed','skipped');
  end if;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('temperature_logged','temperature_point',p_point_id,p_actor_id,p_actor_label,
    jsonb_build_object('temperature_c',p_temperature_c,'range_status',calculated_status,'corrective_action',p_corrective_action));
  return atlas_private.operations_today(local_date);
end;
$$;

create or replace function atlas_private.update_routine_template(
  p_template_id uuid,p_name text,p_description text,p_days_of_week smallint[],
  p_available_from time,p_due_time time,p_assigned_role text,p_active boolean,
  p_requires_manager_signoff boolean,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
begin
  if p_days_of_week is null or cardinality(p_days_of_week)=0 then raise exception 'At least one day of week is required'; end if;
  if exists (select 1 from unnest(p_days_of_week) day_value where day_value<0 or day_value>6) then raise exception 'Days of week must be between 0 and 6'; end if;
  if p_assigned_role is not null and p_assigned_role not in ('admin','manager','bartender','viewer','any_active_staff') then raise exception 'Invalid assigned role'; end if;
  update atlas_private.routine_templates
  set name=coalesce(nullif(trim(p_name),''),name),description=p_description,days_of_week=p_days_of_week,
      available_from=p_available_from,due_time=p_due_time,assigned_role=p_assigned_role,
      active=coalesce(p_active,active),requires_manager_signoff=coalesce(p_requires_manager_signoff,requires_manager_signoff),
      updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=p_template_id;
  if not found then raise exception 'Routine template not found'; end if;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('routine_template_updated','routine_template',p_template_id,p_actor_id,p_actor_label,
    jsonb_build_object('days_of_week',p_days_of_week,'due_time',p_due_time,'active',p_active));
  return atlas_private.operations_today(local_date);
end;
$$;

create or replace function atlas_private.update_temperature_point(
  p_point_id uuid,p_name text,p_location text,p_min_temp_c numeric,p_max_temp_c numeric,
  p_active boolean,p_actor_id uuid,p_actor_label text
)
returns jsonb language plpgsql volatile security invoker set search_path=''
as $$
declare local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
begin
  if p_min_temp_c is not null and p_max_temp_c is not null and p_min_temp_c>p_max_temp_c then
    raise exception 'Minimum temperature cannot exceed maximum temperature'; end if;
  update atlas_private.temperature_points
  set name=coalesce(nullif(trim(p_name),''),name),location=p_location,min_temp_c=p_min_temp_c,
      max_temp_c=p_max_temp_c,active=coalesce(p_active,active),updated_by=p_actor_id,updated_by_label=p_actor_label,
      metadata=metadata || jsonb_build_object('range_status',case when p_min_temp_c is null and p_max_temp_c is null then 'manager_configuration_required' else 'configured' end)
  where id=p_point_id;
  if not found then raise exception 'Temperature point not found'; end if;
  insert into atlas_private.operations_events (event_type,entity_type,entity_id,actor_id,actor_label,payload)
  values ('temperature_point_updated','temperature_point',p_point_id,p_actor_id,p_actor_label,
    jsonb_build_object('min_temp_c',p_min_temp_c,'max_temp_c',p_max_temp_c,'active',p_active));
  return atlas_private.operations_today(local_date);
end;
$$;

create or replace function public.atlas_operations_today(p_local_date date)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.operations_today(p_local_date); $$;
create or replace function public.atlas_operations_set_item(
  p_instance_id uuid,p_template_item_id uuid,p_completed boolean,p_note text,p_evidence jsonb,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.set_routine_item(p_instance_id,p_template_item_id,p_completed,p_note,p_evidence,p_actor_id,p_actor_label); $$;
create or replace function public.atlas_operations_complete_routine(
  p_instance_id uuid,p_notes text,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.complete_routine(p_instance_id,p_notes,p_actor_id,p_actor_label); $$;
create or replace function public.atlas_operations_skip_routine(
  p_instance_id uuid,p_reason text,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.skip_routine(p_instance_id,p_reason,p_actor_id,p_actor_label); $$;
create or replace function public.atlas_operations_log_temperature(
  p_point_id uuid,p_temperature_c numeric,p_note text,p_corrective_action text,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.log_temperature(p_point_id,p_temperature_c,p_note,p_corrective_action,p_actor_id,p_actor_label); $$;
create or replace function public.atlas_operations_update_template(
  p_template_id uuid,p_name text,p_description text,p_days_of_week smallint[],p_available_from time,p_due_time time,
  p_assigned_role text,p_active boolean,p_requires_manager_signoff boolean,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.update_routine_template(p_template_id,p_name,p_description,p_days_of_week,p_available_from,p_due_time,p_assigned_role,p_active,p_requires_manager_signoff,p_actor_id,p_actor_label); $$;
create or replace function public.atlas_operations_update_temperature_point(
  p_point_id uuid,p_name text,p_location text,p_min_temp_c numeric,p_max_temp_c numeric,p_active boolean,p_actor_id uuid,p_actor_label text
) returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.update_temperature_point(p_point_id,p_name,p_location,p_min_temp_c,p_max_temp_c,p_active,p_actor_id,p_actor_label); $$;

revoke execute on function public.atlas_operations_today(date) from public,anon,authenticated;
revoke execute on function public.atlas_operations_set_item(uuid,uuid,boolean,text,jsonb,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_operations_complete_routine(uuid,text,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_operations_skip_routine(uuid,text,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_operations_log_temperature(uuid,numeric,text,text,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_operations_update_template(uuid,text,text,smallint[],time,time,text,boolean,boolean,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_operations_update_temperature_point(uuid,text,text,numeric,numeric,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.atlas_operations_today(date) to service_role;
grant execute on function public.atlas_operations_set_item(uuid,uuid,boolean,text,jsonb,uuid,text) to service_role;
grant execute on function public.atlas_operations_complete_routine(uuid,text,uuid,text) to service_role;
grant execute on function public.atlas_operations_skip_routine(uuid,text,uuid,text) to service_role;
grant execute on function public.atlas_operations_log_temperature(uuid,numeric,text,text,uuid,text) to service_role;
grant execute on function public.atlas_operations_update_template(uuid,text,text,smallint[],time,time,text,boolean,boolean,uuid,text) to service_role;
grant execute on function public.atlas_operations_update_temperature_point(uuid,text,text,numeric,numeric,boolean,uuid,text) to service_role;

comment on table atlas_private.routine_templates is 'Editable recurring weekly and daily VÁ operational routines.';
comment on table atlas_private.temperature_logs is 'Audited manual or sensor temperature readings. Target ranges remain manager-configurable.';
comment on table atlas_private.integration_connections is 'Connection readiness and capability boundaries only. Credentials are never stored in this table.';
comment on function public.atlas_operations_today(date) is 'Service-role-only Checkpoint A snapshot for active Atlas staff.';
