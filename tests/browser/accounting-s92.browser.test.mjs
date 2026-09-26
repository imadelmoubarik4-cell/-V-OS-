// S92 Accounting (#accounting): the administrator-only page for supplier
// invoices, receipts and staff reimbursements, in a real browser against a
// stateful mock of the atlas-accounting gateway (handler.mjs contract; the
// document shape follows atlas_private.accounting_document_json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, requestsTo, SUPABASE, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

const MANAGER = { id: '7d3c1f10-0000-4000-8000-000000000003', email: 'mia.manager@example.test', display_name: 'Mía Stefánsdóttir', role: 'manager', active: true };
const PROFILES = [USERS.admin, USERS.bartender, MANAGER];
const TODAY = '2026-09-24';
const FN = 'atlas-accounting';

const IDS = {
  review: 'a0000000-0000-4000-8000-000000000001',
  unpaid: 'a0000000-0000-4000-8000-000000000002',
  owedSara: 'a0000000-0000-4000-8000-000000000003',
  owedSara2: 'a0000000-0000-4000-8000-000000000004',
  owedMia: 'a0000000-0000-4000-8000-000000000005',
  paid: 'a0000000-0000-4000-8000-000000000006',
  formula: 'a0000000-0000-4000-8000-000000000007',
  globus: 'b0000000-0000-4000-8000-000000000001',
  olgerdin: 'b0000000-0000-4000-8000-000000000002'
};

const SUPPLIERS = [{ id: IDS.globus, name: 'Globus hf.' }, { id: IDS.olgerdin, name: 'Ölgerðin' }];

function doc(overrides = {}) {
  return {
    id: IDS.review, version: 1, status: 'to_review', kind: 'invoice', category: null,
    supplier_id: null, supplier_name: null, supplier_kennitala: null, supplier_known: false,
    document_number: null, issue_date: null, due_date: null, currency: 'ISK',
    net_amount: null, vat_amount: null, total_amount: null, vat_lines: [], purchase_order_id: null, note: null,
    paid_by: 'company', paid_by_profile_id: null, paid_by_label: null,
    paid_at: null, payment_method: null, payment_reference: null, void_reason: null,
    has_file: true, mime_type: 'application/pdf', byte_size: 2048, file_name: 'reikningur.pdf',
    extraction_status: null, extraction: null, exported: false,
    created_by_label: 'Imad El Moubarik', created_at: '2026-09-23T10:00:00.000Z', updated_at: '2026-09-23T10:00:00.000Z',
    approved_at: null, approved_by_label: null, order: null,
    checks: { totals_mismatch: false, vat_lines_mismatch: false, order_difference: null, overdue: false, possible_duplicates: [] },
    history: [{ action: 'uploaded', actor_label: 'Imad El Moubarik', details: {}, created_at: '2026-09-23T10:00:00.000Z' }],
    ...overrides
  };
}

function seedDocuments() {
  const approved = { status: 'approved', approved_at: '2026-09-01T10:00:00.000Z', approved_by_label: 'Imad El Moubarik' };
  return [
    doc({ id: IDS.review, file_name: 'globus-sept.pdf' }),
    doc({ id: IDS.unpaid, ...approved, supplier_id: IDS.olgerdin, supplier_name: 'Ölgerðin', supplier_known: true, document_number: 'INV-7781', issue_date: '2026-08-20', due_date: '2026-10-05', net_amount: 40000, vat_amount: 9600, total_amount: 49600, vat_lines: [{ rate: 24, net: 40000, vat: 9600 }] }),
    doc({ id: IDS.owedSara, ...approved, kind: 'receipt', supplier_name: 'Bónus', issue_date: '2026-08-11', net_amount: 3604, vat_amount: 396, total_amount: 4000, vat_lines: [{ rate: 11, net: 3604, vat: 396 }], paid_by: 'staff', paid_by_profile_id: USERS.bartender.id, paid_by_label: USERS.bartender.display_name, mime_type: 'image/jpeg', file_name: 'kvittun.jpg' }),
    doc({ id: IDS.owedSara2, ...approved, kind: 'receipt', supplier_name: 'Krónan', issue_date: '2026-08-12', total_amount: 1500, net_amount: 1210, vat_amount: 290, vat_lines: [{ rate: 24, net: 1210, vat: 290 }], paid_by: 'staff', paid_by_profile_id: USERS.bartender.id, paid_by_label: USERS.bartender.display_name }),
    doc({ id: IDS.owedMia, ...approved, kind: 'receipt', supplier_name: 'Húsasmiðjan', issue_date: '2026-09-02', total_amount: 7000, net_amount: 5645.16, vat_amount: 1354.84, vat_lines: [{ rate: 24, net: 5645.16, vat: 1354.84 }], paid_by: 'staff', paid_by_profile_id: MANAGER.id, paid_by_label: MANAGER.display_name }),
    doc({ id: IDS.paid, ...approved, status: 'paid', supplier_name: 'Vífilfell', document_number: '5521', issue_date: '2026-08-03', total_amount: 12400, net_amount: 10000, vat_amount: 2400, vat_lines: [{ rate: 24, net: 10000, vat: 2400 }], paid_at: '2026-08-10', payment_method: 'bank_transfer', payment_reference: 'MB-1' }),
    doc({ id: IDS.formula, ...approved, supplier_name: '=HYPERLINK("http://evil.example","x")', document_number: '+99', issue_date: '2026-08-28', total_amount: 1000, net_amount: 806.45, vat_amount: 193.55, vat_lines: [{ rate: 24, net: 806.45, vat: 193.55 }] })
  ];
}

// Lists (snapshot, export) carry no history and no Atlas draft (extraction).
const withoutHistory = ({ history, ...rest }) => ({ ...rest, extraction: null });
const fail = (status, code) => ({ __status: status, body: { error_code: code, message: `server text for ${code}` } });

/**
 * A stateful atlas-accounting mock: an in-memory document list; GET
 * snapshot|document|file|export, POST upload (multipart)|read|command, with the
 * version guard (stale_request), missing_fields and an optional
 * possible_duplicate on approve.
 */
function accountingBackend({ aiEnabled = true, documents = seedDocuments(), duplicateOnApprove = false, failPay = [], holdSnapshot = false } = {}) {
  const backend = { documents, calls: [], uploads: [], nextId: 1, failPay: new Set(failPay) };
  // holdSnapshot: the first snapshot waits until the test calls backend.release().
  let release = () => {};
  const gate = holdSnapshot ? new Promise((resolve) => { release = resolve; }) : null;
  backend.release = () => release();
  const find = (id) => backend.documents.find((entry) => entry.id === id);
  const event = (target, action, details = {}) => { target.history.unshift({ action, actor_label: USERS.admin.display_name, details, created_at: '2026-09-24T14:00:00.000Z' }); };
  const bump = (target) => { target.version += 1; target.updated_at = '2026-09-24T14:00:00.000Z'; };
  const out = (target) => ({ ...target, history: [...target.history] });
  backend.handler = (entry) => {
    if (!entry.gated) backend.calls.push(entry);
    const params = new URLSearchParams(entry.search);
    const action = entry.action;
    if (entry.method === 'GET') {
      if (action === 'snapshot') {
        if (gate && !entry.gated) return gate.then(() => backend.handler({ ...entry, gated: true }));
        return { workspace: { today: TODAY, documents: backend.documents.map(withoutHistory), suppliers: SUPPLIERS, orders: [], team: [{ id: USERS.admin.id, label: USERS.admin.display_name, active: true }, { id: USERS.bartender.id, label: USERS.bartender.display_name, active: true }, { id: MANAGER.id, label: MANAGER.display_name, active: true }], ai_enabled: aiEnabled, reads_today: 0 } };
      }
      if (action === 'document') { const target = find(params.get('id')); return target ? { document: out(target) } : fail(404, 'not_found'); }
      if (action === 'file') { const target = find(params.get('id')); return target?.has_file ? { url: `${SUPABASE}/storage/v1/object/sign/atlas-accounting-documents/documents/${target.id}.pdf?token=t`, mime_type: target.mime_type, expires_in: 300 } : fail(404, 'not_found'); }
      if (action === 'export') {
        const from = params.get('from'); const to = params.get('to');
        const list = backend.documents.filter((d) => ['approved', 'paid', 'void'].includes(d.status) && d.issue_date >= from && d.issue_date <= to)
          .sort((a, b) => a.issue_date.localeCompare(b.issue_date)).map((d) => ({ ...withoutHistory(d), file_url: null }));
        return { from, to, documents: list, expires_in: 900 };
      }
      return fail(404, 'not_found');
    }
    if (action === 'upload') {
      const body = String(entry.body || '');
      const part = (name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] ?? null;
      const fileName = body.match(/name="file"; filename="([^"]*)"/)?.[1] ?? null;
      const upload = { request_id: part('request_id'), fields: JSON.parse(part('fields') || '{}'), file_name: fileName, has_pdf: body.includes('%PDF-') };
      backend.uploads.push(upload);
      if (!upload.request_id || !upload.has_pdf) return fail(400, 'invalid_request');
      const id = `c0000000-0000-4000-8000-${String(backend.nextId++).padStart(12, '0')}`;
      const fields = upload.fields;
      const created = doc({ id, file_name: fileName, paid_by: fields.paid_by || 'company', paid_by_profile_id: fields.paid_by_profile_id || null, paid_by_label: fields.paid_by === 'staff' ? PROFILES.find((p) => p.id === fields.paid_by_profile_id)?.display_name : null, created_at: '2026-09-24T14:00:00.000Z' });
      backend.documents.unshift(created);
      return { document: out(created), readable: true };
    }
    if (action === 'read') {
      const target = find(entry.body?.id);
      if (!target) return fail(404, 'not_found');
      const read = { supplier_name: 'Globus hf.', document_number: 'G-1001', issue_date: '2026-09-20', net_amount: 10000, vat_amount: 2400, total_amount: 12400, currency: 'ISK', line_items: [{ description: 'Campari 1 L', quantity: 4, amount: 12400 }] };
      target.extraction_status = 'read';
      const prefill = Object.fromEntries(['supplier_name', 'document_number', 'issue_date', 'net_amount', 'vat_amount', 'total_amount'].map((key) => [key, read[key]]));
      target.extraction = { version: 1, fields: read, prefill };
      for (const key of ['supplier_name', 'document_number', 'issue_date', 'net_amount', 'vat_amount', 'total_amount']) if (target[key] === null) target[key] = read[key];
      bump(target); event(target, 'read');
      return { document: out(target), outcome: 'read' };
    }
    if (action === 'command') {
      const { id, version, command, payload = {} } = entry.body || {};
      const target = find(id);
      if (!target) return fail(404, 'not_found');
      if (target.version !== version) return fail(409, 'stale_request');
      if (command === 'save') {
        if (target.status !== 'to_review') return fail(409, 'conflict');
        const f = payload.fields || {};
        const before = { ...target };
        Object.assign(target, {
          kind: f.kind, category: f.category || null, supplier_id: f.supplier_id || null, supplier_known: Boolean(f.supplier_id),
          supplier_name: f.supplier_id ? SUPPLIERS.find((s) => s.id === f.supplier_id)?.name : (f.supplier_name || null),
          supplier_kennitala: f.supplier_kennitala || null, document_number: f.document_number || null,
          issue_date: f.issue_date || null, due_date: f.due_date || null, currency: f.currency,
          net_amount: f.net_amount, vat_amount: f.vat_amount, total_amount: f.total_amount, vat_lines: f.vat_lines,
          purchase_order_id: f.purchase_order_id || null, note: f.note || null,
          paid_by: f.paid_by, paid_by_profile_id: f.paid_by_profile_id || null,
          paid_by_label: f.paid_by === 'staff' ? PROFILES.find((p) => p.id === f.paid_by_profile_id)?.display_name : null
        });
        const changes = Object.fromEntries(Object.keys(f).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(target[key] ?? null)).map((key) => [key, [before[key] ?? null, target[key] ?? null]]));
        bump(target); event(target, 'edited', { changes });
        return { document: out(target) };
      }
      if (command === 'approve') {
        if (!target.supplier_name || !target.issue_date || target.total_amount === null) return fail(422, 'missing_fields');
        if (duplicateOnApprove && payload.confirm_duplicate !== true) return fail(409, 'possible_duplicate');
        Object.assign(target, { status: 'approved', approved_at: '2026-09-24T14:00:00.000Z', approved_by_label: USERS.admin.display_name });
        bump(target); event(target, 'approved');
        return { document: out(target) };
      }
      if (command === 'mark_paid') {
        if (target.status !== 'approved') return fail(409, 'conflict');
        if (backend.failPay.has(id)) { backend.failPay.delete(id); return fail(503, 'unavailable'); }
        Object.assign(target, { status: 'paid', paid_at: payload.paid_at, payment_method: payload.payment_method, payment_reference: payload.payment_reference || null });
        bump(target); event(target, 'paid');
        return { document: out(target) };
      }
      if (command === 'void') {
        if (!['approved', 'paid'].includes(target.status) || String(payload.reason || '').trim().length < 3) return fail(400, 'invalid_request');
        Object.assign(target, { status: 'void', void_reason: payload.reason });
        bump(target); event(target, 'voided', { reason: payload.reason });
        return { document: out(target) };
      }
      if (command === 'discard') {
        if (target.status !== 'to_review') return fail(409, 'append_only');
        Object.assign(target, { status: 'discarded', has_file: false });
        bump(target); event(target, 'discarded', { reason: payload.reason });
        return { document: out(target) };
      }
      return fail(400, 'invalid_request');
    }
    return fail(404, 'not_found');
  };
  backend.commands = (name) => backend.calls.filter((call) => call.action === 'command' && (!name || call.body?.command === name));
  return backend;
}

