// Atlas manual build (docs/manual/tools): the Markdown subset, the component
// directives, includes, escaping and the PDF destination reader. No browser.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { escapeHtml, parseAttrs, parseBlocks, parseFrontmatter, renderInline, safeUrl, slugify, stripInline } from '../../docs/manual/tools/lib/markdown.mjs';
import { createRenderer } from '../../docs/manual/tools/lib/render.mjs';
import { resolveIncludes } from '../../docs/manual/tools/lib/include.mjs';
import { namedDestinations } from '../../docs/manual/tools/lib/pdf-dests.mjs';
import { htmlDocument, MANUAL } from '../../docs/manual/tools/build_manual.mjs';

const render = (src, opts = {}) => {
  const r = createRenderer({ root: MANUAL, outDir: MANUAL, ...opts });
  const doc = r.renderDocument(`---\ncover: none\n---\n${src}`);
  return { html: doc.body, warnings: doc.warnings, headings: doc.headings };
};
const count = (html, re) => (html.match(re) || []).length;

// ---------------------------------------------------------------- Markdown core

test('headings get unique slug ids, explicit ids and classes', () => {
  const { html, headings } = render('# Stock count\n\n## Stock count\n\n## Þrif og ÆÐ {#cleaning .quick}\n\n### Third');
  assert.match(html, /<h1 id="stock-count">Stock count<\/h1>/);
  assert.match(html, /<h2 id="stock-count-2">Stock count<\/h2>/);
  assert.match(html, /<h2 id="cleaning" class="quick">Þrif og ÆÐ<\/h2>/);
  assert.match(html, /<h3 id="third">Third<\/h3>/);
  assert.deepEqual(headings.map((h) => h.id), ['stock-count', 'stock-count-2', 'cleaning', 'third']);
  assert.equal(slugify('Þrif og æfing — Kaffi'), 'thrif-og-aefing-kaffi');
});

test('paragraphs, emphasis, code, links and hard breaks', () => {
  const { html } = render('One **bold** and *em* and _also em_ with `a <b> code`.\nSame paragraph  \nafter a break.\n\nSecond [link](https://example.com "Title") and snake_case_word.');
  assert.match(html, /<p>One <strong>bold<\/strong> and <em>em<\/em> and <em>also em<\/em> with <code>a &lt;b&gt; code<\/code>.\nSame paragraph<br>\nafter a break.<\/p>/);
  assert.match(html, /<a href="https:\/\/example.com" title="Title" rel="noopener">link<\/a>/);
  assert.match(html, /snake_case_word/);
  assert.equal(renderInline('***both*** and **a *nested* b**'), '<strong><em>both</em></strong> and <strong>a <em>nested</em> b</strong>');
  assert.equal(renderInline('\\*not em\\* 2 * 3 * 4'), '*not em* 2 * 3 * 4');
});

test('unordered, ordered and nested lists', () => {
  const { html } = render('- one\n- two\n  - nested a\n  - nested b\n- three\n\nText.\n\n3. third\n4. fourth\n   continued\n\nBetween.\n\n1. a\n\n   para in a\n2. b');
  assert.match(html, /<ul class="m-list">\n<li>one<\/li>\n<li>two\n<ul class="m-list">\n<li>nested a<\/li>\n<li>nested b<\/li>\n<\/ul><\/li>\n<li>three<\/li>\n<\/ul>/);
  assert.match(html, /<ol class="m-list" start="3">\n<li>third<\/li>\n<li>fourth\ncontinued<\/li>\n<\/ol>/);
  assert.match(html, /<ol class="m-list m-list--loose">\n<li><p>a<\/p>\n<p>para in a<\/p><\/li>\n<li><p>b<\/p><\/li>\n<\/ol>/);
});

