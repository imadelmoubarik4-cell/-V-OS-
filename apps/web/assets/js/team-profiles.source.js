(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 15000;
  const ROLE_LABELS = {
    admin: 'Administrator',
    manager: 'Manager',
    bartender: 'Bartender',
    viewer: 'Viewer'
  };
  const DEPARTMENT_LABELS = {
    management: 'Management',
    bar: 'Bar',
    kitchen: 'Kitchen',
    service: 'Service',
    operations: 'Operations',
    marketing: 'Marketing',
    other: 'Other'
  };
  const EMPLOYMENT_LABELS = {
    owner: 'Owner',
    full_time: 'Full-time',
    part_time: 'Part-time',
    temporary: 'Temporary',
    contractor: 'Contractor',
    other: 'Other'
  };

  const state = {
    workspace: null,
    staff: null,
    loading: false,
    submitting: false,
    error: null,
    message: null,
    search: '',
    filter: 'active',
    selectedProfileId: null,
    modal: null,
    initialized: false,
    activating: false,
    viewObserver: null
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function initials(value) {
    const words = String(value || 'Atlas').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || 'A';
  }

  function formatDate(value, fallback = 'Not set') {
    if (!value) return fallback;
    const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    if (Number.isNaN(date.getTime())) return fallback;
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function profileApi() {
    return String(cfg.TEAM_PROFILES_API || '').trim();
  }

  function host() {
    return document.getElementById('team-profiles-view');
  }

  function viewVisible() {
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

  async function api(action, options = {}) {
    const endpoint = profileApi();
    if (!endpoint) throw new Error('Team Profiles API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Team Profiles.');

    const url = new URL(endpoint);
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
          'content-type': 'application/json'
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Team Profiles request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Team Profiles took too long to respond. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function profiles() {
    return Array.isArray(state.workspace?.profiles) ? state.workspace.profiles : [];
  }

  function selectedProfile() {
    return profiles().find((profile) => profile.id === state.selectedProfileId)
      || profiles().find((profile) => profile.id === state.staff?.id)
      || profiles()[0]
      || null;
  }

  function profileEvents(profileId) {
    const events = Array.isArray(state.workspace?.events) ? state.workspace.events : [];
    return events.filter((event) => event.profile_id === profileId);
  }

  function training(profile) {
    return profile?.training && !profile.training.private
      ? profile.training
      : { private: true, total_required: 0, completed_required: 0, percent: null, tasks: [] };
  }

  function filteredProfiles() {
    const query = state.search.trim().toLowerCase();
    return profiles().filter((profile) => {
      if (state.filter === 'active' && !profile.active) return false;
      if (state.filter === 'inactive' && profile.active) return false;
      if (state.filter === 'training' && (training(profile).private || training(profile).complete)) return false;
      if (state.filter === 'contacts' && Number(profile.emergency_contact_count || 0) > 0) return false;
      if (!query) return true;
      return [
        profile.name,
        profile.email,
        profile.job_title,
        profile.role,
        profile.department,
        profile.employment_type
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
    });
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || humanize(role);
  }

  function progressBar(value, label) {
    const percent = Math.max(0, Math.min(100, Number(value || 0)));
    return `<div class="team-profile-progress" aria-label="${escapeHtml(label)} ${percent}%"><span style="width:${percent}%"></span></div>`;
  }

  function feedbackMarkup() {
    if (state.error) return `<div class="team-profiles-feedback is-error"><i data-lucide="triangle-alert"></i><span>${escapeHtml(state.error)}</span></div>`;
    if (state.message) return `<div class="team-profiles-feedback is-success"><i data-lucide="circle-check-big"></i><span>${escapeHtml(state.message)}</span></div>`;
    return '';
  }

  function summaryMarkup() {
    const summary = state.workspace?.summary || {};
    const values = [
      ['users-round', 'Active staff', Number(summary.active_profiles || 0), 'Profiles with Atlas access'],
      ['shield-check', 'Managers', Number(summary.managers || 0), 'Managers and administrators'],
      ['graduation-cap', 'Training complete', summary.training_complete ?? '—', 'Required onboarding finished'],
      ['phone-call', 'Emergency contacts', summary.emergency_contacts_complete ?? '—', 'Profiles with a contact saved']
    ];
    return `<div class="team-profiles-summary">${values.map(([icon, label, value, note]) => `<article><span><i data-lucide="${icon}"></i>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('')}</div>`;
  }

  function profileCard(profile) {
    const profileTraining = training(profile);
    const trainingPercent = profileTraining.private ? null : Number(profileTraining.percent || 0);
    const subtitle = profile.job_title || roleLabel(profile.role);
    return `<button type="button" class="team-profile-card ${profile.id === selectedProfile()?.id ? 'is-selected' : ''}" data-team-profile-select="${escapeHtml(profile.id)}">
      <span class="team-profile-avatar">${escapeHtml(initials(profile.name))}</span>
      <span class="team-profile-card-copy">
        <span><strong>${escapeHtml(profile.name)}</strong>${profile.active ? '<small class="is-active">Active</small>' : '<small class="is-inactive">Inactive</small>'}</span>
        <small>${escapeHtml(subtitle)} · ${escapeHtml(profile.email || 'No email')}</small>
        ${trainingPercent === null ? '<em>Training private</em>' : `<em>${trainingPercent}% onboarding</em>${progressBar(trainingPercent, 'Onboarding')}`}
      </span>
      <i data-lucide="chevron-right"></i>
    </button>`;
  }

  function directoryMarkup() {
    const entries = filteredProfiles();
    return `<aside class="team-profiles-directory">
      <header><strong>Team directory</strong><span>${entries.length} shown</span></header>
      <label class="team-profiles-search"><i data-lucide="search"></i><input type="search" data-team-profiles-search placeholder="Search name, role or department" value="${escapeHtml(state.search)}" /></label>
      <div class="team-profiles-filters">
        ${['active','all','training','contacts','inactive'].map((filter) => `<button type="button" class="${state.filter === filter ? 'is-active' : ''}" data-team-profiles-filter="${filter}">${filter === 'training' ? 'Training due' : filter === 'contacts' ? 'Contact missing' : humanize(filter)}</button>`).join('')}
      </div>
      <div class="team-profile-card-list">${entries.length ? entries.map(profileCard).join('') : '<div class="team-profiles-empty"><i data-lucide="user-search"></i><p>No profiles match this view.</p></div>'}</div>
      <footer><i data-lucide="user-plus"></i><span>Account invitations are not connected yet. This checkpoint manages existing Atlas accounts only.</span></footer>
    </aside>`;
  }

  function definitionRow(label, value, fallback = 'Not set') {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || fallback)}</dd></div>`;
  }

  function emergencyMarkup(profile) {
    if (!profile.can_view_sensitive) {
      return `<section class="team-profile-panel"><header><div><span>Private</span><h3>Emergency contact</h3></div><i data-lucide="lock-keyhole"></i></header><p class="team-profile-private-note">Emergency contacts are visible only to the team member and managers.</p></section>`;
    }
    const contacts = Array.isArray(profile.emergency_contacts) ? profile.emergency_contacts : [];
    return `<section class="team-profile-panel">
      <header><div><span>Safety</span><h3>Emergency contacts</h3></div>${profile.can_edit_profile ? '<button type="button" data-team-profile-add-contact><i data-lucide="plus"></i>Add</button>' : ''}</header>
      <div class="team-emergency-list">${contacts.length ? contacts.map((contact) => `<article>
        <span class="team-emergency-priority">${contact.priority}</span>
        <div><strong>${escapeHtml(contact.contact_name)}</strong><small>${escapeHtml(contact.relationship || 'Relationship not set')}</small><a href="tel:${escapeHtml(contact.phone)}">${escapeHtml(contact.phone)}</a>${contact.note ? `<p>${escapeHtml(contact.note)}</p>` : ''}</div>
        ${profile.can_edit_profile ? `<span class="team-emergency-actions"><button type="button" data-team-profile-edit-contact="${escapeHtml(contact.id)}" aria-label="Edit emergency contact"><i data-lucide="pencil"></i></button><button type="button" data-team-profile-remove-contact="${escapeHtml(contact.id)}" aria-label="Remove emergency contact"><i data-lucide="trash-2"></i></button></span>` : ''}
      </article>`).join('') : '<div class="team-profile-empty-section"><i data-lucide="phone-off"></i><p>No emergency contact saved.</p></div>'}</div>
    </section>`;
  }

  function trainingMarkup(profile) {
    const profileTraining = training(profile);
    if (profileTraining.private) {
      return `<section class="team-profile-panel"><header><div><span>Private</span><h3>Onboarding and training</h3></div><i data-lucide="lock-keyhole"></i></header><p class="team-profile-private-note">Training progress is visible only to the team member and managers.</p></section>`;
    }
    const tasks = Array.isArray(profileTraining.tasks) ? profileTraining.tasks : [];
    const canManageTraining = Boolean(profile.can_manage_training && state.staff?.live_profile_writes_enabled);
    return `<section class="team-profile-panel team-training-panel">
      <header><div><span>Knowledge</span><h3>Onboarding and training</h3></div><strong>${Number(profileTraining.completed_required || 0)}/${Number(profileTraining.total_required || 0)}</strong></header>
      <div class="team-training-summary"><span>${Number(profileTraining.percent || 0)}% complete</span>${progressBar(profileTraining.percent, 'Onboarding')}</div>
      <div class="team-training-list">${tasks.map((task) => `<button type="button" class="team-training-task ${task.completed ? 'is-complete' : ''}" data-team-profile-task="${escapeHtml(task.id)}" data-team-profile-task-completed="${task.completed ? 'true' : 'false'}" ${canManageTraining ? '' : 'disabled'}>
        <span><i data-lucide="${task.completed ? 'circle-check-big' : 'circle'}"></i></span>
        <span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.description || humanize(task.category))}</small>${task.completed_at ? `<em>Completed ${escapeHtml(formatDate(task.completed_at))}</em>` : ''}</span>
        ${task.required ? '<small>Required</small>' : '<small>Optional</small>'}
      </button>`).join('')}</div>
      ${canManageTraining ? '<footer>Managers can update each task. Every change is kept in the Team Profiles audit trail.</footer>' : state.staff?.can_manage_team ? '<footer><i data-lucide="shield-off"></i>Training changes are preview-locked. Current production progress is read-only here.</footer>' : '<footer>Your manager records completion after each training step.</footer>'}
    </section>`;
  }

  function accessMarkup(profile) {
    if (!state.staff?.can_manage_team) return '';
    const canManage = Boolean(profile.can_manage_access);
    const adminLocked = state.staff.role === 'manager' && profile.role === 'admin';
    const liveWrites = Boolean(state.staff.live_profile_writes_enabled);
    return `<section class="team-profile-panel team-access-panel">
      <header><div><span>Access</span><h3>Role and account status</h3></div><i data-lucide="key-round"></i></header>
      ${!liveWrites ? `<p class="team-profile-private-note"><i data-lucide="shield-off"></i>Role and active-status controls are preview-locked. Atlas displays the current production access state without changing it.</p><dl>${definitionRow('Current role', roleLabel(profile.role))}${definitionRow('Current access', profile.active ? 'Active' : 'Inactive')}</dl>` : canManage && !adminLocked ? `<form data-team-profile-access-form>
        <label><span>Atlas role</span><select name="role">
          ${['admin','manager','bartender','viewer'].map((role) => `<option value="${role}" ${profile.role === role ? 'selected' : ''}>${escapeHtml(roleLabel(role))}</option>`).join('')}
        </select></label>
        <label class="team-profile-toggle"><input type="checkbox" name="active" ${profile.active ? 'checked' : ''}/><span><strong>Active Atlas access</strong><small>Inactive profiles are denied on their next request.</small></span></label>
        <button type="submit" class="team-profile-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="shield-check"></i>Save access</button>
      </form>` : `<p class="team-profile-private-note"><i data-lucide="lock-keyhole"></i>${profile.id === state.staff?.id ? 'You cannot change your own role or deactivate your own account here.' : 'Only an administrator can modify an administrator profile.'}</p>`}
    </section>`;
  }

  function historyMarkup(profile) {
    if (!state.staff?.can_manage_team) return '';
    const events = profileEvents(profile.id);
    return `<section class="team-profile-panel team-profile-history">
      <header><div><span>Audit</span><h3>Recent profile activity</h3></div><span>${events.length}</span></header>
      <div>${events.length ? events.slice(0, 12).map((event) => `<article><span><i data-lucide="history"></i></span><div><strong>${escapeHtml(humanize(event.event_type))}</strong><small>${escapeHtml(event.actor_label || 'Atlas')} · ${escapeHtml(formatDateTime(event.created_at))}</small></div></article>`).join('') : '<div class="team-profile-empty-section"><i data-lucide="history"></i><p>No profile changes recorded yet.</p></div>'}</div>
    </section>`;
  }

  function detailMarkup() {
    const profile = selectedProfile();
    if (!profile) return `<main class="team-profile-detail"><div class="team-profiles-empty"><i data-lucide="users"></i><p>No team profiles are available.</p></div></main>`;
    const profileTraining = training(profile);
    return `<main class="team-profile-detail">
      <header class="team-profile-detail-head">
        <div class="team-profile-detail-avatar">${escapeHtml(initials(profile.name))}</div>
        <div><span>${escapeHtml(roleLabel(profile.role))}</span><h2>${escapeHtml(profile.name)}</h2><p>${escapeHtml(profile.email || 'No email')}</p></div>
        <div class="team-profile-detail-actions">
          <span class="team-profile-status ${profile.active ? 'is-active' : 'is-inactive'}">${profile.active ? 'Active' : 'Inactive'}</span>
          ${profile.can_edit_profile ? '<button type="button" data-team-profile-edit><i data-lucide="pencil"></i>Edit profile</button>' : ''}
        </div>
      </header>

      <div class="team-profile-completeness">
        <div><span>Profile completeness</span><strong>${profile.profile_completion_percent ?? '—'}%</strong></div>
        ${profile.profile_completion_percent === null ? '' : progressBar(profile.profile_completion_percent, 'Profile completeness')}
        <p>${profile.profile_completion_percent === 100 ? 'Contact and emergency details are ready.' : 'Add missing profile and emergency details to complete this record.'}</p>
      </div>

      <div class="team-profile-detail-grid">
        <section class="team-profile-panel">
          <header><div><span>Employment</span><h3>Role at VÁ</h3></div><i data-lucide="briefcase-business"></i></header>
          <dl>${definitionRow('Job title', profile.job_title)}${definitionRow('Department', DEPARTMENT_LABELS[profile.department])}${definitionRow('Employment', EMPLOYMENT_LABELS[profile.employment_type])}${definitionRow('Start date', formatDate(profile.start_date))}</dl>
        </section>
        <section class="team-profile-panel">
          <header><div><span>Contact</span><h3>Staff details</h3></div><i data-lucide="contact-round"></i></header>
          <dl>${definitionRow('Email', profile.email)}${definitionRow('Phone', profile.phone, profile.can_view_sensitive ? 'Not set' : 'Managers only')}${definitionRow('Language', profile.preferred_language)}${definitionRow('Onboarding', profileTraining.private ? 'Private' : `${Number(profileTraining.percent || 0)}% complete`)}</dl>
        </section>
      </div>

      ${profile.manager_notes && state.staff?.can_manage_team ? `<section class="team-profile-manager-note"><i data-lucide="notebook-pen"></i><div><span>Manager note</span><p>${escapeHtml(profile.manager_notes)}</p></div></section>` : ''}
      <div class="team-profile-detail-grid">${emergencyMarkup(profile)}${accessMarkup(profile)}</div>
      ${trainingMarkup(profile)}
      ${historyMarkup(profile)}
    </main>`;
  }

  function editProfileModal(profile) {
    const manager = Boolean(state.staff?.can_manage_team);
    return `<div class="team-profile-modal" role="dialog" aria-modal="true" aria-labelledby="team-profile-modal-title">
      <div class="team-profile-modal-backdrop" data-team-profile-close-modal></div>
      <section>
        <header><div><span>Team profile</span><h2 id="team-profile-modal-title">Edit ${escapeHtml(profile.name)}</h2></div><button type="button" data-team-profile-close-modal aria-label="Close"><i data-lucide="x"></i></button></header>
        <form data-team-profile-details-form>
          <input type="hidden" name="profile_id" value="${escapeHtml(profile.id)}" />
          <div class="team-profile-form-grid">
            <label><span>Preferred name</span><input name="preferred_name" maxlength="120" value="${escapeHtml(profile.preferred_name || profile.display_name || '')}" placeholder="Name used inside Atlas" /></label>
            <label><span>Phone</span><input name="phone" maxlength="40" value="${escapeHtml(profile.phone || '')}" placeholder="Phone number" /></label>
            <label><span>Phone visibility</span><select name="phone_visibility"><option value="managers_only" ${profile.phone_visibility !== 'team' ? 'selected' : ''}>Managers only</option><option value="team" ${profile.phone_visibility === 'team' ? 'selected' : ''}>Visible to active team</option></select></label>
            <label><span>Preferred language</span><input name="preferred_language" maxlength="80" value="${escapeHtml(profile.preferred_language || '')}" placeholder="English, Icelandic…" /></label>
            ${manager ? `<label><span>Job title</span><input name="job_title" maxlength="160" value="${escapeHtml(profile.job_title || '')}" placeholder="Bartender, co-owner…" /></label>
            <label><span>Department</span><select name="department"><option value="">Not set</option>${Object.entries(DEPARTMENT_LABELS).map(([value,label]) => `<option value="${value}" ${profile.department === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
            <label><span>Employment type</span><select name="employment_type"><option value="">Not set</option>${Object.entries(EMPLOYMENT_LABELS).map(([value,label]) => `<option value="${value}" ${profile.employment_type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
            <label><span>Start date</span><input type="date" name="start_date" value="${escapeHtml(profile.start_date || '')}" /></label>` : ''}
          </div>
          ${manager ? `<label><span>Manager notes</span><textarea name="manager_notes" rows="4" maxlength="5000" placeholder="Private manager-only notes">${escapeHtml(profile.manager_notes || '')}</textarea></label>` : ''}
          <footer><button type="button" class="team-profile-secondary" data-team-profile-close-modal>Cancel</button><button type="submit" class="team-profile-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>Save profile</button></footer>
        </form>
      </section>
    </div>`;
  }

  function contactModal(profile, contact) {
    return `<div class="team-profile-modal" role="dialog" aria-modal="true" aria-labelledby="team-contact-modal-title">
      <div class="team-profile-modal-backdrop" data-team-profile-close-modal></div>
      <section>
        <header><div><span>Safety contact</span><h2 id="team-contact-modal-title">${contact ? 'Edit' : 'Add'} emergency contact</h2></div><button type="button" data-team-profile-close-modal aria-label="Close"><i data-lucide="x"></i></button></header>
        <form data-team-profile-contact-form>
          <input type="hidden" name="profile_id" value="${escapeHtml(profile.id)}" />
          <input type="hidden" name="contact_id" value="${escapeHtml(contact?.id || '')}" />
          <div class="team-profile-form-grid">
            <label><span>Contact name</span><input name="contact_name" required maxlength="160" value="${escapeHtml(contact?.contact_name || '')}" /></label>
            <label><span>Relationship</span><input name="relationship" maxlength="120" value="${escapeHtml(contact?.relationship || '')}" placeholder="Partner, parent, friend…" /></label>
            <label><span>Phone</span><input name="phone" required maxlength="40" value="${escapeHtml(contact?.phone || '')}" /></label>
            <label><span>Priority</span><select name="priority">${[1,2,3,4,5].map((value) => `<option value="${value}" ${Number(contact?.priority || 1) === value ? 'selected' : ''}>${value}${value === 1 ? ' · Primary' : ''}</option>`).join('')}</select></label>
          </div>
          <label><span>Note</span><textarea name="note" rows="3" maxlength="2000" placeholder="Optional context for managers">${escapeHtml(contact?.note || '')}</textarea></label>
          <footer><button type="button" class="team-profile-secondary" data-team-profile-close-modal>Cancel</button><button type="submit" class="team-profile-primary" ${state.submitting ? 'disabled' : ''}><i data-lucide="save"></i>Save contact</button></footer>
        </form>
      </section>
    </div>`;
  }

  function modalMarkup() {
    const profile = selectedProfile();
    if (!state.modal || !profile) return '';
    if (state.modal.mode === 'edit-profile') return editProfileModal(profile);
    if (state.modal.mode === 'contact') {
      const contacts = Array.isArray(profile.emergency_contacts) ? profile.emergency_contacts : [];
      return contactModal(profile, contacts.find((contact) => contact.id === state.modal.contactId) || null);
    }
    return '';
  }

  function loadingMarkup() {
    return `<section class="team-profiles-state"><span><i data-lucide="loader-circle"></i></span><h2>Loading Team Profiles</h2><p>Checking active accounts, roles, emergency contacts and onboarding progress.</p></section>`;
  }

  function errorMarkup() {
    return `<section class="team-profiles-state"><span class="is-error"><i data-lucide="user-x"></i></span><h2>Team Profiles unavailable</h2><p>${escapeHtml(state.error || 'The workspace could not load.')}</p><button type="button" class="team-profile-primary" data-team-profiles-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function shellMarkup() {
    return `<section class="team-profiles-shell">
      <header class="team-profiles-hero">
        <div><span><i data-lucide="contact-round"></i>Checkpoint E · People operations</span><h1>Team Profiles</h1><p>Roles, contact details, emergency information and onboarding progress for every existing Atlas account.</p></div>
        <div><button type="button" data-team-profiles-messages><i data-lucide="messages-square"></i>Messages</button><button type="button" data-team-profiles-refresh><i data-lucide="refresh-cw"></i>Refresh</button></div>
      </header>
      ${feedbackMarkup()}
      ${summaryMarkup()}
      <div class="team-profiles-layout">${directoryMarkup()}${detailMarkup()}</div>
      <footer class="team-profiles-trust"><i data-lucide="shield-check"></i><span>Active profiles only for staff · Emergency contacts private · Role and access changes manager-controlled · Training changes audited · Account invitation off</span></footer>
      ${modalMarkup()}
    </section>`;
  }

  function render() {
    const element = host();
    if (!element) return;
    if (state.loading && !state.workspace) element.innerHTML = loadingMarkup();
    else if (state.error && !state.workspace) element.innerHTML = errorMarkup();
    else element.innerHTML = shellMarkup();
    document.body.classList.toggle('team-profile-modal-open', Boolean(state.modal));
    window.lucide?.createIcons?.();
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || (!viewVisible() && !options.force)) return;
    state.loading = !state.workspace;
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot');
      state.workspace = payload.workspace || {};
      state.staff = payload.staff || state.staff;
      if (!profiles().some((profile) => profile.id === state.selectedProfileId)) {
        state.selectedProfileId = profiles().find((profile) => profile.id === state.staff?.id)?.id
          || profiles()[0]?.id
          || null;
      }
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Team Profiles could not load.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function mutate(action, body, successMessage) {
    if (state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      const payload = await api(action, { method: 'POST', body });
      state.workspace = payload.workspace || state.workspace;
      state.staff = payload.staff || state.staff;
      state.message = successMessage;
      state.modal = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The Team Profile change could not be saved.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  function formValue(form, name) {
    return form.elements.namedItem(name)?.value?.trim?.() || '';
  }

  function submitDetails(form) {
    mutate('save-details', {
      profile_id: formValue(form, 'profile_id'),
      preferred_name: formValue(form, 'preferred_name'),
      job_title: formValue(form, 'job_title') || null,
      department: formValue(form, 'department') || null,
      employment_type: formValue(form, 'employment_type') || null,
      start_date: formValue(form, 'start_date') || null,
      phone: formValue(form, 'phone'),
      phone_visibility: formValue(form, 'phone_visibility') || 'managers_only',
      preferred_language: formValue(form, 'preferred_language'),
      manager_notes: formValue(form, 'manager_notes') || null
    }, 'Team profile updated.');
  }

  function submitContact(form) {
    mutate('save-emergency-contact', {
      profile_id: formValue(form, 'profile_id'),
      contact_id: formValue(form, 'contact_id') || null,
      contact_name: formValue(form, 'contact_name'),
      relationship: formValue(form, 'relationship'),
      phone: formValue(form, 'phone'),
      priority: Number(formValue(form, 'priority') || 1),
      note: formValue(form, 'note')
    }, 'Emergency contact saved.');
  }

  function submitAccess(form) {
    const profile = selectedProfile();
    if (!profile) return;
    mutate('update-access', {
      profile_id: profile.id,
      role: formValue(form, 'role'),
      active: Boolean(form.elements.namedItem('active')?.checked)
    }, 'Role and account status updated.');
  }

  function openMessages() {
    const teamButton = document.querySelector('.nav-item[data-view="team"]');
    if (teamButton) teamButton.click();
    else window.AtlasTeamMessages?.openChannel?.('general');
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const navButton = target.closest('.nav-item[data-view="team-profiles"]');
    if (navButton) {
      event.preventDefault();
      event.stopPropagation();
      activateProfiles();
      return;
    }

    if (target.closest('[data-team-profile-close-modal]')) {
      event.preventDefault();
      state.modal = null;
      render();
      return;
    }

    if (!host()?.contains(target)) return;

    if (target.closest('[data-team-profiles-refresh]')) { loadSnapshot({ force: true }); return; }
    if (target.closest('[data-team-profiles-messages]')) { openMessages(); return; }

    const card = target.closest('[data-team-profile-select]');
    if (card) {
      state.selectedProfileId = card.dataset.teamProfileSelect;
      state.error = null;
      state.message = null;
      render();
      return;
    }

    const filter = target.closest('[data-team-profiles-filter]');
    if (filter) {
      state.filter = filter.dataset.teamProfilesFilter || 'active';
      render();
      return;
    }

    if (target.closest('[data-team-profile-edit]')) {
      state.modal = { mode: 'edit-profile' };
      render();
      return;
    }

    if (target.closest('[data-team-profile-add-contact]')) {
      state.modal = { mode: 'contact', contactId: null };
      render();
      return;
    }

    const editContact = target.closest('[data-team-profile-edit-contact]');
    if (editContact) {
      state.modal = { mode: 'contact', contactId: editContact.dataset.teamProfileEditContact };
      render();
      return;
    }

    const removeContact = target.closest('[data-team-profile-remove-contact]');
    if (removeContact) {
      const profile = selectedProfile();
      if (!profile || !window.confirm('Remove this emergency contact? The audit event will be preserved.')) return;
      mutate('remove-emergency-contact', {
        profile_id: profile.id,
        contact_id: removeContact.dataset.teamProfileRemoveContact
      }, 'Emergency contact removed.');
      return;
    }

    const task = target.closest('[data-team-profile-task]');
    if (task && !task.disabled) {
      const profile = selectedProfile();
      if (!profile) return;
      const completed = task.dataset.teamProfileTaskCompleted !== 'true';
      const note = window.prompt(completed ? 'Completion note (optional):' : 'Reason for reopening this task (optional):') || '';
      mutate('update-onboarding', {
        profile_id: profile.id,
        task_id: task.dataset.teamProfileTask,
        completed,
        note: note.trim() || null
      }, completed ? 'Training task completed.' : 'Training task reopened.');
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-team-profiles-search]')) return;
    state.search = target.value;
    render();
    requestAnimationFrame(() => {
      const field = host()?.querySelector('[data-team-profiles-search]');
      if (field) {
        field.focus();
        field.setSelectionRange(state.search.length, state.search.length);
      }
    });
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !host()?.contains(form)) return;
    event.preventDefault();
    if (form.matches('[data-team-profile-details-form]')) submitDetails(form);
    else if (form.matches('[data-team-profile-contact-form]')) submitContact(form);
    else if (form.matches('[data-team-profile-access-form]')) submitAccess(form);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.modal) {
      state.modal = null;
      render();
    }
  }

  function hideProfiles() {
    const element = host();
    if (element && element.style.display !== 'none') element.style.display = 'none';
    state.modal = null;
    document.body.classList.remove('team-profile-modal-open');
  }

  function handleNavigationCapture(event) {
    const button = event.target instanceof Element ? event.target.closest('.nav-item[data-view]') : null;
    if (!button) return;
    if (button.dataset.view === 'team-profiles') {
      event.preventDefault();
      event.stopPropagation();
      activateProfiles();
      return;
    }
    hideProfiles();
  }

  function activateProfiles() {
    ensureStructure();
    state.activating = true;
    document.querySelectorAll('#inventory-view,#dashboard-view,#recipes-view,#suppliers-view,#imports-view,#team-view,#shifts-view,#knowledge-view,#reports-view,#settings-view,#operations-center,#brain-shell,#marketing-view').forEach((view) => { view.style.display = 'none'; });
    ['home-intro','home-focus','home-metrics'].forEach((id) => { const element = document.getElementById(id); if (element) element.style.display = 'none'; });
    const element = host();
    if (element) element.style.display = 'block';
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = 'Team Profiles';
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === 'team-profiles'));
    document.getElementById('atlas-sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
    state.activating = false;
    if (!state.workspace && !state.loading) loadSnapshot({ force: true });
    else render();
  }

  function ensureStructure() {
    let navButton = document.querySelector('.nav-item[data-view="team-profiles"]');
    if (!navButton) {
      const teamButton = document.querySelector('.nav-item[data-view="team"]');
      if (teamButton) {
        navButton = document.createElement('button');
        navButton.className = 'nav-item';
        navButton.dataset.view = 'team-profiles';
        navButton.innerHTML = '<i data-lucide="contact-round"></i>Profiles';
        teamButton.insertAdjacentElement('afterend', navButton);
      }
    }

    if (!host()) {
      const view = document.createElement('div');
      view.id = 'team-profiles-view';
      view.className = 'team-profiles-view';
      view.style.display = 'none';
      const parent = document.getElementById('team-view')?.parentElement || document.querySelector('.atlas-content main');
      const teamView = document.getElementById('team-view');
      if (teamView) teamView.insertAdjacentElement('afterend', view);
      else parent?.appendChild(view);
    }
    window.lucide?.createIcons?.();
  }

  function observeViewChanges() {
    const parent = host()?.parentElement;
    if (!parent) return;
    state.viewObserver?.disconnect();
    state.viewObserver = new MutationObserver(() => {
      if (state.activating || !viewVisible()) return;
      const anotherVisible = [...parent.children].some((child) => child !== host() && window.getComputedStyle(child).display !== 'none');
      if (anotherVisible) hideProfiles();
    });
    state.viewObserver.observe(parent, { subtree: false, attributes: true, attributeFilter: ['style','class','hidden'] });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStructure();
    observeViewChanges();
    document.addEventListener('click', handleNavigationCapture, true);
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('keydown', handleKeydown);
  }

  window.AtlasTeamProfiles = {
    open: activateProfiles,
    refresh: () => loadSnapshot({ force: true }),
    snapshot: () => state.workspace,
    openProfile: (profileId) => {
      state.selectedProfileId = profileId;
      activateProfiles();
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
