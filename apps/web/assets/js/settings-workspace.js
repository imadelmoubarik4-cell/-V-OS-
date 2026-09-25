// Settings — #settings/<section> (docs/design/Atlas_Experience_Redesign.md §7.15).
//
// Section nav (220 px) + one 720 px column. Every section is a form with its
// own save state; the sticky save bar appears only while that form has unsaved
// changes. Sections: venue, hours, team-access, notifications, rules, ai,
// integrations, security, system (administrators), preferences, activity.
// Staff see Preferences and Notifications only (the nav is hidden then).
//
// Sources: atlas-settings (snapshot and saves; S87/S88 contracts), atlas-ai
// (?action=settings for the venue's Atlas AI settings and limits, rendered from
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
  const SECTIONS = [
    { key: 'venue', label: 'Venue', icon: 'building-2', roles: ['admin', 'manager'] },
    { key: 'hours', label: 'Opening hours', icon: 'clock', roles: ['admin', 'manager'] },
    { key: 'team-access', label: 'Team access', icon: 'users', roles: ['admin'] },
    { key: 'notifications', label: 'Notifications', icon: 'bell', roles: null },
    { key: 'rules', label: 'Operational rules', icon: 'list-checks', roles: ['admin', 'manager'] },
    { key: 'ai', label: 'Atlas AI', icon: 'sparkles', roles: ['admin', 'manager'] },
    { key: 'integrations', label: 'Integrations', icon: 'plug', roles: ['admin', 'manager'] },
    { key: 'security', label: 'Security', icon: 'shield', roles: ['admin'] },
    { key: 'system', label: 'System health', icon: 'activity', roles: ['admin'] },
    { key: 'preferences', label: 'Preferences', icon: 'user-cog', roles: null, group: 'Personal' },
    { key: 'activity', label: 'Activity', icon: 'history', roles: ['admin', 'manager'], group: 'Personal' }
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
    ['dashboard', 'Home'], ['ai', 'Atlas AI'], ['team', 'Messages'], ['operations', 'Operations'],
    ['inventory', 'Inventory'], ['recipes', 'Recipes'], ['suppliers', 'Purchasing'],
    ['shifts', 'Shifts'], ['knowledge', 'Knowledge'], ['reports', 'Reports'], ['settings', 'Settings']
  ];
  const PREFERENCE_CACHE_KEY = 'atlas.preferences.v1';
  // Atlas AI venue settings (GET atlas-ai?action=settings). Only keys present
  // in the response are rendered, so older and newer servers both work.
  const AI_FIELDS = [
    { key: 'enabled', type: 'toggle', label: 'Atlas AI is on for the venue', help: 'When off, Atlas AI answers from saved records only and prepares nothing.' },
    { key: 'daily_turn_limit_per_user', type: 'number', label: 'Questions per person per day', min: 1, max: 10000 },
    { key: 'voice_sessions_per_day', type: 'number', label: 'Voice conversations per person per day', min: 1, max: 1000 },
    { key: 'voice_minutes_per_day', type: 'number', label: 'Voice minutes per person per day', min: 1, max: 1440 },
    { key: 'max_concurrent_voice_sessions', type: 'number', label: 'Voice conversations at the same time, per person', min: 1, max: 10 },
    { key: 'upload_files_per_day', type: 'number', label: 'Files per person per day', min: 1, max: 10000 },
    { key: 'upload_bytes_per_day', type: 'megabytes', label: 'Upload size per person per day (MB)', min: 1, max: 10240 },
    { key: 'media_retention_days', type: 'number', label: 'Keep photos and files for (days)', min: 1, max: 365 },
    { key: 'audio_retention', type: 'select', label: 'Voice recordings', choices: [['delete_after_transcription', 'Delete after they are written down'], ['keep_with_media', 'Keep with photos and files']] }
  ];
  const INTEGRATION_STATES = {
    not_configured: ['neutral', 'Not available yet'],
    ready: ['neutral', 'Not connected'],
    verifying: ['warning', 'Checking'],
    connected: ['positive', 'Connected'],
    verification_failed: ['warning', 'Needs attention'],
    needs_reauthorization: ['warning', 'Needs attention'],
    pending_review: ['info', 'Waiting for platform review']
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
    integrations: { status: 'idle', providers: [], error: null, busy: {}, messages: {}, notice: null },
    purchasingPolicy: { status: 'idle', value: null }
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
    if (error?.code === 'network' || error?.code === 'timeout') return 'Atlas couldn’t be reached. Nothing was saved — check the connection and try again.';
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
    return `<header class="settings-section__head"><div><h2 class="settings-section__title" id="settings-section-title" tabindex="-1">${escapeHtml(title)}</h2>${text ? `<p class="settings-section__sub">${escapeHtml(text)}</p>` : ''}</div>${actions}</header>`;
  }

  function formHead(title, text, extra = '') {
    return `<div class="settings-form__head"><div><h3 class="settings-form__title">${escapeHtml(title)}</h3>${text ? `<p class="settings-form__sub">${escapeHtml(text)}</p>` : ''}</div>${extra}</div>`;
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
    return `${sectionHead('Venue', 'The business details Atlas uses on documents, in Atlas AI and for your team.')}
    <form class="settings-form atlas-card" data-settings-section-form="venue" data-version="${Number(data?.version || 1)}">
      ${formHead('Venue details', '', readOnlyNote(!disabled))}
      <div class="settings-grid">
        ${field('Business name', input('business_name', value.business_name, { required: true, disabled, autocomplete: 'organization' }))}
        ${field('Legal name', input('legal_name', value.legal_name, { required: true, disabled }))}
        ${field('Registration number', input('registration_number', value.registration_number, { disabled }), { optional: true })}
        ${field('Location name', input('location_label', value.location_label, { disabled }), { optional: true, help: 'Shown next to the venue name, for example “Reykjavík”.' })}
        ${field('Address', input('address_line', value.address_line, { disabled, autocomplete: 'street-address' }), { optional: true })}
        ${field('City', input('city', value.city, { disabled, autocomplete: 'address-level2' }), { optional: true })}
        ${field('Country code', input('country_code', value.country_code, { disabled, placeholder: 'IS' }), { optional: true })}
        ${field('Language', select('primary_language', value.primary_language || 'en', [['en', 'English'], ['is', 'Íslenska']], { disabled }))}
        ${field('Email', input('email', value.email, { type: 'email', disabled, autocomplete: 'email' }), { optional: true })}
        ${field('Phone', input('phone', value.phone, { type: 'tel', disabled, autocomplete: 'tel' }), { optional: true })}
        ${field('Website', input('website', value.website, { type: 'url', disabled }), { optional: true })}
        ${field('Booking link', input('booking_url', value.booking_url, { type: 'url', disabled }), { optional: true })}
      </div>
      <dl class="settings-facts"><div><dt>Currency</dt><dd>ISK (fixed)</dd></div><div><dt>Time zone</dt><dd>${escapeHtml(value.timezone || clock()?.timeZone?.() || '')} · <a href="#settings/hours">Change in Opening hours</a></dd></div></dl>
      ${sectionVersion(data)}
      ${feedback('section:venue')}
      ${disabled ? '' : saveBar('section:venue')}
    </form>`;
  }

  function timezoneFormMarkup() {
    const data = section('venue');
    const zone = data?.value?.timezone || clock()?.timeZone?.() || '';
    const disabled = !data?.can_edit;
    const error = state.fieldErrors.timezone;
    const isDefault = clock()?.timezoneIsDefault?.();
    return `<form class="settings-form atlas-card" data-settings-timezone-form data-version="${Number(data?.version || 1)}">
      ${formHead('Time zone', 'Opening hours, checklists and “today” everywhere in Atlas use the venue’s time zone.', readOnlyNote(!disabled))}
      ${field('Venue time zone', input('timezone', zone, { disabled, required: true, placeholder: exampleZone(), invalid: Boolean(error), describedby: error ? 'settings-timezone-error' : '' }), { error, errorId: 'settings-timezone-error', help: isDefault ? 'Atlas is using the default zone because none is saved.' : `A zone name such as ${exampleZone()}.` })}
      ${feedback('timezone')}
      ${disabled ? '' : saveBar('timezone', 'Save time zone')}
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
    const empty = !saved.size ? `<div class="atlas-alert atlas-alert--info">${icon('info')}<div class="atlas-alert__content"><p class="atlas-alert__body">No opening hours are saved yet, so Home shows no timeline and nothing counts down. Atlas never guesses hours.</p></div></div>` : '';
    return `<form class="settings-form atlas-card" data-settings-hours-form>
      ${formHead('Weekly hours', 'Home, Operations and Atlas AI read these hours.', editable ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-settings-copy-monday>Copy Monday to all</button>' : readOnlyNote(false))}
      ${empty}
      <div class="atlas-table-wrap settings-hours"><table class="atlas-table atlas-table--compact">
        <colgroup><col class="settings-hours__day"><col class="settings-hours__check"><col><col><col class="settings-hours__check"><col><col></colgroup>
        <thead><tr><th scope="col">Day</th><th scope="col">Open</th><th scope="col">Opens</th><th scope="col">Closes</th><th scope="col" title="Closes after midnight">Next day</th><th scope="col">Last orders</th><th scope="col">Kitchen</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${feedback('hours')}
      ${editable ? saveBar('hours', 'Save hours') : ''}
    </form>`;
  }

  function offerFormMarkup(offer, isNew = false) {
    const editable = canManage();
    const disabled = !editable;
    const id = offer?.id || '';
    const key = `offer:${id || 'new'}`;
    const days = Array.isArray(offer?.days) ? offer.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const pricing = offer?.pricing && Object.keys(offer.pricing).length ? JSON.stringify(offer.pricing) : '';
    return `<form class="settings-form atlas-card" data-settings-offer-form data-offer-id="${escapeHtml(id)}" data-version="${Number(offer?.version || 1)}">
      ${formHead(isNew ? 'New offer' : (offer?.name || 'Offer'), isNew ? 'Offers appear on the Home timeline on their days.' : '', offer?.active === false ? pill('neutral', 'Paused') : pill('positive', 'Active'))}
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
    </form>`;
  }

  function hoursMarkup() {
    const offers = state.workspace?.offers || [];
    return `${sectionHead('Opening hours', 'When the venue is open, and its offers. Nothing here is invented: without saved hours, Atlas says so.')}
      ${timezoneFormMarkup()}
      ${hoursFormMarkup()}
      <div class="settings-subhead"><h3>Offers</h3>${canManage() && !state.offerDraft ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-add-offer>' + icon('plus') + 'Add offer</button>' : ''}</div>
      ${state.offerDraft ? offerFormMarkup(state.offerDraft, true) : ''}
      ${offers.length ? offers.map((offer) => offerFormMarkup(offer)).join('') : (state.offerDraft ? '' : '<p class="settings-muted">No offers yet.</p>')}`;
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
      <p class="settings-muted">What each role may do. A person’s role and deactivation are changed on their profile in <a href="#team">Team</a>.</p>
      ${roles.length ? roles.map((entry) => {
        const key = `role:${entry.role_key}`;
        const editable = Boolean(entry.can_edit);
        return `<form class="settings-form atlas-card" data-settings-role-form="${escapeHtml(entry.role_key)}" data-version="${Number(entry.version || 1)}">
          ${formHead(entry.label || ROLE_LABELS[entry.role_key] || humanize(entry.role_key), entry.description || '', editable ? '' : pill('neutral', 'Protected'))}
          <ul class="settings-permissions">${permissions.map((permission) => `<li><label class="settings-inline-check"><input type="checkbox" class="atlas-check" name="permission_${escapeHtml(permission)}"${entry.permissions?.[permission] ? ' checked' : ''}${editable ? '' : ' disabled'}> ${escapeHtml(humanize(permission))}</label></li>`).join('')}</ul>
          ${feedback(key)}
          ${editable ? saveBar(key, 'Save permissions') : ''}
        </form>`;
      }).join('') : '<div class="atlas-empty atlas-empty--inline"><h3>No roles to show</h3><p>Roles appear once Settings has loaded them.</p></div>'}`;
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
    const blocked = device.status === 'denied' ? '<p class="settings-muted">To unblock: open this site’s settings in your browser (the icon next to the address), allow notifications, then reload Atlas.</p>' : '';
    const policies = isManager() ? (state.workspace?.notification_policies || []) : [];
    return `${sectionHead('Notifications', 'Alerts on this device, and who gets which alert.')}
      <section class="settings-form atlas-card settings-device-notifications is-${escapeHtml(device.status)}" aria-labelledby="settings-device-title">
        <div class="settings-form__head"><div><h3 class="settings-form__title" id="settings-device-title">This device</h3><p class="settings-form__sub">${escapeHtml(device.detail || '')}</p></div>${pill(tone, text)}</div>
        ${blocked}
        <p class="settings-muted">Atlas asks the browser for permission only when you turn notifications on. Turning them off unsubscribes this device.</p>
        ${action ? `<div class="settings-actions">${action}</div>` : ''}
        ${feedback('push')}
      </section>
      <section class="settings-form atlas-card" aria-labelledby="settings-alerts-title">
        <div class="settings-form__head"><div><h3 class="settings-form__title" id="settings-alerts-title">Alerts sent today</h3><p class="settings-form__sub">Only these alerts can reach a device at the moment.</p></div></div>
        <ul class="settings-list"><li>${icon('messages-square')}New messages in Messages</li><li>${icon('calendar-days')}Published shift changes</li></ul>
        ${policies.length ? `<div class="atlas-table-wrap"><table class="atlas-table atlas-table--compact"><caption class="settings-caption">Saved alert rules, used once more alerts are delivered</caption><thead><tr><th scope="col">Alert</th><th scope="col">Goes to</th><th scope="col">Status</th></tr></thead><tbody>${policies.map((policy) => `<tr><td>${escapeHtml(policy.label || humanize(policy.event_key))}</td><td>${escapeHtml((policy.target_roles || []).map((key) => ROLE_LABELS[key] || humanize(key)).join(', ') || 'Nobody yet')}</td><td>${policy.enabled ? pill('positive', 'On') : pill('neutral', 'Off')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </section>`;
  }

  // Rules that change Atlas today say so; the rest are saved for upcoming features.
  const SETTING_USAGE = {
    inventory: { automatic_reorder_suggestions: 'Used for order suggestions in Purchasing and Atlas AI.' },
    brain: { purchase_learning_enabled: 'Used for order suggestions.', menu_learning_enabled: 'Used for recipe availability notes.', waste_learning_enabled: 'Used for waste notes.' }
  };

  function ruleForm(key, title, fields, description = null) {
    const data = section(key);
    if (!data) return '';
    const disabled = !data.can_edit;
    const used = Object.keys(SETTING_USAGE[key] || {}).length;
    return `<form class="settings-form atlas-card" data-settings-section-form="${escapeHtml(key)}" data-version="${Number(data.version || 1)}">
      ${formHead(title, description || (used ? 'Settings marked “in use” change Atlas today; the rest are saved for upcoming features.' : 'Saved for upcoming features — these don’t change Atlas yet.'), readOnlyNote(!disabled))}
      ${fields(data.value || {}, disabled)}
      ${sectionVersion(data)}
      ${feedback(`section:${key}`)}
      ${disabled ? '' : saveBar(`section:${key}`)}
    </form>`;
  }

  function usedHelp(key, name) {
    return SETTING_USAGE[key]?.[name] ? `In use. ${SETTING_USAGE[key][name]}` : '';
  }

  function checkRow(name, checked, label, options = {}) {
    return `<label class="settings-check"><input type="checkbox" class="atlas-check" name="${escapeHtml(name)}"${checked ? ' checked' : ''}${options.disabled ? ' disabled' : ''}><span><span class="settings-check__label">${escapeHtml(label)}</span>${options.help ? `<span class="settings-check__help">${escapeHtml(options.help)}</span>` : ''}</span></label>`;
  }

  function rulesMarkup() {
    const operations = ruleForm('operations', 'Shifts and service', (value, disabled) => `<div class="settings-grid">
      ${field('Week starts on', select('week_starts_on', value.week_starts_on ?? 1, WEEKDAYS.map((day, index) => [index, day]), { disabled }))}
      ${field('Default break (minutes)', input('default_break_minutes', value.default_break_minutes, { type: 'number', min: 0, max: 720, disabled, inputmode: 'numeric' }))}
      ${field('Last orders before closing (minutes)', input('last_order_minutes_before_close', value.last_order_minutes_before_close, { type: 'number', min: 0, max: 240, disabled, inputmode: 'numeric' }))}
    </div>${checkRow('shift_confirmation_required', value.shift_confirmation_required, 'Staff confirm their shifts', { disabled })}`);
    const inventory = ruleForm('inventory', 'Stock', (value, disabled) => `<div class="settings-grid">
      ${field('Critical stock level (share of par)', input('critical_stock_ratio', value.critical_stock_ratio, { type: 'number', min: 0, max: 1, step: 0.05, disabled, inputmode: 'decimal' }))}
      ${field('Count difference allowed (%)', input('variance_tolerance_percent', value.variance_tolerance_percent, { type: 'number', min: 0, max: 100, step: 0.1, disabled, inputmode: 'decimal' }))}
      ${field('Waste allowed (%)', input('waste_tolerance_percent', value.waste_tolerance_percent, { type: 'number', min: 0, max: 100, step: 0.1, disabled, inputmode: 'decimal' }))}
    </div>
    ${checkRow('low_stock_warning_enabled', value.low_stock_warning_enabled, 'Warn when stock is low', { disabled })}
    ${checkRow('automatic_reorder_suggestions', value.automatic_reorder_suggestions, 'Suggest what to order', { disabled, help: usedHelp('inventory', 'automatic_reorder_suggestions') })}
    ${checkRow('barcode_gallery_enabled', value.barcode_gallery_enabled, 'Allow photos from the gallery in the scanner', { disabled })}
    ${checkRow('allow_multiple_barcodes', value.allow_multiple_barcodes, 'Allow several barcodes per item', { disabled })}
    ${checkRow('staff_barcode_linking', value.staff_barcode_linking, 'Staff can link barcodes to items', { disabled })}
    <p class="settings-muted">${icon('lock')}Placing orders and changing stock from the scanner stay manual. Atlas never does either by itself.</p>`);
    const temperature = ruleForm('temperature', 'Temperature log', (value, disabled) => `<div class="settings-grid">
      ${field('Reminder times', input('reminder_times', (value.reminder_times || []).join(', '), { disabled, placeholder: '10:00, 16:00' }), { help: 'Separate times with commas.' })}
      ${field('Escalate after (minutes)', input('escalation_minutes', value.escalation_minutes, { type: 'number', min: 0, max: 1440, disabled, inputmode: 'numeric' }))}
      ${field('Keep readings for (months)', input('retention_months', value.retention_months, { type: 'number', min: 1, max: 120, disabled, inputmode: 'numeric' }))}
    </div>
    ${checkRow('daily_log_required', value.daily_log_required, 'A daily reading is required', { disabled })}
    ${checkRow('photo_required_on_exception', value.photo_required_on_exception, 'Photo when a reading is out of range', { disabled })}
    ${checkRow('corrective_action_required', value.corrective_action_required, 'Say what was done when a reading is out of range', { disabled })}
    ${checkRow('manager_review_on_exception', value.manager_review_on_exception, 'A manager reviews out-of-range readings', { disabled })}`);
    const cleaning = ruleForm('cleaning', 'Cleaning', (value, disabled) => {
      const schedule = value.weekly_schedule || {};
      return `<div class="settings-grid">
        ${field('Sunday routine', input('schedule_sunday', schedule.sunday || '', { disabled }), { optional: true })}
        ${field('Monday routine', input('schedule_monday', schedule.monday || '', { disabled }), { optional: true })}
        ${field('Tuesday routine', input('schedule_tuesday', schedule.tuesday || '', { disabled }), { optional: true })}
        ${field('Escalate overdue after (minutes)', input('overdue_escalation_minutes', value.overdue_escalation_minutes, { type: 'number', min: 0, max: 1440, disabled, inputmode: 'numeric' }))}
      </div>
      ${checkRow('photo_required', value.photo_required, 'Photo required', { disabled })}
      ${checkRow('comment_required_on_exception', value.comment_required_on_exception, 'Comment when something is skipped', { disabled })}
      ${checkRow('manager_review_on_exception', value.manager_review_on_exception, 'A manager reviews skipped items', { disabled })}`;
    });
    const marketing = ruleForm('marketing', 'Marketing approvals', (value, disabled) => `
      ${field('Brand voice', textarea('brand_voice', value.brand_voice, { disabled, rows: 3 }), { help: 'Moves to Marketing settings with the Marketing redesign.' })}
      ${field('Story frames by default', input('default_story_frames', value.default_story_frames, { type: 'number', min: 1, max: 10, disabled, inputmode: 'numeric' }))}
      ${checkRow('approval_required', value.approval_required, 'Posts need approval', { disabled })}
      ${checkRow('ai_caption_drafts_enabled', value.ai_caption_drafts_enabled, 'Atlas drafts captions', { disabled })}
      <p class="settings-muted">${icon('lock')}Publishing and analytics stay off until an account is connected in Integrations.</p>`);
    return `${sectionHead('Operational rules', 'Thresholds, reminders and approvals.')}
      ${operations}${inventory}${purchasingPolicyMarkup()}${temperature}${cleaning}${marketing}`;
  }

  function purchasingPolicyMarkup() {
    const policy = state.purchasingPolicy;
    let body;
    if (policy.status === 'loading' || policy.status === 'idle') body = '<span class="atlas-skel atlas-skel--text"></span>';
    else if (!policy.value) body = '<p class="settings-muted">The ordering rules couldn’t be read. They are managed in Purchasing.</p>';
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
    return `<section class="settings-form atlas-card" aria-labelledby="settings-po-title">
      <div class="settings-form__head"><div><h3 class="settings-form__title" id="settings-po-title">Ordering</h3><p class="settings-form__sub">Read here; changed with Purchasing.</p></div></div>
      ${body}
    </section>`;
  }

  // ---------- Atlas AI ----------

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

  function aiSettingsForm() {
    const ai = state.ai;
    if (ai.status !== 'ready') return '<section class="settings-form atlas-card" aria-busy="true"><span class="atlas-skel atlas-skel--row"></span><span class="atlas-skel atlas-skel--row"></span></section>';
    if (!ai.settings) {
      const text = ai.error?.code === 'not_configured' ? 'Atlas AI isn’t available in this environment yet.' : 'The Atlas AI settings couldn’t be loaded. Nothing was changed.';
      return `<div class="atlas-alert atlas-alert--${ai.error?.code === 'not_configured' ? 'info' : 'danger'}" role="status">${icon('info')}<div class="atlas-alert__content"><p class="atlas-alert__body">${escapeHtml(text)}</p></div>${ai.error?.code === 'not_configured' ? '' : '<div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-ai-retry>Try again</button></div>'}</div>`;
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
    const [first, ...rest] = controls;
    return `<form class="settings-form atlas-card" data-settings-ai-form>
      ${formHead('Atlas AI for the venue', value.enabled && value.configured === false ? 'It is switched on here, but the service connection isn’t set up yet, so answers use saved records only.' : 'Limits apply to each person, per day.', `${status}${readOnlyNote(editable)}`)}
      ${first || ''}
      <div class="settings-grid">${rest.join('')}</div>
      ${value.updated_at ? `<p class="settings-form__meta">Last changed ${escapeHtml(formatDateTime(value.updated_at))}</p>` : ''}
      ${feedback('ai')}
      ${editable ? saveBar('ai') : ''}
    </form>`;
  }

  function aiPreferencesForm() {
    const ai = state.ai;
    if (ai.status !== 'ready' || !ai.preferences) return '';
    const value = ai.preferences;
    const has = (key) => Object.prototype.hasOwnProperty.call(value, key);
    return `<form class="settings-form atlas-card" data-settings-ai-preferences-form>
      ${formHead('Your replies', 'How Atlas AI answers you. Only you see these.')}
      ${has('reply_length') ? field('Reply length', select('reply_length', value.reply_length, [['short', 'Short'], ['normal', 'Normal'], ['detailed', 'Detailed']])) : ''}
      ${has('speak_answers') ? toggle('speak_answers', Boolean(value.speak_answers), 'Read answers aloud in voice conversations') : ''}
      ${has('voice_enabled') ? toggle('voice_enabled', Boolean(value.voice_enabled), 'Offer voice in Atlas AI') : ''}
      ${has('language') ? field('Language', select('language', value.language, [['auto', 'Same as my question'], ['en', 'English'], ['is', 'Íslenska']])) : ''}
      ${feedback('ai-preferences')}
      ${saveBar('ai-preferences')}
    </form>`;
  }

  function decisionsForm() {
    return ruleForm('brain', 'Suggestions and learning', (value, disabled) => `
    ${checkRow('purchase_learning_enabled', value.purchase_learning_enabled, 'Learn from orders', { disabled, help: usedHelp('brain', 'purchase_learning_enabled') })}
    ${checkRow('menu_learning_enabled', value.menu_learning_enabled, 'Learn from recipes', { disabled, help: usedHelp('brain', 'menu_learning_enabled') })}
    ${checkRow('waste_learning_enabled', value.waste_learning_enabled, 'Learn from waste', { disabled, help: usedHelp('brain', 'waste_learning_enabled') })}
    <p class="settings-muted">${icon('lock')}Atlas never acts on a suggestion by itself; a person approves every change.</p>`, 'What Atlas AI learns from when it suggests things. Each setting changes Atlas today.');
  }

  function aiMarkup() {
    return `${sectionHead('Atlas AI', 'Whether Atlas AI is on, its daily limits, and how it suggests things.')}
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
      case 'browser_mismatch': return 'Connecting was started in another browser, or this browser blocked Atlas’s sign-in cookie. Nothing was connected. Start again from this browser.';
      case 'not_authorized': return 'Only an active manager or administrator can finish connecting. Nothing was connected.';
      case 'provider_check_failed': return `${name} didn’t accept the connection. Reconnect, or check the account on ${name}.`;
      case 'provider_refresh_failed': return `${name} didn’t renew access. Reconnect to continue.`;
      case 'credential_unreadable': return `Atlas can’t read the saved ${name} connection any more. Disconnect, then connect again.`;
      case 'not_configured': return 'Not available yet — this connection isn’t set up on the server.';
      case 'not_connected': return `${name} isn’t connected.`;
      case 'forbidden': return 'Only managers and administrators can change integrations.';
      case 'denied': return `You cancelled on ${name}. Nothing was connected.`;
      case 'invalid_request': return 'That wasn’t accepted. Check what you entered and try again.';
      case 'network': case 'timeout': return 'Atlas couldn’t be reached. Nothing was changed — try again.';
      case 'verify_failed': return `${name} was connected but didn’t pass Atlas’s check. Reconnect, or check the account on ${name}.`;
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
      if (action === 'start') {
        const payload = await integrationsApi('start', { method: 'POST', body: { provider_key: key, return_path: '#settings/integrations' } });
        if (payload?.authorize_url) {
          // The Atlas hop on the functions domain binds this browser; never rebuilt here.
          window.location.assign(payload.authorize_url);
          return;
        }
        integrations.messages[key] = { tone: 'danger', text: integrationMessage('unknown', providerLabel(key)) };
      } else {
        const payload = await integrationsApi(action, { method: 'POST', body: { provider_key: key, ...body } });
        replaceProvider(payload?.provider);
        if (action === 'disconnect') integrations.messages[key] = { tone: 'positive', text: `${providerLabel(key)} is disconnected.` };
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

  function providerMarkup(provider) {
    const key = provider.provider_key;
    const [tone, text] = INTEGRATION_STATES[provider.connection_state] || ['neutral', 'Not connected'];
    const busy = state.integrations.busy[key];
    const message = state.integrations.messages[key];
    const facts = [];
    if (provider.account_label) facts.push(`Account: ${provider.account_label}`);
    if (provider.connected_by_label && provider.connected_at) facts.push(`Connected by ${provider.connected_by_label} · ${formatDateTime(provider.connected_at)}`);
    if (provider.last_verified_at) facts.push(`Last checked ${formatDateTime(provider.last_verified_at)}`);
    const status = {
      not_configured: '',
      ready: provider.auth_kind === 'api_key' ? 'Add the API key to connect.' : 'Ready to connect.',
      verifying: 'Atlas is checking the connection.',
      verification_failed: `The last check failed. Test again, or reconnect.`,
      needs_reauthorization: 'Access expired. Reconnect to continue.',
      pending_review: 'The platform is reviewing Atlas’s access. Nothing to do until it finishes.',
      connected: ''
    }[provider.connection_state] || '';
    const button = (action, label, variant = 'secondary') => `<button type="button" class="atlas-btn atlas-btn--${variant} atlas-btn--sm${busy === action ? ' is-loading' : ''}" data-integration-action="${action}" data-provider="${escapeHtml(key)}"${busy ? ' disabled' : ''}${busy === action ? ' aria-busy="true"' : ''}>${escapeHtml(label)}</button>`;
    const actions = [];
    if (provider.can_connect) actions.push(button('start', ['connected', 'verification_failed', 'needs_reauthorization'].includes(provider.connection_state) ? 'Reconnect' : 'Connect', provider.connection_state === 'ready' ? 'primary' : 'secondary'));
    if (provider.can_test) actions.push(button('test', 'Test connection'));
    if (provider.can_disconnect && provider.connection_state !== 'not_configured') actions.push(button('disconnect', 'Disconnect', 'ghost'));
    const keyForm = provider.can_save_api_key ? `<form class="settings-apikey" data-integration-key-form data-provider="${escapeHtml(key)}">
        ${field('API key', `<input class="atlas-input" type="password" name="api_key" autocomplete="off" spellcheck="false" minlength="8" maxlength="256" required${busy ? ' disabled' : ''}>`, { help: 'Saved encrypted on the server and never shown again.' })}
        <button type="submit" class="atlas-btn atlas-btn--secondary atlas-btn--sm${busy === 'save-api-key' ? ' is-loading' : ''}"${busy ? ' disabled' : ''}>Save key</button>
      </form>` : '';
    const needs = provider.connection_state === 'not_configured'
      ? `<details class="settings-needs"><summary>What it needs</summary><p>${escapeHtml(provider.available_message || 'Not available yet.')}</p>${provider.owner_requirements_summary ? `<p>${escapeHtml(provider.owner_requirements_summary)}</p>` : ''}<p>An administrator sets this up with whoever runs the Atlas server.</p></details>`
      : '';
    const linked = state.focusProvider === key;
    return `<li class="settings-provider${linked ? ' is-linked-target' : ''}" data-provider-card="${escapeHtml(key)}"${linked ? ' aria-current="true"' : ''}>
      <div class="settings-provider__head"><div><h3 class="settings-provider__name">${escapeHtml(provider.label || humanize(key))}</h3>${status ? `<p class="settings-provider__status">${escapeHtml(status)}</p>` : ''}</div>${pill(tone, text)}</div>
      ${facts.length ? `<p class="settings-provider__facts">${escapeHtml(facts.join(' · '))}</p>` : ''}
      ${needs}
      ${keyForm}
      ${actions.length ? `<div class="settings-actions">${actions.join('')}</div>` : ''}
      ${message ? `<p class="settings-form-feedback is-${message.tone === 'danger' ? 'error' : 'success'}" role="${message.tone === 'danger' ? 'alert' : 'status'}">${icon(message.tone === 'danger' ? 'circle-alert' : 'circle-check')}${escapeHtml(message.text)}</p>` : ''}
    </li>`;
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
    if (integrations.status === 'idle' || integrations.status === 'loading') body = `<div aria-busy="true">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(4)}<span class="sr-only">Loading integrations</span></div>`;
    else if (integrations.status === 'error') {
      body = integrations.error?.code === 'not_configured'
        ? `<div class="atlas-empty atlas-empty--inline"><div class="atlas-empty__icon">${icon('plug')}</div><h3>Not available yet</h3><p>Integrations need the connection service on the Atlas server. An administrator sets it up.</p></div>`
        : `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Integrations couldn’t be loaded.</p><p class="atlas-alert__body">${escapeHtml(integrations.error?.status === 403 ? 'Only managers and administrators can see integrations.' : 'Nothing was changed. Try again.')}</p></div>${integrations.error?.status === 403 ? '' : '<div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-integrations-retry>Try again</button></div>'}</div>`;
    } else if (!integrations.providers.length) body = '<p class="settings-muted">No integrations are available.</p>';
    else body = `<ul class="settings-providers">${integrations.providers.map(providerMarkup).join('')}</ul>`;
    return `${sectionHead('Integrations', 'Outside accounts Atlas can use. Connecting happens on the provider’s own page; Atlas never sees passwords.')}
      ${integrationNoticeMarkup()}
      ${body}
      <p class="settings-muted">${icon('lock')}Connected accounts never publish anything by themselves. Planning in Marketing works without them.</p>`;
  }

  // One-time notice after the provider redirect: /?integration=…&result=…&reason=…#settings/…
  function readIntegrationCallback() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const provider = params.get('integration');
    const result = params.get('result');
    if (!provider || !result) return;
    state.integrations.notice = { provider, result, reason: params.get('reason') };
    ['integration', 'result', 'reason'].forEach((key) => params.delete(key));
    const query = params.toString();
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`); } catch { /* address bar only */ }
    state.section = 'integrations';
    if (!/^#settings/.test(window.location.hash)) window.AtlasShell?.navigate?.('#settings/integrations');
  }

  // ---------- security, system, preferences, activity ----------

  function securityMarkup() {
    const enforced = [
      ['Staff sign-in', 'Every account signs in with its own email and password; passwords are never stored in Atlas.'],
      ['Active profile required', 'Deactivated profiles are signed out, and every request checks the profile again.'],
      ['Role-based access', 'Costs, purchasing and item changes are limited to managers and administrators.'],
      ['Keys stay on the server', 'Service keys and connection secrets never reach the browser.']
    ];
    const unavailable = [
      ['Two-factor authentication', 'Not enforced yet — needs the sign-in provider’s two-factor setup.'],
      ['Automatic sign-out after inactivity', 'Not enforced yet — sessions follow the sign-in provider’s refresh rules.'],
      ['Trusted devices', 'Not available yet.'],
      ['Emergency lockdown', 'Not available yet — deactivate a profile in Team to remove access.']
    ];
    return `${sectionHead('Security', 'What Atlas enforces today, and what isn’t available yet.')}
      <section class="settings-security">
        <section class="settings-form atlas-card" aria-labelledby="settings-security-on"><div class="settings-form__head"><div><h3 class="settings-form__title" id="settings-security-on">Enforced now</h3></div>${pill('positive', 'On')}</div>
          <ul class="settings-capabilities">${enforced.map(([title, detail]) => `<li>${icon('shield-check')}<span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></span></li>`).join('')}</ul></section>
        <section class="settings-form atlas-card" aria-labelledby="settings-security-off"><div class="settings-form__head"><div><h3 class="settings-form__title" id="settings-security-off">Not available yet</h3></div>${pill('neutral', 'Off')}</div>
          <ul class="settings-capabilities">${unavailable.map(([title, detail]) => `<li>${icon('circle-dashed')}<span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></span></li>`).join('')}</ul></section>
      </section>`;
  }

  function systemMarkup() {
    return `${sectionHead('System health', 'Read-only checks of the Atlas service. Anything not checked says so.')}<div class="settings-system" data-settings-system-host></div>`;
  }

  function preferencesMarkup() {
    const preference = state.workspace?.preferences || {};
    const device = window.AtlasNotifications?.snapshot?.() || { status: 'unsupported' };
    const stored = preference.start_view;
    const startView = START_VIEWS.some(([key]) => key === stored) ? stored : 'dashboard';
    const allowed = START_VIEWS.filter(([key]) => key === startView || window.AtlasShell?.nav?.allowed?.(START_VIEW_TARGETS[key] || key) !== false);
    return `${sectionHead('Preferences', 'How Atlas opens and behaves for you. Saved to your profile.')}
      <form class="settings-form atlas-card" data-settings-preferences-form>
        ${field('Start page', select('start_view', startView, allowed), { help: 'The page Atlas opens after you sign in.' })}
        ${checkRow('reduce_motion', preference.reduce_motion, 'Reduce motion', { help: 'Turns off animations across Atlas.' })}
        <dl class="settings-facts">
          <div><dt>Notifications on this device</dt><dd>${escapeHtml(device.status === 'enabled' ? 'On' : 'Off')} · <a href="#settings/notifications">Manage</a></dd></div>
          <div><dt>Theme</dt><dd>Light (the only theme for now)</dd></div>
          <div><dt>Language</dt><dd>English</dd></div>
          <div><dt>Time zone</dt><dd>The venue’s time, ${escapeHtml(clock()?.timeZone?.() || '')}</dd></div>
        </dl>
        ${feedback('preferences')}
        ${saveBar('preferences', 'Save preferences')}
      </form>`;
  }

  function activityMarkup() {
    const events = state.workspace?.events || [];
    return `${sectionHead('Activity', 'Changes to settings, newest first. This history can’t be edited.')}
      ${events.length ? `<ul class="atlas-list atlas-card">${events.map((event) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(humanize(event.section_key || 'settings'))} · ${escapeHtml(humanize(String(event.event_type || '').replace(/^settings_/, '')))}</p><p class="atlas-row__meta">${escapeHtml(`${event.actor_label || 'Atlas'} · ${formatDateTime(event.created_at)}`)}</p></div></li>`).join('')}</ul>`
        : '<div class="atlas-empty atlas-empty--inline"><div class="atlas-empty__icon">' + icon('history') + '</div><h3>No changes yet</h3><p>Every saved setting appears here with who changed it.</p></div>'}`;
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

  function navMarkup(sections, current) {
    let lastGroup = null;
    return `<nav class="settings-nav" aria-label="Settings sections"><ul>${sections.map((entry) => {
      const group = entry.group && entry.group !== lastGroup ? `<li class="settings-nav__group">${escapeHtml(entry.group)}</li>` : '';
      lastGroup = entry.group || lastGroup;
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
    const subtitle = showNav ? 'Venue, access, integrations and your preferences' : 'Your preferences and notifications';
    const head = window.AtlasShell?.pageHead?.({ title: 'Settings', sub: subtitle }) || '<header class="page-head"><h1 class="page-head__title">Settings</h1></header>';
    let content;
    if (state.status === 'idle' || (state.status === 'loading' && !state.workspace)) content = `<div aria-busy="true">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(5)}<span class="sr-only">Loading settings</span></div>`;
    else if (state.status === 'error' && !state.workspace) {
      content = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Settings couldn’t be loaded.</p><p class="atlas-alert__body">${escapeHtml(state.error?.status === 403 ? 'Your profile can’t open Settings. Ask an administrator.' : state.error?.status === 401 ? 'Atlas couldn’t confirm your sign-in for this. Nothing has changed. Try again in a moment.' : 'Nothing was changed. Check the connection and try again.')}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-settings-refresh>Try again</button></div></div>`;
    } else content = sectionMarkup(current || defaultSection());
    const listOnly = showNav && phone() && !current;
    const drafts = captureDrafts(element);
    element.innerHTML = `<div class="settings${showNav ? '' : ' settings--single'}${listOnly ? ' is-list' : ''}${current ? ' has-section' : ''}">
      ${head}
      <div class="settings-layout">
        ${showNav ? navMarkup(sections, current || (phone() ? null : defaultSection())) : ''}
        <div class="settings-content" data-settings-content>${listOnly ? '' : content}</div>
      </div>
    </div>`;
    restoreDrafts(element, drafts);
    if ((current || defaultSection()) === 'system' && !listOnly) window.AtlasSystem?.mount?.(element.querySelector('[data-settings-system-host]'));
    window.lucide?.createIcons?.();
    // #settings/integrations?provider=<key> (Atlas AI record links): show that provider once it has loaded.
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
            state.fieldErrors.timezone = `“${zone}” isn’t a time zone Atlas recognises. Use a name such as ${exampleZone()}.`;
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
      await mutate(key, 'ai-settings', null, 'Atlas AI settings saved.', {
        request: () => aiApi('settings', { method: 'POST', body: { patch } }),
        apply: (payload) => { state.ai.settings = { ...(state.ai.settings || {}), ...(payload?.settings || payload || {}) }; },
        errorText: (error) => (error?.status === 403 ? 'Only managers and administrators can change Atlas AI settings.' : error?.status === 400 ? 'A value is outside what Atlas allows. Check the limits and try again.' : friendlySaveError(error))
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
      else integrationAction(provider, action);
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
      <div class="atlas-dialog__body"><p>Atlas deletes its saved access and stops using ${escapeHtml(name)}. You can connect again later.</p></div>
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
