/**
 * On-page "citekey menu" for documents tagged `zotero-item`.
 *
 * Renders below the document title (WidgetLocation.DocumentBelowTitle) and clones the layout of
 * zoteroRoam's citekey menu (Information/zotero-roam-main … CitekeyMenu.tsx): a card holding a
 * wrapping row of action buttons + a functional Scite badge, a citations bar (references /
 * citations / related library items), and an expandable related-items list. Styling is
 * RemNote-native (rn-clr-* + Tailwind), not BlueprintJS.
 *
 * FUNCTIONAL:
 *  - **Sync · <date>** — runs a per-item bidirectional sync via `syncSingleItem` (pull metadata +
 *    push user-owned tags), using the doc's stored Zotero key (errors if the key is missing). The
 *    label shows when THIS doc was last synced (the `lastSyncedAt` slot).
 *  - External-link buttons (Open in Zotero local/web, Connected Papers, Semantic Scholar, Google
 *    Scholar, OpenAlex, Inciteful, Litmaps, ResearchRabbit) build REAL URLs from the DOI/title.
 *    Litmaps & ResearchRabbit use their apps' search routes (`app.litmaps.com/search?q=<doi>` /
 *    `app.researchrabbit.ai/search?q=<doi>`), which open the paper for a logged-in user.
 *  - **Scite badge** (focus paper) + **inline scite counts** on each reference/citation row — real
 *    scite.ai supporting/mentioning/contradicting tallies via scite's free `/tallies` API
 *    (`fetchSciteTallies` in semantic.ts); our own compact badge, links to the scite report.
 *  - **Citations bar** — references (left) | related library items (middle) | citations (right). Counts
 *    are the UNIQUE union across all 4 sources (Semantic Scholar / Crossref / OpenAlex / OpenCitations),
 *    deduped by DOI (see `src/lib/semantic.ts`). Each toggles an inline collapsible list; rows show
 *    title — year · authors (sources), with an in-library ✓ link (navigates to the doc) or an Add button.
 *  - **Citations bar lists** — search/scope/sort, pagination, and the per-row **＋ Add** (Citoid →
 *    Zotero write → RemNote create) + bulk add are all wired (see "The citations bar").
 */
import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SESSION, SETTINGS, SLOTS, ZOTERO_ITEM_POWERUP } from '../lib/consts';
import { BRAND_ICONS } from '../lib/brandIcons';
import { addRelatedItem, buildSyncContext, type SyncContext, syncSingleItem } from '../lib/sync';
import { fetchItemByKey } from '../lib/zoteroApi';
import {
  encodeDoiPath,
  fetchAllSources,
  fetchPaperMetrics,
  fetchSciteTallies,
  type MultiSourceResult,
  normalizeDoi,
  type PaperMetrics,
  registerAddedItem,
  type RelatedPaper,
  type SciteTally,
} from '../lib/semantic';

interface ItemData {
  /** The current document's rem id (so the Sync handler can re-find it outside the tracker). */
  documentId: string;
  citekey: string;
  title: string;
  doi: string;
  year: string;
  zoteroKey: string;
  username: string;
  /** Epoch-ms (as string) of this doc's last per-item Sync; '' if never synced. */
  lastSyncedAt: string;
}

/** Subtle border color that adapts to light/dark via RemNote's CSS vars (with a safe fallback). */
const BORDER = 'var(--rn-clr-border-primary, rgba(128,128,128,0.25))';

// The ONE primary action (Sync) keeps the filled popup-button look (`rn-clr-background-light-accent`
// + `rn-clr-content-accent`); everything else is low-chrome so there's a single clear focal point.
// (Every utility class here is already used elsewhere in the project, so no new Tailwind class needs
// regenerating — see the dev-CSS gotcha in CLAUDE.md.)
const BTN_BASE =
  'flex items-center gap-1 px-2 py-1 rounded-md text-xs no-underline rn-clr-background-light-accent rn-clr-content-accent';
const BTN_ACTIVE = `${BTN_BASE} cursor-pointer`;
const BTN_DISABLED = `${BTN_BASE} opacity-50 cursor-default`;

/** Tiny inline-SVG icon set (zero dependencies). `stroke="currentColor"` means each icon inherits
 *  its parent's rn-clr-content-* color, so it themes for light/dark + disabled states for free —
 *  this replaces the old mismatched emoji/unicode glyphs (▦ 🔖 🎓 ◎ 🕸 🗺 🐇 ⟳ ⌂ ☁ 🔍 📈 ⚠). */
const ICON_PATHS = {
  refresh: <path d="M20 11a8 8 0 10-2.3 5.6M20 4.5v5h-5" />,
  caret: <path d="M6 9l6 6 6-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5L16 16" />
    </>
  ),
  check: <path d="M5 13l4 4 10-11" />,
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19 5l-8.5 8.5" />
      <path d="M18 13.5V19H5V6h5.5" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  chart: <path d="M4 4v16h16M8 16v-4M12.5 16V9M17 16v-6" />,
  warn: (
    <>
      <path d="M12 4.5L21 19.5H3z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
};

