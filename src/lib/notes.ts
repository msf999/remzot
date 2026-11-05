/**
 * Remnote notes -> Zotero child-note serialization.
 *
 * ONE-WAY, Remnote -> Zotero (like tags). The layout follows the Markdown mirror at
 * /Volumes/extSSD/Projects/knowledge-bases/Remnote (READER_CONTRACT v7): first line is the
 * citekey hyperlinked to the doc's RemNote deep link, body bullets nested 2 spaces per level,
 * headings as #/##/###, todos as [ ]/[x], portals as "Query/portal:", and a trailing
 * "Referenced by" section. Per mo's decisions (2026-09-01): entire body verbatim (abstract
 * included), rendered to real HTML, `^remId` anchors DROPPED, Referenced by KEPT. The one thing
 * left out is RemNote's hidden References portal (see `isSearchPortal`) — it is not body content.
 * Each line reads as RemNote draws it (mo, 2026-11-06): an aliased reference as its alias, a pin as
 * 📌, clozes as {{…}}, a flashcard's back after its arrow, tags as chips, and RemNote's formatting
 * and colours — see `richTextToHtml` and `collectBody`.
 *
 * CHANGE DETECTION: we hash the SOURCE markdown and append the hash to the note as a visible
 * trailing marker. Zotero sanitizes and normalizes note HTML server-side ("the string you GET
 * back can differ from the string you POST"), so comparing rendered HTML would produce a
 * permanent phantom diff -- the same failure mode that bit the link/DOI/name fields three times.
 * Hashing the source sidesteps it, and keeping the hash IN the note means no new powerup slot
 * (slots are permanent -- see the Gotchas in CLAUDE.md).
 */
import { PORTAL_TYPE, RNPlugin, RichTextInterface, RemType } from '@remnote/plugin-sdk';

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
const FMT = {
  BOLD: 'b',
  ITALIC: 'l',
  UNDERLINE: 'u',
  INLINE_CODE: 'q',
  CODE: 'code',
  STRIKETHROUGH: 'str',
  SUBSCRIPT: 'sub',
  SUPERSCRIPT: 'sup',
  HIGHLIGHT: 'h',
  TEXT_COLOR: 'tc',
  CLOZE: 'cId',
  /** A REM id, not a URL: for a web link, a Link rem whose address is its URL property. */
  INLINE_LINK: 'qId',
  DEPRECATED_LINK: 'url',
};

/** What RemNote draws in place of a pinned highlight. */
const PIN = '\u{1F4CC}';

/** The arrows RemNote draws between a flashcard's front and back. */
const ARROW = { forward: '→', backward: '←', both: '↔' };

/**
 * RemNote's colour palette (light theme), read off its editor on 2026-11-06. A text run's highlight
 * (`h`) and text colour (`tc`) are 1–6; a rem's own highlight comes back by name.
 */
const RN_COLOUR_NAMES = ['red', 'orange', 'yellow', 'green', 'purple', 'blue'];
const RN_HIGHLIGHT_CSS = ['#ffe5e9', '#ffe8dd', '#fff8d9', '#d1ffee', '#f6ebff', '#d4f0ff'];
const RN_TEXT_CSS = ['#e6193f', '#ff8d1f', '#ffc002', '#00b16f', '#9b52ff', '#4b73ff'];
/** RemNote draws a rem's tags as grey chips beside it. */
const TAG_CHIP_CSS = '#eceef4';

/** A RemNote colour — palette number, colour name or CSS colour — as CSS; undefined if there is none. */
export const remnoteColour = (v: unknown, palette: string[]): string | undefined => {
  if (typeof v === 'number') return palette[v - 1];
  if (typeof v !== 'string' || !v) return undefined;
  if (/^\d$/.test(v)) return palette[Number(v) - 1];
  const named = RN_COLOUR_NAMES.indexOf(v.toLowerCase());
  if (named >= 0) return palette[named];
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(v) ? v : undefined;
};

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

