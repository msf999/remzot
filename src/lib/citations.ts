/**
 * Inline citation numbers → citekeys (2026-11-05): the pure half of "Remzot: Convert Inline
 * Citations". No host calls, so every rule here can be unit-tested off RemNote.
 *
 *   - `findCitationGroups` — the "[2]", "[2,3]", "[34–37]" groups in a run of text.
 *   - `numberReferences`   — each Crossref reference's citation number, read from its deposit `key`.
 *   - `scanRichText`       — where the groups sit in a rem's rich text.
 *   - `rewriteRichText`    — turns a group into `\cite{‹ref›, ‹ref›}`, the form Rem2Tex's citekeys use.
 *
 * The engine that reads rems, fetches the reference list and writes the result is `citeConvert.ts`.
 */
import type { RichTextInterface } from '@remnote/plugin-sdk';

/** One bracketed group of citation numbers found in a run of text. */
export interface CitationGroup {
  /** Offset of the `[` in the text, and the offset just past the `]`. */
  start: number;
  end: number;
  /** The group exactly as written, e.g. "[10–12]". */
  raw: string;
  /** The numbers cited, in written order, ranges expanded, duplicates dropped. */
  numbers: number[];
  /** Why this may not be a citation at all (its numbers then start unticked), or undefined. */
  doubt?: string;
}

/** A widest range we expand: "[3–7]" is five citations; "[1–100]" is a range of values, not citations. */
export const MAX_RANGE = 50;

// "[" + item ("12" or "12-15", any dash) + more items after "," or ";" + "]". Four digits at most.
const GROUP_RE = /\[\s*(\d{1,4}(?:\s*[-–—]\s*\d{1,4})?(?:\s*[,;]\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)*)\s*\]/g;
// A crystal direction is the usual non-citation in a materials paper: "along the [110] direction".
const DIRECTION_AFTER = /^\s*-?\s*(?:directions?|ax[ie]s|orient\w*|planes?|zones?|surfaces?|facets?|azimuth|edges?)\b/i;
// A bracket right after a LaTeX command is that command's optional argument: \cite[12]{x}, \item[3].
const LATEX_COMMAND_BEFORE = /\\[A-Za-z]+\*?\s*(?:\[[^\]]*\]\s*)?$/;

/** Find every citation group in a run of plain text. */
export function findCitationGroups(text: string): CitationGroup[] {
  const out: CitationGroup[] = [];
  const re = new RegExp(GROUP_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    // An optional LaTeX argument — before a "{" or after a command — is never a citation number.
    if (text[end] === '{' || LATEX_COMMAND_BEFORE.test(text.slice(Math.max(0, start - 60), start))) continue;

    const numbers: number[] = [];
    let leadingZero = false;
    let ok = true;
    for (const item of m[1].split(/[,;]/)) {
      const [a, b] = item.split(/[-–—]/).map((s) => s.trim());
      if (/^0\d/.test(a) || (b !== undefined && /^0\d/.test(b))) leadingZero = true;
      const from = Number(a);
      const to = b === undefined ? from : Number(b);
      // "[5–3]", "[10–10]" (a hexagonal direction) and "[1–100]" are not citation ranges.
      if (b !== undefined && (to <= from || to - from + 1 > MAX_RANGE)) {
        ok = false;
        break;
      }
      for (let n = from; n <= to; n++) if (!numbers.includes(n)) numbers.push(n);
    }
    if (!ok || !numbers.length) continue;

    let doubt: string | undefined;
    if (leadingZero) doubt = 'it has a leading zero, like a crystal direction';
    else if (DIRECTION_AFTER.test(text.slice(end, end + 30))) doubt = 'a word like "direction" follows it';
    out.push({ start, end, raw: m[0], numbers, ...(doubt ? { doubt } : {}) });
  }
  return mergeBracketRanges(text, out);
}

