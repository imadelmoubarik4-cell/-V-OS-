// S88 Team A fixtures for Home, Operations and Settings: a realistic venue on
// Thursday 24 September 2026, 16:32 in Reykjavik (open 17:00-01:00, closed Mondays).
import { USERS } from './harness.mjs';
import { emptyFunctions, settingsWorkspace } from './fixtures.mjs';

export const VIEWER = { id: '7d3c1f10-0000-4000-8000-000000000003', email: 'vala.viewer@example.test', display_name: 'Vala Viewer', role: 'viewer', active: true };

const verified = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: '2026-09-22T11:00:00Z', expires_at: '2026-10-22T11:00:00Z' });

export function hours() {
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return labels.map((day_label, weekday) => ({
    weekday, day_label, is_open: weekday !== 1,
    open_time: weekday !== 1 ? '17:00:00' : null, close_time: weekday !== 1 ? '01:00:00' : null, close_next_day: weekday !== 1,
    kitchen_close_time: null, kitchen_close_next_day: false,
    last_order_time: weekday !== 1 ? '00:30:00' : null, last_order_next_day: weekday !== 1,
    updated_at: '2026-09-20T10:00:00Z'
  }));
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n, key, label, done, by) => ({ id: uuid(n), item_key: key, section: null, label, required: true, completed: done, completed_at: done ? '2026-09-24T16:05:00Z' : null, completed_by_label: done ? by : null, note: null, evidence: {}, evidence_type: 'none' });

export function operationsSnapshot() {
  const opening = {
    id: uuid(1), template_id: uuid(90), template_key: 'daily-opening-checklist', name: 'Opening checklist', routine_type: 'opening', date_basis: 'business',
    status: 'in_progress', scheduled_date: '2026-09-24', due_time: null, progress: { required: 9, completed: 4, percent: 44 },
    items: [
      item(11, 'cash-pos', 'Confirm POS, cash float and card terminals', true, 'Sara Jónsdóttir'),
      item(12, 'coffee-machine', 'Start and test the coffee machine', true, 'Sara Jónsdóttir'),
      item(13, 'ice', 'Check ice production and service wells', true, 'Gunnar Kristjánsson'),
      item(14, 'garnish', 'Prepare garnish and fresh citrus', true, 'Sara Jónsdóttir'),
      item(15, 'glassware', 'Polish and stock service glassware', false),
      item(16, 'bar-stock', 'Restock the bar to service levels', false),
      item(17, 'music-lighting', 'Set music, lighting and guest areas', false),
      item(18, 'toilets', 'Complete the guest-area and toilet check', false),
      item(19, 'tablet', 'Charge and position the service tablet', false)
    ]
  };
  const closing = {
    id: uuid(2), template_id: uuid(91), template_key: 'daily-closing-checklist', name: 'Closing checklist', routine_type: 'closing', date_basis: 'business',
    status: 'scheduled', scheduled_date: '2026-09-24', due_time: null, progress: { required: 9, completed: 0, percent: 0 },
    items: ['Close and reconcile the register', 'Empty and clean the dishwasher', 'Record waste and remove rubbish', 'Secure alcohol and high-value stock', 'Clean stations, tools and work surfaces', 'Switch off and check equipment', 'Turn off music and non-essential lighting', 'Lock doors and set the alarm', 'Submit the shift handover report'].map((label, index) => item(30 + index, `c${index}`, label, false))
  };
  const weekly = { id: uuid(3), template_id: uuid(92), name: 'Clean the ice machine', routine_type: 'deep_cleaning', status: 'scheduled', scheduled_date: '2026-09-24', due_time: '23:00:00', description: 'Weekly', progress: { required: 3, completed: 0, percent: 0 }, items: [item(51, 'a', 'Empty and descale', false), item(52, 'b', 'Sanitise the bin', false), item(53, 'c', 'Run a test cycle', false)] };
  return {
    venue_date: '2026-09-24', business_date: '2026-09-24', timezone: 'Atlantic/Reykjavik',
    routines: [opening, closing, weekly],
    temperature: {
      summary: { required_points: 3, logged_points: 1, outstanding_points: 2, outside_range_points: 0, range_unconfigured_points: 1, complete: false },
      points: [
        { id: uuid(71), name: 'Fridge 1', location: 'Back bar', min_temp_c: 1, max_temp_c: 5, range_configured: true, logged_today: true, latest_log: { temperature_c: 3.8, range_status: 'inside_range', reading_at: '2026-09-24T16:05:00Z', logged_by_label: 'Sara Jónsdóttir' } },
        { id: uuid(72), name: 'Fridge 2', location: 'Back bar', min_temp_c: 1, max_temp_c: 5, range_configured: true, logged_today: false, latest_log: null },
        { id: uuid(73), name: 'Walk-in', location: 'Store room', min_temp_c: null, max_temp_c: null, range_configured: false, logged_today: false, latest_log: null }
      ]
    },
    alerts: []
  };
}

