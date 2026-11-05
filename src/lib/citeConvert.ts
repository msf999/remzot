/**
 * "Remzot: Convert Inline Citations" (2026-11-05). Run inside a paper's doc under Zotero/Items, it
 * turns the paper's own citation numbers — "[2]", "[2,3]", "[34–37]" in its highlights and notes —
 * into `\cite{‹ref›, ‹ref›}`, each ‹ref› a reference to the cited paper's doc (the form Rem2Tex's
 * citekeys use). The numbers are matched against the paper's reference list from Crossref, and the
 * popup (convert_citations.tsx) lets the user change or untick every match first. A cited paper
 * missing from the library is added on the way: to Zotero (by its DOI) and to Zotero/Items — and to
 * Incremental Everything when "Make new items Incremental" is on; one already in Zotero only gets its
 * RemNote doc; one already in both is just cited.
 *
 * Nothing is written until `convertCitations`. A rem whose citations changed after the scan is
 * skipped, never overwritten. The pure parsing and rewriting live in `citations.ts`.
 */
import { AppEvents, RemType, SelectionType, type PluginRem, type RichTextInterface, type RNPlugin } from '@remnote/plugin-sdk';
import { contextOf, rewriteRichText, scanRichText, type FoundGroup, type GroupEdit } from './citations';
import { CONVERT_WIDGET, SESSION, SLOTS, ZOTERO_ITEM_POWERUP } from './consts';
import type { SyncLog } from './log';
import { isPropertyRem, safeRichTextToString } from './notes';
import { normalizeDoi, type LibDoc, type NumberedRefList, type RelatedPaper } from './semantic';
import { addRelatedItem, findItemsParent, type SyncContext } from './sync';

const COMMAND = 'Remzot: Convert Inline Citations';
const NOT_PLACED = `Put the cursor in a rem of a paper under Zotero/Items, or open the paper, then run ${COMMAND} again.`;
const NOT_UNDER_ITEMS = `${COMMAND} only works inside a paper's document under Zotero/Items.`;
const MIXED = 'Those rems belong to different papers — select rems from one paper at a time.';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yieldToHost = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ───────────────────────── Where the command runs ─────────────────────────

export type ConvertTarget = { ok: true; paperId: string; rootIds: string[] } | { ok: false; message: string };

/** The paper doc (a direct child of Items) that `remId` is or sits under; undefined otherwise. */
async function paperOf(plugin: RNPlugin, remId: string, itemsId: string): Promise<string | undefined> {
  let rem = await plugin.rem.findOne(remId);
  for (let depth = 0; rem && depth < 500; depth++) {
    const parentId = rem.parent;
    if (!parentId) return undefined;
    if (parentId === itemsId) return rem._id;
    rem = await plugin.rem.findOne(parentId);
  }
  return undefined;
}

/** How long a remembered caret position or selection stays usable by the command. */
const REMEMBERED_MS = 60_000;

/**
 * Remember where the caret is, and any block selection of rems, on every editor selection change. A
 * command run from the Omnibar finds both already wiped (Rem2Tex measured it, 2026-10-12), so
 * `resolveConvertTarget` falls back to these. Registered once, from index.tsx.
 */
export function trackEditorFocus(plugin: RNPlugin): void {
  plugin.event.addListener(AppEvents.EditorSelectionChanged, undefined, async () => {
    try {
      const focused = await plugin.focus.getFocusedRem();
      if (focused) await plugin.storage.setSession(SESSION.lastFocus, { remIds: [focused._id], at: Date.now() });
      const selection = await plugin.editor.getSelection();
      if (selection?.type === SelectionType.Rem && selection.remIds?.length) {
        await plugin.storage.setSession(SESSION.lastSelection, { remIds: selection.remIds, at: Date.now() });
      } else if (selection?.type === SelectionType.Text) {
        // The caret is in one rem again, so an older block selection would only mislead.
        await plugin.storage.setSession(SESSION.lastSelection, undefined);
      }
    } catch {
      // a tracker must never throw
    }
  });
}

