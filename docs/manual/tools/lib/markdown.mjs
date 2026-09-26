// Atlas manual Markdown: a small, dependency-free Markdown subset plus the
// manual's component directives. See docs/manual/README.md for the syntax.
//
// Pipeline: parseFrontmatter() -> parseBlocks() (block tree) -> renderBlocks()
// (HTML, with components from components.mjs). Every piece of source text is
// HTML-escaped; raw HTML in the source is shown as text, never passed through.

// ---------------------------------------------------------------- helpers

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const TRANSLIT = { ð: 'd', þ: 'th', æ: 'ae', ø: 'o', ß: 'ss', œ: 'oe', đ: 'd', ł: 'l' };
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[ðþæøßœđł]/g, (c) => TRANSLIT[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/** Plain text of an inline Markdown string (for alt text, slugs, TOC). */
export function stripInline(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/:[a-z][\w-]*\[([^\]]*)\](\{[^}]*\})?/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim();
}

/** Parses `{#id .class key=value key="quoted value"}` (braces optional). */
export function parseAttrs(text) {
  const attrs = { classes: [] };
  if (!text) return attrs;
  const body = String(text).trim().replace(/^\{/, '').replace(/\}$/, '');
  const re = /\s*(?:#([\w-]+)|\.([\w-]+)|([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?)/gy;
  let m;
  while (re.lastIndex < body.length && (m = re.exec(body))) {
    if (m[0] === '') break;
    if (m[1]) attrs.id = m[1];
    else if (m[2]) attrs.classes.push(m[2]);
    else if (m[3]) attrs[m[3]] = m[4] ?? m[5] ?? m[6] ?? true;
  }
  return attrs;
}

/** Splits `text {attrs}` into [text, attrs]. */
function splitTrailingAttrs(text) {
  const m = String(text).match(/^(.*?)\s*\{([^{}]*)\}\s*$/);
  if (!m) return [String(text).trim(), parseAttrs('')];
  return [m[1].trim(), parseAttrs(m[2])];
}

// ---------------------------------------------------------------- front matter

/** `---\nkey: value\n---` at the top of a file. Values are plain strings. */
export function parseFrontmatter(source) {
  const text = String(source).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    data[kv[1]] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------- block patterns

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const RE_CONTAINER = /^\s{0,3}(:{3,})\s*([a-zA-Z][\w-]*)(.*)$/;
const RE_CONTAINER_CLOSE = /^\s{0,3}(:{3,})\s*$/;
const RE_LEAF = /^\s{0,3}::([a-zA-Z][\w-]*)(?:\[(.*?)\])?\s*(\{.*\})?\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?/;
const RE_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RE_DEF = /^:\s+(.*)$/;

const isBlank = (line) => /^\s*$/.test(line);
const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function matchItem(line) {
  const m = line.match(RE_ITEM);
  if (!m) return null;
  const indent = indentOf(m[1]);
  const ordered = /\d/.test(m[2]);
  // "- " followed by only spaces still counts; content indent is marker + gap
  const gap = Math.min(m[3].length, 4);
  return { indent, ordered, start: ordered ? parseInt(m[2], 10) : 1, contentIndent: indent + m[2].length + gap, text: m[4] };
}

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes('|') && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');
}

/** Does this line start a block that interrupts a paragraph? */
function startsBlock(lines, i) {
  const line = lines[i];
  return RE_FENCE.test(line) || RE_CONTAINER.test(line) || RE_LEAF.test(line) || RE_HEADING.test(line) ||
    RE_HR.test(line) || RE_QUOTE.test(line) || Boolean(matchItem(line)) || isTableStart(lines, i);
}

/** Index of the line that closes the container opened at `start` (colon count `n`). */
function findContainerEnd(lines, start, n) {
  let depth = 0;
  let fence = null;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    const f = line.match(RE_FENCE);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const open = line.match(RE_CONTAINER);
    if (open && open[1].length === n) { depth++; continue; }
    const close = line.match(RE_CONTAINER_CLOSE);
    if (close && close[1].length === n) {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

export function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  let inCode = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') inCode = inCode ? 0 : 1;
    if (c === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

// ---------------------------------------------------------------- block parser

/**
 * Parses Markdown lines into a block tree. Node types: heading, paragraph,
 * list, table, blockquote, hr, code, deflist, container (:::name), leaf (::name).
 */
export function parseBlocks(input) {
  const lines = Array.isArray(input) ? input : String(input).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;

    if ((m = line.match(RE_FENCE))) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(RE_FENCE);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !close[2]) { i++; break; }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang: m[2] || '', text: body.join('\n') });
      continue;
    }

    if ((m = line.match(RE_CONTAINER))) {
      const n = m[1].length;
      const end = findContainerEnd(lines, i, n);
      const inner = lines.slice(i + 1, end === -1 ? lines.length : end);
      let rest = m[3].trim();
      let label = '';
      let attrs;
      const bracket = rest.match(/^\[(.*?)\]\s*(\{.*\})?\s*$/);
      const leading = rest.match(/^\{([^{}]*)\}\s*(.*)$/);
      if (bracket) { label = bracket[1]; attrs = parseAttrs(bracket[2] || ''); }
      else if (leading) {
        // :::name{attrs} Label  (attributes first) — may also end in {more}
        const [text, more] = splitTrailingAttrs(leading[2]);
        attrs = parseAttrs(leading[1]);
        label = text;
        Object.assign(attrs, { ...more, classes: [...attrs.classes, ...more.classes], id: more.id || attrs.id });
        if (!attrs.id) delete attrs.id;
      } else [label, attrs] = splitTrailingAttrs(rest);
      blocks.push({ type: 'container', name: m[2].toLowerCase(), label, attrs, lines: inner, blocks: parseBlocks(inner), unclosed: end === -1 });
      i = end === -1 ? lines.length : end + 1;
      continue;
    }

    if ((m = line.match(RE_LEAF))) {
      blocks.push({ type: 'leaf', name: m[1].toLowerCase(), label: m[2] || '', attrs: parseAttrs(m[3] || '') });
      i++;
      continue;
    }

    if ((m = line.match(RE_HEADING))) {
      const [text, attrs] = splitTrailingAttrs(m[2]);
      blocks.push({ type: 'heading', level: m[1].length, text, attrs });
      i++;
      continue;
    }

    if (RE_HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i])) {
        body.push(lines[i].replace(RE_QUOTE, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', blocks: parseBlocks(body) });
      continue;
    }

    if (matchItem(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    if (i + 1 < lines.length && RE_DEF.test(lines[i + 1])) {
      const items = [];
      while (i < lines.length) {
        if (isBlank(lines[i])) {
          // a blank line may separate definition entries
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j + 1 < lines.length && !RE_DEF.test(lines[j]) && RE_DEF.test(lines[j + 1])) { i = j; continue; }
          break;
        }
        if (!(i + 1 < lines.length && RE_DEF.test(lines[i + 1]))) break;
        const [term, attrs] = splitTrailingAttrs(lines[i]);
        const defs = [];
        i++;
        while (i < lines.length && RE_DEF.test(lines[i])) {
          const def = [lines[i].match(RE_DEF)[1]];
          i++;
          while (i < lines.length && !isBlank(lines[i]) && !RE_DEF.test(lines[i]) && /^\s{2,}/.test(lines[i])) { def.push(lines[i].trim()); i++; }
          defs.push(def.join('\n'));
        }
        items.push({ term, attrs, defs });
      }
      blocks.push({ type: 'deflist', items });
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i) && !(i + 1 < lines.length && RE_DEF.test(lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.map((l, k) => (k === 0 ? l.replace(/^\s+/, '') : l.replace(/^\s+/, ''))).join('\n') });
  }
  return blocks;
}

function parseList(lines, start) {
  const first = matchItem(lines[start]);
  const list = { type: 'list', ordered: first.ordered, start: first.start, items: [], loose: false };
  let i = start;
  while (i < lines.length) {
    const item = matchItem(lines[i]);
    if (!item || item.ordered !== first.ordered || item.indent !== first.indent) break;
    const body = [item.text];
    i++;
    let prevBlank = false;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { body.push(''); prevBlank = true; i++; continue; }
      const indent = indentOf(line);
      if (indent > item.indent) {
        body.push(line.replace(/^\s*/, ' '.repeat(Math.max(0, indent - Math.min(indent, item.contentIndent)))));
        prevBlank = false;
        i++;
        continue;
      }
      if (!prevBlank && !startsBlock(lines, i)) { body.push(line.trim()); i++; continue; }
      break;
    }
    // trailing blank lines belong between items, not inside this one
    let trailing = 0;
    while (body.length && isBlank(body[body.length - 1])) { body.pop(); trailing++; }
    if (body.some(isBlank)) list.loose = true;
    list.items.push({ blocks: parseBlocks(body) });
    if (trailing) {
      const next = i < lines.length ? matchItem(lines[i]) : null;
      if (next && next.ordered === first.ordered && next.indent === first.indent) list.loose = true;
    }
  }
  return [list, i];
}