/** Render one of ICON_PATHS at a fixed box size. */
function Icon({ name, size = 14 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** The single primary action button (Sync); fades to the disabled look while busy. */
function ActionButton({ text, title, busy, onClick }: { text: string; title?: string; busy?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={onClick} title={title ?? text} className={busy ? BTN_DISABLED : BTN_ACTIVE}>
      <Icon name="refresh" size={13} />
      <span>{text}</span>
    </button>
  );
}

/** Format a stored epoch-ms timestamp as "Jun 13 4:45 PM" (date + 12h AM/PM time), or "never". */
function formatSyncDate(epochStr: string): string {
  const n = Number(epochStr);
  if (!epochStr || !Number.isFinite(n) || n <= 0) return 'never';
  const d = new Date(n);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} ${time}`;
}

interface ExternalLink {
  /** Key into BRAND_ICONS for the logo. */
  icon: string;
  name: string;
  href: string;
  disabled?: boolean;
}

/** One external-link icon: the service's brand logo on a small white chip (so every logo reads on any
 *  theme), wrapped in a link. A disabled entry (no DOI/URL) fades in place. Used both on the action row
 *  (focus paper, size 22) and on each reference/citation row (smaller, `size` 20). */
function BrandLink({ icon, name, href, disabled, size = 22 }: ExternalLink & { size?: number }) {
  const img = size - 6;
  const chip = (
    <span
      className="inline-flex items-center justify-center shrink-0"
      title={disabled ? `${name} — needs a DOI` : name}
      style={{
        width: size,
        height: size,
        borderRadius: 5,
        background: '#fff',
        border: `1px solid ${BORDER}`,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <img
        src={BRAND_ICONS[icon]}
        alt={name}
        width={img}
        height={img}
        style={{ width: img, height: img, objectFit: 'contain', display: 'block' }}
      />
    </span>
  );
  if (disabled || !href) return chip;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="no-underline" title={name}>
      {chip}
    </a>
  );
}

/** Citations-bar button (each takes a third of the row, like zoteroRoam's flex 1 0 33%). */
function BarTab({
  count,
  label,
  active,
  disabled,
  onClick,
}: {
  count: number | string;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: '1 1 0',
        paddingTop: 6,
        paddingBottom: 6,
        borderBottom: active ? '2px solid var(--rn-clr-content-accent, #2f81f7)' : '2px solid transparent',
      }}
      className={`px-2 text-xs text-center ${disabled ? 'rn-clr-content-tertiary cursor-default' : 'cursor-pointer'}`}
    >
      <span className={disabled ? '' : 'rn-clr-content-accent font-medium'}>{count}</span>{' '}
      <span className="rn-clr-content-secondary">{label}</span>
    </button>
  );
}

/** Stable per-paper key (DOI if present, else title) — used for the React key, selection set, and
 *  the adding/just-added maps. Mirrors semantic.ts's dedup identity. */
function rowKey(p: RelatedPaper): string {
  return p.doi ? `doi:${p.doi}` : `title:${(p.title || p.fallbackTitle || '').toLowerCase()}`;
}

/** The "open this paper on other sites" links shown as brand-icon chips on each row — ALL the external
 *  services EXCEPT the two Zotero ones (which point at the current library item, not other papers).
 *  Same set/order as the action row minus Zotero. Built from the row's DOI/title (prefers a source's
 *  exact OpenAlex/Semantic page when known); icons with no usable URL fade in place. */
function paperBrandLinks(paper: RelatedPaper): ExternalLink[] {
  const doi = paper.doi;
  const title = paper.title || paper.fallbackTitle || '';
  const q = (s: string): string => encodeURIComponent(s);
  const oaExact = paper.sourceLinks.find((s) => s.name === 'OpenAlex')?.url;
  const s2Exact = paper.sourceLinks.find((s) => s.name === 'Semantic')?.url;
  return [
    {
      icon: 'connectedPapers',
      name: 'Connected Papers',
      href: doi
        ? `https://www.connectedpapers.com/api/redirect/doi/${encodeDoiPath(doi)}`
        : title
        ? `https://www.connectedpapers.com/search?q=${q(title)}`
        : '',
    },
    {
      icon: 'semanticScholar',
      name: 'Semantic Scholar',
      href: s2Exact || (doi ? `https://api.semanticscholar.org/${encodeDoiPath(doi)}` : ''),
      disabled: !s2Exact && !doi,
    },
    { icon: 'googleScholar', name: 'Google Scholar', href: doi || title ? `https://scholar.google.com/scholar?q=${q(doi || title)}` : '' },
    {
      icon: 'openAlex',
      name: 'OpenAlex',
      href: oaExact || (doi ? `https://openalex.org/works?filter=doi:${encodeDoiPath(doi)}` : ''),
      disabled: !oaExact && !doi,
    },
    { icon: 'inciteful', name: 'Inciteful', href: doi ? `https://inciteful.xyz/p/${encodeDoiPath(doi)}` : '', disabled: !doi },
    { icon: 'litmaps', name: 'Litmaps', href: doi || title ? `https://app.litmaps.com/search?q=${q(doi || title)}` : '' },
    { icon: 'researchRabbit', name: 'ResearchRabbit', href: doi || title ? `https://app.researchrabbit.ai/search?q=${q(doi || title)}` : '' },
  ];
}

/** A pickable collection: its key + full "Parent / Child" path. */
interface CollOption {
  key: string;
  path: string;
}

/** Flatten Zotero's collections into full-path options, sorted by path (for the Add-to-collection
 *  picker). Cycle-guarded. */
