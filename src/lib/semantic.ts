/**
 * Citation-graph data layer for the on-page menu's citations bar.
 *
 * Aggregates a paper's REFERENCES (works it cites) and CITATIONS (works that cite it) from FOUR
 * free, no-auth sources, deduped into a UNIQUE union (by DOI) so we don't miss any, with per-item
 * source provenance and an in-library flag:
 *   - Semantic Scholar (Graph API)  — /references + /citations lists (often sparse on references).
 *   - Crossref                       — reference list WITH DOIs (no citing list — count only there).
 *   - OpenAlex                       — referenced_works (IDs → resolved to DOIs) + cited_by (DOIs).
 *   - OpenCitations (Index v2/COCI)  — reference/citation lists; each entry carries BOTH doi + openalex.
 *
 * Each source is fetched independently and never throws — a failure just contributes nothing. The
 * merged unique lists drive the bar's reference/citation COUNTS and
 * the inline collapsible item lists; the in-library subset is the "related library items". Results
 * are cached per DOI (module-level) so each item is fetched once per session.
 *
 * Metadata for display (title/authors/year/venue) is taken from whichever source has it (OpenAlex + S2
 * are richest; Crossref partial; OpenCitations DOI-only). After merging, any row that has a DOI but is
 * still missing its title/year/publication/authors is BACKFILLED by DOI via `enrichMissing` (OpenAlex →
 * Crossref → Semantic Scholar) — this is what fills in the otherwise-sparse Crossref reference rows.
 * "Add to Zotero" later re-fetches clean metadata per DOI via Citoid, so display metadata here is
 * best-effort.
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import { HIERARCHY, SLOTS, ZOTERO_ITEM_POWERUP } from './consts';

/** Short source labels shown per item, e.g. "(Semantic, Crossref)". */
export type SourceName = 'Semantic' | 'Crossref' | 'OpenAlex' | 'OpenCitations';
export const ALL_SOURCES: SourceName[] = ['Semantic', 'Crossref', 'OpenAlex', 'OpenCitations'];

/** A synced item doc, for the DOI→doc index. */
export interface LibDoc {
  remId: string;
  name: string;
}

/** One source's clickable landing page for a work (the "(Semantic, OpenAlex)" links). */
export interface SourceLink {
  name: SourceName;
  /** The work's page on that source (S2 paper page / OpenAlex work page / doi.org for the rest). */
  url: string;
}

/** scite.ai "Smart Citations" tallies for a DOI — counts of citing STATEMENTS in scite's four
 *  categories (their sum is the total citation statements). */
export interface SciteTally {
  supporting: number;
  mentioning: number;
  contradicting: number;
  unclassified: number;
}

/** One reference/citation work in the merged unique union. */
export interface RelatedPaper {
  /** Normalized bare DOI ('' if none — then keyed by title for dedup). */
  doi: string;
  title: string;
  /** Raw citation string shown only when no real title exists (e.g. Crossref `unstructured` for a
   *  reference with no `article-title` that enrichment couldn't resolve). */
  fallbackTitle?: string;
  authors: string;
  year: string;
  url: string;
  /** Which sources reported this work (for the "(…)" provenance label). */
  sources: SourceName[];
  /** Per-source landing-page links (one per contributing source) — the clickable "(…)" parens. */
  sourceLinks: SourceLink[];
  /** Citation count for the popularity sort (max across sources; 0 if unknown). */
  citationCount: number;
  /** Journal / venue / publisher, for display + the "all metadata" search scope ('' if unknown). */
  venue: string;
  /** Abstract, for the "all metadata" search scope ('' if a source didn't provide one). */
  abstract: string;
  /** Insertion index in the merged union (= the "Default" sort order). For references this is
   *  Crossref-first, so it approximates the in-document reference-list order. */
  order: number;
  /** True if a synced `Zotero/Items` doc has this DOI. */
  inLibrary: boolean;
  /** The library doc's rem id (for navigation) when inLibrary; '' otherwise. */
  remId: string;
  /** Relationship of this paper TO the current item, shown on the "In Library" tab — a "·"-joined
   *  subset of "cited by this" (it's a reference), "cites this" (it's a citation), "related" (an
   *  OpenAlex/S2 related work). Set only on the widget's In-Library copies. */
  relationship?: string;
}

/** A paper's reference/citation union, the in-library subset, and topically-related works. */
export interface MultiSourceResult {
  references: RelatedPaper[];
  citations: RelatedPaper[];
  /** (references ∪ citations) that are in the library, deduped. NOTE: the widget recomputes its own
   *  richer "In Library" list (also folding in `relatedWorks` + relationship labels); this field is
   *  kept only for `registerAddedItem`'s in-place flip. */
  related: RelatedPaper[];
  /** Topically-related works (NOT citation-linked) — the union of OpenAlex `related_works` + Semantic
   *  Scholar recommendations, deduped. Drives the "Related" tab. */
  relatedWorks: RelatedPaper[];
}

/** A raw work from one source before merging (no provenance/library info yet). */
interface RawPaper {
  doi: string;
  title: string;
  /** A raw citation string to show ONLY if no real title is found (Crossref `unstructured`). Kept
   *  separate from `title` so enrichMissing still backfills the real title for DOI'd rows. */
  fallbackTitle?: string;
  authors: string;
  year: string;
  /** This source's public landing page for the work ('' → caller falls back to doi.org). */
  sourceUrl: string;
  /** Citation count from this source (0 if it doesn't provide one). */
  citationCount: number;
  /** Journal / venue / publisher ('' if not provided). */
  venue: string;
  /** Abstract ('' if not provided by this source). */
  abstract: string;
}