/** IEEE writes a range across brackets: "[3]–[5]" is 3, 4 and 5. Merge such pairs into one group. */
function mergeBracketRanges(text: string, groups: CitationGroup[]): CitationGroup[] {
  const out: CitationGroup[] = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    const single = (x: CitationGroup): boolean => x.numbers.length === 1 && !/[-–—,;]/.test(x.raw);
    if (prev && single(prev) && single(g) && /^\s*[-–—]\s*$/.test(text.slice(prev.end, g.start))) {
      const from = prev.numbers[0];
      const to = g.numbers[0];
      if (to > from && to - from + 1 <= MAX_RANGE) {
        const numbers: number[] = [];
        for (let n = from; n <= to; n++) numbers.push(n);
        const doubt = prev.doubt ?? g.doubt;
        out[out.length - 1] = { start: prev.start, end: g.end, raw: text.slice(prev.start, g.end), numbers, ...(doubt ? { doubt } : {}) };
        continue;
      }
    }
    out.push(g);
  }
  return out;
}

/** A reference's place in the paper's list: its citation number, and its order under that number. */
export interface RefNumber {
  n: number;
  /** Several works can share one number ("[5] (a) …; (b) …"); `part` orders them. 0 if unknown. */
  part: number;
}

/**
 * The citation number of each reference, worked out from the `key`s Crossref deposits carry.
 * Publishers write them differently — `ref12`, `…_CR12`, `…_c12` (the last digit group),
 * `PhysRevB…Cc12R1` (APS: R2 is a second work under [12]), `ref12/cit14` (ACS), `(cit12)/*[position()=1]`
 * (RSC), `e_1_2_11_13_1` (Wiley, numbered from 2) and `…_bib0060` (Elsevier, in steps of 5) — so this
 * takes the FIRST digit group that differs between references as the number and the next one as the
 * part, then reads the numbers as written when they start at 1, divided by the step when they count
 * in steps, and by rank otherwise. Checked against fifteen papers from ten publishers on 2026-11-05.
 *
 * Returns null when the keys can't number the list (author-year keys, keys with no digits).
 */
export function numberReferences(keys: (string | null | undefined)[]): RefNumber[] | null {
  if (!keys.length) return null;
  const groups = keys.map((k) => ((k ?? '').match(/\d+/g) ?? []).map(Number));
  if (groups.some((g) => !g.length)) return null;
  if (keys.length === 1) return [{ n: 1, part: 0 }];

  const width = Math.max(...groups.map((g) => g.length));
  const varying: number[] = [];
  for (let pos = 0; pos < width; pos++) {
    const values = new Set(groups.filter((g) => g.length > pos).map((g) => g[pos]));
    if (values.size > 1) varying.push(pos);
  }
  if (!varying.length) return null;
  const [numberPos, partPos] = varying;
  if (groups.some((g) => g.length <= numberPos)) return null;

  const raw = groups.map((g) => ({
    n: g[numberPos],
    part: partPos !== undefined && g.length > partPos ? g[partPos] : 0,
  }));
  const values = [...new Set(raw.map((r) => r.n))].sort((a, b) => a - b);
  const gcd = values.reduce((a, b) => {
    let x = a;
    let y = b;
    while (y) [x, y] = [y, x % y];
    return x;
  });
  let toNumber: (n: number) => number;
  if (values[0] === 1) toNumber = (n) => n;
  else if (gcd > 1 && values[0] === gcd) toNumber = (n) => n / gcd;
  else {
    const rank = new Map(values.map((v, i) => [v, i + 1]));
    toNumber = (n) => rank.get(n) as number;
  }
  return raw.map((r) => ({ n: toNumber(r.n), part: r.part }));
}

/** A citation group's place in a rem's rich text. */
export interface FoundGroup {
  /** Index of the rich-text element holding the group; the group's offsets are within its text. */
  elIndex: number;
  group: CitationGroup;
  /** The whole element is the group: a LaTeX element holding just "[31,32]". */
  wholeElement?: boolean;
}