function buildCollectionPaths(
  collections: { key: string; name: string; parentKey: string | null }[]
): CollOption[] {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const pathOf = (c: { key: string; name: string; parentKey: string | null }): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur: { key: string; name: string; parentKey: string | null } | undefined = c;
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      parts.unshift(cur.name);
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
    return parts.join(' / ');
  };
  return collections.map((c) => ({ key: c.key, path: pathOf(c) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Inline collection picker (clip-safe — grows the iframe rather than overlaying). Lists every
 *  Zotero collection by full path plus a "No collection" choice; `onPick(null)` = unfiled. */
function CollectionPicker({
  collections,
  loadError,
  onPick,
  onClose,
}: {
  collections: CollOption[] | null;
  /** True when the collection load FAILED (vs. still loading) — so we don't show a misleading
   *  "Loading…"/"No collections" forever. */
  loadError: boolean;
  onPick: (collectionKey: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="mt-1 rounded text-xs"
      style={{ border: `1px solid ${BORDER}`, background: 'var(--rn-clr-background-secondary)' }}
    >
      <div
        className="px-2 py-1 rn-clr-content-secondary flex items-center justify-between"
        style={{ borderBottom: `1px solid ${BORDER}` }}
      >
        <span>Add to which collection?</span>
        <button type="button" onClick={onClose} title="Close" className="cursor-pointer rn-clr-content-tertiary">
          ✕
        </button>
      </div>
      <div style={{ maxHeight: '12rem', overflowY: 'auto' }}>
        {collections === null ? (
          <div className="px-2 py-1 rn-clr-content-tertiary">
            {loadError ? "Couldn't load collections — close and reopen to retry." : 'Loading collections…'}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="block w-full text-left px-2 py-1 cursor-pointer rn-clr-content-primary"
            >
              No collection (unfiled)
            </button>
            {collections.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => onPick(c.key)}
                title={c.path}
                className="block w-full text-left px-2 py-1 cursor-pointer rn-clr-content-primary"
              >
                {c.path}
              </button>
            ))}
            {collections.length === 0 && (
              <div className="px-2 py-1 rn-clr-content-tertiary">No collections in your Zotero library.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One numbered reference/citation row, rendered as its own card: an optional select-checkbox (when
 *  the row is addable), "N.", the title, and an Add / "✓ In library" button; then a metadata line
 *  and a line with the DOI link + per-source landing-page links. */
function RelatedRow({
  index,
  paper,
  scite,
  metrics,
  inLib,
  remId,
  selected,
  adding,
  addable,
  pickerOpen,
  collections,
  collsError,
  onToggleSelect,
  onOpen,
  onAdd,
  onTogglePicker,
  onPickCollection,
}: {
  index: number;
  paper: RelatedPaper;
  scite?: SciteTally;
  metrics?: PaperMetrics;
  inLib: boolean;
  remId: string;
  selected: boolean;
  adding: boolean;
  addable: boolean;
  pickerOpen: boolean;
  collections: CollOption[] | null;
  collsError: boolean;
  onToggleSelect: (key: string) => void;
  onOpen: (remId: string) => void;
  onAdd: (paper: RelatedPaper) => void;
  onTogglePicker: (key: string) => void;
  onPickCollection: (collectionKey: string | null) => void;
}) {
  const k = rowKey(paper);
  const meta = [paper.year, paper.authors, paper.venue].filter(Boolean).join(' · ');
  const links = paperBrandLinks(paper); // "open on other sites" as brand-icon chips (all but Zotero)
  const title = paper.title || paper.fallbackTitle || paper.doi || '(untitled)';
  // OpenAlex's count (from metrics) is authoritative; Crossref reference rows have no union count, so
  // fall back to the row's own count only until metrics load.
  const cites = metrics?.citedByCount || paper.citationCount;
  // Metrics + DOI/provenance/links lines are shown INLINE. (No per-row expander: the free citation
  // APIs rarely have abstracts for this library, so the abstract "⋯ more" panel was dropped 2026-06-15.)
  const hasMetrics =
    cites > 0 ||
    !!metrics?.topPercent ||
    !!metrics?.retracted ||
    !!(metrics && (metrics.influential > 0 || metrics.relatedInLibrary > 0)) ||
    !!scite;
  const hasLinks = !!paper.doi || paper.sources.length > 0 || links.some((l) => l.href);
  // In-library rows get a positive tint + left rule; others zebra-stripe lightly. No per-row box —
  // rows separate with a single bottom hairline + whitespace.
  const bg = inLib
    ? 'var(--rn-clr-background-light-positive, rgba(46,160,67,0.10))'
    : index % 2 === 1
    ? 'var(--rn-clr-background-primary, rgba(128,128,128,0.035))'
    : 'transparent';
  return (
    <li
      className="text-xs"
      style={{
        borderBottom: `1px solid ${BORDER}`,
        padding: '7px 4px',
        paddingLeft: inLib ? 9 : 4,
        borderLeft: inLib ? '3px solid var(--rn-clr-content-positive, #2ea043)' : undefined,
        background: bg,
      }}
    >
      <div className="flex items-start gap-2">
        {addable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(k)}
            onClick={(e) => e.stopPropagation()}
            title="Select for bulk add"
            className="mt-0.5 shrink-0 cursor-pointer"
            style={{ width: '0.9rem' }}
          />
        ) : (
          <span className="shrink-0" style={{ width: '0.9rem' }} aria-hidden="true" />
        )}
        <span className="shrink-0 rn-clr-content-tertiary" style={{ minWidth: '1.5rem', textAlign: 'right' }}>
          {index}.
        </span>
        {/* Content column: title, meta, summary, and the expand block all share THIS left edge. */}
        <div className="min-w-0 flex-1">
          {/* Line 1: title + the single right-aligned action. */}
          <div className="flex items-start gap-2">
            <span
              className={`min-w-0 flex-1 font-medium ${inLib ? 'rn-clr-content-primary cursor-pointer hover:underline' : 'rn-clr-content-primary'}`}
              onClick={inLib ? () => onOpen(remId) : undefined}
              title={inLib ? `${title} — open in RemNote` : title}
            >
              {title}
            </span>
            {inLib ? (
              <button
                type="button"
                onClick={() => onOpen(remId)}
                title="Already in your library — click to open"
                className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs cursor-pointer no-underline"
                style={{ color: 'var(--rn-clr-content-positive, #2ea043)' }}
              >
                <Icon name="check" size={13} /> In library
              </button>
            ) : adding ? (
              <span className="shrink-0 px-1.5 py-0.5 text-xs rn-clr-content-accent opacity-50">Adding…</span>
            ) : addable ? (
              // Split: "＋ Add" files into the current item's collection(s); the ▾ chevron picks one.
              <span className="shrink-0 flex items-center gap-px">
                <button
                  type="button"
                  onClick={() => onAdd(paper)}
                  title="Add to Zotero + RemNote (this item's collection)"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-l text-xs rn-clr-background-light-accent rn-clr-content-accent cursor-pointer"
                >
                  <Icon name="plus" size={12} /> Add
                </button>
                <button
                  type="button"
                  onClick={() => onTogglePicker(k)}
                  title="Add to a specific collection…"
                  className="flex items-center px-1 py-0.5 rounded-r text-xs rn-clr-background-light-accent rn-clr-content-accent cursor-pointer"
                >
                  <Icon name="caret" size={11} />
                </button>
              </span>
            ) : (
              <span
                className="shrink-0 px-1.5 py-0.5 text-xs rn-clr-content-tertiary opacity-50"
                title="No DOI — can't auto-add this paper"
              >
                No DOI
              </span>
            )}
          </div>
          {/* Line 2: relationship chip (In-Library tab only) + year · authors · venue. */}
          {(meta || paper.relationship) && (
            <div className="rn-clr-content-secondary flex flex-wrap items-center" style={{ columnGap: '0.4rem', rowGap: '0.1rem' }}>
              {paper.relationship && (
                <span
                  className="rn-clr-background-light-accent rn-clr-content-accent"
                  style={{ padding: '0 5px', borderRadius: 4 }}
                  title="This paper's relationship to the current item"
                >
                  {paper.relationship}
                </span>
              )}
              {meta && <span>{meta}</span>}
            </div>
          )}
          {/* Metrics (ALWAYS shown): citations (+ influential) · top% · retracted · ↔ in-library · scite. */}
          {hasMetrics && (
            <div className="rn-clr-content-tertiary flex flex-wrap items-center gap-x-2 gap-y-0.5" style={{ marginTop: 2 }}>
              {cites > 0 && (
                <span className="inline-flex items-center gap-1" title="Total citations (OpenAlex / Semantic Scholar)">
                  <Icon name="chart" size={12} /> {cites.toLocaleString()} citations
                  {metrics && metrics.influential > 0 && (
                    <span
                      className="rn-clr-content-tertiary"
                      title="Influential citations — citing papers that meaningfully built on this one (Semantic Scholar)"
                    >
                      {' '}
                      ({metrics.influential.toLocaleString()} influential)
                    </span>
                  )}
                </span>
              )}
              {metrics?.topPercent && (
                <span
                  style={{ color: 'var(--rn-clr-content-positive, #16a34a)' }}
                  title={`Top ${metrics.topPercent}% most-cited of its publication year (OpenAlex)`}
                >
                  ★ top {metrics.topPercent}%
                </span>
              )}
              {metrics?.retracted && (
                <span
                  className="inline-flex items-center gap-1 font-semibold"
                  style={{ color: 'var(--rn-clr-content-negative, #dc2626)' }}
                  title="Flagged as retracted (OpenAlex) — do not cite"
                >
                  <Icon name="warn" size={12} /> Retracted
                </span>
              )}
              {metrics && metrics.relatedInLibrary > 0 && (
                <span
                  style={{ color: 'var(--rn-clr-content-accent, #2f81f7)' }}
                  title="OpenAlex 'related works' for this paper that are already in your library"
                >
                  ↔ {metrics.relatedInLibrary} in your library
                </span>
              )}
              {scite && <SciteRowCounts tally={scite} doi={paper.doi} />}
            </div>
          )}
          {/* DOI · provenance · external links (ALWAYS shown). */}
          {hasLinks && (
            <div className="rn-clr-content-tertiary flex flex-wrap items-center gap-x-2" style={{ marginTop: 2 }}>
              {paper.doi && (
                <a
                  href={`https://doi.org/${encodeDoiPath(paper.doi)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rn-clr-content-secondary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                  title={`https://doi.org/${paper.doi}`}
                >
                  doi.org/{paper.doi}
                </a>
              )}
              {/* Origin provenance — each contributing source name links to that source's page for this
                  paper (via `sourceLinks`; plain text if a source had no landing page). */}
              {paper.sources.length > 0 && (
                <span>
                  ({paper.sources.map((s, i) => {
                    const url = paper.sourceLinks.find((l) => l.name === s)?.url;
                    return (
                      <span key={s}>
                        {i > 0 ? ', ' : ''}
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="rn-clr-content-secondary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                            title={`View on ${s} (a source of this row's data)`}
                          >
                            {s}
                          </a>
                        ) : (
                          s
                        )}
                      </span>
                    );
                  })})
                </span>
              )}
              {/* "Open this paper on…" — every external service EXCEPT Zotero, as brand-icon chips. */}
              <span className="inline-flex flex-wrap items-center" style={{ columnGap: '0.3rem', rowGap: '0.3rem' }}>
                {links.map((l) => (
                  <BrandLink key={l.icon} {...l} size={20} />
                ))}
              </span>
            </div>
          )}
          {pickerOpen && (
            <CollectionPicker
              collections={collections}
              loadError={collsError}
              onPick={onPickCollection}
              onClose={() => onTogglePicker(k)}
            />
          )}
        </div>
      </div>
    </li>
  );
}

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [20, 50, 100]; // items per page (default 20, max 100)

type SortKey = 'default' | 'year' | 'citations';
type SortDir = 'asc' | 'desc';
type SearchScope = 'title' | 'all';

/** A small native-select control for the toolbar (sort / per-page). Native <select> keeps it to ONE
 *  compact control and its option popup is an OS overlay (no iframe clipping, no outside-click code). */
function ToolSelect({
  value,
  title,
  onChange,
  children,
}: {
  value: string | number;
  title: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      title={title}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs rn-clr-content-secondary cursor-pointer"
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        padding: '2px 4px',
        background: 'var(--rn-clr-background-primary, transparent)',
        maxWidth: '9rem',
      }}
    >
      {children}
    </select>
  );
}

/** Toolbar above an open list: search input (+ a chevron to pick title-only vs all-metadata), a single
 *  Sort select, a per-page select, and the Bulk-add button (disabled unless >1 row is selected). */
function ListToolbar({
  query,
  onQuery,
  scope,
  onScope,
  scopeOpen,
  onToggleScope,
  sortKey,
  sortDir,
  onSetSort,
  pageSize,
  onSetPageSize,
  selectedCount,
  onBulkAdd,
  onToggleBulkPicker,
  bulkBusy,
}: {
  query: string;
  onQuery: (v: string) => void;
  scope: SearchScope;
  onScope: (s: SearchScope) => void;
  scopeOpen: boolean;
  onToggleScope: () => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSetSort: (key: SortKey, dir: SortDir) => void;
  pageSize: number;
  onSetPageSize: (n: number) => void;
  selectedCount: number;
  onBulkAdd: () => void;
  onToggleBulkPicker: () => void;
  bulkBusy: boolean;
}) {
  const bulkDisabled = selectedCount <= 1 || bulkBusy;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2"
      style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}
    >
      <div className="relative flex items-center gap-1" style={{ flex: '1 1 11rem', minWidth: '9rem' }}>
        <span className="rn-clr-content-tertiary flex items-center" aria-hidden="true">
          <Icon name="search" size={14} />
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search…"
          className="flex-1 px-2 py-0.5 rounded text-xs rn-clr-content-primary"
          style={{ border: `1px solid ${BORDER}`, minWidth: 0, background: 'var(--rn-clr-background-primary, transparent)' }}
        />
        <button
          type="button"
          onClick={onToggleScope}
          onMouseDown={(e) => e.stopPropagation()}
          title="Choose what to search"
          className="px-1.5 py-0.5 rounded text-xs rn-clr-content-secondary cursor-pointer whitespace-nowrap"
          style={{ border: `1px solid ${BORDER}` }}
        >
          {scope === 'title' ? 'Title' : 'All'} ▾
        </button>
        {scopeOpen && (
          <div
            className="absolute z-10 rounded rn-clr-background-secondary"
            onMouseDown={(e) => e.stopPropagation()}
            style={{ top: '100%', right: 0, marginTop: 2, border: `1px solid ${BORDER}`, minWidth: '9rem' }}
          >
            <button
              type="button"
              onClick={() => onScope('title')}
              className={`block w-full text-left px-2 py-1 text-xs cursor-pointer ${
                scope === 'title' ? 'rn-clr-content-accent' : 'rn-clr-content-primary'
              }`}
            >
              Title only
            </button>
            <button
              type="button"
              onClick={() => onScope('all')}
              title="Title, authors, publication, year"
              className={`block w-full text-left px-2 py-1 text-xs cursor-pointer ${
                scope === 'all' ? 'rn-clr-content-accent' : 'rn-clr-content-primary'
              }`}
            >
              All metadata
            </button>
          </div>
        )}
      </div>
      {/* One combined Sort select (key + direction encoded in the value) + a per-page select. */}
      <ToolSelect
        value={sortKey === 'default' ? 'default' : `${sortKey}-${sortDir}`}
        title="Sort the list"
        onChange={(v) => {
          if (v === 'default') onSetSort('default', 'asc');
          else {
            const [k, d] = v.split('-');
            onSetSort(k as SortKey, d as SortDir);
          }
        }}
      >
        <option value="default">Sort: Default</option>
        <option value="citations-desc">Sort: Most cited</option>
        <option value="citations-asc">Sort: Fewest cited</option>
        <option value="year-desc">Sort: Newest</option>
        <option value="year-asc">Sort: Oldest</option>
      </ToolSelect>
      <ToolSelect value={pageSize} title="Items per page" onChange={(v) => onSetPageSize(Number(v))}>
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n} / page
          </option>
        ))}
      </ToolSelect>
      {/* Split: "Bulk add" files all selected into the current item's collection(s); the ▾ chevron
          opens a picker to bulk-add them into a specific collection. */}
      <span className="flex items-center gap-px">
        <button
          type="button"
          disabled={bulkDisabled}
          onClick={onBulkAdd}
          title={selectedCount <= 1 ? 'Select 2+ items to bulk add' : 'Add all selected items to Zotero + RemNote'}
          className={`px-2 py-0.5 rounded-l text-xs ${
            bulkDisabled ? 'rn-clr-content-secondary opacity-50 cursor-default' : 'rn-clr-background-light-accent rn-clr-content-accent cursor-pointer'
          }`}
        >
          {bulkBusy ? 'Adding…' : `Bulk add${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
        </button>
        <button
          type="button"
          disabled={bulkDisabled}
          onClick={onToggleBulkPicker}
          title="Bulk add to a specific collection…"
          className={`px-1 py-0.5 rounded-r text-xs ${
            bulkDisabled ? 'rn-clr-content-secondary opacity-50 cursor-default' : 'rn-clr-background-light-accent rn-clr-content-accent cursor-pointer'
          }`}
        >
          ▾
        </button>
      </span>
    </div>
  );
}

/** Bottom page navigation for a list (controlled by the parent). */
function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div
      className="flex items-center justify-center gap-3 mt-1 pt-1 text-xs rn-clr-content-secondary"
      style={{ borderTop: `1px solid ${BORDER}` }}
    >
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className={`px-2 py-0.5 rounded ${page <= 1 ? 'opacity-40 cursor-default' : 'cursor-pointer rn-clr-background-light-accent'}`}
      >
        ‹ Prev
      </button>
      <span>
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
        className={`px-2 py-0.5 rounded ${page >= pageCount ? 'opacity-40 cursor-default' : 'cursor-pointer rn-clr-background-light-accent'}`}
      >
        Next ›
      </button>
    </div>
  );
}

/** scite.ai's four Smart-Citation categories — `key` indexes SciteTally; `name` is scite's label
 *  ("Contrasting", not the API's "contradicting"); `glyph` approximates scite's icon; `color` is a
 *  theme token (dark-mode aware) with a scite-ish hex fallback. */
const SCITE_CATS = [
  { key: 'supporting', name: 'Supporting', glyph: '✔', color: 'var(--rn-clr-content-positive, #16a34a)' },
  { key: 'mentioning', name: 'Mentioning', glyph: '•', color: 'var(--rn-clr-content-secondary, #6b7280)' },
  { key: 'contradicting', name: 'Contrasting', glyph: '✘', color: 'var(--rn-clr-content-negative, #dc2626)' },
  { key: 'unclassified', name: 'Unclassified', glyph: '◦', color: 'var(--rn-clr-content-tertiary, #9ca3af)' },
] as const;

/** Compact inline scite counts for a reference/citation row: all four categories as icon+number
 *  (color-coded, names in the tooltip — to stay on one line), linking to the scite report. */
function SciteRowCounts({ tally, doi }: { tally: SciteTally; doi: string }) {
  return (
    <a
      href={`https://scite.ai/reports/${encodeDoiPath(doi)}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 no-underline hover:underline"
      title="scite.ai Smart Citations — Supporting / Mentioning / Contrasting / Unclassified"
    >
      <span className="rn-clr-content-tertiary">scite</span>
      {SCITE_CATS.map((c) => (
        <span key={c.key} title={c.name} style={{ color: c.color }}>
          {c.glyph}
          {tally[c.key]}
        </span>
      ))}
    </a>
  );
}