// ---------------------------------------------------------------- inline

const PUNCT = /[!-/:-@[-`{-~]/;

/** Allows http(s), mailto, tel, in-page and relative URLs; anything else becomes "#". */
export function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(https?|mailto|tel):/i.test(u)) return '#';
  if (/^\s*(javascript|vbscript|data):/i.test(u)) return '#';
  return u;
}

function findClosingBracket(src, from, open, close) {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const end = src.indexOf('`', j + 1); if (end !== -1 && open === '[') { j = end; continue; } }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Position of the closing emphasis delimiter, skipping code spans and escapes. */
function findEmphasisClose(src, from, delim) {
  const k = delim.length;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') {
      let run = 1;
      while (src[j + run] === '`') run++;
      const end = src.indexOf('`'.repeat(run), j + run);
      if (end !== -1) { j = end + run - 1; continue; }
    }
    if (src.startsWith(delim, j) && j > from && !/\s/.test(src[j - 1])) {
      const after = src[j + k];
      if (k === 1 && (after === delim || src[j - 1] === delim)) {
        // part of a longer run such as ** inside *…*: skip the whole run
        while (src[j + 1] === delim) j++;
        continue;
      }
      if (delim[0] === '_' && after && /[\p{L}\p{N}]/u.test(after)) continue;
      return j;
    }
  }
  return -1;
}

/**
 * Renders inline Markdown to HTML. `ctx` supplies inlineDirective(name,
 * content, attrs) and resolveAsset(src). Everything else is escaped.
 */
export function renderInline(src, ctx = {}) {
  const text = String(src ?? '');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === '\\') {
      if (text[i + 1] === '\n') { out += '<br>'; i += 2; continue; }
      if (i + 1 < text.length && PUNCT.test(text[i + 1])) { out += escapeHtml(text[i + 1]); i += 2; continue; }
    }

    if (c === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let end = text.indexOf(fence, i + run);
      while (end !== -1 && text[end + run] === '`') end = text.indexOf(fence, end + run + 1);
      if (end !== -1) {
        let code = text.slice(i + run, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out += `<code>${escapeHtml(code)}</code>`;
        i = end + run;
        continue;
      }
      out += escapeHtml(fence);
      i += run;
      continue;
    }

    if ((c === '!' && text[i + 1] === '[') || c === '[') {
      const image = c === '!';
      const open = image ? i + 1 : i;
      const close = findClosingBracket(text, open, '[', ']');
      if (close !== -1 && text[close + 1] === '(') {
        const end = findClosingBracket(text, close + 1, '(', ')');
        if (end !== -1) {
          const label = text.slice(open + 1, close);
          const target = text.slice(close + 2, end).trim();
          const tm = target.match(/^<?([^\s>]*)>?(?:\s+"([^"]*)")?$/);
          const url = tm ? tm[1] : target;
          const title = tm && tm[2] ? ` title="${escapeHtml(tm[2])}"` : '';
          if (image) {
            const asset = ctx.resolveAsset ? ctx.resolveAsset(url) : { href: url };
            out += `<img src="${escapeHtml(safeUrl(asset.href))}" alt="${escapeHtml(stripInline(label))}"${title} loading="eager">`;
          } else {
            const href = safeUrl(url);
            const external = /^https?:/i.test(href) ? ' rel="noopener"' : '';
            out += `<a href="${escapeHtml(href)}"${title}${external}>${renderInline(label, ctx)}</a>`;
          }
          i = end + 1;
          continue;
        }
      }
    }

    if (c === ':' && /[a-z]/.test(text[i + 1] || '') && (i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]))) {
      const m = text.slice(i).match(/^:([a-z][\w-]*)\[([^\]]*)\](\{[^}]*\})?/);
      if (m && ctx.inlineDirective) {
        const html = ctx.inlineDirective(m[1], m[2], parseAttrs(m[3] || ''));
        if (html != null) { out += html; i += m[0].length; continue; }
      }
    }

    if (c === '<') {
      const m = text.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/);
      if (m) {
        out += `<a href="${escapeHtml(safeUrl(m[1]))}" rel="noopener">${escapeHtml(m[1].replace(/^mailto:/, ''))}</a>`;
        i += m[0].length;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      let run = 1;
      while (text[i + run] === c) run++;
      const next = text[i + run];
      const prev = text[i - 1];
      const leftFlanking = next && !/\s/.test(next) && !(c === '_' && prev && /[\p{L}\p{N}]/u.test(prev));
      if (leftFlanking && run <= 3) {
        const delim = c.repeat(run);
        const close = findEmphasisClose(text, i + run, delim);
        if (close !== -1) {
          const inner = renderInline(text.slice(i + run, close), ctx);
          out += run === 1 ? `<em>${inner}</em>` : run === 2 ? `<strong>${inner}</strong>` : `<strong><em>${inner}</em></strong>`;
          i = close + run;
          continue;
        }
      }
      out += escapeHtml(c.repeat(run));
      i += run;
      continue;
    }

    if (c === '\n') {
      if (/ {2,}$/.test(out)) { out = out.replace(/ +$/, '') + '<br>\n'; i++; continue; }
      out += '\n';
      i++;
      continue;
    }

    out += escapeHtml(c);
    i++;
  }
  return out;
}