// Formatting a citation may carry and still be rewritten: bold, italic, underline, highlight colour,
// text colour. Clozes, links, code and comments are left alone.
const PLAIN_FORMAT_KEYS = new Set(['i', 'text', 'b', 'l', 'u', 'h', 'tc']);

/** Every citation group in a rem's rich text that may be rewritten. */
export function scanRichText(rt: RichTextInterface | undefined | null): FoundGroup[] {
  if (!Array.isArray(rt)) return [];
  const out: FoundGroup[] = [];
  (rt as unknown[]).forEach((el, elIndex) => {
    if (typeof el === 'string') {
      for (const group of findCitationGroups(el)) out.push({ elIndex, group });
      return;
    }
    if (!el || typeof el !== 'object') return;
    const e = el as Record<string, unknown>;
    if (e.i === 'm' && typeof e.text === 'string' && Object.keys(e).every((k) => PLAIN_FORMAT_KEYS.has(k))) {
      for (const group of findCitationGroups(e.text)) out.push({ elIndex, group });
      return;
    }
    // Some PDF copies come out with the citation as a LaTeX element of its own ("$[31,32]$").
    if (e.i === 'x' && typeof e.text === 'string' && !e.block && !e.cId) {
      const text = e.text.trim();
      const found = findCitationGroups(text);
      if (found.length === 1 && found[0].start === 0 && found[0].end === text.length) {
        out.push({ elIndex, group: { ...found[0], start: 0, end: e.text.length }, wholeElement: true });
      }
    }
  });
  return out;
}

/** One group to rewrite. */
export interface GroupEdit {
  elIndex: number;
  start: number;
  end: number;
  /** The papers' docs to cite, in order. */
  remIds: string[];
  /** Numbers in the group that were NOT converted; they stay behind as "[n, m]". */
  leftover: number[];
}

/**
 * The rich text with each edited group replaced by `\cite{‹ref›, ‹ref›}` (references to the papers'
 * docs) followed by any numbers left behind. The text around a group keeps its formatting; elements
 * without an edit are untouched. Neighbouring plain strings are joined.
 */
export function rewriteRichText(rt: RichTextInterface, edits: GroupEdit[]): RichTextInterface {
  const byElement = new Map<number, GroupEdit[]>();
  for (const e of edits) {
    const list = byElement.get(e.elIndex) ?? [];
    list.push(e);
    byElement.set(e.elIndex, list);
  }
  const out: unknown[] = [];
  (rt as unknown[]).forEach((el, i) => {
    const list = byElement.get(i)?.slice().sort((a, b) => a.start - b.start);
    if (!list?.length) {
      out.push(el);
      return;
    }
    const formatted = typeof el === 'object' && el !== null && (el as { i?: string }).i === 'm';
    const text: string = typeof el === 'string' ? el : String((el as { text?: string }).text ?? '');
    const keep = (s: string): void => {
      if (s) out.push(formatted ? { ...(el as object), text: s } : s);
    };
    let pos = 0;
    for (const e of list) {
      keep(text.slice(pos, e.start));
      if (e.remIds.length) {
        out.push('\\cite{');
        e.remIds.forEach((id, k) => {
          if (k) out.push(', ');
          out.push({ i: 'q', _id: id });
        });
        out.push('}');
      }
      if (e.leftover.length) keep(`[${e.leftover.join(', ')}]`);
      pos = e.end;
    }
    keep(text.slice(pos));
  });
  const merged: unknown[] = [];
  for (const el of out) {
    const last = merged.length - 1;
    if (typeof el === 'string' && typeof merged[last] === 'string') merged[last] = (merged[last] as string) + el;
    else merged.push(el);
  }
  return merged as RichTextInterface;
}

/** The text around a group, for showing where it sits: up to `width` characters each side. */
export function contextOf(text: string, start: number, end: number, width = 70): { before: string; match: string; after: string } {
  const from = Math.max(0, start - width);
  const to = Math.min(text.length, end + width);
  return {
    before: (from > 0 ? '…' : '') + text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to) + (to < text.length ? '…' : ''),
  };
}
