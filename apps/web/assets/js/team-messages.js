(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const POLL_FALLBACK_MS = 6000;
  const REQUEST_TIMEOUT_MS = 15000;

  const state = {
    snapshot: null,
    staff: null,
    members: [],
    selectedChannel: 'general',
    loading: false,
    refreshing: false,
    submitting: false,
    markingRead: false,
    error: null,
    message: null,
    drafts: Object.create(null),
    editingMessageId: null,
    attachmentOpen: false,
    linkType: 'none',
    linkQuery: '',
    linkTargets: [],
    selectedTarget: null,
    targetLoading: false,
    targetTimer: null,
    pollTimer: null,
    viewObserver: null,
    initialized: false
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatBody(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
  }

  function humanize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function initials(value) {
    const words = String(value || 'Atlas').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'A';
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('');
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const now = new Date();
    const sameDate = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    return new Intl.DateTimeFormat('en-GB', sameDate
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    ).format(date);
  }

  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `team-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function host() {
    return document.getElementById('team-view');
  }

  function teamApi() {
    return String(cfg.TEAM_MESSAGES_API || '').trim();
  }

  function teamViewVisible() {
    const element = host();
    if (!element) return false;
    return window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(document.getElementById('app-screen')).display !== 'none';
  }

  async function activeSession() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function api(action, options = {}) {
    const endpoint = teamApi();
    if (!endpoint) throw new Error('Checkpoint C team-message API is not configured for this preview.');
    const session = await activeSession();
    if (!session?.access_token) throw new Error('Sign in to Atlas to open Team Messages.');

    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });

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
      if (!response.ok) throw new Error(payload.error || `Team-message request failed (${response.status}).`);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Team Messages took too long to respond. Check the connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function channels() {
    return Array.isArray(state.snapshot?.channels) ? state.snapshot.channels : [];
  }

  function messages() {
    return Array.isArray(state.snapshot?.messages) ? state.snapshot.messages : [];
  }

  function selectedChannel() {
    return channels().find((channel) => channel.key === state.selectedChannel)
      || channels()[0]
      || null;
  }

  function currentDraft() {
    return state.drafts[state.selectedChannel] || '';
  }

  function setCurrentDraft(value) {
    state.drafts[state.selectedChannel] = String(value ?? '');
  }

  function userIsInteracting() {
    const element = document.activeElement;
    const inside = element && host()?.contains(element);
    return Boolean(
      state.editingMessageId
      || state.attachmentOpen
      || currentDraft().trim()
      || (inside && ['TEXTAREA', 'INPUT', 'SELECT'].includes(element.tagName))
    );
  }

  function renderChannelButton(channel) {
    const unread = Number(channel.unread_count || 0);
    return `<button type="button" class="team-channel ${channel.key === state.selectedChannel ? 'is-active' : ''}" data-team-channel="${escapeHtml(channel.key)}">
      <span class="team-channel-icon is-${escapeHtml(channel.tone || 'neutral')}"><i data-lucide="${escapeHtml(channel.icon || 'message-circle')}"></i></span>
      <span class="team-channel-copy"><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(channel.last_message?.body || channel.description || '')}</small></span>
      ${unread > 0 ? `<span class="team-unread-count">${unread > 99 ? '99+' : unread}</span>` : ''}
    </button>`;
  }

  function renderReadStatus(message) {
    if (!message.is_own || message.message_type !== 'user') return '';
    const readers = Array.isArray(message.read_by) ? message.read_by : [];
    const count = Number(message.read_by_count || readers.length || 0);
    if (!count) return '<span class="team-read-status">Sent</span>';
    const names = readers.map((reader) => reader.user_label).filter(Boolean).join(', ');
    return `<span class="team-read-status" ${names ? `title="${escapeHtml(names)}"` : ''}><i data-lucide="check-check"></i>Read by ${count}</span>`;
  }

  function renderLink(link) {
    if (!link) return '';
    const icons = {
      inventory_item: 'package',
      routine: 'clipboard-check',
      shift: 'calendar-clock',
      brain_recommendation: 'brain-circuit'
    };
    return `<button type="button" class="team-message-link" data-team-open-link="${escapeHtml(link.type)}" data-team-link-key="${escapeHtml(link.key)}" data-team-link-route="${escapeHtml(link.route || '')}">
      <span><i data-lucide="${escapeHtml(icons[link.type] || 'link-2')}"></i></span>
      <span><small>${escapeHtml(humanize(link.type))}</small><strong>${escapeHtml(link.label)}</strong></span>
      <i data-lucide="arrow-up-right"></i>
    </button>`;
  }

  function renderMessage(message) {
    if (message.deleted) {
      return `<article class="team-message is-deleted">
        <div class="team-message-avatar"><i data-lucide="message-square-x"></i></div>
        <div class="team-message-content"><p>Message deleted</p><small>${escapeHtml(formatDateTime(message.created_at))}</small></div>
      </article>`;
    }

    const system = message.message_type === 'system';
    const own = Boolean(message.is_own);
    return `<article class="team-message ${system ? 'is-system' : ''} ${own ? 'is-own' : ''}" data-team-message="${escapeHtml(message.id)}">
      <div class="team-message-avatar">${system ? '<i data-lucide="sparkles"></i>' : escapeHtml(initials(message.sender_label))}</div>
      <div class="team-message-content">
        <header><div><strong>${escapeHtml(message.sender_label)}</strong><span>${escapeHtml(system ? 'System update' : humanize(message.sender_role))}</span></div><time>${escapeHtml(formatDateTime(message.created_at))}${message.edited_at ? ' · edited' : ''}</time></header>
        <p>${formatBody(message.body)}</p>
        ${renderLink(message.link)}
        <footer>
          ${renderReadStatus(message)}
          <span class="team-message-actions">
            ${message.can_edit ? `<button type="button" data-team-edit="${escapeHtml(message.id)}">Edit</button>` : ''}
            ${message.can_delete ? `<button type="button" data-team-delete="${escapeHtml(message.id)}">Delete</button>` : ''}
          </span>
        </footer>
      </div>
    </article>`;
  }

  function emptyMessagesMarkup() {
    return `<div class="team-messages-empty"><div><i data-lucide="messages-square"></i></div><h3>No messages yet</h3><p>Start the conversation in ${escapeHtml(selectedChannel()?.name || 'this channel')}.</p></div>`;
  }

  function attachmentSummary() {
    if (!state.selectedTarget) return '';
    return `<div class="team-selected-link"><span><i data-lucide="link-2"></i><strong>${escapeHtml(state.selectedTarget.label)}</strong><small>${escapeHtml(state.selectedTarget.description || humanize(state.selectedTarget.type))}</small></span><button type="button" data-team-remove-link aria-label="Remove linked record"><i data-lucide="x"></i></button></div>`;
  }

  function targetResultsMarkup() {
    if (state.targetLoading) return '<div class="team-target-state"><i data-lucide="loader-circle"></i>Loading available records…</div>';
    if (!state.linkTargets.length) return `<div class="team-target-state">${state.linkType === 'shift' ? 'No shifts are available yet.' : 'No matching records found.'}</div>`;
    return state.linkTargets.map((target) => `<button type="button" class="team-target-option ${state.selectedTarget?.key === target.key ? 'is-selected' : ''}" data-team-select-target="${escapeHtml(target.key)}">
      <span><strong>${escapeHtml(target.label)}</strong><small>${escapeHtml(target.description || '')}</small></span><i data-lucide="${state.selectedTarget?.key === target.key ? 'circle-check-big' : 'circle'}"></i>
    </button>`).join('');
  }

  function attachmentPanelMarkup() {
    if (!state.attachmentOpen || state.editingMessageId) return '';
    return `<section class="team-attachment-panel">
      <header><div><strong>Link an Atlas record</strong><span>The target is verified by the server before the message is sent.</span></div><button type="button" data-team-close-attachment><i data-lucide="x"></i></button></header>
      <div class="team-attachment-controls">
        <select data-team-link-type aria-label="Link type">
          <option value="none" ${state.linkType === 'none' ? 'selected' : ''}>Choose a record type</option>
          <option value="inventory_item" ${state.linkType === 'inventory_item' ? 'selected' : ''}>Inventory item</option>
          <option value="routine" ${state.linkType === 'routine' ? 'selected' : ''}>Checklist / routine</option>
          <option value="shift" ${state.linkType === 'shift' ? 'selected' : ''}>Shift</option>
          <option value="brain_recommendation" ${state.linkType === 'brain_recommendation' ? 'selected' : ''}>Atlas recommendation</option>
        </select>
        <label><i data-lucide="search"></i><input type="search" data-team-target-search placeholder="Search available records" value="${escapeHtml(state.linkQuery)}" ${state.linkType === 'none' ? 'disabled' : ''} /></label>
      </div>
      <div class="team-target-list">${state.linkType === 'none' ? '<div class="team-target-state">Choose a record type to continue.</div>' : targetResultsMarkup()}</div>
    </section>`;
  }

  function composerMarkup(channel) {
    const canPost = Boolean(state.staff?.can_post && channel?.can_post);
    if (!canPost) {
      const reason = channel?.manager_post_only
        ? 'Only managers and administrators can post in Announcements.'
        : 'Your current role can read messages but cannot post.';
      return `<div class="team-composer-locked"><i data-lucide="lock-keyhole"></i><span>${escapeHtml(reason)}</span></div>`;
    }

    const editing = messages().find((message) => message.id === state.editingMessageId);
    const buttonLabel = editing ? 'Save edit' : 'Send';
    return `<div class="team-composer-wrap">
      ${editing ? `<div class="team-editing-banner"><span><i data-lucide="pencil"></i>Editing your message</span><button type="button" data-team-cancel-edit>Cancel</button></div>` : ''}
      ${attachmentSummary()}
      ${attachmentPanelMarkup()}
      <form class="team-composer" data-team-composer>
        <textarea rows="3" maxlength="4000" data-team-draft placeholder="Message ${escapeHtml(channel?.name || 'the team')}…" ${state.submitting ? 'disabled' : ''}>${escapeHtml(currentDraft())}</textarea>
        <footer>
          <div>
            ${editing ? '' : `<button type="button" class="team-composer-tool ${state.attachmentOpen ? 'is-active' : ''}" data-team-toggle-attachment><i data-lucide="paperclip"></i><span>Link record</span></button>`}
            <span class="team-composer-hint">Ctrl/⌘ + Enter to send</span>
          </div>
          <button type="submit" class="team-send-button" ${state.submitting || !currentDraft().trim() ? 'disabled' : ''}><i data-lucide="${editing ? 'save' : 'send'}"></i>${escapeHtml(buttonLabel)}</button>
        </footer>
      </form>
    </div>`;
  }

  function loadingMarkup() {
    return `<section class="team-messages-shell is-state"><div class="team-state-icon"><i data-lucide="loader-circle"></i></div><h2>Loading Team Messages</h2><p>Checking active staff, channels, unread counts and recent conversations.</p></section>`;
  }

  function errorMarkup() {
    return `<section class="team-messages-shell is-state"><div class="team-state-icon is-error"><i data-lucide="message-square-warning"></i></div><h2>Team Messages unavailable</h2><p>${escapeHtml(state.error || 'The workspace could not load.')}</p><button type="button" class="team-send-button" data-team-refresh><i data-lucide="refresh-cw"></i>Try again</button></section>`;
  }

  function shellMarkup() {
    const channel = selectedChannel();
    const memberCount = Number(state.snapshot?.summary?.active_members || state.members.length || 0);
    const messageList = messages();
    return `<section class="team-messages-shell">
      <header class="team-messages-hero">
        <div><span><i data-lucide="messages-square"></i>Checkpoint C · Internal communication</span><h1>Team Messages</h1><p>Operations, handovers, announcements and marketing conversations in one private staff workspace.</p></div>
        <div class="team-messages-hero-actions"><span><i data-lucide="users"></i>${memberCount} active staff</span><button type="button" data-team-refresh aria-label="Refresh messages"><i data-lucide="refresh-cw"></i>Refresh</button></div>
      </header>

      ${state.message ? `<div class="team-feedback is-success"><i data-lucide="circle-check-big"></i>${escapeHtml(state.message)}</div>` : ''}
      ${state.error ? `<div class="team-feedback is-error"><i data-lucide="triangle-alert"></i>${escapeHtml(state.error)}</div>` : ''}

      <div class="team-messages-layout">
        <aside class="team-channel-panel">
          <header><strong>Channels</strong><span>${Number(state.snapshot?.summary?.total_unread || 0)} unread</span></header>
          <div class="team-channel-list">${channels().map(renderChannelButton).join('')}</div>
          <footer><i data-lucide="bell-off"></i><span>Browser and mobile notifications will be added after permission and delivery settings are approved.</span></footer>
        </aside>

        <main class="team-conversation-panel">
          <header class="team-conversation-head">
            <div><span class="team-conversation-icon is-${escapeHtml(channel?.tone || 'neutral')}"><i data-lucide="${escapeHtml(channel?.icon || 'message-circle')}"></i></span><div><h2>${escapeHtml(channel?.name || 'Team Messages')}</h2><p>${escapeHtml(channel?.description || '')}</p></div></div>
            ${channel?.manager_post_only ? '<span class="team-manager-only"><i data-lucide="shield-check"></i>Manager posts only</span>' : ''}
          </header>

          <div class="team-message-list" data-team-message-list>${messageList.length ? messageList.map(renderMessage).join('') : emptyMessagesMarkup()}</div>
          ${composerMarkup(channel)}
        </main>
      </div>

      <footer class="team-messages-trust"><i data-lucide="shield-check"></i><span>Active staff only · Manager-only announcements · Message revisions audited · Inactive profiles denied on every request · Push notifications off</span></footer>
    </section>`;
  }

  function updateUnreadBadges() {
    const total = Number(state.snapshot?.summary?.total_unread || 0);
    const teamButton = document.querySelector('.nav-item[data-view="team"]');
    if (teamButton) {
      let badge = teamButton.querySelector('.team-nav-unread');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'team-nav-unread';
        teamButton.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.hidden = total <= 0;
    }

    const bell = document.querySelector('.atlas-topbar .top-icon[title="Notifications"]');
    if (bell) {
      let badge = bell.querySelector('.team-bell-unread');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'team-bell-unread';
        bell.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.hidden = total <= 0;
    }
  }

  function render() {
    const element = host();
    if (!element) return;
    element.classList.remove('placeholder-view');
    if (state.loading && !state.snapshot) element.innerHTML = loadingMarkup();
    else if (state.error && !state.snapshot) element.innerHTML = errorMarkup();
    else element.innerHTML = shellMarkup();
    updateUnreadBadges();
    window.lucide?.createIcons?.();

    const list = element.querySelector('[data-team-message-list]');
    if (list && !state.refreshing) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  async function markSelectedChannelRead() {
    const channel = selectedChannel();
    if (!channel || state.markingRead || Number(channel.unread_count || 0) <= 0 || !teamViewVisible()) return;
    state.markingRead = true;
    try {
      const payload = await api('mark-read', {
        method: 'POST',
        body: { channel_key: state.selectedChannel, limit: 60 }
      });
      if (payload.snapshot) state.snapshot = payload.snapshot;
      if (Array.isArray(payload.members)) state.members = payload.members;
      updateUnreadBadges();
      render();
    } catch (error) {
      console.warn('Team message read state could not be updated:', error?.message || error);
    } finally {
      state.markingRead = false;
    }
  }

  async function loadSnapshot(options = {}) {
    if (state.loading || !teamViewVisible()) return;
    state.loading = !state.snapshot;
    state.refreshing = Boolean(options.silent);
    if (!options.silent) {
      state.error = null;
      state.message = null;
    }
    render();
    try {
      const payload = await api('snapshot', {
        params: { channel: state.selectedChannel, limit: 60 }
      });
      state.snapshot = payload.snapshot || {};
      state.staff = payload.staff || state.staff;
      state.members = Array.isArray(payload.members) ? payload.members : state.members;
      state.selectedChannel = state.snapshot.selected_channel_key || state.selectedChannel;
      state.error = null;
      render();
      await markSelectedChannelRead();
      startPolling();
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Team Messages could not load.';
      render();
    } finally {
      state.loading = false;
      state.refreshing = false;
    }
  }

  function startPolling() {
    stopPolling();
    const interval = Math.max(4000, Number(state.snapshot?.policy?.poll_after_ms || POLL_FALLBACK_MS));
    state.pollTimer = window.setInterval(() => {
      if (!teamViewVisible() || document.hidden || userIsInteracting() || state.submitting) return;
      loadSnapshot({ silent: true });
    }, interval);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function resetComposer() {
    setCurrentDraft('');
    state.editingMessageId = null;
    state.attachmentOpen = false;
    state.linkType = 'none';
    state.linkQuery = '';
    state.linkTargets = [];
    state.selectedTarget = null;
    state.targetLoading = false;
  }

  async function sendOrEdit() {
    const body = currentDraft().trim();
    if (!body || state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.message = null;
    render();
    try {
      if (state.editingMessageId) {
        await api('edit', {
          method: 'POST',
          body: {
            channel_key: state.selectedChannel,
            message_id: state.editingMessageId,
            body
          }
        });
        state.message = 'Message updated.';
      } else {
        await api('send', {
          method: 'POST',
          body: {
            channel_key: state.selectedChannel,
            body,
            client_request_id: requestId(),
            link_type: state.selectedTarget?.type || 'none',
            link_key: state.selectedTarget?.key || null
          }
        });
        state.message = 'Message sent.';
      }
      resetComposer();
      await loadSnapshot({ silent: true });
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The message could not be saved.';
      render();
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function deleteMessage(messageId) {
    const message = messages().find((candidate) => candidate.id === messageId);
    if (!message || state.submitting) return;
    const deletingAnother = message.sender_id !== state.staff?.id;
    let reason = null;
    if (deletingAnother) {
      reason = window.prompt('Manager reason for deleting this message:');
      if (!reason?.trim()) return;
    } else if (!window.confirm('Delete this message? The audit history will be preserved.')) {
      return;
    }

    state.submitting = true;
    state.error = null;
    try {
      await api('delete', {
        method: 'POST',
        body: {
          channel_key: state.selectedChannel,
          message_id: messageId,
          reason: reason?.trim() || null
        }
      });
      state.message = 'Message deleted. Its audit history was preserved.';
      await loadSnapshot({ silent: true });
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The message could not be deleted.';
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function loadTargets() {
    if (state.linkType === 'none') {
      state.linkTargets = [];
      state.selectedTarget = null;
      state.targetLoading = false;
      render();
      return;
    }

    state.targetLoading = true;
    state.error = null;
    render();
    try {
      const payload = await api('targets', {
        params: { type: state.linkType, q: state.linkQuery }
      });
      state.linkTargets = Array.isArray(payload.targets) ? payload.targets : [];
      if (state.selectedTarget && !state.linkTargets.some((target) => target.key === state.selectedTarget.key)) {
        state.selectedTarget = null;
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Linked records could not be loaded.';
      state.linkTargets = [];
    } finally {
      state.targetLoading = false;
      render();
    }
  }

  function debounceTargets() {
    if (state.targetTimer) window.clearTimeout(state.targetTimer);
    state.targetTimer = window.setTimeout(loadTargets, 280);
  }

  function navigateView(view) {
    const button = document.querySelector(`.nav-item[data-view="${CSS.escape(view)}"]`);
    if (button) button.click();
    else if (typeof window.setActiveView === 'function') window.setActiveView(view);
  }

  function openLinkedRecord(type, key) {
    if (type === 'routine') {
      if (window.AtlasCheckpointALayout?.openRoutine) window.AtlasCheckpointALayout.openRoutine(key);
      else navigateView('operations');
      return;
    }
    if (type === 'brain_recommendation') {
      navigateView('brain');
      window.setTimeout(() => window.AtlasPhase3Brain?.openRecommendation?.(key), 250);
      return;
    }
    if (type === 'shift') {
      navigateView('shifts');
      return;
    }
    navigateView('inventory');
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const channelButton = target.closest('[data-team-channel]');
    if (channelButton && host()?.contains(channelButton)) {
      event.preventDefault();
      state.selectedChannel = channelButton.dataset.teamChannel || 'general';
      resetComposer();
      state.snapshot = null;
      loadSnapshot();
      return;
    }

    if (target.closest('[data-team-refresh]') && host()?.contains(target)) {
      event.preventDefault();
      loadSnapshot();
      return;
    }

    const editButton = target.closest('[data-team-edit]');
    if (editButton && host()?.contains(editButton)) {
      const message = messages().find((candidate) => candidate.id === editButton.dataset.teamEdit);
      if (!message) return;
      state.editingMessageId = message.id;
      state.attachmentOpen = false;
      state.selectedTarget = null;
      setCurrentDraft(message.body || '');
      render();
      requestAnimationFrame(() => host()?.querySelector('[data-team-draft]')?.focus());
      return;
    }

    if (target.closest('[data-team-cancel-edit]') && host()?.contains(target)) {
      event.preventDefault();
      resetComposer();
      render();
      return;
    }

    const deleteButton = target.closest('[data-team-delete]');
    if (deleteButton && host()?.contains(deleteButton)) {
      event.preventDefault();
      deleteMessage(deleteButton.dataset.teamDelete);
      return;
    }

    if (target.closest('[data-team-toggle-attachment]') && host()?.contains(target)) {
      event.preventDefault();
      state.attachmentOpen = !state.attachmentOpen;
      if (state.attachmentOpen && state.linkType !== 'none' && !state.linkTargets.length) loadTargets();
      else render();
      return;
    }

    if (target.closest('[data-team-close-attachment]') && host()?.contains(target)) {
      event.preventDefault();
      state.attachmentOpen = false;
      render();
      return;
    }

    if (target.closest('[data-team-remove-link]') && host()?.contains(target)) {
      event.preventDefault();
      state.selectedTarget = null;
      render();
      return;
    }

    const targetOption = target.closest('[data-team-select-target]');
    if (targetOption && host()?.contains(targetOption)) {
      event.preventDefault();
      state.selectedTarget = state.linkTargets.find((candidate) => candidate.key === targetOption.dataset.teamSelectTarget) || null;
      state.attachmentOpen = false;
      render();
      return;
    }

    const linkedRecord = target.closest('[data-team-open-link]');
    if (linkedRecord && host()?.contains(linkedRecord)) {
      event.preventDefault();
      openLinkedRecord(linkedRecord.dataset.teamOpenLink, linkedRecord.dataset.teamLinkKey);
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-team-composer]')) return;
    event.preventDefault();
    sendOrEdit();
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return;
    if (target.matches('[data-team-draft]')) {
      setCurrentDraft(target.value);
      const sendButton = host()?.querySelector('.team-send-button[type="submit"]');
      if (sendButton) sendButton.disabled = state.submitting || !target.value.trim();
    }
    if (target.matches('[data-team-target-search]')) {
      state.linkQuery = target.value;
      debounceTargets();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.matches('[data-team-link-type]')) return;
    state.linkType = target.value;
    state.linkQuery = '';
    state.linkTargets = [];
    state.selectedTarget = null;
    loadTargets();
  }

  function handleKeydown(event) {
    if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches('[data-team-draft]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      sendOrEdit();
    }
  }

  function handleVisibility() {
    if (document.hidden || !teamViewVisible()) stopPolling();
    else {
      startPolling();
      if (!userIsInteracting()) loadSnapshot({ silent: true });
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    const element = host();
    if (!element) return;

    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('visibilitychange', handleVisibility);

    state.viewObserver = new MutationObserver(() => {
      if (teamViewVisible()) {
        if (!state.snapshot && !state.loading) loadSnapshot();
        else startPolling();
      } else {
        stopPolling();
      }
    });
    state.viewObserver.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

    if (teamViewVisible()) loadSnapshot();
    else render();
  }

  window.AtlasTeamMessages = {
    refresh: () => loadSnapshot(),
    openChannel: (channelKey = 'general') => {
      state.selectedChannel = channelKey;
      navigateView('team');
      state.snapshot = null;
      window.setTimeout(loadSnapshot, 100);
    },
    unreadCount: () => Number(state.snapshot?.summary?.total_unread || 0),
    snapshot: () => state.snapshot
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