export function operationsBackend(user) {
  const snapshot = operationsSnapshot();
  const staff = { id: user.id, label: user.display_name, role: user.role, can_write: ['admin', 'manager', 'bartender'].includes(user.role), can_manage: ['admin', 'manager'].includes(user.role) };
  return (entry) => {
    if (entry.action === 'snapshot') return { operations: snapshot, staff };
    if (entry.action === 'daily-checklists') {
      const opening = snapshot.routines[0];
      const closing = snapshot.routines[1];
      return { checklists: { business_date: '2026-09-24', current_business_date: '2026-09-24', venue_date: '2026-09-24', timezone: 'Atlantic/Reykjavik', editable: true, configured: true, opening, closing }, summary: {}, staff, policy: { shared_between_devices: true, device_storage: false } };
    }
    if (entry.action === 'settings') return { settings: { templates: [
      { id: uuid(90), name: 'Opening checklist', days_of_week: [0, 1, 2, 3, 4, 5, 6], due_time: null, assigned_role: 'any_active_staff', active: true, item_count: 9 },
      { id: uuid(91), name: 'Closing checklist', days_of_week: [0, 1, 2, 3, 4, 5, 6], due_time: null, assigned_role: 'any_active_staff', active: true, item_count: 9 },
      { id: uuid(92), name: 'Clean the ice machine', days_of_week: [4], due_time: '23:00:00', assigned_role: 'bartender', active: true, item_count: 3 }
    ] }, staff };
    if (entry.method === 'POST' && entry.action === 'set-item') {
      for (const routine of snapshot.routines) {
        const target = (routine.items || []).find((row) => row.id === entry.body.template_item_id);
        if (target && routine.id === entry.body.instance_id) {
          target.completed = entry.body.completed;
          target.completed_by_label = entry.body.completed ? user.display_name : null;
          target.completed_at = entry.body.completed ? '2026-09-24T16:32:00Z' : null;
          target.note = entry.body.note;
          routine.progress.completed = routine.items.filter((row) => row.completed).length;
          routine.status = routine.progress.completed ? 'in_progress' : 'scheduled';
        }
      }
      return { operations: snapshot, staff };
    }
    return { operations: snapshot, staff };
  };
}

export function shiftsWorkspace() {
  return {
    week: { status: 'published' },
    permissions: { can_manage_schedule: true },
    people: [
      { id: 'p1', profile_id: USERS.bartender.id, display_name: 'Sara Jónsdóttir', default_role: 'Bartender' },
      { id: 'p2', profile_id: 'x2', display_name: 'Gunnar Kristjánsson', default_role: 'Bartender' },
      { id: 'p3', profile_id: 'x3', display_name: 'Elín Hauksdóttir', default_role: 'Floor' }
    ],
    shifts: [
      { id: 's1', person_id: 'p1', role_name: 'Bartender', note: 'opening', starts_local: '2026-09-24T16:00:00', ends_local: '2026-09-25T00:00:00' },
      { id: 's2', person_id: 'p2', role_name: 'Bartender', starts_local: '2026-09-24T18:00:00', ends_local: '2026-09-25T01:30:00' },
      { id: 's3', person_id: 'p3', role_name: 'Floor', starts_local: '2026-09-24T19:00:00', ends_local: '2026-09-25T01:30:00' },
      { id: 's4', person_id: 'p1', role_name: 'Bartender', starts_local: '2026-09-26T17:00:00', ends_local: '2026-09-27T01:00:00' }
    ]
  };
}

