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
    extraction_status: null, extraction: null,
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

const withoutHistory = ({ history, ...rest }) => rest;
const fail = (status, code) => ({ __status: status, body: { error_code: code, message: `server text for ${code}` } });

/**
 * A stateful atlas-accounting mock: an in-memory document list; GET
 * snapshot|document|file|export, POST upload (multipart)|read|command, with the
 * version guard (stale_request), missing_fields and an optional
 * possible_duplicate on approve.
 */
function accountingBackend({ aiEnabled = true, documents = seedDocuments(), duplicateOnApprove = false } = {}) {
  const backend = { documents, calls: [], uploads: [], nextId: 1 };
  const find = (id) => backend.documents.find((entry) => entry.id === id);
  const event = (target, action, details = {}) => { target.history.unshift({ action, actor_label: USERS.admin.display_name, details, created_at: '2026-09-24T14:00:00.000Z' }); };
  const bump = (target) => { target.version += 1; target.updated_at = '2026-09-24T14:00:00.000Z'; };
  const out = (target) => ({ ...target, history: [...target.history] });
  backend.handler = (entry) => {
    backend.calls.push(entry);
    const params = new URLSearchParams(entry.search);
    const action = entry.action;
    if (entry.method === 'GET') {
      if (action === 'snapshot') {
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
      target.extraction = { version: 1, fields: read };
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
        bump(target); event(target, 'edited');
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
  await page.click(`#accounting-view [data-acc-open="${id}"]`);
  await page.waitForSelector('#acc-document.is-open [data-acc-form]');
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
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r') { /* CRLF */ } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
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
    assert.match(await page.textContent(`${sheet} .atlas-alert`), /Let Atlas fill it in/);
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
    assert.equal(await page.textContent('#acc-upload [data-acc-error]'), 'Choose the team member who paid.');
    assert.equal(backend.uploads.length, 0, 'nothing is sent without the person');
    await page.selectOption('#acc-upload #acc-up-payer', USERS.bartender.id);
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
    assert.match(await page.textContent('#acc-document .atlas-alert'), /Atlas read this document/);
    assert.equal(await page.inputValue('#acc-document #acc-supplier-name'), 'Globus hf.');
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
    assert.equal(await page.textContent('#acc-reason [data-acc-error]'), 'Say why, in a few words.');
    assert.equal(backend.commands('void').length, 0);
    await page.fill('#acc-reason #acc-reason-text', 'Sent twice by the supplier');
    await page.click('#acc-reason [type="submit"]');
    await until(() => backend.commands('void').length, { message: 'void' });
    assert.deepEqual(backend.commands('void')[0].body.payload, { reason: 'Sent twice by the supplier' });
    await page.waitForSelector('#acc-document .atlas-alert--warning');
    assert.match(await page.textContent('#acc-document'), /Sent twice by the supplier/);
    await page.click('#acc-document .atlas-sheet__foot [data-modal-close]');
    await page.waitForFunction(() => document.getElementById('acc-document').hidden);

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

test('export: month picker and a CSV with the header, one row per document and formula-safe cells', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await openAccounting(page, '#accounting/export');
    assert.equal(await page.inputValue('#accounting-view #acc-month'), '2026-08', 'defaults to last month');
    // September first: one approved document (the staff receipt).
    await page.fill('#accounting-view #acc-month', '2026-09');
    await page.waitForFunction(() => document.querySelector('#accounting-view #acc-month')?.value === '2026-09');
    await settle(page);
    assert.match(await page.textContent('#accounting-view .atlas-stats'), /Documents\s*1/);
    await page.fill('#accounting-view #acc-month', '2026-08');
    await settle(page);
    assert.match(await page.textContent('#accounting-view .atlas-stats'), /Documents\s*5/);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#accounting-view [data-acc-export="csv"]')
    ]);
    assert.equal(download.suggestedFilename(), 'Accounting 2026-08.csv');
    const text = await readFile(await download.path(), 'utf8');
    assert.equal(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM for spreadsheet apps');
    const rows = parseCsv(text.slice(1));
    assert.deepEqual(rows[0], ['Document date', 'Due date', 'Type', 'Supplier', 'Supplier kennitala', 'Number', 'Category', 'Currency', 'Net', 'VAT 24%', 'VAT 11%', 'VAT', 'Total', 'Status', 'Paid on', 'Payment method', 'Payment reference', 'Paid by', 'Void reason', 'Note', 'File']);
    const range = requestsTo(record, FN, 'export')[0];
    assert.equal(new URLSearchParams(range.search).get('from'), '2026-08-01');
    assert.equal(new URLSearchParams(range.search).get('to'), '2026-08-31');
    assert.equal(rows.length, 1 + 5, 'one row per document');
    const bySupplier = Object.fromEntries(rows.slice(1).map((row) => [row[3], row]));
    const formula = bySupplier[`'=HYPERLINK("http://evil.example","x")`];
    assert.ok(formula, `formula supplier is prefixed: ${Object.keys(bySupplier)}`);
    assert.equal(formula[5], "'+99", 'a leading + is neutralised too');
    const paid = bySupplier['Vífilfell'];
    assert.deepEqual([paid[13], paid[14], paid[15], paid[16], paid[17]], ['Paid', '2026-08-10', 'Bank transfer', 'MB-1', 'The business']);
    const staff = bySupplier['Bónus'];
    assert.deepEqual([staff[10], staff[12], staff[13], staff[17]], ['396', '4000', 'To reimburse', USERS.bartender.display_name]);
    await page.waitForFunction(() => /Spreadsheet downloaded: 5 documents/.test(document.querySelector('[data-acc-export-status]')?.textContent || ''));
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
    assert.equal(await page.isDisabled('#acc-document #acc-total'), true, 'a paid document is read-only');
    assert.equal(await page.getAttribute('#accounting-view .acc-tabs a[aria-current="page"]', 'href'), '#accounting/all');
    assert.equal(requestsTo(record, FN, 'snapshot').length, 1);
    noErrors(record);
  } finally { await close(); }
});