/**
 * What the command runs on: the selected rems, else the rem holding the caret — live, or as
 * remembered in the last minute when the Omnibar has wiped them — else the document open in the
 * focused pane. A remembered rem is used only if it belongs to the paper that pane shows. All of it
 * must sit in ONE paper's doc under Zotero/Items.
 */
export async function resolveConvertTarget(plugin: RNPlugin): Promise<ConvertTarget> {
  const items = await findItemsParent(plugin);
  const pane = await plugin.window.getFocusedPaneId().catch(() => undefined);
  const paneDoc = pane ? await plugin.window.getOpenPaneRemId(pane).catch(() => undefined) : undefined;

  let ids: string[] = [];
  const selection = await plugin.editor.getSelectedRem().catch(() => undefined);
  if (selection?.remIds?.length) ids = [...selection.remIds];
  if (!ids.length) {
    const focused = await plugin.focus.getFocusedRem().catch(() => undefined);
    if (focused) ids = [focused._id];
  }
  if (!ids.length) {
    for (const key of [SESSION.lastSelection, SESSION.lastFocus]) {
      const kept = await plugin.storage.getSession<{ remIds: string[]; at: number }>(key).catch(() => undefined);
      if (!kept?.remIds?.length || Date.now() - kept.at > REMEMBERED_MS) continue;
      const samePaper =
        !paneDoc || !items || (await paperOf(plugin, kept.remIds[0], items._id)) === (await paperOf(plugin, paneDoc, items._id));
      if (samePaper) {
        ids = [...kept.remIds];
        break;
      }
    }
  }
  if (!ids.length && paneDoc) ids = [paneDoc];
  if (!ids.length) return { ok: false, message: NOT_PLACED };

  if (!items) return { ok: false, message: NOT_UNDER_ITEMS };
  let paperId: string | undefined;
  for (const id of ids) {
    const paper = await paperOf(plugin, id, items._id);
    if (!paper) return { ok: false, message: NOT_UNDER_ITEMS };
    if (paperId && paper !== paperId) return { ok: false, message: MIXED };
    paperId = paper;
  }
  return { ok: true, paperId: paperId as string, rootIds: ids };
}

/** The paper the citations belong to. */
export interface PaperInfo {
  id: string;
  name: string;
  doi: string;
  key: string;
}

export async function readPaper(plugin: RNPlugin, paperId: string): Promise<PaperInfo | null> {
  const rem = await plugin.rem.findOne(paperId);
  if (!rem) return null;
  const slot = async (code: string): Promise<string> => {
    try {
      return (await rem.getPowerupProperty(ZOTERO_ITEM_POWERUP, code)) ?? '';
    } catch {
      return '';
    }
  };
  return {
    id: rem._id,
    name: (await safeRichTextToString(plugin, rem.text)).trim(),
    doi: normalizeDoi(await slot(SLOTS.doi)),
    key: (await slot(SLOTS.key)).trim(),
  };
}

// ───────────────────────── Scan ─────────────────────────

/** One citation group as found in a rem. */
export interface Occurrence {
  remId: string;
  field: 'text' | 'backText';
  numbers: number[];
  raw: string;
  doubt?: string;
  /** The text around it (the rem's whole text, references left out). */
  context: { before: string; match: string; after: string };
}

/** A rem with at least one citation group. */
export interface ScannedRem {
  id: string;
  occurrences: Occurrence[];
}

export interface ScanResult {
  rems: ScannedRem[];
  remsScanned: number;
}

/** A rich text element as plain text, for context: strings, formatted text, LaTeX, annotations. */
const elementText = (el: unknown): string =>
  typeof el === 'string'
    ? el
    : el && typeof el === 'object' && ['m', 'x', 'n'].includes(String((el as { i?: string }).i))
    ? String((el as { text?: string }).text ?? '')
    : '';

