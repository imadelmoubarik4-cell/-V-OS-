// Home — #home (docs/design/Atlas_Experience_Redesign.md §7.1): in ten
// seconds, is today under control and what needs me.
//
// Renders into #dashboard-view (the shell's internal Home view) as the one
// Home section ('home', order 0). Everything shown is real Atlas data:
//   context line   AtlasVenueClock (saved hours only; "not set" is said)
//   Needs attention AtlasShell.home.rows() — every module contributes rows
//   Today's briefing composed from the same facts, with its sources named
//   Tonight        the Shifts snapshot for today's business date
//   Opening and closing  AtlasVenueClock.timeline() + the server checklists
//   At a glance    AtlasStockTruth / AtlasRecipes / AtlasOperations rules
// Reservations, events and sales have no source yet and are not shown
// (spec §11 decision 8). Viewers see the attention rows only.
//
// Also owns the notifications feed items that are not Home rows: one item per
// Messages conversation with unread messages (spec §4.9, §7.16).
(function () {
  'use strict';

  const WRITE_ROLES = ['admin', 'manager', 'bartender'];
  const MANAGER_ROLES = ['admin', 'manager'];
  const VISIBLE_ROWS = 5;
  const MESSAGES_REFRESH_MS = 20000;
  const SHIFTS_REFRESH_MS = 5 * 60000;

  const state = {
    root: null,
    renderQueued: false,
    tick: null,
    checkedAt: null,
    shifts: { status: 'idle', key: null, week: null, next: null, fetchedAt: 0, inflight: null },
    messages: { channels: [], fetchedAt: 0, inflight: null, total: null },
    dataErrors: new Set(),
    intelligenceRequested: false,
    registered: false
  };

  // ---------- helpers ----------

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function icon(name) {
    return `<i data-lucide="${escape(name)}" aria-hidden="true"></i>`;
  }

  function shell() { return window.AtlasShell || null; }
  function clock() { return window.AtlasVenueClock || null; }

  function role() {
    return shell()?.profile?.()?.role || null;
  }

  function profileId() {
    return shell()?.profile?.()?.id || null;
  }

  function isManager() { return MANAGER_ROLES.includes(role()); }
  function isViewer() { return role() === 'viewer'; }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function list(names, max = 2) {
    const shown = names.slice(0, max);
    if (names.length > max) return `${shown.join(', ')} and ${names.length - max} more`;
    if (shown.length < 2) return shown.join('');
    return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  }

  function items() {
    const value = window.AtlasData?.items?.();
    return Array.isArray(value) ? value : (Array.isArray(globalThis.items) ? globalThis.items : []);
  }

  function recipes() {
    const value = window.AtlasData?.recipes?.();
    return Array.isArray(value) ? value : (Array.isArray(globalThis.recipes) ? globalThis.recipes : []);
  }

  function dataLoaded() {
    return Boolean(shell()?.dataLoadedAt?.());
  }

  function duration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} min`;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }

  // ---------- canonical facts (stock, recipes, purchasing) ----------

  // Live stock only (inactive rows are records, not stock). Unknown stays
  // unknown: an item without a verified count is never "healthy".
  function stockFacts() {
    const truth = window.AtlasStockTruth;
    const active = items().filter((item) => item.active !== false);
    const known = truth ? active.filter((item) => truth.known(item)) : [];
    const below = truth ? known.filter((item) => truth.belowPar(item)) : [];
    const out = below.filter((item) => number(item.verified_quantity ?? item.quantity, 0) <= 0);
    const baselines = known.map((item) => number(item.stock_baseline_at, NaN)).filter(Number.isFinite);
    return {
      active: active.length,
      known: known.length,
      unknown: active.length - known.length,
      below,
      out,
      lastCount: baselines.length ? Math.max(...baselines) : null
    };
  }

  function recipeFacts() {
    const rules = window.AtlasRecipes;
    const active = recipes().filter((recipe) => recipe.active !== false);
    if (!rules?.recipeAvailability) return { active: active.length, unavailable: [], attention: [], known: false };
    const entries = active.map((recipe) => ({ recipe, availability: rules.recipeAvailability(recipe) }));
    return {
      active: active.length,
      unavailable: entries.filter((entry) => entry.availability.status === 'unavailable'),
      attention: entries.filter((entry) => entry.availability.status === 'attention'),
      unchecked: entries.filter((entry) => !['ready', 'attention', 'unavailable'].includes(entry.availability.status)),
      known: true
    };
  }

  function recipesUsing(itemId) {
    return recipes().filter((recipe) => recipe.active !== false
      && (recipe.recipe_ingredients || []).some((ingredient) => String(ingredient.item_id) === String(itemId)))
      .map((recipe) => recipe.name);
  }

  function purchasingFacts() {
    const suggestions = window.AtlasOperations?.orderSuggestions?.();
    if (!Array.isArray(suggestions)) return null;
    const open = suggestions.filter((entry) => !entry.ordered);
    return { toOrder: open, suppliers: [...new Set(open.map((entry) => entry.supplier))] };
  }

  function operations() {
    return window.AtlasOperations?.today?.() || null;
  }

  // ---------- attention contributions ----------
  //
  // Home renders AtlasShell.home.rows(). Inventory ('inventory',
  // atlas-inventory.js), Stock count ('stock-count'), Purchasing ('purchasing'),
  // Recipes ('recipes') and Data ('data') contribute their own rows.

  // Recipes (recipes.js) contributes a row per unservable recipe. When an
  // out-of-stock row above already names the recipe, Home hides the repeat.
  function recipesExplainedByOutRows() {
    const explained = new Set();
    stockFacts().out.slice(0, 3).forEach((item) => {
      recipes().forEach((recipe) => {
        if (recipe.active !== false && (recipe.recipe_ingredients || []).some((ingredient) => String(ingredient.item_id) === String(item.id))) explained.add(String(recipe.id));
      });
    });
    return explained;
  }

  // A data load that failed (index.html showDataBoundaryError) is one neutral row.
  function dataErrorRows() {
    return [...state.dataErrors].map((label) => ({ id: `error:${label}`, severity: 'info', icon: 'circle-alert', title: `${label} couldn’t be loaded`, detail: 'What you see may be incomplete. Nothing was changed.', action: { label: 'Try again', actionId: 'home.reload' } }));
  }

  // ---------- context line ----------

  function contextLine() {
    const venue = clock();
    const current = venue?.state?.();
    const parts = [];
    if (!venue || !current || current.status === 'loading') {
      parts.push({ dot: 'neutral', text: 'Loading opening hours…' });
    } else if (current.status === 'unavailable') {
      parts.push({ dot: 'neutral', text: 'Opening hours unavailable' });
    } else if (current.status === 'not_set') {
      parts.push({ dot: 'neutral', text: 'Opening hours aren’t set', action: current.canManageHours ? { label: 'Set hours', href: '#settings/hours' } : null, note: current.canManageHours ? '' : 'A manager can add them in Settings.' });
    } else {
      const now = new Date();
      const today = venue.today();
      const ops = operations();
      const opening = ops?.opening;
      const closing = ops?.closing;
      if (venue.isOpenAt(now)) {
        const closes = venue.nextEvent(now, { types: ['closes'] });
        parts.push({ dot: 'positive', text: closes ? `Open · closes at ${closes.time} (in ${duration(closes.at - now)})` : 'Open' });
      } else {
        const opens = venue.nextEvent(now, { types: ['opens'] });
        const win = venue.dayWindow(today);
        if (opens && opens.businessDate === today) {
          const progress = opening?.progress;
          const checks = opening?.status === 'completed' ? 'opening checklist done'
            : number(progress?.completed) > 0 ? 'opening checks in progress' : '';
          parts.push({ dot: 'warning', text: `Opens at ${opens.time}${checks ? ` · ${checks}` : ''}` });
        } else if (win.state === 'open') {
          const done = closing?.status === 'completed' && closing.completed_at ? `closing checklist done at ${venue.formatTime(closing.completed_at)}` : '';
          parts.push({ dot: 'neutral', text: `Closed${done ? ` · ${done}` : ''}` });
        } else {
          parts.push({ dot: 'neutral', text: opens ? `Closed today · opens ${venue.formatDate(opens.at)} at ${opens.time}` : 'Closed today' });
        }
      }
    }
    const tonight = tonightShifts();
    if (tonight && tonight.rows.length) parts.push({ icon: 'users', text: `${tonight.rows.length} on shift tonight` });
    return parts;
  }

  // ---------- shifts ----------

  function shiftsEndpoint() {
    return String(window.VABAR_CONFIG?.SHIFTS_API || '').trim();
  }

  async function accessToken() {
    const client = window.atlasSupabase;
    if (!client?.auth) return null;
    try { return (await client.auth.getSession())?.data?.session?.access_token || null; } catch { return null; }
  }

  async function getJson(base, params) {
    const token = await accessToken();
    if (!base || !token) return null;
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url, { cache: 'no-store', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error('request failed');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadShifts(force = false) {
    const venue = clock();
    const current = state.shifts;
    if (!venue || !shiftsEndpoint() || current.inflight || !profileId()) return;
    const today = venue.today();
    const weekStart = venue.startOfWeek(today);
    const key = `${weekStart}|${profileId()}`;
    if (!force && current.key === key && current.status === 'ready' && Date.now() - current.fetchedAt < SHIFTS_REFRESH_MS) return;
    current.status = current.status === 'ready' && current.key === key ? 'ready' : 'loading';
    current.inflight = (async () => {
      try {
        const payload = await getJson(shiftsEndpoint(), { action: 'snapshot', week_start: weekStart });
        current.week = payload?.workspace || null;
        current.next = null;
        // A bartender's next shift may be next week.
        if (!isManager() && !nextShift(current.week, today)) {
          try {
            const next = await getJson(shiftsEndpoint(), { action: 'snapshot', week_start: venue.addDays(weekStart, 7) });
            current.next = next?.workspace || null;
          } catch { current.next = null; }
        }
        current.status = 'ready';
        current.key = key;
        current.fetchedAt = Date.now();
      } catch {
        current.status = 'error';
      } finally {
        current.inflight = null;
        queueRender();
      }
    })();
  }

  function peopleIndex(workspace) {
    return new Map((Array.isArray(workspace?.people) ? workspace.people : []).map((person) => [String(person.id), person]));
  }

  function shiftDate(shift) {
    return String(shift?.starts_local || '').slice(0, 10);
  }

  function shiftTime(value) {
    return String(value || '').slice(11, 16);
  }

  function tonightShifts() {
    const venue = clock();
    const current = state.shifts;
    if (current.status !== 'ready' || !venue) return current.status === 'error' ? { error: true, rows: [] } : null;
    const today = venue.today();
    const people = peopleIndex(current.week);
    const rows = (Array.isArray(current.week?.shifts) ? current.week.shifts : [])
      .filter((shift) => shiftDate(shift) === today && shift.status !== 'cancelled')
      .sort((a, b) => String(a.starts_local).localeCompare(String(b.starts_local)))
      .map((shift) => {
        const person = people.get(String(shift.person_id)) || { display_name: shift.person_name || 'Team member' };
        return {
          id: shift.id,
          name: person.display_name || 'Team member',
          role: shift.role_name || person.default_role || '',
          note: shift.note || '',
          time: `${shiftTime(shift.starts_local)}–${shiftTime(shift.ends_local)}`,
          mine: Boolean(profileId()) && String(person.profile_id) === String(profileId())
        };
      });
    return { rows, published: current.week?.week?.status === 'published', error: false };
  }

  function nextShift(workspace, today) {
    if (!workspace) return null;
    const people = peopleIndex(workspace);
    const mine = (Array.isArray(workspace.shifts) ? workspace.shifts : []).filter((shift) => {
      const person = people.get(String(shift.person_id));
      return person && profileId() && String(person.profile_id) === String(profileId()) && shiftDate(shift) >= today && shift.status !== 'cancelled';
    }).sort((a, b) => String(a.starts_local).localeCompare(String(b.starts_local)));
    return mine[0] || null;
  }

  // ---------- Decisions ledger refresh ----------
  //
  // The decision memory (Atlas AI › Decisions) is fed by the manager-only
  // intelligence refresh that the retired Brain page ran once per visit. Home
  // runs it once per session for managers, in the background.
  function refreshIntelligence() {
    if (state.intelligenceRequested || !isManager()) return;
    const base = String(window.VABAR_CONFIG?.PHASE3_INTELLIGENCE_API || '').trim();
    if (!base) return;
    state.intelligenceRequested = true;
    accessToken().then((token) => {
      if (!token) { state.intelligenceRequested = false; return; }
      const url = new URL(base);
      url.searchParams.set('action', 'refresh');
      return fetch(url, { method: 'POST', cache: 'no-store', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
    }).catch(() => { /* the ledger keeps its last refresh */ });
  }

  // ---------- messages (notifications feed) ----------

  function messagesEndpoint() {
    return String(window.VABAR_CONFIG?.TEAM_MESSAGES_API || '').trim();
  }

  function channelsFromSnapshot(snapshot) {
    return Array.isArray(snapshot?.channels) ? snapshot.channels : [];
  }

  // Per-conversation unread from AtlasTeamUnreadBadge.conversations() or the
  // 'messages:unread' event, in the channel shape messageItems() reads.
  function applyConversations(list) {
    state.messages.channels = (Array.isArray(list) ? list : []).map((entry) => ({
      key: entry.id,
      name: entry.name,
      unread_count: entry.unread,
      last_message: entry.lastMessage ? { id: entry.lastMessage.id, sender_label: entry.lastMessage.sender, body: entry.lastMessage.body, deleted: entry.lastMessage.deleted, created_at: entry.lastMessageAt } : (entry.lastMessageAt ? { created_at: entry.lastMessageAt } : null)
    }));
    state.messages.fetchedAt = Date.now();
    shell()?.emit?.('notify:changed', { source: 'messages-feed' });
  }

  async function loadMessages(force = false) {
    const current = state.messages;
    if (current.inflight || !messagesEndpoint() || !profileId()) return;
    const open = window.AtlasTeamMessages?.snapshot?.();
    if (open && Array.isArray(open.channels)) {
      current.channels = channelsFromSnapshot(open);
      current.fetchedAt = Date.now();
      shell()?.emit?.('notify:changed', { source: 'messages-feed' });
      return;
    }
    // The unread worker (team-unread-badge.js) already polls the snapshot; reuse it.
    const badge = window.AtlasTeamUnreadBadge;
    if (badge?.loaded?.() && typeof badge.conversations === 'function') {
      applyConversations(badge.conversations());
      return;
    }
    if (!force && Date.now() - current.fetchedAt < MESSAGES_REFRESH_MS) return;
    current.inflight = (async () => {
      try {
        const payload = await getJson(messagesEndpoint(), { action: 'snapshot', channel: 'general', limit: 1 });
        current.channels = channelsFromSnapshot(payload?.snapshot);
        current.fetchedAt = Date.now();
      } catch {
        // Keep the last list; the unread badge still shows the total.
      } finally {
        current.inflight = null;
        shell()?.emit?.('notify:changed', { source: 'messages-feed' });
      }
    })();
  }

  // One item per conversation with unread messages (spec §4.9).
  function messageItems() {
    return state.messages.channels
      .filter((channel) => number(channel.unread_count) > 0)
      .map((channel) => {
        const unread = number(channel.unread_count);
        const last = channel.last_message || null;
        const name = channel.name || 'Messages';
        const title = unread === 1 && last?.sender_label ? `${last.sender_label} in ${name}` : `${unread} new messages in ${name}`;
        return {
          id: `messages:${channel.key}:${last?.id || unread}`,
          type: 'message',
          icon: 'messages-square',
          title,
          detail: last && !last.deleted ? String(last.body || '').slice(0, 140) : '',
          time: last?.created_at || null,
          needsAction: false,
          action: { label: 'Open', route: `#messages/${encodeURIComponent(channel.key)}` }
        };
      });
  }

  // ---------- markup ----------

  function greeting() {
    const hour = clock()?.parts?.()?.hour;
    const name = String(window.atlasGreetingName || '').trim();
    const base = !Number.isFinite(hour) ? 'Hello' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return name ? `${base}, ${name}` : base;
  }

  function headAction() {
    if (isViewer()) return '';
    const ops = operations();
    if (!ops || ops.status !== 'ready' || !ops.canWrite) return '';
    const venue = clock();
    const next = venue?.nextEvent?.(new Date(), { types: ['last_orders', 'closes'] });
    const afterLastOrders = Boolean(next && next.type === 'closes' && next.businessDate === venue.today());
    const target = afterLastOrders ? ops.closing : ops.opening;
    if (!target || ['completed', 'skipped'].includes(target.status)) return '';
    return `<a class="atlas-btn atlas-btn--secondary" href="#operations/${encodeURIComponent(target.id)}">${icon('list-checks')}${afterLastOrders ? 'Closing checklist' : 'Opening checklist'}</a>`;
  }

  function headMarkup() {
    const date = clock()?.formatDate?.(new Date(), { long: true }) || '';
    const context = contextLine().map((part) => `<span class="home-context__part">${part.dot ? `<i class="home-dot home-dot--${part.dot}" aria-hidden="true"></i>` : ''}${part.icon ? icon(part.icon) : ''}${escape(part.text)}${part.action ? ` <a class="home-context__link" href="${escape(part.action.href)}">${escape(part.action.label)}</a>` : ''}${part.note ? ` <span class="home-context__note">${escape(part.note)}</span>` : ''}</span>`).join('');
    const action = headAction();
    return `<header class="home-head">
      <div class="home-head__text">
        <p class="home-date">${escape(date)}</p>
        <h1 class="home-greeting">${escape(greeting())}</h1>
        <p class="home-context">${context}</p>
      </div>
      ${action ? `<div class="home-head__actions">${action}</div>` : ''}
    </header>`;
  }

  function rowsForRole() {
    const rows = shell()?.home?.rows?.({ role: role() }) || [];
    const explained = recipesExplainedByOutRows();
    return rows.filter((row) => {
      const match = row.source === 'recipes' && /^recipes:unavailable:(.+)$/.exec(String(row.id));
      return !(match && explained.has(match[1]));
    });
  }

  function attentionMarkup() {
    if (!dataLoaded()) {
      return `<section class="atlas-section home-attention" aria-labelledby="home-attention-title" aria-busy="true">
        <div class="atlas-section__head"><h2 class="atlas-section__title" id="home-attention-title">Needs attention</h2></div>
        <ul class="atlas-list atlas-card">${'<li class="atlas-row"><span class="atlas-skel atlas-skel--circle"></span><div class="atlas-row__body"><span class="atlas-skel atlas-skel--text home-skel-title"></span><span class="atlas-skel atlas-skel--text home-skel-meta"></span></div></li>'.repeat(4)}</ul>
        <span class="sr-only">Checking what needs attention</span>
      </section>`;
    }
    const rows = rowsForRole();
    state.checkedAt = new Date();
    const count = rows.length;
    const body = count
      ? rows.slice(0, VISIBLE_ROWS).map((row, index) => rowMarkup(row, index)).join('')
      : `<li class="atlas-row"><span class="atlas-row__icon atlas-row__icon--positive">${icon('circle-check')}</span><div class="atlas-row__body"><p class="atlas-row__title">Nothing needs you right now</p><p class="atlas-row__meta">Last checked ${escape(clock()?.formatTime?.(state.checkedAt) || '')}</p></div></li>`;
    return `<section class="atlas-section home-attention" aria-labelledby="home-attention-title">
      <div class="atlas-section__head">
        <h2 class="atlas-section__title" id="home-attention-title">Needs attention${count ? ` <span class="atlas-badge atlas-badge--muted">${count}</span>` : ''}</h2>
        ${count ? '<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm home-attention__all" data-home-view-all>View all</button>' : ''}
      </div>
      <ul class="atlas-list atlas-card" data-home-rows>${body}</ul>
    </section>`;
  }

  function rowMarkup(row, index) {
    const tone = ['danger', 'warning', 'info', 'positive'].includes(row.severity) ? row.severity : 'info';
    const action = row.action?.label ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-home-row="${index}">${escape(row.action.label)}</button>` : '';
    return `<li class="atlas-row home-row">
      <span class="atlas-row__icon atlas-row__icon--${tone}">${icon(row.icon || 'circle-alert')}</span>
      <div class="atlas-row__body">
        <button type="button" class="home-row__open" data-home-row="${index}"${row.action?.label ? ` aria-label="${escape(`${row.title}. ${row.action.label}`)}"` : ''}>${escape(row.title)}</button>
        ${row.detail ? `<p class="atlas-row__meta">${escape(row.detail)}</p>` : ''}
      </div>
      <div class="atlas-row__end">${action}<span class="atlas-row__chevron">${icon('chevron-right')}</span></div>
    </li>`;
  }

  function briefingFacts() {
    const facts = { lines: [], sources: new Set() };
    const venue = clock();
    const venueState = venue?.state?.();
    const staffView = !isManager();
    // Service and people.
    const service = [];
    if (venueState?.status === 'ready') {
      facts.sources.add('opening hours');
      const now = new Date();
      if (venue.isOpenAt(now)) {
        const closes = venue.nextEvent(now, { types: ['closes'] });
        service.push(closes ? `You’re open until ${closes.time}.` : 'You’re open.');
      } else {
        const opens = venue.nextEvent(now, { types: ['opens'] });
        if (opens && opens.businessDate === venue.today()) service.push(`You open at ${opens.time}.`);
        else service.push('You’re closed for the rest of today.');
      }
    } else if (venueState?.status === 'not_set') {
      service.push('Opening hours aren’t set, so Atlas can’t plan around service times.');
    }
    const tonight = tonightShifts();
    if (tonight && !tonight.error) {
      facts.sources.add('shifts');
      if (tonight.rows.length) {
        service.push(`${plural(tonight.rows.length, 'person is', 'people are')} on tonight: ${list(tonight.rows.map((row) => row.name.split(/\s+/)[0]), 4)}.`);
      } else {
        service.push('No shifts are published for tonight yet.');
      }
    }
    const ops = operations();
    if (ops?.status === 'ready') {
      facts.sources.add('checklists');
      const opening = ops.opening;
      if (opening && opening.status !== 'completed') {
        const done = number(opening.progress?.completed);
        const total = number(opening.progress?.required);
        service.push(done ? `The opening checklist is ${done} of ${total} done.` : 'The opening checklist hasn’t been started.');
      }
    }
    if (service.length) facts.lines.push(service.join(' '));
    // Stock, recipes and orders.
    const risks = [];
    if (dataLoaded()) {
      const stock = stockFacts();
      if (stock.active) {
        facts.sources.add('stock counts');
        if (!stock.known) risks.push('Stock hasn’t been counted yet, so Atlas can’t tell what’s low.');
        else if (stock.out.length) risks.push(`${list(stock.out.map((item) => item.name))} ${stock.out.length === 1 ? 'is' : 'are'} out${stock.below.length > stock.out.length ? ` and ${plural(stock.below.length - stock.out.length, 'more item is', 'more items are')} below par` : ''}.`);
        else if (stock.below.length) risks.push(`${list(stock.below.map((item) => item.name))} ${stock.below.length === 1 ? 'is' : 'are'} below par.`);
        else risks.push(stock.unknown ? `Nothing counted is below par; ${plural(stock.unknown, 'item hasn’t', 'items haven’t')} been counted.` : 'Nothing counted is below par.');
      }
      const recipeInfo = recipeFacts();
      if (recipeInfo.known && recipeInfo.active) {
        facts.sources.add('recipes');
        if (recipeInfo.unavailable.length) risks.push(`${list(recipeInfo.unavailable.map((entry) => entry.recipe.name))} can’t be served right now.`);
      }
      if (!staffView) {
        const purchasing = purchasingFacts();
        if (purchasing && purchasing.toOrder.length) {
          facts.sources.add('orders');
          risks.push(`${plural(purchasing.toOrder.length, 'item is', 'items are')} ready to order${purchasing.suppliers.length ? ` from ${list(purchasing.suppliers)}` : ''}.`);
        }
      }
    }
    if (risks.length) facts.lines.push(risks.join(' '));
    return facts;
  }

  function sourcesLabel(sources) {
    const names = [...sources];
    if (!names.length) return '';
    if (names.length === 1) return `From ${names[0]}`;
    return `From ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }

  function briefingMarkup() {
    if (isViewer()) return '';
    const facts = briefingFacts();
    const updated = clock()?.formatTime?.(new Date()) || '';
    const text = facts.lines.length
      ? facts.lines.slice(0, 2).map((line) => `<p>${escape(line)}</p>`).join('')
      : `<p class="home-briefing__muted">${dataLoaded() ? 'Today’s briefing isn’t available yet.' : 'Preparing today’s briefing…'}</p>`;
    return `<section class="atlas-card home-briefing" aria-labelledby="home-briefing-title">
      <div class="home-briefing__head">${icon('sparkles')}<h2 id="home-briefing-title">Today’s briefing</h2>${facts.lines.length && updated ? `<span class="home-briefing__time">Updated ${escape(updated)}</span>` : ''}</div>
      <div class="home-briefing__text">${text}</div>
      <div class="home-briefing__foot">
        ${facts.sources.size ? `<span class="home-briefing__sources">${icon('check')}${escape(sourcesLabel(facts.sources))}</span>` : '<span></span>'}
        <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-home-ask>Ask a follow-up${icon('arrow-right')}</button>
      </div>
    </section>`;
  }

  // The Stock block of "At a glance". With no verified count the value is
  // "Not counted" — never "0 below par" or "healthy" (S88 truth rule).
  function stockGlance(loaded = dataLoaded()) {
    const stock = stockFacts();
    let value; let unit = ''; let detail;
    if (!loaded) { value = '—'; detail = 'Loading stock'; }
    else if (!stock.active) { value = '—'; detail = 'No items yet'; }
    else if (!stock.known) { value = 'Not counted'; detail = 'No verified count yet'; }
    else {
      value = String(stock.below.length);
      unit = 'below par';
      const parts = [];
      if (stock.out.length) parts.push(`${stock.out.length} out`);
      if (stock.unknown) parts.push(`${stock.unknown} not counted`);
      const counted = stock.lastCount ? clock()?.formatDate?.(new Date(stock.lastCount)) : '';
      if (counted) parts.push(`last count ${counted}`);
      detail = parts.join(' · ') || 'Counted items are at or above par';
    }
    return { href: stock.known ? '#inventory?filter=below-par' : '#inventory', icon: 'package', label: 'Stock', value, unit, detail, link: 'View inventory', text: value === 'Not counted' };
  }

  function glanceMarkup() {
    if (isViewer()) return '';
    const blocks = [];
    const loaded = dataLoaded();
    // Stock
    blocks.push(stockGlance(loaded));
    // Recipes
    const recipeInfo = recipeFacts();
    let recipeValue; let recipeUnit = ''; let recipeDetail;
    if (!loaded || !recipeInfo.known) { recipeValue = '—'; recipeDetail = loaded ? 'Availability unavailable' : 'Loading recipes'; }
    else if (!recipeInfo.active) { recipeValue = '—'; recipeDetail = 'No recipes yet'; }
    else {
      recipeValue = String(recipeInfo.unavailable.length);
      recipeUnit = 'unavailable';
      recipeDetail = recipeInfo.unavailable.length ? list(recipeInfo.unavailable.map((entry) => entry.recipe.name))
        : recipeInfo.unchecked.length ? `${plural(recipeInfo.unchecked.length, 'recipe', 'recipes')} can’t be checked yet`
          : `All ${plural(recipeInfo.active, 'recipe', 'recipes')} can be served`;
    }
    blocks.push({ href: '#recipes', icon: 'martini', label: 'Recipes', value: recipeValue, unit: recipeUnit, detail: recipeDetail, link: 'View recipes' });
    if (isManager()) {
      const purchasing = loaded ? purchasingFacts() : null;
      blocks.push(purchasing
        ? { href: '#purchasing', icon: 'truck', label: 'Purchasing', value: String(purchasing.toOrder.length), unit: 'to order', detail: purchasing.toOrder.length ? list(purchasing.suppliers) : 'Nothing below par to order', link: 'View orders' }
        : { href: '#purchasing', icon: 'truck', label: 'Purchasing', value: '—', unit: '', detail: loaded ? 'Order suggestions unavailable' : 'Loading orders', link: 'View orders' });
    } else {
      const venue = clock();
      const shift = state.shifts.status === 'ready' && venue ? (nextShift(state.shifts.week, venue.today()) || nextShift(state.shifts.next, venue.today())) : null;
      blocks.push(shift
        ? { href: '#shifts', icon: 'calendar-days', label: 'My next shift', value: shiftDate(shift) === venue.today() ? 'Today' : venue.formatDate(shiftDate(shift)), unit: '', detail: `${shiftTime(shift.starts_local)}–${shiftTime(shift.ends_local)}${shift.role_name ? ` · ${shift.role_name}` : ''}`, link: 'View shifts', text: true }
        : { href: '#shifts', icon: 'calendar-days', label: 'My next shift', value: '—', unit: '', detail: state.shifts.status === 'ready' ? 'No shifts published for you' : state.shifts.status === 'error' ? 'Shifts couldn’t be loaded' : 'Loading shifts', link: 'View shifts' });
    }
    return `<section class="home-glance" aria-label="At a glance">${blocks.map((block) => `<a class="home-glance__item" href="${escape(block.href)}">
      <span class="home-glance__label">${icon(block.icon)}${escape(block.label)}</span>
      <span class="home-glance__value${block.text ? ' home-glance__value--text' : ''}">${escape(block.value)}${block.unit ? `<small>${escape(block.unit)}</small>` : ''}</span>
      <span class="home-glance__detail">${escape(block.detail)}</span>
      <span class="home-glance__link">${escape(block.link)}${icon('arrow-right')}</span>
    </a>`).join('')}</section>`;
  }

  function tonightMarkup() {
    if (isViewer()) return '';
    const tonight = tonightShifts();
    let body;
    if (!tonight) body = '<div class="home-staff" aria-busy="true"><span class="atlas-skel atlas-skel--text"></span><span class="atlas-skel atlas-skel--text"></span></div>';
    else if (tonight.error) body = '<p class="home-muted">Shifts couldn’t be loaded. <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-home-shifts-retry>Try again</button></p>';
    else if (!tonight.rows.length) body = `<p class="home-muted">No shifts published for tonight.</p>${isManager() ? '<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#shifts">Open Shifts</a>' : ''}`;
    else {
      body = `<ul class="home-staff">${tonight.rows.map((row) => {
        const initials = row.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || '·';
        return `<li class="home-staff__row${row.mine ? ' is-mine' : ''}"><span class="atlas-avatar atlas-avatar--sm" aria-hidden="true">${escape(initials)}</span><span class="home-staff__who"><span class="home-staff__name">${escape(row.name)}${row.mine ? ' <span class="atlas-pill atlas-pill--info atlas-pill--plain">You</span>' : ''}</span>${row.role || row.note ? `<span class="home-staff__role">${escape([row.role, row.note].filter(Boolean).join(' · '))}</span>` : ''}</span><span class="home-staff__time">${escape(row.time)}</span></li>`;
      }).join('')}</ul>${!tonight.published && isManager() ? '<p class="home-muted">This week isn’t published yet.</p>' : ''}`;
    }
    return `<section class="home-col" aria-labelledby="home-tonight-title">
      <div class="home-col__head"><h2 id="home-tonight-title">Tonight</h2><a class="atlas-section__link" href="#shifts">Shifts</a></div>
      ${body}
    </section>`;
  }

  function timelineMarkup() {
    if (isViewer()) return '';
    const venue = clock();
    const current = venue?.state?.();
    let body;
    if (!venue || !current || current.status === 'loading') body = '<p class="home-muted" data-venue-clock-state="loading">Loading opening hours…</p>';
    else if (current.status === 'unavailable') body = '<p class="home-muted" data-venue-clock-state="unavailable">Opening hours unavailable. Atlas couldn’t read the venue’s saved hours.</p>';
    else if (current.status === 'not_set') {
      body = `<p class="home-muted" data-venue-clock-state="not_set">Opening hours not set.${current.canManageHours ? ' <a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#settings/hours" data-venue-hours-settings>Set opening hours</a>' : ' A manager can add them in Settings.'}</p>`;
    } else {
      const now = new Date();
      const entries = venue.timeline(venue.today(), now);
      if (!entries.length) {
        const next = venue.nextEvent(now, { types: ['opens'] });
        body = `<p class="home-muted" data-venue-clock-state="closed">Closed today.${next ? ` Next opening ${escape(venue.formatDate(next.at))}, ${escape(next.time)}.` : ''}</p>`;
      } else {
        const ops = operations();
        const checklist = (routine, label) => {
          if (!routine) return '';
          const done = number(routine.progress?.completed);
          const total = number(routine.progress?.required);
          const text = routine.status === 'completed' ? `${label} done${routine.completed_by_label ? ` · ${routine.completed_by_label}` : ''}` : `${label} ${done} of ${total} done`;
          return `<a class="home-timeline__check" href="#operations/${encodeURIComponent(routine.id)}">${escape(text)}</a>`;
        };
        const rowClass = { past: 'is-done', current: 'is-now', future: '' };
        body = `<ol class="home-timeline">${entries.map((entry) => {
          const extra = entry.kind === 'opens' ? checklist(ops?.opening, 'Opening checklist') : entry.kind === 'closes' ? checklist(ops?.closing, 'Closing checklist') : '';
          return `<li class="home-timeline__row ${rowClass[entry.status] || ''}"><time>${escape(entry.time)}</time><span class="home-timeline__mark" aria-hidden="true"></span><span class="home-timeline__label">${escape(entry.title)}${entry.kind === 'offer' && entry.detail ? `<small>${escape(entry.detail)}</small>` : ''}${extra}</span></li>`;
        }).join('')}</ol>`;
      }
    }
    return `<section class="home-col" aria-labelledby="home-hours-title">
      <div class="home-col__head"><h2 id="home-hours-title">Opening and closing</h2></div>
      <div id="home-timeline">${body}</div>
    </section>`;
  }

  function render() {
    const root = ensureRoot();
    if (!root) return;
    if (root.style.display === 'none' && shell()?.current?.() !== 'dashboard') return;
    const focused = document.activeElement && root.contains(document.activeElement) ? focusSelector(document.activeElement) : null;
    const viewer = isViewer();
    root.innerHTML = `<div class="home${viewer ? ' home--viewer' : ''}">
      ${headMarkup()}
      ${attentionMarkup()}
      ${viewer ? '' : `<div class="home-grid">
        <div class="home-grid__main">${briefingMarkup()}${glanceMarkup()}</div>
        <div class="home-grid__side">${tonightMarkup()}${timelineMarkup()}</div>
      </div>`}
    </div>`;
    if (focused) root.querySelector(focused)?.focus();
    window.lucide?.createIcons?.();
  }

  function focusSelector(element) {
    if (element.dataset.homeRow != null) return `${element.classList.contains('home-row__open') ? '.home-row__open' : '.atlas-btn'}[data-home-row="${CSS.escape(element.dataset.homeRow)}"]`;
    if (element.hasAttribute('data-home-ask')) return '[data-home-ask]';
    if (element.hasAttribute('data-home-view-all')) return '[data-home-view-all]';
    return null;
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    const run = () => { state.renderQueued = false; if (homeVisible()) render(); };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else window.setTimeout(run, 0);
  }

  function homeVisible() {
    return shell()?.current?.() === 'dashboard' && state.root && state.root.style.display !== 'none';
  }

  // ---------- events ----------

  function runRow(index) {
    const row = rowsForRole()[Number(index)];
    const action = row?.action;
    if (!action) return;
    if (action.actionId) {
      shell()?.actions?.run?.(action.actionId, { context: 'home', role: role(), record: action.record || null })
        .catch((error) => console.error('Home action failed', error));
    } else if (action.route) {
      shell()?.navigate?.(action.route);
    }
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !state.root?.contains(target)) return;
    const row = target.closest('[data-home-row]');
    if (row) { runRow(row.dataset.homeRow); return; }
    if (target.closest('[data-home-view-all]')) {
      shell()?.notify?.open?.({ filter: 'needs-action', trigger: target.closest('[data-home-view-all]') });
      return;
    }
    if (target.closest('[data-home-ask]')) {
      const date = clock()?.today?.() || '';
      if (window.AtlasAI?.askAbout) window.AtlasAI.askAbout({ type: 'briefing', id: date, label: 'Today’s briefing' });
      else shell()?.navigate?.(`#ai/new?context=briefing:${encodeURIComponent(date)}`);
      return;
    }
    if (target.closest('[data-home-shifts-retry]')) { loadShifts(true); queueRender(); }
  }

  function startTicking() {
    stopTicking();
    // The context line counts minutes ("closes in 2 h 20 min"): refresh once a minute while Home is open.
    state.tick = window.setInterval(() => { if (homeVisible()) render(); else stopTicking(); }, 60000);
  }

  function stopTicking() {
    if (state.tick) window.clearInterval(state.tick);
    state.tick = null;
  }

  function ensureRoot() {
    if (state.root && state.root.isConnected) return state.root;
    state.root = document.getElementById('dashboard-view');
    return state.root;
  }

  function register() {
    const atlas = shell();
    if (!atlas || state.registered) return;
    state.registered = true;
    atlas.registerHomeSection('home', render, 0);
    // 'data' belongs to the Data workspace (pending approvals); load errors use their own key.
    atlas.home.contribute('load-errors', { focusRows: dataErrorRows, order: 90 });
    atlas.notify.contribute('messages', messageItems);
    atlas.actions.register({
      id: 'home.reload', label: 'Reload data', icon: 'refresh-cw', keywords: ['refresh', 'reload'],
      run: () => { state.dataErrors.clear(); if (typeof window.atlasReloadPurchasingData === 'function') return window.atlasReloadPurchasingData().then(() => atlas.dataLoaded({ online: navigator.onLine })); return null; }
    });
    // Team Messages recommendation links open Atlas AI › Decisions (Brain retired).
    atlas.links?.register?.('brain_recommendation', () => { atlas.navigate('#ai/decisions'); return true; });
    atlas.onView('dashboard', {
      show: () => { loadShifts(); refreshIntelligence(); startTicking(); },
      hide: stopTicking
    });
    atlas.onDataLoaded(() => queueRender());
    atlas.on('data:error', (detail) => { if (detail?.source) state.dataErrors.add(String(detail.source)); atlas.emit('notify:changed', { source: 'home:load-errors' }); queueRender(); });
    atlas.on('profile:ready', (profile) => {
      if (!profile?.id) return;
      loadShifts(true);
      loadMessages(true);
      queueRender();
    });
    // Messages and its unread worker announce every per-conversation change.
    atlas.on('messages:unread', (detail) => { if (Array.isArray(detail?.conversations)) applyConversations(detail.conversations); });
    atlas.on('notify:changed', (detail) => {
      if (detail?.source === 'messages') loadMessages(true);
      if (detail?.source !== 'messages-feed') queueRender();
    });
    atlas.on('notify:open', () => loadMessages());
    atlas.on('venue-clock:changed', () => { loadShifts(); queueRender(); });
    atlas.on('operations:changed', () => queueRender());
  }

  function init() {
    ensureRoot();
    register();
    document.addEventListener('click', onClick);
    window.addEventListener('atlas:team-summary', () => loadMessages());
  }

  window.AtlasHome = {
    render,
    stockFacts,
    stockGlance,
    recipeFacts,
    briefing: () => briefingFacts().lines,
    rows: rowsForRole,
    messageItems
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
