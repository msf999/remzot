import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildLibraryIndex,
  buildRows,
  canConvert,
  convertCitations,
  libraryDocFor,
  readPaper,
  scanForCitations,
  type ConvertResult,
  type LibraryIndex,
  type NumberRow,
  type PaperInfo,
  type PaperOutcome,
  type ScanResult,
} from '../lib/citeConvert';
import { SESSION, SETTINGS } from '../lib/consts';
import { SyncLog } from '../lib/log';
import { fetchNumberedReferences, type NumberedRef, type NumberedRefList } from '../lib/semantic';
import { buildSyncContext, type SyncContext } from '../lib/sync';
import { fetchItemByKey, findZoteroItemByDoi } from '../lib/zoteroApi';

/** Where a not-yet-in-library reference stands in Zotero (checked in the background). */
type ZoteroStatus = 'checking' | 'zotero' | 'both' | 'new';

type Phase = 'loading' | 'ready' | 'converting' | 'done' | 'failed';

/** Copy text to the clipboard, falling back to a hidden textarea + execCommand. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (clipboard API can be blocked inside iframes)
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Flatten Zotero's collections into full-path options, sorted by path. Cycle-guarded. */
function collectionPaths(collections: { key: string; name: string; parentKey: string | null }[]): { key: string; path: string }[] {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const pathOf = (c: { key: string; name: string; parentKey: string | null }): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur: typeof c | undefined = c;
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      parts.unshift(cur.name);
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
    return parts.join(' / ');
  };
  return collections.map((c) => ({ key: c.key, path: pathOf(c) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** "12. Title — Smith (2019)" for the dropdown, kept short enough to scan. Crossref has entries with
 *  nothing but a venue ("private communication") or a year of "0"; those say so. */
function optionLabel(r: NumberedRef): string {
  const p = r.paper;
  const title = p.title || p.fallbackTitle || p.doi || (p.venue ? `(${p.venue})` : '(no details in Crossref)');
  const year = p.year && p.year !== '0' ? p.year : '';
  const who = [p.authors, year].filter(Boolean).join(' ');
  const text = `${r.label ? `${r.label}. ` : ''}${title}${who ? ` — ${who}` : ''}`;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

const POSITIVE = 'var(--rn-clr-content-positive, #15803d)';
const NEGATIVE = 'var(--rn-clr-content-negative, #b91c1c)';
const WARNING = 'var(--rn-clr-content-warning, #b45309)';

export const ConvertCitations = () => {
  const plugin = usePlugin();
  const [phase, setPhase] = useState<Phase>('loading');
  const [stage, setStage] = useState('Reading the rems…');
  const [paper, setPaper] = useState<PaperInfo | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [lib, setLib] = useState<LibraryIndex | null>(null);
  const [refs, setRefs] = useState<NumberedRefList | null>(null);
  const [rows, setRows] = useState<NumberRow[]>([]);
  const [zotero, setZotero] = useState<Record<string, ZoteroStatus>>({});
  const [colls, setColls] = useState<{ key: string; path: string }[]>([]);
  const [hostCols, setHostCols] = useState<string[]>([]);
  // 'host' = the paper's own collection(s), offered once Zotero has said what they are.
  const [collChoice, setCollChoice] = useState<string>('none');
  const [zoteroProblem, setZoteroProblem] = useState('');
  const [incremental, setIncremental] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<Map<number, PaperOutcome>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [error, setError] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [, setLogTick] = useState(0);
  const logRef = useRef(new SyncLog());
  const ctxRef = useRef<Promise<SyncContext> | null>(null);
  const checkedRef = useRef(new Set<string>());

  const getContext = (): Promise<SyncContext> => {
    if (!ctxRef.current) {
      ctxRef.current = buildSyncContext(plugin, logRef.current).catch((err) => {
        ctxRef.current = null;
        throw err;
      });
    }
    return ctxRef.current;
  };

  // Load: the paper, the citations, the library, the reference list.
  useEffect(() => {
    let cancelled = false;
    const log = logRef.current;
    void (async () => {
      try {
        const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
        const data = (ctx?.contextData ?? {}) as { paperId?: string; rootIds?: string[] };
        if (!data.paperId || !data.rootIds?.length) throw new Error('Run Remzot: Convert Inline Citations from a rem under a paper.');
        const p = await readPaper(plugin, data.paperId);
        if (!p) throw new Error('That paper no longer exists.');
        if (!p.doi) throw new Error(`${p.name} has no DOI, so Remzot can't get its reference list.`);
        if (cancelled) return;
        setPaper(p);
        log.section(`Convert inline citations in ${p.name} (${p.doi})`);

        const found = await scanForCitations(plugin, data.paperId, data.rootIds);
        log.log('scan', `${found.rems.length} rem(s) with citations out of ${found.remsScanned} scanned.`);
        if (cancelled) return;
        setScan(found);

        setStage('Reading your library…');
        const index = await buildLibraryIndex(plugin);
        log.log('scan', `Library: ${index.byKey.size} synced doc(s), ${index.byDoi.size} with a DOI.`);
        if (cancelled) return;
        setLib(index);

        setStage("Getting the paper's reference list…");
        const list = await fetchNumberedReferences(p.doi, index.byDoi);
        log.log('scan', `Reference list: ${list.refs.length} entr(ies) from ${list.source}, ${list.numbered ? 'numbered' : 'NOT numbered'}.`);
        if (cancelled) return;
        setRefs(list);
        setRows(buildRows(found, list, index));
        setIncremental(!!(await plugin.settings.getSetting<boolean>(SETTINGS.initIncremental).catch(() => false)));
        setPhase('ready');
        setStage('');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  // Once ready, in the background: Zotero's collections and this paper's own collections.
  useEffect(() => {
    if (phase !== 'ready' || !paper) return;
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await getContext();
        if (cancelled) return;
        setColls(collectionPaths(ctx.collections));
        const host = paper.key ? await fetchItemByKey(plugin, paper.key).catch(() => null) : null;
        if (cancelled) return;
        const cols = host?.data.collections ?? [];
        setHostCols(cols);
        // Default to the paper's own collections, unless a collection was already picked by hand.
        if (cols.length) setCollChoice((c) => (c === 'none' ? 'host' : c));
      } catch (err) {
        if (!cancelled) setZoteroProblem(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paper, plugin]);

  // In the background: is each matched reference that is NOT in the library already in Zotero?
  const pending = useMemo(() => {
    if (!refs || !lib) return [];
    const byDoi = new Map<string, string>();
    for (const row of rows)
      for (const a of row.assignments) {
        if (a.refIndex === null) continue;
        const p = refs.refs[a.refIndex].paper;
        if (p.doi && !libraryDocFor(p, lib)) byDoi.set(p.doi, p.title || p.fallbackTitle || '');
      }
    return [...byDoi].map(([doi, title]) => ({ doi, title }));
  }, [rows, refs, lib]);

  useEffect(() => {
    if (phase !== 'ready' || !lib) return;
    const todo = pending.filter((p) => !checkedRef.current.has(p.doi));
    if (!todo.length) return;
    for (const p of todo) checkedRef.current.add(p.doi);
    setZotero((z) => ({ ...z, ...Object.fromEntries(todo.map((p) => [p.doi, 'checking' as ZoteroStatus])) }));
    void (async () => {
      const queue = [...todo];
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const { doi, title } = next;
          const item = await findZoteroItemByDoi(plugin, doi, undefined, title).catch(() => null);
          const status: ZoteroStatus = item ? (lib.byKey.has(item.key) ? 'both' : 'zotero') : 'new';
          setZotero((z) => ({ ...z, [doi]: status }));
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    })();
  }, [pending, phase, lib, plugin]);

  const busy = phase === 'converting';
  const tickedCount = rows.reduce((s, r) => s + r.assignments.filter((a) => a.ticked && a.refIndex !== null).length, 0);
  const tickable = rows.flatMap((r) =>
    r.assignments.filter((a) => a.refIndex !== null && refs && lib && canConvert(refs.refs[a.refIndex].paper, lib))
  );
  const allTicked = tickable.length > 0 && tickable.every((a) => a.ticked);
  const someTicked = tickable.some((a) => a.ticked);

  const setAssignment = (n: number, id: string, patch: Partial<{ refIndex: number | null; ticked: boolean }>): void =>
    setRows((rs) =>
      rs.map((r) => (r.n !== n ? r : { ...r, assignments: r.assignments.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
    );

  const setAllTicked = (on: boolean): void =>
    setRows((rs) =>
      rs.map((r) => ({
        ...r,
        assignments: r.assignments.map((a) =>
          a.refIndex !== null && refs && lib && canConvert(refs.refs[a.refIndex].paper, lib) ? { ...a, ticked: on } : a
        ),
      }))
    );

  const statusOf = (r: NumberedRef): { text: string; color?: string } => {
    if (!lib) return { text: '' };
    if (libraryDocFor(r.paper, lib)) return { text: '✓ in your library', color: POSITIVE };
    if (!r.paper.doi) return { text: "no DOI — can't be added" };
    switch (zotero[r.paper.doi]) {
      case 'checking':
        return { text: 'checking Zotero…' };
      case 'both':
        return { text: '✓ in Zotero and your library', color: POSITIVE };
      case 'zotero':
        return { text: 'in Zotero — its RemNote doc will be made' };
      case 'new':
        return { text: 'new — will be added to Zotero and RemNote' };
      default:
        return { text: 'not in your library — will be added' };
    }
  };

  const collectionKeys = collChoice === 'host' ? hostCols : collChoice === 'none' ? [] : [collChoice];

  const handleConvert = async (): Promise<void> => {
    if (!scan || !refs || !lib || busy || !tickedCount) return;
    setPhase('converting');
    setProgress({ done: 0, total: 1 });
    const log = logRef.current;
    try {
      const res = await convertCitations(
        plugin,
        { scan, rows, refs, lib, getContext, collectionKeys },
        {
          onPaper: (o) => setOutcomes((m) => new Map(m).set(o.refIndex, o)),
          onProgress: (done, total) => setProgress({ done, total }),
        },
        log
      );
      setResult(res);
      setPhase('done');
      if (res.added.length) {
        // The on-page menu (its own iframe and caches) turns these rows "✓ In library". Appended, so
        // a menu that wasn't open during an earlier conversion still learns about its papers.
        const earlier = ((await plugin.storage.getSession(SESSION.addedPapers).catch(() => undefined)) ?? []) as ConvertResult['added'];
        await plugin.storage.setSession(SESSION.addedPapers, [...earlier, ...res.added]).catch(() => undefined);
      }
      const created = res.papers.filter((p) => p.how === 'created').length;
      const adopted = res.papers.filter((p) => p.how === 'adopted').length;
      const failed = res.papers.filter((p) => !p.ok).length;
      await plugin.app.toast(
        `Converted ${res.groupsConverted} citation group${res.groupsConverted === 1 ? '' : 's'} in ${res.remsChanged} rem${
          res.remsChanged === 1 ? '' : 's'
        }` +
          (created ? ` — ${created} paper${created === 1 ? '' : 's'} added to Zotero` : '') +
          (adopted ? `, ${adopted} given a RemNote doc` : '') +
          (failed ? `, ${failed} failed` : '') +
          '.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
      log.log('convert', `FAILED: ${err instanceof Error ? err.message : String(err)}`);
      await plugin.app.toast(`Converting citations failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLogTick((t) => t + 1);
    }
  };

  const places = scan ? scan.rems.reduce((s, r) => s + r.occurrences.length, 0) : 0;
  const summary = result
    ? `Done. Converted ${result.groupsConverted} citation group${result.groupsConverted === 1 ? '' : 's'} in ${result.remsChanged} rem${
        result.remsChanged === 1 ? '' : 's'
      } (${result.citesWritten} citekey${result.citesWritten === 1 ? '' : 's'}). Papers: ` +
      `${result.papers.filter((p) => p.how === 'library').length} already in your library, ` +
      `${result.papers.filter((p) => p.how === 'created').length} added to Zotero and RemNote, ` +
      `${result.papers.filter((p) => p.how === 'adopted').length} from Zotero given a RemNote doc, ` +
      `${result.papers.filter((p) => p.how === 'existing-doc').length} found in both, ` +
      `${result.papers.filter((p) => !p.ok).length} failed.` +
      (result.remsSkipped.length ? ` ${result.remsSkipped.length} rem(s) skipped: ${result.remsSkipped[0].reason}.` : '')
    : '';
  const progressPct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const refOptions = useMemo(
    () =>
      (refs?.refs ?? []).map((r, i) => (
        <option key={i} value={i}>
          {optionLabel(r)}
        </option>
      )),
    [refs]
  );

  return (
    <div className="fixed inset-0 flex flex-col gap-3 p-5 overflow-hidden rn-clr-background-primary rn-clr-content-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Convert inline citations</h1>
          <p className="text-sm rn-clr-content-secondary">
            {paper ? (
              <>
                In <b>{paper.name}</b>: turns its citation numbers — [2], [2,3], [34–37] — into{' '}
                <code>\cite{'{'}citekeys{'}'}</code>, matched to this paper&apos;s reference list. Check each match,
                change it in the dropdown or untick it; nothing changes until you press Convert.
              </>
            ) : (
              'Turns a paper’s citation numbers into \\cite{citekeys}, matched to its reference list.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => plugin.widget.closePopup()}
          disabled={busy}
          title={busy ? 'Wait — closing now would stop the conversion half-way' : 'Close'}
          aria-label="Close"
          className="shrink-0 p-2 rounded-md rn-clr-content-secondary cursor-pointer disabled:opacity-50 disabled:cursor-default"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {phase === 'loading' && <div className="text-sm rn-clr-content-secondary">{stage}</div>}
      {phase === 'failed' && (
        <div className="text-sm" style={{ color: NEGATIVE }}>
          {error}
        </div>
      )}

      {refs && scan && lib && (
        <>
          <div className="text-sm rn-clr-content-secondary" data-testid="convert-status">
            {summary ||
              `Found ${rows.length} citation number${rows.length === 1 ? '' : 's'} in ${places} place${places === 1 ? '' : 's'} across ${
                scan.rems.length
              } rem${scan.rems.length === 1 ? '' : 's'}. Reference list: ${refs.refs.length} reference${refs.refs.length === 1 ? '' : 's'}${
                refs.source === 'Crossref' ? ' from Crossref' : refs.source === 'other' ? ' from Semantic Scholar, OpenAlex and OpenCitations' : ''
              }.`}
          </div>
          {refs.source === 'none' && (
            <div className="text-sm" style={{ color: WARNING }}>
              No reference list was found for this paper (Crossref, Semantic Scholar, OpenAlex, OpenCitations), so there is
              nothing to match against.
            </div>
          )}
          {refs.source === 'Crossref' && !refs.numbered && (
            <div className="text-sm" style={{ color: WARNING }}>
              Crossref lists this paper&apos;s references without their numbers, so nothing was matched — pick each one.
            </div>
          )}
          {refs.source === 'other' && (
            <div className="text-sm" style={{ color: WARNING }}>
              Crossref has no reference list for this paper; the list comes from Semantic Scholar, OpenAlex and
              OpenCitations without numbers — pick each reference.
            </div>
          )}
        </>
      )}

      {refs && scan && lib && (
        <div className="flex-1 min-h-0 overflow-auto rounded-md rn-clr-background-secondary p-3" data-testid="convert-list">
          <div className="flex items-center gap-2 pb-2 mb-1 font-semibold border-b border-gray-300">
            <input
              type="checkbox"
              aria-label="Tick every match"
              checked={allTicked}
              ref={(el) => {
                if (el) el.indeterminate = someTicked && !allTicked;
              }}
              disabled={busy || phase === 'done' || !tickable.length}
              onChange={(e) => setAllTicked(e.target.checked)}
            />
            <span style={{ width: '4.5rem' }}>Number</span>
            <span className="flex-1">Reference</span>
          </div>
          {rows.map((row) => {
            const open = expanded.has(row.n);
            const doubtful = row.occurrences.filter((o) => o.doubt).length;
            return (
              <div key={row.n} className="py-2 border-b border-gray-300" data-number={row.n}>
                {row.assignments.map((a, k) => {
                  const ref = a.refIndex !== null ? refs?.refs[a.refIndex] : undefined;
                  const convertible = !!ref && !!lib && canConvert(ref.paper, lib);
                  const status = ref ? statusOf(ref) : { text: '' };
                  const outcome = a.refIndex !== null ? outcomes.get(a.refIndex) : undefined;
                  const shown = phase === 'done' && a.ticked && outcome;
                  return (
                    <div key={a.id} className="flex items-center gap-2" style={{ minHeight: '1.9rem' }} data-assignment={a.id}>
                      <input
                        type="checkbox"
                        aria-label={`Convert [${row.n}]`}
                        checked={a.ticked && a.refIndex !== null}
                        disabled={busy || phase === 'done' || !convertible}
                        onChange={(e) => setAssignment(row.n, a.id, { ticked: e.target.checked })}
                      />
                      <span className="font-mono text-sm shrink-0" style={{ width: '4.5rem' }}>
                        {k === 0 ? `[${row.n}]` : ''}
                      </span>
                      <select
                        aria-label={`Reference for [${row.n}]`}
                        value={a.refIndex === null ? '' : String(a.refIndex)}
                        disabled={busy || phase === 'done'}
                        onChange={(e) => {
                          const refIndex = e.target.value === '' ? null : Number(e.target.value);
                          const ok = refIndex !== null && !!refs && !!lib && canConvert(refs.refs[refIndex].paper, lib);
                          setAssignment(row.n, a.id, { refIndex, ticked: ok });
                        }}
                        className="flex-1 min-w-0 text-sm rounded-md px-1 py-1 rn-clr-background-primary rn-clr-content-primary"
                        style={{ border: '1px solid var(--rn-clr-border-opaque, #ccc)' }}
                      >
                        <option value="">— pick the reference —</option>
                        {refOptions}
                      </select>
                      <span className="shrink-0 text-xs" style={{ width: '15rem', color: shown ? (outcome.ok ? POSITIVE : NEGATIVE) : status.color }}>
                        {shown ? `${outcome.ok ? '✅' : '❌'} ${outcome.ok ? outcomeText(outcome) : outcome.message}` : status.text}
                      </span>
                    </div>
                  );
                })}
                {row.missing && (
                  <div className="text-xs rn-clr-content-tertiary" style={{ paddingLeft: '6.6rem' }}>
                    Not matched: {row.missing}.
                  </div>
                )}
                {doubtful > 0 && (
                  <div className="text-xs" style={{ paddingLeft: '6.6rem', color: WARNING }}>
                    {row.doubt
                      ? `Left unticked — this may not be a citation: ${row.doubt}.`
                      : `${doubtful} of ${row.occurrences.length} places may not be a citation (${row.occurrences.find((o) => o.doubt)?.doubt}).`}
                  </div>
                )}
                <div className="text-xs rn-clr-content-secondary" style={{ paddingLeft: '6.6rem' }}>
                  {(open ? row.occurrences : row.occurrences.slice(0, 1)).map((o, i) => (
                    <div key={i} className="truncate" title={`${o.context.before}${o.context.match}${o.context.after}`}>
                      {o.context.before}
                      <b className="rn-clr-content-primary">{o.context.match}</b>
                      {o.context.after}
                    </div>
                  ))}
                  {row.occurrences.length > 1 && (
                    <button
                      type="button"
                      className="underline cursor-pointer rn-clr-content-tertiary"
                      onClick={() =>
                        setExpanded((s) => {
                          const next = new Set(s);
                          if (next.has(row.n)) next.delete(row.n);
                          else next.add(row.n);
                          return next;
                        })
                      }
                    >
                      {open ? 'show one place' : `show all ${row.occurrences.length} places`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {refs && scan && lib && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="rn-clr-content-secondary">File added papers in</span>
            <select
              aria-label="Zotero collection for added papers"
              value={collChoice}
              disabled={busy || phase === 'done'}
              onChange={(e) => setCollChoice(e.target.value)}
              className="text-sm rounded-md px-1 py-1 rn-clr-background-primary rn-clr-content-primary"
              style={{ border: '1px solid var(--rn-clr-border-opaque, #ccc)', maxWidth: '22rem' }}
            >
              {hostCols.length > 0 && (
                <option value="host">
                  This paper&apos;s collection{hostCols.length > 1 ? 's' : ''}:{' '}
                  {hostCols.map((k) => colls.find((c) => c.key === k)?.path ?? k).join(', ')}
                </option>
              )}
              <option value="none">No collection</option>
              {colls.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.path}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs rn-clr-content-tertiary">
            {incremental ? 'New docs are also made Incremental (your setting).' : ''}
          </span>
          <div className="flex-1" />
          {progress && phase === 'converting' && (
            <div className="flex items-center gap-2" style={{ width: '12rem' }}>
              <div className="flex-1 h-2 rounded-full overflow-hidden rn-clr-background-secondary">
                <div className="h-full transition-all" style={{ width: `${progressPct}%`, backgroundColor: 'var(--rn-clr-content-accent)' }} />
              </div>
              <span className="text-xs rn-clr-content-secondary whitespace-nowrap">
                {progress.done}/{progress.total}
              </span>
            </div>
          )}
          {phase === 'done' ? (
            <button
              type="button"
              onClick={() => plugin.widget.closePopup()}
              className="px-4 py-2 rounded-md rn-clr-background-light-accent rn-clr-content-accent"
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              onClick={handleConvert}
              disabled={busy || !tickedCount}
              className="px-4 py-2 rounded-md rn-clr-background-light-positive rn-clr-content-positive disabled:opacity-50"
            >
              {busy ? 'Converting…' : `Convert (${tickedCount})`}
            </button>
          )}
        </div>
      )}
      {zoteroProblem && (
        <div className="text-xs" style={{ color: WARNING }}>
          Zotero couldn&apos;t be reached ({zoteroProblem}) — papers that are not in your library can&apos;t be added.
        </div>
      )}

      <div className="text-xs">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setLogOpen((o) => !o)} aria-expanded={logOpen} className="font-semibold cursor-pointer hover:underline">
            {logOpen ? '▾' : '▸'} Log
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await copyToClipboard(logRef.current.toText());
              await plugin.app.toast(ok ? 'Log copied to the clipboard.' : "Couldn't copy the log.");
            }}
            aria-label="Copy the log to the clipboard"
            title="Copy the log to the clipboard"
            className="p-1 rounded-md rn-clr-background-light-accent rn-clr-content-accent cursor-pointer"
          >
            Copy log
          </button>
        </div>
        {logOpen && (
          <pre className="mt-1 rn-clr-content-secondary overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: '10rem' }}>
            {logRef.current.toText()}
          </pre>
        )}
      </div>
    </div>
  );
};

/** What happened to a cited paper, in a few words. */
function outcomeText(o: PaperOutcome): string {
  switch (o.how) {
    case 'library':
      return 'cited (in your library)';
    case 'created':
      return 'added to Zotero and RemNote';
    case 'adopted':
      return 'RemNote doc made (was in Zotero)';
    case 'existing-doc':
      return 'cited (in Zotero and RemNote)';
    default:
      return o.message;
  }
}

renderWidget(ConvertCitations);