/** The citation groups in one field of a rem, with their context. */
function occurrencesIn(remId: string, field: 'text' | 'backText', rt: RichTextInterface | undefined): { found: FoundGroup[]; occurrences: Occurrence[] } {
  const found = scanRichText(rt);
  if (!found.length) return { found, occurrences: [] };
  const parts = (rt as unknown[]).map(elementText);
  const offsets: number[] = [];
  parts.reduce((at, s, i) => ((offsets[i] = at), at + s.length), 0);
  const whole = parts.join('');
  const occurrences = found.map((f) => ({
    remId,
    field,
    numbers: f.group.numbers,
    raw: f.group.raw,
    ...(f.group.doubt ? { doubt: f.group.doubt } : {}),
    context: f.wholeElement
      ? contextOf(whole, offsets[f.elIndex], offsets[f.elIndex] + parts[f.elIndex].length)
      : contextOf(whole, offsets[f.elIndex] + f.group.start, offsets[f.elIndex] + f.group.end),
  }));
  return { found, occurrences };
}

/**
 * Every citation group in the target rems and everything under them, in document order. Running on
 * the paper's own doc scans its whole body; property rems (Title, Authors, …) and portals — which show
 * rems that live elsewhere, RemNote's hidden References portal among them — are left out.
 */
export async function scanForCitations(plugin: RNPlugin, paperId: string, rootIds: string[]): Promise<ScanResult> {
  const roots: PluginRem[] = [];
  for (const id of rootIds) {
    const rem = await plugin.rem.findOne(id);
    if (!rem) continue;
    if (id === paperId) {
      for (const child of await rem.getChildrenRem()) if (!(await isPropertyRem(child))) roots.push(child);
    } else if (!(await isPropertyRem(rem))) {
      roots.push(rem);
    }
  }

  const seen = new Set<string>();
  const rems: ScannedRem[] = [];
  let remsScanned = 0;
  for (const root of roots) {
    if (seen.has(root._id)) continue;
    // One host call gets the subtree; each RemObject already carries its text and children.
    const all: PluginRem[] = (await root.getDescendants().catch(() => [] as PluginRem[])) ?? [];
    const byId = new Map(all.map((r) => [r._id, r] as const));
    const walk = async (rem: PluginRem): Promise<void> => {
      if (seen.has(rem._id)) return;
      seen.add(rem._id);
      if (rem.type === RemType.PORTAL) return;
      remsScanned++;
      const occurrences = [
        ...occurrencesIn(rem._id, 'text', rem.text).occurrences,
        ...occurrencesIn(rem._id, 'backText', rem.backText).occurrences,
      ];
      if (occurrences.length) rems.push({ id: rem._id, occurrences });
      for (const kidId of rem.children ?? []) {
        const kid = byId.get(kidId);
        if (kid && kid.parent === rem._id) await walk(kid);
      }
    };
    await walk(root);
  }
  return { rems, remsScanned };
}

// ───────────────────────── The library ─────────────────────────

/** The synced docs under Zotero/Items, by DOI and by Zotero key. */
export interface LibraryIndex {
  byDoi: Map<string, LibDoc>;
  byKey: Map<string, LibDoc>;
}

/** Read every Zotero/Items doc's DOI and key — 20 docs at a time, so a 1,500-item library is quick. */
export async function buildLibraryIndex(plugin: RNPlugin): Promise<LibraryIndex> {
  const byDoi = new Map<string, LibDoc>();
  const byKey = new Map<string, LibDoc>();
  const items = await findItemsParent(plugin);
  if (!items) return { byDoi, byKey };
  const children = await items.getChildrenRem();
  for (let i = 0; i < children.length; i += 20) {
    await Promise.all(
      children.slice(i, i + 20).map(async (child) => {
        try {
          const [doi, key] = await Promise.all([
            child.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.doi),
            child.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.key),
          ]);
          const doc = { remId: child._id, name: '' };
          const d = normalizeDoi(doi ?? '');
          if (d && !byDoi.has(d)) byDoi.set(d, doc);
          const k = (key ?? '').trim();
          if (k && !byKey.has(k)) byKey.set(k, doc);
        } catch {
          // not a synced item (structural rem, keyless doc)
        }
      })
    );
  }
  return { byDoi, byKey };
}

/** The library doc for a reference, matched by DOI. */
export const libraryDocFor = (paper: RelatedPaper, lib: LibraryIndex): LibDoc | undefined =>
  paper.doi ? lib.byDoi.get(paper.doi) : undefined;

