/**
 * Remnote notes -> Zotero child-note serialization.
 *
 * ONE-WAY, Remnote -> Zotero (like tags). Formatting follows the Markdown mirror at
 * /Volumes/extSSD/Projects/AI/knowledge-bases/Remnote (READER_CONTRACT v7): first line is the
 * citekey hyperlinked to the doc's RemNote deep link, body bullets nested 2 spaces per level,
 * headings as #/##/###, todos as [ ]/[x], portals as "Query/portal:", and a trailing
 * "Referenced by" section. Per mo's decisions (2026-09-01): entire body verbatim (abstract
 * included), rendered to real HTML, `^remId` anchors DROPPED, Referenced by KEPT.
 *
 * CHANGE DETECTION: we hash the SOURCE markdown and append the hash to the note as a visible
 * trailing marker. Zotero sanitizes and normalizes note HTML server-side ("the string you GET
 * back can differ from the string you POST"), so comparing rendered HTML would produce a
 * permanent phantom diff -- the same failure mode that bit the link/DOI/name fields three times.
 * Hashing the source sidesteps it, and keeping the hash IN the note means no new powerup slot
 * (slots are permanent -- see the Gotchas in CLAUDE.md).
 */
import { RNPlugin, RichTextInterface, RemType } from '@remnote/plugin-sdk';

/** A Rem handle. The SDK exports the single-Rem type as PluginRem (the class is RemObject). */
type AnyRem = any;

/** Zotero's own limit is 500,000 chars of raw note HTML (Notes.inc.php $MAX_NOTE_LENGTH). */
export const ZOTERO_NOTE_MAX_CHARS = 500000;

/* ------------------------------------------------------------------ marker + hash -- */

/**
 * The trailing marker. A plain <p> on purpose: Zotero's note editor schema would drop an
 * unknown data-* attribute the moment the user edits the note, and the server sanitizer is a
 * closed-source service with no published whitelist -- but <p> is core schema and survives.
 */
// ANCHORED to the trailing paragraph on purpose. An unanchored scan would treat a hand-written
// Zotero note that merely QUOTES a marker (e.g. the user pasted one item's note under another as
// a cross-reference) as one of ours — and we would then overwrite it. Anchoring is safe because
// the 2026-09-01 live probe confirmed Zotero round-trips our note HTML byte-identically.
export const NOTE_MARKER_RE = /<p>\s*remzot:([0-9a-f]{8,32})\s*<\/p>$/i;

export const extractNoteHash = (noteHtml: string): string | null => {
  const m = NOTE_MARKER_RE.exec((noteHtml || '').trim());
  return m ? m[1].toLowerCase() : null;
};

/**
 * FNV-1a over 2x32 bits -> 16 hex chars. Synchronous (crypto.subtle is async and needs a secure
 * context), dependency-free, and collision-safe enough to decide "did this note change".
 */
export const hashNoteSource = (s: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 ^= h2 >>> 13;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
};

