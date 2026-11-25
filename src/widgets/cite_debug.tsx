/**
 * The "Remzot: Debug Citations Bar" popup (2026-11-24): why the on-page menu's citations bar shows
 * what it does on one page — nothing, zeros, or works. The checks, the verdict and the report text
 * live in lib/citeDebug.ts; this file runs them step by step and shows them as they come in.
 */
import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerText,
  type CheckState,
  citationsCountText,
  clock,
  countMenus,
  doiAsWritten,
  doiToAsk,
  duration,
  type Level,
  type MenuState,
  menusText,
  menuStateKey,
  menuText,
  readDoi,
  ranOutOfTime,
  readPage,
  reportText,
  SOURCE_TIME_LIMIT_MS,
  storedText,
  verdictFor,
  zoteroText,
} from '../lib/citeDebug';
import { SESSION } from '../lib/consts';
import { checkSources, sourceOutcome, type SourceCheck } from '../lib/semantic';

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

const LEVEL_COLOR: Record<Level, string> = {
  ok: 'var(--rn-clr-content-positive, #2e7d32)',
  info: 'var(--rn-clr-content-accent, #2563eb)',
  warn: '#d97706',
  error: 'var(--rn-clr-content-negative, #c62828)',
};
const LEVEL_ICON: Record<Level, string> = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' };