test('tables with alignment, escaped pipes and inline markup', () => {
  const { html } = render('| Item | Qty | Unit |\n| :--- | ---: | :---: |\n| **Limes** | 40 | each \\| box |\n| `a|b` | 2 | bottle |');
  assert.match(html, /<table class="m-table m-table--rowheads">/);
  assert.match(html, /<th scope="col" class="m-align-right">Qty<\/th>/);
  assert.match(html, /<th scope="row" class="m-align-left"><strong>Limes<\/strong><\/th><td class="m-align-right">40<\/td><td class="m-align-center">each \| box<\/td>/);
  assert.match(html, /<code>a\|b<\/code>/);
});

test('blockquote, rule, fenced code, definition list and bare images', () => {
  const { html } = render('> quoted *text*\n\n---\n\n```\n<not html>\n:::tip\n```\n\nTerm\n: Definition one\n\nOther\n: Two\n\n![A caption](assets/brand/Atlas_Mark_Midnight.svg)');
  assert.match(html, /<blockquote class="m-quote"><p>quoted <em>text<\/em><\/p><\/blockquote>/);
  assert.match(html, /<hr class="m-rule">/);
  assert.match(html, /<pre class="m-code"><code>&lt;not html&gt;\n:::tip<\/code><\/pre>/);
  assert.equal(count(html, /m-deflist__entry/g), 2);
  assert.match(html, /<img src="assets\/brand\/Atlas_Mark_Midnight.svg" alt="A caption">/);
});

// ---------------------------------------------------------------- escaping

test('source text can never inject markup, scripts or unsafe URLs', () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> "quotes" & \'apos\'';
  const { html } = render(`${evil}\n\n# <b>head</b>\n\n| <i>x</i> |\n| --- |\n| <u>y</u> |\n\n:::tip <em>t</em>\n<iframe>\n:::\n\n[click](javascript:alert(1)) [data](data:text/html,x) ![i](javascript:x) :ui[<b>]{icon=house} :role[<x>]`);
  assert.doesNotMatch(html, /<script|<img src=x|<iframe|<b>|<i>|<u>|<em>t|javascript:|data:text/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;quotes&quot; &amp; &#39;apos&#39;/);
  assert.match(html, /<a href="#">click<\/a>/);
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(safeUrl(' JavaScript:alert(1)'), '#');
  assert.equal(safeUrl('vbscript:x'), '#');
  assert.equal(safeUrl('mailto:info@example.com'), 'mailto:info@example.com');
  assert.equal(safeUrl('assets/x.png'), 'assets/x.png');
});

test('attribute values from directives are escaped', () => {
  const { html } = render('::figure[Cap "x" <y>]{src="a\\"b.png" alt="\\"><script>"}');
  assert.doesNotMatch(html, /<script>|<y>/);
  const attrs = parseAttrs('{#id .a .b key=value q="two words" s=\'single\' flag}');
  assert.deepEqual(attrs, { classes: ['a', 'b'], id: 'id', key: 'value', q: 'two words', s: 'single', flag: true });
});

// ---------------------------------------------------------------- directives