async function launch({ user = USERS.admin, backend = accountingBackend(), viewport, hash } = {}) {
  const phone = viewport && viewport.width < 768;
  const app = await launchAtlas({
    user, viewport,
    contextOptions: phone ? { hasTouch: true, isMobile: true } : {},
    fixtures: { profiles: PROFILES, functions: { ...emptyFunctions(), 'atlas-ai': {}, [FN]: backend.handler } }
  });
  if (hash) await navigateTo(app.page, hash);
  return { ...app, backend };
}

async function openAccounting(page, hash = '#accounting') {
  await navigateTo(page, hash);
  await page.waitForSelector('#accounting-view .acc-tabs');
}

async function openDoc(page, id) {
  await page.click(`#accounting-view .atlas-row__link[data-acc-open="${id}"]`);
  await page.waitForSelector('#acc-document.is-open .acc-doc__form');
  await settle(page);
}

// Chromium logs every non-2xx response as a console error; a test that
// provokes an expected gateway refusal names its status here.
const noErrors = (record, expectedStatuses = []) => {
  assert.deepEqual(record.pageErrors, [], 'no page errors');
  const expected = expectedStatuses.map((status) => `Failed to load resource: the server responded with a status of ${status} `);
  assert.deepEqual(record.consoleErrors.filter((text) => !expected.some((prefix) => text.startsWith(prefix))), [], 'no console errors');
};
const noHorizontalScroll = (page, width) => page.evaluate((limit) => document.documentElement.scrollWidth <= limit, width);

/** Parses RFC 4180 CSV (quoted cells, doubled quotes, CRLF). */
function parseCsv(text, separator = ',') {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) { row.push(cell); cell = ''; } else if (ch === '\r') { /* CRLF */ } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------

test('Accounting is in Business for administrators only; a manager gets the lock', { skip }, async () => {
  const admin = await launch();
  try {
    const nav = await admin.page.evaluate(() => {
      const link = document.querySelector('.atlas-sidebar .nav-item[data-nav-id="accounting"]');
      let label = link?.previousElementSibling;
      while (label && !label.classList.contains('nav-label')) label = label.previousElementSibling;
      return { visible: Boolean(link && link.getClientRects().length), group: label?.textContent.trim() };
    });
    assert.deepEqual(nav, { visible: true, group: 'Business' });
    await admin.page.click('.atlas-sidebar .nav-item[data-nav-id="accounting"]');
    await admin.page.waitForFunction(() => document.body.dataset.atlasView === 'accounting');
    await admin.page.waitForSelector('#accounting-view .acc-tabs');
    assert.match(await admin.page.textContent('#accounting-view .atlas-page'), /1 to review · 2 unpaid · 3 owed to team/);
    noErrors(admin.record);
  } finally { await admin.close(); }

  const phone = await launch({ viewport: { width: 390, height: 844 } });
  try {
    await phone.page.click('#atlas-more-btn');
    await phone.page.waitForSelector('#atlas-more .atlas-more', { state: 'visible' });
    const rows = await phone.page.$$eval('#atlas-more .atlas-more__row[data-nav-id]', (list) => list.map((row) => row.dataset.navId));
    assert.ok(rows.includes('accounting'), `More sheet rows: ${rows}`);
    await phone.page.click('#atlas-more .atlas-more__row[data-nav-id="accounting"]');
    await phone.page.waitForFunction(() => document.body.dataset.atlasView === 'accounting');
    await phone.page.waitForSelector('#accounting-view .acc-tabs');
    noErrors(phone.record);
  } finally { await phone.close(); }

  for (const user of [MANAGER, USERS.bartender]) {
    const { page, record, close } = await launch({ user });
    try {
      assert.equal(await page.evaluate(() => {
        const link = document.querySelector('.atlas-sidebar .nav-item[data-nav-id="accounting"]');
        return Boolean(link && link.getClientRects().length);
      }), false, `${user.role}: no Accounting in the sidebar`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('#atlas-more-btn');
      await page.waitForSelector('#atlas-more .atlas-more', { state: 'visible' });
      const rows = await page.$$eval('#atlas-more .atlas-more__row[data-nav-id]', (list) => list.map((row) => row.dataset.navId));
      assert.equal(rows.includes('accounting'), false, `${user.role}: no Accounting in More`);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 900 });
      if (user === MANAGER) {
        await navigateTo(page, '#accounting');
        await page.waitForSelector('#accounting-view .atlas-empty');
        assert.match(await page.textContent('#accounting-view'), /Accounting is for administrators/);
      }
      assert.equal(requestsTo(record, FN).length, 0, `${user.role}: never calls the accounting gateway`);
      noErrors(record);
    } finally { await close(); }
  }
});

