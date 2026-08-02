-- Atlas Alpha legacy schema baseline.
-- Reconstructed from the schema-only 2026-08-02 pre-A.2 production snapshot.
-- Contains no production rows, user identities, stock quantities, costs, or source data.
-- It is intentionally idempotent so existing production tables remain unchanged.

create extension if not exists "pgcrypto";
create schema if not exists private;

do $baseline$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'staff_role'
  ) then
    create type "public"."staff_role" as enum ('admin', 'manager', 'bartender', 'viewer');
  end if;
end
$baseline$;

create table if not exists public."profiles" (
  "id" uuid not null,
  "email" text,
  "display_name" text,
  "role" "public"."staff_role" default 'bartender'::staff_role not null,
  "active" boolean default true not null,
  "created_at" timestamptz default now() not null,
  "updated_at" timestamptz default now() not null,
  constraint "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint "profiles_pkey" PRIMARY KEY (id)
);

create table if not exists public."suppliers" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "contact_name" text,
  "email" text,
  "phone" text,
  "notes" text,
  "active" boolean default true not null,
  "created_at" timestamptz default now() not null,
  "updated_at" timestamptz default now() not null,
  constraint "suppliers_name_key" UNIQUE (name),
  constraint "suppliers_pkey" PRIMARY KEY (id)
);

create table if not exists public."inventory_items" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "category" text default 'other'::text not null,
  "quantity" numeric default 0 not null,
  "unit" text default 'bottles'::text not null,
  "par_level" numeric,
  "updated_by" text,
  "updated_at" timestamptz default now() not null,
  "supplier_id" uuid,
  "supplier" text,
  "cost_price" numeric,
  "discount_percent" numeric default 0 not null,
  "sku" text,
  "barcode" text,
  "bin_location" text,
  "units_per_case" numeric,
  "case_cost" numeric,
  "size_ml" numeric,
  "active" boolean default true not null,
  "image_url" text,
  "sell_price" numeric,
  "source_key" text,
  "source_file" text,
  "source_updated_at" date,
  "imported_at" timestamptz default now(),
  "package_size" text,
  "source_page" integer,
  "import_note" text,
  constraint "inventory_items_case_cost_check" CHECK (case_cost IS NULL OR case_cost >= 0::numeric),
  constraint "inventory_items_cost_price_check" CHECK (cost_price IS NULL OR cost_price >= 0::numeric),
  constraint "inventory_items_discount_percent_check" CHECK (discount_percent >= 0::numeric AND discount_percent <= 100::numeric),
  constraint "inventory_items_size_ml_check" CHECK (size_ml IS NULL OR size_ml > 0::numeric),
  constraint "inventory_items_units_per_case_check" CHECK (units_per_case IS NULL OR units_per_case > 0::numeric),
  constraint "inventory_items_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  constraint "inventory_items_pkey" PRIMARY KEY (id)
);

create table if not exists public."inventory_movements" (
  "id" uuid default gen_random_uuid() not null,
  "item_id" uuid,
  "item_name" text not null,
  "movement_type" text not null,
  "quantity_change" numeric not null,
  "unit_cost" numeric,
  "total_cost" numeric,
  "supplier_id" uuid,
  "note" text,
  "created_by" uuid,
  "created_at" timestamptz default now() not null,
  constraint "inventory_movements_movement_type_check" CHECK (movement_type = ANY (ARRAY['restock'::text, 'sale'::text, 'waste'::text, 'adjustment'::text, 'count'::text, 'transfer'::text])),
  constraint "inventory_movements_quantity_change_check" CHECK (quantity_change <> 0::numeric),
  constraint "inventory_movements_unit_cost_check" CHECK (unit_cost IS NULL OR unit_cost >= 0::numeric),
  constraint "inventory_movements_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  constraint "inventory_movements_item_id_fkey" FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE SET NULL,
  constraint "inventory_movements_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  constraint "inventory_movements_pkey" PRIMARY KEY (id)
);

create table if not exists public."recipe_categories" (
  "id" uuid default gen_random_uuid() not null,
  "slug" text not null,
  "name" text not null,
  "description" text,
  "icon" text default 'layers-3'::text not null,
  "display_order" integer default 100 not null,
  "active" boolean default true not null,
  "created_at" timestamptz default now() not null,
  "updated_at" timestamptz default now() not null,
  constraint "recipe_categories_slug_key" UNIQUE (slug),
  constraint "recipe_categories_pkey" PRIMARY KEY (id)
);

