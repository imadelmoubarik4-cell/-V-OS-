// Accounting (#accounting, #accounting/<tab>, #accounting/document/<id>) —
// supplier invoices, receipts and staff reimbursements. Administrators only.
//
// Upload a photo or PDF → Atlas may read it into a draft (only when Atlas AI
// is on; typed values are never overwritten) → an administrator checks and
// approves it → marks it paid, or reimbursed when a team member paid. Nothing
// is posted to an accounting system: Export gives the accountant a CSV and
// the original files for a month. Documents are kept for 7 years: a mistaken
// upload is discarded, an approved document can only be voided.
//
// Files never pass through browser storage credentials: the atlas-accounting
// gateway stores them privately and returns 5-minute signed links.
(function () {
  'use strict';

  const cfg = window.VABAR_CONFIG || {};
  const ADMIN = ['admin'];
  const REQUEST_TIMEOUT_MS = 20000;
  const LONG_TIMEOUT_MS = 70000;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const IMAGE_EDGE = 2400;
  const TABS = [['review', 'To review'], ['unpaid', 'Unpaid'], ['owed', 'Owed to team'], ['all', 'All'], ['export', 'Export']];
  const KINDS = { invoice: 'Invoice', receipt: 'Receipt', credit_note: 'Credit note', other: 'Other' };
  const CATEGORIES = { drinks: 'Drinks', food: 'Food', supplies: 'Bar supplies', cleaning: 'Cleaning', repairs: 'Repairs and maintenance', rent: 'Rent', utilities: 'Utilities', staff: 'Staff', marketing: 'Marketing', other: 'Other' };
  const METHODS = { bank_transfer: 'Bank transfer', card: 'Card', cash: 'Cash', other: 'Other' };
  const VAT_RATES = [24, 11, 0];
  const HISTORY = {
    uploaded: 'Uploaded', read_started: 'Atlas started reading', read: 'Atlas read it', read_failed: 'Atlas couldn’t read it',
    edited: 'Edited', approved: 'Approved', reopened: 'Reopened', paid: 'Marked paid', unpaid: 'Payment undone',
    voided: 'Voided', discarded: 'Discarded', file_opened: 'File opened', exported: 'Exported'
  };

  // Fixed copy per gateway error code (server text is never rendered).
  const ERROR_COPY = {
    invalid_request: 'Some of the details were not valid. Check them and try again.',
    forbidden: 'Accounting is for administrators.',
    not_found: 'That document could not be found. It may have been discarded.',
    stale_request: 'This document changed while you were working. It has been reloaded — check it and try again.',
    conflict: 'This was already done. Refresh and try again.',
    duplicate_file: 'This file is already in Accounting.',
    possible_duplicate: 'This looks like a document that is already in Accounting.',
    missing_fields: 'Add the supplier, the document date and the total before approving.',
    append_only: 'Accounting records are kept for 7 years and can’t be deleted.',
    too_large: 'Files can be up to 15 MB.',
    unsupported_type: 'Upload a PDF, or a JPEG, PNG, WebP or HEIC photo.',
    rate_limited: 'Atlas has read today’s limit of documents. Type the details in by hand, or try again tomorrow.',
    storage_failed: 'The file could not be stored. Nothing was saved. Try again.',
    unavailable: 'Accounting is unavailable right now. Nothing was changed. Try again in a moment.',
    internal: 'Accounting could not complete that request. Nothing was changed.'
  };

  const state = {
    workspace: null, tab: 'review', filter: 'all', query: '', month: null,
    loading: false, error: null, registered: false, initialized: false, openId: null, exporting: false
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = () => window.AtlasVenueClock;
  const venueToday = () => state.workspace?.today || clock()?.venueDate?.() || new Date().toISOString().slice(0, 10);
  const dateOnly = (value, fallback = 'No date') => (value ? clock()?.formatDate?.(value, {}, fallback) || String(value) : fallback);
  const dateTime = (value) => (value ? clock()?.formatDateTime?.(value, {}, '—') || String(value) : '—');
  const requestId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;

  // Krónur read like the rest of Atlas ("3.900 kr", whole krónur) through the
  // shared AtlasFormat.money; other currencies keep their decimals (Intl).
  function money(value, currency = 'ISK') {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    const code = String(currency || 'ISK').toUpperCase();
    if (code === 'ISK') {
      if (window.AtlasFormat?.money) return window.AtlasFormat.money(number, '—');
      return `${number < 0 ? '-' : ''}${String(Math.abs(Math.round(number))).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} kr`;
    }
    try {
      return new Intl.NumberFormat('is-IS', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
    } catch {
      return `${number.toFixed(2)} ${code}`;
    }
  }

  // Accepts 12345, 12345.5, 12.345, 12.345,50 and 12 345,50.
  function parseAmount(text) {
    let value = String(text ?? '').replace(/[\s ]|kr\.?|isk/gi, '');
    if (!value) return null;
    if (value.includes(',') && value.includes('.')) value = value.replace(/\./g, '').replace(',', '.');
    else if (value.includes(',')) value = value.replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(value)) value = value.replace(/\./g, '');
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : NaN;
  }
  const amountInput = (value) => (value === null || value === undefined ? '' : String(value).replace(/\.00$/, ''));

  function profile() { return window.AtlasShell?.profile?.() || window.atlasCurrentProfile || null; }
  function isAdmin() { const p = profile(); return Boolean(p && p.active !== false && ADMIN.includes(p.role)); }
  function host() { return document.getElementById('accounting-view'); }
  function visible() { return window.AtlasShell?.current?.() === 'accounting'; }
  const documents = () => (Array.isArray(state.workspace?.documents) ? state.workspace.documents : []);
  const suppliers = () => (Array.isArray(state.workspace?.suppliers) ? state.workspace.suppliers : []);
  const orders = () => (Array.isArray(state.workspace?.orders) ? state.workspace.orders : []);
  const team = () => (Array.isArray(state.workspace?.team) ? state.workspace.team : []);
  const byId = (id) => documents().find((doc) => doc.id === id) || null;

  // ---------- data ----------

  async function api(action, { method = 'GET', params = {}, body = null, form = null, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const endpoint = String(cfg.ACCOUNTING_API || '').trim();
    if (!endpoint) throw Object.assign(new Error('not configured'), { status: 404 });
    const client = window.atlasSupabase;
    const { data } = client?.auth ? await client.auth.getSession() : { data: null };
    const token = data?.session?.access_token;
    if (!token) throw Object.assign(new Error('session'), { status: 401 });
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([key, value]) => { if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value)); });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    try {
      const response = await fetch(url, { method, cache: 'no-store', signal: controller.signal, headers, body: form || (body ? JSON.stringify(body) : undefined) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status, code: payload.error_code, payload });
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function errorText(error) {
    if (error?.status === 401) return 'Atlas couldn’t confirm your sign-in for this. Try again in a moment.';
    if (error?.status === 403) return 'Accounting is for administrators.';
    if (error?.status === 404 && !error.code) return 'Accounting isn’t switched on for this venue yet.';
    if (error?.name === 'AbortError') return 'The connection timed out. Check the list before trying again.';
    if (error?.code && ERROR_COPY[error.code]) return ERROR_COPY[error.code];
    return 'Nothing was changed. Check the connection and try again.';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    render();
    try {
      const payload = await api('snapshot');
      state.workspace = payload.workspace || {};
      state.error = null;
    } catch (error) {
      state.error = error;
    } finally {
      state.loading = false;
      render();
      if (state.openId && state.workspace) openDocument(state.openId);
    }
  }

  function remember(doc) {
    if (!doc?.id || !state.workspace) return;
    const list = documents();
    const index = list.findIndex((entry) => entry.id === doc.id);
    const { history, ...row } = doc;
    if (index >= 0) list[index] = { ...list[index], ...row };
    else list.unshift(row);
    state.workspace.documents = list;
  }

  // ---------- labels ----------

  function statusPill(doc) {
    const staff = doc.paid_by === 'staff';
    const [label, tone] = {
      to_review: ['To review', 'info'],
      approved: [staff ? 'To reimburse' : 'Unpaid', 'warning'],
      paid: [staff ? 'Reimbursed' : 'Paid', 'positive'],
      void: ['Void', 'neutral'],
      discarded: ['Discarded', 'neutral']
    }[doc.status] || [doc.status, 'neutral'];
    return `<span class="atlas-pill atlas-pill--${tone}">${escapeHtml(label)}</span>`;
  }
  function flagPills(doc) {
    const out = [];
    if (doc.checks?.overdue) out.push('<span class="atlas-pill atlas-pill--danger">Overdue</span>');
    if (doc.status === 'to_review' && doc.checks?.possible_duplicates?.length) out.push('<span class="atlas-pill atlas-pill--warning">Possible duplicate</span>');
    if (doc.extraction_status === 'reading') out.push('<span class="atlas-pill atlas-pill--info">Reading…</span>');
    return out.join('');
  }
  function title(doc) {
    return doc.supplier_name || doc.file_name || `${KINDS[doc.kind] || 'Document'} without a supplier`;
  }
  function meta(doc) {
    return [
      KINDS[doc.kind] || 'Document',
      doc.document_number ? `No. ${doc.document_number}` : null,
      dateOnly(doc.issue_date),
      money(doc.total_amount, doc.currency),
      doc.status === 'approved' && doc.due_date ? `Due ${dateOnly(doc.due_date)}` : null,
      doc.paid_by === 'staff' ? `Paid by ${doc.paid_by_label || 'a team member'}` : null
    ].filter(Boolean).join(' · ');
  }

  // `status: false` leaves out the status pill (the To review tab says it).
  function row(doc, action = '', { status = true } = {}) {
    return `<li class="atlas-row atlas-row--link acc-row" data-acc-row="${escapeHtml(doc.id)}">
        <span class="atlas-row__icon">${icon(doc.mime_type === 'application/pdf' ? 'file-text' : 'receipt-text')}</span>
        <div class="atlas-row__body"><p class="atlas-row__title"><button type="button" class="atlas-row__link acc-link" data-acc-open="${escapeHtml(doc.id)}">${escapeHtml(title(doc))}</button></p><p class="atlas-row__meta">${escapeHtml(meta(doc))}</p></div>
        <div class="atlas-row__end acc-row__end">${flagPills(doc)}${status ? statusPill(doc) : ''}${action}</div></li>`;
  }
  const rowAction = (doc, label, attr) => `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm atlas-row__action" ${attr}="${escapeHtml(doc.id)}" aria-label="${escapeHtml(`${label}: ${title(doc)}`)}">${escapeHtml(label)}</button>`;

  function empty(iconName, heading, text, action = '') {
    return `<div class="atlas-empty"><div class="atlas-empty__icon">${icon(iconName)}</div><h3 class="atlas-empty__title">${escapeHtml(heading)}</h3>${text ? `<p class="atlas-empty__text">${escapeHtml(text)}</p>` : ''}${action ? `<div class="atlas-empty__actions">${action}</div>` : ''}</div>`;
  }
  const uploadButton = (variant = 'primary') => `<button type="button" class="atlas-btn atlas-btn--${variant}" data-acc-upload>${icon('upload')}Upload</button>`;
  const sum = (list) => list.reduce((total, doc) => total + (Number(doc.total_amount) || 0), 0);
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  // ---------- tabs ----------

  function reviewMarkup() {
    const list = documents().filter((doc) => doc.status === 'to_review');
    return list.length
      ? `<p class="acc-lead">Check what Atlas filled in, add anything missing and approve. Nothing is final until you approve it.</p><ul class="atlas-list">${list.map((doc) => row(doc, rowAction(doc, 'Review', 'data-acc-open'), { status: false })).join('')}</ul>`
      : empty('inbox', 'Nothing to review', 'Upload an invoice or a receipt — a photo or a PDF — and it waits here for you to check.', uploadButton('secondary'));
  }

  function unpaidMarkup() {
    const list = documents().filter((doc) => doc.status === 'approved' && doc.paid_by !== 'staff')
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    if (!list.length) return empty('circle-check', 'Nothing unpaid', 'Approved invoices that still need paying appear here, soonest due first.');
    const overdue = list.filter((doc) => doc.checks?.overdue);
    return `<div class="atlas-stats acc-stats">
        <div class="atlas-stat"><p class="atlas-stat__label">Unpaid</p><p class="atlas-stat__value">${escapeHtml(money(sum(list)))}</p><p class="atlas-stat__detail">${plural(list.length, 'document', 'documents')}</p></div>
        <div class="atlas-stat"><p class="atlas-stat__label">Overdue</p><p class="atlas-stat__value">${escapeHtml(money(sum(overdue)))}</p><p class="atlas-stat__detail">${plural(overdue.length, 'document', 'documents')}</p></div>
      </div>
      <ul class="atlas-list">${list.map((doc) => row(doc, rowAction(doc, 'Mark paid', 'data-acc-pay'))).join('')}</ul>`;
  }

  function owedGroups() {
    const groups = new Map();
    documents().filter((doc) => doc.status === 'approved' && doc.paid_by === 'staff').forEach((doc) => {
      const key = doc.paid_by_profile_id || 'unknown';
      if (!groups.has(key)) groups.set(key, { key, label: doc.paid_by_label || 'Team member', docs: [] });
      groups.get(key).docs.push(doc);
    });
    return groups;
  }

  function owedMarkup() {
    const groups = owedGroups();
    if (!groups.size) return empty('hand-coins', 'Nobody is owed money', 'When a team member pays with their own money, upload the receipt and choose who paid. It shows here until you reimburse them.');
    return [...groups.values()].map((group) => `<section class="atlas-section acc-owed" data-acc-owed="${escapeHtml(group.key)}"><div class="atlas-section__head"><h2 class="atlas-section__title">${escapeHtml(group.label)}</h2><span class="atlas-section__meta">Owed ${escapeHtml(money(sum(group.docs)))}</span>${group.docs.length > 1 ? `<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm acc-owed__all" data-acc-pay-all="${escapeHtml(group.key)}" aria-label="${escapeHtml(`Mark all reimbursed: ${group.label}`)}">Mark all reimbursed</button>` : ''}</div>
        <ul class="atlas-list">${group.docs.map((doc) => row(doc, rowAction(doc, 'Mark reimbursed', 'data-acc-pay'))).join('')}</ul></section>`).join('');
  }

  const FILTERS = [['all', 'All'], ['to_review', 'To review'], ['approved', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void'], ['discarded', 'Discarded']];
  function allMarkup() {
    const query = state.query.trim().toLowerCase();
    const list = documents().filter((doc) => {
      if (state.filter === 'all' ? doc.status === 'discarded' : doc.status !== state.filter) return false;
      if (!query) return true;
      return [doc.supplier_name, doc.document_number, doc.file_name, doc.note, doc.paid_by_label, String(doc.total_amount ?? '')]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
    // Six filters do not fit a phone: a select there, the segmented control elsewhere.
    return `<div class="atlas-toolbar acc-toolbar"><label class="atlas-search">${icon('search')}<input class="atlas-input" type="search" data-acc-search placeholder="Search supplier, number or amount" aria-label="Search documents" value="${escapeHtml(state.query)}" autocomplete="off"></label>
        <div class="atlas-segmented acc-filter" role="group" aria-label="Show">${FILTERS.map(([key, label]) => `<button type="button" aria-pressed="${state.filter === key}" data-acc-filter="${key}">${label}</button>`).join('')}</div>
        <select class="atlas-select acc-filter-select" data-acc-filter-select aria-label="Show">${FILTERS.map(([key, label]) => `<option value="${key}"${state.filter === key ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <div class="atlas-toolbar__end">${plural(list.length, 'document', 'documents')}</div></div>
      ${list.length ? `<ul class="atlas-list">${list.map((doc) => row(doc)).join('')}</ul>` : '<p class="acc-muted">No documents match.</p>'}
      <p class="acc-muted">Shows open documents and everything from the last 13 months. Use Export for older months.</p>`;
  }

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function shiftMonth(key, delta) {
    const [year, month] = key.split('-').map(Number);
    const index = year * 12 + (month - 1) + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  }
  const monthLabel = (key) => { const [year, month] = key.split('-').map(Number); return `${MONTH_NAMES[month - 1]} ${year}`; };
  const defaultMonth = () => shiftMonth(venueToday().slice(0, 7), -1);
  function monthBounds(key) {
    const [year, month] = key.split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
  }
  const inRange = (doc, { from, to }) => Boolean(doc.issue_date && doc.issue_date >= from && doc.issue_date <= to);

  function exportMarkup() {
    const month = state.month || defaultMonth();
    const bounds = monthBounds(month);
    const current = venueToday().slice(0, 7);
    const months = Array.from({ length: 24 }, (_, index) => shiftMonth(current, -index));
    const inMonth = documents().filter((doc) => ['approved', 'paid', 'void'].includes(doc.status) && inRange(doc, bounds));
    const counted = inMonth.filter((doc) => doc.status !== 'void');
    const vat = (rate) => counted.reduce((total, doc) => total + (doc.vat_lines || []).filter((line) => Number(line.rate) === rate).reduce((t, line) => t + (Number(line.vat) || 0), 0), 0);
    const waiting = documents().filter((doc) => doc.status === 'to_review' && (!doc.issue_date || inRange(doc, bounds))).length;
    // The workspace holds the last 13 months: an empty month in it is really empty.
    const nothing = !inMonth.length && month >= shiftMonth(current, -12);
    const exportedBefore = inMonth.some((doc) => doc.exported === true);
    const newSince = exportedBefore ? counted.filter((doc) => doc.exported === false).length : 0;
    const disabled = state.exporting || nothing ? ' disabled' : '';
    const alert = (tone, head, text) => `<div class="atlas-alert atlas-alert--${tone}" role="status">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(head)}</p><p class="atlas-alert__body">${escapeHtml(text)}</p></div></div>`;
    return `<div class="atlas-stack acc-export">
        <div class="atlas-field acc-export__month"><label for="acc-month">Month</label><select class="atlas-select" id="acc-month" data-acc-month>${months.map((key) => `<option value="${key}"${key === month ? ' selected' : ''}>${monthLabel(key)}</option>`).join('')}</select></div>
        <div class="atlas-stats acc-stats">
          <div class="atlas-stat"><p class="atlas-stat__label">Documents</p><p class="atlas-stat__value">${counted.length}</p><p class="atlas-stat__detail">${inMonth.length - counted.length} void</p></div>
          <div class="atlas-stat"><p class="atlas-stat__label">Total</p><p class="atlas-stat__value">${escapeHtml(money(sum(counted)))}</p></div>
          <div class="atlas-stat"><p class="atlas-stat__label">VAT 24%</p><p class="atlas-stat__value">${escapeHtml(money(vat(24)))}</p></div>
          <div class="atlas-stat"><p class="atlas-stat__label">VAT 11%</p><p class="atlas-stat__value">${escapeHtml(money(vat(11)))}</p></div>
        </div>
        ${waiting ? alert('warning', `${waiting} ${waiting === 1 ? 'document is' : 'documents are'} still to review`, 'Only approved documents are exported. Review the ones dated in this month, or without a date, first.') : ''}
        ${newSince ? alert('info', `${newSince} ${newSince === 1 ? 'document in this month was' : 'documents in this month were'} approved after it was last exported`, 'Export the month again and send your accountant the new spreadsheet.') : ''}
        <p class="acc-lead">For your accountant (Regla, Payday): every approved, paid and void document dated in this month. The spreadsheet (CSV) opens in a spreadsheet app or imports into accounting software; the ZIP has the original files plus the spreadsheet. Void documents are listed, marked “No – void” under Counted, and left out of the totals.</p>
        ${nothing ? '<p class="acc-muted" data-acc-export-empty>Nothing approved is dated in this month.</p>' : ''}
        <div class="acc-export__actions"><button type="button" class="atlas-btn atlas-btn--primary" data-acc-export="csv"${disabled}>${icon('file-spreadsheet')}Download spreadsheet</button><button type="button" class="atlas-btn atlas-btn--secondary" data-acc-export="csv-is"${disabled}>${icon('file-spreadsheet')}Spreadsheet (Excel, Icelandic)</button><button type="button" class="atlas-btn atlas-btn--secondary" data-acc-export="zip"${disabled}>${icon('file-archive')}Download files (ZIP)</button></div>
        <p class="atlas-field__help">Use “Excel, Icelandic” when Excel on this computer writes decimals with a comma: its columns are separated by semicolons.</p>
        <p class="acc-muted" data-acc-export-status aria-live="polite"></p>
      </div>`;
  }

  const tabRoute = (key) => `#accounting${key === 'review' ? '' : `/${key}`}`;

  function render() {
    const element = host();
    if (!element) return;
    if (!isAdmin()) {
      element.innerHTML = `<div class="atlas-page acc-page">${window.AtlasShell.pageHead({ title: 'Accounting' })}${empty('lock', 'Accounting is for administrators', 'Invoices, receipts and payments are only visible to administrators.', '<a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a>')}</div>`;
      window.lucide?.createIcons?.();
      return;
    }
    const review = documents().filter((doc) => doc.status === 'to_review').length;
    const unpaid = documents().filter((doc) => doc.status === 'approved' && doc.paid_by !== 'staff').length;
    const owed = documents().filter((doc) => doc.status === 'approved' && doc.paid_by === 'staff').length;
    let body;
    if (state.error && !state.workspace) body = `<div class="atlas-alert atlas-alert--danger" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Accounting couldn’t be loaded.</p><p class="atlas-alert__body">${escapeHtml(errorText(state.error))}</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-acc-retry>Try again</button></div></div>`;
    else if (!state.workspace) body = `<div class="acc-skeleton" aria-busy="true" aria-label="Loading accounting">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(5)}</div>`;
    else body = ({ unpaid: unpaidMarkup, owed: owedMarkup, all: allMarkup, export: exportMarkup })[state.tab]?.() || reviewMarkup();
    const count = (key) => ({ review, unpaid, owed })[key] || 0;
    // Upload waits for the workspace (the team list and whether Atlas reads).
    const uploadAttrs = state.workspace ? { 'data-acc-upload': '' } : { 'data-acc-upload': '', disabled: '' };
    element.innerHTML = `<div class="atlas-page acc-page">
        ${window.AtlasShell.pageHead({ title: 'Accounting', sub: state.workspace ? `${review} to review · ${unpaid} unpaid · ${owed} owed to team` : 'Invoices, receipts and reimbursements', actions: [{ label: 'Upload', icon: 'upload', variant: 'primary', attrs: uploadAttrs }] })}
        <nav class="atlas-tabs acc-tabs" aria-label="Accounting">${TABS.map(([key, label]) => `<a href="${tabRoute(key)}"${state.tab === key ? ' aria-current="page"' : ''}>${label}${count(key) ? ` <span class="count">${count(key)}</span>` : ''}</a>`).join('')}</nav>
        <div class="acc-body">${body}</div>
      </div>`;
    window.lucide?.createIcons?.();
    // Phones scroll the tab strip sideways: keep the current tab in view.
    const strip = element.querySelector('.acc-tabs');
    const active = strip?.querySelector('[aria-current="page"]');
    if (strip && active && strip.scrollWidth > strip.clientWidth) {
      const offset = active.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      strip.scrollLeft = Math.max(0, offset - (strip.clientWidth - active.offsetWidth) / 2);
    }
  }

  // ---------- sheets ----------

  function modal(id, options = {}) {
    let element = document.getElementById(id);
    if (!element) {
      element = document.createElement('div');
      element.id = id;
      element.className = 'atlas-modal';
      element.hidden = true;
      element.setAttribute('data-atlas-modal', '');
      document.body.appendChild(element);
      window.AtlasModal.register(element, { closeOnBackdrop: true, ...options });
    } else if (!element.classList.contains('is-open')) {
      // Modal roots share one z-index: the last in the page paints on top and
      // is the one Escape closes. A reused dialog (Mark paid from the list,
      // then from inside a document sheet) moves to the end before it opens.
      document.body.appendChild(element);
    }
    return element;
  }
  const toast = (message, tone) => window.AtlasShell?.toast?.(message, tone ? { tone } : undefined);

  // One error slot per sheet or dialog: a danger alert at the top of its body,
  // scrolled into view. The field at fault is marked until it is edited.
  const errorSlot = () => `<div class="atlas-alert atlas-alert--danger acc-error" role="alert" data-acc-error hidden>${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title" data-acc-error-text></p></div></div>`;
  function showError(root, message, field = null) {
    const box = root.querySelector('[data-acc-error]');
    if (!box) return;
    box.hidden = !message;
    box.querySelector('[data-acc-error-text]').textContent = message || '';
    if (!message) return;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus({ preventScroll: true }); }
    box.scrollIntoView?.({ block: 'nearest' });
  }
  function clearInvalidOnEdit(root) {
    const clear = (event) => { if (event.target instanceof Element && event.target.hasAttribute('aria-invalid')) event.target.removeAttribute('aria-invalid'); };
    root.addEventListener('input', clear);
    root.addEventListener('change', clear);
  }

  // Photos are resized on the device (longest edge 2400 px, JPEG) so a phone
  // photo uploads quickly and Atlas can read it. A browser that cannot decode
  // the photo (HEIC outside Safari) uploads the original.
  async function prepareFile(file) {
    if (!/^image\//.test(file.type) || typeof window.createImageBitmap !== 'function') return file;
    try {
      const bitmap = await window.createImageBitmap(file);
      const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size <= 3 * 1024 * 1024 && /jpe?g|png|webp/.test(file.type)) { bitmap.close?.(); return file; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob) return file;
      return new File([blob], `${(file.name || 'photo').replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
    } catch {
      return file;
    }
  }

  function payerFields(prefix, doc = null) {
    const staff = doc?.paid_by === 'staff';
    const people = team().filter((person) => person.active || person.id === doc?.paid_by_profile_id);
    return `<fieldset class="acc-payer"><legend class="atlas-label">Who paid?</legend>
        <div class="atlas-chips"><label class="atlas-check-row"><input type="radio" class="atlas-radio" name="paid_by" value="company"${staff ? '' : ' checked'}>The business</label>
        <label class="atlas-check-row"><input type="radio" class="atlas-radio" name="paid_by" value="staff"${staff ? ' checked' : ''}>A team member, with their own money</label></div>
        <div class="atlas-field acc-payer__who"${staff ? '' : ' hidden'}><label for="${prefix}-payer">Team member</label><select class="atlas-select" id="${prefix}-payer" name="paid_by_profile_id"><option value="">Choose who paid</option>${people.map((person) => `<option value="${escapeHtml(person.id)}"${person.id === doc?.paid_by_profile_id ? ' selected' : ''}>${escapeHtml(person.label)}</option>`).join('')}</select><p class="help">They show under Owed to team until you mark them reimbursed.</p></div>
      </fieldset>`;
  }
  function wirePayer(root) {
    const who = root.querySelector('.acc-payer__who');
    if (!who) return;
    root.querySelectorAll('input[name="paid_by"]').forEach((input) => input.addEventListener('change', () => { who.hidden = root.querySelector('input[name="paid_by"]:checked')?.value !== 'staff'; }));
  }

  function openUpload() {
    const root = modal('acc-upload');
    const aiOn = state.workspace?.ai_enabled === true;
    const files = [];
    root.innerHTML = `<section class="atlas-sheet" data-modal-panel aria-labelledby="acc-upload-title">
        <span class="atlas-sheet__grabber"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="acc-upload-title">Upload invoices or receipts</h2><p class="atlas-sheet__desc">${aiOn ? 'Atlas reads each one and fills in what it can. You check and approve it.' : 'You type in the details and approve them. Atlas reading is off (Settings › Atlas AI).'}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close>${icon('x')}</button></header>
        <form class="atlas-sheet__body atlas-form acc-upload" data-acc-upload-form>
          ${errorSlot()}
          <label class="atlas-upload acc-drop" data-acc-drop><span class="atlas-upload__thumb">${icon('file-up')}</span><span class="atlas-upload__body"><span class="atlas-upload__title">Choose files</span><span class="atlas-upload__help">PDF or photo, up to 15 MB each. You can choose several.</span></span><input type="file" class="acc-file-input" data-acc-files accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf,.heic" multiple></label>
          <label class="atlas-btn atlas-btn--secondary acc-camera">${icon('camera')}Take a photo<input type="file" class="acc-file-input" data-acc-camera accept="image/*" capture="environment"></label>
          <ul class="atlas-list acc-queue" data-acc-queue aria-live="polite"></ul>
          ${payerFields('acc-up')}
        </form>
        <footer class="atlas-sheet__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close data-acc-cancel>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-acc-start disabled>Upload</button></footer>
      </section>`;
    const queue = root.querySelector('[data-acc-queue]');
    const start = root.querySelector('[data-acc-start]');
    const fail = (message, field = null) => showError(root, message, field);
    // A finished row is a row link (row buttons are hidden on phones).
    const drawQueue = () => {
      queue.innerHTML = files.map((entry, index) => {
        const name = escapeHtml(entry.file.name || 'Photo');
        const titleMarkup = entry.docId ? `<button type="button" class="atlas-row__link" data-acc-q-open="${escapeHtml(entry.docId)}">${name}</button>` : name;
        const end = entry.docId ? `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-acc-q-open="${escapeHtml(entry.docId)}" aria-label="Open ${name}">Open</button>` : entry.started ? '' : `<button type="button" class="atlas-icon-btn" data-acc-q-remove="${index}" aria-label="Remove ${name}">${icon('x')}</button>`;
        return `<li class="atlas-row atlas-row--compact"><span class="atlas-row__icon">${icon(entry.file.type === 'application/pdf' ? 'file-text' : 'image')}</span><div class="atlas-row__body"><p class="atlas-row__title">${titleMarkup}</p><p class="atlas-row__meta" data-acc-q-status="${index}">${escapeHtml(entry.status || `${Math.max(1, Math.round(entry.file.size / 1024))} KB`)}</p></div><div class="atlas-row__end">${end}</div></li>`;
      }).join('');
      const waiting = files.filter((entry) => !entry.started).length;
      start.disabled = !waiting;
      start.textContent = waiting > 1 ? `Upload ${waiting} files` : 'Upload';
      root.querySelector('[data-acc-cancel]').textContent = files.some((entry) => entry.docId) ? 'Done' : 'Cancel';
      window.lucide?.createIcons?.();
    };
    const add = (list) => {
      fail('');
      [...list].forEach((file) => {
        if (file.size > MAX_FILE_BYTES) { fail(`${file.name} is larger than 15 MB.`); return; }
        files.push({ file, status: '', started: false });
      });
      drawQueue();
    };
    root.querySelector('[data-acc-files]').addEventListener('change', (event) => { add(event.target.files); event.target.value = ''; });
    root.querySelector('[data-acc-camera]').addEventListener('change', (event) => { add(event.target.files); event.target.value = ''; });
    const drop = root.querySelector('[data-acc-drop]');
    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('is-dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('is-dragover'); add(event.dataTransfer?.files || []); });
    queue.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-acc-q-remove]');
      if (remove) { files.splice(Number(remove.dataset.accQRemove), 1); drawQueue(); return; }
      const open = event.target.closest('[data-acc-q-open]');
      if (open) { window.AtlasModal.close(root, 'open'); openRoute(open.dataset.accQOpen); }
    });
    wirePayer(root);
    clearInvalidOnEdit(root);
    const setStatus = (entry, text) => { entry.status = text; drawQueue(); };
    start.addEventListener('click', async () => {
      const form = root.querySelector('form');
      const paidBy = form.querySelector('input[name="paid_by"]:checked')?.value || 'company';
      const payer = form.elements.paid_by_profile_id.value;
      if (paidBy === 'staff' && !payer) { fail('Choose the team member who paid.', form.elements.paid_by_profile_id); return; }
      fail('');
      start.disabled = true;
      const fields = paidBy === 'staff' ? { paid_by: 'staff', paid_by_profile_id: payer } : {};
      const created = [];
      for (const entry of files.filter((item) => !item.started)) {
        entry.started = true;
        setStatus(entry, 'Preparing…');
        try {
          const upload = await prepareFile(entry.file);
          const data = new FormData();
          data.set('request_id', entry.requestId || (entry.requestId = requestId()));
          data.set('fields', JSON.stringify(fields));
          data.set('file', upload, upload.name || entry.file.name || 'document');
          setStatus(entry, 'Uploading…');
          const result = await api('upload', { method: 'POST', form: data, timeout: LONG_TIMEOUT_MS });
          entry.docId = result.document?.id;
          remember(result.document);
          created.push(entry.docId);
          if (result.readable && aiOn) {
            setStatus(entry, 'Uploaded · Atlas is reading it…');
            try {
              const read = await api('read', { method: 'POST', body: { id: entry.docId }, timeout: LONG_TIMEOUT_MS });
              remember(read.document);
              setStatus(entry, read.outcome === 'read' ? 'Read by Atlas — check it and approve' : 'Uploaded — type in the details');
            } catch (error) {
              setStatus(entry, error?.code === 'rate_limited' ? ERROR_COPY.rate_limited : 'Uploaded — Atlas couldn’t read it, type in the details');
            }
          } else {
            setStatus(entry, 'Uploaded — type in the details');
          }
        } catch (error) {
          entry.started = error?.code === 'duplicate_file';
          if (error?.code === 'duplicate_file') { entry.docId = error.payload?.existing?.id || null; setStatus(entry, 'Already in Accounting'); }
          else setStatus(entry, errorText(error));
        }
      }
      render();
      if (created.length === 1 && files.every((entry) => entry.started)) {
        window.AtlasModal.close(root, 'done');
        openRoute(created[0]);
      } else if (created.length) {
        toast(`${created.length} uploaded. They’re waiting in To review.`, 'success');
      }
      drawQueue();
    });
    window.AtlasModal.open(root);
    window.lucide?.createIcons?.();
  }

  function readBanner(doc) {
    const canRead = doc.status === 'to_review' && doc.has_file && Number(doc.byte_size || 0) <= 5 * 1024 * 1024 && /pdf|jpeg|png|webp/.test(doc.mime_type || '') && state.workspace?.ai_enabled;
    const again = canRead ? '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-acc-read>Read again</button>' : '';
    const alert = (tone, head, text, actions = '') => `<div class="atlas-alert atlas-alert--${tone}" role="status">${icon(tone === 'info' ? 'sparkles' : 'circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(head)}</p>${text ? `<p class="atlas-alert__body">${escapeHtml(text)}</p>` : ''}</div>${actions ? `<div class="atlas-alert__actions">${actions}</div>` : ''}</div>`;
    switch (doc.extraction_status) {
      case 'read': return doc.status === 'to_review' ? alert('info', 'Atlas read this document', 'It filled in the empty fields, marked “Filled by Atlas”. Check every value against the document before approving.') : '';
      case 'reading': return alert('info', 'Atlas is reading it…', 'If this takes more than a minute, try again.', again);
      case 'failed': return alert('warning', 'Atlas couldn’t read it right now', 'Type in the details, or try again.', again);
      case 'not_readable': return doc.status === 'to_review' ? alert('warning', 'Atlas couldn’t read this file', 'Type in the details from the document.') : '';
      case 'not_configured': return doc.status === 'to_review' ? alert('warning', 'Atlas reading is off', 'Type in the details, or switch on Atlas AI in Settings.', again) : '';
      default: return canRead ? alert('info', 'Let Atlas fill it in', 'Atlas reads the supplier, dates, amounts and VAT. You check them before approving.', '<button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-acc-read>Read with Atlas</button>') : '';
    }
  }

  function checksMarkup(doc) {
    const out = [];
    const c = doc.checks || {};
    const alert = (tone, head, text, actions = '') => out.push(`<div class="atlas-alert atlas-alert--${tone}" role="status">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">${escapeHtml(head)}</p>${text ? `<p class="atlas-alert__body">${text}</p>` : ''}</div>${actions}</div>`);
    if (c.overdue) alert('danger', `Overdue since ${dateOnly(doc.due_date)}`, '');
    if (doc.status === 'to_review' && c.possible_duplicates?.length) {
      alert('warning', 'This may already be in Accounting', `Same supplier and ${c.possible_duplicates.some((d) => d.document_number) ? 'number' : 'date and total'}: ${c.possible_duplicates.map((d) => `<button type="button" class="atlas-link" data-acc-open="${escapeHtml(d.id)}">${escapeHtml(d.document_number ? `No. ${d.document_number}` : dateOnly(d.issue_date))} (${escapeHtml(d.status === 'to_review' ? 'to review' : d.status)})</button>`).join(', ')}`);
    }
    if (c.totals_mismatch) alert('warning', 'The amounts don’t add up', 'Net plus VAT is not the total. Check them against the document.');
    if (c.vat_lines_mismatch) alert('warning', 'The VAT lines don’t match the VAT total', '');
    if (c.order_difference !== null && c.order_difference !== undefined && Math.abs(Number(c.order_difference)) >= 1) {
      const diff = Number(c.order_difference);
      alert('info', `${money(Math.abs(diff), doc.currency)} ${diff > 0 ? 'more' : 'less'} than the linked order`, `The order total is ${escapeHtml(money(doc.order?.total))}. Check prices, delivery charges or missing lines.`);
    }
    return out.join('');
  }

  function vatRowsMarkup(lines) {
    return (lines.length ? lines : [{ rate: 24, net: null, vat: null }]).map((line, index) => `<div class="acc-vat__row" data-acc-vat-row>
        <div class="atlas-field"><label for="acc-vat-rate-${index}">Rate</label><select class="atlas-select" id="acc-vat-rate-${index}" data-vat="rate">${VAT_RATES.map((rate) => `<option value="${rate}"${Number(line.rate) === rate ? ' selected' : ''}>${rate}%</option>`).join('')}</select></div>
        <div class="atlas-field"><label for="acc-vat-net-${index}">Net</label><input class="atlas-input" inputmode="decimal" id="acc-vat-net-${index}" data-vat="net" value="${escapeHtml(amountInput(line.net))}"></div>
        <div class="atlas-field"><label for="acc-vat-vat-${index}">VAT</label><input class="atlas-input" inputmode="decimal" id="acc-vat-vat-${index}" data-vat="vat" value="${escapeHtml(amountInput(line.vat))}"></div>
        <button type="button" class="atlas-icon-btn acc-vat__remove" data-acc-vat-remove aria-label="Remove this VAT line">${icon('x')}</button>
      </div>`).join('');
  }

  function readDetails(doc) {
    const read = doc.extraction?.fields;
    if (!read) return '';
    const rows = [
      ['Supplier', read.supplier_name], ['Kennitala', read.supplier_kennitala && kennitala(read.supplier_kennitala)], ['Number', read.document_number],
      ['Date', read.issue_date && dateOnly(read.issue_date)], ['Due', read.due_date && dateOnly(read.due_date)],
      ['Net', read.net_amount !== null && read.net_amount !== undefined ? money(read.net_amount, read.currency || doc.currency) : null],
      ['VAT', read.vat_amount !== null && read.vat_amount !== undefined ? money(read.vat_amount, read.currency || doc.currency) : null],
      ['Total', read.total_amount !== null && read.total_amount !== undefined ? money(read.total_amount, read.currency || doc.currency) : null]
    ].filter(([, value]) => value);
    const lines = Array.isArray(read.line_items) ? read.line_items : [];
    return `<details class="acc-details"><summary>What Atlas read</summary>
        <dl class="acc-kv">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
        ${lines.length ? `<div class="atlas-table-wrap atlas-table-wrap--scroll"><table class="atlas-table atlas-table--compact"><thead><tr><th>Line</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>${lines.map((line) => `<tr><td>${escapeHtml(line.description)}</td><td class="num">${escapeHtml(line.quantity ?? '')}</td><td class="num">${escapeHtml(line.amount !== null && line.amount !== undefined ? money(line.amount, doc.currency) : '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <p class="atlas-field__help">Lines are for reference; they don’t change stock or prices.</p></details>`;
  }

  const FIELD_LABELS = {
    kind: 'Type', category: 'Category', supplier_id: 'Supplier', supplier_name: 'Supplier', supplier_kennitala: 'Kennitala',
    document_number: 'Number', issue_date: 'Document date', due_date: 'Due date', currency: 'Currency',
    net_amount: 'Net', vat_amount: 'VAT', total_amount: 'Total', vat_lines: 'VAT lines', purchase_order_id: 'Purchase order',
    note: 'Note', paid_by: 'Who paid', paid_by_profile_id: 'Who paid'
  };
  const AMOUNT_FIELDS = ['net_amount', 'vat_amount', 'total_amount'];
  const DATE_FIELDS = ['issue_date', 'due_date'];
  // An edit lists the fields it changed; amounts, dates and the supplier show before → after.
  function changesText(doc, changes) {
    if (!changes || typeof changes !== 'object') return '';
    const value = (key, raw) => {
      if (raw === null || raw === undefined || raw === '') return '—';
      if (AMOUNT_FIELDS.includes(key)) return money(raw, doc.currency);
      if (DATE_FIELDS.includes(key)) return dateOnly(String(raw).slice(0, 10));
      return String(raw);
    };
    const seen = new Set();
    const parts = [];
    for (const [key, pair] of Object.entries(changes)) {
      const label = FIELD_LABELS[key];
      if (!label) continue;
      const detailed = AMOUNT_FIELDS.includes(key) || DATE_FIELDS.includes(key) || key === 'supplier_name';
      if (seen.has(label) && !detailed) continue;
      if (detailed && seen.has(label)) parts.splice(parts.indexOf(label), 1);
      seen.add(label);
      parts.push(detailed && Array.isArray(pair) ? `${label}: ${value(key, pair[0])} → ${value(key, pair[1])}` : label);
    }
    return parts.join(' · ');
  }

  function historyMarkup(doc) {
    // Opening the file is logged for the audit; it is not shown as history.
    const list = (Array.isArray(doc.history) ? doc.history : []).filter((event) => event.action !== 'file_opened');
    if (!list.length) return '';
    return `<details class="acc-details"><summary>History</summary><ul class="atlas-list">${list.map((event) => {
      const changed = event.action === 'edited' ? changesText(doc, event.details?.changes) : '';
      return `<li class="atlas-row atlas-row--compact"><div class="atlas-row__body"><p class="atlas-row__title">${escapeHtml(HISTORY[event.action] || event.action)}${event.details?.reason ? ` · ${escapeHtml(event.details.reason)}` : ''}</p>${changed ? `<p class="atlas-row__meta acc-changes">${escapeHtml(changed)}</p>` : ''}<p class="atlas-row__meta">${escapeHtml(event.actor_label)} · ${escapeHtml(dateTime(event.created_at))}</p></div></li>`;
    }).join('')}</ul></details>`;
  }

  function fileMarkup(doc) {
    if (!doc.has_file) return '<p class="acc-muted">The file was removed when this upload was discarded.</p>';
    return `<div class="acc-file" data-acc-file><p class="acc-muted">Loading the file…</p></div>`;
  }

  async function loadFile(root, doc) {
    const slot = root.querySelector('[data-acc-file]');
    if (!slot) return;
    try {
      const link = await api('file', { params: { id: doc.id } });
      if (!root.contains(slot)) return;
      const open = `<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link')}Open ${link.mime_type === 'application/pdf' ? 'PDF' : 'full size'}</a>`;
      slot.innerHTML = /^image\/(jpeg|png|webp)$/.test(link.mime_type)
        ? `<img class="acc-file__img" src="${escapeHtml(link.url)}" alt="${escapeHtml(`${KINDS[doc.kind] || 'Document'} from ${title(doc)}`)}">${open}`
        : `<div class="atlas-upload atlas-upload--file"><span class="atlas-upload__thumb">${icon(link.mime_type === 'application/pdf' ? 'file-text' : 'image')}</span><span class="atlas-upload__body"><span class="atlas-upload__title">${escapeHtml(doc.file_name || (link.mime_type === 'application/pdf' ? 'PDF document' : 'Photo'))}</span><span class="atlas-upload__help">Opens in a new tab.</span></span>${open}</div>`;
      window.lucide?.createIcons?.();
    } catch (error) {
      slot.innerHTML = `<p class="acc-muted">${escapeHtml(errorText(error))}</p>`;
    }
  }

  // The document sheet has its own address (#accounting/document/<id>) so the
  // phone's Back closes it. Opening from the page pushes that address and the
  // route opens the sheet; a document opened from inside the sheet replaces it.
  function openRoute(id) {
    const shell = window.AtlasShell;
    const target = `#accounting/document/${encodeURIComponent(id)}`;
    if (!shell?.navigate || shell.current?.() !== 'accounting') { openDocument(id); return; }
    const fromSheet = window.AtlasModal.isOpen('acc-document');
    if (!fromSheet) state.routePushed = true;
    shell.navigate(target, fromSheet ? { replace: true } : {});
  }

  function leaveDocumentRoute() {
    if (!/^#accounting\/document\//.test(window.location.hash)) return;
    if (state.routePushed) { state.routePushed = false; window.history.back(); return; }
    window.AtlasShell?.navigate?.(tabRoute(state.tab), { replace: true });
  }

  async function openDocument(id) {
    state.openId = id;
    const root = modal('acc-document', { initialFocus: '#acc-doc-title' });
    if (!root.dataset.accWired) {
      root.dataset.accWired = 'true';
      root.addEventListener('atlas:modal-close', (event) => {
        state.openId = null;
        delete root.dataset.docId;
        if (event.detail?.reason !== 'route') leaveDocumentRoute();
      });
    }
    let doc = byId(id);
    if (!state.workspace) return;
    try {
      const payload = await api('document', { params: { id } });
      doc = payload.document;
      remember(doc);
    } catch (error) {
      if (!doc) { toast(errorText(error), 'warning'); state.openId = null; leaveDocumentRoute(); return; }
    }
    if (state.openId !== id) return;
    const opening = !window.AtlasModal.isOpen(root);
    drawDocument(root, doc);
    if (opening) {
      window.AtlasModal.open(root);
      // The file, the read banner and the warnings come first: open at the top.
      const body = root.querySelector('.atlas-sheet__body');
      if (body) body.scrollTop = 0;
      window.requestAnimationFrame(() => { const again = root.querySelector('.atlas-sheet__body'); if (again) again.scrollTop = 0; });
    }
  }

  const CURRENCIES = ['ISK', 'EUR', 'USD', 'GBP', 'DKK', 'NOK', 'SEK'];
  const kennitala = (value) => { const digits = String(value || '').replace(/[^0-9]/g, ''); return digits.length === 10 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : digits; };
  const same = (a, b) => {
    if (a === null || a === undefined || a === '' || b === null || b === undefined || b === '') return false;
    if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 0.005;
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  };

  // "Filled by Atlas" under a field whose value is still what Atlas put there;
  // a warning where what Atlas read differs from the value now in the field.
  function hints(doc, key) {
    const prefill = doc.extraction?.prefill || {};
    const read = doc.extraction?.fields || {};
    const out = [];
    const keys = key === 'supplier' ? ['supplier_id', 'supplier_name'] : [key];
    if (keys.some((name) => Object.prototype.hasOwnProperty.call(prefill, name) && same(prefill[name], doc[name]))) {
      out.push(`<p class="atlas-field__help acc-filled">${icon('sparkles')}Filled by Atlas</p>`);
    }
    const readKey = key === 'supplier' ? 'supplier_name' : key;
    if (['supplier', 'issue_date', 'total_amount'].includes(key) && read[readKey] !== null && read[readKey] !== undefined && read[readKey] !== ''
      && doc[readKey] !== null && doc[readKey] !== undefined && doc[readKey] !== '' && !same(read[readKey], doc[readKey])) {
      const shown = key === 'total_amount' ? money(read.total_amount, read.currency || doc.currency) : key === 'issue_date' ? dateOnly(read.issue_date) : read.supplier_name;
      out.push(`<p class="atlas-field__help acc-differs">${icon('circle-alert')}Atlas read ${escapeHtml(shown)}. Check it against the document.</p>`);
    }
    return out.join('');
  }

  function factsMarkup(doc) {
    const dash = (value) => (value === null || value === undefined || value === '' ? '—' : value);
    const order = doc.order ? [doc.order.supplier_name || 'Order', dateOnly(String(doc.order.ordered_at || '').slice(0, 10), ''), money(doc.order.total)].filter(Boolean).join(' · ') : null;
    const lines = (doc.vat_lines || []).map((line) => `${line.rate}%: ${money(line.vat, doc.currency)} on ${money(line.net, doc.currency)}`).join(' · ');
    const facts = [
      ['Type', KINDS[doc.kind] || doc.kind], ['Category', CATEGORIES[doc.category] || null], ['Supplier', doc.supplier_name],
      ['Supplier kennitala', doc.supplier_kennitala ? kennitala(doc.supplier_kennitala) : null], ['Number', doc.document_number],
      ['Document date', doc.issue_date ? dateOnly(doc.issue_date) : null], ['Due date', doc.due_date ? dateOnly(doc.due_date) : null],
      ['Net (án VSK)', doc.net_amount !== null && doc.net_amount !== undefined ? money(doc.net_amount, doc.currency) : null],
      ['VAT', doc.vat_amount !== null && doc.vat_amount !== undefined ? money(doc.vat_amount, doc.currency) : null],
      ['VAT lines', lines || null],
      ['Total', doc.total_amount !== null && doc.total_amount !== undefined ? money(doc.total_amount, doc.currency) : null],
      ['Currency', doc.currency], ['Purchase order', order],
      ['Who paid', doc.paid_by === 'staff' ? doc.paid_by_label || 'A team member' : 'The business'], ['Note', doc.note]
    ];
    return `<dl class="acc-kv acc-facts" data-acc-facts>${facts.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(dash(value))}</dd></div>`).join('')}</dl>`;
  }

  function formMarkup(doc) {
    const supplierKnown = Boolean(doc.supplier_id);
    const ordersFor = orders().filter((order) => !doc.supplier_id || order.supplier_id === doc.supplier_id || order.id === doc.purchase_order_id);
    const currency = String(doc.currency || 'ISK').toUpperCase();
    const currencies = CURRENCIES.includes(currency) ? CURRENCIES : [...CURRENCIES, currency];
    return `<div class="atlas-grid-2">
              <div class="atlas-field"><label for="acc-kind">Type</label><select class="atlas-select" id="acc-kind" name="kind">${Object.entries(KINDS).map(([key, label]) => `<option value="${key}"${doc.kind === key ? ' selected' : ''}>${label}</option>`).join('')}</select>${hints(doc, 'kind')}</div>
              <div class="atlas-field"><label for="acc-category">Category <span class="optional">(optional)</span></label><select class="atlas-select" id="acc-category" name="category"><option value="">None</option>${Object.entries(CATEGORIES).map(([key, label]) => `<option value="${key}"${doc.category === key ? ' selected' : ''}>${label}</option>`).join('')}</select>${hints(doc, 'category')}</div>
            </div>
            <div class="atlas-field"><label for="acc-supplier">Supplier</label><select class="atlas-select" id="acc-supplier" name="supplier_id"><option value="">Not in Purchasing — type the name</option>${suppliers().map((s) => `<option value="${escapeHtml(s.id)}"${s.id === doc.supplier_id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>${supplierKnown ? hints(doc, 'supplier') : ''}</div>
            <div class="atlas-field acc-supplier-name"${supplierKnown ? ' hidden' : ''}><label for="acc-supplier-name">Supplier name</label><input class="atlas-input" id="acc-supplier-name" name="supplier_name" maxlength="200" value="${escapeHtml(supplierKnown ? '' : doc.supplier_name || '')}">${supplierKnown ? '' : hints(doc, 'supplier')}</div>
            <div class="atlas-grid-2">
              <div class="atlas-field"><label for="acc-number">Invoice or receipt number <span class="optional">(optional)</span></label><input class="atlas-input" id="acc-number" name="document_number" maxlength="80" value="${escapeHtml(doc.document_number || '')}">${hints(doc, 'document_number')}</div>
              <div class="atlas-field"><label for="acc-kt">Supplier kennitala <span class="optional">(optional)</span></label><input class="atlas-input" id="acc-kt" name="supplier_kennitala" inputmode="numeric" maxlength="11" placeholder="000000-0000" value="${escapeHtml(doc.supplier_kennitala ? kennitala(doc.supplier_kennitala) : '')}">${hints(doc, 'supplier_kennitala')}</div>
            </div>
            <div class="atlas-grid-2">
              <div class="atlas-field"><label for="acc-date">Document date</label><input class="atlas-input" type="date" id="acc-date" name="issue_date" value="${escapeHtml(doc.issue_date || '')}">${hints(doc, 'issue_date')}</div>
              <div class="atlas-field"><label for="acc-due">Due date <span class="optional">(optional)</span></label><input class="atlas-input" type="date" id="acc-due" name="due_date" data-atlas-min-from="acc-date" value="${escapeHtml(doc.due_date || '')}">${hints(doc, 'due_date')}</div>
            </div>
            <fieldset class="acc-vat"><legend class="atlas-label">VAT (VSK)</legend><div data-acc-vat-rows>${vatRowsMarkup(doc.vat_lines || [])}</div>
              <div class="acc-vat__tools"><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-acc-vat-add>${icon('plus')}Add a VAT rate</button><button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-acc-vat-fill>${icon('calculator')}Fill totals from VAT lines</button></div></fieldset>
            <div class="acc-amounts">
              <div class="atlas-field"><label for="acc-net">Net (án VSK)</label><input class="atlas-input" inputmode="decimal" id="acc-net" name="net_amount" value="${escapeHtml(amountInput(doc.net_amount))}">${hints(doc, 'net_amount')}</div>
              <div class="atlas-field"><label for="acc-vat-total">VAT</label><input class="atlas-input" inputmode="decimal" id="acc-vat-total" name="vat_amount" value="${escapeHtml(amountInput(doc.vat_amount))}">${hints(doc, 'vat_amount')}</div>
              <div class="atlas-field"><label for="acc-total">Total</label><input class="atlas-input" inputmode="decimal" id="acc-total" name="total_amount" value="${escapeHtml(amountInput(doc.total_amount))}">${hints(doc, 'total_amount')}</div>
              <div class="atlas-field"><label for="acc-currency">Currency</label><select class="atlas-select" id="acc-currency" name="currency">${currencies.map((code) => `<option value="${escapeHtml(code)}"${code === currency ? ' selected' : ''}>${escapeHtml(code)}</option>`).join('')}</select></div>
            </div>
            <div class="atlas-field"><label for="acc-order">Purchase order <span class="optional">(optional)</span></label><select class="atlas-select" id="acc-order" name="purchase_order_id"><option value="">None</option>${ordersFor.map((order) => `<option value="${escapeHtml(order.id)}"${order.id === doc.purchase_order_id ? ' selected' : ''}>${escapeHtml([suppliers().find((s) => s.id === order.supplier_id)?.name || 'Order', dateOnly(String(order.ordered_at || order.created_at || '').slice(0, 10)), money(order.total), order.status === 'received' ? 'received' : order.status].filter(Boolean).join(' · '))}</option>`).join('')}</select><p class="help">Links this document to what you ordered, so a price difference shows up.</p></div>
            ${payerFields('acc-doc', doc)}
            <div class="atlas-field"><label for="acc-note">Note <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="acc-note" name="note" rows="2" maxlength="2000">${escapeHtml(doc.note || '')}</textarea></div>`;
  }

  function drawDocument(root, doc) {
    const editable = doc.status === 'to_review';
    const footer = {
      to_review: `<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-acc-discard>Discard</button><button type="button" class="atlas-btn atlas-btn--secondary" data-acc-save>Save</button><button type="button" class="atlas-btn atlas-btn--primary" data-acc-approve>Approve</button>`,
      approved: `<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-acc-void>Void</button><button type="button" class="atlas-btn atlas-btn--secondary" data-acc-reopen>Reopen to edit</button><button type="button" class="atlas-btn atlas-btn--primary" data-acc-pay="${escapeHtml(doc.id)}">${doc.paid_by === 'staff' ? 'Mark reimbursed' : 'Mark paid'}</button>`,
      paid: `<button type="button" class="atlas-btn atlas-btn--ghost atlas-sheet__foot-start" data-acc-void>Void</button><button type="button" class="atlas-btn atlas-btn--secondary" data-acc-unpay>${doc.paid_by === 'staff' ? 'Undo reimbursement' : 'Undo payment'}</button>`
    }[doc.status] || '<button type="button" class="atlas-btn atlas-btn--secondary" data-modal-close>Close</button>';
    const paidLine = doc.status === 'paid'
      ? `<p class="acc-paid">${icon('circle-check')}${escapeHtml(doc.paid_by === 'staff' ? `Reimbursed to ${doc.paid_by_label || 'the team member'}` : 'Paid')} on ${escapeHtml(dateOnly(doc.paid_at))}${doc.payment_method ? ` · ${escapeHtml(METHODS[doc.payment_method] || doc.payment_method)}` : ''}${doc.payment_reference ? ` · ${escapeHtml(doc.payment_reference)}` : ''}</p>` : '';
    const voidLine = doc.status === 'void' ? `<div class="atlas-alert atlas-alert--warning" role="status">${icon('ban')}<div class="atlas-alert__content"><p class="atlas-alert__title">Void</p><p class="atlas-alert__body">${escapeHtml(doc.void_reason || '')}</p></div></div>` : '';
    // A redraw of the same document keeps the reader's place; another starts at the top.
    const previous = root.querySelector('.atlas-sheet__body');
    const keep = previous && root.dataset.docId === doc.id ? previous.scrollTop : 0;
    root.dataset.docId = doc.id;
    const details = editable
      ? `<form class="atlas-form acc-doc__form" data-acc-form novalidate>${voidLine}${paidLine}${readBanner(doc)}${checksMarkup(doc)}${formMarkup(doc)}${readDetails(doc)}${historyMarkup(doc)}</form>`
      : `<div class="acc-doc__form">${voidLine}${paidLine}${readBanner(doc)}${checksMarkup(doc)}${factsMarkup(doc)}${readDetails(doc)}${historyMarkup(doc)}</div>`;
    root.innerHTML = `<section class="atlas-sheet atlas-sheet--wide acc-sheet" data-modal-panel aria-labelledby="acc-doc-title">
        <span class="atlas-sheet__grabber"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="acc-doc-title" tabindex="-1">${escapeHtml(title(doc))}</h2><p class="atlas-sheet__desc">${statusPill(doc)} ${escapeHtml([KINDS[doc.kind], `Uploaded by ${doc.created_by_label}`, dateOnly(String(doc.created_at || '').slice(0, 10))].filter(Boolean).join(' · '))}${doc.approved_by_label ? ` · Approved by ${escapeHtml(doc.approved_by_label)}` : ''}</p></div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close>${icon('x')}</button></header>
        <div class="atlas-sheet__body acc-doc">
          ${errorSlot()}
          <div class="acc-doc__file">${fileMarkup(doc)}</div>
          ${details}
        </div>
        <footer class="atlas-sheet__foot">${footer}</footer>
      </section>`;
    root.querySelector('.atlas-sheet__body').scrollTop = keep;
    wireDocument(root, doc);
    window.lucide?.createIcons?.();
    loadFile(root, doc);
  }

  function collect(form) {
    const amounts = {};
    for (const name of ['net_amount', 'vat_amount', 'total_amount']) {
      const value = parseAmount(form.elements[name].value);
      if (Number.isNaN(value)) return { error: 'Enter amounts as numbers, like 12.345 or 12345,50.', field: form.elements[name] };
      amounts[name] = value;
    }
    const lines = [];
    for (const row of form.querySelectorAll('[data-acc-vat-row]')) {
      const net = parseAmount(row.querySelector('[data-vat="net"]').value);
      const vat = parseAmount(row.querySelector('[data-vat="vat"]').value);
      if (Number.isNaN(net) || Number.isNaN(vat)) return { error: 'Enter the VAT amounts as numbers.', field: row.querySelector(Number.isNaN(net) ? '[data-vat="net"]' : '[data-vat="vat"]') };
      if (net !== null || vat !== null) lines.push({ rate: Number(row.querySelector('[data-vat="rate"]').value), net, vat });
    }
    const kt = form.elements.supplier_kennitala.value.replace(/[^0-9]/g, '');
    if (kt && kt.length !== 10) return { error: 'A kennitala has 10 digits.', field: form.elements.supplier_kennitala };
    const currency = form.elements.currency.value.trim().toUpperCase() || 'ISK';
    if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Use a three-letter currency code, like ISK or EUR.', field: form.elements.currency };
    const issue = form.elements.issue_date.value;
    const due = form.elements.due_date.value;
    if (issue && due && due < issue) return { error: 'The due date is before the document date.', field: form.elements.due_date };
    const paidBy = form.querySelector('input[name="paid_by"]:checked')?.value || 'company';
    const supplierId = form.elements.supplier_id.value;
    return {
      fields: {
        kind: form.elements.kind.value, category: form.elements.category.value,
        supplier_id: supplierId, supplier_name: supplierId ? '' : form.elements.supplier_name.value.trim(),
        supplier_kennitala: kt, document_number: form.elements.document_number.value.trim(),
        issue_date: issue, due_date: due, currency, ...amounts, vat_lines: lines,
        purchase_order_id: form.elements.purchase_order_id.value, note: form.elements.note.value.trim(),
        paid_by: paidBy, paid_by_profile_id: paidBy === 'staff' ? form.elements.paid_by_profile_id.value : ''
      }
    };
  }

  async function command(doc, name, payload = {}) {
    const result = await api('command', { method: 'POST', body: { id: doc.id, version: doc.version, command: name, payload } });
    remember(result.document);
    return result.document;
  }

  function wireDocument(root, doc) {
    const form = root.querySelector('[data-acc-form]');
    const fail = (message, field = null) => showError(root, message, field);
    const busy = (on) => root.querySelectorAll('.atlas-sheet__foot .atlas-btn, [data-acc-read]').forEach((button) => { button.disabled = on; });
    const refresh = async (next, message) => {
      render();
      if (message) toast(message, 'success');
      const full = await api('document', { params: { id: next.id } }).then((payload) => payload.document).catch(() => next);
      remember(full);
      drawDocument(root, full);
    };
    const failed = async (error) => {
      if (error?.code === 'stale_request') {
        const fresh = await api('document', { params: { id: doc.id } }).then((payload) => payload.document).catch(() => null);
        if (fresh) { remember(fresh); drawDocument(root, fresh); render(); }
        toast(errorText(error), 'warning');
        return;
      }
      fail(errorText(error));
      busy(false);
    };
    clearInvalidOnEdit(root);

    if (form) {
      form.elements.supplier_id?.addEventListener('change', () => {
        root.querySelector('.acc-supplier-name').hidden = Boolean(form.elements.supplier_id.value);
      });
      wirePayer(root);
      const rows = root.querySelector('[data-acc-vat-rows]');
      root.querySelector('[data-acc-vat-add]')?.addEventListener('click', () => {
        const used = [...rows.querySelectorAll('[data-vat="rate"]')].map((select) => Number(select.value));
        const next = VAT_RATES.find((rate) => !used.includes(rate)) ?? 0;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = vatRowsMarkup([{ rate: next, net: null, vat: null }]).replace(/-0"/g, `-${rows.children.length}"`);
        rows.appendChild(wrapper.firstElementChild);
        window.lucide?.createIcons?.();
      });
      rows.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-acc-vat-remove]');
        if (remove && rows.children.length > 1) remove.closest('[data-acc-vat-row]').remove();
        else if (remove) rows.querySelectorAll('input').forEach((input) => { input.value = ''; });
      });
      root.querySelector('[data-acc-vat-fill]')?.addEventListener('click', () => {
        let net = 0; let vat = 0; let any = false;
        for (const row of rows.querySelectorAll('[data-acc-vat-row]')) {
          const n = parseAmount(row.querySelector('[data-vat="net"]').value);
          const v = parseAmount(row.querySelector('[data-vat="vat"]').value);
          if (Number.isNaN(n) || Number.isNaN(v)) { fail('Enter the VAT amounts as numbers.', row.querySelector(Number.isNaN(n) ? '[data-vat="net"]' : '[data-vat="vat"]')); return; }
          if (n !== null) { net += n; any = true; }
          if (v !== null) { vat += v; any = true; }
        }
        if (!any) { fail('Add the net and VAT amounts for each rate first.', rows.querySelector('[data-vat="net"]')); return; }
        fail('');
        const round = (value) => String(Math.round(value * 100) / 100);
        form.elements.net_amount.value = round(net);
        form.elements.vat_amount.value = round(vat);
        form.elements.total_amount.value = round(net + vat);
      });
    }

    const save = async () => {
      const values = collect(form);
      if (values.error) { fail(values.error, values.field); return null; }
      fail('');
      return command(doc, 'save', { fields: values.fields });
    };
    root.querySelector('[data-acc-save]')?.addEventListener('click', async () => {
      busy(true);
      try { const next = await save(); if (next) await refresh(next, 'Saved.'); else busy(false); } catch (error) { await failed(error); }
    });
    root.querySelector('[data-acc-approve]')?.addEventListener('click', async () => {
      busy(true);
      try {
        const saved = await save();
        if (!saved) { busy(false); return; }
        doc = saved;
        let approved;
        try {
          approved = await command(doc, 'approve');
        } catch (error) {
          if (error?.code !== 'possible_duplicate') throw error;
          if (!(await confirmDialog('Approve a possible duplicate?', 'Atlas found a document from the same supplier with the same number, or the same date and total. Approve only if this is a different document.', 'Approve anyway'))) { await refresh(doc); return; }
          approved = await command(doc, 'approve', { confirm_duplicate: true });
        }
        await refresh(approved, approved.paid_by === 'staff' ? `Approved. ${approved.paid_by_label || 'The team member'} is owed ${money(approved.total_amount, approved.currency)}.` : 'Approved. It’s under Unpaid until you mark it paid.');
      } catch (error) {
        if (error?.code === 'missing_fields') { await refresh(doc).catch(() => {}); showError(root, ERROR_COPY.missing_fields); return; }
        await failed(error);
      }
    });
    root.querySelector('[data-acc-reopen]')?.addEventListener('click', async () => {
      busy(true);
      try { await refresh(await command(doc, 'reopen'), 'Reopened for editing.'); } catch (error) { await failed(error); }
    });
    root.querySelector('[data-acc-unpay]')?.addEventListener('click', async () => {
      busy(true);
      try { await refresh(await command(doc, 'unmark_paid'), 'Payment undone.'); } catch (error) { await failed(error); }
    });
    root.querySelector('[data-acc-pay]')?.addEventListener('click', () => openPay([doc], async (next) => { await refresh(next[0]); }));
    root.querySelector('[data-acc-void]')?.addEventListener('click', async () => {
      const reason = await reasonDialog('Void this document?', 'It stays in Accounting with its file and is marked void, so your records stay complete. Say why.', 'Void', true);
      if (reason === null) return;
      busy(true);
      try { await refresh(await command(doc, 'void', { reason }), 'Voided.'); } catch (error) { await failed(error); }
    });
    root.querySelector('[data-acc-discard]')?.addEventListener('click', async () => {
      const reason = await reasonDialog('Discard this upload?', 'Use this for a file uploaded by mistake. The file is deleted; a note that it was uploaded and discarded is kept.', 'Discard', false);
      if (reason === null) return;
      busy(true);
      try {
        await command(doc, 'discard', { reason });
        render();
        toast('Discarded.', 'success');
        window.AtlasModal.close(root, 'discarded');
      } catch (error) { await failed(error); }
    });
    root.querySelectorAll('[data-acc-read]').forEach((button) => button.addEventListener('click', async () => {
      busy(true);
      fail('');
      try {
        const result = await api('read', { method: 'POST', body: { id: doc.id }, timeout: LONG_TIMEOUT_MS });
        await refresh(result.document, result.outcome === 'read' ? 'Atlas filled in what it could read. Check it.' : null);
      } catch (error) { await failed(error); }
    }));
    root.querySelectorAll('.acc-doc [data-acc-open]').forEach((link) => link.addEventListener('click', () => openRoute(link.dataset.accOpen)));
  }

  function confirmDialog(heading, text, confirmLabel) {
    return new Promise((resolve) => {
      const root = modal('acc-confirm');
      root.innerHTML = `<section class="atlas-dialog" data-modal-panel role="alertdialog" aria-labelledby="acc-confirm-title"><h2 class="atlas-dialog__title" id="acc-confirm-title">${escapeHtml(heading)}</h2><p class="atlas-dialog__body">${escapeHtml(text)}</p><div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="button" class="atlas-btn atlas-btn--primary" data-acc-yes>${escapeHtml(confirmLabel)}</button></div></section>`;
      let answered = false;
      root.querySelector('[data-acc-yes]').addEventListener('click', () => { answered = true; window.AtlasModal.close(root, 'yes'); resolve(true); });
      root.addEventListener('atlas:modal-close', () => { if (!answered) resolve(false); }, { once: true });
      window.AtlasModal.open(root);
    });
  }

  function reasonDialog(heading, text, confirmLabel, required) {
    return new Promise((resolve) => {
      const root = modal('acc-reason');
      root.innerHTML = `<section class="atlas-dialog atlas-dialog--form" data-modal-panel aria-labelledby="acc-reason-title"><h2 class="atlas-dialog__title" id="acc-reason-title">${escapeHtml(heading)}</h2>
          <form class="atlas-dialog__body atlas-form">${errorSlot()}<p>${escapeHtml(text)}</p><div class="atlas-field"><label for="acc-reason-text">Reason${required ? '' : ' <span class="optional">(optional)</span>'}</label><textarea class="atlas-textarea" id="acc-reason-text" name="reason" rows="2" maxlength="500"></textarea></div>
          <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--danger">${escapeHtml(confirmLabel)}</button></div></form></section>`;
      let answered = false;
      clearInvalidOnEdit(root);
      root.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const field = event.currentTarget.elements.reason;
        const reason = field.value.trim();
        if (required && reason.length < 3) { showError(root, 'Say why, in a few words.', field); return; }
        answered = true;
        window.AtlasModal.close(root, 'yes');
        resolve(reason);
      });
      root.addEventListener('atlas:modal-close', () => { if (!answered) resolve(null); }, { once: true });
      window.AtlasModal.open(root);
    });
  }

  // Mark paid (or reimbursed) for one document, or for all of one person's:
  // one dialog, then mark_paid for each in turn. A partial failure says how
  // many went through; submitting again retries only the rest.
  function openPay(list, after) {
    const root = modal('acc-pay');
    const docs = list.filter(Boolean);
    const first = docs[0];
    const staff = first.paid_by === 'staff';
    const many = docs.length > 1;
    const who = escapeHtml(first.paid_by_label || 'the team member');
    const done = new Set();
    const total = docs.reduce((amount, doc) => amount + (Number(doc.total_amount) || 0), 0);
    const summary = many ? `${plural(docs.length, 'receipt', 'receipts')} · ${money(total, first.currency)}` : `${title(first)} · ${money(first.total_amount, first.currency)}`;
    root.innerHTML = `<section class="atlas-dialog atlas-dialog--form" data-modal-panel aria-labelledby="acc-pay-title"><h2 class="atlas-dialog__title" id="acc-pay-title">${staff ? `Reimburse ${who}` : 'Mark as paid'}</h2>
        <form class="atlas-dialog__body atlas-form">${errorSlot()}<p>${escapeHtml(summary)}. Atlas doesn’t move money; this records that ${staff ? 'you paid them back' : 'it was paid'}.</p>
          <div class="atlas-grid-2"><div class="atlas-field"><label for="acc-paid-on">${staff ? 'Reimbursed on' : 'Paid on'}</label><input class="atlas-input" type="date" id="acc-paid-on" name="paid_at" value="${escapeHtml(venueToday())}" max="${escapeHtml(venueToday())}" required></div>
          <div class="atlas-field"><label for="acc-method">How</label><select class="atlas-select" id="acc-method" name="payment_method">${Object.entries(METHODS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></div></div>
          <div class="atlas-field"><label for="acc-ref">Reference <span class="optional">(optional)</span></label><input class="atlas-input" id="acc-ref" name="payment_reference" maxlength="120" placeholder="e.g. bank transfer reference"></div>
          <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary">${staff ? (many ? `Mark ${docs.length} reimbursed` : 'Mark reimbursed') : 'Mark paid'}</button></div></form></section>`;
    clearInvalidOnEdit(root);
    root.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.elements.paid_at.value) { showError(root, 'Choose the date.', form.elements.paid_at); return; }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      showError(root, '');
      const payload = { paid_at: form.elements.paid_at.value, payment_method: form.elements.payment_method.value, payment_reference: form.elements.payment_reference.value.trim() };
      const results = [];
      let firstError = null;
      for (const doc of docs) {
        if (done.has(doc.id)) continue;
        try {
          results.push(await command(byId(doc.id) || doc, 'mark_paid', payload));
          done.add(doc.id);
        } catch (error) {
          firstError = firstError || error;
        }
      }
      render();
      if (!firstError) {
        window.AtlasModal.close(root, 'saved');
        toast(staff ? (many ? `Marked ${docs.length} reimbursed.` : 'Marked reimbursed.') : 'Marked paid.', 'success');
        if (after) await after(results);
        return;
      }
      submit.disabled = false;
      const left = docs.length - done.size;
      showError(root, many ? `${done.size} of ${docs.length} marked reimbursed; ${left} couldn’t be. ${errorText(firstError)}` : errorText(firstError));
      if (firstError?.code === 'stale_request') load();
    });
    window.AtlasModal.open(root);
  }

  // ---------- export ----------

  // [header, value, numeric]. Numeric cells follow the format's decimal mark.
  const CSV_COLUMNS = [
    ['Document date', (d) => d.issue_date], ['Due date', (d) => d.due_date], ['Type', (d) => KINDS[d.kind] || d.kind],
    ['Supplier', (d) => d.supplier_name], ['Supplier kennitala', (d) => d.supplier_kennitala], ['Number', (d) => d.document_number],
    ['Category', (d) => CATEGORIES[d.category] || ''], ['Currency', (d) => d.currency],
    ['Net', (d) => d.net_amount, true], ['VAT 24%', (d) => vatFor(d, 24), true], ['VAT 11%', (d) => vatFor(d, 11), true], ['VAT', (d) => d.vat_amount, true], ['Total', (d) => d.total_amount, true],
    ['Status', (d) => ({ approved: d.paid_by === 'staff' ? 'To reimburse' : 'Unpaid', paid: d.paid_by === 'staff' ? 'Reimbursed' : 'Paid', void: 'Void' })[d.status] || d.status],
    ['Counted', (d) => (d.status === 'void' ? 'No – void' : 'Yes')],
    ['Paid on', (d) => d.paid_at], ['Payment method', (d) => METHODS[d.payment_method] || ''], ['Payment reference', (d) => d.payment_reference],
    ['Paid by', (d) => (d.paid_by === 'staff' ? d.paid_by_label : 'The business')], ['Void reason', (d) => d.void_reason], ['Note', (d) => d.note],
    ['File', (d) => zipName(d)]
  ];
  function vatFor(doc, rate) {
    const lines = (doc.vat_lines || []).filter((line) => Number(line.rate) === rate && line.vat !== null);
    return lines.length ? lines.reduce((total, line) => total + Number(line.vat), 0) : '';
  }
  // Standard CSV (comma, decimal point) or Icelandic Excel (semicolon, decimal comma).
  const CSV_FORMATS = { standard: { separator: ',', decimal: '.' }, icelandic: { separator: ';', decimal: ',' } };
  function csvCell(value, { separator = ',', decimal = '.', numeric = false } = {}) {
    if (value === null || value === undefined || value === '') return '';
    let text;
    if (numeric && Number.isFinite(Number(value))) {
      text = String(Math.round(Number(value) * 100) / 100).replace('.', decimal);
    } else {
      text = String(value);
      // A cell starting with = + - @ would run as a formula in a spreadsheet.
      if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text)) text = `'${text}`;
    }
    return text.includes(separator) || /["\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function toCsv(list, format = CSV_FORMATS.standard) {
    const lines = [CSV_COLUMNS.map(([name]) => csvCell(name, format)).join(format.separator)];
    list.forEach((doc) => lines.push(CSV_COLUMNS.map(([, get, numeric]) => csvCell(get(doc), { ...format, numeric })).join(format.separator)));
    return `﻿${lines.join('\r\n')}\r\n`;
  }
  function zipName(doc) {
    if (!doc.has_file) return '';
    const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[doc.mime_type] || 'bin';
    const part = (value) => String(value || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${[doc.issue_date || 'undated', part(doc.supplier_name) || 'Supplier', part(doc.document_number), doc.status === 'void' ? 'VOID' : ''].filter(Boolean).join(' ')} (${doc.id.slice(0, 8)}).${ext}`;
  }

  // A minimal ZIP writer (stored, no compression: PDFs and photos are already
  // compressed). Names are UTF-8 (flag bit 11).
  const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
  function crc32(bytes) { let crc = 0xffffffff; for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
  function zip(entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, bytes } of entries) {
      const nameBytes = encoder.encode(name);
      const crc = crc32(bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
      local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true); local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
      const head = new DataView(new ArrayBuffer(46));
      head.setUint32(0, 0x02014b50, true); head.setUint16(4, 20, true); head.setUint16(6, 20, true); head.setUint16(8, 0x0800, true); head.setUint16(10, 0, true);
      head.setUint16(12, dosTime, true); head.setUint16(14, dosDate, true); head.setUint32(16, crc, true);
      head.setUint32(20, bytes.length, true); head.setUint32(24, bytes.length, true); head.setUint16(28, nameBytes.length, true);
      head.setUint32(42, offset, true);
      central.push(new Uint8Array(head.buffer), nameBytes);
      offset += 30 + nameBytes.length + bytes.length;
    }
    const centralSize = central.reduce((total, part) => total + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function runExport(kind) {
    const month = state.month || defaultMonth();
    const { from, to } = monthBounds(month);
    const status = host()?.querySelector('[data-acc-export-status]');
    const say = (text) => { if (status) status.textContent = text; };
    state.exporting = true;
    host()?.querySelectorAll('[data-acc-export]').forEach((button) => { button.disabled = true; });
    try {
      say('Preparing the export…');
      const result = await api('export', { params: { from, to }, timeout: LONG_TIMEOUT_MS });
      const list = Array.isArray(result.documents) ? result.documents : [];
      if (!list.length) { say('Nothing approved is dated in this month.'); return; }
      if (kind === 'csv' || kind === 'csv-is') {
        const icelandic = kind === 'csv-is';
        saveBlob(new Blob([toCsv(list, icelandic ? CSV_FORMATS.icelandic : CSV_FORMATS.standard)], { type: 'text/csv;charset=utf-8' }), `Accounting ${month}${icelandic ? ' (Excel)' : ''}.csv`);
        say(`Spreadsheet downloaded: ${list.length} ${list.length === 1 ? 'document' : 'documents'}.`);
        return;
      }
      const entries = [{ name: `Accounting ${month}.csv`, bytes: new TextEncoder().encode(toCsv(list)) }];
      let missing = 0;
      for (const [index, doc] of list.entries()) {
        if (!doc.file_url) { if (doc.has_file) missing += 1; continue; }
        say(`Adding files ${index + 1} of ${list.length}…`);
        try {
          const response = await fetch(doc.file_url, { cache: 'no-store' });
          if (!response.ok) throw new Error('file');
          entries.push({ name: zipName(doc), bytes: new Uint8Array(await response.arrayBuffer()) });
        } catch {
          missing += 1;
        }
      }
      saveBlob(zip(entries), `Accounting ${month}.zip`);
      say(missing ? `Downloaded, but ${missing} ${missing === 1 ? 'file' : 'files'} couldn’t be added. Try again.` : `Downloaded: the spreadsheet and ${entries.length - 1} ${entries.length === 2 ? 'file' : 'files'}.`);
    } catch (error) {
      say(errorText(error));
    } finally {
      state.exporting = false;
      const empty = Boolean(host()?.querySelector('[data-acc-export-empty]'));
      host()?.querySelectorAll('[data-acc-export]').forEach((button) => { button.disabled = empty; });
    }
  }

  // ---------- events and routing ----------

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    if (target.closest('[data-acc-retry]')) { load(); return; }
    if (target.closest('[data-acc-upload]')) { if (state.workspace) openUpload(); return; }
    const open = target.closest('[data-acc-open]');
    if (open) { openRoute(open.dataset.accOpen); return; }
    const pay = target.closest('[data-acc-pay]');
    if (pay) { const doc = byId(pay.dataset.accPay); if (doc) openPay([doc]); return; }
    const payAll = target.closest('[data-acc-pay-all]');
    if (payAll) { const group = owedGroups().get(payAll.dataset.accPayAll); if (group) openPay(group.docs); return; }
    const filter = target.closest('[data-acc-filter]');
    if (filter) { state.filter = filter.dataset.accFilter; render(); return; }
    const exportButton = target.closest('[data-acc-export]');
    if (exportButton && !state.exporting) { runExport(exportButton.dataset.accExport); }
  }

  function handleInput(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    if (target.matches('[data-acc-search]')) {
      state.query = target.value;
      const caret = target.selectionStart;
      render();
      const again = host().querySelector('[data-acc-search]');
      again?.focus();
      if (again && caret !== null) again.setSelectionRange(caret, caret);
    }
    if (target.matches('[data-acc-month]') && /^\d{4}-\d{2}$/.test(target.value)) { state.month = target.value; render(); host().querySelector('[data-acc-month]')?.focus(); }
    if (target.matches('[data-acc-filter-select]')) { state.filter = target.value; render(); host().querySelector('[data-acc-filter-select]')?.focus(); }
  }

  // #accounting/document/<id> opens the sheet over the tab it came from (All
  // for a link opened cold); a tab address closes an open sheet (phone Back).
  function onShow(params = {}) {
    if (params.document) {
      state.openId = String(params.document);
      if (!state.workspace) state.tab = 'all';
    } else {
      const tab = params.section || 'review';
      state.tab = TABS.some(([key]) => key === tab) ? tab : 'review';
      state.routePushed = false;
      if (window.AtlasModal?.isOpen('acc-document')) window.AtlasModal.close('acc-document', 'route');
    }
    render();
    if (!isAdmin()) return;
    if (!state.workspace && !state.loading) load();
    else if (params.document && state.workspace) openDocument(String(params.document));
  }

  function ensureStructure() {
    if (!host()) {
      const view = document.createElement('div');
      view.id = 'accounting-view';
      view.style.display = 'none';
      const parent = document.querySelector('.atlas-content.standard-view main') || document.querySelector('.atlas-content main');
      parent?.appendChild(view);
    }
    if (!state.registered && window.AtlasShell) {
      state.registered = true;
      window.AtlasShell.registerView('accounting', { root: host, title: 'Accounting', onShow });
      window.AtlasShell.actions?.register?.({ id: 'accounting.upload', label: 'Upload an invoice or receipt', icon: 'receipt-text', keywords: ['invoice', 'receipt', 'bill', 'reikningur', 'kvittun', 'accounting', 'reimburse'], roles: ADMIN, contexts: ['accounting', 'home'], run: async () => { window.AtlasShell.navigate('#accounting'); if (!state.workspace) await load(); openUpload(); } });
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStructure();
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    window.AtlasShell?.on?.('profile:ready', () => { if (visible()) { render(); if (isAdmin() && !state.workspace && !state.loading) load(); } });
  }

  window.AtlasAccounting = {
    open: () => window.AtlasShell?.navigate?.('#accounting'),
    refresh: () => load(),
    snapshot: () => state.workspace,
    // Exposed for tests: the export helpers are pure.
    _test: { parseAmount, toCsv, zipName, crc32 }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