test('review: edit supplier, date and VAT lines, fill totals, save, then approve through a possible duplicate', { skip }, async () => {
  const backend = accountingBackend({ duplicateOnApprove: true });
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page);
    assert.match(await page.textContent('#accounting-view .acc-body'), /globus-sept\.pdf/);
    await openDoc(page, IDS.review);
    const sheet = '#acc-document';
    // File preview area (a signed link for a PDF), the read banner and the fields.
    await page.waitForSelector(`${sheet} [data-acc-file] a[href*="/storage/v1/object/sign/"]`);
    assert.match(await page.textContent(`${sheet} [data-acc-file]`), /Open PDF/);
    assert.match(await page.textContent(`${sheet} .acc-doc__form .atlas-alert`), /Let Atlas fill it in/);
    // It opens at the top with focus on the heading, the URL names the document.
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'acc-doc-title');
    assert.equal(await page.evaluate(() => location.hash), `#accounting/document/${IDS.review}`);
    // P3: plain "Net (án VSK)" label, currency as a select.
    assert.equal(await page.textContent(`${sheet} label[for="acc-net"]`), 'Net (án VSK)');
    assert.deepEqual(await page.$$eval(`${sheet} #acc-currency option`, (options) => options.map((option) => option.value)), ['ISK', 'EUR', 'USD', 'GBP', 'DKK', 'NOK', 'SEK']);
    for (const field of ['#acc-supplier', '#acc-supplier-name', '#acc-date', '#acc-net', '#acc-vat-total', '#acc-total']) assert.ok(await page.$(`${sheet} ${field}`), field);
    // With the file beside the form, amounts still have room for "16418.42".
    const amountWidth = await page.$eval(`${sheet} #acc-total`, (node) => node.getBoundingClientRect().width);
    assert.ok(amountWidth >= 110, `amount inputs are wide enough (${amountWidth})`);

    await page.selectOption(`${sheet} #acc-supplier`, IDS.globus);
    assert.equal(await page.isHidden(`${sheet} .acc-supplier-name`), true, 'a known supplier hides the name field');
    await page.fill(`${sheet} #acc-number`, 'G-1001');
    await page.fill(`${sheet} #acc-date`, '2026-09-20');
    await page.fill(`${sheet} #acc-vat-net-0`, '12.345,50');
    await page.fill(`${sheet} #acc-vat-vat-0`, '2.962,92');
    await page.click(`${sheet} [data-acc-vat-add]`);
    await page.selectOption(`${sheet} #acc-vat-rate-1`, '11');
    await page.fill(`${sheet} #acc-vat-net-1`, '1000');
    await page.fill(`${sheet} #acc-vat-vat-1`, '110');
    await page.click(`${sheet} [data-acc-vat-fill]`);
    assert.deepEqual(await page.evaluate(() => ['acc-net', 'acc-vat-total', 'acc-total'].map((id) => document.getElementById(id).value)), ['13345.5', '3072.92', '16418.42']);

    // A bad amount: a danger alert at the top of the sheet, the field marked
    // until it is edited; nothing is sent.
    await page.fill(`${sheet} #acc-total`, 'abc');
    await page.click(`${sheet} [data-acc-save]`);
    await page.waitForSelector(`${sheet} .acc-error:not([hidden])`);
    const problem = await page.evaluate(() => {
      const box = document.querySelector('#acc-document .acc-error');
      const body = document.querySelector('#acc-document .atlas-sheet__body');
      const a = box.getBoundingClientRect(); const b = body.getBoundingClientRect();
      return { role: box.getAttribute('role'), danger: box.classList.contains('atlas-alert--danger'), first: body.firstElementChild === box, inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, text: box.querySelector('[data-acc-error-text]').textContent, invalid: document.getElementById('acc-total').getAttribute('aria-invalid') };
    });
    assert.deepEqual(problem, { role: 'alert', danger: true, first: true, inView: true, text: 'Enter amounts as numbers, like 12.345 or 12345,50.', invalid: 'true' });
    assert.equal(backend.commands('save').length, 0);
    await page.fill(`${sheet} #acc-total`, '16418.42');
    assert.equal(await page.getAttribute(`${sheet} #acc-total`, 'aria-invalid'), null, 'editing clears the mark');

    await page.click(`${sheet} [data-acc-save]`);
    await until(() => backend.commands('save').length, { message: 'save command' });
    await page.waitForFunction(() => document.querySelector('#acc-document [data-acc-save]') && !document.querySelector('#acc-document [data-acc-save]').disabled);
    const save = backend.commands('save')[0].body;
    assert.equal(save.id, IDS.review);
    assert.equal(save.version, 1, 'the version guard is sent');
    const fields = save.payload.fields;
    assert.equal(fields.supplier_id, IDS.globus);
    assert.equal(fields.supplier_name, '');
    assert.equal(fields.document_number, 'G-1001');
    assert.equal(fields.issue_date, '2026-09-20');
    assert.deepEqual(fields.vat_lines, [{ rate: 24, net: 12345.5, vat: 2962.92 }, { rate: 11, net: 1000, vat: 110 }]);
    assert.deepEqual([fields.net_amount, fields.vat_amount, fields.total_amount], [13345.5, 3072.92, 16418.42]);
    assert.equal(fields.currency, 'ISK');
    assert.equal(fields.paid_by, 'company');

    // Typed Icelandic amounts in the totals parse too.
    await page.fill(`${sheet} #acc-total`, '16.418,42');
    await page.click(`${sheet} [data-acc-approve]`);
    await page.waitForSelector('#acc-confirm.is-open [data-acc-yes]');
    assert.match(await page.textContent('#acc-confirm'), /Approve a possible duplicate\?/);
    const beforeConfirm = backend.commands();
    assert.deepEqual(beforeConfirm.slice(-2).map((call) => [call.body.command, call.body.version, call.body.payload?.confirm_duplicate]), [['save', 2, undefined], ['approve', 3, undefined]], 'Approve saves first, then approves');
    assert.equal(beforeConfirm.at(-2).body.payload.fields.total_amount, 16418.42);
    await page.click('#acc-confirm [data-acc-yes]');
    await until(() => backend.commands('approve').length === 2, { message: 'approve with confirm_duplicate' });
    assert.deepEqual(backend.commands('approve')[1].body.payload, { confirm_duplicate: true });
    await page.waitForSelector('#acc-document [data-acc-void]');
    assert.match(await page.textContent('#acc-document .atlas-sheet__desc'), /Unpaid/);
    // Approved: a read-only list of facts, not disabled inputs.
    assert.equal(await page.$$eval('#acc-document .acc-doc input, #acc-document .acc-doc select, #acc-document .acc-doc textarea', (nodes) => nodes.length), 0);
    const facts = await page.$$eval('#acc-document [data-acc-facts] > div', (rows) => Object.fromEntries(rows.map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
    assert.equal(facts.Supplier, 'Globus hf.');
    assert.equal(facts.Total, '16.418 kr');
    assert.equal(facts['Supplier kennitala'], '—');
    assert.equal(facts['VAT lines'], '24%: 2.963 kr on 12.346 kr · 11%: 110 kr on 1.000 kr');
    // History: the edit lists what changed, amounts before → after.
    await page.click('#acc-document .acc-details:last-of-type > summary');
    const history = await page.textContent('#acc-document .acc-details:last-of-type');
    assert.match(history, /Edited.*Supplier: — → Globus hf\./s);
    assert.match(history, /Total: — → 16\.418 kr/);
    await settle(page);
    assert.match(await page.textContent('#accounting-view .acc-body'), /Nothing to review/);
    noErrors(record, [409]);
  } finally { await close(); }
});

test('upload: a PDF paid by a team member needs a person, posts multipart, reads it and opens the sheet', { skip }, async () => {
  const { page, record, backend, close } = await launch();
  try {
    await openAccounting(page);
    await page.click('#accounting-view .atlas-page-head [data-acc-upload], #accounting-view [data-acc-upload]');
    await page.waitForSelector('#acc-upload.is-open [data-acc-upload-form]');
    assert.equal(await page.isDisabled('#acc-upload [data-acc-start]'), true, 'nothing to upload yet');
    await page.setInputFiles('#acc-upload [data-acc-files]', { name: 'reikningur-okt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n') });
    await page.waitForSelector('#acc-upload [data-acc-queue] li');
    assert.match(await page.textContent('#acc-upload [data-acc-queue]'), /reikningur-okt\.pdf/);
    await page.check('#acc-upload input[name="paid_by"][value="staff"]');
    assert.equal(await page.isVisible('#acc-upload .acc-payer__who'), true);
    await page.click('#acc-upload [data-acc-start]');
    await page.waitForSelector('#acc-upload [data-acc-error]:not([hidden])');
    assert.equal(await page.textContent('#acc-upload [data-acc-error-text]'), 'Choose the team member who paid.');
    assert.equal(await page.getAttribute('#acc-upload [data-acc-error]', 'class'), 'atlas-alert atlas-alert--danger acc-error');
    assert.equal(await page.getAttribute('#acc-upload #acc-up-payer', 'aria-invalid'), 'true');
    assert.equal(backend.uploads.length, 0, 'nothing is sent without the person');
    await page.selectOption('#acc-upload #acc-up-payer', USERS.bartender.id);
    assert.equal(await page.getAttribute('#acc-upload #acc-up-payer', 'aria-invalid'), null);
    await page.click('#acc-upload [data-acc-start]');
    await page.waitForSelector('#acc-document.is-open [data-acc-form]');
    await settle(page);
    assert.equal(backend.uploads.length, 1);
    const upload = backend.uploads[0];
    assert.match(upload.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(upload.fields, { paid_by: 'staff', paid_by_profile_id: USERS.bartender.id });
    assert.equal(upload.file_name, 'reikningur-okt.pdf');
    assert.equal(upload.has_pdf, true);
    const uploadCall = requestsTo(record, FN, 'upload')[0];
    assert.equal(uploadCall.method, 'POST');
    const reads = requestsTo(record, FN, 'read');
    assert.equal(reads.length, 1, 'Atlas reads it when Atlas AI is on');
    assert.equal(reads[0].body.id, backend.documents[0].id);
    assert.equal(await page.isHidden('#acc-upload'), true, 'a single upload closes the upload sheet');
    assert.match(await page.textContent('#acc-document .acc-doc__form .atlas-alert'), /Atlas read this document/);
    assert.equal(await page.inputValue('#acc-document #acc-supplier-name'), 'Globus hf.');
    // Fields Atlas filled say so.
    const filled = await page.$$eval('#acc-document .acc-filled', (nodes) => nodes.map((node) => node.closest('.atlas-field').querySelector('label').getAttribute('for')));
    assert.deepEqual(filled, ['acc-supplier-name', 'acc-number', 'acc-date', 'acc-net', 'acc-vat-total', 'acc-total']);
    assert.equal(await page.textContent('#acc-document .acc-filled'), 'Filled by Atlas');
    assert.equal(await page.isChecked('#acc-document input[name="paid_by"][value="staff"]'), true);
    noErrors(record);
  } finally { await close(); }
});