/** A reference can be cited when it is in the library or can be added (it has a DOI). */
export const canConvert = (paper: RelatedPaper, lib: LibraryIndex): boolean => !!paper.doi || !!libraryDocFor(paper, lib);

// ───────────────────────── Rows: one per citation number ─────────────────────────

/** One match of a number to a reference — what the popup shows as a tick + dropdown. */
export interface Assignment {
  id: string;
  /** Index into the reference list; null until one is picked. */
  refIndex: number | null;
  ticked: boolean;
}

/** One citation number found in the text, the places it appears, and the reference(s) it maps to. */
export interface NumberRow {
  n: number;
  occurrences: Occurrence[];
  /** Set when EVERY place it appears looks like something other than a citation. */
  doubt?: string;
  /** Why nothing was matched automatically. */
  missing?: string;
  /** Usually one; several when the paper lists several works under this number. */
  assignments: Assignment[];
}

/**
 * The popup's starting rows: each number found, matched to the reference(s) the paper lists under that
 * number. A match starts ticked unless every place the number appears looks like a non-citation, or
 * the reference can't be cited (no DOI and not in the library). Unnumbered lists match nothing.
 */
export function buildRows(scan: ScanResult, refs: NumberedRefList, lib: LibraryIndex): NumberRow[] {
  const byNumber = new Map<number, Occurrence[]>();
  for (const r of scan.rems)
    for (const o of r.occurrences)
      for (const n of o.numbers) {
        const list = byNumber.get(n) ?? [];
        list.push(o);
        byNumber.set(n, list);
      }
  return [...byNumber.keys()]
    .sort((a, b) => a - b)
    .map((n): NumberRow => {
      const occurrences = byNumber.get(n) as Occurrence[];
      const doubtful = occurrences.filter((o) => o.doubt);
      const doubt = doubtful.length === occurrences.length ? doubtful[0].doubt : undefined;
      const matches = refs.numbered
        ? refs.refs.map((r, i) => ({ r, i })).filter(({ r }) => r.n === n)
        : [];
      if (!matches.length) {
        const missing = !refs.refs.length
          ? 'no reference list was found for this paper'
          : refs.numbered
          ? `the reference list has no number ${n}`
          : 'the reference list has no numbers — pick the reference';
        return { n, occurrences, ...(doubt ? { doubt } : {}), missing, assignments: [{ id: `${n}:0`, refIndex: null, ticked: false }] };
      }
      return {
        n,
        occurrences,
        ...(doubt ? { doubt } : {}),
        assignments: matches.map(({ r, i }, k) => ({ id: `${n}:${k}`, refIndex: i, ticked: !doubt && canConvert(r.paper, lib) })),
      };
    });
}

// ───────────────────────── Convert ─────────────────────────

/** What happened to one cited paper. */
export interface PaperOutcome {
  refIndex: number;
  ok: boolean;
  remId?: string;
  /** In the library already / added to Zotero and RemNote / in Zotero, given its RemNote doc / in
   *  both already (found by Zotero key) / failed. */
  how: 'library' | 'created' | 'adopted' | 'existing-doc' | 'failed';
  message: string;
}

export interface ConvertResult {
  papers: PaperOutcome[];
  remsChanged: number;
  remsSkipped: { remId: string; reason: string }[];
  groupsConverted: number;
  citesWritten: number;
  /** Papers that got a new Zotero/Items doc, for the on-page menu. */
  added: { doi: string; remId: string; name: string }[];
}

export interface ConvertArgs {
  scan: ScanResult;
  rows: NumberRow[];
  refs: NumberedRefList;
  lib: LibraryIndex;
  /** The sync context for adding papers (item types + collections), built on first use. */
  getContext: () => Promise<SyncContext>;
  /** Zotero collections a newly added paper is filed into. */
  collectionKeys: string[];
}

