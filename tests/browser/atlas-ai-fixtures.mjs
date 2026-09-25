// Mock atlas-ai backend for the Atlas AI browser tests. Shapes follow
// supabase/functions/atlas-ai/handler.mjs + chat.mjs and the conversation RPCs.
import { emptyFunctions } from './fixtures.mjs';

export const IDS = {
  convNegroni: '5b0c0f64-1c55-4f7e-9a51-0f2d7b3c1a01',
  convDelivery: '5b0c0f64-1c55-4f7e-9a51-0f2d7b3c1a02',
  convPaloma: '5b0c0f64-1c55-4f7e-9a51-0f2d7b3c1a03',
  convPars: '5b0c0f64-1c55-4f7e-9a51-0f2d7b3c1a04',
  created: '5b0c0f64-1c55-4f7e-9a51-0f2d7b3c1aff',
  action: '9d1e2f30-4a5b-4c6d-8e7f-001122334455',
  voiceAction: '9d1e2f30-4a5b-4c6d-8e7f-001122334466',
  media: '7a7a7a7a-1111-4222-8333-444455556666',
  voiceSession: 'e1e2e3e4-5555-4666-8777-888899990000',
  campari: 'c0a1b2c3-0000-4000-8000-00000000c001',
  negroni: 'c0a1b2c3-0000-4000-8000-00000000c002',
  globus: 'c0a1b2c3-0000-4000-8000-00000000c003'
};

// Fixture times are anchored to a fixed venue afternoon so grouping (Today /
// Previous 7 days) and expiry never depend on when the suite runs. Tests pin
// the browser clock to AI_FIXTURE_NOW.
export const AI_FIXTURE_NOW = new Date('2026-09-24T17:00:00Z');
const hoursAgo = (hours) => new Date(AI_FIXTURE_NOW.getTime() - hours * 3600000).toISOString();
const inHours = (hours) => new Date(AI_FIXTURE_NOW.getTime() + hours * 3600000).toISOString();

export function conversations() {
  return [
    { id: IDS.convPars, title: 'Weekly par review', pinned: true, archived: false, last_message_at: hoursAgo(80), created_at: hoursAgo(90) },
    { id: IDS.convNegroni, title: 'Negroni tonight and Campari order', pinned: false, archived: false, last_message_at: hoursAgo(0.5), created_at: hoursAgo(1) },
    { id: IDS.convDelivery, title: 'Does this delivery match our order?', pinned: false, archived: false, last_message_at: hoursAgo(1.5), created_at: hoursAgo(2) },
    { id: IDS.convPaloma, title: 'Cost of a Paloma', pinned: false, archived: false, last_message_at: hoursAgo(24 * 9), created_at: hoursAgo(24 * 9) }
  ];
}

export function orderProposal(overrides = {}) {
  return {
    id: IDS.action,
    kind: 'purchase_order.create',
    title: 'Order from Globus',
    status: 'proposed',
    required_roles: ['admin', 'manager'],
    expires_at: inHours(20),
    preview: {
      headline: 'Draft purchase order for Globus',
      lines: [
        { label: 'Campari 1 L', detail: '6 bottles × 3.900 kr = 23.400 kr' },
        { label: 'Aperol 1 L', detail: '3 bottles × 3.300 kr = 9.900 kr' },
        { label: 'Angostura Bitters 200 ml', detail: '2 bottles × 2.900 kr = 5.800 kr' }
      ],
      totals: { lines: 3, estimated_total: 39100, estimated_total_label: '39.100 kr' },
      recipients: [],
      will_change: ['A new purchase order is saved in Purchasing with status Draft.'],
      will_not_change: ['The order is not placed or sent to the supplier.', 'Stock and item costs do not change.'],
      route: '#purchasing/order/po-1'
    },
    ...overrides
  };
}

export const EVIDENCE = [
  { kind: 'fact', label: 'Campari on hand', value: '1 bottle (1 L)', source: { type: 'stock_count', id: null, label: 'Count · Tue 22 Sep', route: null } },
  { kind: 'calculation', label: 'Negronis from one bottle', value: '1,000 ml ÷ 30 ml ≈ 33', source: { type: 'recipe', id: IDS.negroni, label: 'Recipe · Negroni', route: null } },
  { kind: 'estimate', label: 'Negronis on recent busy nights', value: '40–50', source: { type: 'report', id: 'sales', label: 'Reports · sales', route: null } },
  { kind: 'missing', label: 'Sales since the last count', value: 'not recorded', source: { type: 'integration', id: 'pos', label: 'No POS link', route: null } }
];

export const RECORDS = [
  { type: 'inventory_item', id: IDS.campari, label: 'Campari', route: `#inventory/item/${IDS.campari}` },
  { type: 'recipe', id: IDS.negroni, label: 'Negroni', route: `#recipes/${IDS.negroni}` },
  { type: 'supplier', id: IDS.globus, label: 'Globus', route: `#purchasing/suppliers/${IDS.globus}` }
];