test('upload with Atlas AI off does not call read', { skip }, async () => {
  const { page, record, close } = await launch({ backend: accountingBackend({ aiEnabled: false }) });
  try {
    await openAccounting(page);
    await page.click('#accounting-view [data-acc-upload]');
    await page.waitForSelector('#acc-upload.is-open');
    assert.match(await page.textContent('#acc-upload .atlas-sheet__desc'), /Atlas reading is off/);
    await page.setInputFiles('#acc-upload [data-acc-files]', { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await page.click('#acc-upload [data-acc-start]');
    await page.waitForSelector('#acc-document.is-open [data-acc-form]');
    await settle(page);
    assert.equal(requestsTo(record, FN, 'upload').length, 1);
    assert.equal(requestsTo(record, FN, 'read').length, 0);
    noErrors(record);
  } finally { await close(); }
});

test('unpaid: Mark paid records date, method and reference; Owed to team groups by person', { skip }, async () => {
  const { page, record, backend, close } = await launch();
  try {
    await openAccounting(page, '#accounting/unpaid');
    const body = await page.textContent('#accounting-view .acc-body');
    assert.match(body, /Ölgerðin/);
    assert.doesNotMatch(body, /Bónus/, 'staff-paid receipts are not in Unpaid');
    // Krónur as elsewhere in Atlas, whole in the summary.
    assert.equal(await page.textContent('#accounting-view .atlas-stat__value'), '50.600 kr');
    assert.match(await page.textContent(`#accounting-view [data-acc-row="${IDS.unpaid}"] .atlas-row__meta`), /49\.600 kr/);
    assert.equal(await page.getAttribute(`#accounting-view [data-acc-pay="${IDS.unpaid}"]`, 'aria-label'), 'Mark paid: Ölgerðin');
    await page.click(`#accounting-view [data-acc-pay="${IDS.unpaid}"]`);
    await page.waitForSelector('#acc-pay.is-open form');
    assert.equal(await page.inputValue('#acc-pay #acc-paid-on'), TODAY);
    await page.fill('#acc-pay #acc-paid-on', '2026-09-22');
    await page.selectOption('#acc-pay #acc-method', 'card');
    await page.fill('#acc-pay #acc-ref', 'Kort 4411');
    await page.click('#acc-pay [type="submit"]');
    await until(() => backend.commands('mark_paid').length, { message: 'mark_paid' });
    const pay = backend.commands('mark_paid')[0].body;
    assert.deepEqual([pay.id, pay.version, pay.payload], [IDS.unpaid, 1, { paid_at: '2026-09-22', payment_method: 'card', payment_reference: 'Kort 4411' }]);
    await page.waitForFunction(() => document.getElementById('acc-pay').hidden);
    await settle(page);
    assert.doesNotMatch(await page.textContent('#accounting-view .acc-body'), /Ölgerðin/, 'a paid invoice leaves Unpaid');
    assert.match(await page.textContent('#accounting-view .acc-body'), /1 document/);

    await navigateTo(page, '#accounting/owed');
    const groups = await page.$$eval('#accounting-view .atlas-section', (sections) => sections.map((section) => ({
      who: section.querySelector('.atlas-section__title').textContent.trim(),
      owed: section.querySelector('.atlas-section__meta').textContent.trim(),
      rows: section.querySelectorAll('[data-acc-row]').length,
      buttons: [...section.querySelectorAll('[data-acc-pay]')].map((button) => button.textContent.trim())
    })));
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((group) => [group.who, group.rows, group.buttons]), [
      [USERS.bartender.display_name, 2, ['Mark reimbursed', 'Mark reimbursed']],
      [MANAGER.display_name, 1, ['Mark reimbursed']]
    ]);
    assert.match(groups[0].owed, /^Owed .*5[.,]500/);
    await page.click(`#accounting-view [data-acc-pay="${IDS.owedMia}"]`);
    await page.waitForSelector('#acc-pay.is-open form');
    assert.match(await page.textContent('#acc-pay .atlas-dialog__title'), new RegExp(`Reimburse ${MANAGER.display_name}`));
    await page.click('#acc-pay [type="submit"]');
    await until(() => backend.commands('mark_paid').length === 2, { message: 'reimburse' });
    await settle(page);
    assert.equal(await page.$$eval('#accounting-view .atlas-section', (sections) => sections.length), 1);
    noErrors(record);
  } finally { await close(); }
});

test('Mark paid from the document sheet after using the list dialog shows the dialog on top', { skip }, async () => {
  const backend = accountingBackend();
  backend.documents.push(doc({ id: 'a0000000-0000-4000-8000-000000000009', status: 'approved', supplier_name: 'Mjólkursamsalan', issue_date: '2026-09-10', total_amount: 2500 }));
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page, '#accounting/unpaid');
    // The list's Mark paid dialog is used (and cancelled) first...
    await page.click(`#accounting-view [data-acc-pay="${IDS.unpaid}"]`);
    await page.waitForSelector('#acc-pay.is-open form');
    await page.click('#acc-pay [data-modal-close]');
    await page.waitForFunction(() => document.getElementById('acc-pay').hidden);
    // ...then Mark paid from inside an open document sheet.
    await openDoc(page, IDS.unpaid);
    await page.click('#acc-document .atlas-sheet__foot [data-acc-pay]');
    await page.waitForSelector('#acc-pay.is-open form');
    // Modal roots share one z-index, so the one later in the page paints on
    // top and is the one Escape closes: the pay dialog must be the last.
    const stack = await page.evaluate(() => {
      const open = [...document.querySelectorAll('[data-atlas-modal].is-open')].map((node) => node.id);
      const button = document.querySelector('#acc-pay [type="submit"]');
      return { open, inert: Boolean(button.closest('[inert]')) };
    });
    assert.deepEqual(stack, { open: ['acc-document', 'acc-pay'], inert: false }, 'the pay dialog is above the sheet');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('acc-pay').hidden);
    assert.equal(await page.isVisible('#acc-document .atlas-sheet'), true, 'Escape closes the dialog, not the sheet under it');
    await page.click('#acc-document .atlas-sheet__foot [data-acc-pay]');
    await page.waitForSelector('#acc-pay.is-open form');
    await page.click('#acc-pay [type="submit"]');
    await until(() => backend.commands('mark_paid').length, { message: 'mark_paid from the sheet' });
    await page.waitForSelector('#acc-document [data-acc-unpay]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);
    noErrors(record);
  } finally { await close(); }
});

test('void needs a reason; discard removes a to-review upload', { skip }, async () => {
  const { page, record, backend, close } = await launch();
  try {
    await openAccounting(page, '#accounting/unpaid');
    await openDoc(page, IDS.unpaid);
    await page.click('#acc-document [data-acc-void]');
    await page.waitForSelector('#acc-reason.is-open form');
    await page.click('#acc-reason [type="submit"]');
    await page.waitForSelector('#acc-reason [data-acc-error]:not([hidden])');
    assert.equal(await page.textContent('#acc-reason [data-acc-error-text]'), 'Say why, in a few words.');
    assert.equal(await page.getAttribute('#acc-reason #acc-reason-text', 'aria-invalid'), 'true');
    assert.equal(backend.commands('void').length, 0);
    await page.fill('#acc-reason #acc-reason-text', 'Sent twice by the supplier');
    await page.click('#acc-reason [type="submit"]');
    await until(() => backend.commands('void').length, { message: 'void' });
    assert.deepEqual(backend.commands('void')[0].body.payload, { reason: 'Sent twice by the supplier' });
    await page.waitForSelector('#acc-document .atlas-alert--warning');
    assert.match(await page.textContent('#acc-document'), /Sent twice by the supplier/);
    await page.click('#acc-document .atlas-sheet__foot [data-modal-close]');
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);
    // Closing returns to the tab the sheet was opened from.
    await page.waitForFunction(() => location.hash === '#accounting/unpaid');

    await navigateTo(page, '#accounting');
    await openDoc(page, IDS.review);
    await page.click('#acc-document [data-acc-discard]');
    await page.waitForSelector('#acc-reason.is-open form');
    assert.match(await page.textContent('#acc-reason label'), /optional/);
    await page.click('#acc-reason [type="submit"]');
    await until(() => backend.commands('discard').length, { message: 'discard' });
    assert.deepEqual(backend.commands('discard')[0].body.payload, { reason: '' });
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);
    await settle(page);
    assert.match(await page.textContent('#accounting-view .acc-body'), /Nothing to review/);
    await page.click('#accounting-view .acc-tabs a[href="#accounting/all"]');
    await page.waitForSelector('#accounting-view [data-acc-filter="discarded"]');
    await page.click('#accounting-view [data-acc-filter="discarded"]');
    assert.match(await page.textContent('#accounting-view .acc-body'), /globus-sept\.pdf/);
    noErrors(record);
  } finally { await close(); }
});

test('export: month select, CSV (standard and Icelandic Excel) with a Counted column and formula-safe cells', { skip }, async () => {
  const backend = accountingBackend();
  // A void document in August, one approved after August was last exported, and
  // a document to review dated in July (not counted as waiting for August).
  backend.documents.push(
    doc({ id: 'a0000000-0000-4000-8000-000000000011', status: 'void', void_reason: 'Duplicate', supplier_name: 'Nói Síríus', issue_date: '2026-08-15', total_amount: 3000, net_amount: 2419.35, vat_amount: 580.65, vat_lines: [{ rate: 24, net: 2419.35, vat: 580.65 }], exported: true }),
    doc({ id: 'a0000000-0000-4000-8000-000000000012', supplier_name: 'Innnes', issue_date: '2026-07-10', total_amount: 900 })
  );
  backend.documents.find((entry) => entry.id === IDS.paid).exported = true;
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page, '#accounting/export');
    const months = await page.$$eval('#accounting-view #acc-month option', (options) => options.map((option) => [option.value, option.textContent]));
    assert.equal(months.length, 24);
    assert.deepEqual(months[0], ['2026-09', 'September 2026']);
    assert.deepEqual(months.at(-1), ['2024-10', 'October 2024']);
    assert.equal(await page.inputValue('#accounting-view #acc-month'), '2026-08', 'defaults to last month');
    let text = await page.textContent('#accounting-view .acc-export');
    assert.match(text, /1 document is still to review/, 'only the undated one; July is another month');
    assert.match(text, /4 documents in this month were approved after it was last exported/);
    assert.match(text, /Regla, Payday/);
    assert.match(text, /original files plus both spreadsheets/);
    assert.match(text, /Credit notes count as minus amounts/);
    // An empty month: nothing to download.
    await page.selectOption('#accounting-view #acc-month', '2026-06');
    await settle(page);
    assert.deepEqual(await page.$$eval('#accounting-view [data-acc-export]', (buttons) => buttons.map((button) => button.disabled)), [true, true, true]);
    assert.match(await page.textContent('#accounting-view .acc-export'), /Nothing approved is dated in this month/);
    // September: one approved document (the staff receipt).
    await page.selectOption('#accounting-view #acc-month', '2026-09');
    await settle(page);
    assert.match(await page.textContent('#accounting-view .atlas-stats'), /Documents\s*1/);
    await page.selectOption('#accounting-view #acc-month', '2026-08');
    await settle(page);
    text = await page.textContent('#accounting-view .atlas-stats');
    assert.match(text, /Documents\s*5\s*1 void/);
    assert.match(text, /Total\s*68\.500 kr/, 'whole krónur, void left out');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#accounting-view [data-acc-export="csv"]')]);
    assert.equal(download.suggestedFilename(), 'Accounting 2026-08.csv');
    const csv = await readFile(await download.path(), 'utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff, 'UTF-8 BOM for spreadsheet apps');
    const rows = parseCsv(csv.slice(1));
    const HEADER = ['Document date', 'Due date', 'Type', 'Supplier', 'Supplier kennitala', 'Number', 'Category', 'Currency', 'Net', 'VAT 24%', 'VAT 11%', 'VAT', 'Total', 'Status', 'Counted', 'Paid on', 'Payment method', 'Payment reference', 'Paid by', 'Void reason', 'Note', 'File'];
    assert.deepEqual(rows[0], HEADER);
    const range = requestsTo(record, FN, 'export')[0];
    assert.equal(new URLSearchParams(range.search).get('from'), '2026-08-01');
    assert.equal(new URLSearchParams(range.search).get('to'), '2026-08-31');
    assert.equal(rows.length, 1 + 6, 'one row per document, the void one included');
    const col = Object.fromEntries(HEADER.map((name, index) => [name, index]));
    const bySupplier = Object.fromEntries(rows.slice(1).map((row) => [row[col.Supplier], row]));
    const formula = bySupplier[`'=HYPERLINK("http://evil.example","x")`];
    assert.ok(formula, `formula supplier is prefixed: ${Object.keys(bySupplier)}`);
    assert.equal(formula[col.Number], "'+99", 'a leading + is neutralised too');
    assert.equal(formula[col.Net], '806.45');
    const paid = bySupplier['Vífilfell'];
    assert.deepEqual(['Status', 'Counted', 'Paid on', 'Payment method', 'Payment reference', 'Paid by'].map((name) => paid[col[name]]), ['Paid', 'Yes', '2026-08-10', 'Bank transfer', 'MB-1', 'The business']);
    const staff = bySupplier['Bónus'];
    assert.deepEqual(['VAT 11%', 'Total', 'Status', 'Paid by'].map((name) => staff[col[name]]), ['396', '4000', 'To reimburse', USERS.bartender.display_name]);
    const voided = bySupplier['Nói Síríus'];
    assert.deepEqual(['Total', 'Status', 'Counted', 'Void reason'].map((name) => voided[col[name]]), ['3000', 'Void', 'No – void', 'Duplicate']);
    await page.waitForFunction(() => /Spreadsheet downloaded: 6 documents/.test(document.querySelector('[data-acc-export-status]')?.textContent || ''));

    // Icelandic Excel: semicolons between columns, decimal commas.
    const [excel] = await Promise.all([page.waitForEvent('download'), page.click('#accounting-view [data-acc-export="csv-is"]')]);
    assert.equal(excel.suggestedFilename(), 'Accounting 2026-08 (Excel).csv');
    const excelText = await readFile(await excel.path(), 'utf8');
    const excelRows = parseCsv(excelText.slice(1), ';');
    assert.deepEqual(excelRows[0], HEADER);
    assert.ok(excelText.split('\r\n')[0].includes('Document date;Due date;Type'));
    const excelFormula = excelRows.find((row) => row[col.Supplier].startsWith("'=HYPERLINK"));
    assert.deepEqual([excelFormula[col.Net], excelFormula[col.VAT], excelFormula[col.Total]], ['806,45', '193,55', '1000']);
    assert.equal(await page.isDisabled('#accounting-view [data-acc-export="csv"]'), false);
    noErrors(record);
  } finally { await close(); }
});

