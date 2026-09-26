// Renders manual Markdown (markdown.mjs) with the Atlas manual components into
// an HTML document. Pure apart from reading icon/diagram/asset files through
// the injected `fs`-like helpers, so tests can run it on strings.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { escapeHtml, parseBlocks, parseFrontmatter, renderInline, slugify, stripInline } from './markdown.mjs';
import { resolveIncludes } from './include.mjs';

export const ROLE_LABELS = {
  admin: 'Administrator',
  manager: 'Manager',
  bartender: 'Bartender',
  viewer: 'Viewer',
  schedule_only: 'Schedule only',
  owner: 'Owner',
  everyone: 'Everyone'
};

export const CALLOUTS = {
  tip: { label: 'Tip', icon: 'lightbulb' },
  note: { label: 'Note', icon: 'info' },
  important: { label: 'Important', icon: 'circle-alert' },
  warning: { label: 'Warning', icon: 'triangle-alert' },
  'admin-only': { label: 'Administrators only', icon: 'shield-check', roles: 'admin' },
  roles: { label: 'Available to', icon: 'users' },
  ai: { label: 'Atlas AI', icon: 'atlas-bot' },
  example: { label: 'Example', icon: 'file-text' },
  'coming-later': { label: 'Coming in a later release', icon: 'hourglass' }
};
const CALLOUT_ALIASES = { admin: 'admin-only', 'atlas-ai': 'ai', later: 'coming-later' };

// Role-matrix cell words -> accessible label (text is always shown, never colour only).
const PERMS = [
  { re: /^(yes|y|✓|✔|full|allowed)\b/i, cls: 'yes', icon: 'check', text: 'Yes' },
  { re: /^(no|n|✗|✕|-|—|none)(?=\s|$)/i, cls: 'no', icon: 'minus', text: 'No' },
  { re: /^(view|view only|read|read only)\b/i, cls: 'view', icon: 'eye', text: 'View only' },
  { re: /^(own|own only)\b/i, cls: 'limited', icon: 'user', text: 'Own only' },
  { re: /^(limited|partial|some)\b/i, cls: 'limited', icon: 'circle-alert', text: 'Limited' }
];

const DEVICE_LABEL = { desktop: 'Desktop', phone: 'Phone', tablet: 'Tablet' };

function toPosix(p) { return p.split(path.sep).join('/'); }
function encodePath(p) { return toPosix(p).split('/').map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg))).join('/'); }
const pad2 = (n) => String(n).padStart(2, '0');

/** Splits "Title — description" (em dash or double hyphen, spaced). */
function splitDash(text) {
  const m = String(text).match(/^(.*?)\s+(?:—|--)\s+([\s\S]*)$/);
  return m ? [m[1], m[2]] : [text, ''];
}

function roleKeys(value) {
  return String(value || '').split(/[\s,]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);
}

