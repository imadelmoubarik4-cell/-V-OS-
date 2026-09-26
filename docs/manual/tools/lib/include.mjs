// ::include{from="File.md#section-id"} and ::include{from="File.md" tag=quick}
// Resolved on the source text before parsing, so the Quick Start can reuse
// sections of the User Guide verbatim (one source for both guides).
import path from 'node:path';
import { parseAttrs, parseFrontmatter, slugify, stripInline } from './markdown.mjs';

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const RE_INCLUDE = /^\s{0,3}::include(?:\[.*?\])?\s*(\{.*\})\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/;
const RE_OPEN = /^\s{0,3}(:{3,})\s*([a-zA-Z][\w-]*)(.*)$/;
const RE_CLOSE = /^\s{0,3}(:{3,})\s*$/;

function trailingAttrs(text) {
  const m = String(text).match(/\{([^{}]*)\}\s*$/);
  return parseAttrs(m ? m[1] : '');
}

function headingInfo(line) {
  const m = line.match(RE_HEADING);
  if (!m) return null;
  const attrs = trailingAttrs(m[2]);
  const text = m[2].replace(/\s*\{[^{}]*\}\s*$/, '');
  return { level: m[1].length, attrs, id: attrs.id || slugify(stripInline(text)) };
}

/** Marks which lines are inside fenced code, so directives there are ignored. */
function fenceMask(lines) {
  const mask = [];
  let fence = null;
  for (const line of lines) {
    const f = line.match(RE_FENCE);
    if (fence) { mask.push(true); if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; mask.push(true); continue; }
    mask.push(false);
  }
  return mask;
}

/** End (exclusive) of the section starting at line `start`. */
function sectionEnd(lines, mask, start) {
  const open = lines[start].match(RE_OPEN);
  if (open) {
    const n = open[1].length;
    let depth = 0;
    for (let j = start + 1; j < lines.length; j++) {
      if (mask[j]) continue;
      const o = lines[j].match(RE_OPEN);
      if (o && o[1].length === n) { depth++; continue; }
      const c = lines[j].match(RE_CLOSE);
      if (c && c[1].length === n) { if (depth === 0) return j + 1; depth--; }
    }
    return lines.length;
  }
  const { level } = headingInfo(lines[start]);
  const stack = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (mask[j]) continue;
    const line = lines[j];
    const o = line.match(RE_OPEN);
    if (o) {
      if (!stack.length && o[2].toLowerCase() === 'chapter') return j;
      stack.push(o[1].length);
      continue;
    }
    const c = line.match(RE_CLOSE);
    if (c) {
      if (!stack.length) return j; // the section sat inside a container that closes here
      const idx = stack.lastIndexOf(c[1].length);
      if (idx !== -1) stack.length = idx;
      continue;
    }
    if (!stack.length) {
      const h = headingInfo(line);
      if (h && h.level <= level) return j;
    }
  }
  return lines.length;
}

function sectionStarts(lines, mask, match) {
  const starts = [];
  lines.forEach((line, i) => {
    if (mask[i]) return;
    const h = headingInfo(line);
    if (h) { if (match(h.attrs, h.id)) starts.push(i); return; }
    const o = line.match(RE_OPEN);
    if (o) {
      const braces = o[3].match(/\{([^{}]*)\}/g) || [];
      const attrs = parseAttrs('');
      for (const b of braces) {
        const a = parseAttrs(b);
        attrs.classes.push(...a.classes);
        if (a.id) attrs.id = a.id;
      }
      if (match(attrs, attrs.id)) starts.push(i);
    }
  });
  return starts;
}

function shiftHeadings(lines, shift) {
  if (!shift) return lines;
  const mask = fenceMask(lines);
  return lines.map((line, i) => {
    if (mask[i]) return line;
    const m = line.match(/^(\s{0,3})(#{1,6})(\s.*)$/);
    if (!m) return line;
    const level = Math.min(6, Math.max(1, m[2].length + shift));
    return m[1] + '#'.repeat(level) + m[3];
  });
}

/**
 * Replaces every ::include line. `readFile(absPath)` returns the file text.
 * Throws on a missing file, an unknown section id, or an include cycle.
 */
export function resolveIncludes(source, { baseDir, readFile, file = '(source)', stack = [] }) {
  const lines = String(source).split('\n');
  const mask = fenceMask(lines);
  const out = [];
  lines.forEach((line, i) => {
    const m = !mask[i] && line.match(RE_INCLUDE);
    if (!m) { out.push(line); return; }
    const attrs = parseAttrs(m[1]);
    if (!attrs.from) throw new Error(`${file}: ::include needs from="File.md#id"`);
    const [target, id] = String(attrs.from).split('#');
    const abs = target ? path.resolve(baseDir, target) : file;
    if (stack.includes(abs)) throw new Error(`${file}: include cycle through ${abs}`);
    const body = parseFrontmatter(readFile(abs)).body;
    const expanded = resolveIncludes(body, { baseDir: path.dirname(abs), readFile, file: abs, stack: [...stack, file] }).split('\n');
    const emask = fenceMask(expanded);
    let starts;
    if (id) starts = sectionStarts(expanded, emask, (a, sid) => sid === id);
    else if (attrs.tag) starts = sectionStarts(expanded, emask, (a) => a.classes.includes(attrs.tag));
    else starts = null;
    if (starts && !starts.length) throw new Error(`${file}: ::include found no section ${id ? `#${id}` : `tagged .${attrs.tag}`} in ${target}`);
    let picked = [];
    if (!starts) picked = expanded;
    else {
      let covered = -1;
      for (const start of starts) {
        if (start < covered) continue; // already inside an earlier picked section
        const end = sectionEnd(expanded, emask, start);
        picked.push(...expanded.slice(start, end), '');
        covered = end;
        if (id) break;
      }
    }
    out.push(...shiftHeadings(picked, parseInt(attrs.shift || '0', 10)));
  });
  return out.join('\n');
}