export const ANSWER = 'Yes, but only about 30 Negronis. You have one bottle of Campari left and each Negroni uses 30 ml. On a busy night you usually sell 40–50.\n\nI’ve prepared an order with Globus so Campari arrives tomorrow morning. Approve it before 18:00 to make their cut-off.';

export function negroniMessages() {
  return [
    { id: 'm-1', role: 'user', content: 'Can we still make Negronis tonight? If not, sort out the Campari.', source: 'text', attachments: [], status: 'complete', metadata: {}, created_at: hoursAgo(0.6) },
    { id: 'm-2', role: 'assistant', content: ANSWER, source: 'text', status: 'complete', evidence: EVIDENCE, records: RECORDS, proposals: [orderProposal()], metadata: {}, created_at: hoursAgo(0.55) }
  ];
}

export function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

export function chatStream({ conversationId = IDS.created, content = ANSWER, proposal = orderProposal(), evidence = EVIDENCE, records = RECORDS } = {}) {
  return sse([
    ['progress', { label: 'Checking stock' }],
    ['progress', { label: 'Looking through recipes' }],
    ['progress', { label: 'Preparing a draft order' }],
    ...(proposal ? [['proposal', proposal]] : []),
    ['delta', { text: content.slice(0, 40) }],
    ['delta', { text: content.slice(40) }],
    ['evidence', { items: evidence }],
    ['records', { items: records }],
    ['done', { message_id: 'm-reply', user_message_id: 'm-user', run_id: 'run-1', conversation_id: conversationId, content, grounding: 'ok' }]
  ]);
}

/**
 * Stateful atlas-ai mock. Options:
 *   configured (default true) — false answers 503 not_configured everywhere;
 *   chat(entry, state) — custom chat responder returning a harness result;
 *   delayChatMs — hold the chat response (to test Stop).
 */
export function atlasAiBackend({ configured = true, chat = null, delayChatMs = 0, messages = negroniMessages, overrides = {} } = {}) {
  const state = { conversations: conversations(), calls: [], executed: 0, voiceActive: false };
  // Hardened voice contract: tool and transcript calls must carry the Atlas
  // voice_session_id of a live session, else 409 voice_session_inactive.
  const inactive = { __status: 409, body: { error_code: 'voice_session_inactive', message: 'This live voice session has ended. Start a new one to continue.' } };
  const liveSession = (body) => state.voiceActive && body.voice_session_id === IDS.voiceSession;
  const handler = async (entry) => {
    state.calls.push(entry);
    if (!configured) return { __status: 503, body: { error_code: 'not_configured', message: 'Atlas AI is not configured' } };
    const body = entry.body && typeof entry.body === 'object' ? entry.body : {};
    const params = new URLSearchParams(entry.search);
    if (overrides[entry.action]) {
      const result = await overrides[entry.action](entry, state);
      if (result !== undefined) return result;
    }
    switch (entry.action) {
      case 'settings': return { enabled: true, configured: true, key_present: true };
      case 'conversations': {
        const q = (params.get('q') || '').toLowerCase();
        const list = state.conversations.filter((item) => !item.archived && (!q || item.title.toLowerCase().includes(q)));
        return { conversations: list, total: list.length, has_more: false };
      }
      case 'conversation': {
        const id = params.get('id');
        const conversation = state.conversations.find((item) => item.id === id) || { id, title: null, pinned: false };
        const list = id === IDS.convNegroni ? messages() : [];
        const actions = list.flatMap((message) => message.proposals || []).map((proposal) => ({ ...proposal, message_id: 'm-2' }));
        return { conversation, messages: list, has_more: false, actions };
      }
      case 'create': {
        const created = { id: IDS.created, title: null, pinned: false, archived: false, last_message_at: new Date().toISOString(), created_at: new Date().toISOString() };
        state.conversations.unshift(created);
        return created;
      }
      case 'rename': {
        const item = state.conversations.find((entry) => entry.id === body.conversation_id);
        if (item) item.title = body.title;
        return { ...item };
      }
      case 'pin': {
        const item = state.conversations.find((entry) => entry.id === body.conversation_id);
        if (item) item.pinned = body.pinned !== false;
        return { ...item };
      }
      case 'archive': {
        const item = state.conversations.find((entry) => entry.id === body.conversation_id);
        if (item) item.archived = body.archived !== false;
        return { ...item };
      }
      case 'delete':
        state.conversations = state.conversations.filter((entry) => entry.id !== body.conversation_id);
        return { deleted: true, conversation_id: body.conversation_id, media_removed: 0, media_pending: 0 };
      case 'execute-action':
        state.executed += 1;
        return { ok: true, action: { id: body.action_id, status: 'executed' }, result: { summary: 'Draft order saved in Purchasing.', purchase_order_id: 'po-1' }, error: null, note_message_id: 'n-1' };
      case 'reject-action':
        return { ok: true, action: { id: body.action_id, status: 'rejected' } };
      case 'upload':
        return { media: { id: IDS.media, kind: 'image', mime: 'image/png', bytes: 68 } };
      case 'transcribe':
        return { text: 'I just counted six bottles of Tanqueray and two Campari', duration: 4.2, source: 'voice_note', media_id: null, audio_retained: false };
      case 'voice-session':
        state.voiceActive = true;
        return { client_secret: 'ek_harness_secret', expires_at: null, model: 'realtime', voice: 'marin', session_id: 'sess_harness', voice_session_id: IDS.voiceSession, voice_session_expires_at: inHours(1), conversation_id: body.conversation_id || IDS.created, run_id: 'run-voice' };
      case 'voice-end':
        if (!liveSession(body)) return inactive;
        state.voiceActive = false;
        return { ended: true, voice_session_id: body.voice_session_id, ended_at: new Date().toISOString() };
      case 'voice-tool':
        if (!liveSession(body)) return inactive;
        return {
          output: 'Tanqueray: 6 bottles counted. Prepared "Back bar count" as a proposal card on screen.',
          proposal: { id: IDS.voiceAction, kind: 'stock_count.draft', title: 'Back bar count', status: 'proposed', required_roles: ['admin', 'manager', 'bartender'], expires_at: inHours(20), preview: { headline: 'New stock count with 2 counted lines', lines: [{ label: 'Tanqueray 1 L', detail: '6 bottle' }, { label: 'Campari 1 L', detail: '2 bottle' }], will_change: ['A new count session is started in Stock count.'], will_not_change: ['Stock does not change now.'] } },
          records: [], evidence: []
        };
      case 'voice-append':
        if (body.voice_session_id !== IDS.voiceSession) return inactive;
        if (body.ended === true) state.voiceActive = false;
        return { messages: (body.turns || []).map((turn, index) => ({ id: `v-${index}`, created: true })) };
      case 'chat': {
        if (delayChatMs) await new Promise((resolve) => setTimeout(resolve, delayChatMs));
        if (chat) return chat(entry, state);
        return { __raw: { status: 200, contentType: 'text/event-stream; charset=utf-8', body: chatStream({ conversationId: body.conversation_id || IDS.created }) } };
      }
      default:
        return { __status: 404, body: { error_code: 'unknown_action', message: 'Unknown Atlas AI action.' } };
    }
  };
  return { handler, state };
}