/** Multi-source citations-bar state. */
interface SemState {
  status: 'idle' | 'loading' | 'done';
  /** The DOI this state belongs to — render ignores it if it doesn't match the current doc (so the
   *  previous doc's counts/related never flash under a newly-navigated doc before the effect reruns). */
  doi: string;
  /** Per-source counts + related items; null while loading or on an unexpected failure. */
  result: MultiSourceResult | null;
}
const SEM_IDLE: SemState = { status: 'idle', doi: '', result: null };

function ItemMenu() {
  const plugin = usePlugin();
  // At most ONE of the three lists is open at a time (clicking another switches to it).
  const [openList, setOpenList] = useState<'refs' | 'inlib' | 'cites' | 'related' | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [sem, setSem] = useState<SemState>(SEM_IDLE);
  // scite.ai tallies for the focus paper + every row, keyed by normalized DOI. Fetched OFF the
  // citations-bar critical path (its own effect below) so the bar paints without waiting on scite and
  // a failed scite fetch retries on revisit instead of being frozen into the cached union.
  const [sciteMap, setSciteMap] = useState<Map<string, SciteTally>>(new Map());
  // Importance metrics (influential cites / top-percentile / retracted / related-in-library) per row,
  // by normalized DOI — fetched in the same off-critical-path effect as scite.
  const [metricsMap, setMetricsMap] = useState<Map<string, PaperMetrics>>(new Map());
  // List toolbar + Add state (lifted here so the toolbar above the list can drive the same list).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('title');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(1);
  // Items per page (default 20, max 100); persists across tab switches.
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Collection picker: which Add button's picker is open (a rowKey, or 'bulk'); + the cached
  // full-path collection list (library-wide, loaded once).
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [colls, setColls] = useState<CollOption[] | null>(null);
  // True when the collection load FAILED — kept distinct from "still null/loading" so the picker
  // shows a retry hint (not a permanent "No collections") and a re-open actually retries.
  const [collsError, setCollsError] = useState(false);
  // rowKey → new remId for items added THIS session, so a row flips to "in library" (and shows up in
  // the related list) immediately, without waiting for a refetch.
  const [justAdded, setJustAdded] = useState<Map<string, string>>(new Map());
  // Cached SyncContext + the current item's Zotero collection keys (resolved once each).
  const ctxRef = useRef<SyncContext | null>(null);
  const hostColRef = useRef<{ key: string; cols: string[] } | null>(null);
  // Synchronous in-flight guard (React `adding` state lags a click by a render — a fast double-click
  // or Add-then-Bulk could otherwise create duplicate Zotero items). This is the load-bearing guard.
  const addingRef = useRef<Set<string>>(new Set());
  // In-flight guard for the one-time collection-list load (React `colls` lags a click by a render).
  const collsLoadingRef = useRef(false);

  const data = useTrackerPlugin<ItemData | null>(async (rp) => {
    // RemNote REUSES this widget iframe across in-app navigation (verified live: the menu kept
    // showing the previous item's data on an unrelated page), and getWidgetContext is NOT
    // reactive. This session read IS reactive — index.tsx bumps the key on AppEvents.URLChange,
    // which re-runs this tracker so the context is re-queried for the new document.
    await rp.storage.getSession(SESSION.navTick);

    const ctx = await rp.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
    if (!ctx?.documentId) return null;
    const rem = await rp.rem.findOne(ctx.documentId);
    if (!rem) return null;
    // Guard: only render on our item docs, whatever the registration filter's semantics are.
    if (!(await rem.hasPowerup(ZOTERO_ITEM_POWERUP))) return null;

    const citekey = rem.text ? (await rp.richText.toString(rem.text)).trim() : '';
    const get = async (slot: string): Promise<string> => {
      try {
        return ((await rem.getPowerupProperty(ZOTERO_ITEM_POWERUP, slot)) ?? '').trim();
      } catch {
        return '';
      }
    };
    const [title, doi, year, zoteroKey, lastSyncedAt] = await Promise.all([
      get(SLOTS.title),
      get(SLOTS.doi),
      get(SLOTS.year),
      get(SLOTS.key),
      get(SLOTS.lastSyncedAt),
    ]);
    // The zotero.org WEB library needs the username SLUG — numeric-userId item URLs 404
    // (verified live 2026-06-13), so the web button stays disabled until the optional
    // "Zotero Username" setting is filled in.
    const username = String((await rp.settings.getSetting(SETTINGS.username)) ?? '').trim();
    return { documentId: ctx.documentId, citekey, title, doi, year, zoteroKey, username, lastSyncedAt };
  }, []);

  // Collapse the open list + drop this-session adds whenever the underlying document changes.
  const docKey = data?.zoteroKey ?? '';
  useEffect(() => {
    setOpenList(null);
    setJustAdded(new Map());
    setPickerFor(null);
  }, [docKey]);

  // Reset list-scoped controls whenever the open list changes (incl. closing). Selection keys could
  // collide across lists, and search/sort/page are per-list.
  useEffect(() => {
    setSelected(new Set());
    setQuery('');
    setScope('title');
    setScopeOpen(false);
    // Per-tab default sort: References keep document order ("Default"); the other tabs (In Library /
    // Citations / Related) default to most-cited first.
    const refsTab = openList === 'refs';
    setSortKey(refsTab ? 'default' : 'citations');
    setSortDir(refsTab ? 'asc' : 'desc');
    setPage(1);
    setPickerFor(null);
  }, [openList]);

  // Dismiss the search-scope dropdown on a click outside it (the toggle + dropdown stopPropagation
  // their own mousedown, so this only fires for clicks elsewhere in the widget).
  useEffect(() => {
    if (!scopeOpen) return;
    const close = (): void => setScopeOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [scopeOpen]);

  // Citations bar: fetch the doc's reference/citation counts from all 4 sources (by DOI) + the
  // related-library matches. Runs per DOI; the `cancelled` guard discards results if the user
  // navigates away mid-fetch. fetchAllSources + the library index are module-cached, so this is one
  // burst of requests per item per session.
  const doi = data?.doi ?? '';
  useEffect(() => {
    if (!doi) {
      setSem(SEM_IDLE);
      return;
    }
    let cancelled = false;
    setSem({ status: 'loading', doi, result: null });
    fetchAllSources(doi, plugin)
      .then((result) => {
        if (!cancelled) setSem({ status: 'done', doi, result });
      })
      .catch((err) => {
        // fetchAllSources isolates each source so it shouldn't reject; a hard failure → all dashes.
        if (cancelled) return;
        console.error('Remzot citation-sources lookup failed:', err);
        setSem({ status: 'done', doi, result: null });
      });
    return () => {
      cancelled = true;
    };
  }, [doi, plugin]);

  // scite tallies (focus + rows) AND importance metrics (rows) — batched/cached, OFF the bar's critical
  // path. Re-runs when the doc changes (focus only, while the lists load) and again when `sem` resolves
  // (now including the row DOIs); on revisit it retries any DOIs that failed before.
  useEffect(() => {
    if (!doi) {
      setSciteMap(new Map());
      setMetricsMap(new Map());
      return;
    }
    let cancelled = false;
    const res = sem.doi === doi ? sem.result : null;
    const dois = [doi];
    if (res) for (const p of [...res.references, ...res.citations, ...res.related]) if (p.doi) dois.push(p.doi);
    void fetchSciteTallies(dois).then((m) => {
      if (!cancelled) setSciteMap(m);
    });
    // Metrics only matter for the rows, so skip until the lists' DOIs are loaded.
    if (res) {
      void fetchPaperMetrics(dois, plugin).then((m) => {
        if (!cancelled) setMetricsMap(m);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [doi, sem, plugin]);

  // Navigate to a related item's RemNote doc.
  const openRelated = async (remId: string): Promise<void> => {
    const target = await plugin.rem.findOne(remId);
    if (target) await plugin.window.openRem(target);
  };

  // ── Derived citation lists (HOOKS — must run before the `data` guard below). ──
  // Use the citation data only if it belongs to the CURRENT doc; just after navigation (before the
  // effect re-runs) sem still holds the previous doc's data, so treat it as not-loaded.
  const semForDoc: SemState = data && sem.doi === data.doi ? sem : SEM_IDLE;
  const semLoading = semForDoc.status !== 'done';
  const refs = semForDoc.result?.references ?? [];
  const cites = semForDoc.result?.citations ?? [];
  // "Related" tab: topically-related works (OpenAlex related_works ∪ S2 recommendations — NOT
  // citation-linked).
  const relatedWorks = semForDoc.result?.relatedWorks ?? [];
  // A row counts as in-library if a synced doc has its DOI OR we added it this session.
  const effInLib = (p: RelatedPaper): boolean => p.inLibrary || justAdded.has(rowKey(p));
  const effRemId = (p: RelatedPaper): string => justAdded.get(rowKey(p)) ?? p.remId;

  // "In Library" = (refs ∪ cites ∪ relatedWorks) currently in the library — recomputed locally (incl.
  // justAdded) so a just-added paper appears immediately. Each carries its RELATIONSHIP to the current
  // item: "cited by this" (a reference of it), "cites this" (a citation of it), and/or "related".
  const inLibrary = useMemo(() => {
    const refKeys = new Set(refs.map(rowKey));
    const citeKeys = new Set(cites.map(rowKey));
    const relKeys = new Set(relatedWorks.map(rowKey));
    const seen = new Set<string>();
    const out: RelatedPaper[] = [];
    for (const p of [...refs, ...cites, ...relatedWorks]) {
      const k = rowKey(p);
      if (!(p.inLibrary || justAdded.has(k)) || seen.has(k)) continue;
      seen.add(k);
      const rel: string[] = [];
      if (refKeys.has(k)) rel.push('cited by this');
      if (citeKeys.has(k)) rel.push('cites this');
      if (relKeys.has(k)) rel.push('related');
      // Re-stamp a fresh order: each source list restarts `order` at 0, so the merged list needs
      // unique orders for the Default sort not to tie.
      out.push({ ...p, order: out.length, relationship: rel.join(' · ') });
    }
    return out;
  }, [refs, cites, relatedWorks, justAdded]);

  const baseList: RelatedPaper[] =
    openList === 'refs'
      ? refs
      : openList === 'cites'
      ? cites
      : openList === 'related'
      ? relatedWorks
      : openList === 'inlib'
      ? inLibrary
      : [];

  // Count of selected rows that are STILL addable (have a DOI + not in library) — the exact set
  // Bulk-add will operate on. Drives the Bulk-add button's enabled state + label so they can't
  // overstate what a click does (e.g. when a checked row became in-library after selection).
  const selectableSelected = baseList.filter(
    (p) => selected.has(rowKey(p)) && !!p.doi && !effInLib(p)
  ).length;

  // filter → sort → paginate (each render; lists are at most a few hundred rows).
  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return baseList;
    return baseList.filter((p) => {
      const dispTitle = p.title || p.fallbackTitle || '';
      const hay =
        scope === 'title'
          ? dispTitle.toLowerCase()
          : `${dispTitle} ${p.authors} ${p.venue} ${p.year}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [baseList, query, scope]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const mul = sortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      const val = (p: RelatedPaper): number =>
        sortKey === 'year' ? Number(p.year) || 0 : sortKey === 'citations' ? p.citationCount : p.order;
      const av = val(a);
      const bv = val(b);
      if (av !== bv) return (av - bv) * mul;
      // Tiebreak by year (newest first) so a Citations sort over the many 0-count rows doesn't
      // degenerate to alphabetical; then by title for full determinism. (Default `order` is unique
      // per row in every list — references, citations, and the re-stamped related list — so the
      // Default sort itself never reaches these tiebreaks.)
      const ay = Number(a.year) || 0;
      const by = Number(b.year) || 0;
      if (ay !== by) return by - ay;
      return a.title.localeCompare(b.title);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const shown = sorted.slice(pageStart, pageStart + pageSize);
  // Bar count text: '…' while loading, else the exact unique-union count.
  const countText = (list: RelatedPaper[]): string => (semLoading ? '…' : String(list.length));

  if (!data) return null;

  const q = (s: string) => encodeURIComponent(s);
  const localUrl = data.zoteroKey ? `zotero://select/library/items/${data.zoteroKey}` : '';
  const webUrl =
    data.zoteroKey && data.username
      ? `https://www.zotero.org/${data.username}/items/${data.zoteroKey}/library`
      : '';
  const connectedPapersUrl = data.doi
    ? `https://www.connectedpapers.com/api/redirect/doi/${encodeDoiPath(data.doi)}`
    : data.title
    ? `https://www.connectedpapers.com/search?q=${q(data.title)}`
    : '';
  const semanticScholarUrl = data.doi ? `https://api.semanticscholar.org/${encodeDoiPath(data.doi)}` : '';
  const googleScholarUrl = `https://scholar.google.com/scholar?q=${q(data.doi || data.title || data.citekey)}`;
  // OpenAlex work record (UI filtered to the DOI) + Inciteful's citation-network Paper Discovery
  // (seed = DOI) — both need a DOI. Litmaps = its app's search for the DOI (else title); opens the
  // paper for a logged-in Litmaps user. `q` is full %-encoding, so the DOI's `/` becomes `%2F`.
  const openAlexUrl = data.doi ? `https://openalex.org/works?filter=doi:${encodeDoiPath(data.doi)}` : '';
  const incitefulUrl = data.doi ? `https://inciteful.xyz/p/${encodeDoiPath(data.doi)}` : '';
  const litmapsUrl = (data.doi || data.title) ? `https://app.litmaps.com/search?q=${q(data.doi || data.title)}` : '';
  const researchRabbitUrl = (data.doi || data.title)
    ? `https://app.researchrabbit.ai/search?q=${q(data.doi || data.title)}`
    : '';

  // Per-item Sync: pull metadata + push user-owned tags via syncSingleItem, keyed by the stored
  // Zotero key. Errors (missing key, 404, version conflict, bad creds) are surfaced as toasts.
  const onSync = async (): Promise<void> => {
    if (syncing) return;
    if (!data.zoteroKey) {
      await plugin.app.toast("This item has no Zotero key — can't sync it.");
      return;
    }
    setSyncing(true);
    try {
      const rem = await plugin.rem.findOne(data.documentId);
      if (!rem) {
        await plugin.app.toast('Could not find this document to sync.');
        return;
      }
      const ctx = await buildSyncContext(plugin);
      const result = await syncSingleItem(plugin, rem, ctx);
      await plugin.app.toast(result.message);
      // Nudge the tracker (session reads are reactive) so the "Sync · <date>" label refreshes.
      await plugin.storage.setSession(SESSION.navTick, Date.now());
    } catch (err) {
      // Lower layers (missing creds, item-fetch HTTP errors) already showed a toast — don't double
      // up. The push/412 path and any unexpected error (e.g. an un-reloaded powerup slot) are NOT
      // pre-toasted, so surface those here.
      console.error('Remzot single-item sync failed:', err);
      if (!(err as { toasted?: boolean } | null)?.toasted) {
        await plugin.app.toast(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSyncing(false);
    }
  };

  const syncDate = formatSyncDate(data.lastSyncedAt);
  const syncLabel = syncing ? 'Syncing…' : 'Sync';
  const syncCaption = data.lastSyncedAt ? `synced ${syncDate}` : 'never synced';
  const syncTitle = syncing
    ? 'Syncing this item with Zotero…'
    : `${
        data.lastSyncedAt ? `Last synced ${new Date(Number(data.lastSyncedAt)).toLocaleString()}` : 'Never synced'
      }. Click to pull metadata from Zotero and push your Status/Rating/Tags back.`;

  // Build the SyncContext for Add once per session (item types + collections rarely change).
  const getCtx = async (): Promise<SyncContext> => {
    if (!ctxRef.current) ctxRef.current = await buildSyncContext(plugin);
    return ctxRef.current;
  };

  // The current item's Zotero collection keys, so added papers join the SAME collection(s). Resolved
  // once per host item from the host Zotero item; any failure falls back to no collection.
  const getHostCollectionKeys = async (): Promise<string[]> => {
    if (!data.zoteroKey) return [];
    if (hostColRef.current?.key === data.zoteroKey) return hostColRef.current.cols;
    let cols: string[] = [];
    try {
      const host = await fetchItemByKey(plugin, data.zoteroKey);
      cols = host?.data.collections ?? [];
    } catch {
      cols = [];
    }
    hostColRef.current = { key: data.zoteroKey, cols };
    return cols;
  };

  const toggleSelect = (key: string): void =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const onSetSort = (key: SortKey, dir: SortDir): void => {
    setSortKey(key);
    setSortDir(dir);
    setPage(1);
  };
  const onSetPageSize = (n: number): void => {
    setPageSize(n);
    setPage(1);
  };

  // Add one paper to Zotero + RemNote, marking it in-library locally on success (so the row flips
  // without a refetch). Returns the result; the caller toasts. Never throws.
  const addOne = async (
    paper: RelatedPaper,
    ctx: SyncContext,
    collectionKeys: string[]
  ): Promise<{ ok: boolean; message: string }> => {
    const k = rowKey(paper);
    // Synchronous re-entrancy guard (closes the double-click / Add-then-Bulk window before any await).
    if (addingRef.current.has(k) || effInLib(paper)) return { ok: false, message: '' };
    addingRef.current.add(k);
    setAdding((s) => new Set(s).add(k));
    try {
      const res = await addRelatedItem(plugin, paper, ctx, { collectionKeys });
      if (res.ok && res.remId) {
        const remId = res.remId;
        setJustAdded((m) => new Map(m).set(k, remId));
        setSelected((s) => {
          const n = new Set(s);
          n.delete(k);
          return n;
        });
        registerAddedItem(paper.doi, remId, paper.title || paper.fallbackTitle || '');
      }
      return { ok: res.ok, message: res.message };
    } catch (err) {
      // addRelatedItem returns {ok:false} for normal failures; a throw is unexpected (e.g. bad
      // creds, already toasted by a lower layer).
      console.error('Remzot add-related failed:', err);
      const toasted = (err as { toasted?: boolean } | null)?.toasted;
      return { ok: false, message: toasted ? '' : `Add failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      addingRef.current.delete(k);
      setAdding((s) => {
        const n = new Set(s);
        n.delete(k);
        return n;
      });
    }
  };

  const onAdd = async (paper: RelatedPaper): Promise<void> => {
    const k = rowKey(paper);
    if (addingRef.current.has(k) || effInLib(paper)) return;
    if (!paper.doi) {
      await plugin.app.toast("This paper has no DOI — can't add it automatically.");
      return;
    }
    const ctx = await getCtx();
    const collectionKeys = await getHostCollectionKeys();
    const res = await addOne(paper, ctx, collectionKeys);
    if (res.message) await plugin.app.toast(res.message);
  };

  // Bulk-add all selected addable rows. `collectionKeys` undefined → the current item's collection(s)
  // (the plain Bulk-add button); a specific key array → the chevron's collection picker.
  const runBulkAdd = async (collectionKeys?: string[]): Promise<void> => {
    if (bulkBusy) return;
    const targets = baseList.filter((p) => selected.has(rowKey(p)) && !!p.doi && !effInLib(p));
    if (targets.length <= 1) {
      // Shouldn't happen now that the button gates on `selectableSelected`, but if the selection
      // changed between render and click, tell the user instead of silently doing nothing.
      await plugin.app.toast('Select 2 or more items (with a DOI, not already in your library) to bulk add.');
      return;
    }
    setBulkBusy(true);
    try {
      const ctx = await getCtx();
      const keys = collectionKeys ?? (await getHostCollectionKeys());
      let ok = 0;
      let fail = 0;
      // Sequential — be polite to Citoid/Zotero and give per-row ✓/Adding… feedback.
      for (const paper of targets) {
        const res = await addOne(paper, ctx, keys);
        if (res.ok) ok += 1;
        else fail += 1;
      }
      await plugin.app.toast(`Bulk add: ${ok} added${fail ? `, ${fail} failed` : ''}.`);
    } finally {
      setBulkBusy(false);
    }
  };
  const onBulkAdd = (): Promise<void> => runBulkAdd();

  // Load the full-path collection list (once) for the Add-to-collection picker.
  const ensureColls = async (): Promise<void> => {
    if (colls || collsLoadingRef.current) return;
    collsLoadingRef.current = true;
    setCollsError(false);
    try {
      const ctx = await getCtx();
      setColls(buildCollectionPaths(ctx.collections));
    } catch {
      // Leave `colls` null (NOT []) so the next picker open retries the load, and flag the error so
      // the picker shows a retry hint instead of a permanent "No collections".
      setCollsError(true);
    } finally {
      collsLoadingRef.current = false;
    }
  };

  // Toggle the collection picker for a row (its rowKey) or for bulk ('bulk'); load collections lazily.
  const onTogglePicker = (key: string): void => {
    setPickerFor((p) => (p === key ? null : key));
    if (!colls) void ensureColls();
  };

  // The user picked a collection (or "No collection" → null) from the open picker; run the add.
  const onPickCollection = async (collectionKey: string | null): Promise<void> => {
    const target = pickerFor;
    setPickerFor(null);
    if (!target) return;
    const collectionKeys = collectionKey ? [collectionKey] : [];
    if (target === 'bulk') {
      await runBulkAdd(collectionKeys);
      return;
    }
    const paper = baseList.find((p) => rowKey(p) === target);
    if (!paper) return;
    const ctx = await getCtx();
    const res = await addOne(paper, ctx, collectionKeys);
    if (res.message) await plugin.app.toast(res.message);
  };

  // scite tally for the focus paper (the header pill) — undefined while loading / no scite record.
  const focusTally = data.doi ? sciteMap.get(normalizeDoi(data.doi)) : undefined;
  // The always-visible external-link icons (brand logos). `icon` keys into BRAND_ICONS; no-DOI links
  // (Semantic Scholar / OpenAlex / Inciteful) fade in place.
  const brandLinks: ExternalLink[] = [
    { icon: 'zoteroApp', name: 'Zotero App', href: localUrl },
    { icon: 'zoteroWeb', name: 'Zotero Web', href: webUrl },
    { icon: 'connectedPapers', name: 'Connected Papers', href: connectedPapersUrl },
    { icon: 'semanticScholar', name: 'Semantic Scholar', href: semanticScholarUrl, disabled: !data.doi },
    { icon: 'googleScholar', name: 'Google Scholar', href: googleScholarUrl },
    { icon: 'openAlex', name: 'OpenAlex', href: openAlexUrl, disabled: !data.doi },
    { icon: 'inciteful', name: 'Inciteful', href: incitefulUrl, disabled: !data.doi },
    { icon: 'litmaps', name: 'Litmaps', href: litmapsUrl },
    { icon: 'researchRabbit', name: 'ResearchRabbit', href: researchRabbitUrl },
  ];

  return (
    <div className="w-full pb-1 text-sm rn-clr-content-primary">
      {/* The menu card. height stays 'auto' (the expandable list + inline menus rely on it). */}
      <div
        className="rn-clr-background-secondary"
        style={{ borderRadius: 6, padding: '10px 12px', border: `1px solid ${BORDER}` }}
      >
        {/* ZONE 1 — single action row, all items CENTERED: the ONE primary Sync button + a muted
            "synced …" caption, the always-visible external-link brand icons (icon-only, so all 9 fit),
            and the compact scite pill. */}
        <div
          className="flex items-center flex-wrap"
          style={{ justifyContent: 'center', columnGap: '0.6rem', rowGap: '0.3rem' }}
        >
          <ActionButton text={syncLabel} title={syncTitle} busy={syncing} onClick={onSync} />
          <span className="rn-clr-content-tertiary text-xs">{syncCaption}</span>
          <span className="flex flex-wrap items-center justify-center" style={{ columnGap: '0.4rem', rowGap: '0.4rem' }}>
            {brandLinks.map((l) => (
              <BrandLink key={l.icon} {...l} />
            ))}
          </span>
          {/* The scite pill: inline scite counts once loaded; otherwise a quiet "scite" link to the
              report (no-record DOIs included). */}
          {data.doi && (
            <span>
              {focusTally ? (
                <SciteRowCounts tally={focusTally} doi={data.doi} />
              ) : (
                <a
                  href={`https://scite.ai/reports/${encodeDoiPath(data.doi)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rn-clr-content-tertiary text-xs no-underline hover:underline"
                  title="scite.ai Smart Citations — click for the report"
                >
                  scite
                </a>
              )}
            </span>
          )}
        </div>

        {/* ZONE 2 — citations tab bar (only with a DOI): References | In Library | Citations | Related
            (single-open; the active tab gets a 2px accent underline that connects to the list below). */}
        {data.doi && (
          <div className="flex mt-2" style={{ alignItems: 'stretch', borderBottom: `1px solid ${BORDER}` }}>
            <BarTab
              count={countText(refs)}
              label="References"
              active={openList === 'refs'}
              disabled={semLoading || refs.length === 0}
              onClick={() => setOpenList((o) => (o === 'refs' ? null : 'refs'))}
            />
            <BarTab
              count={countText(inLibrary)}
              label="In Library"
              active={openList === 'inlib'}
              disabled={semLoading || inLibrary.length === 0}
              onClick={() => setOpenList((o) => (o === 'inlib' ? null : 'inlib'))}
            />
            <BarTab
              count={countText(cites)}
              label="Citations"
              active={openList === 'cites'}
              disabled={semLoading || cites.length === 0}
              onClick={() => setOpenList((o) => (o === 'cites' ? null : 'cites'))}
            />
            <BarTab
              count={countText(relatedWorks)}
              label="Related"
              active={openList === 'related'}
              disabled={semLoading || relatedWorks.length === 0}
              onClick={() => setOpenList((o) => (o === 'related' ? null : 'related'))}
            />
          </div>
        )}

        {/* The single open list: a toolbar (search + scope + sort + bulk-add), then numbered,
            paginated per-item cards, then the bottom pager. */}
        {data.doi && openList && baseList.length > 0 && (
          <div>
            <ListToolbar
              query={query}
              onQuery={(v) => {
                setQuery(v);
                setPage(1);
              }}
              scope={scope}
              onScope={(s) => {
                setScope(s);
                setScopeOpen(false);
                setPage(1);
              }}
              scopeOpen={scopeOpen}
              onToggleScope={() => setScopeOpen((o) => !o)}
              sortKey={sortKey}
              sortDir={sortDir}
              onSetSort={onSetSort}
              pageSize={pageSize}
              onSetPageSize={onSetPageSize}
              selectedCount={selectableSelected}
              onBulkAdd={onBulkAdd}
              onToggleBulkPicker={() => onTogglePicker('bulk')}
              bulkBusy={bulkBusy}
            />
            {pickerFor === 'bulk' && (
              <CollectionPicker
                collections={colls}
                loadError={collsError}
                onPick={onPickCollection}
                onClose={() => setPickerFor(null)}
              />
            )}
            {shown.length === 0 ? (
              <div className="mt-2 px-2 py-2 text-xs rn-clr-content-tertiary">No items match “{query}”.</div>
            ) : (
              <ul key={openList} className="list-none m-0 p-0 mt-2">
                {shown.map((p, i) => {
                  const inLib = effInLib(p);
                  const k = rowKey(p);
                  return (
                    <RelatedRow
                      key={k}
                      index={pageStart + i + 1}
                      paper={p}
                      scite={p.doi ? sciteMap.get(normalizeDoi(p.doi)) : undefined}
                      metrics={p.doi ? metricsMap.get(normalizeDoi(p.doi)) : undefined}
                      inLib={inLib}
                      remId={effRemId(p)}
                      selected={selected.has(k)}
                      adding={adding.has(k)}
                      addable={!!p.doi && !inLib}
                      pickerOpen={pickerFor === k}
                      collections={colls}
                      collsError={collsError}
                      onToggleSelect={toggleSelect}
                      onOpen={openRelated}
                      onAdd={onAdd}
                      onTogglePicker={onTogglePicker}
                      onPickCollection={onPickCollection}
                    />
                  );
                })}
              </ul>
            )}
            <Pager page={safePage} pageCount={pageCount} onPage={setPage} />
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(ItemMenu);
