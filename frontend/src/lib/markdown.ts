/**
 * markdown.ts
 * Madar — Shared markdown rendering for chat surfaces (Agents, project Chat).
 * marked → HTML, then whitelist-sanitized so model output can never inject markup.
 */
import { marked } from 'marked';

export function sanitizeHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const ALLOWED = new Set(['P', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'A', 'DIV', 'KBD']);
  const ALLOWED_ATTR: Record<string, Set<string>> = { A: new Set(['href', 'title']), CODE: new Set(['class']), SPAN: new Set(['class']), TD: new Set(['align']), TH: new Set(['align']), DIV: new Set(['class']) };
  function walk(node: ChildNode): string {
    if (node.nodeType === 3) {
      return (node.textContent || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (!ALLOWED.has(tag)) {
      return (el.textContent || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    const allowedAttrs = ALLOWED_ATTR[tag] || new Set<string>();
    let attrs = '';
    for (const a of Array.from(el.attributes)) {
      if (allowedAttrs.has(a.name)) {
        if (tag === 'A' && a.name === 'href') {
          // Browsers strip tab/newline/CR (and other control chars) out of URLs
          // before scheme resolution, so "java\tscript:" would slip past a naive
          // prefix check. Whitelist safe schemes instead of blacklisting bad ones.
          const v = a.value.replace(/[\x00-\x20\x7f]/g, '').toLowerCase();
          if (!(/^(https?:|mailto:)/.test(v) || v.startsWith('#') || v.startsWith('/'))) continue;
        }
        attrs += ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
      }
    }
    const inner = Array.from(el.childNodes).map(walk).join('');
    if (tag === 'HR' || tag === 'BR') return `<${tag.toLowerCase()}${attrs}/>`;
    return `<${tag.toLowerCase()}${attrs}>${inner}</${tag.toLowerCase()}>`;
  }
  return Array.from(tmp.childNodes).map(walk).join('');
}

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { gfm: true, breaks: true });
  return sanitizeHtml(typeof html === 'string' ? html : src);
}

/**
 * Team Chat only — the sanitized renderMarkdown output is post-processed by a
 * DOM walk that wraps @username mentions in <span class="tchat-mention">.
 * Mentions inside code-like containers (CODE/PRE/KBD) or links (A) stay literal.
 */
function decorateMentionsInText(seed: Text): void {
  const MENTION_RE = /(^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]{1,49})/gu;
  let node: Text | null = seed;
  while (node) {
    const text = node.textContent || '';
    MENTION_RE.lastIndex = 0;
    const m = MENTION_RE.exec(text);
    if (!m) break;
    const at = m.index + m[1].length;      // position of '@'
    const len = 1 + m[2].length;           // '@' + name
    const tail = node.splitText(at);       // tail starts at '@'
    const suffix = tail.splitText(len);    // rest after the mention
    const span = document.createElement('span');
    span.className = 'tchat-mention';
    tail.parentNode!.insertBefore(span, tail);
    span.appendChild(tail);
    node = suffix;
  }
}

function walkMentions(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      decorateMentionsInText(child as Text);
    } else if (child.nodeType === 1) {
      const tag = (child as HTMLElement).tagName;
      if (tag === 'CODE' || tag === 'PRE' || tag === 'KBD' || tag === 'A') continue;
      walkMentions(child);
    }
  }
}

export function applyMentions(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  walkMentions(tmp);
  return tmp.innerHTML;
}

export function renderTeamMarkdown(src: string): string {
  const html = applyMentions(renderMarkdown(src));
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  for (const h of tmp.querySelectorAll('h1,h2,h3,h4,h5,h6') as NodeListOf<HTMLElement>) {
    const cls = h.tagName.toLowerCase();
    const div = document.createElement('div');
    div.className = 'tchat-md-h ' + cls;
    while (h.firstChild) div.appendChild(h.firstChild);
    h.replaceWith(div);
  }
  return tmp.innerHTML;
}
