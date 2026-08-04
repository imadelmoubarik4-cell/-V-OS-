(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const TAB_ORDER = [
    'overview', 'general', 'access', 'notifications', 'operations',
    'intelligence', 'integrations', 'security', 'preferences', 'activity'
  ];
  const TAB_LABELS = {
    overview: 'Overview',
    general: 'Venue & hours',
    access: 'Team access',
    notifications: 'Notifications',
    operations: 'Operational rules',
    intelligence: 'Marketing & Brain',
    integrations: 'Integrations',
    security: 'Security',
    preferences: 'Preferences',
    activity: 'Activity'
  };
  const ROLE_LABELS = {
    admin: 'Administrator',
    manager: 'Manager',
    bartender: 'Bartender',
    viewer: 'Viewer'
  };
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ROLE_KEYS = ['admin', 'manager', 'bartender', 'viewer'];
  const NOTIFICATION_CHANNELS = ['in_app', 'browser', 'email'];
  const START_VIEWS = [
    ['briefing', 'Daily Briefing'], ['brain', 'Atlas Brain'], ['operations', 'Operations'],
    ['inventory', 'Inventory'], ['shifts', 'Shifts'], ['knowledge', 'Knowledge'],
    ['reports', 'Reports'], ['system', 'System'], ['settings', 'Settings']
  ];

  const state = {
    workspace: null,
    staff: null,
    policy: null,
    activeTab: 'overview',
    loading: false,
    saving: false,
    error: null,
    message: null,
    initialized: false,
    viewObserver: null,
    authTimer: null,
    offerDraft: null,
    search: ''
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function endpoint() {
    return String(cfg.SETTINGS_API || '').trim();
  }

  function host() {
    return document.getElementById('settings-view');
  }

  function settingsVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action = 'snapshot', options = {}) {
    const apiUrl = endpoint();
    if (!apiUrl) throw new Error('Settings API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Settings.');

    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `Settings request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Settings took too long to respond. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function section(key) {
    return (state.workspace?.sections || []).find((entry) => entry.section_key === key) || null;
  }

  function canManage() {
    return Boolean(state.workspace?.permissions?.can_manage_organization);
  }

  function canManageSecurity() {
    return Boolean(state.workspace?.permissions?.can_manage_security);
  }

  function formatDateTime(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function statusTone(value) {
    if (['connected', 'active', 'ready', 'healthy', 'authorized', 'granted'].includes(value)) return 'good';
    if (['degraded', 'pending_review', 'waiting_authorization', 'pending', 'blocked'].includes(value)) return 'warn';
    if (['expired', 'error', 'missing'].includes(value)) return 'bad';
    return 'neutral';
  }

  function statusPill(value, label) {
    return `<span class="settings-status is-${statusTone(value)}"><i></i>${escapeHtml(label || humanize(value || 'unknown'))}</span>`;
  }

  function boolValue(form, name) {
    return Boolean(form.querySelector(`[name="${CSS.escape(name)}"]`)?.checked);
  }

  function fieldValue(form, name) {
    return form.querySelector(`[name="${CSS.escape(name)}"]`)?.value ?? '';
  }

  function numberValue(form, name, fallback = 0) {
    const raw = fieldValue(form, name);
    if (raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  function commaList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function integerList(value) {
    return [...new Set(commaList(value).map(Number).filter(Number.isInteger))];
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="settings-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    if (state.message) return `<div class="settings-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    return '';
  }

  function loadingMarkup() {
    return `<section class="settings-shell settings-loading">
      <span class="settings-loading-icon"><i data-lucide="settings-2"></i></span>
      <h2>Loading Atlas Settings</h2>
      <p>Reading venue configuration, operational rules, access controls and personal preferences.</p>
      <div class="settings-loading-grid">${Array.from({ length: 4 }, () => '<i></i>').join('')}</div>
    </section>`;
  }

  function errorMarkup() {
    return `<section class="settings-shell settings-loading">
      <span class="settings-loading-icon is-error"><i data-lucide="settings-2"></i></span>
      <h2>Settings unavailable</h2>
      <p>${escapeHtml(state.error || 'Atlas Settings could not load.')}</p>
      <button type="button" class="settings-primary" data-settings-refresh><i data-lucide="refresh-cw"></i>Try again</button>
    </section>`;
  }

  function tabsMarkup() {
    return `<nav class="settings-tabs" aria-label="Settings sections">${TAB_ORDER.map((tab) => `<button type="button" data-settings-tab="${tab}" class="${state.activeTab === tab ? 'is-active' : ''}">${escapeHtml(TAB_LABELS[tab])}</button>`).join('')}</nav>`;
  }

  function sectionHead(kicker, title, description, action = '') {
    return `<section class="settings-section-head"><div><span>${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>${action}</section>`;
  }

  function heroMarkup() {
    const workspace = state.workspace || {};
    const trust = workspace.trust || {};
    return `<section class="settings-hero">
      <div>
        <span class="settings-kicker"><i data-lucide="sliders-horizontal"></i>Checkpoint J</span>
        <h1>Settings</h1>
        <p>Configure how Atlas works for VÁ while keeping production synchronization, destructive controls and automatic execution safely disabled.</p>
      </div>
      <aside>
        <span>Environment</span>
        <strong>${escapeHtml(humanize(trust.environment || 'isolated_branch'))}</strong>
        <small>Version ${escapeHtml(workspace.version || 'not loaded')} · ${canManage() ? 'Organization manager access' : 'Personal preferences access'}</small>
        <button type="button" data-settings-refresh ${state.loading ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>${state.loading ? 'Refreshing…' : 'Refresh'}</button>
      </aside>
    </section>`;
  }

  function safeguardStrip() {
    const trust = state.workspace?.trust || {};
    return `<section class="settings-safeguard-strip">
      <i data-lucide="shield-check"></i>
      <div><strong>Safety boundary</strong><span>Production sync ${trust.production_sync_enabled ? 'enabled' : 'off'} · Social auto-publishing off · Reorder execution off · Brain automatic execution off · No secrets returned</span></div>
    </section>`;
  }

  function overviewMarkup() {
    const workspace = state.workspace || {};
    const profiles = workspace.profiles_summary || {};
    const integrations = workspace.integrations || [];
    const connected = integrations.filter((entry) => entry.status === 'connected').length;
    const requiredSafeguards = [
      ['Production synchronization', !workspace.trust?.production_sync_enabled],
      ['Automatic social publishing', !workspace.trust?.automatic_social_publishing_enabled],
      ['Automatic reorder execution', !workspace.trust?.automatic_reorder_execution_enabled],
      ['Automatic Brain execution', !workspace.trust?.automatic_brain_execution_enabled]
    ];
    const quickSections = [
      ['general', 'building-2', 'Venue & hours', 'Business identity, opening hours and active offers.'],
      ['access', 'users-round', 'Team access', 'Role permissions and active staff profile summary.'],
      ['operations', 'clipboard-check', 'Operational rules', 'Inventory, temperature and cleaning defaults.'],
      ['intelligence', 'brain-circuit', 'Marketing & Brain', 'Approval, learning, evidence and recommendation rules.'],
      ['integrations', 'plug-zap', 'Integrations', 'Verified connection and permission states.'],
      ['preferences', 'palette', 'Preferences', 'Theme, language, density and personal notifications.']
    ];
    return `<div class="settings-overview">
      <section class="settings-summary-grid">
        <article><span><i data-lucide="layers-3"></i>Configuration areas</span><strong>${(workspace.sections || []).length}</strong><small>Private, versioned sections</small></article>
        <article><span><i data-lucide="users-round"></i>Active profiles</span><strong>${Number(profiles.active || 0)}</strong><small>${Number(profiles.inactive || 0)} inactive</small></article>
        <article><span><i data-lucide="plug-zap"></i>Connected integrations</span><strong>${connected}</strong><small>${Math.max(0, integrations.length - connected)} not fully connected</small></article>
        <article><span><i data-lucide="bell-ring"></i>Notification policies</span><strong>${(workspace.notification_policies || []).filter((entry) => entry.enabled).length}</strong><small>${(workspace.notification_policies || []).length} policies configured</small></article>
      </section>
      ${sectionHead('Configuration map', 'Atlas control centre', 'Every business rule has one clear home and a visible safety boundary.')}
      <section class="settings-quick-grid">${quickSections.map(([tab, icon, title, description]) => `<button type="button" data-settings-tab-jump="${tab}"><i data-lucide="${icon}"></i><span><strong>${title}</strong><small>${description}</small></span><i data-lucide="arrow-right"></i></button>`).join('')}</section>
      <section class="settings-overview-split">
        <article class="settings-panel">
          <header><div><span>Safeguards</span><h2>Locked by policy</h2></div>${statusPill('active', 'Protected')}</header>
          <div class="settings-safeguard-list">${requiredSafeguards.map(([label, safe]) => `<div><i data-lucide="${safe ? 'shield-check' : 'shield-alert'}"></i><span><strong>${label}</strong><small>${safe ? 'Disabled as required' : 'Needs immediate review'}</small></span>${statusPill(safe ? 'connected' : 'error', safe ? 'Off' : 'On')}</div>`).join('')}</div>
        </article>
        <article class="settings-panel">
          <header><div><span>Current venue</span><h2>${escapeHtml(section('venue')?.value?.business_name || 'VÁ Bar')}</h2></div></header>
          <dl class="settings-definition-list">
            <div><dt>Location</dt><dd>${escapeHtml(section('venue')?.value?.location_label || 'Not configured')}</dd></div>
            <div><dt>Timezone</dt><dd>${escapeHtml(section('venue')?.value?.timezone || 'Not configured')}</dd></div>
            <div><dt>Currency</dt><dd>${escapeHtml(section('venue')?.value?.currency || 'ISK')}</dd></div>
            <div><dt>Week starts</dt><dd>${escapeHtml(WEEKDAYS[Number(section('operations')?.value?.week_starts_on ?? 1)])}</dd></div>
          </dl>
        </article>
      </section>
      ${safeguardStrip()}
    </div>`;
  }

  function inputField(label, name, value, options = {}) {
    const type = options.type || 'text';
    const disabled = options.disabled ? 'disabled' : '';
    const required = options.required ? 'required' : '';
    const min = options.min !== undefined ? `min="${escapeHtml(options.min)}"` : '';
    const max = options.max !== undefined ? `max="${escapeHtml(options.max)}"` : '';
    const step = options.step !== undefined ? `step="${escapeHtml(options.step)}"` : '';
    const placeholder = options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : '';
    const note = options.note ? `<small>${escapeHtml(options.note)}</small>` : '';
    if (type === 'textarea') {
      return `<label class="settings-field ${options.full ? 'is-full' : ''}"><span>${escapeHtml(label)}</span><textarea name="${escapeHtml(name)}" ${disabled} ${required} ${placeholder}>${escapeHtml(value ?? '')}</textarea>${note}</label>`;
    }
    if (type === 'select') {
      return `<label class="settings-field ${options.full ? 'is-full' : ''}"><span>${escapeHtml(label)}</span><select name="${escapeHtml(name)}" ${disabled} ${required}>${(options.choices || []).map(([choiceValue, choiceLabel]) => `<option value="${escapeHtml(choiceValue)}" ${String(value) === String(choiceValue) ? 'selected' : ''}>${escapeHtml(choiceLabel)}</option>`).join('')}</select>${note}</label>`;
    }
    return `<label class="settings-field ${options.full ? 'is-full' : ''}"><span>${escapeHtml(label)}</span><input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}" ${disabled} ${required} ${min} ${max} ${step} ${placeholder}>${note}</label>`;
  }

  function checkboxField(label, name, checked, options = {}) {
    return `<label class="settings-toggle ${options.disabled ? 'is-disabled' : ''}"><input type="checkbox" name="${escapeHtml(name)}" ${checked ? 'checked' : ''} ${options.disabled ? 'disabled' : ''}><span><i></i></span><div><strong>${escapeHtml(label)}</strong>${options.note ? `<small>${escapeHtml(options.note)}</small>` : ''}</div></label>`;
  }

  function saveFooter(sectionData, label = 'Save changes') {
    if (!sectionData?.can_edit) return `<footer class="settings-form-footer"><span><i data-lucide="eye"></i>Read-only for your role</span></footer>`;
    return `<footer class="settings-form-footer"><span>Version ${Number(sectionData.version || 1)} · Last updated ${escapeHtml(formatDateTime(sectionData.updated_at))}</span><button type="submit" class="settings-primary" ${state.saving ? 'disabled' : ''}><i data-lucide="save"></i>${state.saving ? 'Saving…' : escapeHtml(label)}</button></footer>`;
  }

  function venueFormMarkup() {
    const data = section('venue');
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    return `<form class="settings-card settings-form" data-settings-section-form="venue" data-version="${Number(data?.version || 1)}">
      <header><div><span>Business identity</span><h3>Venue profile</h3><p>The business details Atlas uses in operational context and public-facing recommendations.</p></div>${statusPill(data?.status || 'active')}</header>
      <div class="settings-form-grid">
        ${inputField('Business name', 'business_name', value.business_name, { required: true, disabled })}
        ${inputField('Legal name', 'legal_name', value.legal_name, { required: true, disabled })}
        ${inputField('Registration number', 'registration_number', value.registration_number, { disabled })}
        ${inputField('Location label', 'location_label', value.location_label, { disabled })}
        ${inputField('Address', 'address_line', value.address_line, { disabled })}
        ${inputField('City', 'city', value.city, { disabled })}
        ${inputField('Country code', 'country_code', value.country_code, { disabled, max: 2 })}
        ${inputField('Timezone', 'timezone', value.timezone, { disabled, required: true })}
        ${inputField('Currency', 'currency', value.currency, { disabled: true, note: 'Checkpoint J currently uses ISK.' })}
        ${inputField('Primary language', 'primary_language', value.primary_language, { type: 'select', choices: [['en', 'English'], ['is', 'Íslenska']], disabled })}
        ${inputField('Email', 'email', value.email, { type: 'email', disabled })}
        ${inputField('Phone', 'phone', value.phone, { type: 'tel', disabled })}
        ${inputField('Website', 'website', value.website, { type: 'url', disabled })}
        ${inputField('Booking URL', 'booking_url', value.booking_url, { type: 'url', disabled })}
      </div>
      ${saveFooter(data, 'Save venue')}
    </form>`;
  }

  function hoursMarkup() {
    const hours = state.workspace?.business_hours || [];
    const editable = canManage();
    return `<form class="settings-card settings-hours-form" data-settings-hours-form>
      <header><div><span>Weekly schedule</span><h3>Business hours</h3><p>Opening, closing, kitchen close and last-order times for every day.</p></div>${editable ? statusPill('active', 'Editable') : statusPill('not_connected', 'Read only')}</header>
      <div class="settings-hours-table">
        <div class="settings-hours-head"><span>Day</span><span>Open</span><span>Opening</span><span>Closing</span><span>Next day</span><span>Kitchen close</span><span>Last order</span></div>
        ${hours.map((row) => `<div class="settings-hours-row" data-weekday="${Number(row.weekday)}">
          <strong>${escapeHtml(row.day_label)}</strong>
          <label class="settings-mini-toggle"><input type="checkbox" name="is_open" ${row.is_open ? 'checked' : ''} ${editable ? '' : 'disabled'}><span></span></label>
          <input type="time" name="open_time" value="${escapeHtml(row.open_time || '')}" ${editable ? '' : 'disabled'}>
          <input type="time" name="close_time" value="${escapeHtml(row.close_time || '')}" ${editable ? '' : 'disabled'}>
          <label class="settings-mini-toggle"><input type="checkbox" name="close_next_day" ${row.close_next_day ? 'checked' : ''} ${editable ? '' : 'disabled'}><span></span></label>
          <input type="time" name="kitchen_close_time" value="${escapeHtml(row.kitchen_close_time || '')}" ${editable ? '' : 'disabled'}>
          <input type="time" name="last_order_time" value="${escapeHtml(row.last_order_time || '')}" ${editable ? '' : 'disabled'}>
        </div>`).join('')}
      </div>
      <footer class="settings-form-footer"><span>All times use Atlantic/Reykjavik.</span>${editable ? `<button type="submit" class="settings-primary" ${state.saving ? 'disabled' : ''}><i data-lucide="save"></i>Save hours</button>` : '<span><i data-lucide="eye"></i>Read-only for your role</span>'}</footer>
    </form>`;
  }

  function offerFormMarkup(offer, isNew = false) {
    const editable = canManage();
    const pricing = JSON.stringify(offer?.pricing || {}, null, 2);
    const id = offer?.id || '';
    const days = Array.isArray(offer?.days) ? offer.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    return `<form class="settings-offer-card" data-settings-offer-form data-offer-id="${escapeHtml(id)}" data-version="${Number(offer?.version || 1)}">
      <header><div><span>${isNew ? 'New offer' : 'Offer schedule'}</span><h3>${escapeHtml(offer?.name || 'New offer')}</h3></div>${statusPill(offer?.active === false ? 'not_connected' : 'active', offer?.active === false ? 'Inactive' : 'Active')}</header>
      <div class="settings-form-grid is-compact">
        ${inputField('Offer key', 'offer_key', offer?.offer_key || '', { required: true, disabled: !editable, note: 'Lowercase letters, numbers and hyphens.' })}
        ${inputField('Name', 'name', offer?.name || '', { required: true, disabled: !editable })}
        ${inputField('Description', 'description', offer?.description || '', { type: 'textarea', full: true, disabled: !editable })}
        ${inputField('Start time', 'start_time', offer?.start_time || '15:00', { type: 'time', required: true, disabled: !editable })}
        ${inputField('End time', 'end_time', offer?.end_time || '18:00', { type: 'time', required: true, disabled: !editable })}
        ${inputField('Booking URL', 'booking_url', offer?.booking_url || '', { type: 'url', full: true, disabled: !editable })}
        ${inputField('Pricing / offer JSON', 'pricing_json', pricing, { type: 'textarea', full: true, disabled: !editable, note: 'Example: {"cocktails_isk":1990,"wine_isk":1090}' })}
      </div>
      <div class="settings-offer-days"><span>Active days</span>${WEEKDAYS.map((day, weekday) => `<label><input type="checkbox" name="day_${weekday}" ${days.includes(weekday) ? 'checked' : ''} ${editable ? '' : 'disabled'}><b>${day.slice(0, 3)}</b></label>`).join('')}</div>
      <div class="settings-toggle-grid">
        ${checkboxField('Offer active', 'active', offer?.active !== false, { disabled: !editable })}
        ${checkboxField('Ends next day', 'end_next_day', Boolean(offer?.end_next_day), { disabled: !editable })}
      </div>
      <footer class="settings-form-footer"><span>${isNew ? 'Creates a new private offer rule.' : `Version ${Number(offer?.version || 1)}`}</span>${editable ? `<div class="settings-button-row">${isNew ? '<button type="button" class="settings-secondary" data-settings-cancel-offer>Cancel</button>' : ''}<button type="submit" class="settings-primary" ${state.saving ? 'disabled' : ''}><i data-lucide="save"></i>${isNew ? 'Create offer' : 'Save offer'}</button></div>` : '<span><i data-lucide="eye"></i>Read-only</span>'}</footer>
    </form>`;
  }

  function generalMarkup() {
    const offers = state.workspace?.offers || [];
    return `<div class="settings-general">
      ${sectionHead('Venue configuration', 'Venue, hours & offers', 'Manage the details that define when and where VÁ operates.', canManage() ? '<button type="button" class="settings-secondary" data-settings-add-offer><i data-lucide="plus"></i>Add offer</button>' : '')}
      ${venueFormMarkup()}
      ${hoursMarkup()}
      <section class="settings-stack-head"><div><span>Active promotions</span><h2>Offer schedules</h2></div><em>${offers.length} configured</em></section>
      <div class="settings-offer-grid">${state.offerDraft ? offerFormMarkup(state.offerDraft, true) : ''}${offers.map((offer) => offerFormMarkup(offer)).join('')}</div>
    </div>`;
  }

  function permissionKeys() {
    const keys = new Set();
    (state.workspace?.roles || []).forEach((role) => Object.keys(role.permissions || {}).forEach((key) => keys.add(key)));
    return [...keys].sort();
  }

  function accessMarkup() {
    const roles = state.workspace?.roles || [];
    const profiles = state.workspace?.profiles_summary || {};
    const permissions = permissionKeys();
    return `<div class="settings-access">
      ${sectionHead('Role governance', 'Team access', 'Define what each Atlas role may view, manage, approve or publish.')}
      <section class="settings-profile-summary">
        <article><span>Total profiles</span><strong>${Number(profiles.total || 0)}</strong></article>
        <article><span>Active</span><strong>${Number(profiles.active || 0)}</strong></article>
        <article><span>Inactive</span><strong>${Number(profiles.inactive || 0)}</strong></article>
        ${Object.entries(profiles.roles || {}).map(([role, count]) => `<article><span>${escapeHtml(ROLE_LABELS[role] || humanize(role))}</span><strong>${Number(count || 0)}</strong></article>`).join('')}
      </section>
      <div class="settings-role-grid">${roles.map((role) => `<form class="settings-card settings-role-card" data-settings-role-form="${escapeHtml(role.role_key)}" data-version="${Number(role.version || 1)}">
        <header><div><span>System role</span><h3>${escapeHtml(role.label)}</h3><p>${escapeHtml(role.description || '')}</p></div>${role.can_edit ? statusPill('active', 'Editable') : statusPill('not_connected', 'Protected')}</header>
        <div class="settings-permission-list">${permissions.map((permission) => `<label><input type="checkbox" name="permission_${escapeHtml(permission)}" ${role.permissions?.[permission] ? 'checked' : ''} ${role.can_edit ? '' : 'disabled'}><span><strong>${escapeHtml(humanize(permission))}</strong><small>${escapeHtml(permission)}</small></span></label>`).join('')}</div>
        <footer class="settings-form-footer"><span>Version ${Number(role.version || 1)}</span>${role.can_edit ? `<button type="submit" class="settings-primary" ${state.saving ? 'disabled' : ''}><i data-lucide="save"></i>Save permissions</button>` : '<span><i data-lucide="lock-keyhole"></i>Protected role</span>'}</footer>
      </form>`).join('')}</div>
      <section class="settings-note-card"><i data-lucide="info"></i><div><strong>Profile roles are assigned in Team Profiles</strong><span>This page defines capabilities. Changing a person’s active role remains in PEOPLE → Profiles.</span></div></section>
    </div>`;
  }

  function notificationsMarkup() {
    const policies = state.workspace?.notification_policies || [];
    return `<div class="settings-notifications">
      ${sectionHead('Notification governance', 'Notifications', 'Choose which operational events appear in Atlas and which channels may be used.')}
      <section class="settings-note-card"><i data-lucide="bell-ring"></i><div><strong>Browser and email delivery require permission</strong><span>Saving a channel enables the policy only. Atlas never claims delivery is available until the relevant browser or integration permission is granted.</span></div></section>
      <div class="settings-notification-grid">${policies.map((policy) => `<form class="settings-card settings-notification-card" data-settings-notification-form="${escapeHtml(policy.event_key)}" data-version="${Number(policy.version || 1)}">
        <header><div><span>${escapeHtml(policy.category)}</span><h3>${escapeHtml(policy.label)}</h3></div>${statusPill(policy.enabled ? 'active' : 'not_connected', policy.enabled ? 'Enabled' : 'Disabled')}</header>
        <div class="settings-toggle-grid">
          ${checkboxField('Policy enabled', 'enabled', Boolean(policy.enabled), { disabled: !policy.can_edit })}
          ${checkboxField('Manager approval', 'manager_approval_required', Boolean(policy.manager_approval_required), { disabled: !policy.can_edit })}
        </div>
        <fieldset><legend>Channels</legend><div class="settings-check-row">${NOTIFICATION_CHANNELS.map((channel) => `<label><input type="checkbox" name="channel_${channel}" ${policy.channels?.[channel] ? 'checked' : ''} ${policy.can_edit ? '' : 'disabled'}><span>${escapeHtml(channel === 'in_app' ? 'In Atlas' : humanize(channel))}</span></label>`).join('')}</div></fieldset>
        <fieldset><legend>Target roles</legend><div class="settings-check-row">${ROLE_KEYS.map((role) => `<label><input type="checkbox" name="role_${role}" ${(policy.target_roles || []).includes(role) ? 'checked' : ''} ${policy.can_edit ? '' : 'disabled'}><span>${escapeHtml(ROLE_LABELS[role])}</span></label>`).join('')}</div></fieldset>
        <div class="settings-form-grid is-compact">
          ${inputField('Reminder minutes', 'reminder_minutes', (policy.reminder_minutes || []).join(', '), { disabled: !policy.can_edit, note: 'Comma-separated, e.g. 1440, 120, 0.' })}
          ${inputField('Escalation minutes', 'escalation_minutes', policy.escalation_minutes ?? '', { type: 'number', min: 0, max: 43200, disabled: !policy.can_edit })}
        </div>
        <footer class="settings-form-footer"><span>Version ${Number(policy.version || 1)}</span>${policy.can_edit ? `<button type="submit" class="settings-primary" ${state.saving ? 'disabled' : ''}><i data-lucide="save"></i>Save policy</button>` : '<span>Read-only</span>'}</footer>
      </form>`).join('')}</div>
    </div>`;
  }

  function operationsSectionForm(key) {
    const data = section(key);
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    let fields = '';
    if (key === 'operations') {
      fields = `<div class="settings-form-grid">
        ${inputField('Week starts on', 'week_starts_on', value.week_starts_on, { type: 'select', choices: WEEKDAYS.map((day, index) => [index, day]), disabled })}
        ${inputField('Default break minutes', 'default_break_minutes', value.default_break_minutes, { type: 'number', min: 0, max: 720, disabled })}
        ${inputField('Last order before close (minutes)', 'last_order_minutes_before_close', value.last_order_minutes_before_close, { type: 'number', min: 0, max: 240, disabled })}
      </div><div class="settings-toggle-grid">
        ${checkboxField('Shift confirmation required', 'shift_confirmation_required', Boolean(value.shift_confirmation_required), { disabled })}
        ${checkboxField('Service Mode enabled', 'service_mode_enabled', Boolean(value.service_mode_enabled), { disabled })}
        ${checkboxField('Production shift sync', 'production_shift_sync_enabled', false, { disabled: true, note: 'Locked off in preview.' })}
      </div>`;
    } else if (key === 'inventory') {
      fields = `<div class="settings-form-grid">
        ${inputField('Critical stock ratio', 'critical_stock_ratio', value.critical_stock_ratio, { type: 'number', min: 0, max: 1, step: 0.05, disabled })}
        ${inputField('Variance tolerance %', 'variance_tolerance_percent', value.variance_tolerance_percent, { type: 'number', min: 0, max: 100, step: 0.1, disabled })}
        ${inputField('Waste tolerance %', 'waste_tolerance_percent', value.waste_tolerance_percent, { type: 'number', min: 0, max: 100, step: 0.1, disabled })}
      </div><div class="settings-toggle-grid">
        ${checkboxField('Low-stock warnings', 'low_stock_warning_enabled', Boolean(value.low_stock_warning_enabled), { disabled })}
        ${checkboxField('Reorder suggestions', 'automatic_reorder_suggestions', Boolean(value.automatic_reorder_suggestions), { disabled })}
        ${checkboxField('Gallery in scanner', 'barcode_gallery_enabled', Boolean(value.barcode_gallery_enabled), { disabled })}
        ${checkboxField('Multiple barcodes per item', 'allow_multiple_barcodes', Boolean(value.allow_multiple_barcodes), { disabled })}
        ${checkboxField('Staff barcode linking', 'staff_barcode_linking', Boolean(value.staff_barcode_linking), { disabled })}
        ${checkboxField('Automatic reorder execution', 'automatic_reorder_execution', false, { disabled: true, note: 'Locked off.' })}
        ${checkboxField('Scanner live quantity apply', 'live_quantity_apply', false, { disabled: true, note: 'Locked off.' })}
      </div>`;
    } else if (key === 'temperature') {
      fields = `<div class="settings-form-grid">
        ${inputField('Reminder times', 'reminder_times', (value.reminder_times || []).join(', '), { disabled, note: 'Comma-separated HH:MM times.' })}
        ${inputField('Escalation minutes', 'escalation_minutes', value.escalation_minutes, { type: 'number', min: 0, max: 1440, disabled })}
        ${inputField('Retention months', 'retention_months', value.retention_months, { type: 'number', min: 1, max: 120, disabled })}
      </div><div class="settings-toggle-grid">
        ${checkboxField('Daily log required', 'daily_log_required', Boolean(value.daily_log_required), { disabled })}
        ${checkboxField('Photo on exception', 'photo_required_on_exception', Boolean(value.photo_required_on_exception), { disabled })}
        ${checkboxField('Corrective action required', 'corrective_action_required', Boolean(value.corrective_action_required), { disabled })}
        ${checkboxField('Manager review on exception', 'manager_review_on_exception', Boolean(value.manager_review_on_exception), { disabled })}
      </div>`;
    } else if (key === 'cleaning') {
      const schedule = value.weekly_schedule || {};
      fields = `<div class="settings-form-grid">
        ${inputField('Sunday routine', 'schedule_sunday', schedule.sunday || '', { disabled })}
        ${inputField('Monday routine', 'schedule_monday', schedule.monday || '', { disabled })}
        ${inputField('Tuesday routine', 'schedule_tuesday', schedule.tuesday || '', { disabled })}
        ${inputField('Overdue escalation minutes', 'overdue_escalation_minutes', value.overdue_escalation_minutes, { type: 'number', min: 0, max: 1440, disabled })}
      </div><div class="settings-toggle-grid">
        ${checkboxField('Photo evidence required', 'photo_required', Boolean(value.photo_required), { disabled })}
        ${checkboxField('Comment on exception', 'comment_required_on_exception', Boolean(value.comment_required_on_exception), { disabled })}
        ${checkboxField('Manager review on exception', 'manager_review_on_exception', Boolean(value.manager_review_on_exception), { disabled })}
      </div>`;
    }
    return `<form class="settings-card settings-form" data-settings-section-form="${escapeHtml(key)}" data-version="${Number(data?.version || 1)}">
      <header><div><span>${escapeHtml(data?.label || humanize(key))}</span><h3>${escapeHtml(data?.label || humanize(key))} rules</h3><p>${escapeHtml(data?.description || '')}</p></div>${statusPill(data?.status || 'active')}</header>
      ${fields}
      ${saveFooter(data, `Save ${data?.label || humanize(key)}`)}
    </form>`;
  }

  function operationsMarkup() {
    return `<div class="settings-operations">
      ${sectionHead('Operational defaults', 'Inventory, temperature & cleaning', 'Configure reminders, evidence rules, thresholds and shift defaults without enabling live automation.')}
      <div class="settings-two-column">${['operations', 'inventory', 'temperature', 'cleaning'].map(operationsSectionForm).join('')}</div>
      ${safeguardStrip()}
    </div>`;
  }

  function marketingFormMarkup() {
    const data = section('marketing');
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    return `<form class="settings-card settings-form" data-settings-section-form="marketing" data-version="${Number(data?.version || 1)}">
      <header><div><span>Content governance</span><h3>Marketing</h3><p>${escapeHtml(data?.description || '')}</p></div>${statusPill(data?.status || 'active')}</header>
      <div class="settings-form-grid">
        ${inputField('Brand voice', 'brand_voice', value.brand_voice, { type: 'textarea', full: true, disabled })}
        ${inputField('Default Story frames', 'default_story_frames', value.default_story_frames, { type: 'number', min: 1, max: 10, disabled })}
      </div>
      <div class="settings-toggle-grid">
        ${checkboxField('Approval required', 'approval_required', Boolean(value.approval_required), { disabled })}
        ${checkboxField('AI caption drafts', 'ai_caption_drafts_enabled', Boolean(value.ai_caption_drafts_enabled), { disabled })}
        ${checkboxField('Automatic publishing', 'automatic_publishing_enabled', false, { disabled: true, note: 'Locked until authorization.' })}
        ${checkboxField('Analytics ingestion', 'analytics_ingestion_enabled', false, { disabled: true, note: 'Locked until authorization.' })}
      </div>
      ${saveFooter(data, 'Save marketing rules')}
    </form>`;
  }

  function brainFormMarkup() {
    const data = section('brain');
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    return `<form class="settings-card settings-form" data-settings-section-form="brain" data-version="${Number(data?.version || 1)}">
      <header><div><span>Decision intelligence</span><h3>Atlas Brain</h3><p>${escapeHtml(data?.description || '')}</p></div>${statusPill(data?.status || 'active')}</header>
      <div class="settings-form-grid">
        ${inputField('Brain mode', 'mode', value.mode, { type: 'select', choices: [['assistant', 'Assistant only'], ['learning', 'Learning'], ['shadow', 'Shadow mode'], ['recommendation', 'Recommendation mode'], ['predictive', 'Predictive mode']], disabled })}
        ${inputField('Explanation level', 'explanation_level', value.explanation_level, { type: 'select', choices: [['brief', 'Brief'], ['evidence', 'Evidence cards'], ['technical', 'Technical']], disabled })}
        ${inputField('Evidence mode', 'evidence_mode', value.evidence_mode, { type: 'select', choices: [['strict', 'Strict'], ['normal', 'Normal'], ['experimental', 'Experimental']], disabled })}
      </div>
      <div class="settings-toggle-grid">
        ${checkboxField('Decision memory', 'decision_memory_enabled', Boolean(value.decision_memory_enabled), { disabled })}
        ${checkboxField('Purchase learning', 'purchase_learning_enabled', Boolean(value.purchase_learning_enabled), { disabled })}
        ${checkboxField('Menu learning', 'menu_learning_enabled', Boolean(value.menu_learning_enabled), { disabled })}
        ${checkboxField('Waste learning', 'waste_learning_enabled', Boolean(value.waste_learning_enabled), { disabled })}
        ${checkboxField('Forecast learning', 'forecast_learning_enabled', Boolean(value.forecast_learning_enabled), { disabled })}
        ${checkboxField('Automatic execution', 'automatic_execution_enabled', false, { disabled: true, note: 'Locked off. Recommendations require human approval.' })}
      </div>
      ${saveFooter(data, 'Save Brain rules')}
    </form>`;
  }

  function intelligenceMarkup() {
    return `<div class="settings-intelligence">
      ${sectionHead('Growth & intelligence', 'Marketing & Atlas Brain', 'Control drafting, approvals, evidence standards and learning behaviour.')}
      <div class="settings-two-column">${marketingFormMarkup()}${brainFormMarkup()}</div>
      ${safeguardStrip()}
    </div>`;
  }

  function integrationsMarkup() {
    const integrations = state.workspace?.integrations || [];
    return `<div class="settings-integrations">
      ${sectionHead('Connection boundaries', 'Integrations', 'Read the verified authorization and permission state of each service. Connection flows remain in their owning integration workspace.')}
      <section class="settings-note-card"><i data-lucide="shield-check"></i><div><strong>No credentials are stored here</strong><span>Settings displays status and capability boundaries only. Passwords, API keys and access tokens never enter this workspace.</span></div></section>
      <div class="settings-integration-grid">${integrations.map((integration) => `<article class="settings-integration-card is-${statusTone(integration.status)}">
        <header><span><i data-lucide="${integration.status === 'connected' ? 'plug-zap' : 'unplug'}"></i></span><div><small>${escapeHtml(humanize(integration.category))}</small><h3>${escapeHtml(integration.label)}</h3></div>${statusPill(integration.status)}</header>
        <dl class="settings-definition-list">
          <div><dt>Authorization</dt><dd>${escapeHtml(humanize(integration.authorization_state))}</dd></div>
          <div><dt>Publishing</dt><dd>${escapeHtml(humanize(integration.publishing_permission_state))}</dd></div>
          <div><dt>Analytics</dt><dd>${escapeHtml(humanize(integration.analytics_permission_state))}</dd></div>
          <div><dt>Last verified</dt><dd>${escapeHtml(formatDateTime(integration.last_verified_at))}</dd></div>
        </dl>
        ${integration.last_connection_error ? `<p>${escapeHtml(integration.last_connection_error)}</p>` : ''}
      </article>`).join('')}</div>
    </div>`;
  }

  function securityMarkup() {
    const data = section('security');
    const value = data?.value || {};
    const editable = Boolean(data?.can_edit && canManageSecurity());
    return `<div class="settings-security">
      ${sectionHead('Administrative safeguards', 'Security', 'Security preferences are separate from secrets, access tokens and authentication-provider controls.')}
      <section class="settings-note-card is-warning"><i data-lucide="lock-keyhole"></i><div><strong>Administrator-only section</strong><span>Managers may review safeguards. Only an Administrator can save this section, and destructive or production controls remain locked off.</span></div></section>
      <form class="settings-card settings-form" data-settings-section-form="security" data-version="${Number(data?.version || 1)}">
        <header><div><span>Session & devices</span><h3>Security preferences</h3><p>${escapeHtml(data?.description || '')}</p></div>${statusPill(data?.status || 'locked')}</header>
        <div class="settings-form-grid">
          ${inputField('Session timeout (minutes)', 'session_timeout_minutes', value.session_timeout_minutes, { type: 'number', min: 15, max: 1440, disabled: !editable })}
        </div>
        <div class="settings-toggle-grid">
          ${checkboxField('Require two-factor authentication', 'two_factor_required', Boolean(value.two_factor_required), { disabled: !editable, note: 'Requires Auth provider support.' })}
          ${checkboxField('Trusted devices', 'trusted_devices_enabled', Boolean(value.trusted_devices_enabled), { disabled: !editable, note: 'Future device-approval boundary.' })}
          ${checkboxField('Emergency lockdown', 'emergency_lockdown_enabled', Boolean(value.emergency_lockdown_enabled), { disabled: !editable, note: 'Preference only; no destructive action is wired.' })}
          ${checkboxField('Password policy managed by Auth', 'password_policy_managed_by_auth', Boolean(value.password_policy_managed_by_auth), { disabled: !editable })}
          ${checkboxField('API keys visible', 'api_keys_visible', false, { disabled: true, note: 'Always off.' })}
          ${checkboxField('Production synchronization', 'production_sync_enabled', false, { disabled: true, note: 'Always off in preview.' })}
          ${checkboxField('Destructive actions', 'destructive_actions_enabled', false, { disabled: true, note: 'Always off.' })}
        </div>
        ${editable ? saveFooter(data, 'Save security preferences') : '<footer class="settings-form-footer"><span><i data-lucide="lock-keyhole"></i>Administrator access required</span></footer>'}
      </form>
      ${safeguardStrip()}
    </div>`;
  }

  function appearanceSectionMarkup() {
    const data = section('appearance');
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    return `<form class="settings-card settings-form" data-settings-section-form="appearance" data-version="${Number(data?.version || 1)}">
      <header><div><span>Organization defaults</span><h3>Default appearance</h3><p>${escapeHtml(data?.description || '')}</p></div>${statusPill(data?.status || 'active')}</header>
      <div class="settings-form-grid">
        ${inputField('Theme', 'theme', value.theme, { type: 'select', choices: [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], disabled })}
        ${inputField('Density', 'density', value.density, { type: 'select', choices: [['comfortable', 'Comfortable'], ['compact', 'Compact']], disabled })}
        ${inputField('Language', 'language', value.language, { type: 'select', choices: [['en', 'English'], ['is', 'Íslenska']], disabled })}
        ${inputField('Date format', 'date_format', value.date_format, { type: 'select', choices: [['DD/MM/YYYY', 'DD/MM/YYYY'], ['YYYY-MM-DD', 'YYYY-MM-DD']], disabled })}
        ${inputField('Time format', 'time_format', value.time_format, { type: 'select', choices: [['24h', '24 hour'], ['12h', '12 hour']], disabled })}
        ${inputField('Start view', 'start_view', value.start_view, { type: 'select', choices: START_VIEWS, disabled })}
      </div>
      <div class="settings-toggle-grid">${checkboxField('Reduce motion by default', 'reduce_motion', Boolean(value.reduce_motion), { disabled })}</div>
      ${saveFooter(data, 'Save defaults')}
    </form>`;
  }

  function modulesMarkup() {
    const data = section('modules');
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    const moduleKeys = ['operations', 'scanner', 'messages', 'marketing', 'profiles', 'shifts', 'knowledge', 'reports', 'system', 'settings'];
    return `<form class="settings-card settings-form" data-settings-section-form="modules" data-version="${Number(data?.version || 1)}">
      <header><div><span>Feature availability</span><h3>Modules</h3><p>${escapeHtml(data?.description || '')}</p></div>${statusPill(value.reports_state || 'active', value.reports_state === 'blocked' ? 'Reports blocked' : humanize(value.reports_state))}</header>
      <div class="settings-toggle-grid">${moduleKeys.map((key) => checkboxField(humanize(key), key, Boolean(value[key]), { disabled: disabled || ['system', 'settings'].includes(key), note: ['system', 'settings'].includes(key) ? 'Core module.' : key === 'reports' ? 'Reports remains a release blocker.' : '' })).join('')}</div>
      <div class="settings-form-grid">
        ${inputField('Reports state', 'reports_state', value.reports_state, { type: 'select', choices: [['blocked', 'Blocked'], ['degraded', 'Degraded'], ['ready', 'Ready']], disabled })}
      </div>
      ${checkboxField('Production synchronization', 'production_sync_enabled', false, { disabled: true, note: 'Locked off.' })}
      ${saveFooter(data, 'Save module availability')}
    </form>`;
  }

  function personalPreferencesMarkup() {
    const preference = state.workspace?.preferences || {};
    return `<form class="settings-card settings-form" data-settings-preferences-form>
      <header><div><span>Your Atlas experience</span><h3>Personal preferences</h3><p>These values belong to your active profile and do not change organization defaults.</p></div>${statusPill('active', 'Personal')}</header>
      <div class="settings-form-grid">
        ${inputField('Theme', 'theme', preference.theme || 'dark', { type: 'select', choices: [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] })}
        ${inputField('Density', 'density', preference.density || 'comfortable', { type: 'select', choices: [['comfortable', 'Comfortable'], ['compact', 'Compact']] })}
        ${inputField('Language', 'language', preference.language || 'en', { type: 'select', choices: [['en', 'English'], ['is', 'Íslenska']] })}
        ${inputField('Start view', 'start_view', preference.start_view || 'briefing', { type: 'select', choices: START_VIEWS })}
        ${inputField('Timezone', 'timezone', preference.timezone || 'Atlantic/Reykjavik', {})}
      </div>
      <div class="settings-toggle-grid">
        ${checkboxField('Reduce motion', 'reduce_motion', Boolean(preference.reduce_motion))}
        ${checkboxField('Browser notifications', 'browser_notifications', Boolean(preference.browser_notifications), { note: 'Requires browser permission.' })}
        ${checkboxField('Email notifications', 'email_notifications', Boolean(preference.email_notifications), { note: 'Delivery requires a connected email workflow.' })}
      </div>
      <footer class="settings-form-footer"><span>Saved only for ${escapeHtml(state.staff?.label || 'your profile')}.</span><button type="submit" class="settings-primary" ${state.saving ? 'disabled' : ''}><i data-lucide="save"></i>Save preferences</button></footer>
    </form>`;
  }

  function preferencesMarkup() {
    return `<div class="settings-preferences">
      ${sectionHead('Personal & organization defaults', 'Preferences & modules', 'Set your own Atlas experience and review organization-wide appearance and feature availability.')}
      <div class="settings-two-column">${personalPreferencesMarkup()}${appearanceSectionMarkup()}${modulesMarkup()}</div>
    </div>`;
  }

  function activityMarkup() {
    const events = state.workspace?.events || [];
    return `<div class="settings-activity">
      ${sectionHead('Change history', 'Settings activity', 'Versioned, private audit evidence for organization and personal preference changes.')}
      <section class="settings-note-card"><i data-lucide="history"></i><div><strong>Audit is read-only</strong><span>Before and after values remain in the private Settings history. This screen cannot alter or delete audit events.</span></div></section>
      <div class="settings-activity-list">${events.length ? events.map((event) => `<article><span class="settings-activity-icon"><i data-lucide="${event.event_type === 'settings_checkpoint_created' ? 'flag' : 'pencil-line'}"></i></span><div><small>${escapeHtml(humanize(event.section_key || 'settings'))}</small><strong>${escapeHtml(humanize(event.event_type))}</strong><p>${escapeHtml(event.actor_label || 'Atlas system')} · ${escapeHtml(formatDateTime(event.created_at))}</p></div><code>${escapeHtml(event.entity_key || '')}</code></article>`).join('') : '<div class="settings-empty"><i data-lucide="history"></i><span>No Settings changes have been recorded yet.</span></div>'}</div>
    </div>`;
  }

  function activeTabMarkup() {
    switch (state.activeTab) {
      case 'general': return generalMarkup();
      case 'access': return accessMarkup();
      case 'notifications': return notificationsMarkup();
      case 'operations': return operationsMarkup();
      case 'intelligence': return intelligenceMarkup();
      case 'integrations': return integrationsMarkup();
      case 'security': return securityMarkup();
      case 'preferences': return preferencesMarkup();
      case 'activity': return activityMarkup();
      default: return overviewMarkup();
    }
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.add('settings-view');
    if (state.loading && !state.workspace) {
      element.innerHTML = loadingMarkup();
      window.lucide?.createIcons?.();
      return;
    }
    if (state.error && !state.workspace) {
      element.innerHTML = errorMarkup();
      window.lucide?.createIcons?.();
      return;
    }
    element.innerHTML = `<section class="settings-shell">
      ${heroMarkup()}
      ${feedbackMarkup()}
      ${tabsMarkup()}
      <main class="settings-main">${activeTabMarkup()}</main>
    </section>`;
    window.lucide?.createIcons?.();
    applyPreferences();
  }

  function applyPayload(payload, message = null) {
    state.workspace = payload.workspace || state.workspace;
    state.staff = payload.staff || state.staff;
    state.policy = payload.policy || state.policy;
    state.error = null;
    state.message = message;
    render();
  }

  async function load(options = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!options.silent) state.error = null;
    render();
    try {
      const payload = await api('snapshot');
      applyPayload(payload);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Settings could not load.';
      if (error?.status === 403) state.workspace = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, message) {
    if (state.saving) return;
    state.saving = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api(action, { method: 'POST', body });
      applyPayload(payload, message);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Settings could not be saved.';
    } finally {
      state.saving = false;
      render();
    }
  }

  function collectSectionValue(key, form) {
    const current = { ...(section(key)?.value || {}) };
    if (key === 'venue') {
      return {
        ...current,
        business_name: fieldValue(form, 'business_name').trim(),
        legal_name: fieldValue(form, 'legal_name').trim(),
        registration_number: fieldValue(form, 'registration_number').trim(),
        address_line: fieldValue(form, 'address_line').trim(),
        city: fieldValue(form, 'city').trim(),
        country_code: fieldValue(form, 'country_code').trim().toUpperCase(),
        location_label: fieldValue(form, 'location_label').trim(),
        timezone: fieldValue(form, 'timezone').trim(),
        currency: 'ISK',
        primary_language: fieldValue(form, 'primary_language'),
        supported_languages: current.supported_languages || ['en', 'is'],
        email: fieldValue(form, 'email').trim(),
        phone: fieldValue(form, 'phone').trim(),
        website: fieldValue(form, 'website').trim(),
        booking_url: fieldValue(form, 'booking_url').trim()
      };
    }
    if (key === 'operations') {
      return {
        week_starts_on: numberValue(form, 'week_starts_on', 1),
        default_break_minutes: numberValue(form, 'default_break_minutes', 0),
        shift_confirmation_required: boolValue(form, 'shift_confirmation_required'),
        service_mode_enabled: boolValue(form, 'service_mode_enabled'),
        last_order_minutes_before_close: numberValue(form, 'last_order_minutes_before_close', 30),
        production_shift_sync_enabled: false
      };
    }
    if (key === 'inventory') {
      return {
        low_stock_warning_enabled: boolValue(form, 'low_stock_warning_enabled'),
        critical_stock_ratio: numberValue(form, 'critical_stock_ratio', 0.25),
        variance_tolerance_percent: numberValue(form, 'variance_tolerance_percent', 5),
        waste_tolerance_percent: numberValue(form, 'waste_tolerance_percent', 3),
        automatic_reorder_suggestions: boolValue(form, 'automatic_reorder_suggestions'),
        automatic_reorder_execution: false,
        barcode_gallery_enabled: boolValue(form, 'barcode_gallery_enabled'),
        allow_multiple_barcodes: boolValue(form, 'allow_multiple_barcodes'),
        staff_barcode_linking: boolValue(form, 'staff_barcode_linking'),
        live_quantity_apply: false
      };
    }
    if (key === 'temperature') {
      return {
        daily_log_required: boolValue(form, 'daily_log_required'),
        reminder_times: commaList(fieldValue(form, 'reminder_times')),
        escalation_minutes: numberValue(form, 'escalation_minutes', 60),
        photo_required_on_exception: boolValue(form, 'photo_required_on_exception'),
        corrective_action_required: boolValue(form, 'corrective_action_required'),
        manager_review_on_exception: boolValue(form, 'manager_review_on_exception'),
        retention_months: numberValue(form, 'retention_months', 24)
      };
    }
    if (key === 'cleaning') {
      return {
        photo_required: boolValue(form, 'photo_required'),
        comment_required_on_exception: boolValue(form, 'comment_required_on_exception'),
        manager_review_on_exception: boolValue(form, 'manager_review_on_exception'),
        overdue_escalation_minutes: numberValue(form, 'overdue_escalation_minutes', 60),
        weekly_schedule: {
          sunday: fieldValue(form, 'schedule_sunday').trim(),
          monday: fieldValue(form, 'schedule_monday').trim(),
          tuesday: fieldValue(form, 'schedule_tuesday').trim()
        }
      };
    }
    if (key === 'marketing') {
      return {
        brand_voice: fieldValue(form, 'brand_voice').trim(),
        approval_required: boolValue(form, 'approval_required'),
        automatic_publishing_enabled: false,
        ai_caption_drafts_enabled: boolValue(form, 'ai_caption_drafts_enabled'),
        default_story_frames: numberValue(form, 'default_story_frames', 3),
        analytics_ingestion_enabled: false
      };
    }
    if (key === 'brain') {
      return {
        mode: fieldValue(form, 'mode'),
        decision_memory_enabled: boolValue(form, 'decision_memory_enabled'),
        purchase_learning_enabled: boolValue(form, 'purchase_learning_enabled'),
        menu_learning_enabled: boolValue(form, 'menu_learning_enabled'),
        waste_learning_enabled: boolValue(form, 'waste_learning_enabled'),
        forecast_learning_enabled: boolValue(form, 'forecast_learning_enabled'),
        explanation_level: fieldValue(form, 'explanation_level'),
        evidence_mode: fieldValue(form, 'evidence_mode'),
        automatic_execution_enabled: false
      };
    }
    if (key === 'security') {
      return {
        session_timeout_minutes: numberValue(form, 'session_timeout_minutes', 480),
        two_factor_required: boolValue(form, 'two_factor_required'),
        trusted_devices_enabled: boolValue(form, 'trusted_devices_enabled'),
        emergency_lockdown_enabled: boolValue(form, 'emergency_lockdown_enabled'),
        password_policy_managed_by_auth: boolValue(form, 'password_policy_managed_by_auth'),
        api_keys_visible: false,
        production_sync_enabled: false,
        destructive_actions_enabled: false
      };
    }
    if (key === 'appearance') {
      return {
        theme: fieldValue(form, 'theme'),
        density: fieldValue(form, 'density'),
        language: fieldValue(form, 'language'),
        date_format: fieldValue(form, 'date_format'),
        time_format: fieldValue(form, 'time_format'),
        start_view: fieldValue(form, 'start_view'),
        reduce_motion: boolValue(form, 'reduce_motion')
      };
    }
    if (key === 'modules') {
      return {
        operations: boolValue(form, 'operations'),
        scanner: boolValue(form, 'scanner'),
        messages: boolValue(form, 'messages'),
        marketing: boolValue(form, 'marketing'),
        profiles: boolValue(form, 'profiles'),
        shifts: boolValue(form, 'shifts'),
        knowledge: boolValue(form, 'knowledge'),
        reports: boolValue(form, 'reports'),
        system: true,
        settings: true,
        reports_state: fieldValue(form, 'reports_state'),
        production_sync_enabled: false
      };
    }
    return current;
  }

  async function handleSubmit(event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !host()?.contains(form)) return;

    const sectionKey = form.dataset.settingsSectionForm;
    if (sectionKey) {
      event.preventDefault();
      await mutate('save-section', {
        section_key: sectionKey,
        expected_version: Number(form.dataset.version || 1),
        value: collectSectionValue(sectionKey, form)
      }, `${section(sectionKey)?.label || humanize(sectionKey)} settings saved.`);
      return;
    }

    if (form.hasAttribute('data-settings-hours-form')) {
      event.preventDefault();
      const hours = [...form.querySelectorAll('.settings-hours-row')].map((row) => ({
        weekday: Number(row.dataset.weekday),
        day_label: WEEKDAYS[Number(row.dataset.weekday)],
        is_open: Boolean(row.querySelector('[name="is_open"]')?.checked),
        open_time: row.querySelector('[name="open_time"]')?.value || null,
        close_time: row.querySelector('[name="close_time"]')?.value || null,
        close_next_day: Boolean(row.querySelector('[name="close_next_day"]')?.checked),
        kitchen_close_time: row.querySelector('[name="kitchen_close_time"]')?.value || null,
        kitchen_close_next_day: false,
        last_order_time: row.querySelector('[name="last_order_time"]')?.value || null,
        last_order_next_day: false
      }));
      await mutate('save-hours', { hours }, 'Business hours saved.');
      return;
    }

    if (form.hasAttribute('data-settings-offer-form')) {
      event.preventDefault();
      let pricing = {};
      try {
        pricing = JSON.parse(fieldValue(form, 'pricing_json') || '{}');
      } catch {
        state.error = 'Offer pricing must be valid JSON.';
        render();
        return;
      }
      const days = WEEKDAYS.map((_, weekday) => weekday).filter((weekday) => form.querySelector(`[name="day_${weekday}"]`)?.checked);
      await mutate('save-offer', {
        offer_id: form.dataset.offerId || null,
        offer_key: fieldValue(form, 'offer_key').trim(),
        name: fieldValue(form, 'name').trim(),
        description: fieldValue(form, 'description').trim() || null,
        active: boolValue(form, 'active'),
        days,
        start_time: fieldValue(form, 'start_time'),
        end_time: fieldValue(form, 'end_time'),
        end_next_day: boolValue(form, 'end_next_day'),
        pricing,
        booking_url: fieldValue(form, 'booking_url').trim() || null,
        expected_version: form.dataset.offerId ? Number(form.dataset.version || 1) : null
      }, form.dataset.offerId ? 'Offer updated.' : 'Offer created.');
      state.offerDraft = null;
      return;
    }

    const roleKey = form.dataset.settingsRoleForm;
    if (roleKey) {
      event.preventDefault();
      const permissions = {};
      form.querySelectorAll('input[name^="permission_"]').forEach((input) => {
        permissions[input.name.slice('permission_'.length)] = Boolean(input.checked);
      });
      await mutate('save-role', {
        role_key: roleKey,
        permissions,
        expected_version: Number(form.dataset.version || 1)
      }, `${ROLE_LABELS[roleKey] || humanize(roleKey)} permissions saved.`);
      return;
    }

    const eventKey = form.dataset.settingsNotificationForm;
    if (eventKey) {
      event.preventDefault();
      const channels = Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, boolValue(form, `channel_${channel}`)]));
      const targetRoles = ROLE_KEYS.filter((role) => boolValue(form, `role_${role}`));
      await mutate('save-notification', {
        event_key: eventKey,
        enabled: boolValue(form, 'enabled'),
        channels,
        target_roles: targetRoles,
        reminder_minutes: integerList(fieldValue(form, 'reminder_minutes')),
        escalation_minutes: fieldValue(form, 'escalation_minutes') === '' ? null : numberValue(form, 'escalation_minutes'),
        manager_approval_required: boolValue(form, 'manager_approval_required'),
        expected_version: Number(form.dataset.version || 1)
      }, 'Notification policy saved.');
      return;
    }

    if (form.hasAttribute('data-settings-preferences-form')) {
      event.preventDefault();
      const wantsBrowser = boolValue(form, 'browser_notifications');
      let browserAllowed = wantsBrowser;
      if (wantsBrowser) {
        if (!('Notification' in window)) {
          state.error = 'This browser does not support notifications.';
          render();
          return;
        }
        if (Notification.permission !== 'granted') {
          const permission = await Notification.requestPermission();
          browserAllowed = permission === 'granted';
          if (!browserAllowed) {
            state.error = 'Browser notification permission was not granted.';
            render();
            return;
          }
        }
      }
      await mutate('save-preferences', {
        theme: fieldValue(form, 'theme'),
        density: fieldValue(form, 'density'),
        language: fieldValue(form, 'language'),
        start_view: fieldValue(form, 'start_view'),
        timezone: fieldValue(form, 'timezone').trim(),
        reduce_motion: boolValue(form, 'reduce_motion'),
        browser_notifications: browserAllowed,
        email_notifications: boolValue(form, 'email_notifications'),
        preferences: {}
      }, 'Personal preferences saved.');
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;

    const tab = target.closest('[data-settings-tab]');
    if (tab) {
      state.activeTab = tab.dataset.settingsTab;
      state.error = null;
      state.message = null;
      render();
      return;
    }

    const jump = target.closest('[data-settings-tab-jump]');
    if (jump) {
      state.activeTab = jump.dataset.settingsTabJump;
      state.error = null;
      state.message = null;
      render();
      return;
    }

    if (target.closest('[data-settings-refresh]')) {
      load();
      return;
    }

    if (target.closest('[data-settings-add-offer]')) {
      state.offerDraft = {
        active: true,
        days: [0, 1, 2, 3, 4, 5, 6],
        start_time: '15:00',
        end_time: '18:00',
        end_next_day: false,
        pricing: {},
        booking_url: section('venue')?.value?.booking_url || ''
      };
      render();
      window.setTimeout(() => host()?.querySelector('[data-settings-offer-form][data-offer-id=""]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      return;
    }

    if (target.closest('[data-settings-cancel-offer]')) {
      state.offerDraft = null;
      render();
    }
  }

  function applyPreferences() {
    const preference = state.workspace?.preferences || {};
    const root = document.documentElement;
    root.dataset.atlasTheme = preference.theme || 'dark';
    root.dataset.atlasDensity = preference.density || 'comfortable';
    root.lang = preference.language || 'en';
    root.classList.toggle('atlas-reduce-motion', Boolean(preference.reduce_motion));
  }

  function activate() {
    if (!settingsVisible()) return;
    if (!state.workspace && !state.loading) load();
    else render();
  }

  function init() {
    if (state.initialized) return true;
    const element = host();
    if (!element) return false;
    state.initialized = true;

    document.addEventListener('click', handleClick, true);
    document.addEventListener('submit', handleSubmit, true);
    state.viewObserver = new MutationObserver(() => activate());
    state.viewObserver.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    state.viewObserver.observe(document.getElementById('app-screen') || document.body, { attributes: true, attributeFilter: ['style', 'class'] });

    window.addEventListener('focus', () => {
      if (settingsVisible() && state.workspace) load({ silent: true });
    });
    window.addEventListener('online', () => {
      if (settingsVisible()) load({ silent: true });
    });
    window.addEventListener('pagehide', () => {
      state.viewObserver?.disconnect();
      if (state.authTimer) window.clearInterval(state.authTimer);
    }, { once: true });

    activate();
    return true;
  }

  window.AtlasSettings = {
    open: () => {
      document.querySelector('[data-view="settings"]')?.click();
      window.setTimeout(activate, 50);
    },
    refresh: () => load(),
    snapshot: () => state.workspace,
    tab: (tab) => {
      if (TAB_ORDER.includes(tab)) {
        state.activeTab = tab;
        render();
      }
    }
  };

  if (!init()) {
    state.authTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.authTimer);
      state.authTimer = null;
    }, 120);
    window.setTimeout(() => {
      if (!state.authTimer) return;
      window.clearInterval(state.authTimer);
      state.authTimer = null;
    }, 12000);
  }
})();
