// Atlas AI workspace (#ai): conversations, streamed answers with progress,
// evidence and linked records, approval cards, photo/file attachments, voice
// notes and live voice, and the manager Decisions ledger (#ai/decisions).
//
// Talks only to atlas-ai (VABAR_CONFIG.ATLAS_AI_API) with the signed-in
// person's session, and to the existing decision-memory endpoint
// (PHASE3_BRAIN_API) for Decisions. Registers with AtlasShell: view 'ai'
// (routes #ai, #ai/c/<id>, #ai/new?context=<type>:<id>, #ai/decisions per
// the spec route table), actions ai.ask / ai.voice / ai.ask.record, link type
// 'ai' and a Home attention contribution for proposals waiting.
//
// Rules this file keeps (docs/design/Atlas_Experience_Redesign.md §6.28, §7.2,
// §8.7, docs/ai/Atlas_AI_Architecture.md §5–§10):
// - never claim a change happened before execute-action says so;
// - approvals are taps on a card, only by a role the proposal allows;
// - the answer text from the `done` event is authoritative;
// - no internal names, JSON or error codes in the interface.
(function (root) {
  'use strict';

  if (root.AtlasAI) return;

  const document = root.document;
  const MANAGER_ROLES = ['admin', 'manager'];
  const OPERATIONAL_ROLES = ['admin', 'manager', 'bartender'];
  const MAX_ATTACHMENTS = 4;
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
  const MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,text/plain,text/csv,.csv,.txt';
  const VOICE_EXPLAINED_KEY = 'atlas.ai.voice.explained.v1';
  const DAY = 86400000;

  // ---------- icons (lucide 0.454.0 paths, inline so streaming never re-scans the DOM) ----------

  const ICONS = {
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    'pin-off': '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
    ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    square: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    'mic-off': '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
    'audio-lines': '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
    'phone-off': '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
    martini: '<path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8Z"/>',
    truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
    'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    'calendar-days': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'messages-square': '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
    'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    'chart-no-axes-column': '<line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    'panel-left': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'wifi-off': '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'
  };

  function icon(name, extraClass = '') {
    const body = ICONS[name] || ICONS.sparkles;
    return `<svg class="icon${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  // ---------- small helpers ----------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function uid(prefix = 'ai') {
    const random = root.crypto?.randomUUID ? root.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}-${random}`.slice(0, 90);
  }

  function role() {
    return root.AtlasShell?.profile?.()?.role || root.atlasCurrentProfile?.role || null;
  }

  function isManager() {
    return MANAGER_ROLES.includes(role());
  }

  function firstName() {
    const profile = root.AtlasShell?.profile?.() || {};
    // The display name only (S87): never an email, never the "Team member" label.
    // The shell profile carries id and role only; sign-in publishes the first
    // name as atlasGreetingName (AtlasIdentity.firstName of the profile).
    if (root.AtlasIdentity) return root.AtlasIdentity.firstName(profile) || String(root.atlasGreetingName || '').trim();
    const fromProfile = profile.display_name || profile.name || '';
    const fromShell = document.getElementById('profile-name')?.textContent || '';
    const candidate = String(fromProfile || fromShell).trim();
    if (!candidate || /team$/i.test(candidate)) return '';
    return candidate.split(/\s+/)[0];
  }

  function reducedMotion() {
    return Boolean(root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) || document.documentElement.classList.contains('atlas-reduce-motion');
  }

  function isPhone() {
    return Boolean(root.matchMedia?.('(max-width: 767px)')?.matches);
  }

  function isCompact() {
    return Boolean(root.matchMedia?.('(max-width: 1023px)')?.matches);
  }

  const VENUE_TZ = 'Atlantic/Reykjavik';
  function fmt(options, value) {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: VENUE_TZ, ...options }).format(value); } catch { return new Intl.DateTimeFormat('en-GB', options).format(value); }
  }
  function dayKey(value) { return fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, value); }
  function timeLabel(value) { return fmt({ hour: '2-digit', minute: '2-digit', hour12: false }, value); }

  // 'Tue 15 Sep' as everywhere in Atlas (ICU en-GB prints 'Sept').
  function shortDate(date) {
    return fmt({ weekday: 'short', day: 'numeric', month: 'short' }, date).replace(',', '').replace(/\bSept\b/, 'Sep');
  }

  function relativeDay(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    if (dayKey(date) === dayKey(now)) return timeLabel(date);
    if (dayKey(date) === dayKey(new Date(now.getTime() - DAY))) return 'Yesterday';
    if (now - date < 6 * DAY) return fmt({ weekday: 'long' }, date);
    return shortDate(date);
  }

  function whenLabel(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes >= 0 && minutes < 60) return minutes <= 1 ? 'Just now' : `${minutes} min ago`;
    return `${relativeDay(date)}${dayKey(date) === dayKey(new Date()) ? '' : ` · ${timeLabel(date)}`}`;
  }

  function expiryLabel(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const time = timeLabel(date);
    if (dayKey(date) === dayKey(now)) return `Expires today at ${time}`;
    if (dayKey(date) === dayKey(new Date(now.getTime() + DAY))) return `Expires tomorrow at ${time}`;
    return `Expires ${shortDate(date)} at ${time}`;
  }

  function durationLabel(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function bytesLabel(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }

  // Internal identifiers never reach the interface: anything that looks like
  // a function or table name is replaced with a neutral phrase.
  function humanText(value, fallback = '') {
    const text = String(value ?? '').trim();
    if (!text) return fallback;
    if (/\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+\.[a-z_]+\(|[{}[\]]/.test(text)) return fallback;
    return text;
  }

  // ---------- SSE parsing (pure; exported for tests) ----------

  function parseEventBlock(raw) {
    let event = 'message';
    const data = [];
    String(raw).split(/\r?\n/).forEach((line) => {
      if (!line || line.startsWith(':')) return;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    });
    if (!data.length) return null;
    const text = data.join('\n');
    try { return { event, data: JSON.parse(text) }; } catch { return { event, data: { text } }; }
  }

  // Splits a growing buffer into complete event blocks; returns the rest.
  function splitEvents(buffer) {
    const events = [];
    let rest = buffer;
    let match = /\r?\n\r?\n/.exec(rest);
    while (match) {
      const parsed = parseEventBlock(rest.slice(0, match.index));
      if (parsed) events.push(parsed);
      rest = rest.slice(match.index + match[0].length);
      match = /\r?\n\r?\n/.exec(rest);
    }
    return { events, rest };
  }

  async function readEventStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitEvents(buffer);
      buffer = split.rest;
      split.events.forEach(onEvent);
    }
    buffer += decoder.decode();
    const tail = splitEvents(`${buffer}\n\n`);
    tail.events.forEach(onEvent);
  }

  // ---------- API ----------

  class AiError extends Error {
    constructor(status, code, message, reason = null) {
      super(message || 'Atlas AI request failed.');
      this.name = 'AiError';
      this.status = status;
      this.code = code || 'failed';
      this.reason = typeof reason === 'string' ? reason : null;
    }
  }

  function endpoint() {
    return String(root.VABAR_CONFIG?.ATLAS_AI_API || '').trim();
  }

  async function accessToken() {
    const client = root.atlasSupabase;
    if (!client?.auth) return null;
    try {
      const { data } = await client.auth.getSession();
      return data?.session?.access_token || null;
    } catch { return null; }
  }

  async function buildUrl(action, params) {
    const base = endpoint();
    if (!base) throw new AiError(503, 'not_configured', 'Atlas AI is not configured');
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    return url;
  }

  async function request(action, { method = 'GET', params = null, body = undefined, form = null, signal = undefined, stream = false } = {}) {
    const url = await buildUrl(action, params);
    const token = await accessToken();
    if (!token) throw new AiError(401, 'unauthorized', 'Sign in again to use Atlas AI.');
    const headers = { authorization: `Bearer ${token}`, accept: stream ? 'text/event-stream' : 'application/json' };
    if (body !== undefined && !form) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await root.fetch(url, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined), signal, cache: 'no-store' });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new AiError(0, 'network', 'Atlas couldn’t be reached.');
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      root.console?.warn?.('[atlas-ai]', action, response.status, payload?.error_code || '', response.headers.get('x-request-id') || '');
      throw new AiError(response.status, payload?.error_code || (response.status === 503 ? 'unavailable' : 'failed'), payload?.message, payload?.reason);
    }
    if (stream) return response;
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }

  // A request that survives page unload (voice-end on pagehide). The access
  // token was read when the call started; nothing is stored.
  function requestOnExit(token, action, body) {
    const base = endpoint();
    if (!base || !token) return;
    const url = new URL(base);
    url.searchParams.set('action', action);
    root.fetch(url, { method: 'POST', keepalive: true, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }

  // Multipart upload with progress (fetch cannot report upload progress).
  function uploadWithProgress(action, form, onProgress, signalHolder) {
    return new Promise((resolve, reject) => {
      Promise.all([buildUrl(action), accessToken()]).then(([url, token]) => {
        if (!token) { reject(new AiError(401, 'unauthorized', 'Sign in again to use Atlas AI.')); return; }
        const xhr = new XMLHttpRequest();
        if (signalHolder) signalHolder.abort = () => xhr.abort();
        xhr.open('POST', url.toString());
        xhr.setRequestHeader('authorization', `Bearer ${token}`);
        xhr.setRequestHeader('accept', 'application/json');
        xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
        xhr.onload = () => {
          let payload = {};
          try { payload = JSON.parse(xhr.responseText || '{}'); } catch { payload = {}; }
          if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
          else {
            root.console?.warn?.('[atlas-ai]', action, xhr.status, payload?.error_code || '');
            reject(new AiError(xhr.status, payload?.error_code || (xhr.status === 503 ? 'unavailable' : 'failed'), payload?.message, payload?.reason));
          }
        };
        xhr.onerror = () => reject(new AiError(0, 'network', 'Atlas couldn’t be reached.'));
        xhr.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        xhr.send(form);
      }).catch(reject);
    });
  }

  // Plain-language failure copy: what failed, what is safe, what to do.
  const FIXED_COPY = {
    rate_limited: 'Atlas is getting a lot of requests from you right now. Wait a minute, then try again.',
    busy: 'Atlas is busy right now. Try again in a moment.',
    timeout: 'Atlas took too long to answer. Try again, or ask a narrower question.',
    too_many_steps: 'That needed too many steps. Try a narrower question.',
    forbidden: 'Your role can’t do this. Ask a manager if it’s needed.',
    conflict: 'This was already handled or has expired. Nothing else was changed.',
    too_large: 'This file is larger than 25 MB.',
    attachments_too_large: 'Photos and PDFs in one message can be up to 20 MB together. Remove one and try again.',
    unsupported_type: 'Atlas can read photos, PDFs, text and CSV files.',
    unauthorized: 'Your session has ended. Sign in again to continue.',
    message_too_long: 'That message is too long. Shorten it and try again.',
    voice_session_inactive: 'This live voice session has ended. Start a new one to continue.',
    not_configured: 'Atlas AI isn’t switched on yet.',
    // A 503 without the server's not_configured code is an outage, not an
    // unconfigured venue (S90, review P2-5).
    unavailable: 'Atlas AI isn’t available right now. Nothing was changed. Try again shortly.'
  };
  const QUOTA_COPY = {
    voice_quota_exceeded: {
      daily_sessions: 'You’ve used today’s live voice sessions. Voice notes and text still work.',
      daily_minutes: 'You’ve used today’s live voice time. Voice notes and text still work.',
      concurrent: 'Live voice is already open in another tab or device. End it there, then try again.',
      default: 'You’ve reached today’s live voice limit. Voice notes and text still work.'
    },
    upload_quota_exceeded: {
      daily_files: 'You’ve reached today’s limit of 100 files for Atlas AI. It resets within 24 hours.',
      daily_bytes: 'You’ve reached today’s upload size limit for Atlas AI. It resets within 24 hours.',
      default: 'You’ve reached today’s upload limit for Atlas AI. It resets within 24 hours.'
    }
  };

  function friendly(error, subject = 'That') {
    const code = error?.code;
    if (QUOTA_COPY[code]) return QUOTA_COPY[code][error?.reason] || QUOTA_COPY[code].default;
    if (FIXED_COPY[code]) return FIXED_COPY[code];
    if (code === 'network') return `${subject} couldn’t reach Atlas. Nothing was changed. Check your connection and try again.`;
    return `${subject} couldn’t be completed. Nothing was changed. Try again.`;
  }

  // ---------- records and routes ----------

  const RECORD_TYPES = {
    inventory_item: { icon: 'package', label: 'Item', route: (id) => `#inventory/item/${encodeURIComponent(id)}` },
    inventory: { icon: 'package', label: 'Inventory', route: () => '#inventory' },
    recipe: { icon: 'martini', label: 'Recipe', route: (id) => `#recipes/${encodeURIComponent(id)}` },
    recipes: { icon: 'martini', label: 'Recipes', route: () => '#recipes' },
    supplier: { icon: 'truck', label: 'Supplier', route: (id) => `#purchasing/suppliers/${encodeURIComponent(id)}` },
    purchase_order: { icon: 'truck', label: 'Order', route: (id) => (id ? `#purchasing/order/${encodeURIComponent(id)}` : '#purchasing') },
    stock_count: { icon: 'list-checks', label: 'Stock count', route: (id) => (id ? `#inventory/counts/${encodeURIComponent(id)}` : '#inventory/counts') },
    par_levels: { icon: 'list-checks', label: 'Par levels', route: () => '#data/pars' },
    data_review: { icon: 'database', label: 'Data issue', route: () => '#data/issues' },
    movement: { icon: 'package', label: 'Movement', route: () => '#inventory/movements' },
    waste: { icon: 'package', label: 'Waste', route: () => '#inventory/waste' },
    shift_week: { icon: 'calendar-days', label: 'Shifts', route: (id) => (id ? `#shifts?week=${encodeURIComponent(id)}` : '#shifts') },
    shift: { icon: 'calendar-days', label: 'Shift', route: () => '#shifts' },
    profile: { icon: 'users', label: 'Team member', route: (id) => `#team/${encodeURIComponent(id)}` },
    team_channel: { icon: 'messages-square', label: 'Messages', route: (id) => (id ? `#messages/${encodeURIComponent(id)}` : '#messages') },
    knowledge_article: { icon: 'book-open', label: 'Article', route: (id) => `#knowledge/${encodeURIComponent(id)}` },
    knowledge: { icon: 'book-open', label: 'Knowledge', route: () => '#knowledge' },
    report: { icon: 'chart-no-axes-column', label: 'Report', route: (id) => `#reports/${encodeURIComponent(id || 'overview')}` },
    routine: { icon: 'list-checks', label: 'Checklist', route: (id) => (id ? `#operations/${encodeURIComponent(id)}` : '#operations') },
    operations: { icon: 'list-checks', label: 'Operations', route: () => '#operations' },
    settings: { icon: 'settings', label: 'Settings', route: (id) => (id ? `#settings/${encodeURIComponent(id)}` : '#settings') },
    marketing: { icon: 'megaphone', label: 'Marketing', route: () => '#marketing' },
    marketing_recommendation: { icon: 'megaphone', label: 'Marketing', route: () => '#marketing' },
    brain_recommendation: { icon: 'sparkles', label: 'Decision', route: (id) => (id ? `#ai/decisions?recommendation=${encodeURIComponent(id)}` : '#ai/decisions') },
    brain_memory: { icon: 'sparkles', label: 'Decisions', route: () => '#ai/decisions' },
    briefing: { icon: 'sparkles', label: 'Today’s briefing', route: () => '#home' },
    integration: { icon: 'settings', label: 'Integration', route: () => '#settings/integrations' },
    venue_clock: { icon: 'settings', label: 'Opening hours', route: () => '#settings/hours' },
    home: { icon: 'list-checks', label: 'Home', route: () => '#home' }
  };

  // Server records carry canonical spec routes (#inventory/item/<id>, …); the
  // type table is only a fallback for records without one.
  function recordRoute(record) {
    if (typeof record?.route === 'string' && /^#[a-z]/.test(record.route)) return record.route;
    const type = RECORD_TYPES[record?.type];
    if (!type) return null;
    try {
      const route = type.route(record.id == null ? '' : String(record.id));
      return route && !route.endsWith('/') ? route : null;
    } catch { return null; }
  }

  function recordIcon(type) {
    return RECORD_TYPES[type]?.icon || 'file-text';
  }

  function openRoute(route) {
    if (!route) return;
    if (root.AtlasShell?.navigate) root.AtlasShell.navigate(route, { source: 'ai' });
    else root.location.hash = route;
  }

  // Page context label for a record the person opened Atlas from.
  function contextLabel(type, id) {
    const lists = { inventory_item: 'inventory', recipe: 'recipes', supplier: 'suppliers', purchase_order: 'purchaseOrders' };
    const list = lists[type] ? root.AtlasData?.[lists[type]]?.() : null;
    const match = Array.isArray(list) ? list.find((entry) => String(entry.id) === String(id)) : null;
    if (match) return match.name || match.title || match.reference || match.label || RECORD_TYPES[type]?.label;
    if (type === 'report') return `${String(id || 'overview').replace(/^\w/, (c) => c.toUpperCase())} report`;
    if (type === 'briefing') return 'Today’s briefing';
    return RECORD_TYPES[type]?.label || 'This page';
  }

  // ---------- progress wording ----------

  const PAST = [
    [/^Checking\b/, 'Checked'], [/^Adding up\b/, 'Added up'], [/^Comparing\b/, 'Compared'], [/^Drafting\b/, 'Drafted'],
    [/^Looking at\b/, 'Looked at'], [/^Looking through\b/, 'Looked through'], [/^Looking up\b/, 'Looked up'],
    [/^Opening\b/, 'Opened'], [/^Preparing\b/, 'Prepared'], [/^Reading\b/, 'Read'], [/^Reviewing\b/, 'Reviewed'],
    [/^Searching\b/, 'Searched'], [/^Valuing\b/, 'Valued'], [/^Working out\b/, 'Worked out'], [/^Counting\b/, 'Counted'],
    [/^Finding\b/, 'Found'], [/^Working on it\b/, 'Worked on it']
  ];

  function progressLabel(value) {
    const text = humanText(String(value || '').replace(/[.…]+$/, ''), 'Checking Atlas');
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  }

  function pastTense(label) {
    const found = PAST.find(([pattern]) => pattern.test(label));
    return found ? label.replace(found[0], found[1]) : label;
  }

  function stepsSummary(steps) {
    const unique = [...new Set(steps.map((step) => pastTense(step.label)))];
    if (!unique.length) return 'Checked Atlas';
    const lower = unique.map((entry, index) => (index === 0 ? entry : entry.charAt(0).toLowerCase() + entry.slice(1)));
    if (lower.length === 1) return lower[0];
    return `${lower.slice(0, -1).join(', ')} and ${lower.at(-1)}`;
  }

  // ---------- answer formatting (escaped markdown subset) ----------

  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<span class="num">$1</span>');
  }

  function formatAnswer(text, { emphasiseFirst = false } = {}) {
    const source = String(text || '').replace(/\r/g, '').trim();
    if (!source) return '';
    const blocks = source.split(/\n{2,}/);
    const html = blocks.map((block, blockIndex) => {
      const lines = block.split('\n');
      if (lines.every((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line))) {
        const ordered = /^\s*\d/.test(lines[0]);
        const items = lines.map((line) => `<li>${inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('');
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      let paragraph = lines.map(inline).join('<br>');
      if (emphasiseFirst && blockIndex === 0 && !/^\*\*/.test(block.trim())) {
        const whole = block.trim();
        const sentence = /^([^.!?\n]{3,200}[.!?])(\s|$)/.exec(whole);
        // Emphasise the first sentence only when its own markup is balanced:
        // bold or code that runs past the full stop is left as written, never
        // sliced into garbled HTML.
        const balanced = (part) => (part.match(/\*\*/g) || []).length % 2 === 0
          && (part.replace(/\*\*/g, '').match(/\*/g) || []).length % 2 === 0
          && (part.match(/`/g) || []).length % 2 === 0;
        if (sentence && sentence[1].length < whole.length && balanced(sentence[1])) {
          const rest = whole.slice(sentence[1].length);
          paragraph = `<strong>${inline(sentence[1])}</strong>${rest.split('\n').map(inline).join('<br>')}`;
        }
      }
      return `<p>${paragraph}</p>`;
    }).join('');
    return html;
  }

  // ---------- state ----------

  const state = {
    root: null,
    els: {},
    initialized: false,
    visible: false,
    configured: null,
    settings: null,
    mode: 'conversations',
    list: { items: [], loaded: false, loading: false, error: null, query: '', searchOpen: false, results: null },
    conv: { id: null, title: '', pinned: false, messages: [], actions: new Map(), loading: false, error: null },
    streaming: null,
    composer: { attachments: [], source: 'text', duration: null, context: null, voiceNote: null, transcribing: false },
    live: null,
    decisions: { loaded: false, loading: false, error: null, snapshot: null, filter: { status: 'all', area: 'all', period: '90' }, detail: null, openId: null },
    openSheet: null,
    renderQueued: false,
    lastParams: {}
  };

  function currentConversationKey() {
    return state.conv.id || 'new';
  }

  // ---------- DOM skeleton ----------

  function ensureRoot() {
    let rootEl = document.getElementById('ai-view');
    if (!rootEl) {
      const main = document.querySelector('.atlas-content.standard-view main') || document.querySelector('main');
      if (!main) return null;
      rootEl = document.createElement('div');
      rootEl.id = 'ai-view';
      rootEl.style.display = 'none';
      main.appendChild(rootEl);
    }
    if (!rootEl.dataset.aiReady) {
      rootEl.dataset.aiReady = 'true';
      rootEl.classList.add('atlas-ai');
      rootEl.innerHTML = skeletonMarkup();
      bindSkeleton(rootEl);
    }
    state.root = rootEl;
    return rootEl;
  }

  function skeletonMarkup() {
    return `
      <div class="ai-layout">
        <div class="ai-scrim" data-ai-close-list hidden></div>
        <aside class="ai-list" id="ai-list" aria-label="Conversations" tabindex="-1">
          <div class="ai-list__top">
            <div class="ai-list__head">
              <button type="button" class="atlas-btn atlas-btn--secondary" data-ai-new>${icon('plus')}New conversation</button>
              <button type="button" class="atlas-icon-btn" data-ai-search-toggle aria-label="Search conversations" aria-expanded="false" aria-controls="ai-list-search">${icon('search')}</button>
              <button type="button" class="atlas-icon-btn ai-list__close" data-ai-close-list aria-label="Close conversations">${icon('x')}</button>
            </div>
            <div class="ai-list__search" id="ai-list-search" hidden>
              <label class="sr-only" for="ai-list-search-input">Search conversations</label>
              <div class="ai-search">${icon('search')}<input id="ai-list-search-input" class="atlas-input" type="search" placeholder="Search conversations" autocomplete="off"></div>
            </div>
            <div class="ai-list__modes" data-ai-modes hidden>
              <div class="atlas-segmented" role="group" aria-label="Atlas AI sections">
                <button type="button" data-ai-mode="conversations" aria-pressed="true">Conversations</button>
                <button type="button" data-ai-mode="decisions" aria-pressed="false">Decisions</button>
              </div>
            </div>
          </div>
          <nav class="ai-list__scroll" data-ai-list aria-label="Conversation history"></nav>
        </aside>
        <section class="ai-thread" data-ai-thread aria-label="Conversation">
          <h1 class="sr-only">Atlas AI</h1>
          <header class="ai-thread__head">
            <button type="button" class="atlas-icon-btn ai-thread__list-btn" data-ai-open-list aria-label="Conversations">${icon('panel-left')}</button>
            <div class="ai-thread__title" data-ai-title></div>
            <button type="button" class="atlas-icon-btn" data-ai-pin aria-label="Pin conversation" hidden>${icon('pin')}</button>
            <button type="button" class="atlas-icon-btn" data-ai-thread-menu aria-label="Conversation options" aria-haspopup="menu" hidden>${icon('ellipsis')}</button>
          </header>
          <div class="ai-scroll" data-ai-scroll>
            <div class="ai-col" data-ai-messages aria-live="off"></div>
            <div class="sr-only" aria-live="polite" data-ai-announce></div>
          </div>
          <div class="composer-wrap" data-ai-composer-wrap>
            <div data-ai-voice-slot></div>
            <div class="composer-prompts" data-ai-prompts hidden></div>
            <form class="composer" data-ai-composer novalidate>
              <div class="composer__attachments" data-ai-attachments hidden></div>
              <label class="sr-only" for="ai-composer-input">Message Atlas</label>
              <textarea id="ai-composer-input" data-ai-input rows="1" placeholder="Ask Atlas about stock, recipes, shifts…" autocomplete="off"></textarea>
              <div class="composer__bar" data-ai-bar></div>
              <div class="composer__record" data-ai-record hidden></div>
            </form>
            <p class="composer-hint" data-ai-hint>Atlas prepares changes for you to approve. It never changes stock, orders or shifts on its own.</p>
            <input type="file" data-ai-file-photo accept="image/*" hidden tabindex="-1">
            <input type="file" data-ai-file-camera accept="image/*" capture="environment" hidden tabindex="-1">
            <input type="file" data-ai-file-any accept="${UPLOAD_ACCEPT}" hidden tabindex="-1" multiple>
          </div>
        </section>
        <section class="ai-decisions" data-ai-decisions aria-labelledby="ai-decisions-title" hidden></section>
      </div>
`;
  }

  function el(name) {
    return state.els[name];
  }

  function bindSkeleton(rootEl) {
    const q = (selector) => rootEl.querySelector(selector);
    state.els = {
      list: q('[data-ai-list]'), listPane: q('.ai-list'), scrim: q('.ai-scrim'), modes: q('[data-ai-modes]'),
      search: q('#ai-list-search'), searchInput: q('#ai-list-search-input'), searchToggle: q('[data-ai-search-toggle]'),
      thread: q('[data-ai-thread]'), title: q('[data-ai-title]'), pin: q('[data-ai-pin]'), threadMenu: q('[data-ai-thread-menu]'),
      scroll: q('[data-ai-scroll]'), messages: q('[data-ai-messages]'), announce: q('[data-ai-announce]'),
      composerWrap: q('[data-ai-composer-wrap]'), composer: q('[data-ai-composer]'), input: q('[data-ai-input]'), bar: q('[data-ai-bar]'),
      record: q('[data-ai-record]'), attachments: q('[data-ai-attachments]'), hint: q('[data-ai-hint]'), prompts: q('[data-ai-prompts]'),
      voiceSlot: q('[data-ai-voice-slot]'), filePhoto: q('[data-ai-file-photo]'), fileCamera: q('[data-ai-file-camera]'), fileAny: q('[data-ai-file-any]'),
      decisions: q('[data-ai-decisions]')
    };

    rootEl.addEventListener('click', onRootClick);
    rootEl.addEventListener('keydown', onRootKeydown);
    rootEl.addEventListener('change', (event) => {
      const filter = event.target.closest?.('[data-ai-dec-filter]');
      if (!filter) return;
      state.decisions.filter = { ...state.decisions.filter, [filter.dataset.aiDecFilter]: filter.value };
      const id = filter.id;
      renderDecisions();
      document.getElementById(id)?.focus();
    });
    el('composer').addEventListener('submit', (event) => { event.preventDefault(); send(); });
    el('input').addEventListener('input', () => { autoGrow(); renderComposerBar(); });
    el('input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (state.streaming) return;
        send();
      }
    });
    el('searchInput').addEventListener('input', onSearchInput);
    el('searchInput').addEventListener('keydown', (event) => { if (event.key === 'Escape') { toggleSearch(false); } });
    [el('filePhoto'), el('fileCamera'), el('fileAny')].forEach((input) => input.addEventListener('change', () => {
      addFiles([...input.files]);
      input.value = '';
    }));
    el('scroll').addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); rootEl.classList.add('is-dragging'); } });
    el('scroll').addEventListener('dragleave', () => rootEl.classList.remove('is-dragging'));
    el('scroll').addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      rootEl.classList.remove('is-dragging');
      addFiles([...event.dataTransfer.files]);
    });
    renderComposerBar();
  }

  // ---------- layout helpers ----------

  function measureTop() {
    if (!state.root || !state.visible) return;
    const rect = state.root.getBoundingClientRect();
    const top = Math.max(0, Math.round(rect.top + (root.scrollY || 0)));
    state.root.style.setProperty('--ai-top', `${top}px`);
  }

  function autoGrow() {
    const input = el('input');
    if (!input) return;
    input.style.height = 'auto';
    const lineHeight = 24;
    // The CSS min-height is the touch height on coarse pointers (44 px) and
    // one line elsewhere; padding counts towards the eight-line maximum.
    const style = root.getComputedStyle ? root.getComputedStyle(input) : null;
    const padding = (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0);
    const minimum = Math.max(lineHeight + 4, parseFloat(style?.minHeight) || 0);
    const max = lineHeight * 8 + Math.max(4, padding);
    input.style.height = `${Math.min(max, Math.max(minimum, input.scrollHeight))}px`;
    input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
  }

  function nearBottom() {
    const scroller = isPhone() ? document.scrollingElement : el('scroll');
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  }

  function scrollToBottom(force = false) {
    if (!force && !nearBottom()) return;
    const behavior = reducedMotion() ? 'auto' : 'smooth';
    if (isPhone()) root.scrollTo?.({ top: document.scrollingElement?.scrollHeight || 0, behavior });
    else el('scroll')?.scrollTo?.({ top: el('scroll').scrollHeight, behavior });
  }

  function announce(text) {
    const region = el('announce');
    if (!region) return;
    region.textContent = '';
    root.setTimeout(() => { region.textContent = text; }, 30);
  }

  // Completed actions only (spec §4.11), through the shell's one toast.
  function toast(text, action = null) {
    root.AtlasShell?.toast?.(text, action ? { action: { label: action.label, onClick: action.run } } : undefined);
  }

  // ---------- conversation list ----------

  function conversationTitle(conversation) {
    const title = String(conversation?.title || '').trim();
    if (title) return title;
    const preview = String(conversation?.last_message_preview || '').trim();
    return preview ? preview.slice(0, 60) : 'New conversation';
  }

  function listGroups(items) {
    const groups = [['Pinned', []], ['Today', []], ['Previous 7 days', []], ['Earlier', []]];
    const today = dayKey(new Date());
    items.forEach((item) => {
      const date = new Date(item.last_message_at || item.updated_at || item.created_at || Date.now());
      if (item.pinned) groups[0][1].push(item);
      else if (dayKey(date) === today) groups[1][1].push(item);
      else if (Date.now() - date.getTime() < 7 * DAY) groups[2][1].push(item);
      else groups[3][1].push(item);
    });
    return groups.filter(([, rows]) => rows.length);
  }

  function renderList() {
    const container = el('list');
    if (!container) return;
    el('modes').hidden = !isManager();
    el('modes').querySelectorAll('[data-ai-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.aiMode === state.mode)));
    const list = state.list;
    if (state.configured === false && !list.items.length) {
      container.innerHTML = '<p class="ai-list__note">Conversations appear here once Atlas AI is switched on.</p>';
      return;
    }
    if (list.loading && !list.loaded) {
      container.innerHTML = `<div class="ai-list__skel" aria-hidden="true">${'<div class="atlas-skel"></div>'.repeat(5)}</div><p class="sr-only">Loading conversations</p>`;
      return;
    }
    if (list.error && !list.items.length) {
      container.innerHTML = `<div class="ai-list__note">Conversations couldn’t be loaded. <button type="button" class="ai-link" data-ai-list-retry>Try again</button></div>`;
      return;
    }
    const items = list.results || list.items;
    if (!items.length) {
      container.innerHTML = list.query
        ? `<p class="ai-list__note">No conversations match “${escapeHtml(list.query)}”.</p>`
        : '<p class="ai-list__note">Your conversations with Atlas appear here.</p>';
      return;
    }
    const groups = list.results ? [['Results', items]] : listGroups(items);
    container.innerHTML = groups.map(([label, rows]) => `
      <div class="ai-list__label" role="heading" aria-level="2">${escapeHtml(label)}</div>
      <ul class="ai-list__group" role="list">${rows.map(conversationRow).join('')}</ul>`).join('');
  }

  function conversationRow(conversation) {
    const current = conversation.id === state.conv.id;
    const meta = conversation.snippet
      ? humanText(String(conversation.snippet).replace(/\*\*/g, ''), relativeDay(conversation.last_message_at || conversation.updated_at))
      : (conversation.pending_approval ? 'Waiting for approval' : relativeDay(conversation.last_message_at || conversation.updated_at || conversation.created_at));
    return `<li class="ai-conv-row${current ? ' is-current' : ''}">
      <a class="ai-conv" href="#ai/c/${escapeHtml(conversation.id)}" data-ai-open-conv="${escapeHtml(conversation.id)}"${current ? ' aria-current="true"' : ''}>
        <span class="ai-conv__t">${conversation.pinned ? `<span class="sr-only">Pinned: </span>` : ''}${escapeHtml(conversationTitle(conversation))}</span>
        <span class="ai-conv__m">${escapeHtml(meta)}</span>
      </a>
      <button type="button" class="atlas-icon-btn ai-conv__menu" data-ai-conv-menu="${escapeHtml(conversation.id)}" aria-label="Options for ${escapeHtml(conversationTitle(conversation))}" aria-haspopup="menu">${icon('ellipsis')}</button>
    </li>`;
  }

  async function loadList({ quiet = false } = {}) {
    if (!endpoint()) { state.configured = false; renderList(); return; }
    state.list.loading = !quiet;
    if (!quiet) renderList();
    try {
      const payload = await request('conversations', { params: { limit: 50 } });
      state.list.items = Array.isArray(payload?.conversations) ? payload.conversations : [];
      state.list.loaded = true;
      state.list.error = null;
    } catch (error) {
      if (error.code === 'not_configured') state.configured = false;
      state.list.error = error;
    } finally {
      state.list.loading = false;
      renderList();
      contributeHome();
    }
  }

  let searchTimer = 0;
  function onSearchInput() {
    const query = el('searchInput').value.trim();
    state.list.query = query;
    root.clearTimeout(searchTimer);
    if (!query) { state.list.results = null; renderList(); return; }
    const lower = query.toLowerCase();
    state.list.results = state.list.items.filter((item) => conversationTitle(item).toLowerCase().includes(lower));
    renderList();
    searchTimer = root.setTimeout(async () => {
      try {
        const payload = await request('conversations', { params: { q: query, limit: 30 } });
        if (state.list.query !== query) return;
        const byId = new Map(state.list.results.map((item) => [item.id, item]));
        (payload?.conversations || []).forEach((item) => byId.set(item.id, { ...byId.get(item.id), ...item }));
        state.list.results = [...byId.values()];
        renderList();
      } catch { /* the local title filter stays */ }
    }, 250);
  }

  function toggleSearch(open = el('search').hidden) {
    el('search').hidden = !open;
    el('searchToggle').setAttribute('aria-expanded', String(open));
    if (open) el('searchInput').focus();
    else {
      el('searchInput').value = '';
      state.list.query = '';
      state.list.results = null;
      renderList();
      el('searchToggle').focus();
    }
  }

  function findConversation(id) {
    return state.list.items.find((item) => item.id === id) || (state.conv.id === id ? { id, title: state.conv.title, pinned: state.conv.pinned } : null);
  }

  async function renameConversation(id, title) {
    const value = String(title || '').trim().slice(0, 200);
    if (!value) return false;
    try {
      await request('rename', { method: 'POST', body: { conversation_id: id, title: value } });
      const item = findConversation(id);
      if (item) item.title = value;
      if (state.conv.id === id) state.conv.title = value;
      renderList();
      renderThreadHead();
      return true;
    } catch (error) {
      toast(friendly(error, 'Renaming'));
      return false;
    }
  }

  async function pinConversation(id, pinned) {
    try {
      await request('pin', { method: 'POST', body: { conversation_id: id, pinned } });
      const item = state.list.items.find((entry) => entry.id === id);
      if (item) item.pinned = pinned;
      if (state.conv.id === id) state.conv.pinned = pinned;
      renderList();
      renderThreadHead();
      toast(pinned ? 'Conversation pinned' : 'Conversation unpinned');
    } catch (error) {
      toast(friendly(error, 'Pinning'));
    }
  }

  async function archiveConversation(id, archived = true) {
    try {
      await request('archive', { method: 'POST', body: { conversation_id: id, archived } });
      if (archived) {
        state.list.items = state.list.items.filter((item) => item.id !== id);
        if (state.conv.id === id) newConversation({ route: true });
        toast('Conversation archived', { label: 'Undo', run: () => archiveConversation(id, false) });
      } else {
        await loadList({ quiet: true });
        toast('Conversation restored');
      }
      renderList();
    } catch (error) {
      toast(friendly(error, 'Archiving'));
    }
  }

  async function deleteConversation(id) {
    const confirmed = await confirmDialog({
      title: 'Delete this conversation?',
      body: 'Its messages, photos and files are removed. Orders, counts or messages Atlas already created stay as they are.',
      confirm: 'Delete',
      danger: true
    });
    if (!confirmed) return;
    try {
      await request('delete', { method: 'POST', body: { conversation_id: id } });
      state.list.items = state.list.items.filter((item) => item.id !== id);
      if (state.conv.id === id) newConversation({ route: true });
      renderList();
      toast('Conversation deleted');
    } catch (error) {
      toast(friendly(error, 'Deleting'));
    }
  }

  // ---------- menus and dialogs ----------

  function closeMenu() {
    const open = document.querySelector('.ai-menu');
    if (!open) return;
    const trigger = open._trigger;
    open.remove();
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.focus?.();
  }

  function openMenu(trigger, items) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'atlas-menu ai-menu';
    menu.setAttribute('role', 'menu');
    menu._trigger = trigger;
    menu.innerHTML = items.map((item, index) => (item.divider
      ? '<hr class="atlas-menu__sep" role="separator">'
      : `<button type="button" role="menuitem" class="atlas-menu__item${item.danger ? ' atlas-menu__item--danger' : ''}" data-index="${index}" tabindex="-1">${icon(item.icon)}${escapeHtml(item.label)}</button>`)).join('');
    state.root.appendChild(menu);
    const rect = trigger.getBoundingClientRect();
    const rootRect = state.root.getBoundingClientRect();
    const width = 200;
    let left = rect.right - rootRect.left - width;
    if (left < 8) left = Math.max(8, rect.left - rootRect.left);
    menu.style.left = `${Math.min(left, rootRect.width - width - 8)}px`;
    menu.style.top = `${rect.bottom - rootRect.top + 4}px`;
    trigger.setAttribute('aria-expanded', 'true');
    const buttons = [...menu.querySelectorAll('[role="menuitem"]')];
    buttons[0]?.focus();
    menu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-index]');
      if (!button) return;
      const item = items[Number(button.dataset.index)];
      closeMenu();
      item?.run?.();
    });
    menu.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length].focus(); }
      else if (event.key === 'Home') { event.preventDefault(); buttons[0].focus(); }
      else if (event.key === 'End') { event.preventDefault(); buttons.at(-1).focus(); }
      else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(); }
    });
    root.setTimeout(() => document.addEventListener('pointerdown', function away(event) {
      if (!menu.isConnected) { document.removeEventListener('pointerdown', away); return; }
      if (!menu.contains(event.target) && event.target !== trigger) { menu.remove(); trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', away); }
    }), 0);
  }

  function conversationMenu(id, trigger) {
    const item = findConversation(id) || { id };
    openMenu(trigger, [
      { label: 'Rename', icon: 'pencil', run: () => renameDialog(id) },
      { label: item.pinned ? 'Unpin' : 'Pin', icon: item.pinned ? 'pin-off' : 'pin', run: () => pinConversation(id, !item.pinned) },
      { label: 'Copy link', icon: 'link', run: () => copyText(`${root.location.origin}${root.location.pathname}#ai/c/${id}`, 'Link copied') },
      { label: 'Archive', icon: 'archive', run: () => archiveConversation(id, true) },
      { divider: true },
      { label: 'Delete', icon: 'trash-2', danger: true, run: () => deleteConversation(id) }
    ]);
  }

  // Focus-trapped sheet or dialog. Returns { root, close }.
  function openLayer({ className, labelledBy, markup, onClose, initialFocus }) {
    const previous = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'ai-layer-scrim';
    const layer = document.createElement('div');
    layer.className = `ai-layer ${className}`;
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    if (labelledBy) layer.setAttribute('aria-labelledby', labelledBy);
    layer.innerHTML = markup;
    document.body.append(scrim, layer);
    const focusables = () => [...layer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null || node === document.activeElement);
    let closed = false;
    const close = (reason) => {
      if (closed) return;
      closed = true;
      layer.remove();
      scrim.remove();
      onClose?.(reason);
      if (previous && previous.isConnected) previous.focus?.();
    };
    layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close('escape'); return; }
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    scrim.addEventListener('click', () => close('scrim'));
    layer.addEventListener('click', (event) => { if (event.target.closest('[data-ai-layer-close]')) close('control'); });
    root.requestAnimationFrame(() => {
      const target = (initialFocus && layer.querySelector(initialFocus)) || focusables()[0] || layer;
      if (target === layer) layer.setAttribute('tabindex', '-1');
      target.focus();
    });
    return { root: layer, close };
  }

  function confirmDialog({ title, body, confirm, danger = false }) {
    return new Promise((resolve) => {
      const id = uid('ai-dialog');
      let answered = false;
      const layer = openLayer({
        className: 'ai-dialog',
        labelledBy: `${id}-title`,
        markup: `<h2 id="${id}-title">${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>
          <div class="ai-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-ai-layer-close>Cancel</button><button type="button" class="atlas-btn ${danger ? 'atlas-btn--danger-solid' : 'atlas-btn--primary'}" data-ai-confirm>${escapeHtml(confirm)}</button></div>`,
        initialFocus: '[data-ai-layer-close]',
        onClose: () => { if (!answered) resolve(false); }
      });
      layer.root.querySelector('[data-ai-confirm]').addEventListener('click', () => { answered = true; layer.close('confirm'); resolve(true); });
    });
  }

  function renameDialog(id) {
    const item = findConversation(id) || { title: '' };
    const dialogId = uid('ai-rename');
    const layer = openLayer({
      className: 'ai-dialog',
      labelledBy: `${dialogId}-title`,
      markup: `<form data-ai-rename-form><h2 id="${dialogId}-title">Rename conversation</h2>
        <div class="atlas-field"><label for="${dialogId}-input">Title</label><input id="${dialogId}-input" class="atlas-input" maxlength="200" value="${escapeHtml(conversationTitle(item))}" required></div>
        <div class="ai-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-ai-layer-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary">Rename</button></div></form>`,
      initialFocus: 'input'
    });
    const input = layer.root.querySelector('input');
    input.select();
    layer.root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value.trim()) { input.setAttribute('aria-invalid', 'true'); return; }
      if (await renameConversation(id, input.value)) layer.close('saved');
    });
  }

  function openListSheet() {
    if (!isCompact()) { el('searchToggle')?.focus(); return; }
    state.root.classList.add('is-list-open');
    el('scrim').hidden = false;
    el('listPane').setAttribute('role', 'dialog');
    el('listPane').setAttribute('aria-modal', 'true');
    state.listReturnFocus = document.activeElement;
    root.requestAnimationFrame(() => (el('listPane').querySelector('[data-ai-new]') || el('listPane')).focus());
  }

  function closeListSheet() {
    if (!state.root?.classList.contains('is-list-open')) return;
    state.root.classList.remove('is-list-open');
    el('scrim').hidden = true;
    el('listPane').removeAttribute('role');
    el('listPane').removeAttribute('aria-modal');
    state.listReturnFocus?.focus?.();
  }

  // ---------- thread ----------

  function renderThreadHead() {
    const title = el('title');
    if (!title) return;
    const hasConversation = Boolean(state.conv.id);
    title.innerHTML = hasConversation
      ? `<button type="button" class="ai-thread__title-btn" data-ai-rename-inline title="Rename">${escapeHtml(state.conv.title || conversationTitle(findConversation(state.conv.id) || {}))}</button>`
      : '<span>New conversation</span>';
    el('pin').hidden = !hasConversation;
    el('threadMenu').hidden = !hasConversation;
    el('pin').innerHTML = icon(state.conv.pinned ? 'pin-off' : 'pin');
    el('pin').setAttribute('aria-label', state.conv.pinned ? 'Unpin conversation' : 'Pin conversation');
    el('pin').setAttribute('aria-pressed', String(Boolean(state.conv.pinned)));
  }

  function startInlineRename() {
    const title = el('title');
    const current = state.conv.title || conversationTitle(findConversation(state.conv.id) || {});
    title.innerHTML = `<label class="sr-only" for="ai-title-input">Conversation title</label><input id="ai-title-input" class="atlas-input ai-thread__title-input" maxlength="200" value="${escapeHtml(current)}">`;
    const input = title.querySelector('input');
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== current) await renameConversation(state.conv.id, input.value);
      renderThreadHead();
      title.querySelector('button')?.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function suggestions() {
    const manager = isManager();
    const operational = OPERATIONAL_ROLES.includes(role());
    const list = [
      { label: 'What’s low before tonight?', prompt: 'What is low before tonight?' },
      { label: 'Who’s on tomorrow?', prompt: 'Who is working tomorrow?' }
    ];
    if (manager) list.push({ label: 'Does this delivery match our order?', prompt: 'Does this delivery match our order?', photo: true });
    else list.push({ label: 'Which recipes can’t we make tonight?', prompt: 'Which recipes can we not make tonight?' });
    if (operational) list.push({ label: 'Count the back bar by voice', live: true });
    else list.push({ label: 'What’s on today’s checklist?', prompt: 'What is on today’s opening checklist?' });
    return list;
  }

  function emptyStateMarkup() {
    const name = firstName();
    if (state.configured === false) return notConfiguredMarkup();
    return `<div class="ai-empty">
      <h2 class="ai-empty__greeting">What can I help with${name ? `, ${escapeHtml(name)}` : ''}?</h2>
      ${state.composer.context ? `<p class="ai-empty__context">Ask about ${escapeHtml(state.composer.context.label)}, or anything else about the venue.</p>` : ''}
      <div class="ai-empty__chips" role="list">${suggestions().map((item, index) => `<button type="button" role="listitem" class="atlas-chip" data-ai-suggest="${index}">${item.photo ? icon('camera') : item.live ? icon('audio-lines') : ''}${escapeHtml(item.label)}</button>`).join('')}</div>
    </div>`;
  }

  function notConfiguredMarkup() {
    const admin = role() === 'admin';
    return `<div class="ai-empty ai-empty--off">
      <div class="atlas-empty">
        <div class="atlas-empty__icon">${icon('sparkles')}</div>
        <h3>Atlas AI isn’t switched on yet</h3>
        <p>${admin
          ? 'Set it up in Settings › Atlas AI: add the service key, then switch it on. Until then, record search and quick answers from your stock, recipes and shifts still work.'
          : 'An administrator can switch it on in Settings. Until then, record search and quick answers from your stock, recipes and shifts still work.'}</p>
        ${admin ? '<a class="atlas-btn atlas-btn--secondary" href="#settings/ai" data-ai-route="#settings/ai">Open Settings</a>' : ''}
      </div>
    </div>`;
  }

  // Spec §4.4/§8.7: the phone tab bar is hidden inside a conversation and
  // while live voice is on; the empty state keeps it.
  function syncTabBar() {
    const hide = state.visible && (state.conv.messages.length > 0 || Boolean(state.live));
    root.AtlasChrome?.setTabBarHidden?.('ai', hide);
    state.root?.classList.toggle('has-tabbar', state.visible && !hide);
  }

  function setTopBar() {
    root.AtlasChrome?.setTopBar?.({
      own: true,
      actions: [
        { icon: 'history', label: 'Conversations', run: () => openListSheet() },
        { icon: 'square-pen', label: 'New conversation', run: () => newConversation({ route: true }) }
      ]
    });
  }

  function renderThread() {
    const container = el('messages');
    if (!container) return;
    renderThreadHead();
    const { conv } = state;
    state.root.classList.toggle('has-messages', conv.messages.length > 0);
    syncTabBar();
    if (conv.loading) {
      container.innerHTML = `<div class="ai-loading" aria-busy="true"><div class="msg-user"><div class="atlas-skel" style="width:46%;height:40px;border-radius:16px"></div></div><div class="atlas-skel" style="width:30%"></div><div class="atlas-skel" style="width:92%;margin-top:12px"></div><div class="atlas-skel" style="width:74%;margin-top:10px"></div><span class="sr-only">Loading conversation</span></div>`;
      return;
    }
    if (conv.error) {
      container.innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div><div class="atlas-alert__title">This conversation couldn’t be loaded.</div><div>Nothing was changed. Try again, or start a new conversation.</div></div><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ai-conv-retry>Try again</button></div>`;
      return;
    }
    if (!conv.messages.length) {
      container.innerHTML = emptyStateMarkup();
      return;
    }
    container.innerHTML = conv.messages.map(messageMarkup).join('');
  }

  function messageNode(message) {
    return el('messages')?.querySelector(`[data-ai-msg="${CSS.escape(message.key)}"]`) || null;
  }

  function patchMessage(message) {
    const node = messageNode(message);
    if (!node) { renderThread(); return; }
    const template = document.createElement('template');
    template.innerHTML = messageMarkup(message).trim();
    node.replaceWith(template.content.firstElementChild);
  }

  function messageMarkup(message) {
    if (message.role === 'user') return userMessageMarkup(message);
    if (message.role === 'system_note') return noteMarkup(message);
    return assistantMarkup(message);
  }

  function userMessageMarkup(message) {
    const attachments = (message.attachments || []).map((attachment) => {
      if (attachment.kind === 'image' && attachment.preview) {
        return `<figure class="msg-photo"><img src="${escapeHtml(attachment.preview)}" alt="${escapeHtml(attachment.name || 'Photo')}"><figcaption>${escapeHtml(attachment.name || 'Photo')}</figcaption></figure>`;
      }
      return `<span class="file-chip">${icon(attachment.kind === 'image' ? 'image' : 'file-text')}${escapeHtml(attachment.name || (attachment.kind === 'image' ? 'Photo' : 'File'))}</span>`;
    }).join('');
    const voice = message.source === 'voice_note'
      ? `<span class="file-chip file-chip--voice">${icon('mic')}Voice note${message.metadata?.duration_seconds ? ` · ${durationLabel(message.metadata.duration_seconds)}` : ''}</span>`
      : message.source === 'live_voice' ? `<span class="file-chip file-chip--voice">${icon('audio-lines')}Live voice</span>` : '';
    const context = message.metadata?.page_context?.entity?.label
      ? `<span class="file-chip">${icon(recordIcon(message.metadata.page_context.entity.type))}${escapeHtml(message.metadata.page_context.entity.label)}</span>` : '';
    const extras = attachments || voice || context ? `<div class="msg-user__attach">${voice}${context}${attachments}</div>` : '';
    return `<div class="msg-user" data-ai-msg="${escapeHtml(message.key)}"><div class="msg-user__inner">${extras}<div class="msg-user__bubble">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div></div></div>`;
  }

  function noteMarkup(message) {
    return `<div class="msg-note" data-ai-msg="${escapeHtml(message.key)}">${icon('info')}<span>${escapeHtml(humanText(message.content, 'Update recorded.'))}</span></div>`;
  }

  function stepsMarkup(message) {
    const steps = message.progress || [];
    const running = message.status === 'streaming';
    if (!steps.length && !running) return '';
    if (running) {
      const label = steps.length ? steps.at(-1).label : 'Thinking';
      return `<div class="steps-line is-running" aria-live="polite">${icon('loader-circle', 'icon--spin')}<span>${escapeHtml(label)}…</span></div>`;
    }
    const expanded = Boolean(message.stepsOpen);
    const list = expanded ? `<ol class="steps-list">${steps.map((step) => `<li>${icon('check')}<span>${escapeHtml(pastTense(step.label))}</span>${step.ms ? `<span class="steps-list__ms">${(step.ms / 1000).toFixed(1)} s</span>` : ''}</li>`).join('')}</ol>` : '';
    return `<button type="button" class="steps-line" data-ai-steps="${escapeHtml(message.key)}" aria-expanded="${expanded}">${icon('circle-check', 'icon--ok')}<span>${escapeHtml(stepsSummary(steps))}</span>${steps.length > 1 ? icon('chevron-down', 'icon--chev') : ''}</button>${list}`;
  }

  const EVIDENCE_KINDS = {
    fact: ['Verified', 'kind--fact'],
    calculation: ['Calculated', 'kind--calc'],
    estimate: ['Estimate', 'kind--est'],
    interpretation: ['Interpretation', 'kind--interp'],
    missing: ['Missing', 'kind--missing']
  };

  function evidenceMarkup(message) {
    const items = (message.evidence || []).filter(Boolean);
    if (!items.length) return '';
    const hasMissing = items.some((item) => item.kind === 'missing');
    const open = message.evidenceOpen ?? (hasMissing || items.length > 2);
    const rows = items.map((item) => {
      const [kindLabel, kindClass] = EVIDENCE_KINDS[item.kind] || EVIDENCE_KINDS.interpretation;
      const label = humanText(item.label, 'Checked in Atlas');
      const value = item.value == null ? '' : humanText(item.value, '');
      const statement = value ? `${label}: ${value}` : label;
      const source = item.source || null;
      const sourceText = humanText(source?.label || RECORD_TYPES[source?.type]?.label || '', '');
      const route = source ? recordRoute(source) : null;
      const sourceHtml = sourceText
        ? (route ? `<a class="src" href="${escapeHtml(route)}" data-ai-route="${escapeHtml(route)}">${escapeHtml(sourceText)}</a>` : `<span class="src">${escapeHtml(sourceText)}</span>`)
        : '<span class="src"></span>';
      return `<div class="evidence__row" role="listitem"><span class="kind ${kindClass}">${kindLabel}</span><span class="evidence__statement">${escapeHtml(statement)}</span>${sourceHtml}</div>`;
    }).join('');
    const bodyId = `ai-ev-${escapeHtml(message.key)}`;
    return `<div class="evidence${open ? ' is-open' : ''}" role="group" aria-label="How Atlas knows">
      <button type="button" class="evidence__head" data-ai-evidence="${escapeHtml(message.key)}" aria-expanded="${open}" aria-controls="${bodyId}" title="How do you know?">${icon('file-text')}<span>How Atlas knows</span><span class="muted">${items.length} ${items.length === 1 ? 'source' : 'sources'}</span>${icon('chevron-down', 'icon--chev')}</button>
      <div class="evidence__body" id="${bodyId}" role="list"${open ? '' : ' hidden'}>${rows}</div>
    </div>`;
  }

  function recordsMarkup(message) {
    const records = (message.records || []).filter((record) => record && (record.label || record.type));
    if (!records.length) return '';
    const expanded = Boolean(message.recordsOpen);
    const visible = expanded ? records : records.slice(0, 6);
    const chips = visible.map((record) => {
      const route = recordRoute(record);
      const label = humanText(record.label, RECORD_TYPES[record.type]?.label || 'Record');
      return route
        ? `<a class="record-chip" href="${escapeHtml(route)}" data-ai-route="${escapeHtml(route)}">${icon(recordIcon(record.type))}${escapeHtml(label)}</a>`
        : `<span class="record-chip">${icon(recordIcon(record.type))}${escapeHtml(label)}</span>`;
    }).join('');
    const more = !expanded && records.length > 6 ? `<button type="button" class="record-chip record-chip--more" data-ai-records-more="${escapeHtml(message.key)}">+${records.length - 6} more</button>` : '';
    return `<div class="records" aria-label="Linked records">${chips}${more}</div>`;
  }

  function assistantMarkup(message) {
    const streaming = message.status === 'streaming';
    const text = message.content || '';
    const body = text
      ? `<div class="msg-ai__text" data-ai-text>${formatAnswer(text, { emphasiseFirst: message.status === 'complete' && !message.fallback && message.grounding !== 'replaced' })}</div>`
      : streaming ? '<div class="ai-skel-lines" aria-hidden="true"><div class="atlas-skel" style="width:92%"></div><div class="atlas-skel" style="width:74%"></div></div><div class="msg-ai__text" data-ai-text hidden></div>' : '';
    const fallback = message.fallback ? `<p class="msg-ai__label"><span class="atlas-pill atlas-pill--plain">Quick answer</span> From Atlas records. Atlas AI is off, so this is a fixed check, not a full answer.</p>` : '';
    const fallbackLines = message.fallbackLines?.length ? `<ul class="msg-ai__lines">${message.fallbackLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '';
    const fallbackAction = message.fallbackAction ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ai-fallback-action="${escapeHtml(message.key)}">${escapeHtml(message.fallbackAction.label)}</button>` : '';
    const stopped = message.status === 'stopped' ? `<p class="msg-ai__stopped">${icon('square')}Stopped. ${text ? 'This answer is incomplete.' : 'Nothing was answered.'}</p>` : '';
    const error = message.error ? `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div><div class="atlas-alert__title">${escapeHtml(message.error.title)}</div>${message.error.body ? `<div>${escapeHtml(message.error.body)}</div>` : ''}</div>${message.error.retry !== false ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ai-retry="${escapeHtml(message.key)}">Try again</button>` : ''}</div>` : '';
    const proposals = (message.proposals || []).map((proposal) => approvalMarkup(proposal)).join('');
    const actions = !streaming && (text || message.status === 'stopped' || message.error) && !message.fallback ? `<div class="msg-actions">
      ${text ? `<button type="button" class="atlas-icon-btn" data-ai-copy="${escapeHtml(message.key)}" aria-label="Copy answer" title="Copy answer">${icon('copy')}</button>` : ''}
      <button type="button" class="atlas-icon-btn" data-ai-retry="${escapeHtml(message.key)}" aria-label="Try again" title="Try again">${icon('refresh-cw')}</button>
    </div>` : '';
    return `<article class="msg-ai${streaming ? ' is-streaming' : ''}" data-ai-msg="${escapeHtml(message.key)}" aria-busy="${streaming}">
      <div class="msg-ai__who"><span class="ai-mark">${icon('sparkles')}</span>Atlas</div>
      ${fallback}${stepsMarkup(message)}${body}${fallbackLines}${fallbackAction}${stopped}${error}${recordsMarkup(message)}${evidenceMarkup(message)}${proposals}${actions}
    </article>`;
  }

  // ---------- approval cards ----------

  const KINDS = {
    'purchase_order.create': { icon: 'truck', verb: 'Create order', done: 'Order created', view: 'View order', executable: true },
    'purchase_order.update_draft': { icon: 'truck', verb: 'Update draft order', done: 'Draft order updated', view: 'View order', executable: true },
    'purchase_order.receive': { icon: 'truck', verb: 'Receive delivery', done: 'Delivery received', view: 'View order', executable: true },
    'stock_count.draft': { icon: 'list-checks', verb: 'Save count for review', done: 'Count saved for review', view: 'View count', executable: true },
    'shift.draft': { icon: 'calendar-days', verb: 'Save as draft', done: 'Shift draft saved', view: 'View shifts', executable: true },
    'team_message.send': { icon: 'messages-square', verb: 'Send message', done: 'Message sent', view: 'View messages', executable: true },
    'knowledge.draft': { icon: 'book-open', verb: 'Save as draft', done: 'Draft saved', view: 'View article', executable: true },
    'settings.suggestion': { icon: 'settings', verb: 'Open Settings', done: 'Opened', view: 'Open Settings', executable: false },
    'par_level.suggestion': { icon: 'list-checks', verb: 'Open par levels', done: 'Opened', view: 'Open par levels', executable: false }
  };

  function kindInfo(kind) {
    return KINDS[kind] || { icon: 'sparkles', verb: 'Approve', done: 'Done', view: 'Open', executable: true };
  }

  function actionState(proposal) {
    const stored = state.conv.actions.get(proposal.id) || {};
    let status = stored.status || proposal.status || 'proposed';
    if (stored.working) status = 'working';
    const expires = new Date(stored.expires_at || proposal.expires_at || 0);
    if ((status === 'proposed') && proposal.expires_at && !Number.isNaN(expires.getTime()) && expires.getTime() <= Date.now()) status = 'expired';
    return { ...proposal, ...stored, status };
  }

  function canApprove(proposal) {
    const roles = Array.isArray(proposal.required_roles) && proposal.required_roles.length ? proposal.required_roles : MANAGER_ROLES;
    return roles.includes(role());
  }

  function proposalRoute(proposal) {
    const preview = proposal.preview || {};
    const kind = proposal.kind || '';
    const result = proposal.result || {};
    const firstRecord = Array.isArray(result.records) ? result.records[0] : null;
    if (firstRecord) return recordRoute(firstRecord);
    if (kind.startsWith('purchase_order')) {
      const id = result.purchase_order_id || result.id || (String(preview.route || '').match(/purchase_order=([^&]+)/) || [])[1];
      return id ? `#purchasing/order/${encodeURIComponent(decodeURIComponent(id))}` : '#purchasing';
    }
    if (kind === 'stock_count.draft') return result.session_id ? `#inventory/counts/${encodeURIComponent(result.session_id)}` : '#inventory/counts';
    if (kind === 'shift.draft') return '#shifts';
    if (kind === 'team_message.send') return '#messages';
    if (kind === 'knowledge.draft') return result.article_id ? `#knowledge/${encodeURIComponent(result.article_id)}` : '#knowledge';
    if (kind === 'settings.suggestion') return '#settings';
    if (kind === 'par_level.suggestion') return '#data/pars';
    return typeof preview.route === 'string' && preview.route.startsWith('#') ? preview.route : null;
  }

  function approvalMarkup(raw) {
    const proposal = actionState(raw);
    const info = kindInfo(proposal.kind);
    const preview = proposal.preview || {};
    const title = humanText(proposal.title, humanText(preview.headline, 'Prepared change'));
    const headline = humanText(preview.headline, '');
    const id = escapeHtml(proposal.id);
    const allowed = canApprove(proposal);

    if (proposal.status === 'rejected' || proposal.status === 'dismissed') {
      return `<div class="approval approval--collapsed" data-ai-approval="${id}">${icon('x')}<span><strong>Dismissed</strong> · ${escapeHtml(title)}</span></div>`;
    }
    if (proposal.status === 'expired') {
      return `<div class="approval approval--collapsed" data-ai-approval="${id}">${icon('info')}<span><strong>Expired</strong> · ${escapeHtml(title)}. Ask Atlas to prepare it again if it’s still needed.</span></div>`;
    }

    const lines = Array.isArray(preview.lines) ? preview.lines : [];
    const shown = lines.slice(0, 8);
    // "6 bottles × 3.900 kr = 23.400 kr" reads as quantity and line total columns.
    const priced = shown.map((line) => /^(\d[\d.,]*)(\s+[^×=]+?)?\s+×\s+(.+?)\s+=\s+(.+)$/.exec(humanText(line.detail, '')));
    const columns = priced.length > 0 && priced.every(Boolean) ? 3 : 2;
    const lineRows = shown.map((line, index) => {
      const label = `<span>${escapeHtml(humanText(line.label, 'Line'))}</span>`;
      const match = priced[index];
      if (columns === 3) {
        return `<div class="approval__line approval__line--3" title="${escapeHtml(`${match[3]} each`)}">${label}<span class="is-num">${escapeHtml(match[1])}${match[2] ? `<span class="unit">${escapeHtml(match[2].trim())}</span>` : ''}</span><span class="is-num">${escapeHtml(match[4])}</span></div>`;
      }
      return `<div class="approval__line">${label}<span class="is-num">${escapeHtml(humanText(line.detail, ''))}</span></div>`;
    }).join('');
    const filler = columns === 3 ? '<span></span>' : '';
    const more = lines.length > shown.length ? `<div class="approval__line approval__line--more${columns === 3 ? ' approval__line--3' : ''}"><span>${lines.length - shown.length} more ${lines.length - shown.length === 1 ? 'line' : 'lines'}</span>${filler}<span></span></div>` : '';
    const total = preview.totals?.estimated_total_label ? `<div class="approval__line approval__line--total${columns === 3 ? ' approval__line--3' : ''}"><span>Estimated total</span>${filler}<span class="is-num">${escapeHtml(preview.totals.estimated_total_label)}</span></div>` : '';
    const discrepancies = Array.isArray(preview.discrepancies) && preview.discrepancies.length
      ? `<div class="approval__warn">${icon('triangle-alert')}<ul>${preview.discrepancies.slice(0, 6).map((entry) => `<li>${escapeHtml(humanText(typeof entry === 'string' ? entry : entry?.label || entry?.message, 'A line differs from the order.'))}</li>`).join('')}</ul></div>` : '';
    const warnings = Array.isArray(preview.warnings) && preview.warnings.length
      ? `<div class="approval__warn">${icon('triangle-alert')}<ul>${preview.warnings.slice(0, 4).map((entry) => `<li>${escapeHtml(humanText(typeof entry === 'string' ? entry : entry?.message, 'Check this before approving.'))}</li>`).join('')}</ul></div>` : '';
    const recipients = Array.isArray(preview.recipients) && preview.recipients.length ? `<p class="approval__recipients">Goes to ${escapeHtml(preview.recipients.join(', '))}</p>` : '';
    const willChange = (preview.will_change || []).filter(Boolean);
    const willNot = (preview.will_not_change || []).filter(Boolean);
    const note = willChange.length || willNot.length ? `<div class="approval__note">${icon('info')}<div>
        ${willChange.length ? `<p><strong>Will change:</strong> ${escapeHtml(willChange.join(' '))}</p>` : ''}
        ${willNot.length ? `<p><strong>Will not change:</strong> ${escapeHtml(willNot.join(' '))}</p>` : ''}
      </div></div>` : '';

    let pill = '<span class="atlas-pill atlas-pill--info">Needs approval</span>';
    if (!allowed && info.executable) pill = '<span class="atlas-pill atlas-pill--warning">Waiting for a manager</span>';
    if (proposal.status === 'working' || proposal.status === 'executing') pill = '<span class="atlas-pill atlas-pill--info">Working…</span>';
    if (proposal.status === 'executed') pill = `<span class="atlas-pill atlas-pill--positive">${escapeHtml(info.done)}</span>`;
    if (proposal.status === 'failed') pill = '<span class="atlas-pill atlas-pill--danger">Failed</span>';
    if (!info.executable && proposal.status === 'proposed') pill = '<span class="atlas-pill atlas-pill--plain">Suggestion</span>';

    let foot;
    const route = proposalRoute(proposal);
    if (proposal.status === 'executed') {
      const summary = humanText(proposal.result?.summary, '');
      foot = `<div class="approval__foot approval__foot--done">${summary ? `<span class="spacer">${escapeHtml(summary)}</span>` : '<span class="spacer"></span>'}${route ? `<a class="atlas-btn atlas-btn--ghost atlas-btn--sm" href="${escapeHtml(route)}" data-ai-route="${escapeHtml(route)}">${escapeHtml(info.view)}${icon('arrow-right')}</a>` : ''}</div>`;
    } else {
      const working = proposal.status === 'working' || proposal.status === 'executing';
      const expires = proposal.expires_at ? escapeHtml(expiryLabel(proposal.expires_at)) : '';
      let primary;
      if (!info.executable) {
        primary = route ? `<a class="atlas-btn atlas-btn--primary atlas-btn--sm" href="${escapeHtml(route)}" data-ai-route="${escapeHtml(route)}">${escapeHtml(info.verb)}</a>` : '';
      } else if (proposal.status === 'failed') {
        primary = '';
      } else if (!allowed) {
        primary = `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" disabled aria-disabled="true" title="Only a manager can approve this" aria-describedby="ai-why-${id}">${icon('lock')}${escapeHtml(info.verb)}</button><span class="sr-only" id="ai-why-${id}">Only a manager can approve this.</span>`;
      } else {
        primary = `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm${working ? ' is-loading' : ''}" data-ai-approve="${id}"${working ? ' disabled aria-busy="true"' : ''}>${icon('check')}${escapeHtml(info.verb)}</button>`;
      }
      const waiting = !allowed && info.executable ? '<span class="approval__reason">Only a manager can approve this.</span>' : '';
      foot = `<div class="approval__foot">
        <span class="spacer">${expires}${waiting ? `${expires ? ' · ' : ''}${waiting}` : ''}</span>
        ${allowed || !info.executable ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-ai-dismiss="${id}"${working ? ' disabled' : ''}>Dismiss</button>` : ''}
        ${info.executable && allowed ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ai-edit="${id}"${working ? ' disabled' : ''} title="Tell Atlas what to change">Edit</button>` : ''}
        ${primary}
      </div>`;
    }
    const failure = proposal.status === 'failed' ? `<div class="atlas-alert atlas-alert--danger approval__failed" role="alert">${icon('circle-alert')}<div><div class="atlas-alert__title">This couldn’t be completed.</div><div>${escapeHtml(proposal.failureText || 'Nothing was changed. Try again, or ask Atlas to prepare it again.')}</div></div>${proposal.retryable === false ? '' : `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ai-approve="${id}">Try again</button>`}</div>` : '';

    return `<div class="approval" role="group" aria-label="${escapeHtml(title)}" data-ai-approval="${id}" data-status="${escapeHtml(proposal.status)}">
      <div class="approval__head">
        <span class="approval__icon">${icon(info.icon)}</span>
        <div class="approval__titles"><h4>${escapeHtml(title)}</h4>${headline && headline !== title ? `<p>${escapeHtml(headline)}</p>` : ''}</div>
        ${pill}
      </div>
      ${lineRows || total ? `<div class="approval__lines">${lineRows}${more}${total}</div>` : ''}
      ${discrepancies}${warnings}${recipients}${note}${failure}
      ${foot}
    </div>`;
  }

  function findProposal(id) {
    for (const message of state.conv.messages) {
      const proposal = (message.proposals || []).find((entry) => entry.id === id);
      if (proposal) return { message, proposal };
    }
    return null;
  }

  function setAction(id, patch) {
    state.conv.actions.set(id, { ...(state.conv.actions.get(id) || {}), ...patch });
    const found = findProposal(id);
    if (found) patchMessage(found.message);
    contributeHome();
  }

  async function approve(id) {
    const found = findProposal(id);
    if (!found) return;
    const current = actionState(found.proposal);
    if (!canApprove(current) || current.working) return;
    setAction(id, { working: true, status: 'executing', failureText: null });
    announce('Working on it.');
    try {
      const result = await request('execute-action', { method: 'POST', body: { action_id: id } });
      if (result?.ok === true) {
        setAction(id, { working: false, status: 'executed', result: result.result || {}, action: result.action || null });
        announce(`${kindInfo(found.proposal.kind).done}.`);
      } else {
        root.console?.warn?.('[atlas-ai] proposal failed', result?.error?.code || 'failed');
        const code = result?.error?.code;
        const text = code === 'forbidden' ? 'Your role can’t approve this. Nothing was changed.'
          : code === 'draft_exists' ? 'This supplier already has a Draft order, so nothing new was created. Ask Atlas to add these lines to that draft.'
          : code === 'conflict' ? 'Something changed since Atlas prepared this. Nothing was changed. Ask Atlas to prepare it again.'
            : code === 'not_found' ? 'A record in this proposal no longer exists. Nothing was changed. Ask Atlas to prepare it again.'
              : 'Nothing was changed. Ask Atlas to prepare it again, or make the change in its page.';
        setAction(id, { working: false, status: 'failed', failureText: text, retryable: false });
        announce('This couldn’t be completed.');
      }
    } catch (error) {
      if (error?.code === 'network' || error?.status === 0) {
        setAction(id, { working: false, status: 'failed', failureText: 'Atlas couldn’t confirm the result. Check the page before trying again, so nothing is done twice.', retryable: true });
      } else if (error?.code === 'conflict') {
        setAction(id, { working: false, status: 'failed', failureText: 'This proposal was already handled or has expired. Nothing else was changed.', retryable: false });
        refreshActions();
      } else {
        setAction(id, { working: false, status: 'failed', failureText: friendly(error, 'This'), retryable: error?.code !== 'forbidden' });
      }
      announce('This couldn’t be completed.');
    }
  }

  async function dismiss(id) {
    const found = findProposal(id);
    if (!found) return;
    const info = kindInfo(found.proposal.kind);
    if (!info.executable && !canApprove(found.proposal)) { setAction(id, { status: 'dismissed' }); return; }
    setAction(id, { working: true });
    try {
      await request('reject-action', { method: 'POST', body: { action_id: id } });
      setAction(id, { working: false, status: 'rejected' });
      announce('Dismissed.');
    } catch (error) {
      setAction(id, { working: false });
      toast(friendly(error, 'Dismissing'));
    }
  }

  function editProposal(id) {
    const found = findProposal(id);
    if (!found) return;
    const input = el('input');
    input.value = `Change the ${humanText(found.proposal.title, 'proposal').replace(/^\w/, (c) => c.toLowerCase())}: `;
    autoGrow();
    renderComposerBar();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async function refreshActions() {
    if (!state.conv.id) return;
    try {
      const payload = await request('conversation', { params: { id: state.conv.id, limit: 1 } });
      (payload?.actions || []).forEach((action) => state.conv.actions.set(action.id, { ...(state.conv.actions.get(action.id) || {}), status: action.status, result: action.result, expires_at: action.expires_at, working: false }));
      renderThread();
    } catch { /* keep what is shown */ }
  }

  // ---------- conversation loading ----------

  function fromServerMessage(message) {
    return {
      key: message.id || uid('m'),
      id: message.id || null,
      role: message.role === 'tool' ? 'system_note' : message.role,
      content: message.content || '',
      status: message.status === 'streaming' ? 'stopped' : (message.status || 'complete'),
      attachments: (message.attachments || []).map((attachment) => ({ kind: attachment.kind, name: attachment.name, media_id: attachment.media_id })),
      evidence: message.evidence || [],
      records: message.records || [],
      proposals: message.proposals || [],
      source: message.source || 'text',
      metadata: message.metadata || {},
      progress: [],
      error: message.status === 'error' ? { title: 'Atlas couldn’t finish this answer.', body: 'Nothing was changed.' } : null,
      created_at: message.created_at
    };
  }

  async function openConversation(id, { route = false } = {}) {
    if (!id) return;
    if (state.streaming) stopStreaming();
    closeListSheet();
    if (state.conv.id === id && state.conv.messages.length && !state.conv.error) { renderThread(); if (route) routeTo({ conversation: id }); return; }
    state.mode = 'conversations';
    state.conv = { id, title: findConversation(id)?.title || '', pinned: Boolean(findConversation(id)?.pinned), messages: [], actions: new Map(), loading: true, error: null };
    applyMode();
    renderThread();
    renderList();
    if (route) routeTo({ conversation: id });
    try {
      const payload = await request('conversation', { params: { id, limit: 50 } });
      if (state.conv.id !== id) return;
      state.conv.title = payload?.conversation?.title || state.conv.title;
      state.conv.pinned = Boolean(payload?.conversation?.pinned);
      state.conv.messages = (payload?.messages || []).map(fromServerMessage);
      (payload?.actions || []).forEach((action) => state.conv.actions.set(action.id, { status: action.status, result: action.result, expires_at: action.expires_at }));
      state.conv.loading = false;
      renderThread();
      scrollToBottom(true);
      contributeHome();
    } catch (error) {
      if (state.conv.id !== id) return;
      state.conv.loading = false;
      state.conv.error = error;
      if (error?.code === 'not_configured') state.configured = false;
      renderThread();
    }
  }

  function newConversation({ route = false, context = null, focus = true } = {}) {
    if (state.streaming) stopStreaming();
    closeListSheet();
    state.mode = 'conversations';
    state.conv = { id: null, title: '', pinned: false, messages: [], actions: new Map(), loading: false, error: null };
    state.composer.context = context;
    applyMode();
    renderThread();
    renderList();
    renderComposerBar();
    if (route) routeTo({ new: '1' });
    if (focus && !isPhone()) root.requestAnimationFrame(() => el('input')?.focus());
  }

  function routeTo(params) {
    if (!root.AtlasShell || !state.visible) return;
    const href = root.AtlasShell.href('ai', params);
    if (root.location.hash === href) return;
    try { root.history.pushState(null, '', href); } catch { /* history unavailable */ }
    state.lastParams = { ...params };
  }

  async function ensureConversation() {
    if (state.conv.id) return state.conv.id;
    const created = await request('create', { method: 'POST', body: {} });
    const id = created?.id || created?.conversation?.id;
    if (!id) throw new AiError(500, 'failed', 'The conversation could not be started.');
    state.conv.id = id;
    state.list.items.unshift({ id, title: null, pinned: false, last_message_at: new Date().toISOString(), created_at: new Date().toISOString() });
    routeTo({ conversation: id });
    renderList();
    renderThreadHead();
    return id;
  }

  // ---------- sending and streaming ----------

  function pageContextPayload() {
    const context = state.composer.context;
    if (!context) return undefined;
    return { view: context.view || null, entity: { type: context.type, id: context.id, label: context.label } };
  }

  async function send(options = {}) {
    if (state.streaming || state.composer.transcribing) return;
    const input = el('input');
    const text = (options.text ?? input.value).trim();
    const uploading = state.composer.attachments.some((attachment) => attachment.status === 'uploading');
    if (uploading) { toast('Wait for the files to finish uploading.'); return; }
    const ready = state.composer.attachments.filter((attachment) => attachment.status === 'ready');
    if (!text && !options.regenerate) {
      if (ready.length) { input.focus(); toast('Add a question about the attachment.'); }
      return;
    }
    if (!navigator.onLine) { toast('You’re offline. Atlas AI needs a connection.'); return; }
    const modelBytes = ready.filter((attachment) => attachment.kind === 'image' || attachment.kind === 'pdf').reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0);
    if (!options.regenerate && modelBytes > MAX_TURN_ATTACHMENT_BYTES) { toast(FIXED_COPY.attachments_too_large); return; }

    if (state.configured === false || !endpoint()) { answerLocally(text); return; }

    const source = options.source || state.composer.source || 'text';
    const duration = state.composer.duration;
    const context = pageContextPayload();
    const userMessage = options.regenerate ? null : {
      key: uid('u'), id: null, role: 'user', content: text, status: 'complete', source,
      attachments: ready.map((attachment) => ({ kind: attachment.kind, name: attachment.name, preview: attachment.preview, media_id: attachment.media?.id })),
      metadata: { ...(duration != null ? { duration_seconds: duration } : {}), ...(context ? { page_context: context } : {}) }
    };
    const reply = { key: uid('a'), id: null, role: 'assistant', content: '', status: 'streaming', progress: [], evidence: [], records: [], proposals: [], started: Date.now() };

    if (userMessage) state.conv.messages.push(userMessage);
    state.conv.messages.push(reply);
    if (!options.regenerate) {
      input.value = '';
      state.composer.attachments = [];
      state.composer.source = 'text';
      state.composer.duration = null;
      autoGrow();
      renderAttachments();
    }
    renderThread();
    scrollToBottom(true);

    const controller = new AbortController();
    state.streaming = { controller, reply };
    renderComposerBar();
    announce('Atlas is answering.');

    let conversationId;
    try {
      conversationId = await ensureConversation();
    } catch (error) {
      state.streaming = null;
      if (error?.code === 'not_configured') { dropTurn(userMessage, reply); switchOffAndAnswer(text); return; }
      failReply(reply, error);
      renderComposerBar();
      return;
    }

    const body = {
      conversation_id: conversationId,
      message: options.regenerate ? '' : text,
      client_request_id: uid('turn'),
      source,
      ...(options.regenerate ? { regenerate: true } : {}),
      ...(ready.length && !options.regenerate ? { attachments: ready.map((attachment) => attachment.media?.id).filter(Boolean) } : {}),
      ...(context && !options.regenerate ? { page_context: context } : {}),
      ...(duration != null && !options.regenerate ? { duration } : {})
    };
    if (!options.regenerate) state.composer.context = null;
    renderComposerBar();

    let finished = false;
    let textFrame = 0;
    const flushText = () => {
      textFrame = 0;
      const node = messageNode(reply);
      const target = node?.querySelector('[data-ai-text]');
      if (!target) { patchMessage(reply); return; }
      target.hidden = false;
      node.querySelector('.ai-skel-lines')?.remove();
      target.innerHTML = formatAnswer(reply.content);
      scrollToBottom();
    };
    const onEvent = ({ event, data }) => {
      if (event === 'progress') {
        const label = progressLabel(data?.label);
        const last = reply.progress.at(-1);
        if (last && !last.ms) last.ms = Date.now() - last.at;
        if (!last || last.label !== label) reply.progress.push({ label, at: Date.now() });
        patchMessage(reply);
      } else if (event === 'delta') {
        reply.content += String(data?.text || '');
        if (!textFrame) textFrame = root.requestAnimationFrame(flushText);
      } else if (event === 'evidence') {
        reply.evidence = Array.isArray(data?.items) ? data.items : [];
      } else if (event === 'records') {
        reply.records = Array.isArray(data?.items) ? data.items : [];
      } else if (event === 'proposal') {
        if (data?.id && !reply.proposals.some((proposal) => proposal.id === data.id)) {
          reply.proposals.push(data);
          if (data.supersedes) state.conv.actions.set(data.supersedes, { status: 'rejected' });
        }
        patchMessage(reply);
      } else if (event === 'done') {
        finished = true;
        if (textFrame) root.cancelAnimationFrame(textFrame);
        reply.content = typeof data?.content === 'string' ? data.content : reply.content;
        reply.id = data?.message_id || reply.id;
        reply.status = 'complete';
        // The server replaced a figure it could not support with its safe
        // answer; show exactly that, never a client-side completion.
        reply.grounding = data?.grounding === 'replaced_unverified' ? 'replaced' : 'ok';
        const last = reply.progress.at(-1);
        if (last && !last.ms) last.ms = Date.now() - last.at;
        if (userMessage && data?.user_message_id) userMessage.id = data.user_message_id;
        if (data?.conversation_id && data.conversation_id !== state.conv.id) state.conv.id = data.conversation_id;
      } else if (event === 'error') {
        finished = true;
        if (textFrame) root.cancelAnimationFrame(textFrame);
        failReply(reply, new AiError(0, data?.code || 'failed', data?.message), { render: false });
      }
    };

    try {
      const response = await request('chat', { method: 'POST', body, signal: controller.signal, stream: true });
      await readEventStream(response, onEvent);
      if (!finished && reply.status === 'streaming') failReply(reply, new AiError(0, 'incomplete', ''), { render: false });
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        reply.status = 'stopped';
      } else if (error?.code === 'not_configured') {
        dropTurn(userMessage, reply);
        state.streaming = null;
        switchOffAndAnswer(text);
        return;
      } else {
        failReply(reply, error, { render: false });
      }
    }
    if (state.streaming?.reply === reply) state.streaming = null;
    if (reply.status === 'streaming') reply.status = 'complete';
    patchMessage(reply);
    renderComposerBar();
    scrollToBottom();
    announce(reply.status === 'complete' ? 'Atlas answered.' : reply.status === 'stopped' ? 'Stopped.' : 'Atlas couldn’t finish this answer.');
    afterTurn();
  }

  function dropTurn(...messages) {
    state.conv.messages = state.conv.messages.filter((message) => !messages.includes(message));
  }

  function failReply(reply, error, { render = true } = {}) {
    reply.status = 'error';
    const specific = ['rate_limited', 'busy', 'timeout', 'too_many_steps', 'network', 'forbidden', 'message_too_long', 'unauthorized', 'attachments_too_large', 'too_large', 'upload_quota_exceeded'].includes(error?.code);
    reply.error = {
      title: 'Atlas couldn’t finish this answer. Nothing was changed.',
      body: specific ? friendly(error, 'This question') : ''
    };
    if (render) patchMessage(reply);
  }

  function stopStreaming() {
    const current = state.streaming;
    if (!current) return;
    current.controller.abort();
    current.reply.status = 'stopped';
    state.streaming = null;
    patchMessage(current.reply);
    renderComposerBar();
  }

  function regenerate(key) {
    if (state.streaming) return;
    const index = state.conv.messages.findIndex((message) => message.key === key);
    if (index < 0) return;
    const message = state.conv.messages[index];
    if (message.fallback) return;
    state.conv.messages.splice(index, 1);
    const previousUser = [...state.conv.messages].reverse().find((entry) => entry.role === 'user');
    // A reply whose question never reached the server is re-sent as a question.
    if (!state.conv.id && previousUser) {
      state.conv.messages.splice(state.conv.messages.indexOf(previousUser), 1);
      renderThread();
      send({ text: previousUser.content, source: previousUser.source });
      return;
    }
    renderThread();
    send({ regenerate: true });
  }

  async function afterTurn() {
    const id = state.conv.id;
    if (!id) return;
    const item = state.list.items.find((entry) => entry.id === id);
    if (item) item.last_message_at = new Date().toISOString();
    // Title the conversation from its first question (editable afterwards).
    if (!state.conv.title) {
      const first = state.conv.messages.find((message) => message.role === 'user');
      if (first) {
        let title = first.content.replace(/\s+/g, ' ').trim();
        if (title.length > 60) title = `${title.slice(0, 57).replace(/\s+\S*$/, '')}…`;
        state.conv.title = title;
        if (item) item.title = title;
        renderThreadHead();
        request('rename', { method: 'POST', body: { conversation_id: id, title } }).catch(() => {});
      }
    }
    renderList();
    contributeHome();
    loadList({ quiet: true });
  }

  // Atlas AI is off: truthful state plus the deterministic answers from search.
  function switchOffAndAnswer(text) {
    state.configured = false;
    renderList();
    answerLocally(text);
  }

  async function answerLocally(text) {
    const reply = { key: uid('a'), role: 'assistant', content: '', status: 'complete', fallback: true, progress: [], evidence: [], records: [], proposals: [] };
    state.conv.messages.push({ key: uid('u'), role: 'user', content: text, status: 'complete', source: 'text', attachments: [], metadata: {} });
    el('input').value = '';
    autoGrow();
    let answer = null;
    try { answer = await root.AtlasSearch?.answerFor?.(text); } catch { answer = null; }
    if (answer) {
      reply.content = answer.text;
      reply.fallbackLines = answer.lines || [];
      reply.fallbackAction = answer.action && typeof answer.action.run === 'function' ? answer.action : null;
    } else {
      reply.content = 'Atlas AI is off, so I can’t answer that yet. Quick answers work for questions like “What is low in stock?”, “What needs ordering?”, “Can we make a Margarita?” or “Who works tomorrow?”. You can also search for an item, recipe or supplier.';
    }
    state.conv.messages.push(reply);
    renderThread();
    renderComposerBar();
    scrollToBottom(true);
  }

  // ---------- attachments ----------

  function attachmentKind(file) {
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type === 'application/pdf') return 'pdf';
    return 'document';
  }

  function addFiles(files) {
    if (!files.length) return;
    if (state.configured === false) { toast('Photos and files need Atlas AI to be switched on.'); return; }
    const room = MAX_ATTACHMENTS - state.composer.attachments.length;
    if (room <= 0) { toast(`Attach up to ${MAX_ATTACHMENTS} files per message.`); return; }
    files.slice(0, room).forEach((file) => {
      const attachment = { key: uid('f'), name: file.name || 'Photo', size: file.size, kind: attachmentKind(file), status: 'uploading', progress: 0, file, preview: null, media: null, error: null };
      if (attachment.kind === 'image' && root.URL?.createObjectURL) attachment.preview = root.URL.createObjectURL(file);
      if (file.size > MAX_UPLOAD_BYTES) { attachment.status = 'error'; attachment.error = 'This file is larger than 25 MB.'; }
      state.composer.attachments.push(attachment);
      if (attachment.status === 'uploading') upload(attachment);
    });
    if (files.length > room) toast(`Attach up to ${MAX_ATTACHMENTS} files per message.`);
    renderAttachments();
    renderComposerBar();
  }

  async function upload(attachment) {
    try {
      const conversationId = await ensureConversation();
      const form = new FormData();
      form.append('file', attachment.file, attachment.name);
      form.append('conversation_id', conversationId);
      attachment.cancel = {};
      const payload = await uploadWithProgress('upload', form, (fraction) => {
        attachment.progress = fraction;
        const bar = el('attachments')?.querySelector(`[data-ai-att="${attachment.key}"] .file-chip__progress > span`);
        if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
      }, attachment.cancel);
      attachment.media = payload?.media || null;
      attachment.status = attachment.media?.id ? 'ready' : 'error';
      if (!attachment.media?.id) attachment.error = 'This file couldn’t be added. Try again.';
    } catch (error) {
      if (error?.name === 'AbortError') return;
      attachment.status = 'error';
      if (error?.code === 'not_configured') {
        state.configured = false;
        attachment.error = 'Photos and files need Atlas AI to be switched on.';
        renderThread();
      } else attachment.error = friendly(error, 'The upload');
    }
    renderAttachments();
    renderComposerBar();
  }

  function removeAttachment(key) {
    const index = state.composer.attachments.findIndex((attachment) => attachment.key === key);
    if (index < 0) return;
    const [removed] = state.composer.attachments.splice(index, 1);
    removed.cancel?.abort?.();
    renderAttachments();
    renderComposerBar();
    el('input').focus();
  }

  function renderAttachments() {
    const container = el('attachments');
    if (!container) return;
    const voiceChip = state.composer.source === 'voice_note'
      ? `<span class="file-chip file-chip--voice">${icon('mic')}Voice note${state.composer.duration ? ` · ${durationLabel(state.composer.duration)}` : ''}<button type="button" class="file-chip__x" data-ai-voice-clear aria-label="Remove voice note label">${icon('x')}</button></span>` : '';
    const chips = state.composer.attachments.map((attachment) => {
      const thumb = attachment.preview ? `<img src="${escapeHtml(attachment.preview)}" alt="">` : icon(attachment.kind === 'image' ? 'image' : 'file-text');
      const status = attachment.status === 'uploading' ? `<span class="file-chip__progress" role="progressbar" aria-label="Uploading ${escapeHtml(attachment.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(attachment.progress * 100)}"><span style="width:${Math.round(attachment.progress * 100)}%"></span></span>`
        : attachment.status === 'error' ? `<span class="file-chip__error">${escapeHtml(attachment.error)}</span>` : `<span class="file-chip__meta">${escapeHtml(bytesLabel(attachment.size))}</span>`;
      return `<span class="file-chip file-chip--upload${attachment.status === 'error' ? ' is-error' : ''}" data-ai-att="${escapeHtml(attachment.key)}"><span class="file-chip__thumb">${thumb}</span><span class="file-chip__body"><span class="file-chip__name">${escapeHtml(attachment.name)}</span>${status}</span><button type="button" class="file-chip__x" data-ai-remove-att="${escapeHtml(attachment.key)}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`;
    }).join('');
    container.innerHTML = voiceChip + chips;
    container.hidden = !(voiceChip || chips);
    const prompts = el('prompts');
    const hasPhoto = state.composer.attachments.some((attachment) => attachment.kind === 'image');
    if (prompts) {
      prompts.hidden = !hasPhoto || Boolean(el('input').value.trim());
      prompts.innerHTML = hasPhoto ? ['Does this match our order?', 'Count these bottles', 'What is this?'].map((text) => `<button type="button" class="atlas-chip" data-ai-prompt="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('') : '';
    }
  }

  // ---------- composer bar ----------

  function renderComposerBar() {
    const bar = el('bar');
    if (!bar) return;
    const streaming = Boolean(state.streaming);
    const offline = !navigator.onLine;
    const text = el('input').value.trim();
    const uploading = state.composer.attachments.some((attachment) => attachment.status === 'uploading');
    const off = state.configured === false || !endpoint();
    const voice = root.AtlasAIVoice?.supported?.() || { voiceNote: false, liveVoice: false };
    const context = state.composer.context;
    const sendDisabled = streaming ? false : (!text || uploading || offline || state.composer.transcribing);
    bar.innerHTML = `
      <button type="button" class="atlas-icon-btn" data-ai-attach aria-label="Add photo or file" aria-haspopup="menu"${off || offline ? ' disabled title="Photos and files need Atlas AI"' : ''}>${icon('plus', 'icon--md')}</button>
      ${context ? `<span class="composer__ctx">${icon(recordIcon(context.type))}<span>${escapeHtml(context.label)}</span><button type="button" class="composer__ctx-x" data-ai-clear-context aria-label="Remove ${escapeHtml(context.label)} from this question">${icon('x')}</button></span>` : ''}
      <span class="spacer"></span>
      ${voice.voiceNote ? `<button type="button" class="atlas-icon-btn" data-ai-voice-note aria-label="Record a voice note"${off || offline || streaming ? ' disabled' : ''}>${icon('mic', 'icon--md')}</button>` : ''}
      ${voice.liveVoice ? `<button type="button" class="atlas-icon-btn" data-ai-live aria-label="Talk to Atlas"${off || offline || streaming || state.live ? ' disabled' : ''}>${icon('audio-lines', 'icon--md')}</button>` : ''}
      ${streaming
        ? `<button type="button" class="send send--stop" data-ai-stop aria-label="Stop generating">${icon('square')}</button>`
        : `<button type="submit" class="send" aria-label="Send"${sendDisabled ? ' disabled' : ''}>${icon('arrow-up')}</button>`}`;
    el('input').disabled = offline;
    el('input').placeholder = offline ? 'You’re offline. Atlas AI needs a connection.' : 'Ask Atlas about stock, recipes, shifts…';
    el('composer').classList.toggle('is-offline', offline);
    el('hint').textContent = off
      ? 'Atlas AI is off. Quick answers come from your stock, recipes and shifts.'
      : 'Atlas prepares changes for you to approve. It never changes stock, orders or shifts on its own.';
    const prompts = el('prompts');
    if (prompts && text) prompts.hidden = true;
  }

  function attachMenu(trigger) {
    const phone = isPhone() || Boolean(root.matchMedia?.('(pointer: coarse)')?.matches);
    openMenu(trigger, [
      ...(phone ? [{ label: 'Take photo', icon: 'camera', run: () => el('fileCamera').click() }] : []),
      { label: phone ? 'Choose from library' : 'Choose photo', icon: 'image', run: () => el('filePhoto').click() },
      { label: 'Attach file', icon: 'paperclip', run: () => el('fileAny').click() }
    ]);
  }

  // ---------- voice note ----------

  async function startVoiceNote() {
    if (state.composer.voiceNote || state.streaming) return;
    const recorder = root.AtlasAIVoice.createVoiceNote({ onLevel: (level) => updateLevel(level) });
    state.composer.voiceNote = recorder;
    try {
      await recorder.start();
    } catch (error) {
      state.composer.voiceNote = null;
      toast(error?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings to record.' : 'Recording couldn’t start on this device.');
      return;
    }
    el('bar').hidden = true;
    const record = el('record');
    record.hidden = false;
    record.innerHTML = `<span class="rec-dot" aria-hidden="true"></span><span class="rec-time" data-ai-rec-time aria-live="off">0:00</span>
      <span class="rec-level" aria-hidden="true">${'<i></i>'.repeat(12)}</span><span class="sr-only" aria-live="polite">Recording</span>
      <span class="spacer"></span>
      <button type="button" class="atlas-icon-btn" data-ai-rec-cancel aria-label="Cancel recording">${icon('x', 'icon--md')}</button>
      <button type="button" class="send" data-ai-rec-stop aria-label="Stop and transcribe">${icon('check')}</button>`;
    record.querySelector('[data-ai-rec-stop]').focus();
    state.recTimer = root.setInterval(() => {
      const seconds = recorder.elapsed();
      const time = record.querySelector('[data-ai-rec-time]');
      if (time) time.textContent = durationLabel(seconds);
      if (seconds >= recorder.maxSeconds) stopVoiceNote();
    }, 250);
  }

  function updateLevel(level) {
    const bars = el('record')?.querySelectorAll('.rec-level i');
    if (!bars?.length) return;
    const now = Date.now();
    bars.forEach((bar, index) => {
      const wobble = reducedMotion() ? 0.5 : (Math.sin(now / 120 + index) + 1) / 2;
      bar.style.height = `${Math.max(4, Math.round(4 + level * 20 * (0.4 + wobble * 0.6)))}px`;
    });
  }

  function resetRecordBar() {
    root.clearInterval(state.recTimer);
    el('record').hidden = true;
    el('record').innerHTML = '';
    el('bar').hidden = false;
    state.composer.voiceNote = null;
    renderComposerBar();
  }

  function cancelVoiceNote() {
    state.composer.voiceNote?.cancel();
    resetRecordBar();
    el('input').focus();
  }

  async function stopVoiceNote() {
    const recorder = state.composer.voiceNote;
    if (!recorder) return;
    root.clearInterval(state.recTimer);
    const recording = await recorder.stop();
    el('record').innerHTML = `${icon('loader-circle', 'icon--spin')}<span>Transcribing…</span>`;
    state.composer.transcribing = true;
    announce('Transcribing your voice note.');
    try {
      if (!recording?.blob?.size) throw new AiError(400, 'empty', 'Nothing was recorded.');
      const conversationId = await ensureConversation();
      const form = new FormData();
      const extension = /mp4/.test(recording.mime) ? 'm4a' : /ogg/.test(recording.mime) ? 'ogg' : 'webm';
      form.append('file', recording.blob, `voice-note.${extension}`);
      form.append('conversation_id', conversationId);
      const result = await request('transcribe', { method: 'POST', form });
      const transcript = String(result?.text || '').trim();
      if (!transcript) throw new AiError(200, 'empty', 'No speech was found.');
      const input = el('input');
      input.value = input.value.trim() ? `${input.value.trim()} ${transcript}` : transcript;
      state.composer.source = 'voice_note';
      state.composer.duration = Number(result?.duration) || recording.duration || null;
      announce('Transcript ready. Check it, then send.');
    } catch (error) {
      if (error?.code === 'not_configured') state.configured = false;
      toast(error?.code === 'empty' ? 'No speech was heard. Try recording again.' : friendly(error, 'Transcribing'));
    } finally {
      state.composer.transcribing = false;
      resetRecordBar();
      renderAttachments();
      autoGrow();
      renderComposerBar();
      el('input').focus();
    }
  }

  // ---------- live voice ----------

  const LIVE_LABELS = {
    connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', muted: 'Muted',
    interrupted: 'Listening', disconnected: 'Disconnected', error: 'Couldn’t connect', ended: 'Ended', reconnecting: 'Reconnecting',
    inactive: 'Session ended'
  };

  function liveErrorText(detail = {}) {
    if (detail.code === 'microphone_blocked') return 'Microphone access is blocked. Allow it in your browser settings, then try again.';
    if (detail.code === 'voice_quota_exceeded' || detail.code === 'rate_limited') return friendly({ code: detail.code, reason: detail.reason });
    if (detail.code === 'unsupported') return 'Live voice isn’t supported in this browser. Voice notes and text still work.';
    return 'Live voice couldn’t connect. Your conversation is saved.';
  }

  function liveMarkup() {
    const live = state.live;
    if (!live) return '';
    const status = live.state;
    const label = LIVE_LABELS[status] || 'Connecting';
    const lines = live.lines.slice(-2).map((line) => `<span class="${line.final ? 'is-final' : 'is-interim'}${line.role === 'assistant' ? ' is-atlas' : ''}">${escapeHtml(line.text)}</span>`).join(' ');
    const broken = status === 'disconnected' || status === 'error' || status === 'inactive';
    const retryable = !(status === 'error' && live.blocked);
    return `<div class="voice" role="region" aria-label="Live voice" data-state="${escapeHtml(status)}">
      <div class="voice__top"><span class="voice__state" aria-live="polite">${escapeHtml(label)}</span><span class="voice__time" data-ai-live-time>${durationLabel((Date.now() - live.startedAt) / 1000)}</span>
        <button type="button" class="voice__toggle" data-ai-live-transcript aria-pressed="${live.showTranscript}">${live.showTranscript ? 'Hide transcript' : 'Show transcript'}</button></div>
      ${broken ? `<div class="voice__error" role="alert">${escapeHtml(status === 'inactive' ? FIXED_COPY.voice_session_inactive : status === 'error' && live.errorText ? live.errorText : 'Live voice disconnected. Your conversation is saved.')}</div>` : `<div class="voice__wave" aria-hidden="true">${'<i></i>'.repeat(18)}</div>`}
      ${live.showTranscript && lines ? `<div class="voice__transcript">${lines}</div>` : ''}
      <div class="voice__controls">
        ${broken
          ? (retryable ? `<button type="button" data-ai-live-reconnect>${icon('refresh-cw')}${status === 'inactive' ? 'Start a new session' : status === 'error' ? 'Try again' : 'Reconnect'}</button>` : '')
          : `<button type="button" data-ai-live-mute aria-pressed="${status === 'muted'}">${icon(status === 'muted' ? 'mic' : 'mic-off')}${status === 'muted' ? 'Unmute' : 'Mute'}</button>`}
        <button type="button" class="end" data-ai-live-end>${icon('phone-off')}End</button>
      </div>
    </div>`;
  }

  function renderLive() {
    const slot = el('voiceSlot');
    if (!slot) return;
    slot.innerHTML = liveMarkup();
    state.root.classList.toggle('is-voice', Boolean(state.live));
    syncTabBar();
  }

  function waveLoop() {
    const live = state.live;
    if (!live) return;
    const bars = el('voiceSlot')?.querySelectorAll('.voice__wave i');
    const time = el('voiceSlot')?.querySelector('[data-ai-live-time]');
    if (time) time.textContent = durationLabel((Date.now() - live.startedAt) / 1000);
    if (bars?.length) {
      const level = live.session?.level?.() || 0;
      const active = ['listening', 'speaking', 'interrupted'].includes(live.state);
      const now = Date.now();
      bars.forEach((bar, index) => {
        const motion = reducedMotion() ? 0.5 : (Math.sin(now / 140 + index * 0.9) + 1) / 2;
        const height = active ? 5 + Math.round((level * 22 + 4) * motion) : 5;
        bar.style.height = `${Math.min(28, height)}px`;
      });
    }
    live.frame = root.requestAnimationFrame(waveLoop);
  }

  async function startLive({ skipExplain = false } = {}) {
    if (state.live || state.streaming) return;
    let explained = false;
    try { explained = root.localStorage?.getItem(VOICE_EXPLAINED_KEY) === 'yes'; } catch { explained = false; }
    if (!explained && !skipExplain) {
      const ok = await confirmDialog({
        title: 'Talk to Atlas',
        body: 'Atlas listens only while this panel is open. Anything Atlas prepares appears as a card for you to approve with a tap. Your browser asks for the microphone next.',
        confirm: 'Start talking'
      });
      if (!ok) return;
      try { root.localStorage?.setItem(VOICE_EXPLAINED_KEY, 'yes'); } catch { /* per-device reminder only */ }
    }
    let conversationId = null;
    try { conversationId = await ensureConversation(); } catch (error) {
      if (error?.code === 'not_configured') { state.configured = false; renderThread(); renderComposerBar(); return; }
      toast(friendly(error, 'Live voice'));
      return;
    }
    const live = { state: 'connecting', startedAt: Date.now(), lines: [], showTranscript: true, errorText: '', blocked: false, session: null, frame: 0, liveMessage: null };
    state.live = live;
    renderLive();
    renderComposerBar();
    // Read once so voice-end can still be sent while the page unloads.
    const exitToken = await accessToken();
    const session = root.AtlasAIVoice.createLiveVoice({
      request,
      sendOnExit: (action, body) => requestOnExit(exitToken, action, body),
      conversationId,
      onState: (next, detail) => {
        if (state.live !== live) return;
        live.state = next;
        if (next === 'error') {
          live.errorText = liveErrorText(detail || {});
          // Daily limits do not lift by retrying now; offer no retry for them.
          live.blocked = detail?.code === 'voice_quota_exceeded' && detail?.reason !== 'concurrent';
          if (detail?.code === 'not_configured') { state.configured = false; renderThread(); }
        }
        if (next === 'inactive') announce(FIXED_COPY.voice_session_inactive);
        if (next === 'ended') { finishLive(); return; }
        renderLive();
      },
      onTranscript: (line) => {
        if (state.live !== live) return;
        const existing = live.lines.find((entry) => entry.id === line.id && entry.role === line.role);
        if (existing) Object.assign(existing, line); else live.lines.push({ ...line });
        if (line.final) addVoiceTurn(line);
        const transcript = el('voiceSlot')?.querySelector('.voice__transcript');
        if (transcript || live.showTranscript) renderLive();
      },
      onProposal: (proposal) => addVoiceProposal(proposal),
      onRecords: (records, evidence) => {
        const reply = lastVoiceReply();
        if (!reply) return;
        reply.records = [...(reply.records || []), ...records].slice(0, 40);
        reply.evidence = [...(reply.evidence || []), ...evidence].slice(0, 40);
        patchMessage(reply);
      },
      onError: (problem) => { if (problem?.code === 'rate_limited') toast('Live voice is going faster than Atlas allows. Wait a moment before the next request.'); }
    });
    live.session = session;
    waveLoop();
    try {
      await session.start();
    } catch (error) {
      // The panel shows fixed copy for the reason; the console keeps the code.
      root.console?.warn?.('[atlas-ai] live voice could not start', error?.code || error?.name || 'error', error?.status || '');
      if (state.live === live && live.state === 'error') {
        live.errorText = liveErrorText({ code: error?.name === 'NotAllowedError' ? 'microphone_blocked' : error?.code, reason: error?.reason });
        live.blocked = error?.code === 'voice_quota_exceeded' && error?.reason !== 'concurrent';
        if (error?.code === 'not_configured') { state.configured = false; renderThread(); }
        renderLive();
      }
    }
  }

  function lastVoiceReply() {
    return [...state.conv.messages].reverse().find((message) => message.role === 'assistant' && message.source === 'live_voice') || null;
  }

  function addVoiceTurn(line) {
    const text = String(line.text || '').trim();
    if (!text) return;
    const key = `voice-${line.role}-${line.id}`;
    if (state.conv.messages.some((message) => message.key === key)) return;
    const message = line.role === 'user'
      ? { key, role: 'user', content: text, status: 'complete', source: 'live_voice', attachments: [], metadata: {} }
      : { key, role: 'assistant', content: text, status: 'complete', source: 'live_voice', progress: [], evidence: [], records: [], proposals: [] };
    state.conv.messages.push(message);
    renderThread();
    scrollToBottom();
  }

  function addVoiceProposal(proposal) {
    if (!proposal?.id) return;
    let reply = lastVoiceReply();
    if (!reply) {
      reply = { key: uid('voice-a'), role: 'assistant', content: '', status: 'complete', source: 'live_voice', progress: [], evidence: [], records: [], proposals: [] };
      state.conv.messages.push(reply);
    }
    if (!reply.proposals.some((entry) => entry.id === proposal.id)) reply.proposals.push(proposal);
    renderThread();
    scrollToBottom(true);
    announce(`Atlas prepared ${humanText(proposal.title, 'a change')}. Review the card to approve it.`);
  }

  function finishLive() {
    const live = state.live;
    if (!live) return;
    root.cancelAnimationFrame(live.frame);
    state.live = null;
    renderLive();
    renderComposerBar();
    afterTurn();
    el('input')?.focus();
  }

  async function endLive() {
    const live = state.live;
    if (!live) return;
    if (live.session) await live.session.end();
    finishLive();
  }

  // ---------- Decisions (manager ledger over the decision memory) ----------

  function decisionsEndpoint() {
    return String(root.VABAR_CONFIG?.PHASE3_BRAIN_API || '').trim();
  }

  async function decisionsRequest(action, { method = 'GET', params = null, body = undefined } = {}) {
    const base = decisionsEndpoint();
    if (!base) throw new AiError(503, 'not_configured', '');
    const url = new URL(base);
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([key, value]) => { if (value != null && value !== '') url.searchParams.set(key, String(value)); });
    const token = await accessToken();
    if (!token) throw new AiError(401, 'unauthorized', '');
    let response;
    try {
      response = await root.fetch(url, { method, cache: 'no-store', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new AiError(0, 'network', ''); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      root.console?.warn?.('[atlas-ai] decisions', action, response.status);
      throw new AiError(response.status, response.status === 403 ? 'forbidden' : 'failed', '');
    }
    return payload;
  }

  const AREAS = {
    stock: { label: 'Stock', match: /stock|inventory|count|par|waste/ },
    purchasing: { label: 'Purchasing', match: /purchas|order|supplier|reorder|delivery|cost/ },
    shifts: { label: 'Shifts', match: /shift|labour|labor|rota|staff/ },
    recipes: { label: 'Recipes', match: /recipe|menu|margin/ }
  };

  function areaOf(row) {
    const text = `${row.recommendation_type || ''} ${row.subject_type || ''}`.toLowerCase();
    return Object.keys(AREAS).find((key) => AREAS[key].match.test(text)) || 'other';
  }

  function decisionStatus(row) {
    const status = String(row.status || '').toLowerCase();
    const action = String(row.action || row.decision || '').toLowerCase();
    if (row.kind === 'memory') {
      if (/outcome/.test(action)) return 'done';
      if (/accept|approve|modif/.test(action)) return 'approved';
      if (/reject|dismiss/.test(action)) return 'dismissed';
      if (/defer/.test(action)) return 'proposed';
      return 'done';
    }
    if (status === 'expired') return 'expired';
    if (status === 'accepted' || status === 'approved' || status === 'modified') return 'approved';
    if (status === 'rejected') return 'dismissed';
    return 'proposed';
  }

  const DECISION_PILLS = {
    proposed: ['Proposed', 'info'], approved: ['Approved', 'positive'], dismissed: ['Dismissed', 'neutral'], expired: ['Expired', 'neutral'], done: ['Done', 'positive']
  };

  function decisionRows() {
    const snapshot = state.decisions.snapshot || {};
    const rows = [];
    (snapshot.recommendations || []).forEach((recommendation) => rows.push({
      kind: 'recommendation',
      id: recommendation.id,
      recommendationId: recommendation.id,
      title: humanText(recommendation.title, 'Recommendation'),
      summary: humanText(recommendation.summary, ''),
      evidenceCount: Array.isArray(recommendation.evidence) ? recommendation.evidence.length : 0,
      source: /atlas-ai/i.test(String(recommendation.generated_by || '')) ? 'Atlas AI' : 'Rule',
      status: recommendation.status,
      decidedBy: '',
      when: recommendation.updated_at || recommendation.created_at || recommendation.generated_at || null,
      outcome: recommendation.last_outcome ? humanText(recommendation.last_outcome.notes || recommendation.last_outcome.outcome_status, '') : '',
      recommendation_type: recommendation.recommendation_type,
      subject_type: recommendation.subject_type
    }));
    (snapshot.memory || []).forEach((memory) => rows.push({
      kind: 'memory',
      id: memory.id || uid('mem'),
      recommendationId: memory.context?.recommendation_id || null,
      title: humanText(memory.title, 'Decision'),
      summary: humanText(memory.summary, ''),
      evidenceCount: 0,
      source: /atlas-ai/i.test(JSON.stringify(memory.context || {})) ? 'Atlas AI' : 'Rule',
      action: memory.action,
      decidedBy: humanText(memory.actor_label, ''),
      when: memory.occurred_at,
      outcome: /outcome/i.test(String(memory.action || '')) ? humanText(memory.summary, '') : '',
      recommendation_type: memory.memory_type || memory.subject_type,
      subject_type: memory.subject_type
    }));
    return rows.map((row) => ({ ...row, statusKey: decisionStatus(row), area: areaOf(row) }))
      .sort((a, b) => (Date.parse(b.when || 0) || 0) - (Date.parse(a.when || 0) || 0));
  }

  function filteredDecisions() {
    const { status, area, period } = state.decisions.filter;
    const since = Date.now() - Number(period) * DAY;
    return decisionRows().filter((row) => (status === 'all' || row.statusKey === status)
      && (area === 'all' || row.area === area)
      && (period === 'all' || !row.when || Date.parse(row.when) >= since));
  }

  function renderDecisions() {
    const container = el('decisions');
    if (!container) return;
    if (!isManager()) {
      container.innerHTML = `<div class="ai-decisions__inner"><h1 class="ai-decisions__title" id="ai-decisions-title">Decisions</h1>
        <div class="atlas-empty"><div class="atlas-empty__icon">${icon('lock')}</div><h3>Decisions are for managers</h3><p>Ask a manager or administrator if you need to see what was decided.</p><a class="atlas-btn atlas-btn--secondary" href="#ai" data-ai-route="#ai">Go to Atlas AI</a></div></div>`;
      return;
    }
    const d = state.decisions;
    const filters = `<div class="ai-decisions__toolbar" role="group" aria-label="Filter decisions">
      <label class="sr-only" for="ai-dec-status">Status</label>
      <select id="ai-dec-status" class="atlas-select" data-ai-dec-filter="status">${[['all', 'All statuses'], ['proposed', 'Proposed'], ['approved', 'Approved'], ['dismissed', 'Dismissed'], ['expired', 'Expired'], ['done', 'Done']].map(([value, label]) => `<option value="${value}"${d.filter.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <label class="sr-only" for="ai-dec-area">Area</label>
      <select id="ai-dec-area" class="atlas-select" data-ai-dec-filter="area">${[['all', 'All areas'], ...Object.entries(AREAS).map(([key, value]) => [key, value.label])].map(([value, label]) => `<option value="${value}"${d.filter.area === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <label class="sr-only" for="ai-dec-period">Period</label>
      <select id="ai-dec-period" class="atlas-select" data-ai-dec-filter="period">${[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']].map(([value, label]) => `<option value="${value}"${d.filter.period === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </div>`;
    let body;
    if (d.loading && !d.snapshot) {
      body = `<div class="ai-decisions__skel" aria-busy="true">${'<div class="atlas-skel"></div>'.repeat(6)}<span class="sr-only">Loading decisions</span></div>`;
    } else if (d.error && !d.snapshot) {
      body = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div><div class="atlas-alert__title">Decisions couldn’t be loaded.</div><div>Nothing was changed. Try again, or check your connection.</div></div><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-ai-dec-retry>Try again</button></div>`;
    } else {
      const rows = filteredDecisions();
      if (!rows.length) {
        body = decisionRows().length
          ? `<div class="atlas-empty"><h3>No decisions match these filters</h3><p>Try another status, area or period.</p><button type="button" class="atlas-btn atlas-btn--secondary" data-ai-dec-clear>Clear filters</button></div>`
          : `<div class="atlas-empty"><div class="atlas-empty__icon">${icon('list-checks')}</div><h3>No decisions recorded yet</h3><p>When you approve or dismiss something Atlas suggests, it appears here with what happened next.</p></div>`;
      } else {
        body = `<div class="ai-dec-table" role="table" aria-label="Decisions">
          <div class="ai-dec-row ai-dec-row--head" role="row"><span role="columnheader">Recommendation</span><span role="columnheader">Source</span><span role="columnheader">Status</span><span role="columnheader">Decided by</span><span role="columnheader">When</span><span role="columnheader">Outcome</span></div>
          ${rows.map((row) => {
            const [pillLabel, tone] = DECISION_PILLS[row.statusKey] || DECISION_PILLS.proposed;
            const selected = Boolean(row.recommendationId) && row.recommendationId === d.openId;
            return `<button type="button" class="ai-dec-row${selected ? ' is-selected' : ''}" role="row"${selected ? ' aria-current="true"' : ''} data-ai-dec-open="${escapeHtml(row.recommendationId || '')}" data-ai-dec-key="${escapeHtml(row.id)}"${row.recommendationId ? '' : ' disabled'}>
              <span role="cell" class="ai-dec-row__main"><span class="ai-dec-row__t">${escapeHtml(row.title)}</span><span class="ai-dec-row__m">${escapeHtml(row.summary || (row.evidenceCount ? `${row.evidenceCount} ${row.evidenceCount === 1 ? 'source' : 'sources'}` : ''))}</span></span>
              <span role="cell" class="ai-dec-row__cell" data-label="Source">${escapeHtml(row.source)}</span>
              <span role="cell" class="ai-dec-row__cell"><span class="atlas-pill atlas-pill--${tone}">${pillLabel}</span></span>
              <span role="cell" class="ai-dec-row__cell" data-label="Decided by">${escapeHtml(row.decidedBy || '—')}</span>
              <span role="cell" class="ai-dec-row__cell num" data-label="When">${escapeHtml(row.when ? whenLabel(row.when) : '—')}</span>
              <span role="cell" class="ai-dec-row__cell" data-label="Outcome">${escapeHtml(row.outcome || '—')}</span>
            </button>`;
          }).join('')}
        </div>
        <p class="ai-decisions__foot">${rows.length} ${rows.length === 1 ? 'decision' : 'decisions'} · Atlas records these so it can explain what was decided before. Nothing here changes stock, orders or shifts.</p>`;
      }
    }
    const head = root.AtlasShell.pageHead({
      id: 'ai-decisions-title',
      title: 'Decisions',
      sub: 'What Atlas suggested, what was decided and what happened next.',
      actions: [{ label: 'Refresh', icon: 'refresh-cw', variant: 'secondary', attrs: { 'data-ai-dec-refresh': '', ...(d.loading ? { disabled: '', 'aria-busy': 'true' } : {}) } }]
    });
    container.innerHTML = `<div class="ai-decisions__inner">${head}${filters}${body}</div>`;
    root.lucide?.createIcons?.();
  }

  async function loadDecisions() {
    if (!isManager()) { renderDecisions(); return; }
    state.decisions.loading = true;
    renderDecisions();
    try {
      const payload = await decisionsRequest('snapshot');
      state.decisions.snapshot = payload?.snapshot || { recommendations: [], memory: [] };
      state.decisions.error = null;
    } catch (error) {
      state.decisions.error = error;
    } finally {
      state.decisions.loading = false;
      state.decisions.loaded = true;
      renderDecisions();
    }
  }

  // #ai/decisions?recommendation=<id> (AtlasAI.openDecision, Messages
  // and palette links) selects the row and opens its detail sheet.
  async function openDecision(recommendationId) {
    if (!recommendationId) return;
    const id = uid('ai-dec');
    state.decisions.openId = String(recommendationId);
    if (state.mode === 'decisions') renderDecisions();
    const layer = openLayer({
      className: 'ai-sheet',
      labelledBy: `${id}-title`,
      onClose: () => {
        state.decisions.openId = null;
        if (state.mode === 'decisions') renderDecisions();
        state.openedRecommendation = null;
        if (state.lastParams?.recommendation) { state.lastParams = { section: 'decisions' }; routeTo({ section: 'decisions' }); }
      },
      markup: `<div class="ai-sheet__head"><div><h2 id="${id}-title">Decision</h2><p>Loading…</p></div><button type="button" class="atlas-icon-btn" data-ai-layer-close aria-label="Close">${icon('x')}</button></div><div class="ai-sheet__body" aria-busy="true">${'<div class="atlas-skel"></div>'.repeat(4)}</div>`
    });
    let detail;
    try {
      const payload = await decisionsRequest('detail', { params: { id: recommendationId } });
      detail = payload?.detail || {};
    } catch {
      layer.root.querySelector('.ai-sheet__body').innerHTML = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div><div class="atlas-alert__title">This decision couldn’t be loaded.</div><div>Nothing was changed. Close and try again.</div></div></div>`;
      return;
    }
    const recommendation = detail.recommendation || {};
    const memory = Array.isArray(detail.memory) ? detail.memory : [];
    const evidence = Array.isArray(recommendation.evidence) ? recommendation.evidence : [];
    const lastOutcome = recommendation.last_outcome;
    const evidenceRows = evidence.slice(0, 12).map((item) => {
      const value = item.value && typeof item.value === 'object'
        ? Object.entries(item.value).slice(0, 4).map(([key, entry]) => `${key.replace(/_/g, ' ')}: ${typeof entry === 'object' ? '' : entry}`).filter((line) => !/:\s*$/.test(line)).join(' · ')
        : String(item.value ?? '');
      return `<li><strong>${escapeHtml(humanText(item.label, 'Evidence'))}</strong>${value ? `<span>${escapeHtml(value)}</span>` : ''}</li>`;
    }).join('');
    const conversationId = recommendation.conversation_id || recommendation.context?.conversation_id || null;
    layer.root.querySelector('h2').textContent = humanText(recommendation.title, 'Decision');
    layer.root.querySelector('.ai-sheet__head p').textContent = humanText(recommendation.summary, '');
    const bodyEl = layer.root.querySelector('.ai-sheet__body');
    bodyEl.removeAttribute('aria-busy');
    bodyEl.innerHTML = `
      <section><h3>What was recommended</h3><p>${escapeHtml(humanText(recommendation.explanation, humanText(recommendation.summary, 'No details were recorded.')))}</p></section>
      <section><h3>Evidence</h3>${evidenceRows ? `<ul class="ai-sheet__list">${evidenceRows}</ul>` : '<p class="muted">No evidence was recorded.</p>'}</section>
      <section><h3>Decision</h3>${memory.length ? `<ul class="ai-sheet__list">${memory.slice(0, 8).map((entry) => `<li><strong>${escapeHtml(humanText(entry.title, 'Decision'))}</strong><span>${escapeHtml([humanText(entry.actor_label, ''), entry.occurred_at ? whenLabel(entry.occurred_at) : ''].filter(Boolean).join(' · '))}</span>${entry.summary ? `<span>${escapeHtml(humanText(entry.summary, ''))}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Not decided yet.</p>'}</section>
      <section><h3>Outcome</h3>${lastOutcome ? `<p>${escapeHtml(humanText(lastOutcome.notes, humanText(lastOutcome.outcome_status, 'Recorded')))}</p>` : '<p class="muted">No outcome recorded yet.</p>'}</section>
      ${conversationId ? `<a class="atlas-btn atlas-btn--ghost atlas-btn--sm" href="#ai/c/${escapeHtml(conversationId)}" data-ai-route="#ai/c/${escapeHtml(conversationId)}">Open the conversation${icon('arrow-right')}</a>` : ''}
      <form class="ai-sheet__form" data-ai-dec-form>
        <h3>Record a decision</h3>
        <div class="atlas-field"><label for="${id}-decision">Decision</label><select id="${id}-decision" class="atlas-select" name="decision"><option value="accept">Approve</option><option value="reject">Dismiss</option><option value="defer">Decide later</option></select></div>
        <div class="atlas-field" data-ai-defer hidden><label for="${id}-until">Decide by</label><input id="${id}-until" class="atlas-input" type="datetime-local" step="60" name="until"></div>
        <div class="atlas-field"><label for="${id}-notes">Note (optional)</label><textarea id="${id}-notes" class="atlas-input" name="notes" rows="3" placeholder="What should Atlas remember about this?"></textarea></div>
        <div class="ai-sheet__error" data-ai-dec-error hidden role="alert"></div>
        <div class="ai-sheet__actions"><button type="submit" class="atlas-btn atlas-btn--primary">Save decision</button></div>
      </form>
      <form class="ai-sheet__form" data-ai-outcome-form>
        <h3>Record what happened</h3>
        <div class="atlas-field"><label for="${id}-outcome">What happened?</label><textarea id="${id}-outcome" class="atlas-input" name="result" rows="2" placeholder="For example: delivered Friday, stock recovered"></textarea></div>
        <div class="atlas-field"><label for="${id}-ostatus">Status</label><select id="${id}-ostatus" class="atlas-select" name="status"><option value="observed">Observed</option><option value="confirmed">Confirmed</option><option value="disputed">Disputed</option></select></div>
        <div class="ai-sheet__error" data-ai-outcome-error hidden role="alert"></div>
        <div class="ai-sheet__actions"><button type="submit" class="atlas-btn atlas-btn--secondary">Save outcome</button></div>
      </form>`;
    const decisionForm = bodyEl.querySelector('[data-ai-dec-form]');
    decisionForm.decision.addEventListener('change', () => { bodyEl.querySelector('[data-ai-defer]').hidden = decisionForm.decision.value !== 'defer'; });
    decisionForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = bodyEl.querySelector('[data-ai-dec-error]');
      const decision = decisionForm.decision.value;
      const until = decisionForm.until.value;
      if (decision === 'defer' && !until) { error.hidden = false; error.textContent = 'Choose when to decide.'; decisionForm.until.focus(); return; }
      const button = decisionForm.querySelector('button[type="submit"]');
      button.disabled = true; button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true');
      try {
        await decisionsRequest('decision', { method: 'POST', body: { recommendation_id: recommendationId, decision, reason_code: decision === 'accept' ? 'evidence_supported' : decision === 'reject' ? 'local_context' : 'timing', notes: decisionForm.notes.value.trim() || null, modified_action: null, deferred_until: until ? new Date(until).toISOString() : null, client_request_id: uid('decision') } });
        layer.close('saved');
        toast('Decision saved');
        loadDecisions();
      } catch {
        error.hidden = false;
        error.textContent = 'The decision couldn’t be saved. Nothing was changed. Try again.';
        button.disabled = false; button.classList.remove('is-loading'); button.removeAttribute('aria-busy');
      }
    });
    const outcomeForm = bodyEl.querySelector('[data-ai-outcome-form]');
    outcomeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = bodyEl.querySelector('[data-ai-outcome-error]');
      const text = outcomeForm.result.value.trim();
      if (!text) { error.hidden = false; error.textContent = 'Describe what happened.'; outcomeForm.result.focus(); return; }
      const button = outcomeForm.querySelector('button[type="submit"]');
      button.disabled = true; button.classList.add('is-loading');
      try {
        await decisionsRequest('outcome', { method: 'POST', body: { recommendation_id: recommendationId, outcome_type: 'manager_observation', outcome_status: outcomeForm.status.value, success_score: null, result: { observation: text }, source_refs: [], notes: null, observed_at: new Date().toISOString(), client_request_id: uid('outcome') } });
        layer.close('saved');
        toast('Outcome saved');
        loadDecisions();
      } catch {
        error.hidden = false;
        error.textContent = 'The outcome couldn’t be saved. Nothing was changed. Try again.';
        button.disabled = false; button.classList.remove('is-loading');
      }
    });
  }

  function applyMode() {
    const decisions = state.mode === 'decisions';
    el('thread').hidden = decisions;
    el('decisions').hidden = !decisions;
    state.root.classList.toggle('is-decisions', decisions);
    renderList();
    if (decisions) {
      renderDecisions();
      if (!state.decisions.loaded && !state.decisions.loading) loadDecisions();
    }
  }

  function setMode(mode, { route = true } = {}) {
    const next = mode === 'decisions' ? 'decisions' : 'conversations';
    state.mode = next;
    closeListSheet();
    applyMode();
    if (route) routeTo(next === 'decisions' ? { section: 'decisions' } : state.conv.id ? { conversation: state.conv.id } : {});
    if (next === 'decisions') root.requestAnimationFrame(() => el('decisions').querySelector('h1')?.focus?.());
  }

  // ---------- events ----------

  function onRootClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const hit = (selector) => target.closest(selector);
    let node;

    if ((node = hit('[data-ai-route]'))) {
      event.preventDefault();
      closeListSheet();
      openRoute(node.dataset.aiRoute);
      return;
    }
    if ((node = hit('[data-ai-open-conv]'))) {
      event.preventDefault();
      openConversation(node.dataset.aiOpenConv, { route: true });
      return;
    }
    if ((node = hit('[data-ai-conv-menu]'))) { conversationMenu(node.dataset.aiConvMenu, node); return; }
    if (hit('[data-ai-new]')) { newConversation({ route: true }); return; }
    if (hit('[data-ai-open-list]')) { openListSheet(); return; }
    if (hit('[data-ai-close-list]')) { closeListSheet(); return; }
    if (hit('[data-ai-search-toggle]')) { toggleSearch(); return; }
    if (hit('[data-ai-list-retry]')) { loadList(); return; }
    if (hit('[data-ai-conv-retry]')) { const id = state.conv.id; state.conv.id = null; openConversation(id); return; }
    if ((node = hit('[data-ai-mode]'))) { setMode(node.dataset.aiMode); return; }
    if (hit('[data-ai-pin]')) { if (state.conv.id) pinConversation(state.conv.id, !state.conv.pinned); return; }
    if ((node = hit('[data-ai-thread-menu]'))) { if (state.conv.id) conversationMenu(state.conv.id, node); return; }
    if (hit('[data-ai-rename-inline]')) { startInlineRename(); return; }
    if ((node = hit('[data-ai-suggest]'))) {
      const suggestion = suggestions()[Number(node.dataset.aiSuggest)];
      if (!suggestion) return;
      if (suggestion.live) { startLive(); return; }
      if (suggestion.photo) {
        el('input').value = suggestion.prompt;
        autoGrow();
        renderComposerBar();
        if (state.configured !== false) (isPhone() ? el('fileCamera') : el('filePhoto')).click();
        return;
      }
      send({ text: suggestion.prompt });
      return;
    }
    if ((node = hit('[data-ai-prompt]'))) { el('input').value = node.dataset.aiPrompt; autoGrow(); renderComposerBar(); el('input').focus(); return; }
    if ((node = hit('[data-ai-steps]'))) {
      const message = state.conv.messages.find((entry) => entry.key === node.dataset.aiSteps);
      if (message) { message.stepsOpen = !message.stepsOpen; patchMessage(message); messageNode(message)?.querySelector('[data-ai-steps]')?.focus(); }
      return;
    }
    if ((node = hit('[data-ai-evidence]'))) {
      const message = state.conv.messages.find((entry) => entry.key === node.dataset.aiEvidence);
      if (message) {
        const open = node.getAttribute('aria-expanded') === 'true';
        message.evidenceOpen = !open;
        patchMessage(message);
        messageNode(message)?.querySelector('[data-ai-evidence]')?.focus();
      }
      return;
    }
    if ((node = hit('[data-ai-records-more]'))) {
      const message = state.conv.messages.find((entry) => entry.key === node.dataset.aiRecordsMore);
      if (message) { message.recordsOpen = true; patchMessage(message); }
      return;
    }
    if ((node = hit('[data-ai-copy]'))) {
      const message = state.conv.messages.find((entry) => entry.key === node.dataset.aiCopy);
      if (message) copyText(message.content, 'Answer copied');
      return;
    }
    if ((node = hit('[data-ai-retry]'))) { regenerate(node.dataset.aiRetry); return; }
    if ((node = hit('[data-ai-fallback-action]'))) {
      const message = state.conv.messages.find((entry) => entry.key === node.dataset.aiFallbackAction);
      message?.fallbackAction?.run?.();
      return;
    }
    if ((node = hit('[data-ai-approve]'))) { approve(node.dataset.aiApprove); return; }
    if ((node = hit('[data-ai-dismiss]'))) { dismiss(node.dataset.aiDismiss); return; }
    if ((node = hit('[data-ai-edit]'))) { editProposal(node.dataset.aiEdit); return; }
    if ((node = hit('[data-ai-attach]'))) { attachMenu(node); return; }
    if ((node = hit('[data-ai-remove-att]'))) { removeAttachment(node.dataset.aiRemoveAtt); return; }
    if (hit('[data-ai-voice-clear]')) { state.composer.source = 'text'; state.composer.duration = null; renderAttachments(); return; }
    if (hit('[data-ai-clear-context]')) { state.composer.context = null; renderComposerBar(); renderThread(); el('input').focus(); return; }
    if (hit('[data-ai-stop]')) { stopStreaming(); el('input').focus(); return; }
    if (hit('[data-ai-voice-note]')) { startVoiceNote(); return; }
    if (hit('[data-ai-rec-cancel]')) { cancelVoiceNote(); return; }
    if (hit('[data-ai-rec-stop]')) { stopVoiceNote(); return; }
    if (hit('[data-ai-live]')) { startLive(); return; }
    if (hit('[data-ai-live-end]')) { endLive(); return; }
    if (hit('[data-ai-live-mute]')) { if (state.live?.session) state.live.session.mute(); return; }
    if (hit('[data-ai-live-transcript]')) { if (state.live) { state.live.showTranscript = !state.live.showTranscript; renderLive(); el('voiceSlot').querySelector('[data-ai-live-transcript]')?.focus(); } return; }
    if (hit('[data-ai-live-reconnect]')) {
      const old = state.live;
      if (old) { root.cancelAnimationFrame(old.frame); old.session?.end?.(); state.live = null; }
      startLive({ skipExplain: true });
      return;
    }
    if ((node = hit('[data-ai-dec-open]'))) { openDecision(node.dataset.aiDecOpen); return; }
    if (hit('[data-ai-dec-retry]') || hit('[data-ai-dec-refresh]')) { loadDecisions(); return; }
    if (hit('[data-ai-dec-clear]')) { state.decisions.filter = { status: 'all', area: 'all', period: 'all' }; renderDecisions(); return; }
  }

  function onRootKeydown(event) {
    if (event.key === 'Escape' && state.root.classList.contains('is-list-open')) { event.preventDefault(); closeListSheet(); return; }
    if (event.key === 'Tab' && state.root.classList.contains('is-list-open')) {
      const nodes = [...el('listPane').querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')].filter((node) => node.offsetParent !== null);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    }
    const filter = event.target.closest?.('[data-ai-dec-filter]');
    if (filter && event.key === 'Enter') event.preventDefault();
  }

  function onGlobalKeydown(event) {
    if (!state.visible) return;
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && String(event.key).toLowerCase() === 'o') {
      event.preventDefault();
      newConversation({ route: true });
    }
  }

  function copyText(text, done) {
    const value = String(text || '');
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* unsupported */ }
      area.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(() => toast(done), () => { fallback(); toast(done); });
    else { fallback(); toast(done); }
  }

  // ---------- shell integration ----------

  async function checkConfigured() {
    if (!endpoint()) { state.configured = false; return; }
    if (state.settingsChecked) return;
    state.settingsChecked = true;
    try {
      const settings = await request('settings');
      state.settings = settings;
      if (settings && typeof settings.configured === 'boolean') state.configured = settings.configured;
    } catch (error) {
      if (error?.code === 'not_configured') state.configured = false;
      // Other failures (for example a staff role reading owner settings) leave it
      // unknown; the first answer tells the truth.
    }
    renderThread();
    renderComposerBar();
    renderList();
  }

  function parseContext(value) {
    const text = String(value || '');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const type = text.slice(0, colon).trim();
    const id = text.slice(colon + 1).trim();
    if (!/^[a-z_]{2,40}$/.test(type) || !id) return null;
    return { type, id, label: contextLabel(type, id), view: null };
  }

  function render(params = {}) {
    if (!ensureRoot()) return;
    state.visible = true;
    setTopBar();
    measureTop();
    if (!state.initialized) {
      state.initialized = true;
      loadList();
      checkConfigured();
    }
    const section = params.section === 'decisions' ? 'decisions' : 'conversations';
    state.lastParams = { ...params };
    if (section === 'decisions') {
      state.mode = 'decisions';
      applyMode();
      // #ai/decisions?recommendation=<id> (AtlasAI.openDecision, Messages and
      // record links) selects that decision and opens its sheet.
      const focus = params.recommendation ? String(params.recommendation) : '';
      if (focus && isManager() && state.openedRecommendation !== focus) {
        state.openedRecommendation = focus;
        openDecision(focus);
      } else if (!focus) state.openedRecommendation = null;
      return;
    }
    if (state.mode === 'decisions') { state.mode = 'conversations'; applyMode(); }
    if (params.conversation) { openConversation(params.conversation); return; }
    if (params.new || params.context || params.q) {
      const context = state.pendingContext || parseContext(params.context);
      state.pendingContext = null;
      const from = params.view || params.from || null;
      if (context && from && !context.view) context.view = from;
      if (!state.conv.messages.length || params.new) newConversation({ context, focus: !params.q });
      else if (context) { state.composer.context = context; renderComposerBar(); }
      if (params.q) {
        // A route-supplied question only prefills the composer: a link (email,
        // chat, QR code) must never send a turn as the signed-in user. Only an
        // in-app intent (ask(), the palette's Ask Atlas row) sends, and that
        // intent travels in memory (takePendingSend), never in the URL.
        const question = String(params.q).slice(0, 4000);
        if (params.send !== '0' && takePendingSend(question)) send({ text: question });
        else { el('input').value = question; autoGrow(); renderComposerBar(); el('input').focus(); }
      }
      return;
    }
    // #ai with nothing else: keep the open conversation, else today's latest.
    if (state.conv.id || state.conv.messages.length) { renderThread(); renderComposerBar(); return; }
    const today = dayKey(new Date());
    const recent = state.list.items.find((item) => !item.archived && dayKey(new Date(item.last_message_at || item.updated_at || 0)) === today);
    if (recent) openConversation(recent.id);
    else { renderThread(); renderComposerBar(); }
  }

  function onHide() {
    state.visible = false;
    if (state.live) endLive();
    closeMenu();
    closeListSheet();
    root.AtlasChrome?.setTabBarHidden?.('ai', false);
  }

  // One-shot, in-memory "send this question" intent. Set by in-app callers just
  // before they open #ai/new?q=…, consumed by render(). A URL alone can never
  // set it, so a crafted link only prefills the composer.
  let pendingSend = null;
  const PENDING_SEND_TTL_MS = 10000;

  function intendSend(question) {
    const text = String(question || '').slice(0, 4000);
    pendingSend = text ? { text, at: Date.now() } : null;
    return Boolean(pendingSend);
  }

  function takePendingSend(question) {
    const pending = pendingSend;
    pendingSend = null;
    return Boolean(pending && pending.text === question && Date.now() - pending.at <= PENDING_SEND_TTL_MS);
  }

  // Opens Atlas AI with an optional question and page context.
  function ask({ question = '', record = null, view = null, send: autoSend = true } = {}) {
    const params = { new: '1' };
    if (record?.type && record?.id != null) {
      params.context = `${record.type}:${record.id}`;
      state.pendingContext = { type: record.type, id: String(record.id), label: record.label || contextLabel(record.type, record.id), view: view || root.AtlasShell?.current?.() || null };
    }
    if (question) params.q = question;
    if (question && autoSend) intendSend(question);
    else pendingSend = null;
    if (root.AtlasShell?.show) root.AtlasShell.show('ai', params, { source: 'action' });
    return true;
  }

  function contributeHome() {
    if (!root.AtlasShell?.home?.contribute || state.homeContributed) {
      if (state.homeContributed) root.AtlasShell?.emit?.('notify:changed', { source: 'home:ai' });
      return;
    }
    state.homeContributed = true;
    root.AtlasShell.home.contribute('ai', {
      order: 90,
      focusRows: () => {
        const rows = [];
        state.conv.messages.forEach((message) => (message.proposals || []).forEach((proposal) => {
          const current = actionState(proposal);
          if (current.status !== 'proposed' || !canApprove(current) || !kindInfo(current.kind).executable) return;
          rows.push({
            id: current.id,
            severity: 'info',
            icon: 'sparkles',
            title: `${humanText(current.title, 'A change Atlas prepared')} is waiting for your approval`,
            detail: current.expires_at ? expiryLabel(current.expires_at) : 'Prepared by Atlas',
            action: { label: 'Review', route: `#ai/c/${state.conv.id}` }
          });
        }));
        return rows.slice(0, 3);
      }
    });
  }

  function registerWithShell() {
    const shell = root.AtlasShell;
    if (!shell) return;
    shell.registerView('ai', { root: () => ensureRoot(), title: 'Atlas AI', display: 'block', render, onHide });
    shell.actions?.register?.({
      id: 'ai.ask', label: 'Ask Atlas', icon: 'sparkles', keywords: ['ask', 'question', 'atlas', 'ai', 'help'], contexts: ['home', 'inventory', 'recipes', 'suppliers', 'reports'],
      run: (ctx = {}) => ask({ question: ctx.query || ctx.question || '', record: ctx.record || null, view: ctx.context || null })
    });
    shell.actions?.register?.({
      id: 'ai.ask.record', label: 'Ask Atlas about this', icon: 'sparkles', keywords: ['ask', 'atlas', 'about'],
      when: (ctx = {}) => Boolean(ctx.record?.type && ctx.record?.id != null),
      run: (ctx = {}) => ask({ question: ctx.query || '', record: ctx.record, view: ctx.context || null, send: Boolean(ctx.query) })
    });
    shell.actions?.register?.({
      id: 'ai.voice', label: 'Talk to Atlas', icon: 'audio-lines', keywords: ['voice', 'talk', 'speak', 'count by voice'], roles: OPERATIONAL_ROLES, contexts: ['home', 'inventory'],
      when: () => Boolean(root.AtlasAIVoice?.supported?.().liveVoice),
      run: () => { shell.show('ai', { new: '1' }, { source: 'action' }); root.setTimeout(() => startLive(), 0); }
    });
    shell.links?.register?.('ai', (key) => (key ? shell.show('ai', { conversation: key }) : shell.show('ai', {})));
    shell.on?.('profile:ready', () => {
      if (!state.root) return;
      renderList();
      renderComposerBar();
      if (state.mode === 'decisions') renderDecisions();
      if (!state.conv.messages.length) renderThread();
    });
  }

  function init() {
    if (state.booted) return;
    state.booted = true;
    ensureRoot();
    registerWithShell();
    root.addEventListener('pagehide', () => { if (state.live?.session) state.live.session.exit(); });
    root.addEventListener('online', () => renderComposerBar());
    root.addEventListener('offline', () => renderComposerBar());
    root.addEventListener('resize', () => measureTop());
    document.addEventListener('keydown', onGlobalKeydown);
  }

  root.AtlasAI = {
    ask,
    askAbout: (record, question = '') => ask({ record, question, send: Boolean(question) }),
    // In-app callers that route to #ai/new?q=… themselves (the palette) call
    // this first so the question is sent; without it the question is prefilled.
    intendSend,
    open: (conversationId) => root.AtlasShell?.show?.('ai', conversationId ? { conversation: conversationId } : {}),
    newConversation: () => root.AtlasShell?.show?.('ai', { new: '1' }),
    decisions: () => root.AtlasShell?.show?.('ai', { section: 'decisions' }),
    // Opens Decisions with this recommendation selected and its detail open.
    openDecision: (recommendationId) => root.AtlasShell?.show?.('ai', recommendationId ? { section: 'decisions', recommendation: String(recommendationId) } : { section: 'decisions' }),
    // Pure helpers, exported for tests.
    parseEventBlock,
    splitEvents,
    formatAnswer,
    stepsSummary,
    humanText,
    recordRoute,
    state: () => ({ configured: state.configured, conversation: state.conv.id, mode: state.mode, streaming: Boolean(state.streaming), live: state.live?.state || null })
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(typeof window === 'undefined' ? globalThis : window);