test('phone 390: no horizontal scroll on the list, the document sheet and the upload sheet', { skip }, async () => {
  const width = 390;
  const { page, record, close } = await launch({ viewport: { width, height: 844 } });
  try {
    for (const tab of ['#accounting', '#accounting/unpaid', '#accounting/owed', '#accounting/all', '#accounting/export']) {
      await openAccounting(page, tab);
      assert.equal(await noHorizontalScroll(page, width), true, `${tab}: no horizontal scroll`);
    }
    // The tab bar stays usable: every tab can be reached and tapped.
    await openAccounting(page, '#accounting');
    const tabs = await page.$$eval('#accounting-view .acc-tabs a', (links) => links.map((link) => { const box = link.getBoundingClientRect(); return { text: link.textContent.trim(), height: box.height }; }));
    assert.equal(tabs.length, 5);
    tabs.forEach((tab) => assert.ok(tab.height >= 40, `${tab.text} tab is tall enough (${tab.height})`));
    await page.locator('#accounting-view .acc-tabs a[href="#accounting/export"]').scrollIntoViewIfNeeded();
    await page.tap('#accounting-view .acc-tabs a[href="#accounting/export"]');
    await page.waitForSelector('#accounting-view [data-acc-export="csv"]');
    const exportButton = await page.$eval('#accounting-view [data-acc-export="csv"]', (node) => { const box = node.getBoundingClientRect(); return { right: box.right, height: box.height }; });
    assert.ok(exportButton.right <= width && exportButton.height >= 44, `export button fits and is tappable: ${JSON.stringify(exportButton)}`);

    // Rows: the status pills sit under the title instead of squeezing a long
    // supplier name into a narrow column, and the whole row opens the
    // document (row buttons are hidden on phones), whose footer has Mark paid.
    await openAccounting(page, '#accounting/unpaid');
    const rowLayout = await page.$eval(`#accounting-view [data-acc-row="${IDS.unpaid}"]`, (row) => ({
      title: row.querySelector('.atlas-row__title').getBoundingClientRect().width,
      titleLines: Math.round(row.querySelector('.atlas-row__title').getBoundingClientRect().height / 20),
      pillsBelow: row.querySelector('.acc-row__end').getBoundingClientRect().top >= row.querySelector('.atlas-row__meta').getBoundingClientRect().bottom - 1
    }));
    assert.ok(rowLayout.title >= 250, `the title keeps the row width (${rowLayout.title})`);
    assert.equal(rowLayout.titleLines, 1);
    assert.equal(rowLayout.pillsBelow, true);
    const rowBox = await page.$eval(`#accounting-view [data-acc-row="${IDS.unpaid}"]`, (row) => { const box = row.getBoundingClientRect(); return { x: box.right - 30, y: box.top + 10 }; });
    await page.touchscreen.tap(rowBox.x, rowBox.y);
    await page.waitForSelector('#acc-document.is-open .atlas-sheet__foot [data-acc-pay]');
    assert.equal(await page.textContent('#acc-document .atlas-sheet__foot [data-acc-pay]'), 'Mark paid');
    await page.tap('#acc-document .atlas-sheet__close');
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);

    await openAccounting(page, '#accounting');
    await openDoc(page, IDS.review);
    await page.click('#acc-document [data-acc-vat-add]');
    assert.equal(await noHorizontalScroll(page, width), true, 'document sheet: no horizontal page scroll');
    const sheet = await page.evaluate((limit) => {
      const panel = document.querySelector('#acc-document .atlas-sheet');
      const wide = [...panel.querySelectorAll('input, select, button, textarea')].filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > limit + 0.5).map((node) => node.id || node.className);
      const foot = [...panel.querySelectorAll('.atlas-sheet__foot .atlas-btn')].map((node) => node.getBoundingClientRect().height);
      return { panelRight: panel.getBoundingClientRect().right, bodyOverflow: panel.querySelector('.atlas-sheet__body').scrollWidth - panel.querySelector('.atlas-sheet__body').clientWidth, wide, foot };
    }, width);
    assert.ok(sheet.panelRight <= width + 0.5, `sheet fits: ${sheet.panelRight}`);
    assert.ok(sheet.bodyOverflow <= 0, `sheet body does not scroll sideways (${sheet.bodyOverflow})`);
    assert.deepEqual(sheet.wide, [], 'no control runs off the screen');
    sheet.foot.forEach((height) => assert.ok(height >= 44, `footer button height ${height}`));
    // The VAT rate select is wide enough to show "24%".
    const rate = await page.$eval('#acc-document #acc-vat-rate-0', (node) => node.getBoundingClientRect().width);
    assert.ok(rate >= 88, `rate select width ${rate}`);
    await page.locator('#acc-document [data-acc-save]').scrollIntoViewIfNeeded();
    await page.tap('#acc-document [data-acc-save]');
    await until(() => requestsTo(record, FN, 'command').length, { message: 'save from the phone' });
    await settle(page);
    await page.tap('#acc-document .atlas-sheet__close');
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);

    await page.tap('#accounting-view [data-acc-upload]');
    await page.waitForSelector('#acc-upload.is-open');
    await page.setInputFiles('#acc-upload [data-acc-files]', { name: 'a-very-long-file-name-from-the-phone-camera-roll-2026-09-24.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await page.check('#acc-upload input[name="paid_by"][value="staff"]');
    await settle(page);
    assert.equal(await noHorizontalScroll(page, width), true, 'upload sheet: no horizontal page scroll');
    const upload = await page.evaluate((limit) => {
      const panel = document.querySelector('#acc-upload .atlas-sheet');
      const body = panel.querySelector('.atlas-sheet__body');
      const drop = document.querySelector('#acc-upload .acc-drop');
      return {
        fits: panel.getBoundingClientRect().right <= limit + 0.5 && body.scrollWidth <= body.clientWidth,
        camera: document.querySelector('#acc-upload .acc-camera').getClientRects().length > 0,
        start: document.querySelector('#acc-upload [data-acc-start]').getBoundingClientRect().right <= limit,
        // "Who paid?" is a radio group and looks like one (round marks).
        radios: [...document.querySelectorAll('#acc-upload input[name="paid_by"]')].map((node) => getComputedStyle(node).borderTopLeftRadius),
        // The drop zone's title and help are separate lines.
        helpBelowTitle: drop.querySelector('.atlas-upload__help').getBoundingClientRect().top >= drop.querySelector('.atlas-upload__title').getBoundingClientRect().bottom - 1
      };
    }, width);
    assert.deepEqual(upload, { fits: true, camera: true, start: true, radios: ['50%', '50%'], helpBelowTitle: true });
    noErrors(record);
  } finally { await close(); }
});

test('#accounting/document/<id> opens that document once the workspace loads', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await navigateTo(page, `#accounting/document/${IDS.paid}`);
    await page.waitForSelector('#acc-document.is-open [data-acc-unpay]');
    assert.match(await page.textContent('#acc-document .acc-paid'), /Paid on .* · Bank transfer · MB-1/);
    // A paid document reads as facts, not ~15 disabled inputs.
    assert.equal(await page.$$eval('#acc-document .acc-doc input, #acc-document .acc-doc select', (nodes) => nodes.length), 0);
    const facts = await page.$$eval('#acc-document [data-acc-facts] > div', (rows) => Object.fromEntries(rows.map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
    assert.deepEqual([facts.Supplier, facts.Number, facts.Total, facts['Net (án VSK)'], facts['Due date'], facts.Note, facts['Who paid']], ['Vífilfell', '5521', '12.400 kr', '10.000 kr', '—', '—', 'The business']);
    assert.equal(await page.getAttribute('#accounting-view .acc-tabs a[aria-current="page"]', 'href'), '#accounting/all');
    assert.equal(requestsTo(record, FN, 'snapshot').length, 1);
    noErrors(record);
  } finally { await close(); }
});