export function decisionsBackend() {
  return () => ({
    snapshot: {
      recommendations: [
        { id: 'r-1', title: 'Order Campari before Friday', summary: 'One bottle left; Negroni is the top seller.', recommendation_type: 'purchasing', status: 'active', generated_by: 'atlas-ai/s88', evidence: [{ label: 'Campari on hand', value: { bottles: 1 } }], updated_at: hoursAgo(2) }
      ],
      memory: [
        { id: 'mem-1', title: 'Approved: Order from Ölgerðin', summary: 'Delivered Friday', action: 'accept', actor_label: 'Imad El Moubarik', occurred_at: hoursAgo(50), context: { recommendation_id: 'r-0' }, memory_type: 'purchasing' },
        { id: 'mem-2', title: 'Dismissed: Raise lime par', summary: 'Seasonal menu change', action: 'reject', actor_label: 'Imad El Moubarik', occurred_at: hoursAgo(120), context: { recommendation_id: 'r-2' }, memory_type: 'stock' }
      ]
    },
    manager: { role: 'admin' }
  });
}

export function aiFixtures(options = {}) {
  const backend = atlasAiBackend(options);
  return {
    backend,
    fixtures: {
      tables: options.tables || {},
      functions: {
        ...emptyFunctions(),
        ...(options.functions || {}),
        'atlas-ai': backend.handler,
        'atlas-phase3-brain': decisionsBackend()
      }
    }
  };
}

// Fake browser media stack for voice tests (installed with initScript).
export function fakeMediaInit() {
  const track = () => ({ enabled: true, kind: 'audio', stop() { this.stopped = true; } });
  const stream = () => { const tracks = [track()]; return { getTracks: () => tracks, getAudioTracks: () => tracks }; };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
  class FakeRecorder {
    static isTypeSupported(type) { return String(type).startsWith('audio/webm'); }
    constructor(_stream, options = {}) { this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    start() { this.state = 'recording'; window.__recorderStarted = true; }
    stop() {
      this.state = 'inactive';
      (this.listeners.dataavailable || []).forEach((fn) => fn({ data: new Blob(['voice'.repeat(40)], { type: 'audio/webm' }) }));
      (this.listeners.stop || []).forEach((fn) => fn());
    }
  }
  window.MediaRecorder = FakeRecorder;
  class FakeChannel {
    constructor() { this.readyState = 'connecting'; this.sent = []; this.listeners = {}; window.__dc = this; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 'closed'; }
    emit(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event)); }
    serverEvent(event) { this.emit('message', { data: JSON.stringify(event) }); }
  }
  class FakePeer {
    constructor() { this.connectionState = 'new'; window.__pc = this; this.tracks = 0; }
    addTrack() { this.tracks += 1; }
    createDataChannel(label) { this.label = label; this.channel = new FakeChannel(); return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0 harness-offer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      setTimeout(() => { this.connectionState = 'connected'; this.channel.readyState = 'open'; this.channel.emit('open', {}); }, 20);
    }
    close() { this.connectionState = 'closed'; }
  }
  window.RTCPeerConnection = FakePeer;
}