/** How long the popup waits for the menu to answer a Refresh before saying none did. */
const REFRESH_WAIT_MS = 10_000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div className="font-semibold" style={{ marginBottom: '0.25rem' }}>
        {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '11rem 1fr', columnGap: '0.75rem', rowGap: '0.2rem' }}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, children, tone }: { label: string; children: React.ReactNode; tone?: Level }) {
  return (
    <>
      <div className="rn-clr-content-secondary">{label}</div>
      <div style={{ color: tone && tone !== 'info' && tone !== 'ok' ? LEVEL_COLOR[tone] : undefined, overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </>
  );
}

function SourceRow({ c, now, startedAt }: { c: SourceCheck; now: number; startedAt: number }) {
  const outcome = c.done ? sourceOutcome(c) : null;
  const color =
    outcome === 'failed' ? LEVEL_COLOR.error : outcome === 'not-found' || !c.done ? 'var(--rn-clr-content-secondary)' : undefined;
  return (
    <tr style={{ color }}>
      <td style={{ padding: '0.15rem 0.75rem 0.15rem 0' }}>{c.name}</td>
      <td style={{ padding: '0.15rem 0.75rem 0.15rem 0' }}>
        {c.done ? answerText(c) : `asking… ${duration(now - startedAt)}`}
        {c.statuses.length > 0 && <span className="rn-clr-content-secondary"> [HTTP {c.statuses.join(', ')}]</span>}
      </td>
      <td style={{ padding: '0.15rem 0.75rem 0.15rem 0', textAlign: 'right' }}>{c.done ? c.count.toLocaleString() : ''}</td>
      <td style={{ padding: '0.15rem 0', textAlign: 'right', whiteSpace: 'nowrap' }}>{c.done ? duration(c.ms) : ''}</td>
    </tr>
  );
}

function CiteDebug() {
  const plugin = usePlugin();
  const [docId, setDocId] = useState('');
  const [state, setState] = useState<CheckState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [refreshAt, setRefreshAt] = useState(0);
  const [ctxError, setCtxError] = useState('');
  // The current run; an older run that is still going stops writing once a newer one starts.
  const runRef = useRef(0);

  // The page to check, passed by the command.
  useEffect(() => {
    plugin.widget
      .getWidgetContext<WidgetLocation.Popup>()
      .then((ctx) => {
        const id = ((ctx?.contextData ?? {}) as { docId?: string }).docId ?? '';
        if (id) setDocId(id);
        else setCtxError('RemNote passed no page to check.');
      })
      .catch((e: unknown) => setCtxError(e instanceof Error ? e.message : String(e)));
  }, [plugin]);

  // The latest page change in RemNote: a menu report written before it is from an earlier visit.
  const lastNavAt =
    useTrackerPlugin<number>(async (rp) => Number(await rp.storage.getSession(SESSION.navTick).catch(() => 0)) || 0, []) ?? 0;

  // What the on-page menu last showed on this page — live: it updates as the menu redraws. (Trackers
  // must never throw: in SDK 0.0.46 one that throws is never run again.)
  const menu = useTrackerPlugin<MenuState | null>(
    async (rp) =>
      docId ? (await rp.storage.getSession<MenuState>(menuStateKey(docId)).catch(() => undefined)) ?? null : null,
    [docId]
  );

  // A clock for "asking for N s" and the Refresh wait.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const run = useCallback(
    async (id: string) => {
      const runId = ++runRef.current;
      let s: CheckState = { docId: id, ranAt: Date.now(), finished: false };
      const put = (patch: Partial<CheckState>): void => {
        s = { ...s, ...patch };
        if (runRef.current === runId) setState(s);
      };
      put({});
      const page = await readPage(plugin, id);
      put({ page });
      if (!page.found || !page.isItem) return put({ finished: true });
      put({ menus: await countMenus(plugin) });
      const doi = await readDoi(plugin, id, page.key);
      put({ doi });
      const ask = doiToAsk(doi);
      if (!ask) return put({ finished: true });
      const shown = doiAsWritten(doi);
      const startedAt = Date.now();
      put({ sources: { doi: ask, shown, checks: [], counts: null, startedAt } });
      const res = await checkSources(ask, {
        timeoutMs: SOURCE_TIME_LIMIT_MS,
        onProgress: (checks) =>
          put({ sources: { doi: ask, shown, checks: checks.map((c) => ({ ...c, statuses: [...c.statuses] })), counts: null, startedAt } }),
      });
      put({
        sources: { doi: ask, shown, checks: res?.checks ?? [], counts: res?.counts ?? null, citationsCut: res?.citationsCut, startedAt },
        finished: true,
      });
    },
    [plugin]
  );

  useEffect(() => {
    if (docId) void run(docId);
  }, [docId, run]);

  const onRefresh = (): void => {
    const at = Date.now();
    setRefreshAt(at);
    plugin.storage.setSession(SESSION.citeRefresh, { docId, at }).catch((e: unknown) => {
      setRefreshAt(0);
      plugin.app.toast(`Couldn't ask the menu to refresh: ${e instanceof Error ? e.message : String(e)}`).catch(() => undefined);
    });
  };

  const verdict = state ? verdictFor(state, menu, now, lastNavAt) : null;
  const version = (() => {
    const v = plugin.manifest?.version as { major?: number; minor?: number; patch?: number } | undefined;
    return v ? `${v.major}.${v.minor}.${v.patch}` : '';
  })();
  const onCopy = async (): Promise<void> => {
    if (!state || !verdict) return;
    const ok = await copyToClipboard(reportText(state, menu, verdict, version));
    await plugin.app.toast(ok ? 'Report copied to the clipboard.' : "Couldn't copy the report.").catch(() => undefined);
  };

  const refreshNote = !refreshAt
    ? ''
    : menu?.refreshed === refreshAt
    ? `The menu read the page again (${clock(refreshAt)}).`
    : now - refreshAt > REFRESH_WAIT_MS
    ? "No menu answered the Refresh. Open this page so its Remzot menu shows, then press Refresh again; if it still doesn't answer, reload RemNote."
    : 'Asked the menu to read the page and the sources again…';

  const page = state?.page;
  const d = state?.doi;
  const src = state?.sources;
  const canRefresh = !!docId && !!page?.found && page.isItem;

  return (
    <div className="fixed inset-0 flex flex-col gap-3 p-5 overflow-hidden rn-clr-background-primary rn-clr-content-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Debug the citations bar</h1>
          <p className="text-sm rn-clr-content-secondary">
            {page?.found ? (
              <>
                On <b>{page.name || docId}</b>: why the on-page menu&apos;s citations bar shows what it does.
              </>
            ) : (
              "Why the on-page menu's citations bar shows what it does."
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => plugin.widget.closePopup()}
          title="Close"
          aria-label="Close"
          className="shrink-0 p-2 rounded-md rn-clr-content-secondary cursor-pointer"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {!docId ? (
        <div className="text-sm rn-clr-content-secondary">
          {ctxError ? `Couldn't tell which page to check: ${ctxError} Close this and run the command again.` : 'Finding the page…'}
        </div>
      ) : (
        verdict && (
          <div
            className="rounded-md"
            style={{
              padding: '0.75rem',
              borderLeft: `4px solid ${LEVEL_COLOR[verdict.level]}`,
              background: 'var(--rn-clr-background-secondary, rgba(128,128,128,0.08))',
            }}
          >
            <div className="font-semibold">
              {LEVEL_ICON[verdict.level]} {verdict.title}
            </div>
            {verdict.detail && <div className="text-sm" style={{ marginTop: '0.25rem' }}>{verdict.detail}</div>}
            {verdict.todo && (
              <div className="text-sm" style={{ marginTop: '0.25rem' }}>
                <b>What to do:</b> {verdict.todo}
              </div>
            )}
            <div className="flex gap-2" style={{ marginTop: '0.6rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={onRefresh}
                disabled={!canRefresh}
                title="Make this page's menu read the page again and ask the sources again"
                className={`px-4 py-2 rounded-md disabled:opacity-50 ${
                  verdict.refresh ? 'rn-clr-background-light-positive rn-clr-content-positive' : 'rn-clr-background-light-accent rn-clr-content-accent'
                }`}
              >
                Refresh the menu
              </button>
              <button
                type="button"
                onClick={() => void run(docId)}
                disabled={!state?.finished}
                title="Read the page and ask the sources again, here"
                className="px-4 py-2 rounded-md rn-clr-background-light-accent rn-clr-content-accent disabled:opacity-50"
              >
                Run again
              </button>
              <button
                type="button"
                onClick={onCopy}
                disabled={!state}
                title="Copy this report as text"
                className="px-4 py-2 rounded-md rn-clr-background-light-accent rn-clr-content-accent disabled:opacity-50"
              >
                Copy report
              </button>
            </div>
            {refreshNote && (
              <div className="text-xs rn-clr-content-secondary" style={{ marginTop: '0.5rem' }}>
                {refreshNote}
              </div>
            )}
          </div>
        )
      )}

      <div className="text-sm" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {page && (
          <Section title="The page">
            {page.found ? (
              <>
                <Row label="Name">{page.name || '(no name)'}</Row>
                <Row label="Zotero item" tone={page.isItem ? undefined : 'warn'}>
                  {page.isItem ? `yes — key ${page.key || '(none)'}` : 'no'}
                </Row>
              </>
            ) : (
              <Row label="Found" tone="error">
                no{page.error ? ` — ${page.error}` : ''}
              </Row>
            )}
          </Section>
        )}

        {page?.isItem && (
          <Section title="The on-page menu">
            <Row
              label="Registered"
              tone={state?.menus === undefined || state.menus === 1 || state.menus < 0 ? undefined : 'error'}
            >
              {state?.menus === undefined ? 'checking…' : menusText(state.menus)}
            </Row>
            <Row label="On this page" tone={!menu || menu.missing ? 'warn' : undefined}>
              {menuText(menu)}
            </Row>
            {menu?.bar === 'loading' && <Row label="Loading for">{duration(now - (menu.askingSince ?? menu.at))}</Row>}
          </Section>
        )}

        {d && (
          <Section title="The DOI">
            <Row label="As the menu reads it" tone={d.asMenu ? undefined : 'warn'}>
              {d.asMenu || '(none)'}
              {d.asMenuError ? ` — error: ${d.asMenuError}` : ''}
            </Row>
            <Row label="The property holds" tone={d.stored === 'missing-target' || d.stored === 'unreadable' ? 'error' : undefined}>
              {storedText(d)}
            </Row>
            <Row label="In Zotero" tone={d.zotero === 'error' ? 'warn' : undefined}>
              {zoteroText(d)}
            </Row>
          </Section>
        )}

        {state?.finished && page?.isItem && d && !src && (
          <Section title="The sources">
            <Row label="Asked">no — there is no DOI to ask about</Row>
          </Section>
        )}

        {src && (
          <div style={{ marginBottom: '1rem' }}>
            <div className="font-semibold" style={{ marginBottom: '0.25rem' }}>
              The sources, asked now about {src.shown || src.doi} ({clock(src.startedAt)})
            </div>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr className="rn-clr-content-secondary">
                  <th style={{ textAlign: 'left', fontWeight: 'normal', paddingRight: '0.75rem' }}>Source</th>
                  <th style={{ textAlign: 'left', fontWeight: 'normal', paddingRight: '0.75rem' }}>Answer</th>
                  <th style={{ textAlign: 'right', fontWeight: 'normal', paddingRight: '0.75rem' }}>Works</th>
                  <th style={{ textAlign: 'right', fontWeight: 'normal' }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {src.checks.map((c) => (
                  <SourceRow key={c.name} c={c} now={now} startedAt={src.startedAt} />
                ))}
              </tbody>
            </table>
            {src.counts ? (
              <div style={{ marginTop: '0.4rem' }}>
                The bar would show: References {src.counts.references.toLocaleString()} · Citations{' '}
                {citationsCountText(src.counts.citations, src.citationsCut)} · Related {src.counts.related.toLocaleString()}{' '}
                <span className="rn-clr-content-secondary">
                  (In Library isn&apos;t counted here{ranOutOfTime(src.checks) ? '; a source that ran out of time counts as 0' : ''})
                </span>
              </div>
            ) : (
              <div className="rn-clr-content-secondary" style={{ marginTop: '0.4rem' }}>
                Each source has {Math.round(SOURCE_TIME_LIMIT_MS / 1000)} s to answer here.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(CiteDebug);