const OPENALEX_RESOLVE_BATCH = 50; // OpenAlex filter `openalex:W1|W2|…` page size (references fallback).
const OPENALEX_CITES_PAGE = 200; // OpenAlex per-page max.
const OPENALEX_CITES_MAX_PAGES = 3; // cap cited_by paging (≤600) to bound mount cost; note if truncated.
const SEMANTIC_LIST_LIMIT = 1000; // S2/OpenCitations single-page list cap.
const SEMANTIC_REC_LIMIT = 50; // S2 recommendations ("Related" tab) cap (endpoint max 500).

// ───────────────────────── DOI helpers ─────────────────────────

/** Normalize a DOI for matching: lowercase, strip a doi.org/dx/www prefix + trailing slashes. */
export function normalizeDoi(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.|dx\.)?doi\.org\//, '')
    .replace(/\/+$/, '');
}

/** Encode a DOI for a URL PATH segment: keep "/" raw (all four APIs want it unescaped; %2F is
 *  unreliable), percent-encode other URL-significant chars (#, ?, &, <, >, space, …). */
export function encodeDoiPath(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/gi, '/');
}

/** Pull the `doi:<doi>` token out of an OpenCitations v2 PID string ("omid:… doi:10.x openalex:W…"). */
function doiFromOcPids(pids: string | undefined): string {
  if (!pids) return '';
  const m = pids.match(/doi:(\S+)/i);
  return normalizeDoi(m ? m[1] : '');
}

/** Summarize an author array to "A" / "A, B" / "A et al.". Accepts S2/OpenAlex/Crossref shapes. */
function authorsSummary(names: string[]): string {
  const clean = names.map((n) => (n ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length <= 2) return clean.join(', ');
  return `${clean[0]} et al.`;
}

/** Rebuild an abstract string from OpenAlex's `abstract_inverted_index` (word → positions). '' if
 *  absent. Capped so a pathological index can't bloat the cached payload. */
function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return '';
  const at: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const i of positions) if (i >= 0 && i < 5000) at[i] = word;
  }
  return at.filter((w) => w !== undefined).join(' ').trim();
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the HTML entities that show up in source titles (`&amp;`, `&lt;`, numeric `&#x3b1;`, …). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Strip inline HTML/MathML markup + decode entities from a title. Crossref `article-title` (and some
 *  OpenAlex/S2 titles) embed `<sub>`/`<sup>`/`<i>`/`<mml:*>` tags + entities that would otherwise render
 *  as literal text (e.g. "BiFeO `<sub>3</sub>` Thin Films"). Tags are removed keeping their inner text
 *  (so `<sub>3</sub>` → `3`); the whitespace the pretty-printed XML left behind is collapsed. */
function sanitizeTitle(s: string): string {
  if (!s) return s;
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// ───────────────────────── Per-source fetchers (each catches → []) ─────────────────────────

/** Crossref references (DOIs + partial metadata). Crossref has no citing list. */
async function crossrefRefs(doi: string): Promise<RawPaper[]> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeDoiPath(doi)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      message?: {
        reference?: {
          DOI?: string;
          'article-title'?: string;
          'volume-title'?: string;
          'journal-title'?: string;
          unstructured?: string;
          year?: string;
          author?: string;
        }[];
      };
    };
    return (j.message?.reference ?? []).map((r) => ({
      doi: normalizeDoi(r.DOI),
      // Real title only. `unstructured` (a raw citation string) is NOT a title — keep it as a fallback
      // so enrichMissing still fetches the real title by DOI (Crossref refs often have only unstructured).
      title: (r['article-title'] || r['volume-title'] || '').toString().trim(),
      fallbackTitle: (r.unstructured || '').toString().trim() || undefined,
      authors: (r.author ?? '').toString().trim(),
      year: (r.year ?? '').toString().trim(),
      sourceUrl: '', // Crossref has no per-item public page → merge falls back to doi.org.
      citationCount: 0, // not in the reference array.
      venue: (r['journal-title'] ?? '').toString().trim(),
      abstract: '',
    }));
  } catch {
    return [];
  }
}

/** Semantic Scholar Graph API references OR citations list (resolved-DOI works). */
async function s2List(doi: string, kind: 'references' | 'citations'): Promise<RawPaper[]> {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeDoiPath(
      doi
    )}/${kind}?fields=title,year,authors,externalIds,paperId,url,citationCount,venue,abstract&limit=${SEMANTIC_LIST_LIMIT}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      data?: { citedPaper?: S2Paper; citingPaper?: S2Paper }[];
    };
    const nested = kind === 'references' ? 'citedPaper' : 'citingPaper';
    return (j.data ?? [])
      .map((row) => row?.[nested])
      .filter((p): p is S2Paper => !!p)
      .map((p) => ({
        doi: normalizeDoi(p.externalIds?.DOI),
        title: (p.title ?? '').trim(),
        authors: authorsSummary((p.authors ?? []).map((a) => a?.name ?? '')),
        year: p.year ? String(p.year) : '',
        // S2's `url` IS the public paper page (a bare-DOI path 404s); keep it for the source link.
        sourceUrl: (p.url ?? '').trim(),
        citationCount: typeof p.citationCount === 'number' ? p.citationCount : 0,
        venue: (p.venue ?? '').trim(),
        abstract: (p.abstract ?? '').trim(),
      }));
  } catch {
    return [];
  }
}
interface S2Paper {
  title?: string | null;
  year?: number | string | null;
  authors?: { name?: string }[];
  externalIds?: { DOI?: string | null } | null;
  paperId?: string | null;
  url?: string | null;
  citationCount?: number | null;
  venue?: string | null;
  abstract?: string | null;
}

