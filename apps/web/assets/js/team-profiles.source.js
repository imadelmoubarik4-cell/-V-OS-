// Team — #team, #team/<profileId> (docs/design/Atlas_Experience_Redesign.md §7.10).
//
// Directory of people (Alcedo accounts and schedule-only roster people), a
// profile sheet (full screen on phones) and manager tools: add or invite
// people, access (role, active), onboarding tasks and setup links. Emergency
// contacts are shown only to the person and managers, and to managers only
// after "Show". Photos come from AtlasTeamProfilePhotos.photoFor(profile id).
//
// Shipped as a gzip bundle: team-profiles.bundle.js.gz is `gzip -9n` of this
// file (tests/node/team-profiles-ui.test.js checks they match), installed by
// team-profiles-bootstrap.js.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 15000;
  const MANAGER_ROLES = ['admin', 'manager'];
  const ROLE_LABELS = { admin: 'Administrator', manager: 'Manager', bartender: 'Bartender', viewer: 'Viewer', schedule_only: 'Schedule only' };
  const DEPARTMENT_LABELS = { management: 'Management', bar: 'Bar', kitchen: 'Kitchen', service: 'Service', operations: 'Operations', marketing: 'Marketing', other: 'Other' };
  const EMPLOYMENT_LABELS = { owner: 'Owner', full_time: 'Full-time', part_time: 'Part-time', temporary: 'Temporary', contractor: 'Contractor', other: 'Other' };
  const EVENT_LABELS = {
    profile_details_updated: 'Profile updated', emergency_contact_saved: 'Emergency contact saved', emergency_contact_removed: 'Emergency contact removed',
    role_changed: 'Role changed', active_status_changed: 'Access changed', training_management: 'Training updated', auth_invitation: 'Invitation sent'
  };
  const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener() {} };

  const state = {
    workspace: null,
    staff: null,
    roster: [],
    rosterShifts: [],
    loading: false,
    error: null,
    failedAt: 0,
    submitting: false,
    filter: 'active',
    roleFilter: 'all',
    trainingDue: false,
    contactMissing: false,
    search: '',
    profileId: null,
    revealed: new Set(),
    visible: false,
    initialized: false
  };

  // ---------- helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function icon(name) {
    return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
  }

  function paintIcons() {
    window.lucide?.createIcons?.();
  }

  function humanize(value) {
    return String(value || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  function initials(value) {
    const words = String(value || 'Alcedo').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || 'A';
  }

  function vc() {
    return window.AtlasVenueClock;
  }

  function today() {
    return vc()?.today?.() || new Date().toISOString().slice(0, 10);
  }

  function formatDate(value, fallback = 'Not set') {
    if (!value) return fallback;
    return vc()?.formatDate?.(String(value).length === 10 ? value : value, { year: true }) || fallback;
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || humanize(role);
  }

  function role() {
    return state.staff?.role || window.AtlasShell?.profile?.()?.role || window.atlasCurrentProfile?.role || null;
  }

  function isManager() {
    return Boolean(state.staff?.can_manage_team) || MANAGER_ROLES.includes(role());
  }

  // A person keeps one hue across Team and Shifts: the index Shifts gives the
  // roster person (roster ids sorted, twelve --person-color hues), else a hash
  // of the profile id. The avatar is a pale tint of that hue with its own ink.
  const PERSON_HUES = 12;
  function personHue(profile) {
    const person = profile ? rosterPersonFor(profile) : null;
    const index = person ? state.roster.map((entry) => entry.id).filter(Boolean).sort().indexOf(person.id) : -1;
    if (index >= 0) return `atlas-person--${index % PERSON_HUES}`;
    let hash = 0;
    for (const character of String(profile?.id || 'x')) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
    return `atlas-person--${hash % PERSON_HUES}`;
  }

  function avatar(profile, size = '') {
    const photo = profile && !profile.schedule_only ? window.AtlasTeamProfilePhotos?.photoFor?.(profile.id) : null;
    return `<span class="atlas-avatar ${size} team-avatar ${personHue(profile)} team-profile-avatar${photo?.signed_url ? ' has-profile-photo' : ''}" aria-hidden="true">${photo?.signed_url ? `<img src="${escapeHtml(photo.signed_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : escapeHtml(initials(profile?.name))}</span>`;
  }

  function pill(label, tone = 'neutral') {
    return `<span class="atlas-pill atlas-pill--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
  }

  // A quiet status word with a 6 px dot (warning ink), for a second fact in a
  // row that already carries a pill: one loud mark per row.
  function flag(label) {
    return `<span class="team-flag">${escapeHtml(label)}</span>`;
  }

  // Progress at the true ratio. Up to 12 steps draw one segment each (the
  // steps are countable); more draw one bar whose fill is set from data-ratio
  // after paint (a transform, so no style markup).
  function meter(done, total, extra = '') {
    const count = Math.max(0, Number(total) || 0);
    const filled = Math.max(0, Math.min(count, Number(done) || 0));
    if (count && count <= 12) {
      return `<span class="team-meter${extra ? ` ${extra}` : ''}" aria-hidden="true">${Array(count).fill('').map((_, index) => `<i${index < filled ? ' class="is-on"' : ''}></i>`).join('')}</span>`;
    }
    return `<span class="team-meter team-meter--bar${extra ? ` ${extra}` : ''}" aria-hidden="true"><i data-team-ratio="${count ? filled / count : 0}"></i></span>`;
  }

  // Applies data-team-ratio (bar fills) and data-team-span (a shift on the
  // evening axis) after paint, through the CSSOM.
  function applyGeometry(root) {
    if (!root) return;
    root.querySelectorAll('[data-team-ratio]').forEach((fill) => {
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, Number(fill.dataset.teamRatio) || 0))})`;
    });
    // The axis ends are named over the shift column's bar lane (header text
    // stays "On shift today"): custom properties read by ::before/::after.
    root.querySelectorAll('[data-team-axis]').forEach((wrap) => {
      const [from, to] = String(wrap.dataset.teamAxis).split(',');
      wrap.style.setProperty('--team-axis-from', JSON.stringify(from || ''));
      wrap.style.setProperty('--team-axis-to', JSON.stringify(to || ''));
    });
    root.querySelectorAll('[data-team-span]').forEach((span) => {
      const [from, to] = String(span.dataset.teamSpan).split(',').map(Number);
      span.style.setProperty('--team-from', String(Math.max(0, Math.min(1, from || 0))));
      span.style.setProperty('--team-to', String(Math.max(0, Math.min(1, to || 0))));
    });
  }

  // ---------- API ----------

  class TeamError extends Error {
    constructor(message, status) { super(message); this.status = status; this.atlasFixed = true; }
  }
  // Only this module's own fixed copy (atlasFixed) is shown; a JavaScript error
  // or server text reads as the fallback (AtlasApi.message).
  function shown(error, fallback) {
    if (window.AtlasApi?.message) return window.AtlasApi.message(error, fallback);
    return error?.atlasFixed ? error.message : fallback;
  }

  function friendlyError(status, message) {
    const text = String(message || '').trim();
    if (status === 401) return 'Your session has ended. Sign in again to see the team.';
    if (status === 403) return text && !/rpc|jwt|token|schema|postgres/i.test(text) ? text : 'Your role can’t do that in Team.';
    if (status >= 400 && status < 500 && text && text.length < 200 && !/rpc|jwt|token|schema|postgres|function|violates|constraint/i.test(text)) return text;
    return 'Team is temporarily unavailable.';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  function rosterWeek() {
    return vc()?.startOfWeek?.(today()) || today();
  }

  async function api(action, options = {}) {
    const endpoint = options.roster ? String(cfg.SHIFTS_API || '').trim() : String(cfg.TEAM_PROFILES_API || '').trim();
    if (!endpoint) throw new TeamError('Team is not set up for this Alcedo yet.', 0);
    const session = await activeSession();
    if (!session?.access_token) throw new TeamError('Sign in again to see the team.', 401);
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    if (options.roster && (!options.method || options.method === 'GET')) url.searchParams.set('week_start', rosterWeek());
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new TeamError(friendlyError(response.status, payload.error), response.status);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new TeamError('Team took too long to answer. Check the connection and try again.', 0);
      if (error instanceof TeamError) throw error;
      throw new TeamError('Team couldn’t be reached. Check the connection and try again.', 0);
    } finally {
      window.clearTimeout(timer);
    }
  }

  // ---------- data ----------

  function profiles() {
    const accounts = Array.isArray(state.workspace?.profiles) ? state.workspace.profiles : [];
    const roster = state.roster.filter((person) => !person.profile_id).map((person) => ({
      id: person.id, name: person.display_name, email: isManager() ? person.email : null, active: person.active,
      role: 'schedule_only', job_title: person.default_role, schedule_only: true,
      training: { private: true }, emergency_contact_count: 0
    }));
    return [...accounts, ...roster];
  }

  function profileById(id) {
    return profiles().find((profile) => profile.id === id) || null;
  }

  function training(profile) {
    return profile?.training && !profile.training.private
      ? profile.training
      : { private: true, total_required: 0, completed_required: 0, percent: null, tasks: [] };
  }

  function trainingDue(profile) {
    const t = training(profile);
    return !t.private && Number(t.total_required || 0) > 0 && !t.complete && Number(t.completed_required || 0) < Number(t.total_required || 0);
  }

  function rosterPersonFor(profile) {
    if (profile.schedule_only) return state.roster.find((person) => person.id === profile.id) || null;
    return state.roster.find((person) => person.profile_id === profile.id) || null;
  }

  function shiftsFor(profile) {
    const person = rosterPersonFor(profile);
    if (!person) return [];
    return state.rosterShifts.filter((shift) => shift.person_id === person.id)
      .sort((a, b) => String(a.starts_local).localeCompare(String(b.starts_local)));
  }

  function businessDateOf(shift) {
    return (shift.starts_at && vc()?.businessDate?.(shift.starts_at)) || String(shift.starts_local || '').slice(0, 10);
  }

  function todayShift(profile) {
    const key = today();
    return shiftsFor(profile).find((shift) => businessDateOf(shift) === key) || null;
  }

  function shiftTime(shift) {
    return `${String(shift.starts_local).slice(11, 16)}–${String(shift.ends_local).slice(11, 16)}`;
  }

  // Minutes from the start of the shift's business day; an end at or before
  // the start runs past midnight.
  function shiftMinutes(shift) {
    const clock = (value) => {
      const [hours, minutes] = String(value || '').slice(11, 16).split(':').map(Number);
      return (hours || 0) * 60 + (minutes || 0);
    };
    const start = clock(shift.starts_local);
    let end = clock(shift.ends_local);
    if (end <= start) end += 24 * 60;
    return [start, end];
  }

  // Tonight's axis: from the earliest start to the latest end among today's
  // shifts in the list, on whole hours, so every row's bar is comparable.
  function shiftAxis(rows) {
    const spans = rows.map(todayShift).filter(Boolean).map(shiftMinutes);
    if (!spans.length) return null;
    const from = Math.floor(Math.min(...spans.map((span) => span[0])) / 60) * 60;
    const to = Math.ceil(Math.max(...spans.map((span) => span[1])) / 60) * 60;
    return to > from ? { from, to } : null;
  }

  function clockLabel(minutes) {
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function filteredProfiles() {
    const query = state.search.trim().toLowerCase();
    return profiles().filter((profile) => {
      if (state.filter === 'active' && !profile.active) return false;
      if (state.filter === 'inactive' && profile.active) return false;
      if (state.roleFilter !== 'all' && profile.role !== state.roleFilter) return false;
      if (state.trainingDue && !trainingDue(profile)) return false;
      if (state.contactMissing && (profile.schedule_only || Number(profile.emergency_contact_count || 0) > 0)) return false;
      if (!query) return true;
      return [profile.name, profile.job_title, roleLabel(profile.role), isManager() ? profile.email : ''].some((text) => String(text || '').toLowerCase().includes(query));
    });
  }

  // ---------- page ----------

  function host() {
    return document.getElementById('team-profiles-view');
  }

  function ensureHost() {
    let view = host();
    if (!view) {
      view = document.createElement('div');
      view.id = 'team-profiles-view';
      view.style.display = 'none';
      const teamView = document.getElementById('team-view');
      if (teamView) teamView.insertAdjacentElement('afterend', view);
      else document.querySelector('.atlas-content main')?.appendChild(view);
    }
    view.classList.add('team-host');
    return view;
  }

  function headerMarkup() {
    const all = profiles().filter((profile) => profile.active);
    const due = isManager() ? all.filter(trainingDue).length : 0;
    const sub = state.workspace ? [`${all.length} ${all.length === 1 ? 'person' : 'people'}`, due ? `${due} with training due` : null].filter(Boolean).join(' · ') : state.error ? 'The team couldn’t be loaded' : 'Loading the team…';
    const actions = [];
    if (state.staff?.can_manage_team && state.staff?.account_invitations_enabled) actions.push(`<button type="button" class="atlas-btn atlas-btn--secondary" data-team-profile-invite>${icon('mail')}Invite by email</button>`);
    if (state.staff?.can_manage_team) actions.push(`<button type="button" class="atlas-btn atlas-btn--primary" data-team-profile-add-member>${icon('user-plus')}Add team member</button>`);
    return `<header class="page-head"><div class="page-head__text"><h1 class="page-head__title">Team</h1><p class="page-head__sub">${escapeHtml(sub)}</p></div>${actions.length ? `<div class="page-head__actions">${actions.join('')}</div>` : ''}</header>`;
  }

  function toolbarMarkup() {
    const manager = isManager();
    const roles = [...new Set(profiles().map((profile) => profile.role))];
    return `<div class="atlas-toolbar team-toolbar">
      <label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" placeholder="Search people" aria-label="Search people" value="${escapeHtml(state.search)}" data-team-search autocomplete="off"></label>
      <div class="team-filters">
      ${manager ? `<div class="atlas-segmented" role="group" aria-label="Status">${['active', 'all', 'inactive'].map((key) => `<button type="button" data-team-profiles-filter="${key}" aria-pressed="${state.filter === key}">${humanize(key)}</button>`).join('')}</div>` : ''}
      ${roles.length > 1 ? `<label class="sr-only" for="team-role-filter">Role</label><select class="atlas-select team-toolbar__role" id="team-role-filter" data-team-role-filter><option value="all">All roles</option>${roles.map((key) => `<option value="${escapeHtml(key)}" ${state.roleFilter === key ? 'selected' : ''}>${escapeHtml(roleLabel(key))}</option>`).join('')}</select>` : ''}
      ${manager ? `<button type="button" class="atlas-chip" aria-pressed="${state.trainingDue}" data-team-chip="training">Training due</button><button type="button" class="atlas-chip" aria-pressed="${state.contactMissing}" data-team-chip="contact">Contact missing</button>` : ''}
      </div>
      <div class="atlas-toolbar__end" data-team-count>${state.workspace ? `${filteredProfiles().length} shown` : ''}</div>
    </div>`;
  }

  // The steps done in ink, the total in grey ("2 of 3"), a segment per step.
  function trainingCell(profile) {
    const t = training(profile);
    if (t.private) return '<span class="team-muted">—</span>';
    const total = Number(t.total_required || 0);
    if (!total) return '<span class="team-muted">No tasks</span>';
    const done = Number(t.completed_required || 0);
    return `<span class="team-progress">${meter(done, total)}<span class="num">${done}<span class="team-muted"> of ${total}</span></span>${trainingDue(profile) ? ` ${flag('Due')}` : ''}</span>`;
  }

  function contactCell(profile) {
    if (profile.schedule_only) return '<span class="team-muted" title="No Alcedo account">—</span>';
    return Number(profile.emergency_contact_count || 0) > 0
      ? `<span class="team-ok">${icon('check')}<span>Saved</span></span>`
      : flag('Missing');
  }

  // Today's shift as its time and as a bar on tonight's shared axis, so the
  // column reads as the evening's line-up (who opens, who closes).
  function shiftCell(profile, axis) {
    const shift = todayShift(profile);
    if (!shift) return '<span class="team-muted">—</span>';
    const span = axis ? shiftMinutes(shift) : null;
    const range = axis ? axis.to - axis.from : 0;
    const bar = span && range ? `<span class="team-shift__track" aria-hidden="true"><i data-team-span="${((span[0] - axis.from) / range).toFixed(4)},${((span[1] - axis.from) / range).toFixed(4)}"></i></span>` : '';
    return `<span class="team-shift"><span class="num">${escapeHtml(shiftTime(shift))}</span>${bar}</span>`;
  }

  function tableMarkup(rows) {
    const manager = isManager();
    const axis = shiftAxis(rows);
    return `<div class="atlas-table-wrap team-table-wrap"${axis ? ` data-team-axis="${clockLabel(axis.from)},${clockLabel(axis.to)}"` : ''}>
      <table class="atlas-table team-table">
        <thead><tr>
          <th scope="col">Person</th>
          <th scope="col">Role</th>
          <th scope="col">On shift today</th>
          ${manager ? '<th scope="col" data-priority="2">Training</th><th scope="col" data-priority="3">Emergency contact</th>' : ''}
          <th class="col-actions" scope="col"><span class="sr-only">Open</span></th>
        </tr></thead>
        <tbody>${rows.map((profile) => `<tr class="team-table__row${profile.active ? '' : ' is-inactive'}" data-team-profile-select="${escapeHtml(profile.id)}">
          <td><a class="team-person" href="#team/${encodeURIComponent(profile.id)}" data-team-profile-open="${escapeHtml(profile.id)}">${avatar(profile)}<span class="team-person__text"><span class="cell-primary" data-team-profile-name>${escapeHtml(profile.name)}</span><span class="cell-sub">${escapeHtml([profile.job_title, manager ? profile.email : null].filter(Boolean).join(' · ') || roleLabel(profile.role))}</span></span></a></td>
          <td><span class="team-role">${escapeHtml(roleLabel(profile.role))}</span>${profile.active ? '' : ` ${pill('Inactive')}`}</td>
          <td>${shiftCell(profile, axis)}</td>
          ${manager ? `<td data-priority="2">${trainingCell(profile)}</td><td data-priority="3">${contactCell(profile)}</td>` : ''}
          <td class="col-actions"><span class="team-chevron">${icon('chevron-right')}</span></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>${lineupMarkup(rows, axis)}`;
  }

  // Under the table: today's line-up in one sentence, from the same shifts the
  // bars draw ("3 of 4 on shift today, first in 16:00, last out 01:30").
  function lineupMarkup(rows, axis) {
    const spans = rows.map(todayShift).filter(Boolean).map(shiftMinutes);
    if (!axis || !spans.length) return '';
    const first = Math.min(...spans.map((span) => span[0]));
    const last = Math.max(...spans.map((span) => span[1]));
    return `<p class="atlas-table-foot team-lineup"><span>${spans.length} of ${rows.length} on shift today</span><span class="team-lineup__times">First in <span class="num">${clockLabel(first)}</span> · last out <span class="num">${clockLabel(last)}</span></span></p>`;
  }

  function phoneListMarkup(rows) {
    return `<ul class="atlas-table-list team-list">${rows.map((profile) => {
      const shift = todayShift(profile);
      const meta = [roleLabel(profile.role), shift ? `today ${shiftTime(shift)}` : null, profile.active ? null : 'Inactive'].filter(Boolean).join(' · ');
      const due = isManager() && trainingDue(profile);
      return `<li><a class="atlas-table-list__row team-list__row" href="#team/${encodeURIComponent(profile.id)}" data-team-profile-open="${escapeHtml(profile.id)}" data-team-profile-select="${escapeHtml(profile.id)}">${avatar(profile, 'atlas-avatar--lg')}<div class="atlas-table-list__body"><div class="atlas-table-list__title" data-team-profile-name>${escapeHtml(profile.name)}</div><div class="atlas-table-list__meta">${escapeHtml(meta)}</div></div>${due ? flag('Training due') : ''}<span class="team-chevron">${icon('chevron-right')}</span></a></li>`;
    }).join('')}</ul>`;
  }

  // Loading: the directory's own rows at their real size (avatar, name and
  // detail lines), so nothing moves when the people arrive.
  function skeletonRows(count) {
    return Array(count).fill('<div class="team-skel__row"><span class="atlas-skel atlas-skel--circle team-skel__avatar"></span><span class="team-skel__text"><span class="atlas-skel team-skel__name"></span><span class="atlas-skel team-skel__sub"></span></span><span class="atlas-skel team-skel__cell"></span></div>').join('');
  }

  function directoryMarkup() {
    if (!state.workspace) {
      if (state.error) return '';
      return `<div class="team-skel" aria-busy="true">${skeletonRows(5)}<span class="sr-only">Loading the team</span></div>`;
    }
    const rows = filteredProfiles();
    if (!profiles().length) {
      return `<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon">${icon('users')}</div><h3 class="atlas-empty__title">No team members yet</h3><p class="atlas-empty__text">${state.staff?.can_manage_team ? 'Add the people who work here so you can plan shifts and share updates.' : 'Your manager adds the team here.'}</p>${state.staff?.can_manage_team ? `<div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-team-profile-add-member>${icon('user-plus')}Add team member</button></div>` : ''}</div>`;
    }
    if (!rows.length) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('search')}</div><h3 class="atlas-empty__title">${state.search.trim() ? `No one matches “${escapeHtml(state.search.trim())}”` : 'No one matches these filters'}</h3><p class="atlas-empty__text">Try another search or clear the filters.</p><div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-team-clear>Clear filters</button></div></div>`;
    }
    return phoneQuery.matches ? phoneListMarkup(rows) : tableMarkup(rows);
  }

  function alertMarkup() {
    if (!state.error) return '';
    return `<div class="atlas-alert atlas-alert--danger team-alert" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">The team couldn’t be ${state.workspace ? 'updated' : 'loaded'}.</p><p class="atlas-alert__body">${escapeHtml(state.error)} ${state.workspace ? 'You’re seeing the last list that loaded.' : 'Nothing has changed.'}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-team-profiles-refresh>Try again</button></div></div>`;
  }

  // Admin-only: when a permanent delete couldn't remove a member's stored photo,
  // the leftover file is tracked and cleaned up here — no manual Supabase access.
  function orphanCleanupBanner() {
    const count = Number(state.staff?.photo_orphan_count || 0);
    if (!count || state.staff?.role !== 'admin') return '';
    return `<div class="atlas-alert atlas-alert--warning team-alert" role="status">${icon('image-off')}<div class="atlas-alert__content"><p class="atlas-alert__title">${count} leftover profile ${count === 1 ? 'photo' : 'photos'} to remove</p><p class="atlas-alert__body">A permanent deletion couldn’t remove ${count === 1 ? 'a stored photo' : 'some stored photos'}. No personal records remain — only the ${count === 1 ? 'file' : 'files'}. Finish removing ${count === 1 ? 'it' : 'them'} now.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-team-cleanup-photos>${icon('trash-2')}Finish cleanup</button></div></div>`;
  }

  // ---------- profile ----------

  function row(label, value) {
    return `<div class="team-detail__row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  function detailMarkup(profile, options = {}) {
    if (!profile) {
      return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('user-x')}</div><h3 class="atlas-empty__title">This person isn’t on the team</h3><p class="atlas-empty__text">They may have been removed, or the link is wrong.</p><div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#team">Back to Team</a></div></div>`;
    }
    const manager = isManager();
    const own = profile.id === state.staff?.id;
    const t = training(profile);
    const shifts = shiftsFor(profile);
    const titleId = options.titleId || 'team-detail-title';
    // Under the name: what they do and where they stand today, in one grey line.
    const shiftToday = todayShift(profile);
    const facts = [
      shiftToday ? `On shift today ${shiftTime(shiftToday)}` : null,
      profile.can_view_sensitive && profile.start_date ? `Since ${formatDate(profile.start_date)}` : null
    ].filter(Boolean);
    const head = `<div class="team-detail__head" data-team-profile-detail="${escapeHtml(profile.id)}" ${profile.schedule_only ? 'data-schedule-only' : ''}>
      <span class="team-profile-detail-avatar">${avatar(profile, 'atlas-avatar--xl')}</span>
      <div class="team-detail__who"><h2 class="team-detail__name" id="${titleId}">${escapeHtml(profile.name)}</h2><p class="team-detail__role">${escapeHtml([profile.job_title, roleLabel(profile.role)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · '))}</p>${facts.length ? `<p class="team-detail__facts">${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join('')}</p>` : ''}${profile.active ? '' : pill('Inactive')}</div>
      <div class="team-profile-detail-actions team-detail__actions">${profile.can_edit_profile ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-team-profile-edit="${escapeHtml(profile.id)}">${icon('pencil')}Edit profile</button>` : ''}</div>
    </div>`;
    if (profile.schedule_only) {
      return `${head}<section class="team-detail__section"><h3 class="team-detail__title">Schedule only</h3><p class="team-detail__text">${escapeHtml(profile.name)} is on the shift roster without an Alcedo login. ${manager ? 'Add them again with a login to give them access.' : ''}</p>${shifts.length ? shiftsSection(profile, shifts) : ''}<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#shifts">Open Shifts</a></section>${removalBlock(profile)}`;
    }
    const phone = profile.phone ? `<a href="tel:${escapeHtml(String(profile.phone).replace(/\s+/g, ''))}">${escapeHtml(profile.phone)}</a>` : `<span class="team-muted">${profile.can_view_sensitive ? 'Not added' : 'Shared with managers only'}</span>`;
    const email = profile.email ? `<a href="mailto:${escapeHtml(profile.email)}">${escapeHtml(profile.email)}</a>` : '<span class="team-muted">Shared with managers only</span>';
    const contact = `<section class="team-detail__section"><h3 class="team-detail__title">Contact</h3><dl class="team-detail__list">
      ${row('Phone', phone)}${row('Email', email)}${profile.preferred_language ? row('Language', escapeHtml(profile.preferred_language)) : ''}
      ${profile.can_view_sensitive ? `${row('Department', escapeHtml(DEPARTMENT_LABELS[profile.department] || 'Not set'))}${row('Employment', escapeHtml(EMPLOYMENT_LABELS[profile.employment_type] || 'Not set'))}${row('Started', escapeHtml(formatDate(profile.start_date)))}` : ''}
    </dl></section>`;
    return `${head}${contact}${emergencySection(profile, own)}${shiftsSection(profile, shifts)}${trainingSection(profile, t)}${own ? `<section class="team-detail__section"><h3 class="team-detail__title">Required reading</h3><p class="team-detail__text">Procedures you need to read are in Knowledge.</p><a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#knowledge/required">${icon('book-open')}Open required reading</a></section>` : ''}${manager && profile.manager_notes ? `<section class="team-detail__section"><h3 class="team-detail__title">Manager note</h3><p class="team-detail__text">${escapeHtml(profile.manager_notes)}</p></section>` : ''}${accessSection(profile)}${historySection(profile)}${removalBlock(profile)}`;
  }

  function emergencySection(profile, own) {
    if (!profile.can_view_sensitive) return '';
    const contacts = Array.isArray(profile.emergency_contacts) ? profile.emergency_contacts : [];
    const masked = isManager() && !own && !state.revealed.has(profile.id);
    const body = !contacts.length
      ? `<p class="team-detail__text">${own ? 'Add someone we can call if something happens at work.' : 'No emergency contact saved.'}</p>`
      : masked
        ? `<p class="team-detail__text">${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'} saved. Shown only when needed.</p><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-team-reveal="${escapeHtml(profile.id)}">${icon('eye')}Show emergency contact</button>`
        : `<ul class="atlas-list team-contacts">${contacts.sort((a, b) => Number(a.priority) - Number(b.priority)).map((contact) => `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(contact.contact_name)}${Number(contact.priority) === 1 ? ' <span class="team-muted">· First to call</span>' : ''}</p><p class="atlas-row__meta">${escapeHtml(contact.relationship || 'Relationship not added')} · <a href="tel:${escapeHtml(String(contact.phone).replace(/\s+/g, ''))}">${escapeHtml(contact.phone)}</a></p></div>${profile.can_edit_profile ? `<div class="atlas-row__end"><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-team-profile-edit-contact="${escapeHtml(contact.id)}" data-profile-id="${escapeHtml(profile.id)}" aria-label="Edit ${escapeHtml(contact.contact_name)}">${icon('pencil')}</button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-team-profile-remove-contact="${escapeHtml(contact.id)}" data-profile-id="${escapeHtml(profile.id)}" aria-label="Remove ${escapeHtml(contact.contact_name)}">${icon('trash-2')}</button></div>` : ''}</li>`).join('')}</ul>`;
    return `<section class="team-detail__section"><div class="team-detail__title-row"><h3 class="team-detail__title">Emergency contact</h3>${profile.can_edit_profile && !masked ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-profile-add-contact="${escapeHtml(profile.id)}">${icon('plus')}Add</button>` : ''}</div>${body}</section>`;
  }

  function shiftsSection(profile, shifts) {
    if (!state.roster.length && !shifts.length) return '';
    const vcs = vc();
    const todayKey = today();
    return `<section class="team-detail__section"><h3 class="team-detail__title">Shifts this week</h3>${shifts.length
      ? `<ul class="team-shifts">${shifts.map((shift) => {
        const isToday = businessDateOf(shift) === todayKey;
        return `<li${isToday ? ' class="is-today"' : ''}><span class="team-shifts__day">${escapeHtml(vcs ? vcs.formatDate(String(shift.starts_local).slice(0, 10)) : String(shift.starts_local).slice(0, 10))}${isToday ? '<span class="team-shifts__today">Today</span>' : ''}</span><span class="num">${escapeHtml(shiftTime(shift))}</span><span class="team-muted">${escapeHtml(shift.role_name || '')}</span></li>`;
      }).join('')}</ul>`
      : `<p class="team-detail__text">No ${isManager() ? '' : 'published '}shifts this week.</p>`}</section>`;
  }

  function trainingSection(profile, t) {
    if (t.private) return '';
    const tasks = Array.isArray(t.tasks) ? t.tasks : [];
    const canToggle = Boolean(profile.can_manage_training && state.staff?.live_training_writes_enabled);
    const total = Number(t.total_required || 0);
    const done = Number(t.completed_required || 0);
    return `<section class="team-detail__section"><div class="team-detail__title-row"><h3 class="team-detail__title">Onboarding</h3><span class="team-muted num">${done} of ${total} required</span></div>
      ${total ? `<div class="team-onboarding__meter" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Onboarding progress">${meter(done, total, 'team-meter--wide')}</div>` : ''}
      <ul class="team-tasks">${tasks.map((task) => `<li><button type="button" class="team-task${task.completed ? ' is-done' : ''}" data-team-profile-task="${escapeHtml(task.id)}" data-team-profile-task-completed="${task.completed ? 'true' : 'false'}" data-profile-id="${escapeHtml(profile.id)}" ${canToggle ? '' : 'disabled'} aria-pressed="${task.completed ? 'true' : 'false'}">
        <span class="team-task__mark">${icon(task.completed ? 'circle-check' : 'circle')}</span>
        <span class="team-task__body"><span class="team-task__title">${escapeHtml(task.title)}</span><span class="team-task__meta">${escapeHtml([task.required ? 'Required' : 'Optional', task.completed_at ? `Done ${formatDate(task.completed_at)}` : null].filter(Boolean).join(' · '))}</span></span>
      </button></li>`).join('')}</ul>
      <p class="team-detail__hint">${canToggle ? 'Tap a task to mark it done or reopen it. Changes are kept in the history.' : 'Your manager marks each step when you’ve done it.'}</p></section>`;
  }

  function accessSection(profile) {
    if (!state.staff?.can_manage_team) return '';
    const liveWrites = Boolean(state.staff.live_profile_writes_enabled);
    const adminLocked = state.staff.role === 'manager' && profile.role === 'admin';
    const self = profile.id === state.staff.id;
    const renew = !self ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-member-renew="${escapeHtml(profile.id)}">${icon('link')}New setup link</button>` : '';
    // S99 lost-phone recovery: a manager may reset a member's authenticator so
    // they re-enrol at next sign-in. A manager cannot reset an admin (admin-only).
    const resetMfa = !self && !adminLocked ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-member-reset-mfa="${escapeHtml(profile.id)}">${icon('shield')}Reset two-factor</button>` : '';
    if (!liveWrites || !profile.can_manage_access || adminLocked || self) {
      const reason = self ? 'You can’t change your own role or turn off your own access.' : adminLocked ? 'Only an administrator can change an administrator.' : 'Access can’t be changed here right now.';
      return `<section class="team-detail__section"><h3 class="team-detail__title">Access</h3><dl class="team-detail__list">${row('Role', escapeHtml(roleLabel(profile.role)))}${row('Alcedo access', profile.active ? 'On' : 'Off')}</dl><p class="team-detail__hint">${escapeHtml(reason)}</p>${renew || resetMfa ? `<div class="team-access__tools">${renew}${resetMfa}</div>` : ''}</section>`;
    }
    return `<section class="team-detail__section"><h3 class="team-detail__title">Access</h3>
      <form class="atlas-form team-access" data-team-profile-access-form data-profile-id="${escapeHtml(profile.id)}" novalidate>
        <div class="atlas-field"><label for="team-access-role">Role</label><select class="atlas-select" id="team-access-role" name="role">${['admin', 'manager', 'bartender', 'viewer'].map((key) => `<option value="${key}" ${profile.role === key ? 'selected' : ''}>${escapeHtml(roleLabel(key))}</option>`).join('')}</select></div>
        <div class="atlas-toggle-row"><div><p class="atlas-toggle-row__label" id="team-access-active-label">Alcedo access</p><p class="atlas-toggle-row__help">When off, they’re signed out on their next action.</p></div><button type="button" class="atlas-toggle" role="switch" aria-checked="${profile.active ? 'true' : 'false'}" aria-labelledby="team-access-active-label" data-team-access-active></button></div>
        <div class="atlas-form-foot"><button type="submit" class="atlas-btn atlas-btn--primary atlas-btn--sm">Save access</button></div>
      </form>${renew || resetMfa ? `<div class="team-access__tools">${renew}${resetMfa}</div>` : ''}</section>`;
  }

  function historySection(profile) {
    if (!state.staff?.can_manage_team) return '';
    const events = (Array.isArray(state.workspace?.events) ? state.workspace.events : []).filter((event) => event.profile_id === profile.id).slice(0, 8);
    if (!events.length) return '';
    return `<section class="team-detail__section"><h3 class="team-detail__title">History</h3><ul class="team-history">${events.map((event) => `<li><span>${escapeHtml(EVENT_LABELS[event.event_type] || humanize(event.event_type))}</span><span class="team-muted">${escapeHtml(event.actor_label || 'Alcedo')} · ${escapeHtml(vc()?.formatRelative?.(event.created_at) || '')}</span></li>`).join('')}</ul></section>`;
  }

  // Taking someone off the team. "Remove from team" (manager+) archives — it is
  // reversible and keeps every record. "Delete permanently" (administrators only)
  // erases their personal data and sign-in for good; shifts they already worked
  // are kept under a de-identified "Former team member" row and never destroyed.
  // Hidden for your own row; a manager can't act on an administrator. Every rule
  // is re-checked by the Edge Function — these buttons only decide what to show.
  function removalBlock(profile) {
    if (!state.staff?.can_manage_team) return '';
    if (profile.id === state.staff.id) return '';
    const managerOnAdmin = state.staff.role === 'manager' && profile.role === 'admin';
    const canRemove = profile.active !== false && !managerOnAdmin;
    const canDelete = state.staff.role === 'admin';
    if (!canRemove && !canDelete) return '';
    const remove = canRemove ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-team-member-remove="${escapeHtml(profile.id)}">${icon('user-minus')}Remove from team</button>` : '';
    const del = canDelete ? `<button type="button" class="atlas-btn atlas-btn--danger atlas-btn--sm" data-team-member-delete="${escapeHtml(profile.id)}">${icon('trash-2')}Delete permanently</button>` : '';
    return `<section class="team-detail__section team-danger"><h3 class="team-detail__title">Remove from team</h3>
      <p class="team-detail__hint">Removing takes them off the active team and signs them out, but keeps their records — you can add them back any time. Deleting permanently erases their personal details${profile.schedule_only ? '' : ' and Alcedo sign-in'} for good and can’t be undone; shifts they already worked are kept.</p>
      <div class="team-danger__actions">${remove}${del}</div></section>`;
  }

  // ---------- layers ----------

  // Layers and dialogs are the shared AtlasModal ones (modal.js).
  function openLayer({ id, panel, onClose, initialFocus }) {
    const root = window.AtlasModal.layer({ id, panel, className: 'team-layer', onClose, initialFocus });
    paintIcons();
    applyGeometry(root);
    window.AtlasShell?.emit?.('team-profiles:rendered', { host: root });
    return root;
  }

  function closeLayer(root) {
    if (root) window.AtlasModal.dismiss(root);
  }

  // Resolves { value } (the note when `field` is given) or null when dismissed.
  function confirmDialog({ title, body, confirmLabel, danger = false, field = null }) {
    const options = { id: 'team-confirm', title, body, confirmLabel, danger };
    if (!field) return window.AtlasModal.confirm(options).then((ok) => (ok ? { value: '' } : null));
    return window.AtlasModal.prompt({ ...options, label: field.label, value: field.value, placeholder: field.placeholder, required: field.required, maxLength: 1000 })
      .then((value) => (value === null ? null : { value }));
  }

  // Profile: side sheet on wider screens, a full page on phones (spec §7.10).
  function openProfileSheet(profile) {
    const existing = document.getElementById('team-profile-sheet');
    if (existing && existing.dataset.profileId === profile?.id) {
      existing.querySelector('.atlas-sheet__body').innerHTML = detailMarkup(profile, { titleId: 'team-sheet-title' });
      paintIcons();
      applyGeometry(existing);
      window.AtlasShell?.emit?.('team-profiles:rendered', { host: existing });
      return;
    }
    const root = openLayer({
      id: 'team-profile-sheet',
      panel: `<section class="atlas-sheet team-sheet" data-modal-panel aria-labelledby="team-sheet-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head team-sheet__head"><div><p class="atlas-sheet__desc">Team member</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <div class="atlas-sheet__body team-detail">${detailMarkup(profile, { titleId: 'team-sheet-title' })}</div>
      </section>`,
      // Start at the top of the profile, not at the first form field (Access).
      initialFocus: '.atlas-sheet__close',
      onClose: (reason) => {
        if (reason !== 'route' && window.AtlasShell?.current?.() === 'team-profiles' && state.profileId) {
          state.profileId = null;
          routeTo('team-profiles', {});
        }
      }
    });
    root.dataset.profileId = profile?.id || '';
  }

  // Moves between this page's routes; AtlasShell.show() writes the address.
  function routeTo(view, params = {}) {
    window.AtlasShell?.show?.(view, params, { source: 'route' });
  }

  function closeProfileSheet() {
    const sheet = document.getElementById('team-profile-sheet');
    if (sheet && window.AtlasModal?.isOpen?.(sheet)) window.AtlasModal.close(sheet, 'route');
    else sheet?.remove();
  }

  function openEditProfile(profile) {
    if (!profile) return;
    const manager = Boolean(state.staff?.can_manage_team);
    const root = openLayer({
      id: 'team-edit',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="team-edit-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="team-edit-title">Edit profile</h2><p class="atlas-sheet__desc">${escapeHtml(profile.name)}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="team-edit-form" data-team-profile-details-form novalidate>
          <input type="hidden" name="profile_id" value="${escapeHtml(profile.id)}">
          <div class="atlas-field"><label for="te-name">Name shown in Alcedo</label><input class="atlas-input" id="te-name" name="preferred_name" maxlength="120" value="${escapeHtml(profile.preferred_name || profile.display_name || profile.name || '')}"></div>
          <div class="atlas-field"><label for="te-phone">Phone <span class="optional">Optional</span></label><input class="atlas-input" id="te-phone" name="phone" type="tel" maxlength="40" value="${escapeHtml(profile.phone || '')}"></div>
          <div class="atlas-field"><label for="te-phone-vis">Who can see the phone number</label><select class="atlas-select" id="te-phone-vis" name="phone_visibility"><option value="managers_only" ${profile.phone_visibility !== 'team' ? 'selected' : ''}>Managers only</option><option value="team" ${profile.phone_visibility === 'team' ? 'selected' : ''}>Everyone on the team</option></select></div>
          <div class="atlas-field"><label for="te-lang">Language <span class="optional">Optional</span></label><input class="atlas-input" id="te-lang" name="preferred_language" maxlength="80" value="${escapeHtml(profile.preferred_language || '')}" placeholder="English, Icelandic"></div>
          ${manager ? `<div class="atlas-field"><label for="te-title">Job title <span class="optional">Optional</span></label><input class="atlas-input" id="te-title" name="job_title" maxlength="160" value="${escapeHtml(profile.job_title || '')}"></div>
          <div class="atlas-grid-2"><div class="atlas-field"><label for="te-dept">Department</label><select class="atlas-select" id="te-dept" name="department"><option value="">Not set</option>${Object.entries(DEPARTMENT_LABELS).map(([value, label]) => `<option value="${value}" ${profile.department === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          <div class="atlas-field"><label for="te-emp">Employment</label><select class="atlas-select" id="te-emp" name="employment_type"><option value="">Not set</option>${Object.entries(EMPLOYMENT_LABELS).map(([value, label]) => `<option value="${value}" ${profile.employment_type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
          <div class="atlas-field"><label for="te-start">Start date <span class="optional">Optional</span></label><input class="atlas-input" type="date" id="te-start" name="start_date" value="${escapeHtml(profile.start_date || '')}"></div>
          <div class="atlas-field"><label for="te-notes">Manager note <span class="optional">Only managers see this</span></label><textarea class="atlas-input atlas-textarea" id="te-notes" name="manager_notes" rows="3" maxlength="5000">${escapeHtml(profile.manager_notes || '')}</textarea></div>` : ''}
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="team-edit-form" class="atlas-btn atlas-btn--primary">Save profile</button></footer>
      </section>`
    });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const value = (name) => form.elements.namedItem(name)?.value?.trim?.() || '';
      const ok = await mutate('save-details', {
        profile_id: profile.id,
        preferred_name: value('preferred_name'),
        job_title: value('job_title') || null,
        department: value('department') || null,
        employment_type: value('employment_type') || null,
        start_date: value('start_date') || null,
        phone: value('phone'),
        phone_visibility: value('phone_visibility') || 'managers_only',
        preferred_language: value('preferred_language'),
        manager_notes: manager ? (value('manager_notes') || null) : null
      }, 'Profile saved');
      if (ok) closeLayer(root);
    });
  }

  function openContactSheet(profile, contact) {
    const root = openLayer({
      id: 'team-contact',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="team-contact-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="team-contact-title">${contact ? 'Edit emergency contact' : 'Add emergency contact'}</h2><p class="atlas-sheet__desc">Only ${escapeHtml(profile.name)} and managers can see it.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="team-contact-form" data-team-profile-contact-form novalidate>
          <div class="atlas-field"><label for="tc-name">Name</label><input class="atlas-input" id="tc-name" name="contact_name" required maxlength="160" value="${escapeHtml(contact?.contact_name || '')}"><p class="error" hidden data-error-for="contact_name">Enter a name.</p></div>
          <div class="atlas-field"><label for="tc-rel">Relationship <span class="optional">Optional</span></label><input class="atlas-input" id="tc-rel" name="relationship" maxlength="120" value="${escapeHtml(contact?.relationship || '')}" placeholder="Partner, parent, friend"></div>
          <div class="atlas-field"><label for="tc-phone">Phone</label><input class="atlas-input" id="tc-phone" name="phone" type="tel" required maxlength="40" value="${escapeHtml(contact?.phone || '')}"><p class="error" hidden data-error-for="phone">Enter a phone number.</p></div>
          <div class="atlas-field"><label for="tc-priority">Order to call</label><select class="atlas-select" id="tc-priority" name="priority">${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${Number(contact?.priority || 1) === value ? 'selected' : ''}>${value === 1 ? 'First' : `Number ${value}`}</option>`).join('')}</select></div>
          <div class="atlas-field"><label for="tc-note">Note <span class="optional">Optional</span></label><textarea class="atlas-input atlas-textarea" id="tc-note" name="note" rows="2" maxlength="2000">${escapeHtml(contact?.note || '')}</textarea></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="team-contact-form" class="atlas-btn atlas-btn--primary">Save contact</button></footer>
      </section>`
    });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const name = form.contact_name.value.trim();
      const phone = form.phone.value.trim();
      root.querySelector('[data-error-for="contact_name"]').hidden = Boolean(name);
      root.querySelector('[data-error-for="phone"]').hidden = Boolean(phone);
      form.contact_name.setAttribute('aria-invalid', String(!name));
      form.phone.setAttribute('aria-invalid', String(!phone));
      if (!name || !phone) { (!name ? form.contact_name : form.phone).focus(); return; }
      const ok = await mutate('save-emergency-contact', {
        profile_id: profile.id,
        contact_id: contact?.id || null,
        contact_name: name,
        relationship: form.relationship.value.trim(),
        phone,
        priority: Number(form.priority.value || 1),
        note: form.note.value.trim()
      }, 'Emergency contact saved');
      if (ok) closeLayer(root);
    });
  }

  function openAddMember() {
    const root = openLayer({
      id: 'team-add',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="team-add-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="team-add-title">Add team member</h2><p class="atlas-sheet__desc">They appear in Team and Shifts straight away.</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="team-add-form" data-team-profile-add-member-form novalidate>
          <div class="atlas-field"><label for="ta-name">Name</label><input class="atlas-input" id="ta-name" name="display_name" required maxlength="120"><p class="error" hidden data-error-for="display_name">Enter a name.</p></div>
          <div class="atlas-field"><label for="ta-role">Job</label><input class="atlas-input" id="ta-role" name="default_role" required maxlength="120" placeholder="Bartender, barback, manager"><p class="error" hidden data-error-for="default_role">Enter what they do.</p></div>
          <div class="atlas-field"><label for="ta-access">Alcedo access</label><select class="atlas-select" id="ta-access" name="access"><option value="schedule_only">No login — on the schedule only</option><option value="bartender">Staff login</option><option value="viewer">Read-only login</option></select><p class="help">With a login you get a one-time setup link to share with them. No email is sent.</p></div>
          <div class="atlas-field"><label for="ta-email">Email <span class="optional" data-email-optional>Optional</span></label><input class="atlas-input" id="ta-email" name="email" type="email" maxlength="320" autocomplete="off"><p class="error" hidden data-error-for="email">A login needs an email address.</p></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="team-add-form" class="atlas-btn atlas-btn--primary">Add team member</button></footer>
      </section>`
    });
    const form = root.querySelector('form');
    form.access.addEventListener('change', () => { root.querySelector('[data-email-optional]').hidden = form.access.value !== 'schedule_only'; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = { display_name: form.display_name.value.trim(), default_role: form.default_role.value.trim(), email: form.email.value.trim() || null, current_week: rosterWeek() };
      const access = form.access.value;
      const errors = { display_name: !body.display_name, default_role: !body.default_role, email: access !== 'schedule_only' && !body.email };
      Object.entries(errors).forEach(([key, bad]) => { root.querySelector(`[data-error-for="${key}"]`).hidden = !bad; form.elements.namedItem(key).setAttribute('aria-invalid', String(bad)); });
      const first = Object.keys(errors).find((key) => errors[key]);
      if (first) { form.elements.namedItem(first).focus(); return; }
      body.login_role = access;
      const submit = root.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const login = access !== 'schedule_only';
        const payload = await api(login ? 'create-login-member' : 'create-person', { roster: !login, method: 'POST', body });
        closeLayer(root);
        if (login) {
          state.workspace = payload.workspace || state.workspace;
          state.staff = payload.staff || state.staff;
          showSetupLink(payload.result);
        } else {
          state.roster = payload.workspace?.people || state.roster;
          window.AtlasShell?.toast?.(`${body.display_name} added to the schedule`);
        }
        window.dispatchEvent(new Event('atlas:team-roster-changed'));
        loadSnapshot({ silent: true });
      } catch (error) {
        submit.disabled = false;
        window.AtlasShell?.toast?.(shown(error, 'The team member couldn’t be added. Nothing was changed; try again.'));
      }
    });
  }

  function showSetupLink(result) {
    if (!result?.invitation_token) return;
    const link = new URL('invitation.html', window.location.href);
    link.hash = new URLSearchParams({ token_hash: result.invitation_token }).toString();
    const root = openLayer({
      id: 'team-setup-link',
      panel: `<section class="atlas-dialog atlas-dialog--form" data-modal-panel aria-labelledby="team-link-title">
        <h2 class="atlas-dialog__title" id="team-link-title">Share the setup link</h2>
        <div class="atlas-dialog__body">
          <p>${escapeHtml(result.email || 'The new member')} can use this link once to choose a password. Share it privately — no email has been sent.</p>
          <div class="atlas-field"><label for="team-link-input">Setup link</label><input class="atlas-input" id="team-link-input" readonly value="${escapeHtml(link.href)}"></div>
        </div>
        <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--secondary" data-team-copy-link>${icon('copy')}Copy link</button><button type="button" class="atlas-btn atlas-btn--primary" data-modal-close>Done</button></div>
      </section>`
    });
    root.querySelector('[data-team-copy-link]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link.href);
        window.AtlasShell?.toast?.('Setup link copied');
      } catch {
        root.querySelector('#team-link-input')?.select();
        window.AtlasShell?.toast?.('Select the link and copy it');
      }
    });
  }

  // Identify a removal/deletion target: login members by profile_id, schedule-only
  // roster people by person_id (they have no account). The server resolves both.
  function removalTarget(profile) {
    return profile.schedule_only === true ? { person_id: profile.id } : { profile_id: profile.id };
  }

  function normalizeName(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Step-up before a permanent deletion: force a FRESH authenticator check right
  // now, so the sign-in that authorises the delete is recent (not a day-old
  // session). challengeAndVerify refreshes the session's second-factor timestamp,
  // which the Edge Function re-checks server-side. When the admin has no second
  // factor we can't challenge here — we let the request through and the server's
  // own step-up policy decides (and its message is shown truthfully).
  // Fail-closed: deletion proceeds ONLY when a fresh authenticator check verifies
  // here. If the MFA API is unavailable, the factor lookup fails, or the admin has
  // no verified factor, we do NOT continue — the server also enforces this, but
  // the UI must never wave the deletion through on a lookup/verify failure.
  async function stepUpForDeletion() {
    const client = window.atlasSupabase;
    if (!client?.auth?.mfa) return 'unavailable';
    let factor;
    try {
      const listed = await client.auth.mfa.listFactors();
      factor = (listed?.data?.totp || []).find((candidate) => candidate.status === 'verified');
    } catch {
      return 'lookup_failed';
    }
    if (!factor) return 'no_factor';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entered = await window.AtlasModal.prompt({
        id: 'team-delete-stepup', title: 'Confirm it’s you',
        body: attempt
          ? 'That code didn’t work. Enter the current 6-digit code from your authenticator app.'
          : 'Enter the 6-digit code from your authenticator app to confirm this permanent deletion.',
        label: 'Authenticator code', placeholder: '000000', required: true, multiline: false, maxLength: 6, type: 'text', confirmLabel: 'Confirm'
      });
      if (entered === null) return 'cancelled';
      const code = String(entered).replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) continue;
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (!error) return 'verified';
    }
    return 'failed';
  }

  // After a successful removal/deletion: close the open profile, refresh the
  // roster (schedule-only people live in the shifts snapshot), and tell Shifts
  // and Messages to re-read so the person disappears everywhere at once.
  function afterRemoval() {
    state.profileId = null;
    window.dispatchEvent(new Event('atlas:team-roster-changed'));
    loadSnapshot({ silent: true });
    // Close the open profile and return to the directory (the member is gone or
    // archived, so the open sheet no longer makes sense) — on every viewport.
    routeTo('team-profiles', {});
  }

  async function cleanupOrphanPhotos() {
    if (state.submitting) return;
    state.submitting = true;
    try {
      const payload = await api('cleanup-photo-orphans', { method: 'POST', body: {} });
      const r = payload?.result || {};
      state.workspace = payload.workspace || state.workspace;
      state.staff = payload.staff || state.staff;
      if (r.remaining) window.AtlasShell?.toast?.(`Removed ${r.removed}; ${r.remaining} still couldn’t be removed. Try again shortly.`);
      else window.AtlasShell?.toast?.(r.attempted ? `Removed ${r.removed} leftover ${r.removed === 1 ? 'photo' : 'photos'}` : 'Nothing left to clean up');
    } catch (error) {
      window.AtlasShell?.toast?.(shown(error, 'The cleanup couldn’t run. Try again.'));
    } finally {
      state.submitting = false;
      loadSnapshot({ silent: true });
    }
  }

  async function removeMemberFromTeam(profile) {
    if (!profile || state.submitting) return;
    const name = profile.name || 'this member';
    const answer = await confirmDialog({
      title: `Remove ${name} from the team?`,
      body: `${name} is taken off the active team and signed out. Their profile, history and the shifts they worked are all kept — you can add them back any time.`,
      confirmLabel: 'Remove from team', danger: true
    });
    if (!answer) return;
    const ok = await mutate('remove-from-team', removalTarget(profile), `${name} removed from the team`);
    if (ok) afterRemoval();
  }

  async function openDeleteMember(profile) {
    if (!profile || state.submitting) return;
    const target = removalTarget(profile);
    const schedule = profile.schedule_only === true;
    let preview;
    try {
      const payload = await api('delete-preview', { method: 'POST', body: target });
      preview = payload?.result || {};
    } catch (error) {
      window.AtlasShell?.toast?.(shown(error, 'This member couldn’t be checked right now. Try again.'));
      return;
    }
    const name = preview.display_name || profile.name || 'this member';
    const keepsShifts = preview.hard_delete_mode === 'anonymized_kept_shifts';
    const shiftCount = Number(preview.shift_entry_count || 0);
    const kind = schedule ? 'Schedule-only — no login' : 'Alcedo login account';
    const removed = ['Their name, contact details and profile'];
    if (!schedule) removed.push('Their emergency contacts and profile photo', 'Their Alcedo sign-in — they can no longer log in');
    if (!keepsShifts) removed.push('Their roster entry (no past shifts to keep)');
    const kept = keepsShifts ? [`The ${shiftCount} shift${shiftCount === 1 ? '' : 's'} they already worked — kept under “Former team member” so the schedule history stays correct`] : [];
    const list = (items, danger) => `<ul class="team-delete__list${danger ? ' team-delete__list--danger' : ''}">${items.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`;
    const bodyHtml = `
      <div class="team-delete__who">${avatar(profile, 'atlas-avatar--lg')}<div><strong>${escapeHtml(name)}</strong><span class="team-muted">${escapeHtml(kind)}</span></div></div>
      <p class="team-delete__warn">This permanently deletes personal data and can’t be undone.</p>
      <p class="team-delete__label">Deleted for good</p>${list(removed, true)}
      ${kept.length ? `<p class="team-delete__label">Kept (required records)</p>${list(kept, false)}` : ''}
      <div class="atlas-field"><label for="team-delete-confirm">Type <strong>${escapeHtml(name)}</strong> to confirm</label>
        <input class="atlas-input" id="team-delete-confirm" name="confirm_name" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(name)}"></div>`;
    await window.AtlasModal.form({
      id: 'team-delete-member', className: 'team-delete', title: 'Delete permanently?',
      body: bodyHtml, submitLabel: 'Delete permanently', danger: true, wide: true,
      onSubmit: async (form) => {
        const typed = form.elements.namedItem('confirm_name')?.value || '';
        if (!typed.trim()) return 'Type the member’s name to confirm.';
        if (normalizeName(typed) !== normalizeName(name)) return 'That name doesn’t match. Type the member’s name exactly to confirm.';
        const step = await stepUpForDeletion();
        if (step === 'cancelled') return 'Enter your authenticator code to confirm this deletion.';
        if (step === 'no_factor') return 'Set up an authenticator app on your own account before deleting a team member.';
        if (step === 'lookup_failed' || step === 'unavailable') return 'Two-factor couldn’t be checked right now, so the deletion was not performed. Try again.';
        if (step !== 'verified') return 'The authenticator code didn’t match. Try again with the current 6-digit code.';
        let payload;
        try {
          payload = await api('delete-member', { method: 'POST', body: { ...target, confirm_name: typed.trim() } });
        } catch (error) {
          return shown(error, 'The member couldn’t be deleted. Nothing was changed; try again.');
        }
        const result = payload?.result || {};
        state.workspace = payload.workspace || state.workspace;
        state.staff = payload.staff || state.staff;
        if (result.ok === false) {
          // Honest partial outcome: access revoked + personal data purged, but the
          // sign-in account deletion failed. Never report this as a clean success.
          window.AtlasShell?.toast?.(result.message || 'Partly done — access was revoked and data removed, but finishing the sign-in deletion failed. It’s safe to retry.');
          afterRemoval();
          return null;
        }
        window.AtlasShell?.toast?.(`${name} was permanently deleted`);
        afterRemoval();
        return null;
      }
    });
  }

  function openInvite() {
    const root = openLayer({
      id: 'team-invite',
      panel: `<section class="atlas-sheet" data-modal-panel aria-labelledby="team-invite-title">
        <span class="atlas-sheet__grabber" aria-hidden="true"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="team-invite-title">Invite by email</h2><p class="atlas-sheet__desc">Alcedo emails them a secure invitation. Pick their role now; their account turns on once they finish setup (password, name, phone, photo and authenticator app).</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form" id="team-invite-form" data-team-profile-invite-form novalidate>
          <div class="atlas-field"><label for="ti-email">Email</label><input class="atlas-input" id="ti-email" name="email" type="email" required maxlength="320" autocomplete="email"><p class="error" hidden data-error-for="email">Enter an email address.</p></div>
          <div class="atlas-field"><label for="ti-name">Name <span class="optional">Optional</span></label><input class="atlas-input" id="ti-name" name="display_name" maxlength="120" autocomplete="name"></div>
          <div class="atlas-field"><label for="ti-role">Role</label><select class="atlas-select" id="ti-role" name="role">${(role() === 'admin' ? ['admin', 'manager', 'bartender', 'viewer'] : ['manager', 'bartender', 'viewer']).map((key) => `<option value="${key}"${key === 'viewer' ? ' selected' : ''}>${escapeHtml(roleLabel(key))}</option>`).join('')}</select></div>
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" form="team-invite-form" class="atlas-btn atlas-btn--primary">Send invitation</button></footer>
      </section>`
    });
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const email = form.email.value.trim();
      const bad = !email || !form.email.checkValidity();
      root.querySelector('[data-error-for="email"]').hidden = !bad;
      form.email.setAttribute('aria-invalid', String(bad));
      if (bad) { form.email.focus(); return; }
      const ok = await mutate('invite-account', { email, display_name: form.display_name.value.trim() || null, role: form.role?.value || 'viewer' }, `Invitation sent to ${email}`);
      if (ok) closeLayer(root);
    });
  }

  // ---------- load & save ----------

  async function loadSnapshot(options = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!options.silent) state.error = null;
    paint();
    try {
      const [payload, roster] = await Promise.all([api('snapshot'), api('snapshot', { roster: true }).catch(() => null)]);
      if (!payload?.workspace) throw new TeamError('Team is temporarily unavailable.', 0);
      state.workspace = payload.workspace;
      state.staff = payload.staff || state.staff;
      state.roster = Array.isArray(roster?.workspace?.people) ? roster.workspace.people : [];
      state.rosterShifts = Array.isArray(roster?.workspace?.shifts) ? roster.workspace.shifts : [];
      state.error = null;
      state.failedAt = 0;
      window.dispatchEvent(new CustomEvent('atlas:team-summary', { detail: { activeProfiles: Number(state.workspace?.summary?.active_profiles) } }));
    } catch (error) {
      state.error = shown(error, 'The team couldn’t be loaded. Check the connection and try again.');
      state.failedAt = Date.now();
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.submitting) return false;
    state.submitting = true;
    try {
      const payload = await api(action, { method: 'POST', body });
      state.workspace = payload.workspace || state.workspace;
      state.staff = payload.staff || state.staff;
      if (successMessage) window.AtlasShell?.toast?.(successMessage);
      // Names, roles and access show in Messages, Shifts and the sidebar.
      window.dispatchEvent(new Event('atlas:team-roster-changed'));
      return true;
    } catch (error) {
      window.AtlasShell?.toast?.(shown(error, 'The change couldn’t be saved. Nothing was changed; try again.'));
      return false;
    } finally {
      state.submitting = false;
      paint();
    }
  }

  // ---------- render ----------

  function paint() {
    if (!state.visible) return;
    const view = ensureHost();
    const focusId = document.activeElement && view.contains(document.activeElement) ? document.activeElement.id || (document.activeElement.matches('[data-team-search]') ? 'team-search' : '') : '';
    const phoneDetail = phoneQuery.matches && state.profileId;
    if (phoneDetail) {
      const profile = profileById(state.profileId);
      view.innerHTML = `<div class="team team--detail">${state.workspace ? `<div class="team-detail">${detailMarkup(profile, { titleId: 'team-page-title' })}</div>` : alertMarkup() || `<div class="team-skel" aria-busy="true">${'<div class="atlas-skel atlas-skel--row"></div>'.repeat(4)}</div>`}</div>`;
      window.AtlasChrome?.setTopBar?.({ title: profile?.name || 'Team', back: () => routeTo('team-profiles', {}) });
    } else {
      view.innerHTML = `<div class="team">${headerMarkup()}${alertMarkup()}${orphanCleanupBanner()}${!state.workspace && state.error ? '' : toolbarMarkup()}<div class="team-body">${directoryMarkup()}</div></div>`;
      window.AtlasChrome?.setTopBar?.({});
    }
    paintIcons();
    applyGeometry(view);
    if (focusId === 'team-search') {
      const input = view.querySelector('[data-team-search]');
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    } else if (focusId) document.getElementById(focusId)?.focus?.({ preventScroll: true });
    window.AtlasShell?.emit?.('team-profiles:rendered', { host: view });
    syncSheet();
  }

  function syncSheet() {
    if (!state.visible || phoneQuery.matches || !state.profileId || !state.workspace) {
      if (!state.profileId || phoneQuery.matches) closeProfileSheet();
      return;
    }
    openProfileSheet(profileById(state.profileId));
  }

  function render(params = {}) {
    state.visible = true;
    const next = params.profile ? String(params.profile) : null;
    state.profileId = next;
    const view = ensureHost();
    view.style.display = 'block';
    if (!state.workspace && !state.loading && (Date.now() - state.failedAt > 20000 || !state.failedAt)) loadSnapshot();
    else paint();
  }

  function hide() {
    state.visible = false;
    closeProfileSheet();
    document.querySelectorAll('.team-layer').forEach((layer) => closeLayer(layer));
  }

  // ---------- events ----------

  function inScope(element) {
    return Boolean(element && (host()?.contains(element) || element.closest('.team-layer')));
  }

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !inScope(target)) return;

    const open = target.closest('[data-team-profile-open]');
    if (open) {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      routeTo('team-profiles', { profile: open.dataset.teamProfileOpen });
      return;
    }
    const rowEl = target.closest('tr[data-team-profile-select]');
    if (rowEl && !target.closest('a, button')) {
      routeTo('team-profiles', { profile: rowEl.dataset.teamProfileSelect });
      return;
    }
    if (target.closest('[data-team-profiles-refresh]')) { state.failedAt = 0; loadSnapshot(); return; }
    if (target.closest('[data-team-cleanup-photos]')) { cleanupOrphanPhotos(); return; }
    if (target.closest('[data-team-profile-add-member]')) { openAddMember(); return; }
    if (target.closest('[data-team-profile-invite]')) { openInvite(); return; }
    if (target.closest('[data-team-clear]')) { state.search = ''; state.roleFilter = 'all'; state.trainingDue = false; state.contactMissing = false; state.filter = 'active'; paint(); return; }
    const filter = target.closest('[data-team-profiles-filter]');
    if (filter) { state.filter = filter.dataset.teamProfilesFilter; paint(); return; }
    const chip = target.closest('[data-team-chip]');
    if (chip) {
      if (chip.dataset.teamChip === 'training') state.trainingDue = !state.trainingDue;
      else state.contactMissing = !state.contactMissing;
      paint();
      return;
    }
    const reveal = target.closest('[data-team-reveal]');
    if (reveal) { state.revealed.add(reveal.dataset.teamReveal); syncSheet(); if (phoneQuery.matches) paint(); return; }
    const edit = target.closest('[data-team-profile-edit]');
    if (edit) { openEditProfile(profileById(edit.dataset.teamProfileEdit)); return; }
    const addContact = target.closest('[data-team-profile-add-contact]');
    if (addContact) { openContactSheet(profileById(addContact.dataset.teamProfileAddContact), null); return; }
    const editContact = target.closest('[data-team-profile-edit-contact]');
    if (editContact) {
      const profile = profileById(editContact.dataset.profileId);
      openContactSheet(profile, (profile?.emergency_contacts || []).find((contact) => contact.id === editContact.dataset.teamProfileEditContact) || null);
      return;
    }
    const removeContact = target.closest('[data-team-profile-remove-contact]');
    if (removeContact) {
      const profile = profileById(removeContact.dataset.profileId);
      const contact = (profile?.emergency_contacts || []).find((entry) => entry.id === removeContact.dataset.teamProfileRemoveContact);
      const answer = await confirmDialog({ title: 'Remove this emergency contact?', body: `${contact?.contact_name || 'The contact'} is removed from ${profile?.name || 'the'} profile. The change is kept in the history.`, confirmLabel: 'Remove contact', danger: true });
      if (answer) mutate('remove-emergency-contact', { profile_id: profile.id, contact_id: removeContact.dataset.teamProfileRemoveContact }, 'Emergency contact removed');
      return;
    }
    const task = target.closest('[data-team-profile-task]');
    if (task && !task.disabled) {
      const profile = profileById(task.dataset.profileId);
      const completed = task.dataset.teamProfileTaskCompleted !== 'true';
      const answer = await confirmDialog({
        title: completed ? 'Mark this step as done?' : 'Reopen this step?',
        body: `${task.querySelector('.team-task__title')?.textContent || 'This step'} for ${profile?.name || 'this person'}.`,
        confirmLabel: completed ? 'Mark as done' : 'Reopen step',
        field: { label: 'Note' }
      });
      if (answer) mutate('update-onboarding', { profile_id: profile.id, task_id: task.dataset.teamProfileTask, completed, note: answer.value || null }, completed ? 'Step marked as done' : 'Step reopened');
      return;
    }
    const toggle = target.closest('[data-team-access-active]');
    if (toggle) { toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true')); return; }
    const renew = target.closest('[data-team-member-renew]');
    if (renew) {
      if (state.submitting) return;
      state.submitting = true;
      try {
        const payload = await api('renew-member-setup', { method: 'POST', body: { profile_id: renew.dataset.teamMemberRenew } });
        showSetupLink(payload.result);
      } catch (error) {
        window.AtlasShell?.toast?.(shown(error, 'A new setup link couldn’t be made. Try again.'));
      } finally {
        state.submitting = false;
      }
      return;
    }
    const removeMember = target.closest('[data-team-member-remove]');
    if (removeMember) { removeMemberFromTeam(profileById(removeMember.dataset.teamMemberRemove)); return; }
    const deleteMember = target.closest('[data-team-member-delete]');
    if (deleteMember) { openDeleteMember(profileById(deleteMember.dataset.teamMemberDelete)); return; }
    const resetMfa = target.closest('[data-team-member-reset-mfa]');
    if (resetMfa) {
      const profile = profileById(resetMfa.dataset.teamMemberResetMfa);
      const answer = await confirmDialog({
        title: `Reset ${profile?.name || 'this member'}’s two-factor?`,
        body: 'Their authenticator app is removed. They’ll be asked to set up a new one the next time they sign in. Use this if they lost their phone.',
        confirmLabel: 'Reset two-factor',
        danger: true
      });
      if (answer) mutate('reset-member-mfa', { profile_id: resetMfa.dataset.teamMemberResetMfa }, 'Two-factor reset');
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-team-profile-access-form]') || !inScope(form)) return;
    event.preventDefault();
    const profile = profileById(form.dataset.profileId);
    if (!profile) return;
    const active = form.querySelector('[data-team-access-active]')?.getAttribute('aria-checked') === 'true';
    const nextRole = form.elements.namedItem('role').value;
    if (!active && profile.active) {
      const answer = await confirmDialog({ title: `Turn off ${profile.name}’s access?`, body: 'They are signed out on their next action and can’t open Alcedo until you turn access on again. Their history stays.', confirmLabel: 'Turn off access', danger: true });
      if (!answer) return;
    }
    mutate('update-access', { profile_id: profile.id, role: nextRole, active }, 'Access saved');
  }

  function handleInput(event) {
    const target = event.target;
    if (target?.matches?.('[data-team-search]') && host()?.contains(target)) {
      state.search = target.value;
      const body = host().querySelector('.team-body');
      if (body) { body.innerHTML = directoryMarkup(); paintIcons(); applyGeometry(body); }
      const count = host().querySelector('[data-team-count]');
      if (count) count.textContent = `${filteredProfiles().length} shown`;
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target?.matches?.('[data-team-role-filter]')) { state.roleFilter = target.value; paint(); }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureHost();
    window.AtlasShell?.registerView?.('team-profiles', { root: host, title: 'Team', render, onHide: hide });
    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    window.addEventListener('atlas:profile-photos-updated', () => { if (state.visible) paint(); });
    phoneQuery.addEventListener?.('change', () => { if (state.visible) paint(); });
    window.AtlasShell?.actions?.register?.({
      id: 'team.add', label: 'Add team member', icon: 'user-plus', keywords: ['team', 'staff', 'person', 'employee', 'invite'], roles: MANAGER_ROLES, contexts: ['team-profiles', 'shifts'],
      run: () => { routeTo('team-profiles', {}); window.setTimeout(openAddMember, 300); }
    });
    if (window.AtlasShell?.current?.() === 'team-profiles') render(window.AtlasShell.params?.() || {});
  }

  window.AtlasTeamProfiles = {
    open: () => routeTo('team-profiles', {}),
    refresh: () => loadSnapshot(),
    snapshot: () => state.workspace,
    openProfile: (profileId) => routeTo('team-profiles', { profile: profileId })
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