/* ------------------------------------------------------------------------- helpers -- */

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** RemNote's "Copy link" form: /w/<kb>/<name-slug>-<remId>. The slug is cosmetic; the id resolves. */
export const remnoteDeepLink = (kbId: string, remId: string, name: string): string => {
  const slug = (name || '')
    .replace(/[^A-Za-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `https://www.remnote.com/w/${kbId}/${slug ? `${slug}-${remId}` : remId}`;
};

/** RICH_TEXT_FORMATTING values, inlined so a missing SDK export can't break the build. */
const FMT = { BOLD: 'b', ITALIC: 'l', INLINE_CODE: 'q', STRIKETHROUGH: 'str', INLINE_LINK: 'qId' };

/** Resolves a rem reference id to its display name. Async because it may hit the host. */
/**
 * RemNote stores pasted/uploaded files as `%LOCAL_FILE%<id>`, which is meaningless outside RemNote.
 * The same id is the object key on RemNote's public S3 bucket, so a real URL is pure substitution.
 */
const REMNOTE_FILE_PREFIX = '%LOCAL_FILE%';
const REMNOTE_S3_BASE = 'https://remnote-user-data.s3.amazonaws.com/';

export const resolveRemnoteFileUrl = (url: string): string =>
  url.startsWith(REMNOTE_FILE_PREFIX)
    ? REMNOTE_S3_BASE + url.slice(REMNOTE_FILE_PREFIX.length)
    : url;

export type RefResolver = (remId: string) => Promise<string>;

/**
 * RichText -> plain text. Purely local: RichTextInterface is plain JS objects already carried on
 * every RemObject, so this costs ZERO host round-trips (plugin.richText.toString would cost one
 * per rem). Rem references resolve through the caller's cache.
 */
export const richTextToPlain = async (
  rt: RichTextInterface | undefined,
  ref: RefResolver
): Promise<string> => {
  if (!rt || !Array.isArray(rt)) return '';
  const out: string[] = [];
  for (const el of rt as any[]) {
    if (typeof el === 'string') {
      out.push(el);
      continue;
    }
    if (!el || typeof el !== 'object') continue;
    switch (el.i) {
      case 'm':
        out.push(el.text ?? '');
        break;
      case 'q':
        out.push(await ref(el._id));
        break;
      case 'x':
        out.push(`$${el.text ?? ''}$`);
        break;
      case 'i':
        // The URL is part of the hashed text ON PURPOSE: swapping an image must re-push the note,
        // and it scopes the 2026-09-01 image change to the few docs that actually contain one.
        out.push(el.url ? `![${el.title ?? ''}](${resolveRemnoteFileUrl(el.url)})` : '[image]');
        break;
      case 'a':
        out.push('[audio]');
        break;
      case 'n':
        out.push(el.text ?? '');
        break;
      default:
        break;
    }
  }
  return out.join('');
};

/** RichText -> inline HTML, preserving bold/italic/code/strikethrough and inline links. */
export const richTextToHtml = async (
  rt: RichTextInterface | undefined,
  ref: RefResolver
): Promise<string> => {
  if (!rt || !Array.isArray(rt)) return '';
  const out: string[] = [];
  for (const el of rt as any[]) {
    if (typeof el === 'string') {
      out.push(escapeHtml(el));
      continue;
    }
    if (!el || typeof el !== 'object') continue;
    if (el.i === 'q') {
      out.push(escapeHtml(await ref(el._id)));
      continue;
    }
    if (el.i === 'x') {
      out.push(`<code>${escapeHtml(el.text ?? '')}</code>`);
      continue;
    }
    if (el.i === 'i') {
      // A real <img>, with RemNote's `%LOCAL_FILE%` rewritten to its public S3 URL.
      //
      // Verified 2026-09-01: the Zotero SERVER preserves <img src> byte-identically, but the
      // note-editor hard-blocks remote loading (`// Disable remote image loading` —
      // note-editor/src/core/node-views/image.js), so the WEB library shows only alt text. The
      // DESKTOP client, however, silently downloads the image on first opening the note and
      // converts it into an embedded_image attachment, after which it renders everywhere — at the
      // cost of the 300 MB file quota. mo chose that trade knowingly (2026-09-01); if storage ever
      // runs short, revert this branch to emitting a link.
      const src = resolveRemnoteFileUrl(el.url ?? '');
      if (!src) {
        out.push('[image]');
        continue;
      }
      out.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(el.title ?? '')}">`);
      continue;
    }
    if (el.i !== 'm') continue;
    let piece = escapeHtml(el.text ?? '');
    if (el[FMT.INLINE_CODE]) piece = `<code>${piece}</code>`;
    if (el[FMT.BOLD]) piece = `<strong>${piece}</strong>`;
    if (el[FMT.ITALIC]) piece = `<em>${piece}</em>`;
    if (el[FMT.STRIKETHROUGH]) piece = `<s>${piece}</s>`;
    const href = el[FMT.INLINE_LINK];
    if (typeof href === 'string' && href) piece = `<a href="${escapeHtml(href)}">${piece}</a>`;
    out.push(piece);
  }
  return out.join('');
};

/* --------------------------------------------------------------------- the doc body -- */

/** One rendered body line. `kind` drives both the Markdown and the HTML rendering. */
export interface NoteLine {
  depth: number;
  /** Plain text — this is what the Markdown rendering and therefore the HASH sees. */
  text: string;
  /** Inline HTML for the same content, preserving bold/italic/code/strikethrough and links. */
  html: string;
  kind: 'bullet' | 'heading' | 'todo-done' | 'todo-open' | 'portal' | 'document';
  headingLevel?: 1 | 2 | 3;
  url?: string;
}

export interface NoteSource {
  /** Citekey / doc name -- the note's first line, and therefore its Zotero title. */
  title: string;
  /**
   * RemNote deep link for the first line. OPTIONAL: building it needs the knowledge-base id, and
   * if that can't be resolved the note must still be pushed -- the title just renders unlinked
   * rather than the whole feature going silent.
   */
  docUrl?: string;
  lines: NoteLine[];
  referencedBy: { name: string; url?: string }[];
}

const swallow = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

/**
 * Is this child one of RemNote's own powerup property rems rather than user content?
 * Only the doc's DIRECT children need this test -- anything under a genuine body bullet is body
 * content -- which keeps it to ~1 call per direct child instead of one per descendant.
 */
export const isPropertyRem = async (rem: AnyRem): Promise<boolean> => {
  const checks = ['isPowerupProperty', 'isPowerupSlot', 'isSlot', 'isPowerupEnum'];
  for (const name of checks) {
    if (typeof rem?.[name] !== 'function') continue;
    if (await swallow(Promise.resolve(rem[name]()), false)) return true;
  }
  return false;
};

/**
 * Collect a doc's body as flat, depth-tagged lines.
 *
 * `rich` = false is the CHEAP pass used for hashing: one getDescendants() call plus local
 * rich-text flattening, no per-rem property round-trips. `rich` = true additionally resolves
 * heading level / todo state / sub-document links, and is only worth paying for on the items
 * whose hash actually changed.
 */
export const collectBody = async (
  plugin: RNPlugin,
  doc: AnyRem,
  ref: RefResolver,
  rich: boolean
): Promise<NoteLine[]> => {
  const children: AnyRem[] = await swallow(doc.getChildrenRem(), []);
  const roots: AnyRem[] = [];
  for (const c of children) {
    if (!(await isPropertyRem(c))) roots.push(c);
  }
  if (!roots.length) return [];

  // One host call gets the whole subtree; every RemObject already carries text/parent/children.
  const all: AnyRem[] = await swallow(doc.getDescendants(), []);
  const byId = new Map<string, AnyRem>();
  for (const r of all) if (r?._id) byId.set(r._id, r);
  for (const r of roots) if (r?._id) byId.set(r._id, r);

  const lines: NoteLine[] = [];
  const seen = new Set<string>();

  const walk = async (rem: AnyRem, depth: number): Promise<void> => {
    if (!rem?._id || seen.has(rem._id)) return;
    seen.add(rem._id);

    const text = (await richTextToPlain(rem.text, ref)).trim();
    const html = (await richTextToHtml(rem.text, ref)).trim();
    let kind: NoteLine['kind'] = 'bullet';
    let headingLevel: NoteLine['headingLevel'];
    let url: string | undefined;

    if (rem.type === RemType.PORTAL) {
      kind = 'portal';
    } else if (rich) {
      if (await swallow(Promise.resolve(rem.isTodo?.()), false)) {
        const st = await swallow(Promise.resolve(rem.getTodoStatus?.()), undefined as any);
        kind = st === 'Finished' ? 'todo-done' : 'todo-open';
      } else if (await swallow(Promise.resolve(rem.isDocument?.()), false)) {
        kind = 'document';
      } else {
        const fs = await swallow(Promise.resolve(rem.getFontSize?.()), undefined as any);
        if (fs === 'H1' || fs === 'H2' || fs === 'H3') {
          kind = 'heading';
          headingLevel = fs === 'H1' ? 1 : fs === 'H2' ? 2 : 3;
        }
      }
    }

    if (text || kind !== 'bullet') lines.push({ depth, text, html, kind, headingLevel, url });

    // A sub-document's own contents live in its own note; don't inline them.
    if (kind === 'document') return;
    // A heading RESETS indentation: its children restart at depth 0 rather than nesting under
    // it. That is the mirror's behaviour (remnote_convert.py sets child_depth = 0 for headings),
    // and matching it keeps our hash stable against the reference format.
    const childDepth = kind === 'heading' ? 0 : depth + 1;
    const kidIds: string[] = rem.children ?? [];
    for (const id of kidIds) {
      const kid = byId.get(id);
      if (kid) await walk(kid, childDepth);
    }
  };

  for (const r of roots) await walk(r, 0);
  return lines;
};

/* ------------------------------------------------------------------------ rendering -- */

/**
 * Markdown in the mirror's shape.
 *
 * `forHash` emits a CANONICAL form that omits every URL. This matters: `docUrl` and the backlink
 * URLs are derived from the knowledge-base id, which is re-parsed from the address bar each run
 * and can legitimately be absent (e.g. the desktop app). If URLs were hashed, a run that failed to
 * resolve the kbId would change the hash of EVERY doc and re-push the entire library — then
 * re-push it again on switching back. The hash must depend only on the note's content.
 */
export const renderMarkdown = (src: NoteSource, forHash = false): string => {
  const linkTitle = !forHash && src.docUrl;
  const out: string[] = [linkTitle ? `[${src.title}](${src.docUrl})` : src.title, ''];
  for (const l of src.lines) {
    const pad = '  '.repeat(l.depth);
    if (l.kind === 'heading') out.push(`${'#'.repeat(l.headingLevel ?? 1)} ${l.text}`);
    else if (l.kind === 'todo-done') out.push(`${pad}- [x] ${l.text}`);
    else if (l.kind === 'todo-open') out.push(`${pad}- [ ] ${l.text}`);
    else if (l.kind === 'portal') out.push(`${pad}- \u{1F50E} Query/portal: ${l.text}`);
    else out.push(`${pad}- ${l.text}`);
  }
  if (src.referencedBy.length) {
    out.push('', '## Referenced by');
    for (const r of src.referencedBy)
      out.push(!forHash && r.url ? `- [${r.name}](${r.url})` : `- ${r.name}`);
  }
  return out.join('\n').trim();
};

/**
 * Zotero note HTML. Only tags in the note-editor ProseMirror schema are emitted
 * (p, h1-h3, ul, li, a, strong, em, code, s) so nothing is dropped when the note is edited.
 */
export const renderHtml = (src: NoteSource, hash: string): string => {
  const title = escapeHtml(src.title);
  const out: string[] = [
    src.docUrl ? `<p><a href="${escapeHtml(src.docUrl)}">${title}</a></p>` : `<p>${title}</p>`,
  ];
  // A <ul> must nest INSIDE the preceding <li>, never beside it: `ul` accepts only `li`, and the
  // note editor's ProseMirror schema re-parents a stray bulletList into a synthesized empty
  // listItem — which shows up as a blank bullet above every indented group and makes the saved
  // HTML differ from what we pushed.
  let open = 0; // number of open <ul>
  let liOpen = false; // the innermost <ul> has an unclosed <li>
  let liInline = false; // …and nothing (no nested <ul>) has been emitted since its opening line
  // Close the open <li>: on the SAME line as its text when it holds no nested list (`<li>x</li>`),
  // on its own line after the nested </ul> otherwise. Cosmetic only — the hash never sees HTML.
  const closeLi = () => {
    if (liInline) out[out.length - 1] += '</li>';
    else out.push('</li>');
    liOpen = false;
    liInline = false;
  };
  const closeTo = (depth: number) => {
    while (open > depth) {
      if (liOpen) closeLi();
      out.push('</ul>');
      open -= 1;
      liOpen = open > 0; // the <ul> just closed lived inside its parent's <li>
      liInline = false;
    }
  };
  for (const l of src.lines) {
    if (l.kind === 'heading') {
      closeTo(0);
      const lv = l.headingLevel ?? 1;
      out.push(`<h${lv}>${l.html || escapeHtml(l.text)}</h${lv}>`);
      continue;
    }
    // Clamp: we can only descend one level per line, and only into an open <li>. This handles a
    // depth jump greater than one and a first line at depth > 0.
    let depth = l.depth;
    if (depth + 1 > open) depth = liOpen ? open : Math.max(open - 1, 0);
    closeTo(depth + 1);
    while (open < depth + 1) {
      out.push('<ul>');
      open += 1;
      liOpen = false;
      liInline = false;
    }
    if (liOpen) closeLi();
    const body = l.html || escapeHtml(l.text);
    const prefix =
      l.kind === 'todo-done'
        ? '☑ '
        : l.kind === 'todo-open'
        ? '☐ '
        : l.kind === 'portal'
        ? '\u{1F50E} Query/portal: '
        : '';
    out.push(`<li>${prefix}${body}`);
    liOpen = true;
    liInline = true;
  }
  closeTo(0);
  if (src.referencedBy.length) {
    out.push('<h2>Referenced by</h2>', '<ul>');
    for (const r of src.referencedBy) {
      const n = escapeHtml(r.name);
      out.push(r.url ? `<li><a href="${escapeHtml(r.url)}">${n}</a></li>` : `<li>${n}</li>`);
    }
    out.push('</ul>');
  }
  // The marker goes LAST and is appended AFTER hashing, so it can never feed into its own hash.
  out.push(`<p>remzot:${hash}</p>`);
  return out.join('\n');
};

export interface BuiltNote {
  markdown: string;
  html: string;
  hash: string;
  empty: boolean;
  tooLong: boolean;
  /** Body lines, for the preview row ("N lines"). */
  lineCount: number;
}

/**
 * Serialize -> hash -> render. The hash covers the markdown only, never the marker.
 *
 * `hashOverride` exists because detection and rendering run at different fidelity: the hash is
 * computed from the CHEAP pass (~2 host calls per doc) while the pushed HTML comes from the RICH
 * pass (headings/todos/sub-documents, ~3 calls per rem). Stamping the cheap hash into the rich
 * note keeps the two consistent across runs. Trade-off: a formatting-only edit that changes no
 * text (ticking a todo, promoting a bullet to a heading) is not detected by the bulk sync -- the
 * per-item Sync button pushes unconditionally and is the escape hatch for that.
 */
export const buildNote = (src: NoteSource, hashOverride?: string): BuiltNote => {
  const markdown = renderMarkdown(src);
  // Hash the URL-free canonical rendering, never `markdown` itself.
  const hash = hashOverride ?? hashNoteSource(renderMarkdown(src, true));
  const html = renderHtml(src, hash);
  return {
    markdown,
    hash,
    html,
    empty: src.lines.length === 0,
    tooLong: html.length > ZOTERO_NOTE_MAX_CHARS,
    lineCount: src.lines.length,
  };
};