export function createRenderer(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const outDir = path.resolve(options.outDir || root);
  const assetRoots = [root, ...(options.assetRoots || []).map((p) => path.resolve(p))];
  const iconsDir = options.iconsDir || path.join(root, 'assets/icons');
  const warnings = [];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const iconCache = new Map();
  const ids = new Map();
  const headings = [];
  let figureCount = 0;
  const tocRequests = [];

  function uniqueId(base) {
    const id = base || 'section';
    const n = ids.get(id) || 0;
    ids.set(id, n + 1);
    return n ? `${id}-${n + 1}` : id;
  }

  function icon(name, cls = '') {
    const key = String(name || '').toLowerCase();
    if (!key) return '';
    // 'atlas-bot' is the Atlas AI robot badge, as the app shows it wherever
    // the assistant is the symbol (assets/brand/atlas-bot-small.png, a copy of
    // apps/web/assets/atlas-bot/atlas-bot-small.png; its first frame).
    if (key === 'atlas-bot') {
      const sprite = resolveAsset('assets/brand/atlas-bot-small.png');
      return `<span class="m-icon m-bot${cls ? ` ${cls}` : ''}" aria-hidden="true" style="background-image:url('${escapeHtml(sprite.href)}')"></span>`;
    }
    if (!iconCache.has(key)) {
      const file = path.join(iconsDir, `${key}.svg`);
      if (!/^[a-z0-9-]+$/.test(key) || !existsSync(file)) { warn(`Unknown icon "${key}" (add it to tools/extract_icons.mjs)`); iconCache.set(key, ''); }
      else iconCache.set(key, readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim());
    }
    const svg = iconCache.get(key);
    if (!svg) return '';
    return svg.replace('<svg ', `<svg class="m-icon${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false" `);
  }

  /** Resolves a manual-relative asset path to an href relative to the output file. */
  function resolveAsset(src) {
    const s = String(src || '');
    if (!s || /^(https?:|data:|#)/i.test(s)) return { href: s, exists: true, abs: null };
    const clean = decodeURI(s.split(/[?#]/)[0]);
    for (const base of assetRoots) {
      const abs = path.resolve(base, clean);
      if (existsSync(abs)) return { href: encodePath(path.relative(outDir, abs)) || '.', exists: true, abs };
    }
    warn(`Missing asset: ${s}`);
    return { href: encodePath(path.relative(outDir, path.resolve(root, clean))), exists: false, abs: null };
  }

  function roleBadge(key) {
    const k = String(key).toLowerCase();
    const label = ROLE_LABELS[k] || k.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    return `<span class="m-role m-role--${escapeHtml(slugify(k))}">${escapeHtml(label)}</span>`;
  }

  const inlineCtx = {
    resolveAsset,
    inlineDirective(name, content, attrs) {
      switch (name) {
        case 'icon': return icon(content.trim(), 'm-icon--inline');
        case 'role': return roleKeys(content).map(roleBadge).join(' ');
        case 'kbd': return `<kbd class="m-kbd">${escapeHtml(content)}</kbd>`;
        case 'ui': return `<span class="m-ui">${attrs.icon ? icon(attrs.icon, 'm-icon--inline') : ''}${escapeHtml(content)}</span>`;
        case 'badge': return `<span class="m-badge${attrs.tone ? ` m-badge--${escapeHtml(slugify(attrs.tone))}` : ''}">${escapeHtml(content)}</span>`;
        case 'path':
        case 'nav': {
          const parts = content.split(/\s*(?:>|›|→)\s*/).filter(Boolean);
          const chevron = icon('chevron-right', 'm-path__sep');
          return `<span class="m-path">${parts.map((p) => `<span class="m-path__step">${escapeHtml(p)}</span>`).join(chevron)}</span>`;
        }
        default: return null; // leave unknown :name[...] as text
      }
    }
  };
  const inline = (text) => renderInline(text, inlineCtx);

  // ------------------------------------------------------------ blocks

  function renderBlocks(blocks, ctx = {}) {
    return blocks.map((b) => renderBlock(b, ctx)).join('\n');
  }

  function renderBlock(block, ctx) {
    switch (block.type) {
      case 'heading': return renderHeading(block, ctx);
      case 'paragraph': return renderParagraph(block);
      case 'list': return renderList(block);
      case 'table': return renderTable(block, ctx);
      case 'blockquote': return `<blockquote class="m-quote">${renderBlocks(block.blocks, ctx)}</blockquote>`;
      case 'hr': return '<hr class="m-rule">';
      case 'code': return `<pre class="m-code"><code>${escapeHtml(block.text)}</code></pre>`;
      case 'deflist': return renderDeflist(block, ctx);
      case 'container': return renderContainer(block, ctx);
      case 'leaf': return renderLeaf(block, ctx);
      default: return '';
    }
  }

  function renderParagraph(block) {
    // A paragraph that is only an image becomes a plain figure.
    const img = block.text.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (img) return renderFigure({ src: img[2], caption: img[1], device: 'none' });
    return `<p>${inline(block.text)}</p>`;
  }

  function renderHeading(block, ctx) {
    const plain = stripInline(block.text);
    const id = uniqueId(block.attrs.id || slugify(plain));
    const level = block.level;
    const classes = [...block.attrs.classes.filter((c) => /^[\w-]+$/.test(c))];
    if (ctx.chapter && level === 1) classes.push('m-chapter__title');
    if (!classes.includes('no-toc') && !ctx.noToc) {
      headings.push({ level, id, html: inline(block.text), plain, chapter: ctx.chapter && level === 1 ? ctx.chapter : null });
    }
    const cls = classes.length ? ` class="${escapeHtml(classes.join(' '))}"` : '';
    let html = `<h${level} id="${escapeHtml(id)}"${cls}>${inline(block.text)}</h${level}>`;
    if (block.attrs.roles) html += renderRoleLine(block.attrs.roles);
    return html;
  }

  function renderRoleLine(roles, label = 'Available to') {
    return `<p class="m-roleline"><span class="m-roleline__label">${icon('users')}${escapeHtml(label)}</span> ${roleKeys(roles).map(roleBadge).join(' ')}</p>`;
  }

  /** List item content: a lone first paragraph renders without <p> in tight lists. */
  function renderItem(item, loose) {
    const [first, ...rest] = item.blocks;
    if (!loose && first && first.type === 'paragraph') return inline(first.text) + (rest.length ? '\n' + renderBlocks(rest) : '');
    return renderBlocks(item.blocks);
  }

  function renderList(block, cls = 'm-list') {
    const tag = block.ordered ? 'ol' : 'ul';
    const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
    const items = block.items.map((item) => `<li>${renderItem(item, block.loose)}</li>`).join('\n');
    return `<${tag} class="${cls}${block.loose ? ' m-list--loose' : ''}"${start}>\n${items}\n</${tag}>`;
  }

  function renderTable(block, ctx = {}, extra = {}) {
    const alignAttr = (k) => (block.align[k] ? ` class="m-align-${block.align[k]}"` : '');
    const headCell = extra.headCell || ((cell) => inline(cell));
    const bodyCell = extra.bodyCell || ((cell) => inline(cell));
    const head = `<thead><tr>${block.header.map((cell, k) => `<th scope="col"${alignAttr(k)}>${headCell(cell, k)}</th>`).join('')}</tr></thead>`;
    const rows = block.rows.map((row) => `<tr>${block.header.map((_, k) => {
      const cell = row[k] ?? '';
      return k === 0 && extra.rowHeaders !== false
        ? `<th scope="row"${alignAttr(k)}>${inline(cell)}</th>`
        : `<td${alignAttr(k)}>${bodyCell(cell, k)}</td>`;
    }).join('')}</tr>`).join('\n');
    const caption = extra.caption ? `<caption>${inline(extra.caption)}</caption>` : '';
    const cls = ['m-table', extra.cls].filter(Boolean).join(' ');
    const rowHead = extra.rowHeaders === false ? '' : ' m-table--rowheads';
    return `<div class="m-table-wrap"><table class="${cls}${rowHead}">${caption}${head}<tbody>\n${rows}\n</tbody></table></div>`;
  }

  function renderDeflist(block, ctx = {}) {
    const cls = ctx.glossary ? 'm-glossary' : 'm-deflist';
    const items = block.items.map(({ term, attrs, defs }) => {
      const id = ctx.glossary ? ` id="${escapeHtml(uniqueId(attrs.id || `term-${slugify(stripInline(term))}`))}"` : '';
      return `<div class="${cls}__entry"><dt${id}>${inline(term)}</dt>${defs.map((d) => `<dd>${inline(d)}</dd>`).join('')}</div>`;
    }).join('\n');
    return `<dl class="${cls}">\n${items}\n</dl>`;
  }

  // ------------------------------------------------------------ components

  function renderCallout(kind, block, ctx) {
    const def = CALLOUTS[kind];
    const roles = block.attrs.roles || def.roles;
    const labelText = block.attrs.label || def.label;
    const title = block.label ? `<p class="m-callout__title">${inline(block.label)}</p>` : '';
    const roleBadges = roles && kind !== 'admin-only' ? `<span class="m-callout__roles">${roleKeys(roles).map(roleBadge).join(' ')}</span>` : '';
    return `<aside class="m-callout m-callout--${kind}" role="note" aria-label="${escapeHtml(labelText)}">
<div class="m-callout__icon">${icon(block.attrs.icon || def.icon)}</div>
<div class="m-callout__body"><p class="m-callout__label">${escapeHtml(labelText)}${roleBadges}</p>${title}
${renderBlocks(block.blocks, ctx)}</div>
</aside>`;
  }

  function firstList(blocks) {
    return blocks.find((b) => b.type === 'list');
  }

  function renderWorkflow(block, ctx) {
    const list = firstList(block.blocks);
    if (!list) { warn('workflow: expected a list of steps'); return renderBlocks(block.blocks, ctx); }
    const steps = list.items.map((item, k) => {
      const [first, ...rest] = item.blocks;
      let title = '';
      let desc = '';
      if (first && first.type === 'paragraph') [title, desc] = splitDash(first.text);
      const more = renderBlocks(first && first.type === 'paragraph' ? rest : item.blocks, ctx);
      return `<li class="m-workflow__step"><span class="m-workflow__num" aria-hidden="true">${k + 1}</span>
<div class="m-workflow__text"><p class="m-workflow__title">${inline(title)}</p>${desc ? `<p class="m-workflow__desc">${inline(desc)}</p>` : ''}${more}</div></li>`;
    }).join('\n');
    const count = list.items.length;
    const layout = block.attrs.layout || (count <= 5 ? 'horizontal' : 'vertical');
    const before = renderBlocks(block.blocks.slice(0, block.blocks.indexOf(list)), ctx);
    const after = renderBlocks(block.blocks.slice(block.blocks.indexOf(list) + 1), ctx);
    const title = block.label ? `<p class="m-workflow__heading">${icon(block.attrs.icon || 'workflow')}${inline(block.label)}</p>` : '';
    return `<div class="m-workflow m-workflow--${escapeHtml(layout)}" style="--steps:${count}">${title}${before}
<ol class="m-workflow__steps">\n${steps}\n</ol>${after}</div>`;
  }

  function renderDoDont(block, ctx) {
    const parts = block.blocks.map((child) => {
      if (child.type !== 'container' || !['do', 'dont', "don't"].includes(child.name)) {
        return renderBlock(child, ctx);
      }
      const isDo = child.name === 'do';
      const label = child.label ? inline(child.label) : isDo ? 'Do' : 'Don’t';
      const body = child.blocks.map((b) => (b.type === 'list' ? renderList(b, `m-list m-list--${isDo ? 'do' : 'dont'}`) : renderBlock(b, ctx))).join('\n');
      return `<div class="m-dodont__card m-dodont__card--${isDo ? 'do' : 'dont'}">
<p class="m-dodont__label">${icon(isDo ? 'check' : 'x')}<span>${label}</span></p>${body}</div>`;
    }).join('\n');
    return `<div class="m-dodont">${parts}</div>`;
  }

  function renderCards(block, ctx) {
    const intro = [];
    const cards = [];
    for (const b of block.blocks) {
      if (b.type === 'heading') cards.push({ heading: b, body: [] });
      else if (cards.length) cards[cards.length - 1].body.push(b);
      else intro.push(b);
    }
    const cols = parseInt(block.attrs.cols, 10) || (cards.length % 3 === 0 || cards.length > 4 ? 3 : 2);
    const html = cards.map(({ heading, body }) => {
      const ic = heading.attrs.icon ? `<span class="m-card__icon">${icon(heading.attrs.icon)}</span>` : '';
      const roles = heading.attrs.roles ? `<p class="m-card__roles">${roleKeys(heading.attrs.roles).map(roleBadge).join(' ')}</p>` : '';
      const level = Math.min(6, Math.max(3, heading.level));
      return `<div class="m-card">${ic}<h${level} class="m-card__title">${inline(heading.text)}</h${level}>${roles}${renderBlocks(body, ctx)}</div>`;
    }).join('\n');
    return `${renderBlocks(intro, ctx)}<div class="m-cards m-cards--${cols}">\n${html}\n</div>`;
  }

  function renderPrompts(block, ctx) {
    const list = firstList(block.blocks);
    if (!list) { warn('prompts: expected a list of questions'); return ''; }
    const cols = parseInt(block.attrs.cols, 10) || 2;
    const title = block.label ? `<p class="m-prompts__title">${icon('atlas-bot')}${inline(block.label)}</p>` : '';
    const items = list.items.map((item) => {
      const first = item.blocks[0];
      const [q, hint] = splitDash(first && first.type === 'paragraph' ? first.text : '');
      const question = q.replace(/^["“”]+|["“”]+$/g, '');
      return `<li class="m-prompt"><span class="m-prompt__icon">${icon('atlas-bot')}</span><p class="m-prompt__q">“${inline(question)}”</p>${hint ? `<p class="m-prompt__hint">${inline(hint)}</p>` : ''}</li>`;
    }).join('\n');
    return `<div class="m-prompts">${title}<ul class="m-prompts__grid m-prompts__grid--${cols}" aria-label="Example questions for Atlas AI">\n${items}\n</ul></div>`;
  }

  function renderRoleMatrix(block, ctx) {
    const table = block.blocks.find((b) => b.type === 'table');
    if (!table) { warn('role-matrix: expected a table'); return ''; }
    const note = renderBlocks(block.blocks.filter((b) => b !== table), ctx);
    return renderTable(table, ctx, {
      cls: 'm-table--matrix',
      caption: block.label || '',
      headCell: (cell, k) => (k === 0 ? inline(cell) : ROLE_LABELS[cell.trim().toLowerCase()] ? roleBadge(cell.trim()) : inline(cell)),
      bodyCell: (cell) => {
        const text = cell.trim();
        for (const p of PERMS) {
          const m = text.match(p.re);
          if (m) {
            const rest = text.slice(m[0].length).replace(/^[\s,;:(-]+|\)$/g, '').trim();
            return `<span class="m-perm m-perm--${p.cls}">${icon(p.icon)}<span>${p.text}</span></span>${rest ? `<span class="m-perm__note">${inline(rest)}</span>` : ''}`;
          }
        }
        return inline(text);
      }
    }) + note;
  }

  function renderQuickRef(block, ctx) {
    const title = block.label ? `<p class="m-quickref__title">${icon(block.attrs.icon || 'list-checks')}${inline(block.label)}</p>` : '';
    const body = block.blocks.map((b) => (b.type === 'table' ? renderTable(b, ctx, { cls: 'm-table--compact' }) : renderBlock(b, ctx))).join('\n');
    return `<section class="m-quickref"${block.attrs.id ? ` id="${escapeHtml(uniqueId(block.attrs.id))}"` : ''}>${title}${body}</section>`;
  }

  function renderChapter(block, ctx) {
    const number = block.attrs.number ?? '';
    const art = block.attrs.art ? resolveAsset(block.attrs.art) : null;
    const crop = block.attrs['art-crop'] ? ` m-chapter__art--crop-${escapeHtml(slugify(block.attrs['art-crop']))}` : '';
    const inner = renderBlocks(block.blocks, { ...ctx, chapter: number || true });
    const eyebrow = block.attrs.eyebrow || (number !== '' ? `Chapter ${number}` : '');
    const ic = block.attrs.icon ? `<span class="m-chapter__icon">${icon(block.attrs.icon)}</span>` : '';
    return `<section class="m-chapter${art ? ' m-chapter--art' : ''}"${block.attrs.id ? ` id="${escapeHtml(uniqueId(block.attrs.id))}"` : ''}>
<div class="m-chapter__head">${number !== '' ? `<span class="m-chapter__num" aria-hidden="true">${escapeHtml(/^\d+$/.test(number) ? pad2(number) : number)}</span>` : ''}
<p class="m-chapter__eyebrow">${ic}${escapeHtml(eyebrow)}</p></div>
<div class="m-chapter__body">${inner}</div>
${art ? `<div class="m-chapter__art${crop}"><img src="${escapeHtml(art.href)}" alt="" role="presentation"></div>` : ''}
</section>`;
  }

  function renderFigure({ src, caption = '', alt = '', device = 'desktop', width = '', markers = [], extra = '', id = '', cls = '' }) {
    figureCount++;
    const asset = resolveAsset(src);
    const deviceKey = ['desktop', 'phone', 'tablet', 'none', 'diagram'].includes(device) ? device : 'desktop';
    const altText = alt || stripInline(caption) || `Screenshot ${figureCount}`;
    const style = width ? ` style="--fig-width:${escapeHtml(/^\d+$/.test(width) ? `${width}px` : width)}"` : '';
    const dots = markers.map((m, k) => `<span class="m-marker" style="left:${m.x}%;top:${m.y}%" aria-hidden="true">${k + 1}</span>`).join('');
    const image = asset.exists
      ? `<img src="${escapeHtml(asset.href)}" alt="${escapeHtml(altText)}">`
      : `<div class="m-shot__missing" role="img" aria-label="${escapeHtml(altText)}">${icon('image')}<span>Screenshot pending</span><code>${escapeHtml(src)}</code></div>`;
    const chrome = deviceKey === 'desktop' ? '<span class="m-shot__bar" aria-hidden="true"><i></i><i></i><i></i></span>' : '';
    const legend = markers.length
      ? `<ol class="m-legend">${markers.map((m, k) => `<li><span class="m-legend__num" aria-hidden="true">${k + 1}</span><span class="m-legend__text"><span class="m-sr">Marker ${k + 1}: </span>${inline(m.text)}</span></li>`).join('')}</ol>`
      : '';
    const label = DEVICE_LABEL[deviceKey] ? `<span class="m-figure__device">${icon(deviceKey === 'phone' ? 'smartphone' : 'monitor')}${DEVICE_LABEL[deviceKey]}</span>` : '';
    const cap = caption || legend || extra
      ? `<figcaption class="m-figure__caption">${caption ? `<p class="m-figure__text">${label}${inline(caption)}</p>` : ''}${extra}${legend}</figcaption>`
      : '';
    return `<figure class="m-figure m-figure--${deviceKey}${cls ? ` ${cls}` : ''}"${id ? ` id="${escapeHtml(uniqueId(id))}"` : ''}${style}>
<div class="m-shot m-shot--${deviceKey}">${chrome}<div class="m-shot__screen">${image}${dots}</div></div>
${cap}</figure>`;
  }

  function figureFromBlock(block, ctx) {
    const markers = [];
    const extra = [];
    for (const b of block.blocks || []) {
      if (b.type === 'list') {
        for (const item of b.items) {
          const text = item.blocks[0] && item.blocks[0].type === 'paragraph' ? item.blocks[0].text : '';
          const m = text.match(/^\[?\s*(\d+(?:\.\d+)?)\s*%?\s*,\s*(\d+(?:\.\d+)?)\s*%?\s*\]?\s+([\s\S]+)$/);
          if (m) markers.push({ x: Math.min(100, +m[1]), y: Math.min(100, +m[2]), text: m[3] });
          else warn(`figure ${block.attrs.src}: marker "${text.slice(0, 40)}" needs "[x%, y%] text"`);
        }
      } else extra.push(renderBlock(b, ctx));
    }
    if (!block.attrs.src) { warn('figure without src'); return ''; }
    return renderFigure({
      src: block.attrs.src,
      caption: block.attrs.caption || block.label || '',
      alt: block.attrs.alt || '',
      device: block.attrs.device || (block.name === 'diagram' ? 'diagram' : 'desktop'),
      width: block.attrs.width || '',
      markers,
      extra: extra.join('\n'),
      id: block.attrs.id || '',
      cls: block.attrs.classes.join(' ')
    });
  }

  function renderDiagram(block) {
    const src = block.attrs.src;
    const asset = resolveAsset(src);
    const caption = block.attrs.caption || block.label || '';
    const alt = block.attrs.alt || stripInline(caption) || 'Diagram';
    if (!asset.exists || block.attrs.inline === 'false' || !/\.svg$/i.test(src)) {
      return figureFromBlock({ ...block, attrs: { ...block.attrs, device: 'diagram' }, name: 'diagram' });
    }
    // Inline SVG: text stays real text (selectable and searchable in the PDF).
    const svg = readFileSync(asset.abs, 'utf8')
      .replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<svg\b/, `<svg role="img" aria-label="${escapeHtml(alt)}"`).trim();
    const width = block.attrs.width ? ` style="--fig-width:${escapeHtml(block.attrs.width)}"` : '';
    return `<figure class="m-figure m-figure--diagram"${width}><div class="m-diagram">${svg}</div>${caption ? `<figcaption class="m-figure__caption"><p class="m-figure__text">${inline(caption)}</p></figcaption>` : ''}</figure>`;
  }

  function renderContainer(block, ctx) {
    if (block.unclosed) warn(`:::${block.name} is not closed`);
    const kind = CALLOUT_ALIASES[block.name] || block.name;
    if (CALLOUTS[kind]) return renderCallout(kind, block, ctx);
    switch (kind) {
      case 'workflow': return renderWorkflow(block, ctx);
      case 'do-dont': return renderDoDont(block, ctx);
      case 'do': case 'dont': return renderDoDont({ ...block, blocks: [block] }, ctx);
      case 'cards': return renderCards(block, ctx);
      case 'prompts': return renderPrompts(block, ctx);
      case 'role-matrix': return renderRoleMatrix(block, ctx);
      case 'quick-ref': return renderQuickRef(block, ctx);
      case 'glossary': return `<div class="m-glossary-wrap">${block.label ? `<p class="m-glossary__title">${inline(block.label)}</p>` : ''}${renderBlocks(block.blocks, { ...ctx, glossary: true })}</div>`;
      case 'chapter': return renderChapter(block, ctx);
      case 'figure': return figureFromBlock(block, ctx);
      case 'diagram': return renderDiagram(block);
      case 'figures': {
        const caption = block.label ? `<p class="m-figure-row__caption">${inline(block.label)}</p>` : '';
        return `<div class="m-figure-row">${renderBlocks(block.blocks, ctx)}</div>${caption}`;
      }
      case 'section': {
        const id = block.attrs.id ? ` id="${escapeHtml(uniqueId(block.attrs.id))}"` : '';
        return `<section class="m-section"${id}>${renderBlocks(block.blocks, ctx)}</section>`;
      }
      case 'columns': return `<div class="m-columns">${renderBlocks(block.blocks, ctx)}</div>`;
      case 'keep': return `<div class="m-keep">${renderBlocks(block.blocks, ctx)}</div>`;
      default:
        warn(`Unknown directive :::${block.name}`);
        return `<div class="m-unknown">${renderBlocks(block.blocks, ctx)}</div>`;
    }
  }

  function renderLeaf(block, ctx) {
    switch (block.name) {
      case 'toc': tocRequests.push({ depth: parseInt(block.attrs.depth || '1', 10) || 1, title: block.label || 'Contents' }); return `<!--M-TOC:${tocRequests.length - 1}-->`;
      case 'pagebreak': return '<div class="m-pagebreak" aria-hidden="true"></div>';
      case 'figure': return figureFromBlock({ ...block, blocks: [] }, ctx);
      case 'diagram': return renderDiagram(block);
      case 'roles': return renderRoleLine(block.attrs.roles || block.label, block.attrs.label || 'Available to');
      case 'include': warn('::include was not resolved (render with a file path)'); return '';
      default: warn(`Unknown directive ::${block.name}`); return '';
    }
  }

  function renderToc(depth, title) {
    const items = headings.filter((h) => h.level <= depth).map((h) => {
      const num = h.chapter && h.chapter !== true ? `<span class="m-toc__num">${escapeHtml(/^\d+$/.test(h.chapter) ? pad2(h.chapter) : h.chapter)}</span>` : '<span class="m-toc__num"></span>';
      return `<li class="m-toc__item m-toc__item--${h.level}"><a href="#${escapeHtml(h.id)}">${num}<span class="m-toc__text">${h.html}</span><span class="m-toc__dots" aria-hidden="true"></span><span class="m-toc__page" data-toc-page="${escapeHtml(h.id)}"></span></a></li>`;
    }).join('\n');
    return `<nav class="m-toc" aria-label="${escapeHtml(title)}"><h2 class="m-toc__title no-toc">${escapeHtml(title)}</h2><ol class="m-toc__list">\n${items}\n</ol></nav>`;
  }

  function renderCover(fm) {
    const kind = fm.cover || 'full';
    if (kind === 'none') return '';
    const logo = resolveAsset(fm.logo || 'assets/brand/Atlas_Primary_Horizontal_Midnight.svg');
    const line = (cls, value) => (value ? `<p class="${cls}">${inline(value)}</p>` : '');
    return `<section class="m-cover m-cover--${escapeHtml(kind)}" aria-label="Cover">
<div class="m-cover__top"><img class="m-cover__logo" src="${escapeHtml(logo.href)}" alt="Atlas"></div>
<div class="m-cover__main">${line('m-cover__eyebrow', fm.subtitle)}<h1 class="m-cover__title">${inline(fm.title || 'User Guide')}</h1>${line('m-cover__tagline', fm.tagline)}</div>
<div class="m-cover__foot">${line('m-cover__version', fm.version)}${line('m-cover__release', fm.release)}</div>
</section>`;
  }

  /** Renders a whole source file. Returns { body, frontmatter, headings, warnings }. */
  function renderDocument(source, { file = null, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
    const { data, body } = parseFrontmatter(source);
    const expanded = file ? resolveIncludes(body, { baseDir: path.dirname(file), readFile, file }) : body;
    const blocks = parseBlocks(expanded);
    let html = renderBlocks(blocks);
    html = html.replace(/<!--M-TOC:(\d+)-->/g, (_, k) => renderToc(tocRequests[k].depth, tocRequests[k].title));
    const cover = renderCover(data);
    return { body: `${cover}\n<main class="m-main">\n${html}\n</main>`, frontmatter: data, headings: headings.slice(), warnings };
  }

  return { renderDocument, renderBlocks: (src) => renderBlocks(parseBlocks(src)), inline, icon, resolveAsset, warnings, headings };
}
