// Settings — #settings/<section> (docs/design/Atlas_Experience_Redesign.md §7.15).
//
// Section nav (220 px) + one 720 px column. Every section is a form with its
// own save state; the sticky save bar appears only while that form has unsaved
// changes. Sections: venue, hours, team-access, notifications, rules, ai,
// integrations, security, system (administrators), preferences, activity.
// Staff see Preferences and Notifications only (the nav is hidden then).
//
// Sources: atlas-settings (snapshot and saves; S87/S88 contracts), atlas-ai
// (?action=settings for the venue's Alcedo AI settings and limits, rendered from
// the actual response; ?action=preferences for personal reply settings),
// atlas-integrations (status, start, test, disconnect, save-api-key; S88 §6 and
// the owner hardening brief §5–6) and AtlasSystem (System health).
(function () {
  'use strict';
  // Native time picker, whole minutes; the value is 'HH:MM' (24 h). Inside the
  // control the device locale decides how it is shown.
  const TIME_FIELD = 'type="time" step="60"';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 22000;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // Monday first in the editor; weekday numbers stay 0 = Sunday (settings_business_hours).
  const EDITOR_DAYS = [1, 2, 3, 4, 5, 6, 0];
  const ROLE_LABELS = { admin: 'Administrator', manager: 'Manager', bartender: 'Bartender', viewer: 'Viewer' };
  // Grouped by who the setting is for. A group label is printed where an
  // entry's group differs from the one before; entries without one continue it.
  const SECTIONS = [
    { key: 'venue', label: 'Venue', icon: 'building-2', roles: ['admin', 'manager'], group: 'The venue' },
    { key: 'hours', label: 'Opening hours', icon: 'clock', roles: ['admin', 'manager'] },
    { key: 'rules', label: 'Operational rules', icon: 'list-checks', roles: ['admin', 'manager'] },
    { key: 'ai', label: 'Alcedo AI', icon: 'sparkles', roles: ['admin', 'manager'] },
    { key: 'integrations', label: 'Integrations', icon: 'plug', roles: ['admin', 'manager'] },
    { key: 'team-access', label: 'Team access', icon: 'users', roles: ['admin'], group: 'Access' },
    { key: 'security', label: 'Security', icon: 'shield', roles: ['admin'] },
    { key: 'system', label: 'System health', icon: 'activity', roles: ['admin'] },
    { key: 'activity', label: 'Activity', icon: 'history', roles: ['admin', 'manager'] },
    { key: 'notifications', label: 'Notifications', icon: 'bell', roles: null, group: 'You' },
    { key: 'preferences', label: 'Preferences', icon: 'user-cog', roles: null }
  ];
  // Older links and stored tabs.
  const SECTION_ALIASES = { general: 'venue', overview: 'venue', access: 'team-access', operations: 'rules', intelligence: 'ai' };
  // Each start view maps to a real destination; stored Brain/briefing values open Home.
  const START_VIEW_TARGETS = {
    dashboard: 'dashboard', briefing: 'dashboard', brain: 'dashboard', ai: 'ai', operations: 'operations',
    inventory: 'inventory', recipes: 'recipes', suppliers: 'suppliers', team: 'team',
    shifts: 'shifts', knowledge: 'knowledge', reports: 'reports', settings: 'settings'
  };
  const START_VIEWS = [
    ['dashboard', 'Home'], ['ai', 'Alcedo AI'], ['team', 'Messages'], ['operations', 'Operations'],
    ['inventory', 'Inventory'], ['recipes', 'Recipes'], ['suppliers', 'Purchasing'],
    ['shifts', 'Shifts'], ['knowledge', 'Knowledge'], ['reports', 'Reports'], ['settings', 'Settings']
  ];
  const PREFERENCE_CACHE_KEY = 'atlas.preferences.v1';
  // Alcedo AI venue settings (GET atlas-ai?action=settings). Only keys present
  // in the response are rendered, so older and newer servers both work.
  const AI_FIELDS = [
    { key: 'enabled', type: 'toggle', label: 'Alcedo AI is on for the venue', help: 'When off, Alcedo AI answers from saved records only and prepares nothing.' },
    { key: 'daily_turn_limit_per_user', type: 'number', label: 'Questions per person per day', min: 1, max: 10000 },
    { key: 'voice_sessions_per_day', type: 'number', label: 'Voice conversations per person per day', min: 1, max: 1000 },
    { key: 'voice_minutes_per_day', type: 'number', label: 'Voice minutes per person per day', min: 1, max: 1440 },
    { key: 'max_concurrent_voice_sessions', type: 'number', label: 'Voice conversations at the same time, per person', min: 1, max: 10 },
    { key: 'upload_files_per_day', type: 'number', label: 'Files per person per day', min: 1, max: 10000 },
    { key: 'upload_bytes_per_day', type: 'megabytes', label: 'Upload size per person per day (MB)', min: 1, max: 10240 },
    { key: 'media_retention_days', type: 'number', label: 'Keep photos and files for (days)', min: 1, max: 365 },
    { key: 'audio_retention', type: 'select', label: 'Voice recordings', choices: [['delete_after_transcription', 'Delete after they are written down'], ['keep_with_media', 'Keep with photos and files']] }
  ];
  // Connection pill per connection_state; publishing providers refine a
  // connected card by publishing readiness (S94B, contract §4).
  const INTEGRATION_STATES = {
    not_configured: ['neutral', 'Not set up yet'],
    ready: ['neutral', 'Ready to connect'],
    verifying: ['warning', 'Checking'],
    connected: ['positive', 'Connected'],
    verification_failed: ['warning', 'Verification failed'],
    needs_reauthorization: ['warning', 'Needs reconnecting'],
    pending_review: ['info', 'Platform review pending']
  };
  // S94B: what Alcedo posts to, per provider (atlas-integrations resource_kind).
  const RESOURCE_WORDS = {
    facebook_page: { noun: 'Page', choose: 'Choose Page', change: 'Change Page', title: 'Choose the Facebook Page', use: 'Use this Page', none: 'No Page chosen' },
    instagram_account: { noun: 'account', choose: 'Choose account', change: 'Change account', title: 'Choose the Instagram account', use: 'Use this account', none: 'No account chosen' },
    gbp_location: { noun: 'location', choose: 'Choose location', change: 'Change location', title: 'Choose the Business Profile location', use: 'Use this location', none: 'No location chosen' },
    tiktok_account: { noun: 'account', choose: 'Choose account', change: 'Change account', title: 'Choose the TikTok account', use: 'Use this account', none: 'No account chosen' }
  };
  const REVIEW_STATES = [
    ['unknown', 'Not checked yet'], ['not_required', 'Not needed'], ['required', 'Needed, not started'],
    ['pending', 'In progress'], ['approved', 'Approved'], ['rejected', 'Rejected']
  ];
  const INTEGRATION_EVENTS = {
    connect_started: 'Connecting started', credential_stored: 'Access saved', connected: 'Connected', callback_failed: 'Connecting failed',
    verified: 'Checked', verify_failed: 'Check failed', refreshed: 'Access renewed', refresh_failed: 'Renewing access failed',
    disconnected: 'Disconnected', api_key_saved: 'Key saved', publish_scope_requested: 'Publishing permission requested',
    resource_listed: 'Accounts listed', resource_selected: 'Posting target chosen', credential_used: 'Used to publish a post',
    review_state_set: 'Platform review updated'
  };

  const state = {
    workspace: null,
    staff: null,
    status: 'idle',
    error: null,
    section: null,
    savingForms: new Set(),
    formFeedback: {},
    fieldErrors: {},
    dirtyForms: new Set(),
    initialized: false,
    offerDraft: null,
    notificationAction: false,
    ai: { status: 'idle', settings: null, preferences: null, error: null },
    integrations: { status: 'idle', providers: [], error: null, busy: {}, messages: {}, notice: null, autoPick: null },
    purchasingPolicy: { status: 'idle', value: null },
    // S99: the current user's own authenticator status (client.auth.mfa.listFactors).
    mfa: { status: 'idle', hasFactor: false, busy: false }
  };

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    const text = String(value || '').replace(/[._-]+/g, ' ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function icon(name) {
    return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
  }

  function clock() { return window.AtlasVenueClock || null; }

  function exampleZone() { return clock()?.DEFAULT_TIME_ZONE || ''; }

  function formatDateTime(value) {
    if (!value) return 'Not recorded';
    return clock()?.formatDateTime?.(value) || 'Not recorded';
  }

  function host() {
    return document.getElementById('settings-view');
  }

  function role() {
    return state.staff?.role || window.AtlasShell?.profile?.()?.role || null;
  }

  function isAdmin() { return role() === 'admin'; }
  function isManager() { return ['admin', 'manager'].includes(role()); }

  function section(key) {
    const sections = state.workspace?.sections;
    return (Array.isArray(sections) ? sections : []).find((entry) => entry?.section_key === key) || null;
  }

  function canManage() {
    return Boolean(state.workspace?.permissions?.can_manage_organization);
  }

  function visibleSections() {
    const current = role();
    return SECTIONS.filter((entry) => !entry.roles || (current && entry.roles.includes(current)));
  }

  function defaultSection() {
    return visibleSections().length > 2 ? 'venue' : 'preferences';
  }

  // Opening-hours conflicts (S90 P3): a zero-length day, a close before the
  // open without "Next day", more than 24 hours, or a late close that runs
  // into the next day's opening. Mirrors atlas-settings businessHoursProblem.
  function hoursProblem(rows) {
    const minutes = (value) => {
      const match = /^(\d{2}):(\d{2})/.exec(String(value ?? ''));
      return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    const clockText = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const byDay = new Map(rows.map((row) => [Number(row.weekday), row]));
    for (const row of rows) {
      if (!row || !row.is_open) continue;
      const weekday = Number(row.weekday);
      const day = names[weekday] || String(row.day_label || 'This day');
      const open = minutes(row.open_time);
      const close = minutes(row.close_time);
      if (open === null || close === null) continue;
      if (!row.close_next_day && close === open) {
        return { weekday, text: `${day} opens and closes at the same time. Change the closing time, or tick Next day if it’s open around the clock.` };
      }
      if (!row.close_next_day && close < open) {
        return { weekday, text: `${day} closes before it opens. Tick Next day if it closes after midnight.` };
      }
      if (row.close_next_day && close > open) {
        return { weekday, text: `${day} would be open for more than 24 hours. Check the closing time.` };
      }
      if (row.close_next_day) {
        const next = byDay.get((weekday + 1) % 7);
        const nextOpen = next?.is_open ? minutes(next.open_time) : null;
        if (nextOpen !== null && close > nextOpen) {
          return { weekday, text: `${day} closes at ${clockText(close)} after midnight, but ${names[(weekday + 1) % 7]} opens at ${clockText(nextOpen)}. Change one so they don’t overlap.` };
        }
      }
    }
    return null;
  }

  function hhmm(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
    return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
  }

  function fieldValue(form, name) {
    return form.querySelector(`[name="${CSS.escape(name)}"]`)?.value ?? '';
  }

  function boolValue(form, name) {
    const element = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!element) return false;
    if (element.getAttribute('role') === 'switch') return element.getAttribute('aria-checked') === 'true';
    return Boolean(element.checked);
  }

  function numberValue(form, name, fallback = 0) {
    const raw = fieldValue(form, name);
    if (raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  function commaList(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  // ---------- server ----------

  async function accessToken() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session?.access_token || null;
  }

  async function request(base, action, options = {}) {
    const apiUrl = String(base || '').trim();
    if (!apiUrl) throw Object.assign(new Error('not configured'), { status: 0, code: 'not_configured' });
    const token = await accessToken();
    if (!token) throw Object.assign(new Error('signed out'), { status: 401, code: 'unauthorized' });
    const url = new URL(apiUrl);
    url.searchParams.set('action', action);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error('request failed');
        error.status = response.status;
        error.code = payload?.error_code || payload?.code || null;
        error.serverText = typeof payload?.error === 'string' ? payload.error : '';
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error('timeout'), { status: 0, code: 'timeout' });
      if (error instanceof TypeError) throw Object.assign(new Error('network'), { status: 0, code: 'network' });
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  const api = (action, options) => request(cfg.SETTINGS_API, action, options);

  function friendlySaveError(error, context = '') {
    if (error?.status === 409 || /changed after this page was opened/i.test(error?.serverText || '')) return 'Someone else saved this after you opened it. Discard your changes to see theirs, then edit again.';
    if (error?.status === 403) return 'Your role can’t change this setting.';
    if (error?.code === 'network' || error?.code === 'timeout') return 'Alcedo couldn’t be reached. Nothing was saved — check the connection and try again.';
    if (error?.status === 400) return context || 'Some values aren’t accepted. Check them and try again.';
    return 'That couldn’t be saved. Nothing was changed — try again.';
  }

  // ---------- markup primitives ----------

  function feedback(key) {
    const entry = state.formFeedback[key];
    if (!entry) return '';
    return `<p class="settings-form-feedback is-${entry.type === 'error' ? 'error' : 'success'}" role="${entry.type === 'error' ? 'alert' : 'status'}">${icon(entry.type === 'error' ? 'circle-alert' : 'circle-check')}${escapeHtml(entry.text)}</p>`;
  }

  // The sticky bar is part of every editable form; it shows while the form is dirty.
  function saveBar(key, label = 'Save changes') {
    const busy = state.savingForms.has(key);
    const dirty = state.dirtyForms.has(key) || busy;
    return `<div class="settings-savebar" data-settings-savebar${dirty ? '' : ' hidden'}>
      <span class="settings-savebar__text">Unsaved changes</span>
      <button type="button" class="atlas-btn atlas-btn--ghost" data-settings-discard${busy ? ' disabled' : ''}>Discard</button>
      <button type="submit" class="atlas-btn atlas-btn--primary${busy ? ' is-loading' : ''}"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? 'Saving…' : escapeHtml(label)}</button>
    </div>`;
  }

  let fieldSequence = 0;
  // Label + control + help/error as siblings (.atlas-field); the control gets an id.
  function field(label, control, options = {}) {
    const id = `settings-field-${++fieldSequence}`;
    const helpId = options.help ? `${id}-help` : '';
    const withId = control.replace(/^\s*<(input|select|textarea)\b/, `<$1 id="${id}"${helpId && !options.error ? ` aria-describedby="${helpId}"` : ''}`);
    const error = options.error ? `<p class="atlas-field__error" id="${escapeHtml(options.errorId || `${id}-error`)}">${icon('circle-alert')}${escapeHtml(options.error)}</p>` : '';
    return `<div class="atlas-field${options.full ? ' settings-field--full' : ''}">
      <label for="${id}">${escapeHtml(label)}${options.optional ? ' <span class="optional">Optional</span>' : ''}</label>
      ${withId}
      ${options.help ? `<p class="atlas-field__help" id="${helpId}">${escapeHtml(options.help)}</p>` : ''}${error}
    </div>`;
  }

  function input(name, value, options = {}) {
    const attrs = [
      `name="${escapeHtml(name)}"`,
      `type="${escapeHtml(options.type || 'text')}"`,
      `value="${escapeHtml(value ?? '')}"`,
      options.disabled ? 'disabled' : '',
      options.required ? 'required' : '',
      options.min != null ? `min="${escapeHtml(options.min)}"` : '',
      options.max != null ? `max="${escapeHtml(options.max)}"` : '',
      options.step != null ? `step="${escapeHtml(options.step)}"` : '',
      options.inputmode ? `inputmode="${escapeHtml(options.inputmode)}"` : '',
      options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : '',
      options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : '',
      options.invalid ? 'aria-invalid="true"' : '',
      options.describedby ? `aria-describedby="${escapeHtml(options.describedby)}"` : '',
      options.label ? `aria-label="${escapeHtml(options.label)}"` : ''
    ].filter(Boolean).join(' ');
    return `<input class="atlas-input" ${attrs}>`;
  }

  function select(name, value, choices, options = {}) {
    return `<select class="atlas-select" name="${escapeHtml(name)}"${options.disabled ? ' disabled' : ''}${options.label ? ` aria-label="${escapeHtml(options.label)}"` : ''}>${choices.map(([choice, text]) => `<option value="${escapeHtml(choice)}"${String(value) === String(choice) ? ' selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select>`;
  }

  function textarea(name, value, options = {}) {
    return `<textarea class="atlas-input atlas-textarea" name="${escapeHtml(name)}" rows="${options.rows || 3}"${options.disabled ? ' disabled' : ''}>${escapeHtml(value ?? '')}</textarea>`;
  }

  function toggle(name, checked, label, options = {}) {
    const id = `settings-${name}-${Math.random().toString(36).slice(2, 7)}`;
    return `<div class="atlas-toggle-row">
      <div><p class="atlas-toggle-row__label" id="${id}">${escapeHtml(label)}</p>${options.help ? `<p class="atlas-toggle-row__help">${escapeHtml(options.help)}</p>` : ''}</div>
      <button type="button" class="atlas-toggle" role="switch" name="${escapeHtml(name)}" aria-checked="${checked ? 'true' : 'false'}" aria-labelledby="${id}"${options.disabled ? ' disabled' : ''} data-settings-toggle></button>
    </div>`;
  }

  function pill(tone, text) {
    return `<span class="atlas-pill atlas-pill--${tone}">${escapeHtml(text)}</span>`;
  }

  function sectionHead(title, text, actions = '') {
    return `<header class="settings-section__head"><div><h2 class="settings-section__title" id="settings-section-title" tabindex="-1">${escapeHtml(title)}</h2>${text ? `<p class="settings-section__sub">${escapeHtml(text)}</p>` : ''}</div>${actions ? `<div class="settings-section__actions">${actions}</div>` : ''}</header>`;
  }

  // A settings row (taste §8.2): the label column — the row's title with its
  // status beside it, a grey description, then its facts or a preview of what
  // the setting produces — next to the panel that holds the controls.
  // options: { status, meta, aside, id }
  function rowLabel(title, text, options = {}) {
    const meta = (Array.isArray(options.meta) ? options.meta : [options.meta]).filter(Boolean).join('');
    return `<div class="settings-row__label">
      <div class="settings-row__heading"><h3 class="settings-form__title"${options.id ? ` id="${escapeHtml(options.id)}"` : ''}>${escapeHtml(title)}</h3>${options.status || ''}</div>
      ${text ? `<p class="settings-form__sub">${escapeHtml(text)}</p>` : ''}
      ${meta ? `<div class="settings-row__meta">${meta}</div>` : ''}
      ${options.aside || ''}
    </div>`;
  }

  function readOnlyNote(editable) {
    return editable ? '' : `<p class="settings-readonly">${icon('eye')}Read-only for your role</p>`;
  }

  function sectionVersion(data) {
    return data?.updated_at ? `<p class="settings-form__meta">Last changed ${escapeHtml(formatDateTime(data.updated_at))}</p>` : '';
  }

  // ---------- sections ----------

  function venueMarkup() {
    const data = section('venue');
    const value = data?.value || {};
    const disabled = !data?.can_edit;
    return `${sectionHead('Venue', 'The business details Alcedo uses on documents, in Alcedo AI and for your team.')}
    <form class="settings-form settings-row" data-settings-section-form="venue" data-version="${Number(data?.version || 1)}">
      ${rowLabel('Business details', 'Names, address and how guests and suppliers reach the venue.', {
        meta: [sectionVersion(data), readOnlyNote(!disabled)],
        aside: `<figure class="settings-preview"><figcaption class="settings-preview__caption">As it appears on documents</figcaption><div class="settings-letterhead" data-settings-venue-preview>${letterheadMarkup(value)}</div></figure>`
      })}
      <div class="settings-row__panel">
        <div class="settings-grid">
          ${field('Business name', input('business_name', value.business_name, { required: true, disabled, autocomplete: 'organization' }))}
          ${field('Legal name', input('legal_name', value.legal_name, { required: true, disabled }))}
          ${field('Registration number', input('registration_number', value.registration_number, { disabled }), { optional: true })}
          ${field('Location name', input('location_label', value.location_label, { disabled }), { optional: true, help: 'Shown next to the venue name, for example “Reykjavík”.' })}
          ${field('Address', input('address_line', value.address_line, { disabled, autocomplete: 'street-address' }), { optional: true, full: true })}
          ${field('City', input('city', value.city, { disabled, autocomplete: 'address-level2' }), { optional: true })}
          ${field('Country code', input('country_code', value.country_code, { disabled, placeholder: 'IS' }), { optional: true })}
          ${field('Email', input('email', value.email, { type: 'email', disabled, autocomplete: 'email' }), { optional: true })}
          ${field('Phone', input('phone', value.phone, { type: 'tel', disabled, autocomplete: 'tel' }), { optional: true })}
          ${field('Website', input('website', value.website, { type: 'url', disabled }), { optional: true })}
          ${field('Booking link', input('booking_url', value.booking_url, { type: 'url', disabled }), { optional: true })}
          ${field('Language', select('primary_language', value.primary_language || 'en', [['en', 'English'], ['is', 'Íslenska']], { disabled }))}
        </div>
        <dl class="settings-facts"><div><dt>Currency</dt><dd>ISK, fixed</dd></div><div><dt>Time zone</dt><dd>${escapeHtml(value.timezone || clock()?.timeZone?.() || '')} · <a href="#settings/hours">Change in Opening hours</a></dd></div></dl>
        ${feedback('section:venue')}
        ${disabled ? '' : saveBar('section:venue')}
      </div>
    </form>`;
  }

  // The letterhead preview: the venue block as documents print it, redrawn
  // from the form on every keystroke (paintVenuePreview). Empty lines drop out.
  function letterheadMarkup(value) {
    const join = (parts, glue) => parts.map((part) => String(part || '').trim()).filter(Boolean).join(glue);
    const name = String(value.business_name || '').trim();
    const lines = [
      join([value.legal_name, value.registration_number ? `Reg. no. ${String(value.registration_number).trim()}` : ''], ' · '),
      join([value.address_line, join([value.city, String(value.country_code || '').toUpperCase()], ', ')], ', '),
      join([value.email, value.phone], ' · '),
      join([value.website], '')
    ].filter(Boolean);
    return `<p class="settings-letterhead__name${name ? '' : ' is-empty'}">${escapeHtml(name || 'Business name')}${value.location_label ? ` <span class="settings-letterhead__place">${escapeHtml(String(value.location_label).trim())}</span>` : ''}</p>${lines.length ? lines.map((line) => `<p class="settings-letterhead__line">${escapeHtml(line)}</p>`).join('') : '<p class="settings-letterhead__line is-empty">Add the legal name and address to complete it.</p>'}`;
  }

  function paintVenuePreview(form) {
    const target = form?.querySelector('[data-settings-venue-preview]');
    if (!target) return;
    const value = {};
    ['business_name', 'legal_name', 'registration_number', 'location_label', 'address_line', 'city', 'country_code', 'email', 'phone', 'website'].forEach((name) => { value[name] = fieldValue(form, name); });
    target.innerHTML = letterheadMarkup(value);
  }

  function timezoneFormMarkup() {
    const data = section('venue');
    const zone = data?.value?.timezone || clock()?.timeZone?.() || '';
    const disabled = !data?.can_edit;
    const error = state.fieldErrors.timezone;
    const isDefault = clock()?.timezoneIsDefault?.();
    const now = clock()?.formatDateTime?.(new Date()) || '';
    return `<form class="settings-form settings-row" data-settings-timezone-form data-version="${Number(data?.version || 1)}">
      ${rowLabel('Time zone', 'Opening hours, checklists and “today” everywhere in Alcedo use the venue’s time zone.', { meta: readOnlyNote(!disabled) })}
      <div class="settings-row__panel">
        ${field('Venue time zone', input('timezone', zone, { disabled, required: true, placeholder: exampleZone(), invalid: Boolean(error), describedby: error ? 'settings-timezone-error' : '' }), { error, errorId: 'settings-timezone-error', help: isDefault ? 'Alcedo is using the default zone because none is saved.' : `A zone name such as ${exampleZone()}.` })}
        ${now ? `<p class="settings-produces">${icon('clock')}<span>At the venue it is now <strong class="num">${escapeHtml(now)}</strong></span></p>` : ''}
        ${feedback('timezone')}
        ${disabled ? '' : saveBar('timezone', 'Save time zone')}
      </div>
    </form>`;
  }

  // Open/closed switch: a closed day's time fields are unavailable.
  function syncHoursRow(row) {
    const open = Boolean(row.querySelector('[name="is_open"]')?.checked);
    if (!canManage()) return;
    row.querySelectorAll('[name="open_time"], [name="close_time"], [name="close_next_day"], [name="last_order_time"], [name="kitchen_close_time"]').forEach((entry) => { entry.disabled = !open; });
  }

  function hoursFormMarkup() {
    const saved = new Map((state.workspace?.business_hours || []).map((row) => [Number(row.weekday), row]));
    const editable = canManage();
    const disabled = editable ? '' : ' disabled';
    const rows = EDITOR_DAYS.map((weekday) => {
      const row = saved.get(weekday) || { weekday, day_label: WEEKDAYS[weekday], is_open: false };
      const day = WEEKDAYS[weekday];
      // A closed day's times are kept but can't be edited until it is open.
      const timeOff = disabled || (row.is_open ? '' : ' disabled');
      return `<tr class="settings-hours-row" data-weekday="${weekday}">
        <th scope="row">${escapeHtml(day)}</th>
        <td data-label="Open"><label class="settings-hours__tap"><input type="checkbox" class="atlas-check" name="is_open" aria-label="${escapeHtml(day)} open"${row.is_open ? ' checked' : ''}${disabled}></label></td>
        <td data-label="Opens"><input class="atlas-input" ${TIME_FIELD} name="open_time" aria-label="${escapeHtml(day)} opening time" value="${escapeHtml(hhmm(row.open_time) || '')}"${timeOff}></td>
        <td data-label="Closes"><input class="atlas-input" ${TIME_FIELD} name="close_time" aria-label="${escapeHtml(day)} closing time" value="${escapeHtml(hhmm(row.close_time) || '')}"${timeOff}></td>
        <td data-label="Next day"><label class="settings-hours__tap"><input type="checkbox" class="atlas-check" name="close_next_day" aria-label="${escapeHtml(day)} closes after midnight"${row.close_next_day ? ' checked' : ''}${timeOff}></label></td>
        <td data-label="Last orders"><input class="atlas-input" ${TIME_FIELD} name="last_order_time" aria-label="${escapeHtml(day)} last orders" value="${escapeHtml(hhmm(row.last_order_time) || '')}"${timeOff}></td>
        <td data-label="Kitchen"><input class="atlas-input" ${TIME_FIELD} name="kitchen_close_time" aria-label="${escapeHtml(day)} kitchen closes" value="${escapeHtml(hhmm(row.kitchen_close_time) || '')}"${timeOff}></td>
      </tr>`;
    }).join('');
    const empty = !saved.size ? `<div class="atlas-alert atlas-alert--info settings-hours__empty">${icon('info')}<div class="atlas-alert__content"><p class="atlas-alert__body">No opening hours are saved yet, so Home shows no timeline and nothing counts down. Alcedo never guesses hours.</p></div></div>` : '';
    const zone = section('venue')?.value?.timezone || clock()?.timeZone?.() || '';
    return `<form class="settings-form settings-row settings-row--hours" data-settings-hours-form>
      ${rowLabel('Weekly hours', 'Home, Operations and Alcedo AI read these hours.', { meta: readOnlyNote(editable), aside: weekMarkup() })}
      <div class="settings-row__panel settings-row__panel--flush">
        <div class="settings-panel__bar"><p class="settings-panel__note">${zone ? `Times are the venue’s, ${escapeHtml(zone)}` : 'Times are the venue’s'}</p>${editable ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-settings-copy-monday>Copy Monday to all</button>' : ''}</div>
        ${empty}
        <div class="atlas-table-wrap settings-hours"><table class="atlas-table atlas-table--compact">
          <colgroup><col class="settings-hours__day"><col class="settings-hours__check"><col><col><col class="settings-hours__check"><col><col></colgroup>
          <thead><tr><th scope="col">Day</th><th scope="col">Open</th><th scope="col">Opens</th><th scope="col">Closes</th><th scope="col" title="Closes after midnight">Next day</th><th scope="col">Last orders</th><th scope="col">Kitchen</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${feedback('hours')}
        ${editable ? saveBar('hours', 'Save hours') : ''}
      </div>
    </form>`;
  }

  // The week as Home reads it: one 24-hour track per day from 06:00 to 06:00,
  // the open span as a bar and last orders as a tick. Drawn from the table
  // (paintWeek), so it follows every edit before anything is saved.
  const WEEK_AXIS_START = 6 * 60;

  function weekMarkup() {
    return `<figure class="settings-preview settings-week">
      <figcaption class="settings-preview__caption">The week on Home</figcaption>
      <ol class="settings-week__days" data-settings-week>${EDITOR_DAYS.map((weekday) => `<li class="settings-week__day" data-week-day="${weekday}"><span class="settings-week__name" aria-hidden="true">${WEEKDAYS[weekday].slice(0, 3)}</span><span class="settings-week__track" aria-hidden="true"><span class="settings-week__bar" hidden></span><span class="settings-week__tick" hidden></span><span class="settings-week__closed">Closed</span></span><span class="sr-only" data-week-text>${WEEKDAYS[weekday]}: closed</span></li>`).join('')}</ol>
      <div class="settings-week__axis" aria-hidden="true"><span>06</span><span>12</span><span>18</span><span>00</span><span>06</span></div>
    </figure>`;
  }

  function paintWeek(form) {
    const list = form?.querySelector('[data-settings-week]');
    if (!list) return;
    const minutes = (value) => {
      const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
      return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    const along = (value) => (value - WEEK_AXIS_START + 1440) % 1440;
    let today = null;
    try { today = clock()?.weekday?.(clock()?.today?.()) ?? null; } catch { today = null; }
    list.querySelectorAll('[data-week-day]').forEach((item) => {
      const weekday = Number(item.dataset.weekDay);
      const row = form.querySelector(`.settings-hours-row[data-weekday="${weekday}"]`);
      const open = Boolean(row?.querySelector('[name="is_open"]')?.checked);
      const from = minutes(row?.querySelector('[name="open_time"]')?.value);
      const to = minutes(row?.querySelector('[name="close_time"]')?.value);
      const last = minutes(row?.querySelector('[name="last_order_time"]')?.value);
      const bar = item.querySelector('.settings-week__bar');
      const tick = item.querySelector('.settings-week__tick');
      const closed = item.querySelector('.settings-week__closed');
      const text = item.querySelector('[data-week-text]');
      item.classList.toggle('is-today', weekday === today);
      const drawn = open && from !== null && to !== null;
      bar.hidden = !drawn;
      closed.hidden = drawn;
      closed.textContent = open ? 'No times' : 'Closed';
      tick.hidden = true;
      if (!drawn) { text.textContent = `${WEEKDAYS[weekday]}: ${open ? 'open, no times yet' : 'closed'}`; return; }
      const start = along(from);
      let end = along(to);
      if (end <= start) end += 1440;
      end = Math.min(end, 1440);
      bar.style.setProperty('--from', String(start / 1440));
      bar.style.setProperty('--to', String(end / 1440));
      if (last !== null) {
        let mark = along(last);
        if (mark < start) mark += 1440;
        if (mark > start && mark < end) { tick.hidden = false; tick.style.setProperty('--at', String(mark / 1440)); }
      }
      const clockText = (value) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
      text.textContent = `${WEEKDAYS[weekday]}: ${clockText(from)} to ${clockText(to)}${last !== null ? `, last orders ${clockText(last)}` : ''}`;
    });
  }

  function offerFormMarkup(offer, isNew = false) {
    const editable = canManage();
    const disabled = !editable;
    const id = offer?.id || '';
    const key = `offer:${id || 'new'}`;
    const days = Array.isArray(offer?.days) ? offer.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const pricing = offer?.pricing && Object.keys(offer.pricing).length ? JSON.stringify(offer.pricing) : '';
    // An offer reads as one line (name, days, hours, state) and opens to edit;
    // it stays open while it is new, has changes, is saving or has a message.
    const open = isNew || state.dirtyForms.has(key) || state.savingForms.has(key) || Boolean(state.formFeedback[key]);
    const when = !isNew && hhmm(offer?.start_time) && hhmm(offer?.end_time)
      ? `${days.length === 7 ? 'Every day' : EDITOR_DAYS.filter((weekday) => days.includes(weekday)).map((weekday) => WEEKDAYS[weekday].slice(0, 3)).join(', ') || 'No days'} · ${hhmm(offer.start_time)}–${hhmm(offer.end_time)}`
      : (isNew ? 'Offers appear on the Home timeline on their days.' : '');
    return `<form class="settings-form settings-row__panel settings-offer${isNew ? ' is-new' : ''}" data-settings-offer-form data-offer-id="${escapeHtml(id)}" data-version="${Number(offer?.version || 1)}">
      <details class="settings-offer__details"${open ? ' open' : ''}>
      <summary class="settings-offer__head"><div><h4 class="settings-offer__title">${escapeHtml(isNew ? 'New offer' : (offer?.name || 'Offer'))}</h4>${when ? `<p class="settings-offer__when num">${escapeHtml(when)}</p>` : ''}</div><span class="settings-offer__end">${isNew ? '' : (offer?.active === false ? pill('neutral', 'Paused') : pill('positive', 'Active'))}${isNew ? '' : `<span class="settings-offer__chevron" aria-hidden="true">${icon('chevron-down')}</span>`}</span></summary>
      <div class="settings-offer__body">
      <div class="settings-grid">
        ${field('Name', input('name', offer?.name || '', { required: true, disabled }))}
        ${field('Short key', input('offer_key', offer?.offer_key || '', { required: true, disabled, placeholder: 'happy-hour' }), { help: 'Lowercase letters, numbers and hyphens.' })}
        ${field('Starts', input('start_time', hhmm(offer?.start_time) || '', { type: 'time', required: true, disabled }))}
        ${field('Ends', input('end_time', hhmm(offer?.end_time) || '', { type: 'time', required: true, disabled }))}
        ${field('Description', textarea('description', offer?.description || '', { disabled, rows: 2 }), { optional: true, full: true })}
        ${field('Booking link', input('booking_url', offer?.booking_url || '', { type: 'url', disabled }), { optional: true, full: true })}
        ${field('Prices', input('pricing_json', pricing, { disabled, placeholder: '{"cocktails_isk":1990}' }), { optional: true, full: true, help: 'Optional, as data: {"cocktails_isk":1990,"wine_isk":1090}' })}
      </div>
      <fieldset class="settings-days"><legend class="atlas-label">Days</legend>${EDITOR_DAYS.map((weekday) => `<label class="settings-inline-check"><input type="checkbox" class="atlas-check" name="day_${weekday}"${days.includes(weekday) ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${WEEKDAYS[weekday].slice(0, 3)}</label>`).join('')}</fieldset>
      <div class="settings-inline">
        <label class="settings-inline-check"><input type="checkbox" class="atlas-check" name="active"${offer?.active === false ? '' : ' checked'}${disabled ? ' disabled' : ''}> Active</label>
        <label class="settings-inline-check"><input type="checkbox" class="atlas-check" name="end_next_day"${offer?.end_next_day ? ' checked' : ''}${disabled ? ' disabled' : ''}> Ends after midnight</label>
      </div>
      ${feedback(key)}
      ${editable ? (isNew
        ? `<div class="settings-savebar"><button type="button" class="atlas-btn atlas-btn--ghost" data-settings-cancel-offer>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary${state.savingForms.has(key) ? ' is-loading' : ''}"${state.savingForms.has(key) ? ' disabled aria-busy="true"' : ''}>${state.savingForms.has(key) ? 'Saving…' : 'Create offer'}</button></div>`
        : saveBar(key, 'Save offer')) : ''}
      </div>
      </details>
    </form>`;
  }

  function hoursMarkup() {
    const offers = state.workspace?.offers || [];
    const active = offers.filter((offer) => offer?.active !== false).length;
    const add = canManage() && !state.offerDraft ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-add-offer>${icon('plus')}Add offer</button>` : '';
    return `${sectionHead('Opening hours', 'When the venue is open, and its offers. Nothing here is invented: without saved hours, Alcedo says so.')}
      ${hoursFormMarkup()}
      <section class="settings-row" aria-labelledby="settings-offers-title">
        ${rowLabel('Offers', 'Happy hours and set menus. They appear on the Home timeline on their days.', {
          id: 'settings-offers-title',
          meta: offers.length ? `<p class="settings-form__meta num">${escapeHtml(`${active} active · ${offers.length - active} paused`)}</p>` : '',
          aside: add ? `<div class="settings-row__actions">${add}</div>` : ''
        })}
        <div class="settings-row__panels">
          ${state.offerDraft ? offerFormMarkup(state.offerDraft, true) : ''}
          ${offers.length ? offers.map((offer) => offerFormMarkup(offer)).join('') : (state.offerDraft ? '' : '<p class="settings-empty">No offers yet. An offer needs a name, its days and its hours.</p>')}
        </div>
      </section>
      ${timezoneFormMarkup()}`;
  }

  function permissionKeys() {
    const keys = new Set();
    (state.workspace?.roles || []).forEach((entry) => Object.keys(entry.permissions || {}).forEach((key) => keys.add(key)));
    return [...keys].sort();
  }

  function teamAccessMarkup() {
    const roles = state.workspace?.roles || [];
    const profiles = state.workspace?.profiles_summary || {};
    const permissions = permissionKeys();
    const invite = window.AtlasShell?.actions?.get?.('team.invite')
      ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-settings-invite>' + icon('user-plus') + 'Invite someone</button>' : '';
    const counts = Object.entries(profiles.roles || {}).map(([key, count]) => `${count} ${(ROLE_LABELS[key] || humanize(key)).toLowerCase()}${count === 1 ? '' : 's'}`).join(', ');
    return `${sectionHead('Team access', `${plural(Number(profiles.active || 0), 'active profile', 'active profiles')}${counts ? ` · ${counts}` : ''}${Number(profiles.inactive || 0) ? ` · ${profiles.inactive} deactivated` : ''}`, invite)}
      <p class="settings-lede">What each role may do. A person’s role and deactivation are changed on their profile in <a href="#team">Team</a>.</p>
      ${roles.length ? roles.map((entry) => {
        const key = `role:${entry.role_key}`;
        const editable = Boolean(entry.can_edit);
        const people = Number(profiles.roles?.[entry.role_key] || 0);
        const allowed = permissions.filter((permission) => entry.permissions?.[permission]).length;
        return `<form class="settings-form settings-row" data-settings-role-form="${escapeHtml(entry.role_key)}" data-version="${Number(entry.version || 1)}">
          ${rowLabel(entry.label || ROLE_LABELS[entry.role_key] || humanize(entry.role_key), entry.description || '', {
            status: editable ? '' : pill('neutral', 'Protected'),
            meta: `<p class="settings-form__meta num">${escapeHtml(`${plural(people, 'person', 'people')} · ${allowed} of ${permissions.length} allowed`)}</p>`
          })}
          <div class="settings-row__panel">
            <ul class="settings-permissions">${permissions.map((permission) => `<li><label class="settings-inline-check"><input type="checkbox" class="atlas-check" name="permission_${escapeHtml(permission)}"${entry.permissions?.[permission] ? ' checked' : ''}${editable ? '' : ' disabled'}> ${escapeHtml(humanize(permission))}</label></li>`).join('')}</ul>
            ${feedback(key)}
            ${editable ? saveBar(key, 'Save permissions') : ''}
          </div>
        </form>`;
      }).join('') : `<div class="settings-row settings-row--empty"><div class="atlas-empty atlas-empty--inline"><div class="atlas-empty__icon">${icon('users')}</div><h3>No roles to show</h3><p>Roles appear once Settings has loaded them.</p></div></div>`}`;
  }

  function notificationsMarkup() {
    const device = window.AtlasNotifications?.snapshot?.() || { status: 'unsupported', detail: 'Notifications are not available in this browser.' };
    const on = device.status === 'enabled';
    const labels = { enabled: ['positive', 'On'], pending: ['neutral', 'Off'], unsynced: ['warning', 'Needs reconnecting'], denied: ['warning', 'Blocked in browser'], unavailable: ['neutral', 'Not set up'], unsupported: ['neutral', 'Not supported'] };
    const [tone, text] = labels[device.status] || ['neutral', 'Off'];
    let action = '';
    if (state.notificationAction) action = '<button type="button" class="atlas-btn atlas-btn--secondary is-loading" disabled aria-busy="true">Updating…</button>';
    else if (on) action = '<button type="button" class="atlas-btn atlas-btn--secondary" data-settings-push-disable>Turn notifications off</button>';
    else if (device.status === 'pending') action = '<button type="button" class="atlas-btn atlas-btn--primary" data-settings-push-enable>Turn notifications on</button>';
    else if (device.status === 'unsynced') action = '<button type="button" class="atlas-btn atlas-btn--primary" data-settings-push-enable>Reconnect this device</button>';
    const blocked = device.status === 'denied' ? '<p class="settings-steps-note">To unblock: open this site’s settings in your browser (the icon next to the address), allow notifications, then reload Alcedo.</p>' : '';
    const policies = isManager() ? (state.workspace?.notification_policies || []) : [];
    // What a device receives today, drawn as the notifications themselves.
    const arrives = [['messages-square', 'New message', 'From Messages, as soon as it is posted'], ['calendar-days', 'Shifts published', 'From Shifts, when a manager publishes the week']];
    return `${sectionHead('Notifications', 'Alerts on this device, and who gets which alert.')}
      <section class="settings-row settings-device-notifications is-${escapeHtml(device.status)}" aria-labelledby="settings-device-title">
        ${rowLabel('This device', 'Alcedo asks the browser for permission only when you turn notifications on. Turning them off unsubscribes this device.', { id: 'settings-device-title', status: pill(tone, text) })}
        <div class="settings-row__panel">
          <p class="settings-state">${icon(on ? 'bell-ring' : device.status === 'denied' ? 'bell-off' : 'bell')}<span>${escapeHtml(device.detail || '')}</span></p>
          ${blocked}
          ${action ? `<div class="settings-actions">${action}</div>` : ''}
          ${feedback('push')}
        </div>
      </section>
      <section class="settings-row" aria-labelledby="settings-alerts-title">
        ${rowLabel('Alerts sent today', 'Only these alerts can reach a device at the moment.', { id: 'settings-alerts-title' })}
        <div class="settings-row__panel settings-row__panel--flush">
          <ul class="settings-notices">${arrives.map(([glyph, title, from]) => `<li class="settings-notice"><span class="settings-notice__mark" aria-hidden="true">${icon(glyph)}</span><span class="settings-notice__text"><span class="settings-notice__app">Alcedo</span><span class="settings-notice__title">${escapeHtml(title)}</span><span class="settings-notice__from">${escapeHtml(from)}</span></span></li>`).join('')}</ul>
        </div>
      </section>
      ${policies.length ? `<section class="settings-row" aria-labelledby="settings-policies-title">
        ${rowLabel('Alert rules', 'Saved for when more alerts are delivered. They don’t send anything yet.', { id: 'settings-policies-title' })}
        <div class="settings-row__panel settings-row__panel--flush"><div class="atlas-table-wrap"><table class="atlas-table atlas-table--compact"><caption class="settings-caption sr-only">Saved alert rules, used once more alerts are delivered</caption><thead><tr><th scope="col">Alert</th><th scope="col">Goes to</th><th scope="col">Status</th></tr></thead><tbody>${policies.map((policy) => `<tr><td>${escapeHtml(policy.label || humanize(policy.event_key))}</td><td>${escapeHtml((policy.target_roles || []).map((key) => ROLE_LABELS[key] || humanize(key)).join(', ') || 'Nobody yet')}</td><td>${policy.enabled ? pill('positive', 'On') : pill('neutral', 'Off')}</td></tr>`).join('')}</tbody></table></div></div>
      </section>` : ''}`;
  }

  // Rules that change Alcedo today say so; the rest are saved for upcoming features.
  const SETTING_USAGE = {
    inventory: { automatic_reorder_suggestions: 'Used for order suggestions in Purchasing and Alcedo AI.' },
    brain: { purchase_learning_enabled: 'Used for order suggestions.', menu_learning_enabled: 'Used for recipe availability notes.', waste_learning_enabled: 'Used for waste notes.' }
  };

  function ruleForm(key, title, fields, description = null) {
    const data = section(key);
    if (!data) return '';
    const disabled = !data.can_edit;
    const used = Object.keys(SETTING_USAGE[key] || {}).length;
    const status = description ? '' : used ? pill('positive', 'In use') : pill('neutral', 'Saved for later');
    return `<form class="settings-form settings-row" data-settings-section-form="${escapeHtml(key)}" data-version="${Number(data.version || 1)}">
      ${rowLabel(title, description || (used ? 'Settings marked “in use” change Alcedo today; the rest are saved for upcoming features.' : 'Kept for upcoming features. Changing these doesn’t affect Alcedo yet.'), { status, meta: [sectionVersion(data), readOnlyNote(!disabled)] })}
      <div class="settings-row__panel">
        ${fields(data.value || {}, disabled)}
        ${feedback(`section:${key}`)}
        ${disabled ? '' : saveBar(`section:${key}`)}
      </div>
    </form>`;
  }

  function usedHelp(key, name) {
    return SETTING_USAGE[key]?.[name] ? `In use. ${SETTING_USAGE[key][name]}` : '';
  }

  // A tick row: label, then its grey help. A setting that changes Alcedo today
  // carries a small "in use" mark (SETTING_USAGE) instead of a coloured label.
  function checkRow(name, checked, label, options = {}) {
    const used = /^In use\. /.test(options.help || '');
    return `<label class="settings-check${used ? ' is-used' : ''}"><input type="checkbox" class="atlas-check" name="${escapeHtml(name)}"${checked ? ' checked' : ''}${options.disabled ? ' disabled' : ''}><span><span class="settings-check__label">${escapeHtml(label)}${used ? ' <span class="atlas-pill atlas-pill--positive atlas-pill--plain settings-used">In use</span>' : ''}</span>${options.help ? `<span class="settings-check__help">${escapeHtml(used ? options.help.replace(/^In use\. /, '') : options.help)}</span>` : ''}</span></label>`;
  }

  // The checks of one form, as one ruled list.
  function checkList(rows) {
    return `<div class="settings-checks">${rows.join('')}</div>`;
  }

  function rulesMarkup() {
    const operations = ruleForm('operations', 'Shifts and service', (value, disabled) => `<div class="settings-grid">
      ${field('Week starts on', select('week_starts_on', value.week_starts_on ?? 1, WEEKDAYS.map((day, index) => [index, day]), { disabled }))}
      ${field('Default break (minutes)', input('default_break_minutes', value.default_break_minutes, { type: 'number', min: 0, max: 720, disabled, inputmode: 'numeric' }))}
      ${field('Last orders before closing (minutes)', input('last_order_minutes_before_close', value.last_order_minutes_before_close, { type: 'number', min: 0, max: 240, disabled, inputmode: 'numeric' }))}
    </div>${checkList([checkRow('shift_confirmation_required', value.shift_confirmation_required, 'Staff confirm their shifts', { disabled })])}`);
    const inventory = ruleForm('inventory', 'Stock', (value, disabled) => `<div class="settings-grid">
      ${field('Critical stock level (share of par)', input('critical_stock_ratio', value.critical_stock_ratio, { type: 'number', min: 0, max: 1, step: 0.05, disabled, inputmode: 'decimal' }))}
      ${field('Count difference allowed (%)', input('variance_tolerance_percent', value.variance_tolerance_percent, { type: 'number', min: 0, max: 100, step: 0.1, disabled, inputmode: 'decimal' }))}
      ${field('Waste allowed (%)', input('waste_tolerance_percent', value.waste_tolerance_percent, { type: 'number', min: 0, max: 100, step: 0.1, disabled, inputmode: 'decimal' }))}
    </div>
    ${checkList([
      checkRow('low_stock_warning_enabled', value.low_stock_warning_enabled, 'Warn when stock is low', { disabled }),
      checkRow('automatic_reorder_suggestions', value.automatic_reorder_suggestions, 'Suggest what to order', { disabled, help: usedHelp('inventory', 'automatic_reorder_suggestions') }),
      checkRow('barcode_gallery_enabled', value.barcode_gallery_enabled, 'Allow photos from the gallery in the scanner', { disabled }),
      checkRow('allow_multiple_barcodes', value.allow_multiple_barcodes, 'Allow several barcodes per item', { disabled }),
      checkRow('staff_barcode_linking', value.staff_barcode_linking, 'Staff can link barcodes to items', { disabled })
    ])}
    <p class="settings-muted">${icon('lock')}Placing orders and changing stock from the scanner stay manual. Alcedo never does either by itself.</p>`);
    const temperature = ruleForm('temperature', 'Temperature log', (value, disabled) => `<div class="settings-grid">
      ${field('Reminder times', input('reminder_times', (value.reminder_times || []).join(', '), { disabled, placeholder: '10:00, 16:00' }), { help: 'Separate times with commas.' })}
      ${field('Escalate after (minutes)', input('escalation_minutes', value.escalation_minutes, { type: 'number', min: 0, max: 1440, disabled, inputmode: 'numeric' }))}
      ${field('Keep readings for (months)', input('retention_months', value.retention_months, { type: 'number', min: 1, max: 120, disabled, inputmode: 'numeric' }))}
    </div>
    ${checkList([
      checkRow('daily_log_required', value.daily_log_required, 'A daily reading is required', { disabled }),
      checkRow('photo_required_on_exception', value.photo_required_on_exception, 'Photo when a reading is out of range', { disabled }),
      checkRow('corrective_action_required', value.corrective_action_required, 'Say what was done when a reading is out of range', { disabled }),
      checkRow('manager_review_on_exception', value.manager_review_on_exception, 'A manager reviews out-of-range readings', { disabled })
    ])}`);
    const cleaning = ruleForm('cleaning', 'Cleaning', (value, disabled) => {
      const schedule = value.weekly_schedule || {};
      return `<div class="settings-grid">
        ${field('Sunday routine', input('schedule_sunday', schedule.sunday || '', { disabled }), { optional: true })}
        ${field('Monday routine', input('schedule_monday', schedule.monday || '', { disabled }), { optional: true })}
        ${field('Tuesday routine', input('schedule_tuesday', schedule.tuesday || '', { disabled }), { optional: true })}
        ${field('Escalate overdue after (minutes)', input('overdue_escalation_minutes', value.overdue_escalation_minutes, { type: 'number', min: 0, max: 1440, disabled, inputmode: 'numeric' }))}
      </div>
      ${checkList([
        checkRow('photo_required', value.photo_required, 'Photo required', { disabled }),
        checkRow('comment_required_on_exception', value.comment_required_on_exception, 'Comment when something is skipped', { disabled }),
        checkRow('manager_review_on_exception', value.manager_review_on_exception, 'A manager reviews skipped items', { disabled })
      ])}`;
    });
    const marketing = ruleForm('marketing', 'Marketing approvals', (value, disabled) => `
      ${field('Brand voice', textarea('brand_voice', value.brand_voice, { disabled, rows: 3 }), { help: 'Moves to Marketing settings with the Marketing redesign.' })}
      <div class="settings-grid">${field('Story frames by default', input('default_story_frames', value.default_story_frames, { type: 'number', min: 1, max: 10, disabled, inputmode: 'numeric' }))}</div>
      ${checkList([
        checkRow('approval_required', value.approval_required, 'Posts need approval', { disabled }),
        checkRow('ai_caption_drafts_enabled', value.ai_caption_drafts_enabled, 'Alcedo drafts captions', { disabled })
      ])}
      <p class="settings-muted">${icon('lock')}Publishing and analytics stay off until an account is connected in Integrations.</p>`);
    return `${sectionHead('Operational rules', 'Thresholds, reminders and approvals.')}
      ${operations}${inventory}${purchasingPolicyMarkup()}${temperature}${cleaning}${marketing}`;
  }

  function purchasingPolicyMarkup() {
    const policy = state.purchasingPolicy;
    let body;
    if (policy.status === 'loading' || policy.status === 'idle') body = `<div class="settings-facts" aria-busy="true">${'<div><span class="atlas-skel atlas-skel--text"></span><span class="atlas-skel atlas-skel--text"></span></div>'.repeat(5)}<span class="sr-only">Loading the ordering rules</span></div>`;
    else if (!policy.value) body = `<p class="settings-muted">${icon('circle-alert')}The ordering rules couldn’t be read. They are managed in Purchasing.</p>`;
    else {
      const value = policy.value;
      const money = (amount) => (amount == null ? 'Any amount' : clock()?.formatKr?.(amount) || String(amount));
      body = `<dl class="settings-facts">
        <div><dt>Approval before ordering</dt><dd>${value.approval_required ? `Required${value.approval_threshold_isk != null ? ` above ${escapeHtml(money(value.approval_threshold_isk))}` : ''}${value.approval_separate_approver ? ', by someone else' : ''}` : 'Not required'}</dd></div>
        <div><dt>Receiving more than ordered</dt><dd>${Number(value.over_receipt_tolerance_percent) > 0 ? `Up to ${escapeHtml(value.over_receipt_tolerance_percent)}% more` : 'Not allowed'}</dd></div>
        <div><dt>Closing an order short</dt><dd>${value.short_close_enabled ? 'Allowed' : 'Not allowed'}</dd></div>
        <div><dt>Delivery date required when ordering</dt><dd>${value.delivery_date_required_on_place ? 'Yes' : 'No'}</dd></div>
        <div><dt>Staff receive deliveries</dt><dd>${value.staff_receiving_enabled ? 'Yes' : 'No — managers only'}</dd></div>
      </dl>`;
    }
    return `<section class="settings-row" aria-labelledby="settings-po-title">
      ${rowLabel('Ordering', 'Read here; changed with Purchasing.', { id: 'settings-po-title', aside: '<div class="settings-row__actions"><a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#purchasing">Open Purchasing</a></div>' })}
      <div class="settings-row__panel">${body}</div>
    </section>`;
  }

  // ---------- Alcedo AI ----------

  const aiApi = (action, options) => request(cfg.ATLAS_AI_API, action, options);

  async function loadAi(force = false) {
    const ai = state.ai;
    if (ai.status === 'loading' || (!force && ai.status === 'ready')) return;
    ai.status = 'loading';
    render();
    const [settings, preferences] = await Promise.allSettled([
      isManager() ? aiApi('settings') : Promise.resolve(null),
      aiApi('preferences')
    ]);
    ai.settings = settings.status === 'fulfilled' && settings.value ? (settings.value.settings || settings.value) : null;
    ai.preferences = preferences.status === 'fulfilled' && preferences.value ? (preferences.value.preferences || preferences.value) : null;
    ai.error = settings.status === 'rejected' ? settings.reason : null;
    ai.status = 'ready';
    render();
  }

  // Loading: the row as it will be — a title and description bar beside a
  // panel of field-height bars — so nothing moves when the data lands.
  function skeletonRow(fields = 4, label = 'Loading') {
    return `<div class="settings-row settings-row--loading" aria-busy="true"><div class="settings-row__label"><span class="atlas-skel settings-skel--title"></span><span class="atlas-skel atlas-skel--text"></span><span class="atlas-skel atlas-skel--text settings-skel--short"></span></div><div class="settings-row__panel"><div class="settings-grid">${'<div class="settings-skel-field"><span class="atlas-skel atlas-skel--text settings-skel--short"></span><span class="atlas-skel settings-skel--control"></span></div>'.repeat(fields)}</div></div><span class="sr-only">${escapeHtml(label)}</span></div>`;
  }

  function aiSettingsForm() {
    const ai = state.ai;
    if (ai.status !== 'ready') return skeletonRow(6, 'Loading the Alcedo AI settings');
    if (!ai.settings) {
      const text = ai.error?.code === 'not_configured' ? 'Alcedo AI isn’t available in this environment yet.' : 'The Alcedo AI settings couldn’t be loaded. Nothing was changed.';
      return `<div class="settings-row">${rowLabel('Alcedo AI for the venue', 'Whether it is on, and how much each person can use it per day.')}<div class="settings-row__panel"><div class="atlas-alert atlas-alert--${ai.error?.code === 'not_configured' ? 'info' : 'danger'}" role="status">${icon(ai.error?.code === 'not_configured' ? 'info' : 'circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${escapeHtml(text)}</p></div>${ai.error?.code === 'not_configured' ? '' : '<div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-ai-retry>Try again</button></div>'}</div></div></div>`;
    }
    const value = ai.settings;
    const editable = Boolean(value.can_edit);
    const disabled = !editable;
    const status = value.enabled
      ? (value.configured === false ? pill('warning', 'On, but not connected yet') : pill('positive', 'On'))
      : pill('neutral', 'Off');
    const fields = AI_FIELDS.filter((entry) => Object.prototype.hasOwnProperty.call(value, entry.key));
    const controls = fields.map((entry) => {
      const current = value[entry.key];
      if (entry.type === 'toggle') return toggle(entry.key, Boolean(current), entry.label, { help: entry.help, disabled });
      if (entry.type === 'select') return field(entry.label, select(entry.key, current, entry.choices, { disabled }));
      if (entry.type === 'megabytes') return field(entry.label, input(entry.key, current == null ? '' : Math.round(Number(current) / 1048576), { type: 'number', min: entry.min, max: entry.max, disabled, inputmode: 'numeric' }));
      return field(entry.label, input(entry.key, current, { type: 'number', min: entry.min, max: entry.max, disabled, inputmode: 'numeric' }));
    });
    const switches = controls.filter((_, index) => fields[index].type === 'toggle');
    const rest = controls.filter((_, index) => fields[index].type !== 'toggle');
    return `<form class="settings-form settings-row" data-settings-ai-form>
      ${rowLabel('Alcedo AI for the venue', value.enabled && value.configured === false ? 'It is switched on here, but the service connection isn’t set up yet, so answers use saved records only.' : 'Limits apply to each person, per day.', {
        status,
        meta: [value.updated_at ? `<p class="settings-form__meta">Last changed ${escapeHtml(formatDateTime(value.updated_at))}</p>` : '', readOnlyNote(editable)]
      })}
      <div class="settings-row__panel">
        ${switches.length ? `<div class="settings-switches">${switches.join('')}</div>` : ''}
        ${rest.length ? `<div class="settings-grid">${rest.join('')}</div>` : ''}
        ${feedback('ai')}
        ${editable ? saveBar('ai') : ''}
      </div>
    </form>`;
  }

  function aiPreferencesForm() {
    const ai = state.ai;
    if (ai.status !== 'ready' || !ai.preferences) return '';
    const value = ai.preferences;
    const has = (key) => Object.prototype.hasOwnProperty.call(value, key);
    const switches = [
      has('speak_answers') ? toggle('speak_answers', Boolean(value.speak_answers), 'Read answers aloud in voice conversations') : '',
      has('voice_enabled') ? toggle('voice_enabled', Boolean(value.voice_enabled), 'Offer voice in Alcedo AI') : ''
    ].filter(Boolean);
    return `<form class="settings-form settings-row" data-settings-ai-preferences-form>
      ${rowLabel('Your replies', 'How Alcedo AI answers you. Only you see these.')}
      <div class="settings-row__panel">
        <div class="settings-grid">
          ${has('reply_length') ? field('Reply length', select('reply_length', value.reply_length, [['short', 'Short'], ['normal', 'Normal'], ['detailed', 'Detailed']])) : ''}
          ${has('language') ? field('Language', select('language', value.language, [['auto', 'Same as my question'], ['en', 'English'], ['is', 'Íslenska']])) : ''}
        </div>
        ${switches.length ? `<div class="settings-switches">${switches.join('')}</div>` : ''}
        ${feedback('ai-preferences')}
        ${saveBar('ai-preferences')}
      </div>
    </form>`;
  }

  function decisionsForm() {
    return ruleForm('brain', 'Suggestions and learning', (value, disabled) => `
    ${checkList([
      checkRow('purchase_learning_enabled', value.purchase_learning_enabled, 'Learn from orders', { disabled, help: usedHelp('brain', 'purchase_learning_enabled') }),
      checkRow('menu_learning_enabled', value.menu_learning_enabled, 'Learn from recipes', { disabled, help: usedHelp('brain', 'menu_learning_enabled') }),
      checkRow('waste_learning_enabled', value.waste_learning_enabled, 'Learn from waste', { disabled, help: usedHelp('brain', 'waste_learning_enabled') })
    ])}
    <p class="settings-muted">${icon('lock')}Alcedo never acts on a suggestion by itself; a person approves every change.</p>`, 'What Alcedo AI learns from when it suggests things. Each setting changes Alcedo today.');
  }

  function aiMarkup() {
    return `${sectionHead('Alcedo AI', 'Whether Alcedo AI is on, its daily limits, and how it suggests things.')}
      ${aiSettingsForm()}${aiPreferencesForm()}${decisionsForm()}`;
  }

  // ---------- integrations ----------

  const integrationsApi = (action, options) => request(cfg.INTEGRATIONS_API, action, options);

  function providerLabel(key) {
    return state.integrations.providers.find((provider) => provider.provider_key === key)?.label || humanize(key);
  }

  // Branch on error_code only; the server's text is never shown (brief §6).
  function integrationMessage(code, provider) {
    const name = provider || 'The provider';
    switch (code) {
      case 'browser_mismatch': return 'Connecting was started in another browser, or this browser blocked Alcedo’s sign-in cookie. Nothing was connected. Start again from this browser.';
      case 'not_authorized': return 'Only an active manager or administrator can finish connecting. Nothing was connected.';
      case 'provider_check_failed': return `${name} didn’t accept the connection. Reconnect, or check the account on ${name}.`;
      case 'provider_refresh_failed': return `${name} didn’t renew access. Reconnect to continue.`;
      case 'credential_unreadable': return `Alcedo can’t read the saved ${name} connection any more. Disconnect, then connect again.`;
      case 'not_configured': return `${name === 'The provider' ? 'This connection' : name} isn’t set up yet. An administrator can set it up.`;
      case 'not_connected': return `${name} isn’t connected.`;
      case 'forbidden': return 'Only managers and administrators can change integrations.';
      case 'denied': return `You cancelled on ${name}. Nothing was connected.`;
      case 'invalid_request': return 'That wasn’t accepted. Check what you entered and try again.';
      case 'network': case 'timeout': return 'Alcedo couldn’t be reached. Nothing was changed — try again.';
      case 'verify_failed': return `${name} was connected but didn’t pass Alcedo’s check. Reconnect, or check the account on ${name}.`;
      case 'refresh_in_progress': return `Alcedo is renewing access to ${name} right now. Try again in a minute.`;
      case 'resource_not_listed': return 'That choice isn’t in the latest list any more. Open the list again and choose.';
      case 'resource_not_selectable': return `Alcedo can’t post there. Choose another one on ${name}.`;
      default: return 'Connecting didn’t finish. Nothing was changed — try again.';
    }
  }

  async function loadIntegrations(force = false) {
    const integrations = state.integrations;
    if (!isManager() || integrations.status === 'loading' || (!force && integrations.status === 'ready')) return;
    integrations.status = 'loading';
    render();
    try {
      const payload = await integrationsApi('status');
      integrations.providers = Array.isArray(payload?.providers) ? payload.providers : [];
      integrations.status = 'ready';
      integrations.error = null;
    } catch (error) {
      integrations.status = 'error';
      integrations.error = error;
    }
    render();
    // Back from the provider: when publishing needs a target, open the picker once.
    const autoPick = integrations.autoPick;
    integrations.autoPick = null;
    const picked = autoPick && integrations.providers.find((provider) => provider.provider_key === autoPick);
    if (picked?.publishing?.reason === 'no_resource_selected' && picked.publishing.can_choose_resource) openResourcePicker(picked.provider_key);
  }

  function replaceProvider(provider) {
    if (!provider?.provider_key) return;
    const list = state.integrations.providers;
    const index = list.findIndex((entry) => entry.provider_key === provider.provider_key);
    if (index >= 0) list[index] = provider; else list.push(provider);
  }

  async function integrationAction(key, action, body = {}) {
    const integrations = state.integrations;
    if (integrations.busy[key]) return;
    integrations.busy[key] = action;
    delete integrations.messages[key];
    render();
    try {
      if (action === 'start' || action === 'allow-publishing') {
        const purpose = action === 'allow-publishing' ? { purpose: 'publishing' } : {};
        const payload = await integrationsApi('start', { method: 'POST', body: { provider_key: key, return_path: '#settings/integrations', ...purpose } });
        if (payload?.authorize_url) {
          // The Alcedo hop on the functions domain binds this browser; never rebuilt here.
          window.location.assign(payload.authorize_url);
          return;
        }
        integrations.messages[key] = { tone: 'danger', text: integrationMessage('unknown', providerLabel(key)) };
      } else {
        const payload = await integrationsApi(action, { method: 'POST', body: { provider_key: key, ...body } });
        replaceProvider(payload?.provider);
        if (action === 'disconnect') integrations.messages[key] = { tone: 'positive', text: `${providerLabel(key)} is disconnected.` };
        else if (action === 'set-review-state') integrations.messages[key] = { tone: 'positive', text: 'Platform review saved.' };
        else if (payload?.verified === false) integrations.messages[key] = { tone: 'danger', text: integrationMessage(payload.error_code, providerLabel(key)) };
        else integrations.messages[key] = { tone: 'positive', text: action === 'save-api-key' ? `${providerLabel(key)} key saved and checked.` : `${providerLabel(key)} is working.` };
      }
    } catch (error) {
      integrations.messages[key] = { tone: 'danger', text: integrationMessage(error?.code || (error?.status === 403 ? 'forbidden' : null), providerLabel(key)) };
    } finally {
      delete integrations.busy[key];
      render();
    }
  }

  // Pill, status line and the primary next step for one card (S94B §4 states).
  function integrationView(provider) {
    const name = provider.label || humanize(provider.provider_key);
    const publishing = provider.publishing && provider.publishing.supported ? provider.publishing : null;
    const words = RESOURCE_WORDS[publishing?.resource_kind] || RESOURCE_WORDS.facebook_page;
    const connectionState = provider.connection_state;
    const base = INTEGRATION_STATES[connectionState] || ['neutral', 'Not connected'];
    const status = {
      // Owner copy only: what connecting would enable (S91).
      not_configured: provider.enables || '',
      ready: provider.auth_kind === 'api_key' ? 'Add the API key to connect.' : `Ready to connect. ${provider.enables || ''}`.trim(),
      verifying: 'Alcedo is checking the connection.',
      // Fixed words only: the provider's own text stays in the audit trail (S88 brief §6).
      verification_failed: 'The last check failed. Test again, or reconnect.',
      needs_reauthorization: publishing
        ? `Access expired or was removed on ${name}. Scheduled posts won’t publish until you reconnect.`
        : 'Access expired. Reconnect to continue.',
      pending_review: 'The platform is reviewing Alcedo’s access. Nothing to do until it finishes.',
      connected: ''
    }[connectionState] || '';
    if (!publishing || connectionState !== 'connected') return { tone: base[0], text: base[1], status, primary: null, state: connectionState };
    const target = publishing.resource?.label;
    switch (publishing.reason) {
      case null:
      case undefined:
        return {
          tone: 'positive', text: 'Publishing allowed', state: 'publishing_allowed',
          status: `${target ? `Connected as ${target}. ` : ''}Approved posts publish here.${publishing.direct_post === false ? ' Posts go to the TikTok inbox as drafts until TikTok approves Alcedo.' : ''}`,
          primary: null
        };
      case 'publishing_permission_missing':
        return { tone: 'warning', text: 'Publishing permission missing', state: 'publishing_missing', status: `Connected, but posting wasn’t allowed. Allow Alcedo to post on ${name}.`, primary: publishing.can_allow_publishing ? 'allow-publishing' : 'start' };
      case 'no_resource_selected':
        return { tone: 'warning', text: words.none, state: 'no_resource', status: `Connected. ${words.choose.replace('Choose', 'Choose which')} Alcedo posts to.`, primary: publishing.can_choose_resource ? 'choose-resource' : null };
      case 'review_required':
        return { tone: 'neutral', text: 'App review required', state: 'review_required', status: `${name} hasn’t approved Alcedo for posting yet. Plan and approve posts as usual and post them by hand until then.`, primary: null };
      case 'review_pending':
        return { tone: 'info', text: 'Platform review pending', state: 'review_pending', status: `${name} is reviewing Alcedo’s access. Nothing to do until it finishes.`, primary: null };
      default:
        return { tone: base[0], text: base[1], status, primary: null, state: connectionState };
    }
  }

  function capabilityMarkup(provider) {
    const publishing = provider.publishing;
    if (!publishing?.supported || provider.connection_state !== 'connected') return '';
    const words = RESOURCE_WORDS[publishing.resource_kind] || RESOURCE_WORDS.facebook_page;
    const allowed = publishing.permission_state === 'granted';
    const rows = [
      [allowed ? 'circle-check' : 'lock', allowed ? 'Publish approved posts' : 'Publish approved posts: not allowed yet'],
      [publishing.resource ? 'circle-check' : 'circle-dashed', publishing.resource ? `Posts go to ${publishing.resource.label}` : `${words.none} yet`]
    ];
    if (publishing.direct_post === false) rows.push(['info', 'Videos arrive in the TikTok inbox to finish there (private until TikTok approves Alcedo)']);
    if (publishing.direct_post === true) rows.push(['circle-check', 'Direct posting approved by TikTok']);
    return `<ul class="settings-provider__can">${rows.map(([glyph, text]) => `<li>${icon(glyph)}<span>${escapeHtml(text)}</span></li>`).join('')}</ul>`;
  }

  function reviewControlMarkup(provider, busy) {
    const publishing = provider.publishing;
    if (!publishing?.supported || !publishing.can_set_review_state || !isAdmin() || provider.connection_state === 'not_configured') return '';
    const key = provider.provider_key;
    const id = `settings-review-${key}`;
    const current = REVIEW_STATES.find(([value]) => value === publishing.review_state)?.[1] || 'Not checked yet';
    return `<details class="settings-needs settings-review" data-integration-review="${escapeHtml(key)}"><summary>Platform review: ${escapeHtml(current)}</summary>
      <p>Only the platform can see whether it approved Alcedo; record what it says here. ${key === 'tiktok' ? 'TikTok: approved allows direct posting.' : key === 'google-business-profile' ? 'Google: approved means Business Profile API access was granted.' : 'Meta: approved means App Review granted the posting permissions.'}</p>
      <div class="settings-review__row"><label class="sr-only" for="${id}">Platform review</label><select class="atlas-select" id="${id}" data-integration-review-select${busy ? ' disabled' : ''}>${REVIEW_STATES.map(([value, label]) => `<option value="${value}"${value === publishing.review_state ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
      <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm${busy === 'set-review-state' ? ' is-loading' : ''}" data-integration-review-save data-provider="${escapeHtml(key)}"${busy ? ' disabled' : ''}>Save</button></div>
    </details>`;
  }

  function eventsMarkup(provider) {
    const events = Array.isArray(provider.recent_events) ? provider.recent_events.filter((event) => INTEGRATION_EVENTS[event.event_type]) : [];
    if (!events.length || provider.connection_state === 'not_configured') return '';
    return `<details class="settings-provider__events"><summary>Recent activity</summary><ul>${events.map((event) => `<li>${escapeHtml(INTEGRATION_EVENTS[event.event_type])}${event.actor_label ? ` · ${escapeHtml(event.actor_label)}` : ''} · ${escapeHtml(formatDateTime(event.created_at))}</li>`).join('')}</ul></details>`;
  }

  function providerMarkup(provider) {
    const key = provider.provider_key;
    const view = integrationView(provider);
    const busy = state.integrations.busy[key];
    const message = state.integrations.messages[key];
    const publishing = provider.publishing?.supported ? provider.publishing : null;
    const words = RESOURCE_WORDS[publishing?.resource_kind] || RESOURCE_WORDS.facebook_page;
    const facts = [];
    if (provider.account_label) facts.push(`Account: ${provider.account_label}`);
    if (provider.connected_by_label && provider.connected_at) facts.push(`Connected by ${provider.connected_by_label} · ${formatDateTime(provider.connected_at)}`);
    if (provider.last_verified_at) facts.push(`Last checked ${formatDateTime(provider.last_verified_at)}`);
    const button = (action, label, variant = 'secondary') => `<button type="button" class="atlas-btn atlas-btn--${variant} atlas-btn--sm${busy === action ? ' is-loading' : ''}" data-integration-action="${action}" data-provider="${escapeHtml(key)}"${busy ? ' disabled' : ''}${busy === action ? ' aria-busy="true"' : ''}>${escapeHtml(label)}</button>`;
    const actions = [];
    if (view.primary === 'allow-publishing') actions.push(button('allow-publishing', 'Allow publishing', 'primary'));
    if (view.primary === 'choose-resource') actions.push(button('choose-resource', words.choose, 'primary'));
    if (provider.can_connect) {
      const connectionState = provider.connection_state;
      if (connectionState === 'ready') actions.push(button('start', 'Connect', 'primary'));
      else if (connectionState === 'needs_reauthorization' || view.primary === 'start') actions.push(button('start', 'Reconnect', 'primary'));
      else if (connectionState === 'verification_failed' || (connectionState === 'connected' && !publishing)) actions.push(button('start', 'Reconnect'));
      else if (connectionState === 'verifying') actions.push(button('start', 'Connect'));
    }
    if (publishing && publishing.can_choose_resource && view.primary !== 'choose-resource' && publishing.resource && publishing.resource_kind !== 'tiktok_account') actions.push(button('choose-resource', words.change));
    if (provider.can_test) actions.push(button('test', 'Test connection'));
    if (provider.can_disconnect && provider.connection_state !== 'not_configured') actions.push(button('disconnect', 'Disconnect', 'ghost'));
    const keyForm = provider.can_save_api_key ? `<form class="settings-apikey" data-integration-key-form data-provider="${escapeHtml(key)}">
        ${field('API key', `<input class="atlas-input" type="password" name="api_key" autocomplete="off" spellcheck="false" minlength="8" maxlength="256" required${busy ? ' disabled' : ''}>`, { help: 'Saved encrypted on the server and never shown again.' })}
        <button type="submit" class="atlas-btn atlas-btn--secondary atlas-btn--sm${busy === 'save-api-key' ? ' is-loading' : ''}"${busy ? ' disabled' : ''}>Save key</button>
      </form>` : '';
    // The technical setup list is for administrators only (function secret
    // names, never values); everyone else sees "Not set up yet" and what it
    // enables (S91).
    const setup = provider.setup_details;
    const needs = provider.connection_state === 'not_configured' && isAdmin() && setup
      ? `<details class="settings-needs" data-provider-setup><summary>Setup details</summary>${setup.summary ? `<p>${escapeHtml(setup.summary)}</p>` : ''}${Array.isArray(setup.requirements) && setup.requirements.length ? `<ul>${setup.requirements.map((entry) => `<li><code>${escapeHtml(entry.name)}</code> ${escapeHtml(entry.label)}</li>`).join('')}</ul>` : ''}<p>These are set as function secrets on the Alcedo server. Their values are never shown here.</p></details>`
      : '';
    const linked = state.focusProvider === key;
    return `<li class="settings-provider${linked ? ' is-linked-target' : ''}" data-provider-card="${escapeHtml(key)}" data-integration-state="${escapeHtml(view.state || provider.connection_state || '')}"${linked ? ' aria-current="true"' : ''}>
      <div class="settings-provider__head"><div><h3 class="settings-provider__name">${escapeHtml(provider.label || humanize(key))}</h3>${view.status ? `<p class="settings-provider__status">${escapeHtml(view.status)}</p>` : ''}</div>${pill(view.tone, view.text)}</div>
      ${facts.length ? `<p class="settings-provider__facts">${escapeHtml(facts.join(' · '))}</p>` : ''}
      ${capabilityMarkup(provider)}
      ${needs}
      ${keyForm}
      ${actions.length ? `<div class="settings-actions">${actions.join('')}</div>` : ''}
      ${reviewControlMarkup(provider, busy)}
      ${eventsMarkup(provider)}
      ${message ? `<p class="settings-form-feedback is-${message.tone === 'danger' ? 'error' : 'success'}" role="${message.tone === 'danger' ? 'alert' : 'status'}">${icon(message.tone === 'danger' ? 'circle-alert' : 'circle-check')}${escapeHtml(message.text)}</p>` : ''}
    </li>`;
  }

  // ---------- resource picker (S94B) ----------

  function initials(label) {
    const words = String(label || '').replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
    return (words.slice(0, 2).map((word) => word.charAt(0)).join('') || '?').toUpperCase();
  }

  const UNAVAILABLE = {
    no_create_content: 'You can’t post for this Page. Ask a Page admin for content access.',
    not_verified: 'Not verified on Google yet.',
    site_manager: 'Site managers can’t post for this location.'
  };

  function resourceMeta(resource) {
    const details = resource.details || {};
    switch (resource.resource_kind) {
      case 'facebook_page': return ['Page', details.category].filter(Boolean).join(' · ');
      case 'instagram_account': return details.page_name ? `Linked to the ${details.page_name} Page` : 'Instagram professional account';
      case 'gbp_location': return [details.address, details.account_label].filter(Boolean).join(' · ') || 'Business Profile location';
      default: return 'TikTok account';
    }
  }

  function pickerEmpty(kind, notes) {
    switch (kind) {
      case 'instagram_account': return ['No Instagram account found', notes?.pages_without_instagram ? 'None of your Pages has a linked Instagram professional account. Link it in Instagram, then open this list again.' : 'The account you connected doesn’t manage a Page with an Instagram professional account.'];
      case 'gbp_location': return ['No locations found', 'The Google account you connected doesn’t manage a Business Profile location. Connect with the account that manages the venue’s profile.'];
      case 'tiktok_account': return ['No account found', 'TikTok didn’t return the connected account. Reconnect TikTok.'];
      default: return ['No Pages found', 'The Facebook account you connected doesn’t manage any Pages. Connect with the account that manages the venue’s Page.'];
    }
  }

  function pickerBodyMarkup(picker) {
    const words = RESOURCE_WORDS[picker.kind] || RESOURCE_WORDS.facebook_page;
    if (picker.status === 'loading') return `<div aria-busy="true">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(3)}<span class="sr-only">Loading the list</span></div>`;
    if (picker.status === 'error') return `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(integrationMessage(picker.error, providerLabel(picker.provider)))}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-picker-retry>Try again</button></div></div>`;
    if (!picker.resources.length) {
      const [title, text] = pickerEmpty(picker.kind, picker.notes);
      return `<div class="atlas-empty atlas-empty--inline" data-picker-empty><div class="atlas-empty__icon">${icon('search-x')}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-picker-reconnect>Reconnect</button></div>`;
    }
    const current = picker.resources.find((resource) => resource.selected)?.resource_id || '';
    return `<fieldset class="settings-picker" data-picker-options><legend class="sr-only">${escapeHtml(words.title)}</legend>
      ${picker.resources.map((resource) => {
        const disabled = !resource.selectable;
        const reason = disabled ? UNAVAILABLE[resource.unavailable_reason] || 'Alcedo can’t post there.' : '';
        return `<label class="atlas-check-row settings-picker__option${disabled ? ' is-disabled' : ''}">
          <input class="atlas-radio" type="radio" name="settings-resource" value="${escapeHtml(resource.resource_id)}"${resource.resource_id === (picker.choice ?? current) ? ' checked' : ''}${disabled ? ' disabled' : ''}>
          <span class="atlas-avatar atlas-avatar--lg" aria-hidden="true">${escapeHtml(initials(resource.label))}</span>
          <span class="settings-picker__text"><span class="settings-picker__name">${escapeHtml(resource.label)}${resource.selected ? ' <span class="atlas-badge atlas-badge--muted">In use</span>' : ''}</span><span class="settings-picker__meta">${escapeHtml(reason || resourceMeta(resource))}</span></span>
        </label>`;
      }).join('')}
    </fieldset>`;
  }

  function pickerPanel(picker) {
    const words = RESOURCE_WORDS[picker.kind] || RESOURCE_WORDS.facebook_page;
    const full = picker.resources.length > 5 ? ' atlas-sheet--full-phone' : '';
    return `<section class="atlas-sheet settings-picker-sheet${full}" data-modal-panel role="dialog" aria-modal="true" aria-labelledby="settings-picker-title">
      <span class="atlas-sheet__grabber" aria-hidden="true"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="settings-picker-title">${escapeHtml(words.title)}</h2><p class="atlas-sheet__desc">Alcedo posts only to the one you choose. You can change it later.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
      <div class="atlas-sheet__body" data-picker-body>${pickerBodyMarkup(picker)}</div>
      <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-picker-use disabled>${escapeHtml(words.use)}</button></footer>
    </section>`;
  }

  // The live list comes from the provider through atlas-integrations; the
  // sheet never sees a token. Nothing is pre-selected except the one in use.
  function openResourcePicker(key, trigger = null) {
    const provider = state.integrations.providers.find((entry) => entry.provider_key === key);
    const kind = provider?.publishing?.resource_kind;
    const modal = window.AtlasModal;
    if (!kind || !modal?.layer) return;
    const picker = { provider: key, kind, status: 'loading', resources: [], notes: {}, error: null, choice: null, saving: false };
    const root = modal.layer({ id: 'settings-resource-picker', panel: pickerPanel(picker), onClose: () => trigger?.focus?.() });
    // Repaint the body and the Use button only: the dialog element that
    // AtlasModal registered (focus trap, close controls) stays in place.
    const paint = () => {
      const body = root.querySelector('[data-picker-body]');
      const use = root.querySelector('[data-picker-use]');
      if (!body || !use) return;
      body.innerHTML = pickerBodyMarkup(picker);
      const ready = picker.status === 'ready' && picker.resources.some((resource) => resource.selectable);
      const chosen = picker.choice ?? picker.resources.find((resource) => resource.selected)?.resource_id;
      use.disabled = !ready || !chosen || picker.saving;
      use.classList.toggle('is-loading', picker.saving);
      root.querySelector('.atlas-sheet')?.classList.toggle('atlas-sheet--full-phone', picker.resources.length > 5);
      window.lucide?.createIcons?.();
    };
    const load = async () => {
      picker.status = 'loading';
      paint();
      try {
        const payload = await integrationsApi('list-resources', { method: 'POST', body: { provider_key: key } });
        picker.resources = Array.isArray(payload?.resources) ? payload.resources : [];
        picker.notes = payload?.notes || {};
        picker.status = 'ready';
        replaceProvider(payload?.provider);
        render();
      } catch (error) {
        picker.status = 'error';
        picker.error = error?.code || (error?.status === 403 ? 'forbidden' : null);
      }
      if (root.isConnected) paint();
    };
    const choose = async () => {
      const value = picker.choice ?? picker.resources.find((resource) => resource.selected)?.resource_id;
      const resource = picker.resources.find((entry) => entry.resource_id === value && entry.selectable);
      if (!resource) return;
      const current = picker.resources.find((entry) => entry.selected);
      if (current && current.resource_id !== resource.resource_id && modal.confirm) {
        const words = RESOURCE_WORDS[kind] || RESOURCE_WORDS.facebook_page;
        const ok = await modal.confirm({ title: `Change to another ${words.noun}?`, body: `Scheduled posts will publish to ${resource.label}.`, confirmLabel: words.change, cancelLabel: 'Keep current', id: 'settings-picker-confirm' });
        if (!ok) return;
      }
      picker.saving = true;
      paint();
      try {
        const payload = await integrationsApi('select-resource', { method: 'POST', body: { provider_key: key, resource_kind: kind, resource_id: resource.resource_id } });
        replaceProvider(payload?.provider);
        state.integrations.messages[key] = { tone: 'positive', text: `Posts go to ${payload?.selected?.label || resource.label} on ${providerLabel(key)}.` };
        modal.dismiss(root, 'done');
        window.AtlasShell?.toast?.(`Posts go to ${payload?.selected?.label || resource.label} on ${providerLabel(key)}.`, { tone: 'success' });
        render();
      } catch (error) {
        picker.saving = false;
        picker.status = 'error';
        picker.error = error?.code || (error?.status === 403 ? 'forbidden' : null);
        if (root.isConnected) paint();
      }
    };
    root.addEventListener('change', (event) => {
      if (event.target?.name !== 'settings-resource') return;
      picker.choice = event.target.value;
      root.querySelector('[data-picker-use]')?.removeAttribute('disabled');
    });
    root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-picker-retry]')) { load(); return; }
      if (target.closest('[data-picker-reconnect]')) { modal.dismiss(root, 'reconnect'); integrationAction(key, 'start'); return; }
      if (target.closest('[data-picker-use]') && !target.closest('[data-picker-use]').disabled) choose();
    });
    load();
  }

  function integrationNoticeMarkup() {
    const notice = state.integrations.notice;
    if (!notice) return '';
    const name = providerLabel(notice.provider);
    const ok = notice.result === 'connected';
    return `<div class="atlas-alert atlas-alert--${ok ? 'positive' : 'danger'}" role="${ok ? 'status' : 'alert'}" data-integration-notice>${icon(ok ? 'circle-check' : 'circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(ok ? `${name} is connected.` : integrationMessage(notice.reason, name))}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-integration-notice-close>Dismiss</button></div></div>`;
  }

  function integrationsMarkup() {
    const integrations = state.integrations;
    let body;
    let summary = '';
    if (integrations.status === 'idle' || integrations.status === 'loading') body = `<div class="settings-providers" aria-busy="true">${'<div class="settings-provider settings-provider--loading"><span class="atlas-skel settings-skel--title"></span><span class="atlas-skel atlas-skel--text"></span></div>'.repeat(4)}<span class="sr-only">Loading integrations</span></div>`;
    else if (integrations.status === 'error') {
      body = integrations.error?.code === 'not_configured'
        ? `<div class="atlas-empty atlas-empty--inline settings-panel__empty"><div class="atlas-empty__icon">${icon('plug')}</div><h3>Not set up yet</h3><p>Integrations connect Alcedo to your Google, Meta, TikTok and Tripadvisor accounts. An administrator can set them up.</p></div>`
        : `<div class="settings-panel__inset"><div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Integrations couldn’t be loaded.</p><p class="atlas-alert__body">${escapeHtml(integrations.error?.status === 403 ? 'Only managers and administrators can see integrations.' : 'Nothing was changed. Try again.')}</p></div>${integrations.error?.status === 403 ? '' : '<div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-integrations-retry>Try again</button></div>'}</div></div>`;
    } else if (!integrations.providers.length) body = '<p class="settings-empty">No integrations are available.</p>';
    else {
      body = `<ul class="settings-providers">${integrations.providers.map(providerMarkup).join('')}</ul>`;
      // Counts follow the rows on screen: connected, and the ones a person must act on.
      const views = integrations.providers.map((provider) => ({ provider, view: integrationView(provider) }));
      const connected = views.filter(({ provider }) => provider.connection_state === 'connected').length;
      const attention = views.filter(({ view }) => view.tone === 'warning').length;
      summary = `<p class="settings-form__meta num">${escapeHtml(`${connected} of ${views.length} connected${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`)}</p>`;
    }
    return `${sectionHead('Integrations', 'Outside accounts Alcedo can use. Connecting happens on the provider’s own page; Alcedo never sees passwords.')}
      ${integrationNoticeMarkup()}
      <section class="settings-row" aria-labelledby="settings-providers-title">
        ${rowLabel('Connections', 'Each account is connected on its own. Posting needs the platform’s permission and a chosen Page, account or location.', {
          id: 'settings-providers-title',
          meta: summary,
          aside: `<p class="settings-muted settings-row__note">${icon('lock')}Alcedo only publishes posts someone approved. Planning in Marketing works without any connection.</p>`
        })}
        <div class="settings-row__panel settings-row__panel--flush">${body}</div>
      </section>`;
  }

  // One-time notice after the provider redirect: /?integration=…&result=…&reason=…#settings/…
  function readIntegrationCallback() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const provider = params.get('integration');
    const result = params.get('result');
    if (!provider || !result) return;
    state.integrations.notice = { provider, result, reason: params.get('reason') };
    if (result === 'connected') state.integrations.autoPick = provider;
    ['integration', 'result', 'reason'].forEach((key) => params.delete(key));
    const query = params.toString();
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`); } catch { /* address bar only */ }
    state.section = 'integrations';
    if (!/^#settings/.test(window.location.hash)) window.AtlasShell?.navigate?.('#settings/integrations');
  }

  // ---------- security, system, preferences, activity ----------

  function securityMarkup() {
    const enforced = [
      ['Staff sign-in', 'Every account signs in with its own email and password; passwords are never stored in Alcedo.'],
      ['Active profile required', 'Deactivated profiles are signed out, and every request checks the profile again.'],
      ['Role-based access', 'Costs, purchasing and item changes are limited to managers and administrators.'],
      ['Keys stay on the server', 'Service keys and connection secrets never reach the browser.']
    ];
    const unavailable = [
      ['Automatic sign-out after inactivity', 'Not enforced yet — sessions follow the sign-in provider’s refresh rules.'],
      ['Trusted devices', 'Not available yet.'],
      ['Emergency lockdown', 'Not available yet — deactivate a profile in Team to remove access.']
    ];
    const list = (rows, glyph) => `<ul class="settings-capabilities">${rows.map(([title, detail]) => `<li>${icon(glyph)}<span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></span></li>`).join('')}</ul>`;
    return `${sectionHead('Security', 'What Alcedo enforces today, and what isn’t available yet.')}
      <div class="settings-security">
        ${mfaMarkup()}
        <section class="settings-row" aria-labelledby="settings-security-on">
          ${rowLabel('Enforced now', 'Protections every account has, whatever its role.', { id: 'settings-security-on', status: pill('positive', 'On'), meta: `<p class="settings-form__meta num">${enforced.length} protections</p>` })}
          <div class="settings-row__panel">${list(enforced, 'shield-check')}</div>
        </section>
        <section class="settings-row" aria-labelledby="settings-security-off">
          ${rowLabel('Not available yet', 'Listed so nobody assumes they are on.', { id: 'settings-security-off', status: pill('neutral', 'Off') })}
          <div class="settings-row__panel">${list(unavailable, 'circle-dashed')}</div>
        </section>
      </div>`;
  }

  // S99: the current user's own authenticator (two-factor). Every account needs
  // one to sign in; this card lets the person set one up, replace it, or remove
  // then re-add it. It reads/writes only the current user's factors through the
  // app's Supabase client (window.atlasSupabase).
  function mfaMarkup() {
    const mfa = state.mfa;
    let body;
    if (mfa.status === 'idle' || mfa.status === 'loading') {
      body = `<div aria-busy="true"><span class="atlas-skel atlas-skel--text"></span><span class="atlas-skel settings-skel--control settings-skel--button"></span><span class="sr-only">Checking your authenticator</span></div>`;
    } else if (mfa.status === 'error') {
      body = `<p class="settings-state is-error">${icon('circle-alert')}<span>Your authenticator status couldn’t be checked.</span></p>
        <div class="settings-actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-mfa-refresh>Try again</button></div>`;
    } else if (mfa.hasFactor) {
      // Replace first; the destructive Remove goes last, named in words, and
      // asks before it does anything (confirmRemoveMfa).
      body = `<p class="settings-state is-on">${icon('shield-check')}<span>An authenticator app is set up for your account. Alcedo asks for its 6-digit code when you sign in.</span></p>
        <div class="settings-actions">
          <button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm${mfa.busy ? ' is-loading' : ''}"${mfa.busy ? ' disabled aria-busy="true"' : ''} data-settings-mfa-setup>Replace authenticator</button>
          <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm settings-actions__destructive"${mfa.busy ? ' disabled' : ''} data-settings-mfa-remove>Remove authenticator</button>
        </div>`;
    } else {
      body = `<p class="settings-state is-off">${icon('shield-alert')}<span>No authenticator app is set up yet. You’ll be asked to add one the next time you sign in.</span></p>
        <div class="settings-actions"><button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm${mfa.busy ? ' is-loading' : ''}"${mfa.busy ? ' disabled aria-busy="true"' : ''} data-settings-mfa-setup>Set up authenticator</button></div>`;
    }
    return `<section class="settings-row settings-row--mfa" aria-labelledby="settings-security-mfa">
      ${rowLabel('Two-factor authentication', 'An authenticator app is required to sign in to Alcedo. It applies to your own account.', { id: 'settings-security-mfa', status: mfa.status === 'ready' ? pill(mfa.hasFactor ? 'positive' : 'neutral', mfa.hasFactor ? 'On' : 'Off') : '' })}
      <div class="settings-row__panel">${body}</div>
    </section>`;
  }

  function mfaClient() {
    return window.atlasSupabase || null;
  }

  async function loadMfaStatus(force) {
    const client = mfaClient();
    if (!client?.auth?.mfa) { state.mfa.status = 'error'; return; }
    if (state.mfa.status === 'loading') return;
    if (!force && state.mfa.status === 'ready') return;
    state.mfa.status = 'loading';
    try {
      const { data, error } = await client.auth.mfa.listFactors();
      if (error) throw error;
      state.mfa.hasFactor = (data?.totp || []).some((factor) => factor.status === 'verified');
      state.mfa.status = 'ready';
    } catch (error) {
      console.warn('Authenticator status could not be read', error?.message || error);
      state.mfa.status = 'error';
    }
    if (state.section === 'security' && settingsVisible()) render();
  }

  function openMfaSetup() {
    const client = mfaClient();
    if (!client || !window.AtlasMfaEnroll) { window.AtlasShell?.toast?.('Two-factor setup isn’t available right now. Reload Alcedo and try again.'); return; }
    const root = document.createElement('div');
    root.className = 'atlas-modal';
    root.dataset.atlasModal = '';
    root.hidden = true;
    root.innerHTML = `<section class="atlas-dialog atlas-dialog--form settings-mfa-dialog" data-modal-panel aria-labelledby="settings-mfa-title" aria-describedby="settings-mfa-desc">
      <h2 class="atlas-dialog__title" id="settings-mfa-title">Set up your authenticator</h2>
      <p class="settings-mfa-dialog__desc" id="settings-mfa-desc">Three steps, about a minute. Keep your phone at hand.</p>
      <div class="atlas-dialog__body"><div data-settings-mfa-host></div></div>
      <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button></div>
    </section>`;
    document.body.appendChild(root);
    const modal = window.AtlasModal;
    let controller = null;
    const cleanup = () => { controller?.destroy?.(); root.remove(); };
    if (!modal) { cleanup(); return; }
    modal.register(root, { onClose: () => window.setTimeout(cleanup, 0) });
    modal.open(root);
    window.AtlasMfaEnroll.mount(root.querySelector('[data-settings-mfa-host]'), {
      client,
      onVerified: () => {
        window.AtlasShell?.toast?.('Authenticator set up');
        modal.close(root);
        loadMfaStatus(true);
      }
    }).then((instance) => { controller = instance; });
  }

  async function removeMfa() {
    const client = mfaClient();
    if (!client?.auth?.mfa) return;
    const answer = await (window.AtlasModal ? confirmRemoveMfa() : Promise.resolve(true));
    if (!answer) return;
    state.mfa.busy = true;
    if (state.section === 'security' && settingsVisible()) render();
    try {
      const { data } = await client.auth.mfa.listFactors();
      const factors = (data?.totp || []).filter((factor) => factor.status === 'verified');
      for (const factor of factors) { await client.auth.mfa.unenroll({ factorId: factor.id }); }
      window.AtlasShell?.toast?.('Authenticator removed. Set up a new one to keep signing in.');
    } catch (error) {
      window.AtlasShell?.toast?.('The authenticator couldn’t be removed. Try again.');
    } finally {
      state.mfa.busy = false;
      loadMfaStatus(true);
    }
  }

  function confirmRemoveMfa() {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'atlas-modal';
      root.dataset.atlasModal = '';
      root.hidden = true;
      root.innerHTML = `<section class="atlas-dialog" data-modal-panel aria-labelledby="settings-mfa-remove-title"><h2 class="atlas-dialog__title" id="settings-mfa-remove-title">Remove your authenticator?</h2><div class="atlas-dialog__body"><p>Alcedo stops asking for its code. You’ll need to set up an authenticator again the next time you sign in.</p></div><div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Keep it</button><button type="button" class="atlas-btn atlas-btn--danger-solid" data-settings-mfa-remove-confirm>Remove authenticator</button></div></section>`;
      document.body.appendChild(root);
      let answer = false;
      window.AtlasModal.register(root, { onClose: () => { root.remove(); resolve(answer); } });
      root.querySelector('[data-settings-mfa-remove-confirm]').addEventListener('click', () => { answer = true; window.AtlasModal.close(root); });
      window.AtlasModal.open(root);
    });
  }

  function systemMarkup() {
    return `${sectionHead('System health', 'Read-only checks of the Alcedo service. Anything not checked says so.')}<div class="settings-system" data-settings-system-host></div>`;
  }

  function preferencesMarkup() {
    const preference = state.workspace?.preferences || {};
    const device = window.AtlasNotifications?.snapshot?.() || { status: 'unsupported' };
    const stored = preference.start_view;
    const startView = START_VIEWS.some(([key]) => key === stored) ? stored : 'dashboard';
    const allowed = START_VIEWS.filter(([key]) => key === startView || window.AtlasShell?.nav?.allowed?.(START_VIEW_TARGETS[key] || key) !== false);
    return `${sectionHead('Preferences', 'How Alcedo opens and behaves for you. Saved to your profile.')}
      <form class="settings-form settings-row" data-settings-preferences-form>
        ${rowLabel('Opening and motion', 'Applied every time you sign in, on any device.')}
        <div class="settings-row__panel">
          <div class="settings-grid">${field('Start page', select('start_view', startView, allowed), { help: 'The page Alcedo opens after you sign in.' })}</div>
          ${checkList([checkRow('reduce_motion', preference.reduce_motion, 'Reduce motion', { help: 'Turns off animations across Alcedo.' })])}
          ${feedback('preferences')}
          ${saveBar('preferences', 'Save preferences')}
        </div>
      </form>
      <section class="settings-row" aria-labelledby="settings-fixed-title">
        ${rowLabel('Fixed for now', 'These follow the venue or have one option today.', { id: 'settings-fixed-title' })}
        <div class="settings-row__panel">
          <dl class="settings-facts">
            <div><dt>Notifications on this device</dt><dd>${escapeHtml(device.status === 'enabled' ? 'On' : 'Off')} · <a href="#settings/notifications">Manage</a></dd></div>
            <div><dt>Theme</dt><dd>Light, the only theme for now</dd></div>
            <div><dt>Language</dt><dd>English</dd></div>
            <div><dt>Time zone</dt><dd>The venue’s time, ${escapeHtml(clock()?.timeZone?.() || '')}</dd></div>
          </dl>
        </div>
      </section>`;
  }

  function activityMarkup() {
    const events = state.workspace?.events || [];
    const list = `<ul class="settings-activity">${events.map((event) => `<li class="settings-activity__row"><div class="settings-activity__body"><p class="settings-activity__title">${escapeHtml(humanize(event.section_key || 'settings'))} · ${escapeHtml(humanize(String(event.event_type || '').replace(/^settings_/, '')))}</p><p class="settings-activity__who">${escapeHtml(event.actor_label || 'Alcedo')}</p></div><time class="settings-activity__when num"${event.created_at ? ` datetime="${escapeHtml(event.created_at)}"` : ''}>${escapeHtml(formatDateTime(event.created_at))}</time></li>`).join('')}</ul>`;
    return `${sectionHead('Activity', 'Changes to settings, newest first. This history can’t be edited.')}
      <section class="settings-row" aria-labelledby="settings-activity-title">
        ${rowLabel('Settings changes', 'Every saved setting, with who changed it and when.', { id: 'settings-activity-title', meta: events.length ? `<p class="settings-form__meta num">${escapeHtml(plural(events.length, 'change', 'changes'))}</p>` : '' })}
        <div class="settings-row__panel settings-row__panel--flush">${events.length ? list : `<div class="atlas-empty atlas-empty--inline settings-panel__empty"><div class="atlas-empty__icon">${icon('history')}</div><h3>No changes yet</h3><p>Every saved setting appears here with who changed it.</p></div>`}</div>
      </section>`;
  }

  // ---------- page ----------

  function sectionMarkup(key) {
    switch (key) {
      case 'venue': return venueMarkup();
      case 'hours': return hoursMarkup();
      case 'team-access': return teamAccessMarkup();
      case 'notifications': return notificationsMarkup();
      case 'rules': return rulesMarkup();
      case 'ai': return aiMarkup();
      case 'integrations': return integrationsMarkup();
      case 'security': return securityMarkup();
      case 'system': return systemMarkup();
      case 'activity': return activityMarkup();
      default: return preferencesMarkup();
    }
  }

  // An entry's group is the nearest one at or above it in SECTIONS, so a role
  // that cannot see a group's first entry still gets the right label.
  function groupOf(entry) {
    for (let index = SECTIONS.indexOf(entry); index >= 0; index -= 1) if (SECTIONS[index].group) return SECTIONS[index].group;
    return '';
  }

  function navMarkup(sections, current) {
    let lastGroup = null;
    return `<nav class="settings-nav" aria-label="Settings sections"><ul>${sections.map((entry) => {
      const name = groupOf(entry);
      const group = name && name !== lastGroup ? `<li class="settings-nav__group">${escapeHtml(name)}</li>` : '';
      lastGroup = name || lastGroup;
      return `${group}<li><a class="settings-nav__link" href="#settings/${entry.key}"${entry.key === current ? ' aria-current="page"' : ''}>${icon(entry.icon)}<span>${escapeHtml(entry.label)}</span>${icon('chevron-right')}</a></li>`;
    }).join('')}</ul></nav>`;
  }

  function phone() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;
  }

  function render() {
    const element = host();
    if (!element || element.style.display === 'none') return;
    element.classList.remove('placeholder-view');
    const sections = visibleSections();
    const current = sections.some((entry) => entry.key === state.section) ? state.section : null;
    const showNav = sections.length > 2;
    // The settings belong to one venue: its name leads the line under the title.
    const venueName = String(section('venue')?.value?.business_name || '').trim();
    const subtitle = showNav ? `${venueName ? `${venueName} · ` : ''}Venue, access, integrations and your preferences` : 'Your preferences and notifications';
    const head = window.AtlasShell?.pageHead?.({ title: 'Settings', sub: subtitle }) || '<header class="page-head"><h1 class="page-head__title">Settings</h1></header>';
    let content;
    if (state.status === 'idle' || (state.status === 'loading' && !state.workspace)) content = `<header class="settings-section__head" aria-hidden="true"><div><span class="atlas-skel settings-skel--heading"></span><span class="atlas-skel atlas-skel--text settings-skel--wide"></span></div></header>${skeletonRow(6, 'Loading settings')}${skeletonRow(2, '')}`;
    else if (state.status === 'error' && !state.workspace) {
      content = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Settings couldn’t be loaded.</p><p class="atlas-alert__body">${escapeHtml(state.error?.status === 403 ? 'Your profile can’t open Settings. Ask an administrator.' : state.error?.status === 401 ? 'Alcedo couldn’t confirm your sign-in for this. Nothing has changed. Try again in a moment.' : 'Nothing was changed. Check the connection and try again.')}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-refresh>Try again</button></div></div>`;
    } else content = sectionMarkup(current || defaultSection());
    const listOnly = showNav && phone() && !current;
    const drafts = captureDrafts(element);
    // Re-renders keep what the person opened, and the page head that has
    // already played its entry (a new node would play it on every save).
    const openOffers = new Set([...element.querySelectorAll('[data-settings-offer-form] > details[open]')].map((node) => node.parentElement.dataset.offerId));
    const oldHead = element.querySelector('.settings > .page-head');
    element.innerHTML = `<div class="settings${showNav ? '' : ' settings--single'}${listOnly ? ' is-list' : ''}${current ? ' has-section' : ''}">
      ${head}
      <div class="settings-layout">
        ${showNav ? navMarkup(sections, current || (phone() ? null : defaultSection())) : ''}
        <div class="settings-content" data-settings-content>${listOnly ? '' : content}</div>
      </div>
    </div>`;
    restoreDrafts(element, drafts);
    const newHead = element.querySelector('.settings > .page-head');
    if (oldHead && newHead && oldHead.outerHTML === newHead.outerHTML) newHead.replaceWith(oldHead);
    element.querySelectorAll('[data-settings-offer-form] > details').forEach((node) => { if (openOffers.has(node.parentElement.dataset.offerId)) node.open = true; });
    element.querySelectorAll('[data-settings-hours-form]').forEach(paintWeek);
    element.querySelectorAll('[data-settings-section-form="venue"]').forEach(paintVenuePreview);
    if ((current || defaultSection()) === 'system' && !listOnly) window.AtlasSystem?.mount?.(element.querySelector('[data-settings-system-host]'));
    if ((current || defaultSection()) === 'security' && !listOnly && (state.mfa.status === 'idle')) loadMfaStatus();
    window.lucide?.createIcons?.();
    // #settings/integrations?provider=<key> (Alcedo AI record links): show that provider once it has loaded.
    if (state.focusProvider) {
      const card = [...element.querySelectorAll('[data-provider-card]')].find((node) => node.dataset.providerCard === state.focusProvider);
      if (card) {
        card.scrollIntoView({ block: 'center' });
        state.focusProvider = null;
      }
    }
  }

  function formKey(form) {
    if (!form) return '';
    if (form.dataset.settingsSectionForm) return `section:${form.dataset.settingsSectionForm}`;
    if (form.hasAttribute('data-settings-timezone-form')) return 'timezone';
    if (form.hasAttribute('data-settings-hours-form')) return 'hours';
    if (form.hasAttribute('data-settings-offer-form')) return `offer:${form.dataset.offerId || 'new'}`;
    if (form.dataset.settingsRoleForm) return `role:${form.dataset.settingsRoleForm}`;
    if (form.hasAttribute('data-settings-preferences-form')) return 'preferences';
    if (form.hasAttribute('data-settings-ai-form')) return 'ai';
    if (form.hasAttribute('data-settings-ai-preferences-form')) return 'ai-preferences';
    return '';
  }

  // Re-rendering replaces the section; unsaved edits in other forms are kept.
  function captureDrafts(element) {
    const drafts = {};
    if (!state.dirtyForms.size) return drafts;
    element.querySelectorAll('form').forEach((form) => {
      const key = formKey(form);
      if (!key || !state.dirtyForms.has(key)) return;
      drafts[key] = [...form.querySelectorAll('[name]')].map((entry) => ({
        name: entry.getAttribute('name'),
        row: entry.closest('[data-weekday]')?.dataset.weekday ?? null,
        value: entry.value,
        checked: entry.getAttribute('role') === 'switch' ? entry.getAttribute('aria-checked') === 'true' : entry.checked
      }));
    });
    return drafts;
  }

  function restoreDrafts(element, drafts) {
    Object.entries(drafts).forEach(([key, fields]) => {
      if (!state.dirtyForms.has(key)) return;
      const form = [...element.querySelectorAll('form')].find((candidate) => formKey(candidate) === key);
      if (!form) return;
      fields.forEach((entry) => {
        const scope = entry.row === null ? form : form.querySelector(`[data-weekday="${CSS.escape(entry.row)}"]`);
        const target = scope?.querySelector(`[name="${CSS.escape(entry.name)}"]`);
        if (!target || target.disabled) return;
        if (target.getAttribute('role') === 'switch') target.setAttribute('aria-checked', String(entry.checked));
        else if (target.type === 'checkbox' || target.type === 'radio') target.checked = entry.checked;
        else target.value = entry.value;
      });
      const bar = form.querySelector('[data-settings-savebar]');
      if (bar) bar.hidden = false;
    });
  }

  // ---------- load and save ----------

  function applyPayload(payload) {
    state.workspace = payload.workspace || state.workspace;
    state.staff = payload.staff || state.staff;
    applyPreferences();
  }

  async function load(options = {}) {
    if (state.status === 'loading') return;
    if (options.silent && state.dirtyForms.size) return;
    if (!state.workspace) state.status = 'loading';
    render();
    try {
      const payload = await api('snapshot');
      applyPayload(payload);
      state.status = 'ready';
      state.error = null;
    } catch (error) {
      state.error = error;
      state.status = state.workspace ? 'ready' : 'error';
    }
    render();
    afterSectionShown();
  }

  async function loadPurchasingPolicy() {
    const policy = state.purchasingPolicy;
    if (!isManager() || policy.status !== 'idle' || !window.atlasSupabase?.rpc) return;
    policy.status = 'loading';
    try {
      const { data, error } = await window.atlasSupabase.rpc('atlas_purchase_order_policy');
      policy.value = !error && data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch { policy.value = null; }
    policy.status = 'ready';
    render();
  }

  async function mutate(key, action, body, message, options = {}) {
    if (!key || state.savingForms.has(key)) return false;
    state.savingForms.add(key);
    delete state.formFeedback[key];
    render();
    try {
      const payload = await (options.request ? options.request() : api(action, { method: 'POST', body }));
      state.dirtyForms.delete(key);
      state.formFeedback[key] = { type: 'success', text: message };
      if (options.apply) options.apply(payload); else applyPayload(payload);
      // AtlasVenueClock re-reads hours and the venue time zone on this event.
      window.AtlasShell?.emit?.('settings:saved', { action, section_key: body?.section_key || null });
      return true;
    } catch (error) {
      state.formFeedback[key] = { type: 'error', text: options.errorText ? options.errorText(error) : friendlySaveError(error) };
      return false;
    } finally {
      state.savingForms.delete(key);
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
        currency: 'ISK',
        primary_language: fieldValue(form, 'primary_language') || current.primary_language || 'en',
        supported_languages: current.supported_languages || ['en', 'is'],
        email: fieldValue(form, 'email').trim(),
        phone: fieldValue(form, 'phone').trim(),
        website: fieldValue(form, 'website').trim(),
        booking_url: fieldValue(form, 'booking_url').trim()
      };
    }
    if (key === 'operations') {
      return {
        ...current,
        week_starts_on: numberValue(form, 'week_starts_on', 1),
        default_break_minutes: numberValue(form, 'default_break_minutes', 0),
        shift_confirmation_required: boolValue(form, 'shift_confirmation_required'),
        last_order_minutes_before_close: numberValue(form, 'last_order_minutes_before_close', 30),
        production_shift_sync_enabled: false
      };
    }
    if (key === 'inventory') {
      return {
        ...current,
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
        ...current,
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
        ...current,
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
        ...current,
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
        ...current,
        purchase_learning_enabled: boolValue(form, 'purchase_learning_enabled'),
        menu_learning_enabled: boolValue(form, 'menu_learning_enabled'),
        waste_learning_enabled: boolValue(form, 'waste_learning_enabled'),
        automatic_execution_enabled: false
      };
    }
    return current;
  }

  function aiPatch(form) {
    const current = state.ai.settings || {};
    const patch = {};
    let problem = null;
    AI_FIELDS.filter((entry) => Object.prototype.hasOwnProperty.call(current, entry.key)).forEach((entry) => {
      let value;
      if (entry.type === 'toggle') value = boolValue(form, entry.key);
      else if (entry.type === 'select') value = fieldValue(form, entry.key);
      else {
        const raw = fieldValue(form, entry.key).trim();
        const parsed = Number(raw);
        if (raw === '' || !Number.isInteger(parsed) || parsed < entry.min || parsed > entry.max) {
          problem = problem || `${entry.label} must be a whole number from ${entry.min} to ${entry.max}.`;
          return;
        }
        value = entry.type === 'megabytes' ? parsed * 1048576 : parsed;
      }
      if (value !== current[entry.key]) patch[entry.key] = value;
    });
    return { patch, problem };
  }

  async function handleSubmit(event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !host()?.contains(form)) return;
    const keyForm = form.hasAttribute('data-integration-key-form');
    if (keyForm) {
      event.preventDefault();
      const provider = form.dataset.provider;
      const apiKey = form.api_key.value.trim();
      if (!/^[\x21-\x7E]{8,256}$/.test(apiKey)) {
        state.integrations.messages[provider] = { tone: 'danger', text: 'An API key is 8 to 256 characters without spaces.' };
        render();
        return;
      }
      form.api_key.value = '';
      integrationAction(provider, 'save-api-key', { api_key: apiKey });
      return;
    }
    const key = formKey(form);
    if (!key) return;
    event.preventDefault();
    const sectionKey = form.dataset.settingsSectionForm;
    if (sectionKey) {
      await mutate(key, 'save-section', { section_key: sectionKey, expected_version: Number(form.dataset.version || 1), value: collectSectionValue(sectionKey, form) }, 'Saved.');
      return;
    }
    if (key === 'timezone') {
      const zone = fieldValue(form, 'timezone').trim();
      delete state.fieldErrors.timezone;
      const value = { ...(section('venue')?.value || {}), timezone: zone };
      await mutate(key, 'save-section', { section_key: 'venue', expected_version: Number(form.dataset.version || 1), value }, 'Time zone saved.', {
        errorText: (error) => {
          if (error?.status === 400 && /time ?zone/i.test(error.serverText || '')) {
            state.fieldErrors.timezone = `“${zone}” isn’t a time zone Alcedo recognises. Use a name such as ${exampleZone()}.`;
            return 'The time zone wasn’t saved.';
          }
          return friendlySaveError(error);
        }
      });
      return;
    }
    if (key === 'hours') {
      const hours = [...form.querySelectorAll('.settings-hours-row')].map((row) => ({
        weekday: Number(row.dataset.weekday),
        day_label: WEEKDAYS[Number(row.dataset.weekday)],
        is_open: Boolean(row.querySelector('[name="is_open"]')?.checked),
        open_time: hhmm(row.querySelector('[name="open_time"]')?.value),
        close_time: hhmm(row.querySelector('[name="close_time"]')?.value),
        close_next_day: Boolean(row.querySelector('[name="close_next_day"]')?.checked),
        kitchen_close_time: hhmm(row.querySelector('[name="kitchen_close_time"]')?.value),
        kitchen_close_next_day: false,
        last_order_time: hhmm(row.querySelector('[name="last_order_time"]')?.value),
        last_order_next_day: false
      })).sort((a, b) => a.weekday - b.weekday);
      // A problem is shown on the day itself (a row under it), its fields are
      // marked invalid and described by the message, and focus moves to the
      // first one, so the message is in view where the person is looking.
      // Nothing re-renders: the typed hours stay.
      const missing = hours.find((row) => row.is_open && (!row.open_time || !row.close_time));
      const problem = missing
        ? { weekday: missing.weekday, text: `${missing.day_label} is marked open — add its opening and closing times, or switch it off.`, fields: ['open_time', 'close_time'].filter((name) => !missing[name]) }
        : hoursProblem(EDITOR_DAYS.map((weekday) => hours.find((row) => row.weekday === weekday)).filter(Boolean));
      form.querySelectorAll('.settings-hours-row [aria-invalid]').forEach((input) => {
        input.removeAttribute('aria-invalid');
        const described = String(input.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== 'settings-hours-problem');
        if (described.length) input.setAttribute('aria-describedby', described.join(' ')); else input.removeAttribute('aria-describedby');
      });
      form.querySelector('.settings-hours__problem')?.remove();
      if (problem) {
        const row = form.querySelector(`.settings-hours-row[data-weekday="${problem.weekday}"]`);
        const fields = (problem.fields || ['open_time', 'close_time']).map((name) => row?.querySelector(`[name="${name}"]`)).filter(Boolean);
        const holder = document.createElement('tr');
        holder.className = 'settings-hours__problem';
        holder.innerHTML = '<td colspan="7"><p class="settings-form-feedback is-error" role="alert" id="settings-hours-problem" data-settings-hours-conflict></p></td>';
        const note = holder.querySelector('p');
        note.innerHTML = icon('circle-alert');
        note.append(document.createTextNode(problem.text));
        if (row) row.after(holder); else form.querySelector('.settings-hours tbody')?.append(holder);
        window.lucide?.createIcons?.();
        fields.forEach((input) => {
          input.setAttribute('aria-invalid', 'true');
          const described = new Set(String(input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
          described.add('settings-hours-problem');
          input.setAttribute('aria-describedby', [...described].join(' '));
        });
        const target = fields[missing ? 0 : fields.length - 1];
        target?.focus({ preventScroll: true });
        // The day and its message together, clear of the sticky top bar and save bar.
        (row || holder).scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }
      form.querySelector('[data-settings-hours-conflict]')?.remove();
      // Last orders after midnight belongs to the next day when the venue closes after midnight.
      hours.forEach((row) => {
        if (row.close_next_day && row.last_order_time && row.open_time && row.last_order_time < row.open_time) row.last_order_next_day = true;
        if (row.close_next_day && row.kitchen_close_time && row.open_time && row.kitchen_close_time < row.open_time) row.kitchen_close_next_day = true;
      });
      await mutate(key, 'save-hours', { hours }, 'Opening hours saved. Home uses them now.');
      return;
    }
    if (key.startsWith('offer:')) {
      let pricing = {};
      const rawPricing = fieldValue(form, 'pricing_json').trim();
      if (rawPricing) {
        try { pricing = JSON.parse(rawPricing); } catch {
          state.formFeedback[key] = { type: 'error', text: 'Prices must look like {"cocktails_isk":1990}.' };
          render();
          return;
        }
      }
      if (!fieldValue(form, 'start_time') || !fieldValue(form, 'end_time')) {
        state.formFeedback[key] = { type: 'error', text: 'Add when the offer starts and ends.' };
        render();
        return;
      }
      const days = EDITOR_DAYS.filter((weekday) => form.querySelector(`[name="day_${weekday}"]`)?.checked).sort();
      const saved = await mutate(key, 'save-offer', {
        offer_id: form.dataset.offerId || null,
        offer_key: fieldValue(form, 'offer_key').trim(),
        name: fieldValue(form, 'name').trim(),
        description: fieldValue(form, 'description').trim() || null,
        active: boolValue(form, 'active'),
        days,
        start_time: hhmm(fieldValue(form, 'start_time')),
        end_time: hhmm(fieldValue(form, 'end_time')),
        end_next_day: boolValue(form, 'end_next_day'),
        pricing,
        booking_url: fieldValue(form, 'booking_url').trim() || null,
        expected_version: form.dataset.offerId ? Number(form.dataset.version || 1) : null
      }, form.dataset.offerId ? 'Offer saved.' : 'Offer created.');
      if (saved && !form.dataset.offerId) { state.offerDraft = null; render(); }
      return;
    }
    if (key.startsWith('role:')) {
      const roleKey = form.dataset.settingsRoleForm;
      const permissions = {};
      form.querySelectorAll('input[name^="permission_"]').forEach((entry) => { permissions[entry.name.slice('permission_'.length)] = Boolean(entry.checked); });
      await mutate(key, 'save-role', { role_key: roleKey, permissions, expected_version: Number(form.dataset.version || 1) }, 'Permissions saved.');
      return;
    }
    if (key === 'preferences') {
      const current = state.workspace?.preferences || {};
      // Theme, density, language and time zone have no runtime yet; their
      // stored values go back unchanged. Notifications mirror the device.
      const saved = await mutate(key, 'save-preferences', {
        theme: ['dark', 'light', 'system'].includes(current.theme) ? current.theme : 'light',
        density: ['comfortable', 'compact'].includes(current.density) ? current.density : 'comfortable',
        language: ['en', 'is'].includes(current.language) ? current.language : 'en',
        start_view: fieldValue(form, 'start_view'),
        timezone: current.timezone || clock()?.timeZone?.() || undefined,
        reduce_motion: boolValue(form, 'reduce_motion'),
        browser_notifications: window.AtlasNotifications?.snapshot?.()?.status === 'enabled',
        email_notifications: false,
        preferences: {}
      }, 'Preferences saved. They apply every time you sign in.');
      if (saved) applyPreferences();
      return;
    }
    if (key === 'ai') {
      const { patch, problem } = aiPatch(form);
      if (problem) { state.formFeedback.ai = { type: 'error', text: problem }; render(); return; }
      if (!Object.keys(patch).length) { state.dirtyForms.delete('ai'); render(); return; }
      await mutate(key, 'ai-settings', null, 'Alcedo AI settings saved.', {
        request: () => aiApi('settings', { method: 'POST', body: { patch } }),
        apply: (payload) => { state.ai.settings = { ...(state.ai.settings || {}), ...(payload?.settings || payload || {}) }; },
        errorText: (error) => (error?.status === 403 ? 'Only managers and administrators can change Alcedo AI settings.' : error?.status === 400 ? 'A value is outside what Alcedo allows. Check the limits and try again.' : friendlySaveError(error))
      });
      return;
    }
    if (key === 'ai-preferences') {
      const current = state.ai.preferences || {};
      const patch = {};
      if ('reply_length' in current) patch.reply_length = fieldValue(form, 'reply_length');
      if ('speak_answers' in current) patch.speak_answers = boolValue(form, 'speak_answers');
      if ('voice_enabled' in current) patch.voice_enabled = boolValue(form, 'voice_enabled');
      if ('language' in current) patch.language = fieldValue(form, 'language');
      await mutate(key, 'ai-preferences', null, 'Saved.', {
        request: () => aiApi('preferences', { method: 'POST', body: { patch } }),
        apply: (payload) => { state.ai.preferences = { ...current, ...(payload?.preferences || payload || {}) }; }
      });
    }
  }

  async function updatePushPreference(enable) {
    if (state.notificationAction || !window.AtlasNotifications) return;
    state.notificationAction = true;
    delete state.formFeedback.push;
    render();
    try {
      const result = await (enable ? window.AtlasNotifications.enable() : window.AtlasNotifications.disable());
      if (result?.status === 'enabled') state.formFeedback.push = { type: 'success', text: 'Notifications are on for this device.' };
      else if (!enable && result?.status === 'pending') state.formFeedback.push = { type: 'success', text: 'Notifications are off for this device.' };
      else state.formFeedback.push = { type: 'error', text: result?.detail || 'Notifications couldn’t be turned on.' };
    } catch (error) {
      state.formFeedback.push = { type: 'error', text: window.AtlasApi ? window.AtlasApi.message(error, 'Notifications couldn’t be set up. Try again.') : 'Notifications couldn’t be set up. Try again.' };
    } finally {
      state.notificationAction = false;
      render();
    }
  }

  async function refreshDeviceStatus() {
    try { await window.AtlasNotifications?.refresh?.(); } catch { /* keeps its last state */ }
    if (['notifications', 'preferences'].includes(state.section) && settingsVisible()) render();
  }

  function settingsVisible() {
    const element = host();
    return Boolean(element) && element.style.display !== 'none' && window.AtlasShell?.current?.() === 'settings';
  }

  function markDirty(event) {
    const target = event.target instanceof Element ? event.target : null;
    const form = target?.closest('form');
    if (!form || !host()?.contains(form) || form.hasAttribute('data-integration-key-form')) return;
    const key = formKey(form);
    if (!key) return;
    state.dirtyForms.add(key);
    if (state.formFeedback[key]?.type === 'success') {
      delete state.formFeedback[key];
      form.querySelector('.settings-form-feedback')?.remove();
    }
    const bar = form.querySelector('[data-settings-savebar]');
    if (bar) bar.hidden = false;
    // The previews beside the form follow the edit before it is saved.
    if (key === 'hours') paintWeek(form);
    if (key === 'section:venue') paintVenuePreview(form);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    const switchButton = target.closest('[data-settings-toggle]');
    if (switchButton && !switchButton.disabled) {
      switchButton.setAttribute('aria-checked', String(switchButton.getAttribute('aria-checked') !== 'true'));
      markDirty({ target: switchButton });
      return;
    }
    if (target.closest('[data-settings-refresh]')) { load(); return; }
    if (target.closest('[data-settings-mfa-refresh]')) { loadMfaStatus(true); return; }
    if (target.closest('[data-settings-mfa-setup]')) { openMfaSetup(); return; }
    if (target.closest('[data-settings-mfa-remove]')) { removeMfa(); return; }
    if (target.closest('[data-settings-push-enable]')) { updatePushPreference(true); return; }
    if (target.closest('[data-settings-push-disable]')) { updatePushPreference(false); return; }
    const discard = target.closest('[data-settings-discard]');
    if (discard) {
      const key = formKey(discard.closest('form'));
      state.dirtyForms.delete(key);
      delete state.formFeedback[key];
      if (key === 'timezone') delete state.fieldErrors.timezone;
      render();
      return;
    }
    if (target.closest('[data-settings-copy-monday]')) {
      const form = target.closest('form');
      const monday = form.querySelector('.settings-hours-row[data-weekday="1"]');
      form.querySelectorAll('.settings-hours-row').forEach((row) => {
        if (row === monday) return;
        row.querySelectorAll('[name]').forEach((entry) => {
          const source = monday.querySelector(`[name="${CSS.escape(entry.name)}"]`);
          if (!source) return;
          if (entry.type === 'checkbox') entry.checked = source.checked; else entry.value = source.value;
        });
        syncHoursRow(row);
      });
      markDirty({ target: form });
      return;
    }
    if (target.closest('[data-settings-add-offer]')) {
      state.offerDraft = { active: true, days: [0, 1, 2, 3, 4, 5, 6], start_time: '', end_time: '', end_next_day: false, pricing: {}, booking_url: section('venue')?.value?.booking_url || '' };
      render();
      window.setTimeout(() => host()?.querySelector('[data-settings-offer-form][data-offer-id=""] [name="name"]')?.focus(), 0);
      return;
    }
    if (target.closest('[data-settings-cancel-offer]')) { state.offerDraft = null; delete state.formFeedback['offer:new']; render(); return; }
    if (target.closest('[data-settings-invite]')) { window.AtlasShell?.actions?.run?.('team.invite', { context: 'settings' }).catch(() => {}); return; }
    if (target.closest('[data-settings-ai-retry]')) { loadAi(true); return; }
    if (target.closest('[data-integrations-retry]')) { loadIntegrations(true); return; }
    if (target.closest('[data-integration-notice-close]')) { state.integrations.notice = null; render(); return; }
    const integration = target.closest('[data-integration-action]');
    if (integration && !integration.disabled) {
      const action = integration.dataset.integrationAction;
      const provider = integration.dataset.provider;
      if (action === 'disconnect') confirmDisconnect(provider, integration);
      else if (action === 'choose-resource') openResourcePicker(provider, integration);
      else integrationAction(provider, action);
      return;
    }
    const review = target.closest('[data-integration-review-save]');
    if (review && !review.disabled) {
      const value = review.closest('[data-integration-review]')?.querySelector('[data-integration-review-select]')?.value;
      if (value) integrationAction(review.dataset.provider, 'set-review-state', { review_state: value });
    }
  }

  function confirmDisconnect(provider, trigger) {
    const name = providerLabel(provider);
    const root = document.createElement('div');
    root.className = 'atlas-modal';
    root.dataset.atlasModal = '';
    root.hidden = true;
    root.innerHTML = `<div class="atlas-dialog" data-modal-panel aria-labelledby="settings-disconnect-title">
      <h2 class="atlas-dialog__title" id="settings-disconnect-title">Disconnect ${escapeHtml(name)}?</h2>
      <div class="atlas-dialog__body"><p>Alcedo deletes its saved access and stops using ${escapeHtml(name)}. You can connect again later.</p></div>
      <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Keep connected</button><button type="button" class="atlas-btn atlas-btn--danger-solid" data-settings-confirm-disconnect>Disconnect</button></div>
    </div>`;
    document.body.appendChild(root);
    const modal = window.AtlasModal;
    if (!modal) { root.remove(); integrationAction(provider, 'disconnect'); return; }
    modal.register(root, { onClose: () => window.setTimeout(() => { root.remove(); trigger?.focus?.(); }, 0) });
    root.querySelector('[data-settings-confirm-disconnect]').addEventListener('click', () => {
      modal.close(root);
      integrationAction(provider, 'disconnect');
    });
    modal.open(root);
  }

  function applyPreferences() {
    const preference = state.workspace?.preferences;
    if (!preference) return;
    const cached = {
      user_id: state.staff?.id || null,
      start_view: START_VIEW_TARGETS[preference.start_view] || 'dashboard',
      reduce_motion: Boolean(preference.reduce_motion)
    };
    try { window.localStorage.setItem(PREFERENCE_CACHE_KEY, JSON.stringify(cached)); } catch { /* storage unavailable */ }
    window.AtlasPreferences?.apply?.(cached);
  }

  // Loads a section needs the first time it is opened.
  function afterSectionShown() {
    const key = state.section || defaultSection();
    if (key === 'ai') loadAi();
    if (key === 'integrations') loadIntegrations();
    if (key === 'rules') loadPurchasingPolicy();
    if (key === 'notifications' || key === 'preferences') refreshDeviceStatus();
  }

  function show(params = {}) {
    state.focusProvider = params.provider ? String(params.provider) : null;
    const requested = params.section ? String(params.section) : null;
    const key = requested ? (SECTION_ALIASES[requested] || requested) : null;
    const allowed = visibleSections();
    state.section = key && allowed.some((entry) => entry.key === key) ? key : (phone() && allowed.length > 2 ? null : defaultSection());
    if (key && !allowed.some((entry) => entry.key === key)) state.section = defaultSection();
    if (!state.workspace && state.status !== 'loading') load();
    else render();
    afterSectionShown();
    const entry = SECTIONS.find((candidate) => candidate.key === state.section);
    window.AtlasChrome?.setTopBar?.(phone() && allowed.length > 2 && requested && entry ? { title: entry.label, back: '#settings' } : {});
    if (requested) window.requestAnimationFrame(() => host()?.querySelector('#settings-section-title')?.focus({ preventScroll: true }));
  }

  function init() {
    if (state.initialized) return true;
    const element = host();
    if (!element) return false;
    state.initialized = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('input', markDirty);
    document.addEventListener('change', markDirty);
    document.addEventListener('change', (event) => {
      if (event.target?.name === 'is_open') { const row = event.target.closest?.('.settings-hours-row'); if (row) syncHoursRow(row); }
    });
    readIntegrationCallback();
    const shell = window.AtlasShell;
    shell?.registerView?.('settings', { root: 'settings-view', title: 'Settings', render: (params) => show(params) });
    shell?.on?.('profile:ready', () => { if (settingsVisible()) render(); });
    window.addEventListener('focus', () => { if (settingsVisible() && state.workspace) load({ silent: true }); });
    window.addEventListener('online', () => { if (settingsVisible()) load({ silent: true }); });
    if (typeof window.matchMedia === 'function') window.matchMedia('(max-width: 767px)').addEventListener?.('change', () => { if (settingsVisible()) render(); });
    window.setTimeout(refreshDeviceStatus, 0);
    if (shell?.current?.() === 'settings') show(shell.params());
    return true;
  }

  window.AtlasSettings = {
    open: (key) => window.AtlasShell?.navigate?.(key ? `#settings/${key}` : '#settings'),
    refresh: () => load(),
    snapshot: () => state.workspace,
    section: () => state.section,
    tab: (key) => window.AtlasShell?.navigate?.(`#settings/${SECTION_ALIASES[key] || key}`),
    hoursProblem
  };

  if (!init()) {
    const timer = window.setInterval(() => { if (init()) window.clearInterval(timer); }, 120);
    window.setTimeout(() => window.clearInterval(timer), 12000);
  }
})();