create table if not exists public."recipes" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "type" text default 'cocktail'::text not null,
  "yield_quantity" numeric default 1 not null,
  "yield_unit" text default 'serving'::text not null,
  "menu_price" numeric,
  "show_on_menu" boolean default true not null,
  "updated_by" uuid,
  "created_at" timestamptz default now() not null,
  "updated_at" timestamptz default now() not null,
  "glassware" text,
  "garnish" text,
  "method" text,
  "notes" text,
  "image_url" text,
  "active" boolean default true not null,
  "category_id" uuid,
  "happy_hour_price" numeric,
  "glass_price" numeric,
  "bottle_price" numeric,
  "source_key" text,
  "source_file" text,
  "imported_at" timestamptz,
  constraint "recipes_name_key" UNIQUE (name),
  constraint "recipes_menu_price_check" CHECK (menu_price IS NULL OR menu_price >= 0::numeric),
  constraint "recipes_yield_quantity_check" CHECK (yield_quantity > 0::numeric),
  constraint "recipes_category_id_fkey" FOREIGN KEY (category_id) REFERENCES recipe_categories(id) ON DELETE SET NULL,
  constraint "recipes_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  constraint "recipes_pkey" PRIMARY KEY (id)
);

create table if not exists public."recipe_ingredients" (
  "id" uuid default gen_random_uuid() not null,
  "recipe_id" uuid not null,
  "item_id" uuid,
  "item_name" text not null,
  "quantity" numeric not null,
  "unit" text not null,
  constraint "recipe_ingredients_recipe_id_item_id_item_name_key" UNIQUE (recipe_id, item_id, item_name),
  constraint "recipe_ingredients_quantity_check" CHECK (quantity > 0::numeric),
  constraint "recipe_ingredients_item_id_fkey" FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE SET NULL,
  constraint "recipe_ingredients_recipe_id_fkey" FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
  constraint "recipe_ingredients_pkey" PRIMARY KEY (id)
);

create table if not exists public."import_batches" (
  "id" uuid default gen_random_uuid() not null,
  "batch_key" text not null,
  "source_files" text[] default '{}'::text[] not null,
  "status" text default 'uploaded'::text not null,
  "record_counts" jsonb default '{}'::jsonb not null,
  "notes" text,
  "created_at" timestamptz default now() not null,
  "completed_at" timestamptz,
  "file_name" text,
  "file_extension" text,
  "mime_type" text,
  "file_size" bigint,
  "entity_scope" text default 'inventory'::text not null,
  "current_stage" text default 'uploaded'::text not null,
  "progress_percent" integer default 0 not null,
  "storage_bucket" text,
  "storage_path" text,
  "created_by" uuid,
  "started_at" timestamptz,
  "updated_at" timestamptz default now() not null,
  "last_error" text,
  constraint "import_batches_batch_key_key" UNIQUE (batch_key),
  constraint "import_batches_progress_percent_check" CHECK (progress_percent >= 0 AND progress_percent <= 100),
  constraint "import_batches_status_check" CHECK (status = ANY (ARRAY['prepared'::text, 'uploaded'::text, 'reading'::text, 'extracting'::text, 'matching'::text, 'ready'::text, 'importing'::text, 'completed'::text, 'completed_with_review'::text, 'imported'::text, 'failed'::text, 'cancelled'::text])),
  constraint "import_batches_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  constraint "import_batches_pkey" PRIMARY KEY (id)
);

create table if not exists public."import_review_items" (
  "id" uuid default gen_random_uuid() not null,
  "batch_id" uuid not null,
  "entity_type" text default 'inventory_item'::text not null,
  "source_key" text not null,
  "severity" text default 'review'::text not null,
  "issue" text not null,
  "source_data" jsonb default '{}'::jsonb not null,
  "resolved" boolean default false not null,
  "resolved_at" timestamptz,
  "created_at" timestamptz default now() not null,
  constraint "import_review_items_batch_id_entity_type_source_key_issue_key" UNIQUE (batch_id, entity_type, source_key, issue),
  constraint "import_review_items_severity_check" CHECK (severity = ANY (ARRAY['info'::text, 'review'::text, 'warning'::text, 'error'::text])),
  constraint "import_review_items_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  constraint "import_review_items_pkey" PRIMARY KEY (id)
);

CREATE OR REPLACE FUNCTION private.is_manager_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.active = true
      and p.role in ('admin','manager')
  );
$function$;