/** An OpenAlex work object (the fields we request). */
interface OAWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  authorships?: { author?: { display_name?: string } }[];
  referenced_works?: string[];
  related_works?: string[];
  cited_by_api_url?: string;
  cited_by_count?: number | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}
function oaToRaw(w: OAWork): RawPaper {
  const oaId = (w.id ?? '').split('/').pop() ?? ''; // "https://openalex.org/W123" → "W123"
  return {
    doi: normalizeDoi(w.doi),
    title: (w.title ?? '').trim(),
    authors: authorsSummary((w.authorships ?? []).map((a) => a?.author?.display_name ?? '')),
    year: w.publication_year ? String(w.publication_year) : '',
    sourceUrl: oaId ? `https://openalex.org/works/${oaId}` : '',
    citationCount: typeof w.cited_by_count === 'number' ? w.cited_by_count : 0,
    venue: (w.primary_location?.source?.display_name ?? '').trim(),
    abstract: reconstructAbstract(w.abstract_inverted_index),
  };
}

/** OpenAlex CITATIONS only (cited_by, paginated/capped). References come from Crossref alone now, so
 *  we no longer resolve OpenAlex's `referenced_works` (drops the batched ID-resolution fetches). */
async function openAlexCitations(doi: string): Promise<RawPaper[]> {
  try {
    const wRes = await fetch(`https://api.openalex.org/works/doi:${encodeDoiPath(doi)}?select=id`, {
      headers: { Accept: 'application/json' },
    });
    if (!wRes.ok) return [];
    const work = (await wRes.json()) as OAWork;
    const oaId = (work.id ?? '').split('/').pop() ?? ''; // "https://openalex.org/W123" → "W123"
    if (!oaId) return [];

    const citations: RawPaper[] = [];
    for (let page = 1; page <= OPENALEX_CITES_MAX_PAGES; page += 1) {
      const r = await fetch(
        `https://api.openalex.org/works?filter=cites:${oaId}&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,abstract_inverted_index&per-page=${OPENALEX_CITES_PAGE}&page=${page}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!r.ok) break;
      const jr = (await r.json()) as { results?: OAWork[] };
      const rows = jr.results ?? [];
      for (const w of rows) citations.push(oaToRaw(w));
      if (rows.length < OPENALEX_CITES_PAGE) break;
    }
    return citations;
  } catch {
    return [];
  }
}

/** OpenAlex REFERENCES — resolve the work's `referenced_works` IDs → DOIs+metadata (50/batch). Only
 *  used as a FALLBACK reference source when Crossref has no reference data for the DOI. */
async function openAlexReferences(doi: string): Promise<RawPaper[]> {
  try {
    const wRes = await fetch(`https://api.openalex.org/works/doi:${encodeDoiPath(doi)}?select=referenced_works`, {
      headers: { Accept: 'application/json' },
    });
    if (!wRes.ok) return [];
    const work = (await wRes.json()) as OAWork;
    const refIds = (work.referenced_works ?? []).map((u) => u.split('/').pop() ?? '').filter(Boolean);
    const references: RawPaper[] = [];
    for (let i = 0; i < refIds.length; i += OPENALEX_RESOLVE_BATCH) {
      const batch = refIds.slice(i, i + OPENALEX_RESOLVE_BATCH);
      const r = await fetch(
        `https://api.openalex.org/works?filter=openalex:${batch.join(
          '|'
        )}&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,abstract_inverted_index&per-page=${OPENALEX_RESOLVE_BATCH}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!r.ok) break;
      const jr = (await r.json()) as { results?: OAWork[] };
      for (const w of jr.results ?? []) references.push(oaToRaw(w));
    }
    return references;
  } catch {
    return [];
  }
}

/** OpenAlex RELATED works — the work's `related_works` (topically related, NOT citation-linked: 0
 *  overlap with references/citations in testing) resolved to DOIs+metadata (50/batch). Drives the
 *  "Related" tab alongside the S2 recommendations. */
async function openAlexRelated(doi: string): Promise<RawPaper[]> {
  try {
    const wRes = await fetch(`https://api.openalex.org/works/doi:${encodeDoiPath(doi)}?select=related_works`, {
      headers: { Accept: 'application/json' },
    });
    if (!wRes.ok) return [];
    const work = (await wRes.json()) as OAWork;
    const ids = (work.related_works ?? []).map((u) => u.split('/').pop() ?? '').filter(Boolean);
    const out: RawPaper[] = [];
    for (let i = 0; i < ids.length; i += OPENALEX_RESOLVE_BATCH) {
      const batch = ids.slice(i, i + OPENALEX_RESOLVE_BATCH);
      const r = await fetch(
        `https://api.openalex.org/works?filter=openalex:${batch.join(
          '|'
        )}&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,abstract_inverted_index&per-page=${OPENALEX_RESOLVE_BATCH}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!r.ok) break;
      const jr = (await r.json()) as { results?: OAWork[] };
      for (const w of jr.results ?? []) out.push(oaToRaw(w));
    }
    return out;
  } catch {
    return [];
  }
}

/** Semantic Scholar RECOMMENDATIONS — topically-related papers for a DOI (the free, no-key
 *  `recommendations/v1/papers/forpaper/DOI:<doi>` endpoint). Another "related works" source. */
async function s2Recommendations(doi: string): Promise<RawPaper[]> {
  try {
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/DOI:${encodeDoiPath(
      doi
    )}?fields=title,year,authors,externalIds,paperId,url,citationCount,venue,abstract&limit=${SEMANTIC_REC_LIMIT}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const j = (await res.json()) as { recommendedPapers?: S2Paper[] };
    return (j.recommendedPapers ?? []).map((p) => ({
      doi: normalizeDoi(p.externalIds?.DOI),
      title: (p.title ?? '').trim(),
      authors: authorsSummary((p.authors ?? []).map((a) => a?.name ?? '')),
      year: p.year ? String(p.year) : '',
      sourceUrl: (p.url ?? '').trim(),
      citationCount: typeof p.citationCount === 'number' ? p.citationCount : 0,
      venue: (p.venue ?? '').trim(),
      abstract: (p.abstract ?? '').trim(),
    }));
  } catch {
    return [];
  }
}

/** OpenCitations Index v2 references OR citations — DOI-only (no display metadata). */
async function openCitationsList(doi: string, kind: 'references' | 'citations'): Promise<RawPaper[]> {
  try {
    const res = await fetch(`https://opencitations.net/index/api/v2/${kind}/doi:${encodeDoiPath(doi)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as { citing?: string; cited?: string }[];
    // references rows: the OTHER work is `cited`; citations rows: it's `citing`.
    const field = kind === 'references' ? 'cited' : 'citing';
    return rows
      .map((row) => ({
        doi: doiFromOcPids(row[field]),
        title: '',
        authors: '',
        year: '',
        sourceUrl: '', // OpenCitations has no per-item page → merge falls back to doi.org.
        citationCount: 0,
        venue: '',
        abstract: '',
      }))
      .filter((p) => p.doi);
  } catch {
    return [];
  }
}

// ───────────────────────── Merge into the unique union ─────────────────────────

/** Merge per-source raw lists into a unique, provenance-tagged, library-flagged list. Dedup by DOI
 *  (or by lowercased title when a work has no DOI); keep the richest metadata across sources. */
function mergeUnique(
  tagged: { source: SourceName; papers: RawPaper[] }[],
  index: Map<string, LibDoc>,
  selfDoi: string
): RelatedPaper[] {
  const self = normalizeDoi(selfDoi);
  const byKey = new Map<string, RelatedPaper>();
  const better = (next: string, cur: string): string => (next.length > cur.length ? next : cur);

  for (const { source, papers } of tagged) {
    for (const p of papers) {
      const doi = normalizeDoi(p.doi);
      if (doi && doi === self) continue; // skip self-reference
      const dispTitle = p.title || p.fallbackTitle || '';
      const key = doi ? `doi:${doi}` : dispTitle ? `title:${dispTitle.toLowerCase()}` : '';
      if (!key) continue; // no DOI and no title → nothing to dedup/show
      // This source's clickable landing page for the work: its own page if it has one, else the
      // universal doi.org fallback (so Crossref/OpenCitations links still go to the paper).
      const link = p.sourceUrl || (doi ? `https://doi.org/${doi}` : '');
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (link && !existing.sourceLinks.some((s) => s.name === source))
          existing.sourceLinks.push({ name: source, url: link });
        existing.title = better(sanitizeTitle(p.title), existing.title);
        if (!existing.fallbackTitle && p.fallbackTitle) existing.fallbackTitle = sanitizeTitle(p.fallbackTitle);
        existing.authors = better(p.authors, existing.authors);
        existing.year = existing.year || p.year;
        existing.url = existing.url || link;
        existing.citationCount = Math.max(existing.citationCount, p.citationCount);
        existing.venue = better(p.venue, existing.venue);
        existing.abstract = existing.abstract || p.abstract;
      } else {
        const lib = doi ? index.get(doi) : undefined;
        byKey.set(key, {
          doi,
          title: sanitizeTitle(p.title),
          fallbackTitle: p.fallbackTitle ? sanitizeTitle(p.fallbackTitle) : p.fallbackTitle,
          authors: p.authors,
          year: p.year,
          url: link,
          sources: [source],
          sourceLinks: link ? [{ name: source, url: link }] : [],
          citationCount: p.citationCount,
          venue: p.venue,
          abstract: p.abstract,
          // Insertion index = "Default" order (Crossref-first → ≈ document reference order).
          order: byKey.size,
          inLibrary: !!lib,
          remId: lib?.remId ?? '',
        });
      }
    }
  }

  // Sort: in-library first, then newest year, then title.
  return [...byKey.values()].sort((a, b) => {
    if (a.inLibrary !== b.inLibrary) return a.inLibrary ? -1 : 1;
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;
    if (ay !== by) return by - ay;
    return a.title.localeCompare(b.title);
  });
}

// ───────────────────────── Metadata backfill (enrichment) ─────────────────────────

const ENRICH_FALLBACK_MAX = 40; // cap the per-DOI Crossref / batched S2 fallback (OpenAlex batch is uncapped).
const S2_BATCH = 100; // Semantic Scholar /paper/batch page size.

/** One OpenAlex request per 50 DOIs: `filter=doi:A|B|…` → DOI → full metadata. */
async function openAlexByDois(dois: string[]): Promise<Map<string, RawPaper>> {
  const out = new Map<string, RawPaper>();
  for (let i = 0; i < dois.length; i += OPENALEX_RESOLVE_BATCH) {
    const batch = dois.slice(i, i + OPENALEX_RESOLVE_BATCH);
    try {
      const r = await fetch(
        `https://api.openalex.org/works?filter=doi:${batch
          .map(encodeDoiPath)
          .join('|')}&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,abstract_inverted_index&per-page=${OPENALEX_RESOLVE_BATCH}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!r.ok) continue;
      const jr = (await r.json()) as { results?: OAWork[] };
      for (const w of jr.results ?? []) {
        const raw = oaToRaw(w);
        if (raw.doi) out.set(raw.doi, raw);
      }
    } catch {
      /* skip this batch */
    }
  }
  return out;
}

interface CrossrefWork {
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
}

/** Crossref single work by DOI → title/authors/year/venue (for the enrichment fallback). */
async function crossrefWork(doi: string): Promise<Partial<RawPaper>> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeDoiPath(doi)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return {};
    const m = ((await res.json()) as { message?: CrossrefWork }).message;
    if (!m) return {};
    const yr =
      m.issued?.['date-parts']?.[0]?.[0] ??
      m['published-print']?.['date-parts']?.[0]?.[0] ??
      m['published-online']?.['date-parts']?.[0]?.[0];
    return {
      title: (m.title?.[0] ?? '').trim(),
      authors: authorsSummary((m.author ?? []).map((a) => a.family || a.name || '')),
      year: yr ? String(yr) : '',
      venue: (m['container-title']?.[0] ?? '').trim(),
    };
  } catch {
    return {};
  }
}

/** Semantic Scholar /paper/batch by DOI → title/authors/year/venue (one POST per 100 DOIs). */
async function s2BatchWorks(dois: string[]): Promise<Map<string, Partial<RawPaper>>> {
  const out = new Map<string, Partial<RawPaper>>();
  for (let i = 0; i < dois.length; i += S2_BATCH) {
    const batch = dois.slice(i, i + S2_BATCH);
    try {
      const res = await fetch(
        'https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,year,venue,authors',
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: batch.map((d) => `DOI:${d}`) }),
        }
      );
      if (!res.ok) continue;
      const arr = (await res.json()) as (S2Paper | null)[];
      arr.forEach((p, idx) => {
        if (!p) return; // null = not found on S2
        out.set(batch[idx], {
          title: (p.title ?? '').trim(),
          authors: authorsSummary((p.authors ?? []).map((a) => a?.name ?? '')),
          year: p.year ? String(p.year) : '',
          venue: (p.venue ?? '').trim(),
        });
      });
    } catch {
      /* skip this batch */
    }
  }
  return out;
}

/** Run an async task over items with bounded concurrency (so the fallback can't open dozens of
 *  sockets at once). */
async function runCapped<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Backfill any merged row that has a DOI but is missing its title, year, publication (venue) or
 * authors — common for Crossref reference entries (which frequently carry only a DOI), and for
 * OpenCitations-only citations (DOI-only). Tries OpenAlex first (one batched request covers the bulk
 * cheaply), then Crossref, then a batched Semantic Scholar lookup — each only for the fields STILL
 * missing, and stopping once nothing needs more. Mutates the rows in place; never throws. The per-DOI
 * Crossref/S2 fallback is capped (OpenAlex usually resolves nearly everything in one request).
 */
async function enrichMissing(papers: RelatedPaper[]): Promise<void> {
  const needs = (p: RelatedPaper): boolean =>
    !!p.doi && (!p.title || !p.year || !p.venue || !p.authors);
  const apply = (p: RelatedPaper, m: Partial<RawPaper>): void => {
    if (!p.title && m.title) p.title = sanitizeTitle(m.title);
    if (!p.year && m.year) p.year = m.year;
    if (!p.venue && m.venue) p.venue = m.venue;
    if (!p.authors && m.authors) p.authors = m.authors;
    if (!p.abstract && m.abstract) p.abstract = m.abstract;
  };
  const pendingDois = (): string[] => [...new Set(papers.filter(needs).map((p) => p.doi))];

  if (pendingDois().length === 0) return;

  // 1) OpenAlex — batched, uncapped (best DOI coverage; fills most rows in one request burst).
  const oa = await openAlexByDois(pendingDois());
  for (const p of papers) {
    const m = oa.get(p.doi);
    if (m && needs(p)) apply(p, m);
  }

  // 2) Crossref — single work per still-missing DOI (capped count + concurrency).
  const crDois = pendingDois().slice(0, ENRICH_FALLBACK_MAX);
  const cr = new Map<string, Partial<RawPaper>>();
  await runCapped(crDois, 6, async (doi) => {
    cr.set(doi, await crossrefWork(doi));
  });
  for (const p of papers) {
    const m = cr.get(p.doi);
    if (m && needs(p)) apply(p, m);
  }

  // 3) Semantic Scholar — batched, for anything STILL missing.
  const s2 = await s2BatchWorks(pendingDois().slice(0, ENRICH_FALLBACK_MAX));
  for (const p of papers) {
    const m = s2.get(p.doi);
    if (m && needs(p)) apply(p, m);
  }
}

// ───────────────────────── scite.ai Smart Citations ─────────────────────────

const SCITE_BATCH = 250; // scite POST /tallies batch size.
const SCITE_MAX_FAILS = 3; // after this many consecutive total failures, stop hitting scite for the session.
/** Per-DOI scite tally cache (a `null` value = fetched, but scite has no record). */
const sciteCache = new Map<string, SciteTally | null>();
/** Consecutive-failure guard so a persistently down / CSP-blocked scite endpoint isn't re-hit on every
 *  navigation. Reset to 0 on any success; once it trips, fetchSciteTallies serves cache-only. */
let sciteFails = 0;
let sciteDisabled = false;

interface RawSciteTally {
  supporting?: number;
  contradicting?: number;
  mentioning?: number;
  unclassified?: number;
}
function toSciteTally(r: RawSciteTally): SciteTally {
  return {
    supporting: r.supporting ?? 0,
    mentioning: r.mentioning ?? 0,
    contradicting: r.contradicting ?? 0,
    unclassified: r.unclassified ?? 0,
  };
}

/** Fetch scite.ai Smart-Citation tallies for the given DOIs: `POST https://api.scite.ai/tallies` with a
 *  raw JSON ARRAY body → `{ tallies: { <doi>: {...} } }`. Batched + cached per DOI; never throws (a
 *  failure just yields no tally for those DOIs, left uncached so it retries — unless scite has failed
 *  SCITE_MAX_FAILS times in a row, after which it serves cache-only). Result keyed by normalized DOI. */
export async function fetchSciteTallies(dois: string[]): Promise<Map<string, SciteTally>> {
  const out = new Map<string, SciteTally>();
  const need: string[] = [];
  for (const raw of dois) {
    const d = normalizeDoi(raw);
    if (!d) continue;
    if (sciteCache.has(d)) {
      const cached = sciteCache.get(d);
      if (cached) out.set(d, cached);
    } else if (!need.includes(d)) {
      need.push(d);
    }
  }
  if (sciteDisabled) return out; // scite gave up for this session — serve whatever's cached.
  for (let i = 0; i < need.length; i += SCITE_BATCH) {
    const batch = need.slice(i, i + SCITE_BATCH);
    try {
      const res = await fetch('https://api.scite.ai/tallies', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        if ((sciteFails += 1) >= SCITE_MAX_FAILS) sciteDisabled = true;
        continue; // leave uncached → retry next time (until disabled)
      }
      const j = (await res.json()) as { tallies?: Record<string, RawSciteTally> };
      sciteFails = 0;
      const byDoi = new Map<string, RawSciteTally>();
      for (const [k, v] of Object.entries(j.tallies ?? {})) byDoi.set(normalizeDoi(k), v);
      for (const d of batch) {
        const raw = byDoi.get(d);
        const t = raw ? toSciteTally(raw) : null; // a record (even all-zero) is kept; no record → null
        sciteCache.set(d, t);
        if (t) out.set(d, t);
      }
    } catch {
      if ((sciteFails += 1) >= SCITE_MAX_FAILS) sciteDisabled = true;
      // network error — leave uncached so it retries on a later mount (until disabled)
    }
  }
  return out;
}

// ───────────────────────── Paper importance metrics ─────────────────────────

/** Per-paper importance signals shown on a reference/citation row's metrics line. */
export interface PaperMetrics {
  /** OpenAlex cited_by_count — authoritative total citations (Crossref reference rows lack one). */
  citedByCount: number;
  /** Semantic Scholar influentialCitationCount — citations that meaningfully built on the paper. */
  influential: number;
  /** Top 1% / 10% most-cited for its publication YEAR (OpenAlex), else null. */
  topPercent: 1 | 10 | null;
  /** OpenAlex is_retracted. */
  retracted: boolean;
  /** How many of this paper's OpenAlex `related_works` are in the user's library (relatedness proxy). */
  relatedInLibrary: number;
}

const metricsCache = new Map<string, PaperMetrics>();
const LIBRARY_WID_MAX_BATCHES = 12; // cap the library→OpenAlex-ID resolution (≤600 DOIs) for a huge KB.
/** The library's OpenAlex work-IDs (resolved once/session from the DOI index) — for related_works ∩ lib. */
let libraryWidsPromise: Promise<Set<string>> | null = null;

function oaId(url: string | undefined | null): string {
  return (url ?? '').split('/').pop() ?? ''; // "https://openalex.org/W123" → "W123"
}

/** Resolve the user's library DOIs → OpenAlex work-IDs (batched, capped, cached once/session). A failed
 *  build is not cached (retries). */
function getLibraryWids(plugin: RNPlugin): Promise<Set<string>> {
  if (!libraryWidsPromise) {
    libraryWidsPromise = (async () => {
      const wids = new Set<string>();
      const index = await getLibraryDoiIndex(plugin);
      const dois = [...index.keys()];
      const maxDois = LIBRARY_WID_MAX_BATCHES * OPENALEX_RESOLVE_BATCH;
      if (dois.length > maxDois) {
        console.info(
          `Remzot: library has ${dois.length} DOIs; resolving only the first ${maxDois} for "related in your library"`
        );
      }
      for (let i = 0; i < Math.min(dois.length, maxDois); i += OPENALEX_RESOLVE_BATCH) {
        const batch = dois.slice(i, i + OPENALEX_RESOLVE_BATCH);
        try {
          const r = await fetch(
            `https://api.openalex.org/works?filter=doi:${batch.map(encodeDoiPath).join('|')}&select=id&per-page=${OPENALEX_RESOLVE_BATCH}`,
            { headers: { Accept: 'application/json' } }
          );
          if (!r.ok) continue;
          const jr = (await r.json()) as { results?: { id?: string }[] };
          for (const w of jr.results ?? []) {
            const id = oaId(w.id);
            if (id) wids.add(id);
          }
        } catch {
          /* skip this batch */
        }
      }
      return wids;
    })().catch(() => {
      libraryWidsPromise = null; // don't cache a hard failure
      return new Set<string>();
    });
  }
  return libraryWidsPromise;
}

interface OAMetricWork {
  doi?: string | null;
  cited_by_count?: number | null;
  is_retracted?: boolean;
  citation_normalized_percentile?: { is_in_top_1_percent?: boolean; is_in_top_10_percent?: boolean } | null;
  related_works?: string[];
}

/** Fetch importance metrics (influential cites + top-percentile + retracted + related-in-library) for the
 *  given DOIs: OpenAlex batch (percentile / retracted / related_works) + Semantic Scholar batch
 *  (influentialCitationCount) + the library W-ID set for the related_works intersection. Batched + cached
 *  per DOI; never throws (missing signals just read as 0/false/null). Result keyed by normalized DOI. */
export async function fetchPaperMetrics(dois: string[], plugin: RNPlugin): Promise<Map<string, PaperMetrics>> {
  const out = new Map<string, PaperMetrics>();
  const need: string[] = [];
  for (const raw of dois) {
    const d = normalizeDoi(raw);
    if (!d) continue;
    const cached = metricsCache.get(d);
    if (cached) out.set(d, cached);
    else if (!metricsCache.has(d) && !need.includes(d)) need.push(d);
  }
  if (!need.length) return out;
  const libWids = await getLibraryWids(plugin).catch(() => new Set<string>());

  // OpenAlex: percentile / retracted / related_works (batched by DOI).
  const oa = new Map<string, OAMetricWork>();
  for (let i = 0; i < need.length; i += OPENALEX_RESOLVE_BATCH) {
    const batch = need.slice(i, i + OPENALEX_RESOLVE_BATCH);
    try {
      const r = await fetch(
        `https://api.openalex.org/works?filter=doi:${batch
          .map(encodeDoiPath)
          .join('|')}&select=doi,cited_by_count,is_retracted,citation_normalized_percentile,related_works&per-page=${OPENALEX_RESOLVE_BATCH}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!r.ok) continue;
      const jr = (await r.json()) as { results?: OAMetricWork[] };
      for (const w of jr.results ?? []) {
        const d = normalizeDoi(w.doi);
        if (d) oa.set(d, w);
      }
    } catch {
      /* skip this batch */
    }
  }

  // Semantic Scholar: influentialCitationCount (batched, results in input order).
  const inf = new Map<string, number>();
  for (let i = 0; i < need.length; i += S2_BATCH) {
    const batch = need.slice(i, i + S2_BATCH);
    try {
      const res = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=influentialCitationCount', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch.map((d) => `DOI:${d}`) }),
      });
      if (!res.ok) continue;
      const arr = (await res.json()) as ({ influentialCitationCount?: number } | null)[];
      arr.forEach((p, idx) => {
        if (p) inf.set(batch[idx], p.influentialCitationCount ?? 0);
      });
    } catch {
      /* skip this batch */
    }
  }

  for (const d of need) {
    const w = oa.get(d);
    const pct = w?.citation_normalized_percentile;
    const related = w?.related_works ?? [];
    const m: PaperMetrics = {
      citedByCount: typeof w?.cited_by_count === 'number' ? w.cited_by_count : 0,
      influential: inf.get(d) ?? 0,
      topPercent: pct?.is_in_top_1_percent ? 1 : pct?.is_in_top_10_percent ? 10 : null,
      retracted: !!w?.is_retracted,
      relatedInLibrary: libWids.size ? related.reduce((n, u) => n + (libWids.has(oaId(u)) ? 1 : 0), 0) : 0,
    };
    metricsCache.set(d, m);
    out.set(d, m);
  }
  return out;
}

/** Per-DOI cache of the combined multi-source union. */
const cache = new Map<string, MultiSourceResult>();

/**
 * Fetch a paper's references + citations. REFERENCES come from Crossref ALONE (it's the most
 * accurate + document-ordered; other sites appear only as per-row LINKS in the UI). CITATIONS are
 * the unique union of Semantic Scholar + OpenAlex + OpenCitations (Crossref has no citing list).
 * Returns null if there's no DOI. Never throws. Cached per DOI (one request burst per item/session).
 */
export async function fetchAllSources(doi: string, plugin: RNPlugin): Promise<MultiSourceResult | null> {
  const key = normalizeDoi(doi);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached) return cached;

  const [crRefs, s2Cites, oaCites, ocCites, oaRelated, s2Rec, index] = await Promise.all([
    crossrefRefs(key),
    s2List(key, 'citations'),
    openAlexCitations(key),
    openCitationsList(key, 'citations'),
    openAlexRelated(key),
    s2Recommendations(key),
    getLibraryDoiIndex(plugin).catch(() => new Map<string, LibDoc>()),
  ]);

  // References: Crossref alone when it has data (most accurate + document-ordered → origin "(Crossref)").
  // FALLBACK: if Crossref has NO reference data for this DOI (common for preprints/books/unregistered
  // works), use the S2 + OpenAlex + OpenCitations union so the list isn't falsely empty — only paying
  // that extra fetch when Crossref came back empty. (S2 first as it best preserves citation order.)
  let refSources: { source: SourceName; papers: RawPaper[] }[] = [{ source: 'Crossref', papers: crRefs }];
  if (crRefs.length === 0) {
    const [s2Refs, oaRefs, ocRefs] = await Promise.all([
      s2List(key, 'references'),
      openAlexReferences(key),
      openCitationsList(key, 'references'),
    ]);
    refSources = [
      { source: 'Semantic', papers: s2Refs },
      { source: 'OpenAlex', papers: oaRefs },
      { source: 'OpenCitations', papers: ocRefs },
    ];
  }
  const citeSources: { source: SourceName; papers: RawPaper[] }[] = [
    { source: 'Semantic', papers: s2Cites },
    { source: 'OpenAlex', papers: oaCites },
    { source: 'OpenCitations', papers: ocCites },
  ];

  const references = mergeUnique(refSources, index, key);
  const citations = mergeUnique(citeSources, index, key);
  // "Related" tab: OpenAlex related_works ∪ S2 recommendations — topically related, NOT citation-linked.
  const relatedWorks = mergeUnique(
    [
      { source: 'OpenAlex', papers: oaRelated },
      { source: 'Semantic', papers: s2Rec },
    ],
    index,
    key
  );

  // Backfill rows missing a title/year/publication/author (Crossref reference entries are usually
  // partial) by DOI — OpenAlex, then Crossref, then Semantic Scholar. Mutates in place BEFORE
  // relatedFrom so the in-library "related" copies inherit the enriched metadata.
  await enrichMissing([...references, ...citations, ...relatedWorks]);

  // NOTE: scite tallies are deliberately NOT fetched here — they're fetched separately in the widget
  // (off this cached/critical path) so (a) the bar/counts paint without waiting on scite, and (b) a
  // failed scite fetch retries on revisit instead of being frozen into this cached result.
  const result: MultiSourceResult = {
    references,
    citations,
    related: relatedFrom(references, citations),
    relatedWorks,
  };
  cache.set(key, result);
  return result;
}

/** The deduped in-library subset of (references ∪ citations) — a work can be BOTH a reference and a
 *  citation (mutual citation / errata), so dedup by DOI-or-title to avoid listing it twice. */
function relatedFrom(references: RelatedPaper[], citations: RelatedPaper[]): RelatedPaper[] {
  const seen = new Set<string>();
  const out: RelatedPaper[] = [];
  for (const p of [...references, ...citations]) {
    const k = p.doi ? `doi:${p.doi}` : `title:${p.title.toLowerCase()}`;
    if (p.inLibrary && !seen.has(k)) {
      seen.add(k);
      // Re-stamp a fresh sequential order: references and citations each restart `order` at 0, so
      // without this the merged list has duplicate orders and "Default" sort would tie.
      out.push({ ...p, order: out.length });
    }
  }
  return out;
}

// ───────────────────────── Library DOI index ─────────────────────────

/** Built once per session (lazy); a failed build is NOT cached (so it retries). */
let libIndexPromise: Promise<Map<string, LibDoc>> | null = null;

/** DOIs added THIS session, kept here too so they survive a null/rebuilt index (the rem may not
 *  have propagated into getChildrenRem yet); merged into every freshly built index. */
const sessionAdded = new Map<string, LibDoc>();

/** A DOI → synced-doc index for matching against the user's library. NOTE: in a partially-loaded KB
 *  (e.g. the web client) this only sees the locally-loaded item docs. */
export function getLibraryDoiIndex(plugin: RNPlugin): Promise<Map<string, LibDoc>> {
  if (!libIndexPromise) {
    libIndexPromise = buildLibraryDoiIndex(plugin).catch((err) => {
      libIndexPromise = null;
      throw err;
    });
  }
  return libIndexPromise;
}

/**
 * Reflect a just-added paper into the in-memory caches so it shows as in-library IMMEDIATELY this
 * session (no refetch): flips `inLibrary`/`remId` on any cached reference/citation with this DOI
 * (recomputing each result's `related` subset) and adds it to the library DOI index (so a later
 * navigation to another item sees it too). Called by the on-page menu after a successful Add.
 */
export function registerAddedItem(doi: string | undefined, remId: string, name: string): void {
  const key = normalizeDoi(doi);
  if (!key || !remId) return;
  // Record in BOTH the resolved index (if built) and the session side-map (so a later/rebuilt index
  // still includes it even before RemNote propagates the new child rem).
  sessionAdded.set(key, { remId, name });
  libIndexPromise?.then((m) => m.set(key, { remId, name })).catch(() => {});
  for (const result of cache.values()) {
    let touched = false;
    for (const list of [result.references, result.citations, result.relatedWorks]) {
      for (const p of list) {
        if (p.doi === key && !p.inLibrary) {
          p.inLibrary = true;
          p.remId = remId;
          touched = true;
        }
      }
    }
    if (touched) result.related = relatedFrom(result.references, result.citations);
  }
}

async function buildLibraryDoiIndex(plugin: RNPlugin): Promise<Map<string, LibDoc>> {
  const map = new Map<string, LibDoc>();
  const root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) return map;
  const items = await plugin.rem.findByName([HIERARCHY.items], root._id);
  if (!items) return map;
  const children = await items.getChildrenRem();
  for (const child of children) {
    try {
      if (!(await child.hasPowerup(ZOTERO_ITEM_POWERUP))) continue;
      const doi = normalizeDoi((await child.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.doi)) ?? '');
      if (!doi) continue;
      const name = child.text ? (await plugin.richText.toString(child.text)).trim() : '';
      if (!map.has(doi)) map.set(doi, { remId: child._id, name });
    } catch {
      // skip structural rems etc.
    }
  }
  // Include items added this session that the child scan may not have picked up yet (rem not yet
  // propagated), so a freshly built index doesn't briefly show them as not-in-library.
  for (const [doi, doc] of sessionAdded) if (!map.has(doi)) map.set(doi, doc);
  return map;
}