test('owed to team: "Mark all reimbursed" asks once, marks each in turn and reports a partial failure', { skip }, async () => {
  const backend = accountingBackend({ failPay: [IDS.owedSara2] });
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page, '#accounting/owed');
    const heads = await page.$$eval('#accounting-view .acc-owed', (sections) => sections.map((section) => section.querySelector('[data-acc-pay-all]')?.getAttribute('aria-label') || null));
    assert.deepEqual(heads, [`Mark all reimbursed: ${USERS.bartender.display_name}`, null], 'only a person with several receipts gets it');
    await page.click(`#accounting-view [data-acc-pay-all="${USERS.bartender.id}"]`);
    await page.waitForSelector('#acc-pay.is-open form');
    assert.match(await page.textContent('#acc-pay form > p'), /2 receipts · 5\.500 kr/);
    assert.equal(await page.textContent('#acc-pay [type="submit"]'), 'Mark 2 reimbursed');
    await page.selectOption('#acc-pay #acc-method', 'cash');
    await page.click('#acc-pay [type="submit"]');
    await page.waitForSelector('#acc-pay [data-acc-error]:not([hidden])');
    assert.match(await page.textContent('#acc-pay [data-acc-error-text]'), /^1 of 2 marked reimbursed; 1 couldn’t be\. Accounting is unavailable right now/);
    const first = backend.commands('mark_paid');
    assert.deepEqual(first.map((call) => [call.body.id, call.body.payload.payment_method]), [[IDS.owedSara, 'cash'], [IDS.owedSara2, 'cash']]);
    // Trying again sends only the one that failed.
    await page.click('#acc-pay [type="submit"]');
    await page.waitForFunction(() => document.getElementById('acc-pay').hidden);
    assert.deepEqual(backend.commands('mark_paid').slice(2).map((call) => call.body.id), [IDS.owedSara2]);
    await settle(page);
    assert.equal(await page.$$eval('#accounting-view .acc-owed', (sections) => sections.length), 1);
    noErrors(record, [503]);
  } finally { await close(); }
});

test('upload: button waits for the workspace; several files stay listed as row links and Cancel becomes Done', { skip }, async () => {
  const backend = accountingBackend({ aiEnabled: false, holdSnapshot: true });
  const { page, record, close } = await launch({ backend, viewport: { width: 390, height: 844 } });
  try {
    await page.evaluate(() => { window.AtlasShell.navigate('#accounting'); });
    await page.waitForSelector('#accounting-view .page-head [data-acc-upload]');
    assert.equal(await page.isDisabled('#accounting-view .page-head [data-acc-upload]'), true, 'disabled while loading');
    backend.release();
    await page.waitForSelector('#accounting-view .acc-tabs a .count');
    assert.equal(await page.isDisabled('#accounting-view .page-head [data-acc-upload]'), false);
    // The To review tab doesn't repeat "To review" on every row.
    assert.equal(await page.$$eval('#accounting-view .acc-body .atlas-pill', (pills) => pills.filter((pill) => pill.textContent === 'To review').length), 0);

    await page.tap('#accounting-view .page-head [data-acc-upload]');
    await page.waitForSelector('#acc-upload.is-open');
    const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`) });
    await page.setInputFiles('#acc-upload [data-acc-files]', [pdf('one.pdf'), pdf('two.pdf'), pdf('three.pdf')]);
    const camera = await page.$eval('#acc-upload .acc-camera', (node) => node.getBoundingClientRect().height);
    assert.ok(camera >= 44, `"Take a photo" keeps its height with a queue (${camera})`);
    assert.equal(await page.textContent('#acc-upload [data-acc-cancel]'), 'Cancel');
    await page.tap('#acc-upload [data-acc-start]');
    await page.waitForFunction(() => document.querySelectorAll('#acc-upload [data-acc-queue] .atlas-row__link[data-acc-q-open]').length === 3);
    assert.equal(await page.isVisible('#acc-upload'), true, 'several uploads stay listed');
    assert.equal(await page.textContent('#acc-upload [data-acc-cancel]'), 'Done');
    const link = await page.$eval('#acc-upload [data-acc-queue] li:nth-child(2) .atlas-row__link', (node) => node.dataset.accQOpen);
    const box = await page.$eval('#acc-upload [data-acc-queue] li:nth-child(2)', (node) => { const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
    await page.touchscreen.tap(box.x, box.y);
    await page.waitForSelector('#acc-document.is-open [data-acc-form]');
    assert.equal(await page.evaluate(() => location.hash), `#accounting/document/${link}`);
    noErrors(record);
  } finally { await close(); }
});

test('phone: the sheet opens at the top on its heading; Back closes it; tabs and the All filter fit', { skip }, async () => {
  const width = 390;
  const backend = accountingBackend();
  // A to-review document Atlas read, with warnings, so the form starts well below the fold.
  const read = { supplier_name: 'Globus hf.', issue_date: '2026-09-18', total_amount: 13000, net_amount: 10484, vat_amount: 2516, currency: 'ISK', line_items: [] };
  Object.assign(backend.documents[0], {
    extraction_status: 'read', extraction: { version: 1, fields: read, prefill: { supplier_name: 'Globus hf.', issue_date: '2026-09-18', total_amount: 13000 } },
    supplier_name: 'Globus hf.', issue_date: '2026-09-18', total_amount: 12400,
    checks: { totals_mismatch: true, vat_lines_mismatch: false, order_difference: null, overdue: false, possible_duplicates: [{ id: IDS.paid, document_number: '5521', status: 'paid' }] },
    history: [
      { action: 'edited', actor_label: 'Imad El Moubarik', details: { changes: { total_amount: [13000, 12400], note: [null, 'x'] } }, created_at: '2026-09-23T11:00:00.000Z' },
      { action: 'file_opened', actor_label: 'Imad El Moubarik', details: {}, created_at: '2026-09-23T10:30:00.000Z' },
      { action: 'uploaded', actor_label: 'Imad El Moubarik', details: {}, created_at: '2026-09-23T10:00:00.000Z' }
    ]
  });
  const { page, record, close } = await launch({ backend, viewport: { width, height: 844 } });
  try {
    await openAccounting(page, '#accounting/export');
    const strip = await page.$eval('#accounting-view .acc-tabs', (node) => {
      const active = node.querySelector('[aria-current="page"]').getBoundingClientRect(); const box = node.getBoundingClientRect();
      return { scrolled: node.scrollLeft > 0, visible: active.left >= box.left - 1 && active.right <= box.right + 1 };
    });
    assert.deepEqual(strip, { scrolled: true, visible: true }, 'the current tab is scrolled into view');

    await openAccounting(page, '#accounting/all');
    const toolbar = await page.evaluate(() => {
      const search = document.querySelector('#accounting-view .acc-toolbar .atlas-search').getBoundingClientRect();
      const select = document.querySelector('#accounting-view [data-acc-filter-select]');
      return { search: Math.round(search.width), select: select.getClientRects().length ? Math.round(select.getBoundingClientRect().width) : 0, segmented: document.querySelector('#accounting-view .acc-filter').getClientRects().length };
    });
    assert.deepEqual(toolbar, { search: width - 32, select: width - 32, segmented: 0 });
    await page.selectOption('#accounting-view [data-acc-filter-select]', 'paid');
    await page.waitForFunction(() => document.querySelectorAll('#accounting-view [data-acc-row]').length === 1);
    assert.match(await page.textContent('#accounting-view .acc-body .atlas-list'), /Vífilfell/);

    await openAccounting(page, '#accounting');
    await page.tap(`#accounting-view .atlas-row__link[data-acc-open="${IDS.review}"]`);
    await page.waitForSelector('#acc-document.is-open [data-acc-form]');
    await settle(page);
    const opened = await page.evaluate(() => ({ scrollTop: document.querySelector('#acc-document .atlas-sheet__body').scrollTop, focus: document.activeElement?.id, hash: location.hash }));
    assert.deepEqual(opened, { scrollTop: 0, focus: 'acc-doc-title', hash: `#accounting/document/${IDS.review}` });
    // Hints: filled by Atlas where the value is Atlas's; a warning where it differs.
    const hints = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#acc-document .acc-filled, #acc-document .acc-differs')].map((node) => [`${node.closest('.atlas-field').querySelector('label').getAttribute('for')}:${node.classList.contains('acc-filled') ? 'filled' : 'differs'}`, node.textContent.trim()])));
    assert.deepEqual(hints, {
      'acc-supplier-name:filled': 'Filled by Atlas',
      'acc-date:filled': 'Filled by Atlas',
      'acc-total:differs': 'Atlas read 13.000 kr. Check it against the document.'
    });
    assert.match(await page.textContent('#acc-document [data-acc-file]'), /Opens in a new tab\./);
    assert.doesNotMatch(await page.textContent('#acc-document [data-acc-file]'), /5 minutes/);
    // History: no "File opened"; the edit says what changed.
    const history = await page.$$eval('#acc-document .acc-details:last-of-type li', (rows) => rows.map((row) => row.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(history.length, 2);
    assert.match(history[0], /^Edited ?Total: 13\.000 kr → 12\.400 kr · Note ?Imad/);
    assert.doesNotMatch(history.join(' '), /File opened/);

    // The phone's Back closes the sheet and returns to the list.
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);
    assert.equal(await page.evaluate(() => location.hash), '#accounting');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'accounting');
    noErrors(record);
  } finally { await close(); }
});

test('other currencies keep their decimals; ISK reads as krónur', { skip }, async () => {
  const backend = accountingBackend();
  backend.documents.push(doc({ id: 'a0000000-0000-4000-8000-000000000013', status: 'approved', supplier_name: 'Amazon EU', issue_date: '2026-09-05', currency: 'EUR', total_amount: 49.9 }));
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page, '#accounting/unpaid');
    const meta = await page.textContent('#accounting-view [data-acc-row="a0000000-0000-4000-8000-000000000013"] .atlas-row__meta');
    assert.match(meta, /49[.,]90/);
    assert.match(meta, /€|EUR/);
    assert.match(await page.textContent(`#accounting-view [data-acc-row="${IDS.unpaid}"] .atlas-row__meta`), /49\.600 kr/);
    noErrors(record);
  } finally { await close(); }
});

test('stylesheet: the Accounting block uses defined tokens only', { skip }, async () => {
  const css = await readFile(new URL('../../apps/web/assets/css/purchasing.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../apps/web/assets/css/atlas-tokens.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('S92 Accounting'));
  const used = [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))];
  assert.deepEqual(used.filter((name) => !tokens.includes(`${name}:`)), []);
});

