/**
 * "Remzot: Debug Citations Bar" (2026-11-24) — from mo's RemNote to-do "add a debug command for
 * checking if no citations/refs are rendered".
 *
 * The on-page menu's citations bar shows nothing, or zeros, in cases that look alike:
 *   - the menu read no DOI: the bar is hidden and the DOI-only links say "needs a DOI";
 *   - the item has no DOI at all, in RemNote or in Zotero;
 *   - a source failed (rate-limited, offline) or is still being asked — a very highly cited paper
 *     makes OpenCitations send every citation at once;
 *   - the sources really have nothing for the paper.
 * For the page open in the focused pane, the popup (widgets/cite_debug.tsx) shows:
 *   - the page: is it a Zotero item, and its key;
 *   - the menu: registered once? What it last showed on this page — the menu writes
 *     that per page to session storage (`MenuState` under `menuStateKey`), and the popup reads it live;
 *   - the DOI now: as the menu reads it, what the property holds, and Zotero's;
 *   - the sources now: each asked afresh (`checkSources`), with its answer;
 * then a verdict (`verdictFor`) saying what to do. Refresh (`SESSION.citeRefresh`) makes that page's
 * menu read the page again and ask the sources again.
 */
import { WidgetLocation, type RNPlugin } from '@remnote/plugin-sdk';
import {
  CITE_DEBUG_WIDGET,
  ITEM_MENU_WIDGET,
  REMZOT_PLUGIN_ID,
  SESSION,
  SLOTS,
  ZOTERO_ITEM_POWERUP,
} from './consts';
import { safeRichTextToString } from './notes';
import { normalizeDoi, sourceOutcome, type SourceCheck } from './semantic';
import { fetchItemByKey, parseDoiFromExtra } from './zoteroApi';

export const DEBUG_COMMAND = 'Remzot: Debug Citations Bar';

/** How long the popup lets one source take before calling it "no answer". */
export const SOURCE_TIME_LIMIT_MS = 45_000;

/** How long the popup waits for Zotero's copy of the item. */
export const ZOTERO_TIME_LIMIT_MS = 20_000;

/** How long after a page change the menu has to report on the page it now shows. */
const MENU_REPORT_GRACE_MS = 5_000;

const errText = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e));

// ───────────────────────── What the menu shows (written by item_menu.tsx) ─────────────────────────

/** The bar's four tab counts. */
export interface ListCounts {
  references: number;
  inLibrary: number;
  citations: number;
  related: number;
}

/** What the on-page menu last showed on one page. */
export interface MenuState {
  /** Set when the menu showed nothing: RemNote returned nothing for the page ('page'), didn't report
   *  the Zotero Item tag on it ('not-item'), or a read of the page failed ('error' — see `error`). */
  missing?: 'page' | 'not-item' | 'error';
  error?: string;
  /** The DOI the menu read; '' → the bar is hidden. */
  doi?: string;
  bar?: 'hidden' | 'loading' | 'shown';
  /** While loading: when the lookup under way began (epoch ms). */
  askingSince?: number;
  counts?: ListCounts;
  /** When the sources behind `counts` were asked (epoch ms). */
  askedAt?: number;
  /** Sources that failed in that ask, in words. */
  failed?: string[];
  /** The Refresh (its `at`) this state answers, if any. */
  refreshed?: number;
  /** The page change (SESSION.navTick) the menu drew this for — every page change makes it write again. */
  navAt?: number;
  /** When the menu wrote this (epoch ms). */
  at: number;
}

export const menuStateKey = (docId: string): string => `${SESSION.menuStatePrefix}${docId}`;

/** A source's answer in words: "answered", "doesn't have this paper (404)", "rate-limited (429)"… */
export function answerText(c: SourceCheck): string {
  if (!c.done) return 'asking…';
  const outcome = sourceOutcome(c);
  if (outcome === 'answered') return 'answered';
  if (outcome === 'not-found') return "doesn't have this paper (404)";
  if (c.error) {
    // Cut off by the time limit after the answer began: it was still coming in.
    if (c.error.startsWith('no answer within') && c.statuses.some((s) => s >= 200 && s < 300)) {
      return c.error.replace('no answer within', 'still sending after');
    }
    return c.error.startsWith('no answer') ? c.error : `no answer (${c.error})`;
  }
  const bad = c.statuses.find((s) => s < 200 || s >= 300) ?? 0;
  if (bad === 429) return 'rate-limited (429)';
  if (bad === 408) return 'timed out (408)';
  if (bad >= 500) return `server error (${bad})`;
  return `refused (${bad})`;
}