CREATE OR REPLACE FUNCTION private.is_self_or_manager(target_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select (select auth.uid()) = target_user or (select private.is_manager_or_admin());
$function$;

CREATE OR REPLACE FUNCTION private.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_inventory(p_item_id uuid, p_quantity_change numeric, p_movement_type text, p_unit_cost numeric DEFAULT NULL::numeric, p_supplier_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_item public.inventory_items;
begin
  if p_quantity_change = 0 then
    raise exception 'Quantity change cannot be zero';
  end if;
  if p_movement_type not in ('restock','sale','waste','adjustment','count','transfer') then
    raise exception 'Invalid movement type';
  end if;

  update public.inventory_items
  set quantity = quantity + p_quantity_change,
      supplier_id = coalesce(p_supplier_id, supplier_id),
      cost_price = case when p_unit_cost is not null then p_unit_cost else cost_price end,
      updated_by = (select auth.uid())::text
  where id = p_item_id
    and quantity + p_quantity_change >= 0
  returning * into v_item;

  if v_item.id is null then
    raise exception 'Item not found or resulting quantity would be negative';
  end if;

  insert into public.inventory_movements (
    item_id, item_name, movement_type, quantity_change,
    unit_cost, total_cost, supplier_id, note, created_by
  ) values (
    v_item.id, v_item.name, p_movement_type, p_quantity_change,
    p_unit_cost,
    case when p_unit_cost is null then null else abs(p_quantity_change) * p_unit_cost end,
    p_supplier_id, p_note, (select auth.uid())
  );

  return v_item;
end;
$function$;

CREATE OR REPLACE FUNCTION public.atlas_touch_import_batch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  if new.status in ('imported','completed','completed_with_review') and new.completed_at is null then
    new.completed_at = now();
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at_recipe_categories()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

do $baseline$
begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass) then
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
  end if;
end
$baseline$;

CREATE UNIQUE INDEX IF NOT EXISTS import_batches_batch_key_key ON public.import_batches USING btree (batch_key);
CREATE INDEX IF NOT EXISTS import_batches_created_by_idx ON public.import_batches USING btree (created_by, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS import_batches_pkey ON public.import_batches USING btree (id);
CREATE INDEX IF NOT EXISTS import_batches_status_created_idx ON public.import_batches USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS import_batches_storage_path_idx ON public.import_batches USING btree (storage_bucket, storage_path) WHERE (storage_path IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS import_review_items_batch_id_entity_type_source_key_issue_key ON public.import_review_items USING btree (batch_id, entity_type, source_key, issue);
CREATE UNIQUE INDEX IF NOT EXISTS import_review_items_pkey ON public.import_review_items USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_barcode_unique ON public.inventory_items USING btree (barcode) WHERE (barcode IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_pkey ON public.inventory_items USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_sku_unique ON public.inventory_items USING btree (sku) WHERE (sku IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_source_key_uidx ON public.inventory_items USING btree (source_key) WHERE (source_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_movements_item_created_idx ON public.inventory_movements USING btree (item_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_pkey ON public.inventory_movements USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_pkey ON public.profiles USING btree (id);
CREATE INDEX IF NOT EXISTS recipe_categories_active_order_idx ON public.recipe_categories USING btree (active, display_order);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_categories_pkey ON public.recipe_categories USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_categories_slug_key ON public.recipe_categories USING btree (slug);
CREATE INDEX IF NOT EXISTS recipe_ingredients_item_id_idx ON public.recipe_ingredients USING btree (item_id);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_pkey ON public.recipe_ingredients USING btree (id);
CREATE INDEX IF NOT EXISTS recipe_ingredients_recipe_id_idx ON public.recipe_ingredients USING btree (recipe_id);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_recipe_id_item_id_item_name_key ON public.recipe_ingredients USING btree (recipe_id, item_id, item_name);
CREATE INDEX IF NOT EXISTS recipe_ingredients_recipe_idx ON public.recipe_ingredients USING btree (recipe_id);
CREATE INDEX IF NOT EXISTS recipes_active_idx ON public.recipes USING btree (active);
CREATE INDEX IF NOT EXISTS recipes_category_id_idx ON public.recipes USING btree (category_id);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_name_key ON public.recipes USING btree (name);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_pkey ON public.recipes USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_source_key_uidx ON public.recipes USING btree (source_key) WHERE (source_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS recipes_type_idx ON public.recipes USING btree (type);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_key ON public.suppliers USING btree (name);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_pkey ON public.suppliers USING btree (id);

do $baseline$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_import_batches_touch'
      and tgrelid = 'public.import_batches'::regclass
  ) then
    execute $trigger$CREATE TRIGGER trg_import_batches_touch BEFORE UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION atlas_touch_import_batch()$trigger$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_inventory_items_updated_at'
      and tgrelid = 'public.inventory_items'::regclass
  ) then
    execute $trigger$CREATE TRIGGER trg_inventory_items_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at()$trigger$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_profiles_updated_at'
      and tgrelid = 'public.profiles'::regclass
  ) then
    execute $trigger$CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION private.set_updated_at()$trigger$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_recipe_categories_updated_at'
      and tgrelid = 'public.recipe_categories'::regclass
  ) then
    execute $trigger$CREATE TRIGGER trg_recipe_categories_updated_at BEFORE UPDATE ON recipe_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at_recipe_categories()$trigger$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_recipes_updated_at'
      and tgrelid = 'public.recipes'::regclass
  ) then
    execute $trigger$CREATE TRIGGER trg_recipes_updated_at BEFORE UPDATE ON recipes FOR EACH ROW EXECUTE FUNCTION private.set_updated_at()$trigger$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_suppliers_updated_at'
      and tgrelid = 'public.suppliers'::regclass
  ) then
    execute $trigger$CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION private.set_updated_at()$trigger$;
  end if;
end
$baseline$;

alter table public."import_batches" enable row level security;
alter table public."import_review_items" enable row level security;
alter table public."inventory_items" enable row level security;
alter table public."inventory_movements" enable row level security;
alter table public."profiles" enable row level security;
alter table public."recipe_categories" enable row level security;
alter table public."recipe_ingredients" enable row level security;
alter table public."recipes" enable row level security;
alter table public."suppliers" enable row level security;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'import_batches'
      and policyname = 'authenticated staff can delete import batches'
  ) then
    execute $policy$create policy "authenticated staff can delete import batches" on public."import_batches" as permissive for delete to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'import_batches'
      and policyname = 'authenticated staff can insert import batches'
  ) then
    execute $policy$create policy "authenticated staff can insert import batches" on public."import_batches" as permissive for insert to "authenticated" with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'import_batches'
      and policyname = 'authenticated staff can read import batches'
  ) then
    execute $policy$create policy "authenticated staff can read import batches" on public."import_batches" as permissive for select to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'import_batches'
      and policyname = 'authenticated staff can update import batches'
  ) then
    execute $policy$create policy "authenticated staff can update import batches" on public."import_batches" as permissive for update to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL)) with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'import_review_items'
      and policyname = 'authenticated staff can read import reviews'
  ) then
    execute $policy$create policy "authenticated staff can read import reviews" on public."import_review_items" as permissive for select to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'import_review_items'
      and policyname = 'authenticated staff can update import reviews'
  ) then
    execute $policy$create policy "authenticated staff can update import reviews" on public."import_review_items" as permissive for update to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL)) with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_items'
      and policyname = 'authenticated staff add inventory'
  ) then
    execute $policy$create policy "authenticated staff add inventory" on public."inventory_items" as permissive for insert to "authenticated" with check (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_items'
      and policyname = 'authenticated staff read inventory'
  ) then
    execute $policy$create policy "authenticated staff read inventory" on public."inventory_items" as permissive for select to "authenticated" using (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_items'
      and policyname = 'authenticated staff update inventory'
  ) then
    execute $policy$create policy "authenticated staff update inventory" on public."inventory_items" as permissive for update to "authenticated" using (true) with check (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_items'
      and policyname = 'managers delete inventory'
  ) then
    execute $policy$create policy "managers delete inventory" on public."inventory_items" as permissive for delete to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_movements'
      and policyname = 'managers delete movements'
  ) then
    execute $policy$create policy "managers delete movements" on public."inventory_movements" as permissive for delete to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_movements'
      and policyname = 'staff add movements'
  ) then
    execute $policy$create policy "staff add movements" on public."inventory_movements" as permissive for insert to "authenticated" with check ((( SELECT auth.uid() AS uid) = created_by))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_movements'
      and policyname = 'staff read movements'
  ) then
    execute $policy$create policy "staff read movements" on public."inventory_movements" as permissive for select to "authenticated" using (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'managers update profiles'
  ) then
    execute $policy$create policy "managers update profiles" on public."profiles" as permissive for update to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin)) with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'staff read profiles'
  ) then
    execute $policy$create policy "staff read profiles" on public."profiles" as permissive for select to "authenticated" using (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and policyname = 'staff can add recipe categories'
  ) then
    execute $policy$create policy "staff can add recipe categories" on public."recipe_categories" as permissive for insert to "authenticated" with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and policyname = 'staff can delete recipe categories'
  ) then
    execute $policy$create policy "staff can delete recipe categories" on public."recipe_categories" as permissive for delete to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and policyname = 'staff can read recipe categories'
  ) then
    execute $policy$create policy "staff can read recipe categories" on public."recipe_categories" as permissive for select to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_categories'
      and policyname = 'staff can update recipe categories'
  ) then
    execute $policy$create policy "staff can update recipe categories" on public."recipe_categories" as permissive for update to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL)) with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'managers add recipe ingredients'
  ) then
    execute $policy$create policy "managers add recipe ingredients" on public."recipe_ingredients" as permissive for insert to "authenticated" with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'managers delete recipe ingredients'
  ) then
    execute $policy$create policy "managers delete recipe ingredients" on public."recipe_ingredients" as permissive for delete to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'managers update recipe ingredients'
  ) then
    execute $policy$create policy "managers update recipe ingredients" on public."recipe_ingredients" as permissive for update to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin)) with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'staff can delete recipe ingredients'
  ) then
    execute $policy$create policy "staff can delete recipe ingredients" on public."recipe_ingredients" as permissive for delete to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'staff can read recipe ingredients'
  ) then
    execute $policy$create policy "staff can read recipe ingredients" on public."recipe_ingredients" as permissive for select to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'staff can update recipe ingredients'
  ) then
    execute $policy$create policy "staff can update recipe ingredients" on public."recipe_ingredients" as permissive for update to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL)) with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'staff can write recipe ingredients'
  ) then
    execute $policy$create policy "staff can write recipe ingredients" on public."recipe_ingredients" as permissive for insert to "authenticated" with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'staff read recipe ingredients'
  ) then
    execute $policy$create policy "staff read recipe ingredients" on public."recipe_ingredients" as permissive for select to "authenticated" using (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'managers add recipes'
  ) then
    execute $policy$create policy "managers add recipes" on public."recipes" as permissive for insert to "authenticated" with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'managers delete recipes'
  ) then
    execute $policy$create policy "managers delete recipes" on public."recipes" as permissive for delete to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'managers update recipes'
  ) then
    execute $policy$create policy "managers update recipes" on public."recipes" as permissive for update to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin)) with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'public reads visible recipes'
  ) then
    execute $policy$create policy "public reads visible recipes" on public."recipes" as permissive for select to "anon" using ((show_on_menu = true))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'staff can delete recipes'
  ) then
    execute $policy$create policy "staff can delete recipes" on public."recipes" as permissive for delete to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'staff can read recipes'
  ) then
    execute $policy$create policy "staff can read recipes" on public."recipes" as permissive for select to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'staff can update recipes'
  ) then
    execute $policy$create policy "staff can update recipes" on public."recipes" as permissive for update to "authenticated" using ((( SELECT auth.uid() AS uid) IS NOT NULL)) with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'staff can write recipes'
  ) then
    execute $policy$create policy "staff can write recipes" on public."recipes" as permissive for insert to "authenticated" with check ((( SELECT auth.uid() AS uid) IS NOT NULL))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'staff read recipes'
  ) then
    execute $policy$create policy "staff read recipes" on public."recipes" as permissive for select to "authenticated" using (true)$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'suppliers'
      and policyname = 'managers add suppliers'
  ) then
    execute $policy$create policy "managers add suppliers" on public."suppliers" as permissive for insert to "authenticated" with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'suppliers'
      and policyname = 'managers delete suppliers'
  ) then
    execute $policy$create policy "managers delete suppliers" on public."suppliers" as permissive for delete to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'suppliers'
      and policyname = 'managers update suppliers'
  ) then
    execute $policy$create policy "managers update suppliers" on public."suppliers" as permissive for update to "authenticated" using (( SELECT private.is_manager_or_admin() AS is_manager_or_admin)) with check (( SELECT private.is_manager_or_admin() AS is_manager_or_admin))$policy$;
  end if;
end
$baseline$;

do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'suppliers'
      and policyname = 'staff read suppliers'
  ) then
    execute $policy$create policy "staff read suppliers" on public."suppliers" as permissive for select to "authenticated" using (true)$policy$;
  end if;
end
$baseline$;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_batches" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_batches" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_batches" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_batches" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_review_items" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_review_items" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_review_items" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."import_review_items" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_items" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_items" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_items" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_items" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_movements" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_movements" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_movements" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."inventory_movements" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."profiles" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."profiles" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."profiles" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."profiles" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_categories" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_categories" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_categories" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_categories" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_ingredients" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_ingredients" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_ingredients" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipe_ingredients" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipes" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipes" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipes" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."recipes" to "service_role";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."suppliers" to "anon";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."suppliers" to "authenticated";
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."suppliers" to "postgres" with grant option;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table "public"."suppliers" to "service_role";