test('totals never add currencies: krónur totals plus a line per other currency', { skip }, async () => {
  const backend = accountingBackend();
  const EUR = 'a0000000-0000-4000-8000-000000000021';
  const EUR_STAFF = 'a0000000-0000-4000-8000-000000000022';
  backend.documents.push(
    doc({ id: EUR, status: 'approved', supplier_name: 'Riedel GmbH', issue_date: '2026-08-18', currency: 'EUR', net_amount: 322.58, vat_amount: 77.42, total_amount: 400, vat_lines: [{ rate: 24, net: 322.58, vat: 77.42 }] }),
    doc({ id: EUR_STAFF, status: 'approved', kind: 'receipt', supplier_name: 'Ryanair', issue_date: '2026-09-03', currency: 'EUR', total_amount: 40, paid_by: 'staff', paid_by_profile_id: USERS.bartender.id, paid_by_label: USERS.bartender.display_name })
  );
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page, '#accounting/unpaid');
    const unpaid = await page.$eval('#accounting-view .atlas-stat', (node) => node.innerText.replace(/\s+/g, ' ').trim());
    assert.match(unpaid, /^Unpaid 50\.600 kr 3 documents Plus €400\.00 in 1 EUR invoice \(not in this total\)$/);

    await navigateTo(page, '#accounting/export');
    const stats = await page.$eval('#accounting-view .atlas-stats', (node) => node.innerText.replace(/\s+/g, ' '));
    assert.match(stats, /Total 68\.500 kr Plus €400\.00 in 1 EUR invoice \(not in this total\)/);
    assert.match(stats, /VAT 24% 12\.484 kr/, 'the EUR invoice\'s VAT is not added to krónur');

    await navigateTo(page, '#accounting/owed');
    const owed = await page.$eval(`#accounting-view [data-acc-owed="${USERS.bartender.id}"] .atlas-section__meta`, (node) => node.textContent);
    assert.equal(owed, 'Owed 5.500 kr + €40.00');
    await page.click(`#accounting-view [data-acc-pay-all="${USERS.bartender.id}"]`);
    await page.waitForSelector('#acc-pay.is-open form');
    assert.match(await page.textContent('#acc-pay form > p'), /^3 receipts · 5\.500 kr \+ €40\.00\./);
    noErrors(record);
  } finally { await close(); }
});

test('phone rows: the icon sits beside the title and the pills line up with it; the owed header stacks', { skip }, async () => {
  const backend = accountingBackend();
  backend.documents.find((entry) => entry.id === IDS.unpaid).supplier_name = 'Ölgerðin Egill Skallagrímsson hf. — heildsala og dreifing';
  const { page, record, close } = await launch({ backend, viewport: { width: 390, height: 844 } });
  try {
    for (const route of ['#accounting/unpaid', '#accounting/all']) {
      await openAccounting(page, route);
      const rows = await page.$$eval('#accounting-view [data-acc-row]', (list) => list.map((row) => {
        const icon = row.querySelector('.atlas-row__icon').getBoundingClientRect();
        const title = row.querySelector('.atlas-row__title').getBoundingClientRect();
        const pills = row.querySelector('.acc-row__end').getBoundingClientRect();
        return { id: row.dataset.accRow, iconInTitleRow: icon.top >= title.top - 8 && icon.top <= title.top + 8, iconLeftOfTitle: icon.right <= title.left, pillsAligned: Math.abs(pills.left - title.left) < 1, pillsBelow: pills.top >= title.bottom - 1 };
      }));
      assert.ok(rows.length >= 2, route);
      rows.forEach((row) => assert.deepEqual(row, { id: row.id, iconInTitleRow: true, iconLeftOfTitle: true, pillsAligned: true, pillsBelow: true }, `${route} ${row.id}`));
    }
    // The review row without an amount leaves out the dash.
    await openAccounting(page, '#accounting');
    assert.equal(await page.textContent(`#accounting-view [data-acc-row="${IDS.review}"] .atlas-row__meta`), 'Invoice · No date');

    await openAccounting(page, '#accounting/owed');
    const head = await page.$eval(`#accounting-view [data-acc-owed="${USERS.bartender.id}"] .acc-owed__head`, (node) => {
      const box = node.getBoundingClientRect();
      const title = node.querySelector('.atlas-section__title').getBoundingClientRect();
      const meta = node.querySelector('.atlas-section__meta').getBoundingClientRect();
      const button = node.querySelector('[data-acc-pay-all]').getBoundingClientRect();
      return { titleLines: Math.round(title.height / 20) <= 2, titleFull: Math.abs(title.width - box.width) < 1, metaBelow: meta.top >= title.bottom - 1, metaLeft: Math.abs(meta.left - box.left) < 1, buttonRight: Math.abs(button.right - box.right) < 1, sameLine: Math.abs((meta.top + meta.height / 2) - (button.top + button.height / 2)) < 4 };
    });
    assert.deepEqual(head, { titleLines: true, titleFull: true, metaBelow: true, metaLeft: true, buttonRight: true, sameLine: true });
    noErrors(record);
  } finally { await close(); }
});

test('desktop owed header: name left, amount and action grouped right', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await openAccounting(page, '#accounting/owed');
    const heads = await page.$$eval('#accounting-view .acc-owed__head', (list) => list.map((node) => {
      const box = node.getBoundingClientRect();
      const title = node.querySelector('.atlas-section__title').getBoundingClientRect();
      const end = node.querySelector('.acc-owed__end').getBoundingClientRect();
      return { titleLeft: Math.abs(title.left - box.left) < 1, endRight: Math.abs(end.right - box.right) < 1, oneLine: Math.abs(title.top - end.top) < 12 };
    }));
    assert.equal(heads.length, 2);
    heads.forEach((head) => assert.deepEqual(head, { titleLeft: true, endRight: true, oneLine: true }));
    noErrors(record);
  } finally { await close(); }
});

test('errors: "Go to <field>" focuses the field; dialog alerts draw their icon; approved-by is a fact', { skip }, async () => {
  const { page, record, backend, close } = await launch();
  try {
    await openAccounting(page);
    await openDoc(page, IDS.review);
    await page.fill('#acc-document #acc-kt', '12345');
    await page.locator('#acc-document [data-acc-save]').click();
    await page.waitForSelector('#acc-document .acc-error:not([hidden]) [data-acc-error-go]');
    assert.equal(await page.textContent('#acc-document [data-acc-error-go]'), 'Go to Supplier kennitala');
    await page.evaluate(() => { document.getElementById('acc-doc-title').focus(); document.querySelector('#acc-document .atlas-sheet__body').scrollTop = 0; });
    await page.click('#acc-document [data-acc-error-go]');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'acc-kt');
    assert.equal(await page.$eval('#acc-document .acc-error', (node) => Boolean(node.querySelector('svg'))), true, 'the alert icon is drawn');
    assert.equal(backend.commands('save').length, 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);

    await openAccounting(page, '#accounting/unpaid');
    await openDoc(page, IDS.unpaid);
    assert.doesNotMatch(await page.textContent('#acc-document .atlas-sheet__desc'), /Approved by/, 'the header stays short');
    const facts = await page.$$eval('#acc-document [data-acc-facts] > div', (rows) => Object.fromEntries(rows.map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
    assert.match(facts['Approved by'], /^Imad El Moubarik · /);
    await page.click('#acc-document [data-acc-void]');
    await page.waitForSelector('#acc-reason.is-open form');
    await page.click('#acc-reason [type="submit"]');
    await page.waitForSelector('#acc-reason [data-acc-error]:not([hidden])');
    assert.equal(await page.$eval('#acc-reason [data-acc-error]', (node) => Boolean(node.querySelector('svg'))), true, 'reason dialog alert icon');
    assert.equal(await page.textContent('#acc-reason [data-acc-error-go]'), 'Go to Reason');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('acc-reason').hidden);
    await page.click('#acc-document .atlas-sheet__foot [data-acc-pay]');
    await page.waitForSelector('#acc-pay.is-open form');
    await page.fill('#acc-pay #acc-paid-on', '');
    await page.click('#acc-pay [type="submit"]');
    await page.waitForSelector('#acc-pay [data-acc-error]:not([hidden])');
    assert.equal(await page.$eval('#acc-pay [data-acc-error]', (node) => Boolean(node.querySelector('svg'))), true, 'pay dialog alert icon');
    assert.equal(await page.textContent('#acc-pay [data-acc-error-go]'), 'Go to Paid on');
    // Sheet footers are sticky actions, so a toast rises above them.
    assert.equal(await page.$eval('#acc-document .atlas-sheet__foot', (node) => node.hasAttribute('data-atlas-sticky-actions')), true);
    noErrors(record);
  } finally { await close(); }
});

// ---------- S92 rollout state: web published before the atlas-accounting function ----------

const FN_URL = `${SUPABASE}/functions/v1/${FN}`;
const healthChecks = (record) => record.requests.filter((entry) => entry.path === '/auth/v1/health');
const notDeployedText = (page) => page.evaluate(() => {
  const alert = document.querySelector('#accounting-view [data-acc-not-deployed]');
  return alert ? { text: alert.textContent.replace(/\s+/g, ' ').trim(), tone: alert.className, generic: Boolean(document.querySelector('#accounting-view [data-acc-load-error]')) } : null;
});
const genericText = (page) => page.evaluate(() => document.querySelector('#accounting-view [data-acc-load-error]')?.textContent.replace(/\s+/g, ' ').trim() || null);

test('deploy preview: a missing atlas-accounting (reply the browser cannot read) says the backend is not deployed', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#home' });
  try {
    // Supabase answers a function that does not exist with a 404 without CORS
    // headers, so the page's fetch rejects with no HTTP status at all (the
    // harness would hand a fulfilled 404 back readable, so the refusal is
    // simulated at the network level). The project itself (Auth health) still
    // answers.
    let calls = 0;
    await page.route(`${FN_URL}**`, (route) => { calls += 1; return route.abort('failed'); });
    await openAccounting(page);
    await until(async () => Boolean(await notDeployedText(page)), { message: 'the not-deployed notice' });
    const notice = await notDeployedText(page);
    assert.match(notice.text, /Accounting backend is not deployed yet\./);
    assert.match(notice.text, /Nothing was changed\. Deploy S92 Accounting before testing this preview\./);
    assert.match(notice.tone, /atlas-alert--warning/, 'a notice, not a red error');
    assert.equal(notice.generic, false, 'the generic "couldn’t be loaded" alert is not shown');
    assert.doesNotMatch(await page.textContent('#accounting-view'), /couldn’t be loaded/);
    assert.ok(healthChecks(record).length >= 1, 'the project was checked');
    assert.equal(await page.isDisabled('#accounting-view [data-acc-upload]'), true, 'Upload stays off');
    // "Check again" retries the real endpoint; nothing is faked.
    const before = calls;
    await page.click('#accounting-view [data-acc-retry]');
    await until(() => calls > before, { message: 'a retry of atlas-accounting' });
    await until(async () => Boolean(await notDeployedText(page)), { message: 'still not deployed' });
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('deploy preview: a readable gateway 404 without error_code also says not deployed', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#home' });
  try {
    await page.route(`${FN_URL}**`, (route) => route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: '{"code":"NOT_FOUND","message":"Requested function was not found"}' }));
    await openAccounting(page);
    await until(async () => Boolean(await notDeployedText(page)), { message: 'the not-deployed notice' });
    assert.equal((await notDeployedText(page)).generic, false);
    assert.equal(healthChecks(record).length, 0, 'a readable 404 needs no project check');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('after deployment: a genuine server failure keeps the generic error, not the rollout notice', { skip }, async () => {
  const backend = accountingBackend();
  const inner = backend.handler;
  let failing = true;
  backend.handler = (entry) => (failing && entry.action === 'snapshot'
    ? { __status: 500, body: { error_code: 'unavailable', message: 'Accounting is unavailable right now.' } }
    : inner(entry));
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page);
    await until(async () => Boolean(await genericText(page)), { message: 'the generic load error' });
    const text = await genericText(page);
    assert.match(text, /Accounting couldn’t be loaded\./);
    assert.match(text, /Accounting is unavailable right now\. Nothing was changed\./);
    assert.equal(await notDeployedText(page), null, 'no rollout notice for a deployed function');
    assert.equal(healthChecks(record).length, 0);
    // The function recovers: Try again loads the workspace.
    failing = false;
    await page.click('#accounting-view [data-acc-retry]');
    await page.waitForSelector('#accounting-view .atlas-row__link');
    assert.equal(await genericText(page), null);
    noErrors(record, [500]);
  } finally { await close(); }
});