/** The failed sources among `checks`, e.g. "Semantic Scholar citations: rate-limited (429)". */
export function failedSources(checks: SourceCheck[]): string[] {
  return checks.filter((c) => c.done && sourceOutcome(c) === 'failed').map((c) => `${c.name}: ${answerText(c)}`);
}

export const clock = (ms?: number): string => (ms ? new Date(ms).toLocaleTimeString() : '?');

export function duration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

const n = (x: number): string => x.toLocaleString();

export const countsText = (c: ListCounts): string =>
  `References ${n(c.references)} · In Library ${n(c.inLibrary)} · Citations ${n(c.citations)} · Related ${n(c.related)}`;

// ───────────────────────── The checks ─────────────────────────

export interface PageInfo {
  found: boolean;
  name: string;
  isItem: boolean;
  /** Its Zotero key ('' if none). */
  key: string;
  error: string;
}

/** The page: found? a Zotero item? its key. `error` with `found` set: the page is there, but a later
 *  read (tag, key) failed. */
export async function readPage(plugin: RNPlugin, docId: string): Promise<PageInfo> {
  let rem;
  try {
    rem = await plugin.rem.findOne(docId);
  } catch (e) {
    return { found: false, name: '', isItem: false, key: '', error: errText(e) };
  }
  if (!rem) return { found: false, name: '', isItem: false, key: '', error: '' };
  const page: PageInfo = { found: true, name: '', isItem: false, key: '', error: '' };
  try {
    page.name = (await safeRichTextToString(plugin, rem.text)).trim();
    page.isItem = await rem.hasPowerup(ZOTERO_ITEM_POWERUP);
    if (page.isItem) page.key = ((await rem.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.key)) ?? '').trim();
  } catch (e) {
    page.error = errText(e);
  }
  return page;
}

/** How many times the menu is registered (WidgetLocation.DocumentBelowTitle) — once is right; -1 if
 *  RemNote didn't say. */
export async function countMenus(plugin: RNPlugin): Promise<number> {
  try {
    const ownId = plugin.id ?? REMZOT_PLUGIN_ID;
    const count = async (): Promise<number> =>
      ((await plugin.widget.getWidgetsAtLocation(WidgetLocation.DocumentBelowTitle)) ?? []).filter(
        (w) => w.pluginId === ownId && w.fileName === ITEM_MENU_WIDGET
      ).length;
    let found = await count();
    // menuOrder.ts takes the menu off the list for a moment to move it below Incremental Everything's
    // chip: ask again before saying it isn't registered.
    for (let i = 0; i < 3 && found === 0; i++) {
      await new Promise((r) => setTimeout(r, 400));
      found = await count();
    }
    return found;
  } catch {
    return -1;
  }
}

/** The page's DOI, three ways. */
export interface DoiInfo {
  /** As the on-page menu reads it: the property's text ('' if none). */
  asMenu: string;
  asMenuError: string;
  /** What the property holds: a link rem (how Remzot writes it), plain text (older syncs), nothing,
   *  a link to a rem RemNote doesn't return, or a value that couldn't be read. */
  stored: 'link' | 'text' | 'empty' | 'missing-target' | 'unreadable';
  /** The DOI that value gives, as written there ('' if none) — normalized only to compare or ask. */
  storedDoi: string;
  /** The linked rem, for `missing-target`. */
  targetId: string;
  storedError: string;
  /** Zotero's DOI for the item: its DOI field, or a "DOI:" line in Extra. */
  zotero: 'found' | 'none' | 'not-in-zotero' | 'no-key' | 'error';
  /** As Zotero has it ('' if none). */
  zoteroDoi: string;
  zoteroError: string;
}