export function teamAFixtures({ user = USERS.admin, overrides = {} } = {}) {
  const workspace = settingsWorkspace({ business_hours: hours(), roles: [
    { role_key: 'admin', label: 'Administrator', description: 'Full access', permissions: { manage_settings: true, manage_team: true, view_costs: true }, can_edit: false, version: 1 },
    { role_key: 'manager', label: 'Manager', description: 'Runs the venue', permissions: { manage_settings: true, manage_team: false, view_costs: true }, can_edit: true, version: 1 },
    { role_key: 'bartender', label: 'Bartender', description: 'Serves and counts', permissions: { manage_settings: false, manage_team: false, view_costs: false }, can_edit: true, version: 1 }
  ], offers: [{ id: 'o1', offer_key: 'happy-hour', name: 'Happy hour', days: [0, 2, 3, 4, 5, 6], start_time: '17:00:00', end_time: '19:00:00', end_next_day: false, active: true, pricing: {}, version: 1 }],
  notification_policies: [{ event_key: 'team_message', label: 'New team messages', enabled: true, target_roles: ['admin', 'manager', 'bartender'] }, { event_key: 'shift_published', label: 'Shift published', enabled: true, target_roles: ['bartender'] }],
  events: [{ section_key: 'venue', event_type: 'settings_section_saved', actor_label: 'Imad El Moubarik', created_at: '2026-09-23T10:02:00Z' }] });
  if (!['admin', 'manager'].includes(user.role)) workspace.permissions = { can_manage_organization: false, can_manage_security: false };
  return {
    profiles: [USERS.admin, USERS.bartender, VIEWER],
    tables: {
      inventory_items: [
        { id: 'campari', name: 'Campari', category: 'Liqueurs', unit: 'bottles', par_level: 4, supplier: 'Globus', active: true, cost_price: 3900 },
        { id: 'lime', name: 'Limes', category: 'Fruit & garnish', unit: 'each', par_level: 40, supplier: 'Mata', active: true, cost_price: 60 },
        { id: 'tanq', name: 'Tanqueray London Dry', category: 'Gin', unit: 'bottles', par_level: 6, supplier: 'Globus', active: true, cost_price: 4200 },
        { id: 'aperol', name: 'Aperol', category: 'Liqueurs', unit: 'bottles', par_level: 4, supplier: 'Globus', active: true, cost_price: 3300 },
        { id: 'tonic', name: 'Fever-Tree Tonic', category: 'Mixers', unit: 'bottles', par_level: 72, supplier: 'Ölgerðin', active: true, cost_price: 190 },
        { id: 'vermouth', name: 'Sweet vermouth', category: 'Vermouth', unit: 'bottles', par_level: 3, supplier: 'Globus', active: true, cost_price: 2900 },
        { id: 'beer', name: 'Einstök White Ale', category: 'Beer — bottles/cans', unit: 'bottles', par_level: 48, supplier: 'Ölgerðin', active: true, cost_price: 290 }
      ],
      inventory_catalog: [
        { id: 'campari', name: 'Campari', category: 'Liqueurs', unit: 'bottles', par_level: 4, active: true },
        { id: 'lime', name: 'Limes', category: 'Fruit & garnish', unit: 'each', par_level: 40, active: true },
        { id: 'tanq', name: 'Tanqueray London Dry', category: 'Gin', unit: 'bottles', par_level: 6, active: true },
        { id: 'aperol', name: 'Aperol', category: 'Liqueurs', unit: 'bottles', par_level: 4, active: true },
        { id: 'tonic', name: 'Fever-Tree Tonic', category: 'Mixers', unit: 'bottles', par_level: 72, active: true },
        { id: 'vermouth', name: 'Sweet vermouth', category: 'Vermouth', unit: 'bottles', par_level: 3, active: true },
        { id: 'beer', name: 'Einstök White Ale', category: 'Beer — bottles/cans', unit: 'bottles', par_level: 48, active: true }
      ],
      recipes: [
        { id: 'negroni', name: 'Negroni', active: true, yield_quantity: 1, menu_price: 2900, recipe_ingredients: [{ id: 'n1', item_id: 'campari', item_name: 'Campari', quantity: 30, unit: 'ml' }, { id: 'n2', item_id: 'tanq', item_name: 'Tanqueray London Dry', quantity: 30, unit: 'ml' }] },
        { id: 'gt', name: 'Gin and tonic', active: true, yield_quantity: 1, menu_price: 2500, recipe_ingredients: [{ id: 'g1', item_id: 'tanq', item_name: 'Tanqueray London Dry', quantity: 50, unit: 'ml' }] },
        { id: 'spritz', name: 'Aperol spritz', active: true, yield_quantity: 1, menu_price: 2600, recipe_ingredients: [{ id: 's1', item_id: 'aperol', item_name: 'Aperol', quantity: 60, unit: 'ml' }] }
      ],
      recipe_catalog: [
        { id: 'negroni', name: 'Negroni', active: true, yield_quantity: 1, recipe_ingredients: [{ id: 'n1', item_id: 'campari', item_name: 'Campari', quantity: 30, unit: 'ml' }] },
        { id: 'spritz', name: 'Aperol spritz', active: true, yield_quantity: 1, recipe_ingredients: [{ id: 's1', item_id: 'aperol', item_name: 'Aperol', quantity: 60, unit: 'ml' }] }
      ],
      suppliers: [{ id: 's1', name: 'Globus' }, { id: 's2', name: 'Mata' }, { id: 's3', name: 'Ölgerðin' }],
      recipe_categories: []
    },
    rpc: { atlas_purchase_order_policy: { approval_required: true, approval_threshold_isk: 50000, approval_separate_approver: false, over_receipt_tolerance_percent: 0, short_close_enabled: false, delivery_date_required_on_place: false, staff_receiving_enabled: false } },
    functions: {
      ...emptyFunctions(),
      'atlas-stock-counts': { counts: { verified_balances: [verified('campari', 0), verified('lime', 0), verified('tanq', 3), verified('aperol', 2), verified('tonic', 48), verified('vermouth', 3)] } },
      'atlas-settings': (entry) => {
        if (entry.action === 'venue-clock') return { clock: { timezone: 'Atlantic/Reykjavik', timezone_source: 'settings', hours_configured: true, business_hours: hours(), offers: [{ offer_key: 'happy-hour', name: 'Happy hour', days: [0, 2, 3, 4, 5, 6], start_time: '17:00:00', end_time: '19:00:00', end_next_day: false }], venue_date: '2026-09-24', business_date: '2026-09-24', venue_local_time: null, generated_at: '2026-09-24T16:32:00Z' }, staff: { id: user.id, role: user.role, active: true, can_manage_hours: ['admin', 'manager'].includes(user.role) } };
        return { workspace, staff: { id: user.id, label: user.display_name, role: user.role, active: true } };
      },
      'atlas-operations-checkpoint-a': operationsBackend(user),
      'atlas-shifts': { workspace: shiftsWorkspace(), staff: { id: user.id } },
      'atlas-team-messages': { snapshot: { channels: [{ key: 'general', name: 'General', unread_count: 2, last_message: { id: 'm9', sender_label: 'Gunnar', body: 'Ice machine is making a noise again', created_at: '2026-09-24T16:10:00Z' } }, { key: 'managers', name: 'Managers', unread_count: 1, last_message: { id: 'm7', sender_label: 'Sara', body: 'Globus delivery moved to Friday', created_at: '2026-09-24T15:40:00Z' } }], messages: [], selected_channel_key: 'general', summary: { total_unread: 3, active_members: 6 } }, members: [], staff: {} },
      'atlas-ai': (entry) => {
        if (entry.action === 'settings') return { enabled: true, media_retention_days: 30, audio_retention: 'delete_after_transcription', daily_turn_limit_per_user: 200, voice_sessions_per_day: 20, voice_minutes_per_day: 60, max_concurrent_voice_sessions: 1, upload_bytes_per_day: 262144000, upload_files_per_day: 100, updated_at: '2026-09-20T10:00:00Z', can_edit: ['admin', 'manager'].includes(user.role), configured: false, key_present: false };
        if (entry.action === 'preferences') return { reply_length: 'normal', speak_answers: false, voice_enabled: true, language: 'auto', stored: false };
        return { __status: 503, body: { error_code: 'not_configured' } };
      },
      'atlas-integrations': (entry) => {
        if (entry.action === 'status') return { providers: [
          { provider_key: 'google-business-profile', label: 'Google Business Profile', auth_kind: 'oauth2', connection_state: 'ready', configured: true, can_connect: true, can_save_api_key: false, can_test: false, can_disconnect: false, missing_requirements: [], scopes_granted: [] },
          { provider_key: 'instagram', label: 'Instagram', auth_kind: 'oauth2', connection_state: 'connected', configured: true, can_connect: true, can_test: true, can_disconnect: true, account_label: '@vabar.rvk', last_verified_at: '2026-09-23T09:00:00Z', connected_by_label: 'Imad El Moubarik', connected_at: '2026-09-20T12:00:00Z' },
          { provider_key: 'tiktok', label: 'TikTok', auth_kind: 'oauth2', connection_state: 'not_configured', configured: false, can_connect: false, can_test: false, can_disconnect: false, available_message: 'Not available yet — requires a TikTok for Developers client key and its client secret.', owner_requirements_summary: 'A TikTok developer app with Content Posting API access and app review.' },
          { provider_key: 'tripadvisor', label: 'Tripadvisor', auth_kind: 'api_key', connection_state: 'ready', configured: true, can_connect: false, can_save_api_key: true, can_test: false, can_disconnect: false }
        ], policy: {}, staff: { role: user.role } };
        return { __status: 409, body: { error: 'x', error_code: 'not_configured' } };
      },
      'atlas-system': { workspace: { summary: { overall_status: 'healthy', healthy_services: 5, degraded_services: 0, open_incidents: 0, blocked_sources: 1 }, services: [{ service_key: 'web-app', label: 'Web app', category: 'app', environment: 'production', status: 'healthy', last_checked_at: '2026-09-24T16:20:00Z' }], data_sources: [{ label: 'Inventory', domain: 'stock', is_live: true, status: 'current', record_count: 84, last_successful_at: '2026-09-24T16:00:00Z' }], releases: [{ label: 'S88', environment: 'production', status: 'current', commit_sha: 'a1b2c3d4e5', migration_status: 'current' }], jobs: [], incidents: [], audit: [], recovery: { backup_status: 'unknown' }, security: {} } }
    },
    ...overrides
  };
}