test('offline: when the Supabase project does not answer either, the generic connection error stays', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#home' });
  try {
    await page.route(`${FN_URL}**`, (route) => route.abort('internetdisconnected'));
    await page.route(`${SUPABASE}/auth/v1/health**`, (route) => route.abort('internetdisconnected'));
    await openAccounting(page);
    await until(async () => Boolean(await genericText(page)), { message: 'the generic load error' });
    assert.match(await genericText(page), /Check the connection and try again\./);
    assert.equal(await notDeployedText(page), null);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('credit notes count as minus amounts in the totals and in both exports', { skip }, async () => {
  const backend = accountingBackend();
  // August: Ölgerðin 49.600 kr (24%) plus a 5.000 kr credit note from them (VAT 24% 967,74).
  backend.documents.push(doc({ id: 'a0000000-0000-4000-8000-000000000021', status: 'approved', approved_at: '2026-09-01T10:00:00.000Z', kind: 'credit_note', supplier_name: 'Ölgerðin', document_number: 'KR-12', issue_date: '2026-08-22', total_amount: 5000, net_amount: 4032.26, vat_amount: 967.74, vat_lines: [{ rate: 24, net: 4032.26, vat: 967.74 }] }));
  const { page, record, close } = await launch({ backend });
  try {
    await openAccounting(page, '#accounting/export');
    await page.selectOption('#accounting-view #acc-month', '2026-08');
    await settle(page);
    const stats = await page.textContent('#accounting-view .atlas-stats');
    // Without the credit note August totals 68.500 kr (see the export test); the credit note takes 5.000 kr off.
    assert.match(stats, /Total\s*63\.500 kr/);
    const [standard] = await Promise.all([page.waitForEvent('download'), page.click('#accounting-view [data-acc-export="csv"]')]);
    const rows = parseCsv((await readFile(await standard.path(), 'utf8')).replace(/^﻿/, ''));
    const header = rows[0];
    const credit = rows.find((row) => row[header.indexOf('Number')] === 'KR-12');
    assert.equal(credit[header.indexOf('Type')], 'Credit note');
    assert.equal(credit[header.indexOf('Total')], '-5000');
    assert.equal(credit[header.indexOf('Net')], '-4032.26');
    assert.equal(credit[header.indexOf('VAT 24%')], '-967.74');
    assert.equal(credit[header.indexOf('VAT')], '-967.74');
    const invoice = rows.find((row) => row[header.indexOf('Number')] === 'INV-7781');
    assert.equal(invoice[header.indexOf('Total')], '49600', 'invoices stay positive');
    const [excel] = await Promise.all([page.waitForEvent('download'), page.click('#accounting-view [data-acc-export="csv-is"]')]);
    const excelRows = parseCsv((await readFile(await excel.path(), 'utf8')).replace(/^﻿/, ''), ';');
    const excelCredit = excelRows.find((row) => row[excelRows[0].indexOf('Number')] === 'KR-12');
    assert.equal(excelCredit[excelRows[0].indexOf('Total')], '-5000');
    assert.equal(excelCredit[excelRows[0].indexOf('Net')], '-4032,26', 'minus sign with a decimal comma, no formula guard');
    noErrors(record);
  } finally { await close(); }
});

test('a11y: sheets and dialogs are announced as modal dialogs; approve names the missing field; the drop zone shows focus', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await openAccounting(page);
    await openDoc(page, IDS.review);
    const roles = await page.$eval('#acc-document [data-modal-panel]', (panel) => [panel.getAttribute('role'), panel.getAttribute('aria-modal'), panel.getAttribute('aria-labelledby')]);
    assert.deepEqual(roles, ['dialog', 'true', 'acc-doc-title']);
    // Approve with no supplier, date or total: the alert says so and takes focus to the first missing field.
    await page.click('#acc-document [data-acc-approve]');
    await page.waitForSelector('#acc-document [data-acc-error-text]');
    assert.match(await page.textContent('#acc-document [data-acc-error-text]'), /supplier, the document date and the total/);
    const goTo = await page.$('#acc-document [data-acc-error] button');
    assert.ok(goTo, 'a "Go to" button');
    await goTo.click();
    const focused = await page.evaluate(() => [document.activeElement?.name, document.activeElement?.getAttribute('aria-invalid')]);
    assert.ok(['supplier_id', 'supplier_name'].includes(focused[0]), `focus on the supplier field, got ${focused[0]}`);
    assert.equal(focused[1], 'true');
    assert.equal(requestsTo(record, FN, 'command').length, 0, 'nothing was sent');
    await page.keyboard.press('Escape');
    await page.click('#accounting-view [data-acc-upload]');
    await page.waitForSelector('#acc-upload.is-open');
    assert.deepEqual(await page.$eval('#acc-upload [data-modal-panel]', (panel) => [panel.getAttribute('role'), panel.getAttribute('aria-modal')]), ['dialog', 'true']);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'acc-upload-title', 'the upload sheet opens on its heading');
    await page.focus('#acc-upload [data-acc-files]');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await page.$eval('#acc-upload .acc-drop', (el) => getComputedStyle(el).outlineStyle);
    assert.notEqual(outline, 'none', 'keyboard focus is visible on the drop zone');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// Layers above the page after dialogs close: none may stay over the list.
async function strayLayers(page) {
  return page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return ['fixed', 'absolute'].includes(cs.position) && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
      && box.width > 120 && box.height > 40 && !el.closest('#atlas-sidebar, #atlas-topbar, #atlas-tabbar, .atlas-toast-region')
      && box.bottom > 0 && box.top < innerHeight;
  }).map((el) => `${el.tagName}.${[...el.classList].join('.')}#${el.id}`));
}

for (const viewport of [{ width: 1872, height: 896 }, { width: 390, height: 844 }]) {
  test(`no layer stays over the list after Upload and a document sheet close (${viewport.width})`, { skip }, async () => {
    const documents = seedDocuments();
    for (let index = 0; index < 13; index += 1) documents.push(doc({ id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, file_name: `WhatsApp Image ${index}.jpeg`, mime_type: 'image/jpeg' }));
    const { page, close } = await launch({ viewport, backend: accountingBackend({ documents }) });
    const press = (selector) => (viewport.width < 768 ? page.tap(selector) : page.click(selector));
    try {
      await openAccounting(page);
      assert.deepEqual(await strayLayers(page), [], 'nothing over the list on load');
      await page.mouse.wheel(0, 4000);
      await settle(page);
      assert.deepEqual(await strayLayers(page), [], 'nothing over the list after scrolling');
      await page.evaluate(() => window.scrollTo(0, 0));
      await press('#accounting-view .page-head [data-acc-upload]');
      await page.waitForSelector('#acc-upload.is-open');
      await press('#acc-upload .atlas-sheet__close');
      await until(() => page.evaluate(() => !document.querySelector('.atlas-modal.is-open')));
      assert.deepEqual(await strayLayers(page), [], 'the upload sheet leaves nothing behind');
      await press(`#accounting-view .atlas-row__link[data-acc-open="${IDS.review}"]`);
      await page.waitForSelector('#acc-document.is-open .acc-sheet');
      await page.keyboard.press('Escape');
      await until(() => page.evaluate(() => !document.querySelector('.atlas-modal.is-open')));
      assert.deepEqual(await strayLayers(page), [], 'the document sheet leaves nothing behind');
      assert.equal(await page.evaluate(() => document.body.classList.contains('atlas-modal-open')), false, 'page scroll is unlocked');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    } finally { await close(); }
  });
}

test('files dropped on the Accounting page open Upload with them queued; the browser does not open the file', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await openAccounting(page);
    const dropOn = (selector, name) => page.evaluate(([selector, name]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['%PDF-1.4\n%%EOF\n'], name, { type: 'application/pdf' }));
      const target = document.querySelector(selector);
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(over);
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(drop);
      return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
    }, [selector, name]);
    const first = await dropOn('#accounting-view .acc-body', 'dropped-on-list.pdf');
    assert.deepEqual(first, { overPrevented: true, dropPrevented: true }, 'the browser default (open the file) is stopped');
    await page.waitForSelector('#acc-upload.is-open');
    await until(() => page.evaluate(() => document.querySelector('#acc-upload [data-acc-queue]')?.textContent.includes('dropped-on-list.pdf')));
    // Onto the open sheet, outside its drop zone: added to the same queue once.
    await dropOn('#acc-upload .atlas-sheet__head', 'second.pdf');
    await until(() => page.evaluate(() => document.querySelectorAll('#acc-upload [data-acc-queue] > li').length === 2));
    // Onto the drop zone itself: queued once, not twice.
    await dropOn('#acc-upload [data-acc-drop]', 'third.pdf');
    await until(() => page.evaluate(() => document.querySelectorAll('#acc-upload [data-acc-queue] > li').length === 3));
    await settle(page);
    assert.equal(await page.locator('#acc-upload [data-acc-queue] > li').count(), 3);
    assert.equal(await page.textContent('#acc-upload [data-acc-start]'), 'Upload 3 files');
  } finally { await close(); }
});