/** Resolves a rem reference id to its display name. Async because it may hit the host. */
export type RefResolver = (remId: string) => Promise<string>;

/**
 * What RemNote shows for a reference that carries an alias: the alias's text. `fallback` resolves
 * the target's own name, for when the alias can't be read.
 */
export type AliasResolver = (el: { _id: string; aliasId: string }, fallback: RefResolver) => Promise<string>;

/** Options for the plain-text rendering — the one the HASH sees. */
export interface PlainOptions {
  alias?: AliasResolver;
  /**
   * Render as Remzot did before 2026-11-06 — every reference as its target's name, pins and aliases
   * included, and no cloze marks — so `buildNoteForDoc` can reproduce the hashes of older notes.
   */
  legacy?: boolean;
}

/** Options for the HTML rendering. HTML is never hashed, so these lookups can't move a note. */
export interface HtmlOptions {
  alias?: AliasResolver;
  /** A RemNote link to a rem (references, pins, tags); undefined when the knowledge base is unknown. */
  remLink?: (remId: string, name?: string) => string | undefined;
  /** The web address behind an inline link: the URL of the Link rem it names. Rich pass only. */
  linkUrl?: (remId: string) => Promise<string | undefined>;
  /** A referenced rem's own highlight — RemNote shows references to PDF highlights in it. Rich pass only. */
  refHighlight?: (remId: string) => Promise<string | undefined>;
}

const isAliased = (el: any): boolean => typeof el.aliasId === 'string' && !!el.aliasId && el.aliasId !== el._id;

/** A reference as RemNote shows it: its alias when it carries one, else the target's name. */
const refText = (el: any, ref: RefResolver, alias?: AliasResolver): Promise<string> =>
  alias && isAliased(el) ? alias(el, ref) : ref(el._id);

/**
 * Clozes in RemNote's own `{{…}}` syntax. One cloze can span several runs (a bold word inside it),
 * all carrying its `cId`, so the braces open and close where the id changes, not per element.
 */
const clozeMarks = (out: string[]) => {
  let open: string | null = null;
  return {
    at(el: any): void {
      const id = el && typeof el === 'object' && typeof el[FMT.CLOZE] === 'string' && el[FMT.CLOZE] ? el[FMT.CLOZE] : null;
      if (id === open) return;
      if (open) out.push('}}');
      if (id) out.push('{{');
      open = id;
    },
    end(): void {
      if (open) out.push('}}');
      open = null;
    },
  };
};

/**
 * RichText -> plain text. Purely local: RichTextInterface is plain JS objects already carried on
 * every RemObject, so this costs ZERO host round-trips (plugin.richText.toString would cost one
 * per rem). Rem references resolve through the caller's cache; an aliased one costs one call.
 */