export interface ConvertCallbacks {
  onPaper?: (outcome: PaperOutcome) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Same groups, same numbers, same order — the citations in a rem are unchanged since the scan. */
const sameCitations = (stored: Occurrence[], fresh: Occurrence[]): boolean =>
  stored.length === fresh.length &&
  stored.every((o, i) => o.field === fresh[i].field && o.numbers.join(',') === fresh[i].numbers.join(','));

/**
 * Convert the ticked matches. First every cited paper gets a doc — from the library, or added to
 * Zotero and RemNote — then each rem is rewritten: every group whose numbers resolved becomes
 * `\cite{‹ref›, …}`, and numbers that were not converted stay behind as "[n]". A rem whose citations
 * changed after the scan is skipped; other edits to it are fine (the groups are found afresh).
 */
export async function convertCitations(
  plugin: RNPlugin,
  args: ConvertArgs,
  cb: ConvertCallbacks = {},
  log?: SyncLog
): Promise<ConvertResult> {
  log?.section('Convert inline citations');
  const ticked = new Map<number, number[]>();
  for (const row of args.rows)
    for (const a of row.assignments)
      if (a.ticked && a.refIndex !== null) {
        const list = ticked.get(row.n) ?? [];
        if (!list.includes(a.refIndex)) list.push(a.refIndex);
        ticked.set(row.n, list);
      }
  const needed = [...new Set([...ticked.values()].flat())];
  const remsToWrite = args.scan.rems.filter((r) => r.occurrences.some((o) => o.numbers.some((n) => ticked.has(n))));
  const total = needed.length + remsToWrite.length;
  let done = 0;
  const step = async (): Promise<void> => {
    cb.onProgress?.(++done, total);
    await yieldToHost();
  };

  // 1) A doc for every cited paper.
  const docFor = new Map<number, string>();
  const madeThisRun = new Map<string, string>();
  const papers: PaperOutcome[] = [];
  const added: ConvertResult['added'] = [];
  for (const refIndex of needed) {
    const { paper, label } = args.refs.refs[refIndex];
    const title = paper.title || paper.fallbackTitle || paper.doi;
    let outcome: PaperOutcome;
    const inLibrary = libraryDocFor(paper, args.lib);
    const earlier = paper.doi ? madeThisRun.get(paper.doi) : undefined;
    if (inLibrary) {
      outcome = { refIndex, ok: true, remId: inLibrary.remId, how: 'library', message: 'in your library' };
    } else if (earlier) {
      outcome = { refIndex, ok: true, remId: earlier, how: 'library', message: 'added earlier in this run' };
    } else if (!paper.doi) {
      outcome = { refIndex, ok: false, how: 'failed', message: "no DOI, so it can't be added" };
    } else {
      try {
        const res = await addRelatedItem(
          plugin,
          { doi: paper.doi, title: paper.title || paper.fallbackTitle },
          await args.getContext(),
          { collectionKeys: args.collectionKeys, findDoc: (key) => args.lib.byKey.get(key)?.remId },
          log
        );
        outcome =
          res.ok && res.remId
            ? { refIndex, ok: true, remId: res.remId, how: res.outcome ?? 'created', message: res.message }
            : { refIndex, ok: false, how: 'failed', message: res.message };
        if (outcome.ok && outcome.remId && (res.outcome === 'created' || res.outcome === 'adopted')) {
          const doc = await plugin.rem.findOne(outcome.remId);
          added.push({ doi: paper.doi, remId: outcome.remId, name: doc ? (await safeRichTextToString(plugin, doc.text)).trim() : '' });
        }
      } catch (err) {
        outcome = { refIndex, ok: false, how: 'failed', message: errMsg(err) };
      }
    }
    if (outcome.ok && outcome.remId) {
      docFor.set(refIndex, outcome.remId);
      if (paper.doi) madeThisRun.set(paper.doi, outcome.remId);
    }
    papers.push(outcome);
    log?.log('convert', `[${label || '?'}] ${title}: ${outcome.how} — ${outcome.message}`);
    cb.onPaper?.(outcome);
    await step();
  }

  // 2) Rewrite the rems.
  let remsChanged = 0;
  let groupsConverted = 0;
  let citesWritten = 0;
  const remsSkipped: ConvertResult['remsSkipped'] = [];
  for (const stored of remsToWrite) {
    const rem = await plugin.rem.findOne(stored.id);
    if (!rem) {
      remsSkipped.push({ remId: stored.id, reason: 'it no longer exists' });
      await step();
      continue;
    }
    const fields: { field: 'text' | 'backText'; rt: RichTextInterface | undefined }[] = [
      { field: 'text', rt: rem.text },
      { field: 'backText', rt: rem.backText },
    ];
    const fresh = fields.map(({ field, rt }) => ({ field, rt, ...occurrencesIn(rem._id, field, rt) }));
    if (!sameCitations(stored.occurrences, [...fresh[0].occurrences, ...fresh[1].occurrences])) {
      remsSkipped.push({ remId: stored.id, reason: 'its citations changed after the scan — run the command again' });
      log?.log('convert', `Skipped ${stored.id}: its citations changed after the scan.`);
      await step();
      continue;
    }
    let groups = 0;
    let cites = 0;
    try {
      for (const f of fresh) {
        const edits: GroupEdit[] = [];
        f.found.forEach((g) => {
          const remIds: string[] = [];
          const leftover: number[] = [];
          for (const n of g.group.numbers) {
            const ids = (ticked.get(n) ?? []).map((i) => docFor.get(i)).filter((x): x is string => !!x);
            if (!ids.length) leftover.push(n);
            for (const id of ids) if (!remIds.includes(id)) remIds.push(id);
          }
          if (!remIds.length) return;
          edits.push({ elIndex: g.elIndex, start: g.group.start, end: g.group.end, remIds, leftover });
          groups++;
          cites += remIds.length;
        });
        if (!edits.length || !f.rt) continue;
        const next = rewriteRichText(f.rt, edits);
        if (f.field === 'text') await rem.setText(next);
        else await rem.setBackText(next);
        log?.log(
          'convert',
          `Rem ${rem._id} (${f.field}): "${(f.rt as unknown[]).map(elementText).join('').slice(0, 160)}" → ${edits.length} group(s) converted.`
        );
      }
      if (groups) {
        remsChanged++;
        groupsConverted += groups;
        citesWritten += cites;
      }
    } catch (err) {
      remsSkipped.push({ remId: stored.id, reason: `writing it failed: ${errMsg(err)}` });
      log?.log('convert', `Writing ${stored.id} failed: ${errMsg(err)}`);
    }
    await step();
  }

  log?.log(
    'convert',
    `Done: ${groupsConverted} group(s) in ${remsChanged} rem(s), ${citesWritten} citation(s); ` +
      `${papers.filter((p) => p.how === 'created').length} added to Zotero, ` +
      `${papers.filter((p) => p.how === 'adopted').length} given a RemNote doc, ` +
      `${papers.filter((p) => !p.ok).length} failed; ${remsSkipped.length} rem(s) skipped.`
  );
  return { papers, remsChanged, remsSkipped, groupsConverted, citesWritten, added };
}

// ───────────────────────── The command ─────────────────────────

/** The command's action: check where it runs, then open the popup (which scans and matches). */
export async function openConvertCitations(plugin: RNPlugin): Promise<void> {
  try {
    const target = await resolveConvertTarget(plugin);
    if (!target.ok) {
      await plugin.app.toast(target.message);
      return;
    }
    const paper = await readPaper(plugin, target.paperId);
    if (!paper) {
      await plugin.app.toast(NOT_UNDER_ITEMS);
      return;
    }
    if (!paper.doi) {
      await plugin.app.toast(`${paper.name || 'This paper'} has no DOI, so Remzot can't get its reference list.`);
      return;
    }
    const scan = await scanForCitations(plugin, target.paperId, target.rootIds);
    if (!scan.rems.length) {
      await plugin.app.toast(
        target.rootIds.includes(target.paperId)
          ? `No [n] citations found in ${paper.name}.`
          : 'No [n] citations found in that rem or under it.'
      );
      return;
    }
    // Clicking outside must not close it mid-write: Close is the way out.
    await plugin.widget.openPopup(CONVERT_WIDGET, { paperId: target.paperId, rootIds: target.rootIds }, false);
  } catch (err) {
    await plugin.app.toast(`${COMMAND} failed: ${errMsg(err)}`);
  }
}