export async function readDoi(plugin: RNPlugin, docId: string, key: string): Promise<DoiInfo> {
  const d: DoiInfo = {
    asMenu: '',
    asMenuError: '',
    stored: 'unreadable',
    storedDoi: '',
    targetId: '',
    storedError: '',
    zotero: 'no-key',
    zoteroDoi: '',
    zoteroError: '',
  };
  const rem = await plugin.rem.findOne(docId).catch(() => undefined);
  if (rem) {
    try {
      d.asMenu = ((await rem.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.doi)) ?? '').trim();
    } catch (e) {
      d.asMenuError = errText(e);
    }
    try {
      const rich = (await rem.getPowerupPropertyAsRichText(ZOTERO_ITEM_POWERUP, SLOTS.doi)) ?? [];
      const ref = rich.find((el) => typeof el === 'object' && el !== null && (el as { i?: unknown }).i === 'q') as
        | { _id?: string }
        | undefined;
      if (ref?._id) {
        d.targetId = ref._id;
        const target = await plugin.rem.findOne(ref._id);
        if (target) {
          d.stored = 'link';
          d.storedDoi = (await safeRichTextToString(plugin, target.text)).trim();
        } else {
          d.stored = 'missing-target';
        }
      } else {
        const text = (await safeRichTextToString(plugin, rich)).trim();
        d.stored = text ? 'text' : 'empty';
        d.storedDoi = text;
      }
    } catch (e) {
      d.stored = 'unreadable';
      d.storedError = errText(e);
    }
  } else {
    d.storedError = 'RemNote returned nothing for the page';
  }
  if (key) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ZOTERO_TIME_LIMIT_MS);
    try {
      const item = await fetchItemByKey(plugin, key, undefined, stop.signal);
      if (!item) {
        d.zotero = 'not-in-zotero';
      } else {
        d.zoteroDoi = (item.data?.DOI || parseDoiFromExtra(item.data?.extra) || '').trim();
        d.zotero = normalizeDoi(d.zoteroDoi) ? 'found' : 'none';
      }
    } catch (e) {
      d.zotero = 'error';
      d.zoteroError = stop.signal.aborted ? `no answer within ${Math.round(ZOTERO_TIME_LIMIT_MS / 1000)} s` : errText(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return d;
}

/** The DOI to show for the sources' ask, as written: as the menu reads it, else what the property
 *  holds, else Zotero's. */
export const doiAsWritten = (d: DoiInfo): string => [d.asMenu, d.storedDoi, d.zoteroDoi].find((x) => normalizeDoi(x)) ?? '';

/** The DOI to ask the sources about (normalized). */
export const doiToAsk = (d: DoiInfo): string => normalizeDoi(doiAsWritten(d));

/** The sources, asked afresh by the popup. */
export interface SourcesInfo {
  /** The DOI asked about (normalized) and as written. */
  doi: string;
  shown: string;
  checks: SourceCheck[];
  /** The lists the bar would hold (In Library aside); null while asking. */
  counts: { references: number; citations: number; related: number } | null;
  startedAt: number;
}

/** One run of the checks, filled in step by step. */
export interface CheckState {
  docId: string;
  ranAt: number;
  page?: PageInfo;
  menus?: number;
  doi?: DoiInfo;
  /** Undefined until asked — and when no DOI could be found anywhere. */
  sources?: SourcesInfo;
  finished: boolean;
}

// ───────────────────────── The verdict ─────────────────────────

export type Level = 'ok' | 'info' | 'warn' | 'error';

export interface Verdict {
  level: Level;
  title: string;
  detail: string;
  /** What to do ('' when nothing). */
  todo: string;
  /** Whether Refresh is the thing to press. */
  refresh: boolean;
}

const verdict = (level: Level, title: string, detail = '', todo = '', refresh = false): Verdict => ({
  level,
  title,
  detail,
  todo,
  refresh,
});

/** Why the bar shows what it shows, from the checks so far and the menu's own report. `lastNavAt`: the
 *  latest page change (SESSION.navTick) — a report written before it is from an earlier visit. */
export function verdictFor(s: CheckState, menu: MenuState | null | undefined, now: number, lastNavAt = 0): Verdict {
  const p = s.page;
  if (!p) return verdict('info', 'Checking…');
  if (!p.found) {
    return p.error
      ? verdict('error', "RemNote couldn't be asked about this page.", p.error, 'Press Run again. If it keeps happening, reload RemNote.')
      : verdict(
          'error',
          'RemNote returned nothing for this page.',
          '',
          'Open the page again and run this again. If it keeps happening, reload RemNote.'
        );
  }
  if (p.error) {
    return verdict('warn', "Part of this page couldn't be read just now.", p.error, 'Press Run again. If it keeps happening, reload RemNote.');
  }
  if (!p.isItem) {
    return verdict(
      'info',
      "This page isn't a Zotero item.",
      'The on-page menu and its citations bar appear only on synced items under Zotero/Items.'
    );
  }
  if (s.menus === 0) {
    return verdict(
      'error',
      "The on-page menu isn't registered.",
      'So no item shows its menu.',
      'Toggle Remzot off and on in Settings → Plugins, or reload RemNote.'
    );
  }
  if (s.menus !== undefined && s.menus > 1) {
    return verdict('warn', `The on-page menu is registered ${s.menus} times, so it is drawn ${s.menus} times.`, '', 'Reload RemNote.');
  }
  if (!menu) {
    return verdict(
      'warn',
      "The menu hasn't reported on this page since RemNote started.",
      "It reports each time it draws. If this page shows no Remzot menu, it didn't load here.",
      'Press Refresh. If nothing changes, reload RemNote.',
      true
    );
  }
  if (lastNavAt > 0 && menu.at < lastNavAt && now - lastNavAt > MENU_REPORT_GRACE_MS) {
    return verdict(
      'warn',
      "The menu hasn't drawn this page since the last page change.",
      `Its report is from ${clock(menu.at)}, an earlier visit; the last page change was at ${clock(lastNavAt)}. ` +
        "If this page shows no Remzot menu, it didn't load here; if it shows one, the menu has stopped updating.",
      'Press Refresh. If nothing changes, reload RemNote.',
      true
    );
  }
  const when = clock(menu.at);
  if (menu.missing === 'error') {
    return verdict(
      'error',
      "The menu's last read of this page failed.",
      `When it last drew (${when}): ${menu.error || 'no reason given'} — so it showed nothing.`,
      'Press Refresh. If it keeps failing, reload RemNote.',
      true
    );
  }
  if (menu.missing === 'page') {
    return verdict(
      'error',
      "The menu couldn't read this page.",
      `When it last drew (${when}), RemNote returned nothing for the page, so the menu showed nothing.`,
      'Press Refresh.',
      true
    );
  }
  if (menu.missing === 'not-item') {
    return verdict(
      'error',
      "The menu didn't see that this page is a Zotero item.",
      `When it last drew (${when}), RemNote didn't report the Zotero Item tag, so the menu showed nothing.`,
      'Press Refresh.',
      true
    );
  }
  const d = s.doi;
  if (!d) return verdict('info', 'Checking…');
  const doiNow = normalizeDoi(d.asMenu) || normalizeDoi(d.storedDoi);
  const doiShown = d.asMenu || d.storedDoi;

  if (!menu.doi) {
    if (doiNow) {
      return verdict(
        'error',
        'The menu read no DOI, but the page has one.',
        `The DOI property gives ${doiShown} now, but when the menu drew (${when}) RemNote gave it nothing. ` +
          'So the citations bar is hidden and the links that need a DOI say "needs a DOI".',
        'Press Refresh.',
        true
      );
    }
    if (d.stored === 'missing-target') {
      return verdict(
        'error',
        "The DOI property links to a rem RemNote doesn't return.",
        `The property holds a link to rem ${d.targetId}, which RemNote didn't return just now — so there is no DOI to read.`,
        "Press Refresh. If it stays, press Sync in the item's menu: it writes the DOI again.",
        true
      );
    }
    if (d.stored === 'unreadable') {
      return verdict(
        'warn',
        "The DOI property couldn't be read just now.",
        d.storedError ? `RemNote: ${d.storedError}.` : '',
        'Press Run again. If it keeps failing, reload RemNote.'
      );
    }
    if (normalizeDoi(d.zoteroDoi)) {
      return verdict(
        'warn',
        "This page's DOI property is empty, but Zotero has a DOI for the item.",
        `Zotero: ${d.zoteroDoi}.`,
        "Press Sync in the item's menu, or run a sync, to fill it in."
      );
    }
    if (d.zotero === 'not-in-zotero') {
      return verdict(
        'warn',
        "This item isn't in Zotero any more: deleted, or in its trash.",
        'So there is no DOI to read, and the citations bar stays hidden.',
        "To keep it, restore it from Zotero's trash. If not, the next Remzot: Open Zotero Sync lists this page under Will delete."
      );
    }
    if (d.zotero === 'error' || d.zotero === 'no-key') {
      return verdict(
        'info',
        'This page has no DOI, so the citations bar is hidden.',
        d.zotero === 'no-key' ? 'The page has no Zotero key, so Zotero was not asked.' : `Zotero couldn't be asked: ${d.zoteroError}`,
        d.zotero === 'no-key'
          ? 'Run Remzot: Open Zotero Sync. Listed under Will match, this page gets its key and DOI when you apply; ' +
              "listed under Will delete, its name isn't a Zotero citation key — rename it to the key first."
          : "Press Run again. If Zotero still can't be asked, check the Zotero User ID and API Key in Remzot's settings."
      );
    }
    return verdict(
      'info',
      'This item has no DOI, in RemNote or in Zotero.',
      'The citations bar needs a DOI, so it stays hidden. Books, theses and reports often have none.',
      'Nothing to fix. If the item does have a DOI, add it in Zotero and sync.'
    );
  }
  if (!doiNow) {
    const why =
      d.stored === 'unreadable'
        ? `the DOI property couldn't be read${d.storedError ? ` (${d.storedError})` : ''}`
        : d.stored === 'missing-target'
        ? `the DOI property links to rem ${d.targetId}, which RemNote didn't return`
        : 'the DOI property is empty';
    return verdict(
      'warn',
      `The menu read DOI ${menu.doi}, but the page gives none now.`,
      `When the menu drew (${when}) it had ${menu.doi}; now ${why}.`,
      'Press Run again. If it stays, press Refresh so the menu reads the page again.',
      true
    );
  }
  if (normalizeDoi(menu.doi) !== doiNow) {
    return verdict('warn', 'The menu shows an older DOI.', `The menu read ${menu.doi}; the page now gives ${doiShown}.`, 'Press Refresh.', true);
  }

  const src = s.sources;
  const slow = (src?.checks ?? []).filter((c) => (!c.done && now - src!.startedAt > 15_000) || c.error.startsWith('no answer within'));
  const huge = (src?.checks ?? []).find((c) => c.count > 10_000);
  if (menu.bar === 'loading') {
    const waited = now - (menu.askingSince ?? menu.at);
    if (waited < 60_000) {
      return verdict('info', "The menu is still loading this paper's lists.", `For ${duration(waited)} so far.`, 'Wait a moment — this updates by itself.');
    }
    const title = `The menu has been loading this paper's lists for ${duration(waited)}.`;
    if (huge) {
      return verdict(
        'warn',
        title,
        `${huge.name} sends all ${n(huge.count)} of its works for this paper in one answer, and the menu then looks up each ` +
          "work's details — that takes far longer still.",
        'Leave the page open: the bar fills in when the menu is done. Refresh would start it again from the beginning.'
      );
    }
    if (slow.length) {
      return verdict(
        'warn',
        title,
        `Slow here too: ${slow.map((c) => `${c.name} (${c.done ? answerText(c) : `asking for ${duration(now - src!.startedAt)}`})`).join('; ')}.`,
        'Press Refresh to ask again.',
        true
      );
    }
    if (!src?.counts) return verdict('warn', title, 'Asking the sources here, to see what is slow…');
    const works = src.counts.references + src.counts.citations + src.counts.related;
    if (works >= 3_000) {
      return verdict(
        'warn',
        title,
        `The sources answered here within seconds, with ${n(works)} works. The menu then looks up the details of each work ` +
          'in batches, one after another — for this many, that takes minutes.',
        'Leave the page open: the bar fills in when the menu is done.'
      );
    }
    return verdict(
      'warn',
      title,
      'The sources answered here within seconds. The menu may still be listing the papers in your library (once a session; ' +
        'a big library takes a while), or it is stuck.',
      'Wait a minute. If nothing changes, press Refresh.',
      true
    );
  }

  // The bar is shown.
  const c = menu.counts ?? { references: 0, inLibrary: 0, citations: 0, related: 0 };
  const menuTotal = c.references + c.citations + c.related;
  const failedThen = menu.failed ?? [];
  if (!src) return verdict('info', 'Checking…');
  if (!src.counts) {
    if (menuTotal > 0 && !failedThen.length) return verdict('ok', 'The citations bar looks fine.', `The menu shows ${countsText(c)}.`);
    return verdict('info', 'Asking the sources…', slow.length ? `Still waiting for ${slow.map((x) => x.name).join(', ')}.` : '');
  }
  const fresh = src.counts;
  const freshTotal = fresh.references + fresh.citations + fresh.related;
  const failedNow = src.checks.filter((x) => sourceOutcome(x) === 'failed');
  const allFailed = src.checks.length > 0 && failedNow.length === src.checks.length;

  if (menuTotal === 0) {
    if (freshTotal > 0) {
      return verdict(
        'warn',
        'The menu shows an older, empty answer.',
        failedThen.length
          ? `When the menu asked (${clock(menu.askedAt)}), these failed: ${failedThen.join('; ')}. Asked again now, the sources answer.`
          : `The sources had nothing when the menu asked (${clock(menu.askedAt)}), but they answer now.`,
        'Press Refresh.',
        true
      );
    }
    if (allFailed) {
      return verdict(
        'error',
        'None of the sources could be reached.',
        failedSources(src.checks).join('; '),
        'Check your connection, then press Run again in a minute.'
      );
    }
    if (failedNow.length) {
      return verdict(
        'warn',
        'Some sources failed, and the rest have nothing for this paper.',
        failedSources(src.checks).join('; '),
        'Press Run again in a minute.'
      );
    }
    return verdict(
      'info',
      'The sources have nothing for this paper.',
      'Every source answered, without references, citations or related works — so the bar shows 0. Nothing is wrong with Remzot.'
    );
  }

  const emptied = (
    [
      ['References', c.references, fresh.references],
      ['Citations', c.citations, fresh.citations],
      ['Related', c.related, fresh.related],
    ] as const
  ).filter(([, shown, now2]) => shown === 0 && now2 > 0);
  if (emptied.length) {
    return verdict(
      'warn',
      `The menu shows no ${emptied.map(([name]) => name).join(' or ')}, but the sources give some now.`,
      emptied.map(([name, , now2]) => `${name}: ${n(now2)} now`).join('; ') +
        (failedThen.length ? `. When the menu asked, these failed: ${failedThen.join('; ')}.` : '.'),
      'Press Refresh.',
      true
    );
  }
  if (failedThen.length) {
    return verdict(
      'info',
      'The bar shows works, but some sources failed when the menu asked.',
      `${failedThen.join('; ')} — their share of the lists is missing.`,
      'Press Refresh to ask again.',
      true
    );
  }
  return verdict('ok', 'The citations bar looks fine.', `The menu shows ${countsText(c)}.`);
}

// ───────────────────────── The report, as text ─────────────────────────

const ICON: Record<Level, string> = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' };

/** Whether any source was stopped by the popup's time limit (its works then count as 0). */
export const ranOutOfTime = (checks: SourceCheck[]): boolean => checks.some((c) => c.error.startsWith('no answer within'));

/** How many times the menu is registered, in words. */
export function menusText(n: number): string {
  if (n < 0) return "RemNote didn't say";
  if (n === 0) return 'no — it is not registered';
  if (n === 1) return 'once';
  return `${n} times — it is drawn ${n} times`;
}

export function storedText(d: DoiInfo): string {
  switch (d.stored) {
    case 'link':
      return `a link to "${d.storedDoi || '(empty)'}"`;
    case 'text':
      return `plain text "${d.storedDoi}" (written before DOIs were links; a sync upgrades it)`;
    case 'empty':
      return 'nothing';
    case 'missing-target':
      return `a link to rem ${d.targetId}, which RemNote didn't return`;
    default:
      return `couldn't be read${d.storedError ? ` (${d.storedError})` : ''}`;
  }
}

export function zoteroText(d: DoiInfo): string {
  switch (d.zotero) {
    case 'found':
      return d.zoteroDoi;
    case 'none':
      return 'no DOI';
    case 'not-in-zotero':
      return "the item isn't in Zotero (or is in its trash)";
    case 'no-key':
      return 'not asked (the page has no Zotero key)';
    default:
      return `couldn't be asked (${d.zoteroError})`;
  }
}

export function menuText(menu: MenuState | null | undefined): string {
  if (!menu) return 'no report on this page since RemNote started';
  const when = `as of ${clock(menu.at)}`;
  if (menu.missing === 'page') return `${when}: RemNote returned nothing for the page, so it showed nothing`;
  if (menu.missing === 'not-item') return `${when}: it didn't see the Zotero Item tag, so it showed nothing`;
  if (menu.missing === 'error') return `${when}: its read of the page failed (${menu.error || 'no reason given'}), so it showed nothing`;
  if (!menu.doi) return `${when}: read no DOI, so the citations bar is hidden`;
  if (menu.bar === 'loading') return `${when}: DOI ${menu.doi}; loading the lists since ${clock(menu.askingSince ?? menu.at)}`;
  const counts = menu.counts ? countsText(menu.counts) : '';
  const failed = menu.failed?.length ? `; failed then: ${menu.failed.join('; ')}` : '';
  return `${when}: DOI ${menu.doi}; ${counts} (sources asked ${clock(menu.askedAt)}${failed})`;
}

/** The whole report as plain text — for "Copy report". */
export function reportText(s: CheckState, menu: MenuState | null | undefined, v: Verdict, version: string): string {
  const lines: string[] = [];
  lines.push(`Remzot ${version} — citations bar debug report, ${new Date(s.ranAt).toLocaleString()}`);
  lines.push(`Verdict: ${ICON[v.level]} ${v.title}${v.detail ? ` ${v.detail}` : ''}${v.todo ? ` What to do: ${v.todo}` : ''}`);
  lines.push('');
  const p = s.page;
  lines.push(
    `Page: ${s.docId}` +
      (p ? (p.found ? ` "${p.name}" — ${p.isItem ? `a Zotero item, key ${p.key || '(none)'}` : 'not a Zotero item'}` : ' — not found') : '')
  );
  if (s.menus !== undefined) {
    lines.push(`Menu registered: ${menusText(s.menus)}`);
  }
  lines.push(`Menu on this page: ${menuText(menu)}`);
  const d = s.doi;
  if (d) {
    lines.push(`DOI as the menu reads it: ${d.asMenu || '(none)'}${d.asMenuError ? ` — error: ${d.asMenuError}` : ''}`);
    lines.push(`DOI property holds: ${storedText(d)}`);
    lines.push(`DOI in Zotero: ${zoteroText(d)}`);
  }
  const src = s.sources;
  if (src) {
    lines.push('');
    lines.push(`Sources, asked at ${clock(src.startedAt)} about ${src.shown || src.doi}:`);
    for (const c of src.checks) {
      lines.push(
        `  ${c.name}: ${answerText(c)}${c.statuses.length ? ` [HTTP ${c.statuses.join(', ')}]` : ''} — ${n(c.count)} works, ${duration(c.ms)}`
      );
    }
    if (src.counts) {
      lines.push(
        `  The bar would show: References ${n(src.counts.references)} · Citations ${n(src.counts.citations)} · Related ${n(src.counts.related)}` +
          (ranOutOfTime(src.checks) ? ' (a source that ran out of time counts as 0 here)' : '')
      );
    }
  } else if (s.finished) {
    lines.push('Sources: not asked (no DOI anywhere)');
  }
  return lines.join('\n');
}

// ───────────────────────── The command ─────────────────────────

/** "Remzot: Debug Citations Bar": opens the popup on the page open in the focused pane. */
export async function openCiteDebug(plugin: RNPlugin): Promise<void> {
  const pane = await plugin.window.getFocusedPaneId().catch(() => undefined);
  const docId = pane ? await plugin.window.getOpenPaneRemId(pane).catch(() => undefined) : undefined;
  if (!docId) {
    await plugin.app.toast(`Open a Zotero item's page, then run ${DEBUG_COMMAND} again.`);
    return;
  }
  await plugin.widget.openPopup(CITE_DEBUG_WIDGET, { docId });
}