test('callouts: tip, important, admin-only, roles, Atlas AI, example, coming later', () => {
  const { html } = render([
    ':::tip Count by area', 'Body **text**.', ':::',
    ':::important', 'Careful.', ':::',
    ':::admin-only', 'Only admins.', ':::',
    ':::roles{roles="admin manager"}', 'Two roles.', ':::',
    ':::ai', 'Ask Atlas.', ':::',
    ':::example', 'A day.', ':::',
    ':::coming-later Accounting', 'Later.', ':::'
  ].join('\n'));
  for (const kind of ['tip', 'important', 'admin-only', 'roles', 'ai', 'example', 'coming-later']) {
    assert.match(html, new RegExp(`class="m-callout m-callout--${kind}" role="note"`), kind);
  }
  assert.match(html, /m-callout__label">Tip<\/p><p class="m-callout__title">Count by area<\/p>/);
  assert.match(html, />Administrators only</);
  assert.match(html, />Coming in a later release</);
  assert.match(html, /<span class="m-role m-role--admin">Administrator<\/span> <span class="m-role m-role--manager">Manager<\/span>/);
  assert.match(html, /<svg class="m-icon" aria-hidden="true"/);
});

test('role badges inline and on headings always carry a text label', () => {
  const { html } = render('Hi :role[bartender viewer] and :role[schedule_only].\n\n## Orders {roles="admin,manager"}');
  assert.match(html, /m-role--bartender">Bartender</);
  assert.match(html, /m-role--viewer">Viewer</);
  assert.match(html, /m-role--schedule-only">Schedule only</);
  assert.match(html, /<p class="m-roleline">.*Available to<\/span> <span class="m-role m-role--admin">Administrator<\/span> <span class="m-role m-role--manager">Manager<\/span><\/p>/);
});

test('workflow: numbered steps, title — description, horizontal up to five', () => {
  const { html } = render(':::workflow Receive\n1. Open — Find the order.\n2. Check — Compare lines.\n3. Receive\n:::\n\n:::workflow{layout=vertical}\n- A — a\n- B — b\n:::\n\n:::workflow\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n:::');
  assert.match(html, /class="m-workflow m-workflow--horizontal" style="--steps:3"/);
  assert.match(html, /<span class="m-workflow__num" aria-hidden="true">1<\/span>\n<div class="m-workflow__text"><p class="m-workflow__title">Open<\/p><p class="m-workflow__desc">Find the order.<\/p>/);
  assert.match(html, /<p class="m-workflow__title">Receive<\/p><\/div>/);
  assert.match(html, /m-workflow--vertical" style="--steps:2"/);
  assert.match(html, /m-workflow--vertical" style="--steps:6"/);
});

test('do / don\'t pair and feature cards', () => {
  const { html } = render('::::do-dont\n:::do\n- Count the shelf\n:::\n:::dont Avoid this\n- Copy last week\n:::\n::::\n\n:::cards{cols=2}\nIntro text.\n### Home {icon=house}\nWhat needs you.\n### Team {icon=users roles=admin}\nPeople.\n:::');
  assert.match(html, /<div class="m-dodont"><div class="m-dodont__card m-dodont__card--do">/);
  assert.match(html, /<span>Do<\/span><\/p><ul class="m-list m-list--do">/);
  assert.match(html, /<span>Avoid this<\/span><\/p><ul class="m-list m-list--dont">/);
  assert.match(html, /<p>Intro text.<\/p><div class="m-cards m-cards--2">/);
  assert.equal(count(html, /class="m-card"/g), 2);
  assert.match(html, /<h3 class="m-card__title">Team<\/h3><p class="m-card__roles"><span class="m-role m-role--admin">Administrator<\/span><\/p>/);
});

test('screenshot figure: device frame, markers by %, legend with text, alt from caption', () => {
  const { html, warnings } = render(':::figure{src="assets/brand/Atlas_Mark_Midnight.svg" device=phone caption="Home on a *phone*."}\n- [20%, 5%] **Search** opens search.\n- 80,95 Tab bar\n- bad marker\n:::');
  assert.match(html, /<figure class="m-figure m-figure--phone">/);
  assert.match(html, /<img src="assets\/brand\/Atlas_Mark_Midnight.svg" alt="Home on a phone.">/);
  assert.match(html, /<span class="m-marker" style="left:20%;top:5%" aria-hidden="true">1<\/span><span class="m-marker" style="left:80%;top:95%" aria-hidden="true">2<\/span>/);
  assert.match(html, /<ol class="m-legend"><li><span class="m-legend__num" aria-hidden="true">1<\/span><span class="m-legend__text"><span class="m-sr">Marker 1: <\/span><strong>Search<\/strong> opens search.<\/span><\/li>/);
  assert.ok(warnings.some((w) => /needs "\[x%, y%\] text"/.test(w)));
});

test('missing screenshots render a labelled placeholder and a build warning', () => {
  const { html, warnings } = render('::figure[Not captured]{src="assets/screenshots/nope.png"}');
  assert.match(html, /m-shot__missing" role="img" aria-label="Not captured"/);
  assert.match(html, /<span class="m-shot__bar" aria-hidden="true">/);
  assert.ok(warnings.includes('Missing asset: assets/screenshots/nope.png'));
});

test('role matrix renders words next to icons, never colour only', () => {
  const { html } = render(':::role-matrix Purchasing\n| Task | admin | manager | bartender | viewer |\n| --- | --- | --- | --- | --- |\n| Create | yes | yes | no | view |\n| Edit | yes | limited (own venue) | own | — |\n:::');
  assert.match(html, /<table class="m-table m-table--matrix m-table--rowheads"><caption>Purchasing<\/caption>/);
  assert.match(html, /<th scope="col"><span class="m-role m-role--viewer">Viewer<\/span><\/th>/);
  for (const word of ['Yes', 'No', 'View only', 'Limited', 'Own only']) assert.match(html, new RegExp(`<span>${word}</span>`), word);
  assert.match(html, /<span class="m-perm__note">own venue<\/span>/);
});

test('prompt cards, quick reference, glossary and chapter opener', () => {
  const { html, headings } = render(':::chapter{number=4 art="assets/brand/atlas-bot.png" art-crop=left}\n# Atlas AI {#ai}\nAsk in plain language.\n:::\n\n:::prompts Try asking\n- What is below par? — Checks par.\n- "Who works Friday?"\n:::\n\n:::quick-ref Shortcuts\n| Do | Where |\n| --- | --- |\n| Search | :kbd[Ctrl K] |\n:::\n\n:::glossary\nPar level\n: Wanted on hand.\n:::');
  assert.match(html, /<section class="m-chapter m-chapter--art">/);
  assert.match(html, /<span class="m-chapter__num" aria-hidden="true">04<\/span>/);
  assert.match(html, /<h1 id="ai" class="m-chapter__title">Atlas AI<\/h1>/);
  assert.match(html, /<img src="assets\/brand\/atlas-bot.png" alt="" role="presentation">/);
  assert.deepEqual(headings[0], { level: 1, id: 'ai', html: 'Atlas AI', plain: 'Atlas AI', chapter: '4' });
  assert.match(html, /<p class="m-prompt__q">“What is below par\?”<\/p><p class="m-prompt__hint">Checks par.<\/p>/);
  assert.match(html, /<p class="m-prompt__q">“Who works Friday\?”<\/p><\/li>/);
  assert.match(html, /<section class="m-quickref">.*Shortcuts<\/p>.*m-table--compact/s);
  assert.match(html, /<kbd class="m-kbd">Ctrl K<\/kbd>/);
  assert.match(html, /<dl class="m-glossary">\n<div class="m-glossary__entry"><dt id="term-par-level">Par level<\/dt><dd>Wanted on hand.<\/dd><\/div>/);
});

test('table of contents lists chapters (and sections at depth 2) with page slots', () => {
  const { html } = render('::toc{depth=2}\n\n:::chapter{number=1}\n# One\n:::\n\n## Sub {.no-toc}\n\n## Shown\n\n# Appendix');
  assert.match(html, /<nav class="m-toc" aria-label="Contents">/);
  assert.match(html, /<li class="m-toc__item m-toc__item--1"><a href="#one"><span class="m-toc__num">01<\/span><span class="m-toc__text">One<\/span>.*data-toc-page="one"><\/span><\/a><\/li>/);
  assert.match(html, /m-toc__item--2"><a href="#shown">/);
  assert.doesNotMatch(html, /href="#sub"/);
  assert.match(html, /m-toc__item--1"><a href="#appendix"><span class="m-toc__num"><\/span>/);
});

test('inline directives: icon, ui label, path, kbd, badge; unknown stays text', () => {
  const html = createRenderer({ root: MANUAL }).inline(':icon[house] :ui[Save]{icon=check} :path[Inventory > Stock count] :badge[New]{tone=new} :nope[x] time 10:30[a]');
  assert.match(html, /^<svg class="m-icon m-icon--inline"/);
  assert.match(html, /<span class="m-ui"><svg class="m-icon m-icon--inline"[^]*<\/svg>Save<\/span>/);
  assert.match(html, /<span class="m-path"><span class="m-path__step">Inventory<\/span><svg[^]*<span class="m-path__step">Stock count<\/span><\/span>/);
  assert.match(html, /<span class="m-badge m-badge--new">New<\/span>/);
  assert.match(html, /:nope\[x\] time 10:30\[a\]/);
});

test('unknown directives and unclosed containers are reported, not dropped', () => {
  const { html, warnings } = render(':::mystery\nstill shown\n:::\n\n:::tip\nnever closed');
  assert.match(html, /still shown/);
  assert.match(html, /never closed/);
  assert.ok(warnings.includes('Unknown directive :::mystery'));
  assert.ok(warnings.includes(':::tip is not closed'));
});

// ---------------------------------------------------------------- includes and document

test('includes pull a section by id or every section with a tag', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'manual-'));
  try {
    writeFileSync(path.join(dir, 'Master.md'), '---\ntitle: M\n---\n:::chapter{number=1}\n# Chapter\n:::\n\n## Keep {#keep .quick}\nA\n\n### Child\nB\n\n## Skip\nC\n\n```\n## Not a heading {.quick}\n```\n\n:::tip{#tip-id .quick}\nD\n:::\n\n:::chapter{number=2}\n# Next\n:::\n\n## Last {.quick}\nE\n');
    const read = (p) => readFileSync(p, 'utf8');
    const byId = resolveIncludes('::include{from="Master.md#keep" shift=1}', { baseDir: dir, readFile: read, file: path.join(dir, 'Quick.md') });
    assert.equal(byId.trim(), '### Keep {#keep .quick}\nA\n\n#### Child\nB');
    const tagged = resolveIncludes('::include{from="Master.md" tag=quick}', { baseDir: dir, readFile: read, file: path.join(dir, 'Quick.md') });
    assert.match(tagged, /## Keep[^]*### Child[^]*:::tip\{#tip-id \.quick\}\nD\n:::[^]*## Last \{\.quick\}\nE/);
    assert.doesNotMatch(tagged, /Skip|Not a heading|# Next/);
    assert.throws(() => resolveIncludes('::include{from="Master.md#missing"}', { baseDir: dir, readFile: read, file: path.join(dir, 'Q.md') }), /no section #missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('include cycles are refused', () => {
  const files = { '/m/A.md': '::include{from="B.md"}', '/m/B.md': '::include{from="A.md"}' };
  assert.throws(() => resolveIncludes(files['/m/A.md'], { baseDir: '/m', readFile: (p) => files[p], file: '/m/A.md' }), /include cycle/);
});

test('front matter, cover and the standalone document shell', () => {
  const { data, body } = parseFrontmatter('---\ntitle: User Guide\nversion: "Atlas · 0.8"\n---\n# Hi');
  assert.deepEqual(data, { title: 'User Guide', version: 'Atlas · 0.8' });
  assert.equal(body, '# Hi');
  const r = createRenderer({ root: MANUAL, outDir: MANUAL });
  const doc = r.renderDocument('---\ntitle: User Guide\nsubtitle: Restaurant & Hospitality Operating System\ntagline: Everything your team needs to run the venue.\nversion: Atlas User Guide · Version 0.8\nfooter: Foot "quoted"\n---\n# One');
  assert.match(doc.body, /<section class="m-cover m-cover--full" aria-label="Cover">/);
  assert.match(doc.body, /<img class="m-cover__logo" src="assets\/brand\/Atlas_Primary_Horizontal_Midnight.svg" alt="Atlas">/);
  assert.match(doc.body, /Restaurant &amp; Hospitality Operating System/);
  const html = htmlDocument({ ...doc, outDir: MANUAL, kind: 'user' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<link rel="stylesheet" href="theme\/manual.css">/);
  assert.match(html, /@bottom-left \{ content: "Foot \\"quoted\\""; \}/);
  const nested = htmlDocument({ ...doc, outDir: path.join(MANUAL, 'tools'), kind: 'quick' });
  assert.match(nested, /href="..\/theme\/manual.css"/);
  assert.match(nested, /class="m-doc m-doc--quick" data-chapter-start="page"/);
});

test('asset paths are rewritten relative to the output folder', () => {
  const r = createRenderer({ root: MANUAL, outDir: path.join(MANUAL, 'tools') });
  assert.equal(r.resolveAsset('assets/brand/atlas-bot.png').href, '../assets/brand/atlas-bot.png');
  assert.equal(r.resolveAsset('https://example.com/x.png').href, 'https://example.com/x.png');
});

test('stripInline and parseBlocks basics', () => {
  assert.equal(stripInline('**Bold** [link](x) :ui[Save] `code`'), 'Bold link Save code');
  const blocks = parseBlocks(':::tip Title {.x}\nbody\n:::\n::toc{depth=2}');
  assert.equal(blocks[0].type, 'container');
  assert.equal(blocks[0].label, 'Title');
  assert.deepEqual(blocks[0].attrs.classes, ['x']);
  assert.deepEqual(blocks[1], { type: 'leaf', name: 'toc', label: '', attrs: { classes: [], depth: '2' } });
});

test('PDF named destinations map to 1-based page numbers', () => {
  const pdf = [
    '%PDF-1.7',
    '1 0 obj <</Type /Catalog /Pages 2 0 R /Dests 9 0 R>> endobj',
    '2 0 obj <</Type /Pages /Kids [3 0 R 4 0 R] /Count 3>> endobj',
    '3 0 obj <</Type /Page /Parent 2 0 R>> endobj',
    '4 0 obj <</Type /Pages /Kids [5 0 R] /Count 1>> endobj',
    '5 0 obj <</Type /Page /Parent 4 0 R>> endobj',
    '9 0 obj <</stock-count [5 0 R /XYZ 0 800 0] /caf#C3#A9 [3 0 R /XYZ 0 800 0]>> endobj',
    '%%EOF'
  ].join('\n');
  const { dests, pageCount } = namedDestinations(Buffer.from(pdf, 'latin1'));
  assert.equal(pageCount, 2);
  assert.equal(dests.get('stock-count'), 2);
  assert.equal(dests.get('cafÃ©'), 1);
});

// ---------------------------------------------------------------- The guides themselves

test('the guides render without warnings, name only captured screenshots and keep the robot to Atlas AI', () => {
  const manifest = JSON.parse(readFileSync(path.join(MANUAL, 'assets/screenshots/manifest.json'), 'utf8'));
  const captured = new Set(manifest.screenshots.map((entry) => entry.file));
  for (const file of ['Atlas_User_Guide.md', 'Atlas_Quick_Start_Guide.md']) {
    const source = readFileSync(path.join(MANUAL, file), 'utf8');
    const r = createRenderer({ root: MANUAL, outDir: MANUAL });
    const doc = r.renderDocument(source, { file: path.join(MANUAL, file) });
    assert.deepEqual(doc.warnings, [], `${file} renders without warnings`);
    const ids = [...doc.body.matchAll(/<h[1-6][^>]* id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${file} has unique heading ids`);
    for (const [, shot] of doc.body.matchAll(/assets\/screenshots\/([\w-]+\.png)/g)) assert.ok(captured.has(shot), `${file}: ${shot} is in manifest.json`);
    assert.doesNotMatch(source, /PENDING:/);
    const robot = [...source.matchAll(/:::chapter\{[^}]*art="assets\/brand\/atlas-bot\.png"[^}]*\}\n# ([^{\n]+)/g)].map((m) => m[1].trim());
    robot.forEach((title) => assert.match(title, /^Atlas AI/, `${file}: the robot art only opens an Atlas AI chapter`));
    assert.equal(count(source, /atlas-bot\.png/g), robot.length, `${file}: the robot appears only as chapter art`);
  }
});