export const richTextToPlain = async (
  rt: RichTextInterface | undefined,
  ref: RefResolver,
  opts: PlainOptions = {}
): Promise<string> => {
  if (!rt || !Array.isArray(rt)) return '';
  const out: string[] = [];
  const cloze = opts.legacy ? null : clozeMarks(out);
  for (const el of rt as any[]) {
    cloze?.at(el);
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
        // A pin is drawn as 📌 after the text it was copied from — not as that text a second time.
        if (opts.legacy) out.push(await ref(el._id));
        else out.push(el.pin ? PIN : await refText(el, ref, opts.alias));
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
  cloze?.end();
  return out.join('');
};

/**
 * A rem's plain-text NAME computed locally: strings plus the text of formatted-text, LaTeX and
 * annotation elements. Images and audio add nothing to a name, and references are left out —
 * resolving them would mean host calls of their own. Only the fallback of `safeRichTextToString`.
 */
const plainNameText = (rt: RichTextInterface): string =>
  (rt as any[])
    .map((el) =>
      typeof el === 'string' ? el : el && (el.i === 'm' || el.i === 'x' || el.i === 'n') ? el.text ?? '' : ''
    )
    .join('');

/**
 * `plugin.richText.toString`, except that a refusal falls back to `plainNameText` instead of
 * throwing. The host REJECTS some of RemNote's own image elements — an upload's leftover `percent`,
 * an image occlusion's `blocks` (CLAUDE.md Gotchas, R-032) — and every caller reads names in a loop,
 * so one such rem used to fail a whole note, library index or preview.
 */
export const safeRichTextToString = async (
  plugin: RNPlugin,
  rt: RichTextInterface | undefined
): Promise<string> => {
  if (!rt || !Array.isArray(rt)) return '';
  try {
    return await plugin.richText.toString(rt);
  } catch {
    return plainNameText(rt);
  }
};

/**
 * RichText -> inline HTML as RemNote draws it: bold/italic/underline/code/strikethrough, sub- and
 * superscript, highlight and text colours, clozes as `{{…}}`, inline links, references (linked back
 * to RemNote, in the highlight colour of a PDF highlight) and pins as a linked 📌. Every mark used is
 * in the Zotero note-editor schema (zotero/note-editor src/core/schema/marks.js), so nothing is
 * dropped when the note is edited there.
 */
export const richTextToHtml = async (
  rt: RichTextInterface | undefined,
  ref: RefResolver,
  opts: HtmlOptions = {}
): Promise<string> => {
  if (!rt || !Array.isArray(rt)) return '';
  const out: string[] = [];
  const cloze = clozeMarks(out);
  for (const el of rt as any[]) {
    cloze.at(el);
    if (typeof el === 'string') {
      out.push(escapeHtml(el));
      continue;
    }
    if (!el || typeof el !== 'object') continue;
    if (el.i === 'q') {
      if (el.pin) {
        const pinHref = opts.remLink?.(el._id);
        out.push(pinHref ? `<a href="${escapeHtml(pinHref)}">${PIN}</a>` : PIN);
        continue;
      }
      const name = await refText(el, ref, opts.alias);
      let piece = escapeHtml(name);
      const href = name ? opts.remLink?.(el._id, name) : undefined;
      if (href) piece = `<a href="${escapeHtml(href)}">${piece}</a>`;
      const bg = opts.refHighlight ? remnoteColour(await opts.refHighlight(el._id), RN_HIGHLIGHT_CSS) : undefined;
      if (bg && name) piece = `<span style="background-color: ${bg}">${piece}</span>`;
      out.push(piece);
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
    if (el[FMT.INLINE_CODE] || el[FMT.CODE]) piece = `<code>${piece}</code>`;
    if (el[FMT.BOLD]) piece = `<strong>${piece}</strong>`;
    if (el[FMT.ITALIC]) piece = `<em>${piece}</em>`;
    if (el[FMT.UNDERLINE]) piece = `<u>${piece}</u>`;
    if (el[FMT.STRIKETHROUGH]) piece = `<s>${piece}</s>`;
    if (el[FMT.SUBSCRIPT]) piece = `<sub>${piece}</sub>`;
    else if (el[FMT.SUPERSCRIPT]) piece = `<sup>${piece}</sup>`;
    const colour = remnoteColour(el[FMT.TEXT_COLOR], RN_TEXT_CSS);
    if (colour) piece = `<span style="color: ${colour}">${piece}</span>`;
    const bg = remnoteColour(el[FMT.HIGHLIGHT], RN_HIGHLIGHT_CSS);
    if (bg) piece = `<span style="background-color: ${bg}">${piece}</span>`;
    // `qId` names a REM — for a web link, a Link rem holding the address. Until 2026-11-06 the id
    // itself went into href, so every such link was broken in Zotero.
    const linkId = el[FMT.INLINE_LINK];
    const oldUrl = el[FMT.DEPRECATED_LINK];
    const href =
      typeof linkId === 'string' && linkId
        ? (opts.linkUrl && (await opts.linkUrl(linkId))) || opts.remLink?.(linkId)
        : typeof oldUrl === 'string' && oldUrl
        ? oldUrl
        : undefined;
    if (href) piece = `<a href="${escapeHtml(href)}">${piece}</a>`;
    out.push(piece);
  }
  cloze.end();
  return out.join('');
};

/* --------------------------------------------------------------------- the doc body -- */

/** One rendered body line. `kind` drives both the Markdown and the HTML rendering. */
export interface NoteLine {
  depth: number;
  /** Plain text — this is what the Markdown rendering and therefore the HASH sees. */
  text: string;
  /**
   * The line as Remzot wrote it before 2026-11-06 (front only, every reference as its target's
   * name, no cloze marks) — only for the hashes older notes carry (`buildNoteForDoc`).
   */
  legacyText?: string;
  /** Inline HTML for the same content, as RemNote draws it (see `richTextToHtml`). */
  html: string;
  kind: 'bullet' | 'heading' | 'todo-done' | 'todo-open' | 'portal' | 'document';
  headingLevel?: 1 | 2 | 3;
  url?: string;
  /**
   * The line belongs to RemNote's hidden References portal (or sits under it). Never written to
   * Zotero; collected only so the hash notes had before these were skipped can be reproduced.
   */
  hidden?: boolean;
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
 * Is this rem a SEARCH portal? RemNote keeps every document's References section — the
 * "N References · Hide" panel at the bottom — as one of these, stored INSIDE the document
 * (`query:<the doc>`, with portals under it), and makes it the first time a doc with backlinks is
 * shown. It never appears in the doc, but `getChildrenRem()` returns it, so the notes writer and the
 * Items scan must skip it (R-031; confirmed by experiment 2026-11-05). Only portals pay a host call.
 */
export const isSearchPortal = async (rem: AnyRem): Promise<boolean> =>
  rem?.type === RemType.PORTAL &&
  (await swallow(Promise.resolve(rem.getPortalType?.()), undefined)) === PORTAL_TYPE.SEARCH_PORTAL;

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
 *
 * Lines from RemNote's hidden References portal come back flagged `hidden`, their links resolved
 * through `refHidden` (default `ref`) so a caller can keep them out of its unreadable-link count.
 *
 * A line is drawn as RemNote draws it: a flashcard's back after its arrow, and — rich pass only, as
 * each costs a call per rem — the card's real direction, the rem's own highlight and its tags. The
 * hashed `text` takes the back with a plain → (direction, highlight and tags are HTML only, like
 * headings and todos). `legacyText` is the line as older notes had it. A line comes back if either
 * text is non-empty, or it is not a plain bullet; the caller picks per format.
 */
export const collectBody = async (
  plugin: RNPlugin,
  doc: AnyRem,
  ref: RefResolver,
  rich: boolean,
  refHidden: RefResolver = ref,
  opts: HtmlOptions = {}
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
  // The cheap pass makes no lookups beyond names and aliases; the rich pass may follow links and
  // read the highlight colour of what a reference points at.
  const htmlOpts: HtmlOptions = rich ? opts : { alias: opts.alias, remLink: opts.remLink };
  const tagCache = new Map<string, string | null>(); // tag id → its chip label, or null for a powerup

  /** A rem's user tags as RemNote's grey chips. Powerups (Todo, Header, PDF Highlight…) never show as chips. */
  const tagChips = async (rem: AnyRem): Promise<string> => {
    const chips: string[] = [];
    for (const t of await swallow(Promise.resolve(rem.getTagRems?.()), [] as AnyRem[])) {
      if (!t?._id) continue;
      let label = tagCache.get(t._id);
      if (label === undefined) {
        const powerup = await swallow(Promise.resolve(t.isPowerup?.()), false);
        const name = powerup ? '' : (await safeRichTextToString(plugin, t.text)).trim();
        label = name ? `#${name}` : null;
        tagCache.set(t._id, label);
      }
      if (!label) continue;
      const href = opts.remLink?.(t._id, label.slice(1));
      const inner = href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
      chips.push(`<span style="background-color: ${TAG_CHIP_CSS}">${inner}</span>`);
    }
    return chips.join(' ');
  };

  const walk = async (rem: AnyRem, depth: number, underHidden: boolean): Promise<void> => {
    if (!rem?._id || seen.has(rem._id)) return;
    seen.add(rem._id);

    // RemNote's hidden References portal is still walked — flagged, never pushed — so the hash a
    // note carried before these were skipped can be reproduced (see `buildNoteForDoc`).
    const hidden = underHidden || (await isSearchPortal(rem));
    const resolve = hidden ? refHidden : ref;
    const front = (await richTextToPlain(rem.text, resolve, { alias: opts.alias })).trim();
    let html = (await richTextToHtml(rem.text, resolve, htmlOpts)).trim();
    // A flashcard shows its back after an arrow; a concept's front in bold, a descriptor's in italic.
    const backRt = rem.type !== RemType.PORTAL && Array.isArray(rem.backText) && rem.backText.length ? rem.backText : undefined;
    const back = backRt ? (await richTextToPlain(backRt, resolve, { alias: opts.alias })).trim() : '';
    const text = back ? `${front} ${ARROW.forward} ${back}`.trim() : front;
    if (back) {
      if (rem.type === RemType.CONCEPT) html = `<strong>${html}</strong>`;
      else if (rem.type === RemType.DESCRIPTOR) html = `<em>${html}</em>`;
      const dir = rich ? await swallow(Promise.resolve(rem.getPracticeDirection?.()), undefined as any) : undefined;
      const arrow = dir === 'both' ? ARROW.both : dir === 'backward' ? ARROW.backward : ARROW.forward;
      html = `${html} ${arrow} ${(await richTextToHtml(backRt, resolve, htmlOpts)).trim()}`.trim();
    }
    // Before 2026-11-06: the front only, with every reference as its target's name. Looked up through
    // `refHidden`, which never counts an unreadable link — this text is never pushed.
    const legacyText = (await richTextToPlain(rem.text, refHidden, { legacy: true })).trim();
    if (rich && !hidden && html) {
      // A rem's own highlight colours its whole row in RemNote; its tags sit at the end.
      const hl = remnoteColour(await swallow(Promise.resolve(rem.getHighlightColor?.()), undefined as any), RN_HIGHLIGHT_CSS);
      if (hl) html = `<span style="background-color: ${hl}">${html}</span>`;
      const chips = await tagChips(rem);
      if (chips) html = `${html} ${chips}`;
    }
    let kind: NoteLine['kind'] = 'bullet';
    let headingLevel: NoteLine['headingLevel'];
    let url: string | undefined;

    if (rem.type === RemType.PORTAL) {
      kind = 'portal';
    } else if (rich && !hidden) {
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

    if (text || legacyText || kind !== 'bullet')
      lines.push({ depth, text, legacyText, html, kind, headingLevel, url, ...(hidden ? { hidden: true } : {}) });

    // A sub-document's own contents live in its own note; don't inline them.
    if (kind === 'document') return;
    // A heading RESETS indentation: its children restart at depth 0 rather than nesting under
    // it. That is the mirror's behaviour (remnote_convert.py sets child_depth = 0 for headings),
    // and matching it keeps our hash stable against the reference format.
    const childDepth = kind === 'heading' ? 0 : depth + 1;
    const kidIds: string[] = rem.children ?? [];
    for (const id of kidIds) {
      const kid = byId.get(id);
      if (kid) await walk(kid, childDepth, hidden);
    }
  };

  for (const r of roots) await walk(r, 0, false);
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
 * Zotero note HTML. Only tags in the note-editor ProseMirror schema are emitted (p, h1-h3, ul, li,
 * a, strong, em, u, s, sub, sup, code, and spans carrying a colour or background colour) so nothing
 * is dropped when the note is edited.
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
