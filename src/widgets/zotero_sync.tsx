import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useEffect, useRef, useState } from 'react';
import {
  applySyncPlan,
  buildSyncContext,
  computeSyncPlan,
  type EntryGroup,
  type DeleteReason,
  type SyncContext,
  type SyncPlan,
} from '../lib/sync';
import { fetchTopItems } from '../lib/zoteroApi';
import { STORAGE } from '../lib/consts';
import { SyncLog } from '../lib/log';

const deleteReasonLabel = (reason: DeleteReason): string =>
  reason === 'no-key'
    ? 'no Zotero key'
    : reason === 'duplicate-key'
    ? 'duplicate of another synced item'
    : 'removed from Zotero';

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

interface Row {
  id: string;
  name: string;
  detail?: string;
  /** Nested rows (field diffs for "Will update", grouped items for "Will create"). */
  children?: Row[];
  /** Shown on a group row, e.g. "12 items" or "3 fields". */
  childCountLabel?: string;
}

interface Category {
  key: string;
  label: string;
  rows: Row[];
  /** When false, the category is read-only: no select-all or per-row checkboxes. */
  selectable?: boolean;
  /** Item count shown in the header (defaults to rows.length; differs when rows are groups). */
  count?: number;
}

/** All selectable leaf ids under a row (recurses through nested group rows). */
const leafIdsOf = (row: Row): string[] =>
  row.children ? row.children.flatMap(leafIdsOf) : [row.id];

/** Total entries in a collection group and all its descendants. */
const countGroupItems = <T,>(g: EntryGroup<T>): number =>
  g.items.length + g.children.reduce((n, c) => n + countGroupItems(c), 0);

/**
 * Convert a collection-group tree to nested Rows (subcollections first, then items). `keyPrefix`
 * namespaces the group ids; `itemToRow` renders each entry (a create item, or an update item
 * that itself expands into field-diff rows).
 */
const groupTreeToRows = <T,>(
  groups: EntryGroup<T>[],
  keyPrefix: string,
  itemToRow: (e: T) => Row
): Row[] =>
  groups.map((g) => {
    const total = countGroupItems(g);
    return {
      id: `grp:${keyPrefix}:${g.key}`,
      name: g.name,
      childCountLabel: `${total} item${total === 1 ? '' : 's'}`,
      children: [...groupTreeToRows(g.children, keyPrefix, itemToRow), ...g.items.map(itemToRow)],
    };
  });

/** A checkbox that can show the indeterminate (partial) state. */
const TriCheckbox = (props: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate && !props.checked;
  }, [props.indeterminate, props.checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="cursor-pointer shrink-0"
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  );
};

export const ZoteroSync = () => {
  const plugin = usePlugin();

  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  // 'log' starts collapsed: the diagnostic box at the popup's end is folded until opened.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['log']));
  const [hasLog, setHasLog] = useState(false);
  const logRef = useRef<SyncLog | null>(null);
  const ctxRef = useRef<SyncContext | null>(null);

  // Both create and update items are grouped into a nested collection tree (mirrors Zotero).
  const createRows: Row[] = plan
    ? groupTreeToRows(plan.createGroups, 'create', (e) => ({
        id: e.id,
        name: e.name,
        detail:
          e.collections.length > 1
            ? `Also exists in ${e.collections.slice(1).join(', ')}`
            : undefined,
      }))
    : [];
  const updateRows: Row[] = plan
    ? groupTreeToRows(plan.updateGroups, 'update', (e) => ({
        id: e.id,
        name: e.name || '(untitled)',
        childCountLabel: `${e.changes.length} field${e.changes.length === 1 ? '' : 's'}`,
        children: e.changes.map((c) => ({
          id: `${e.id}:${c.field}`,
          name: c.field,
          detail: `${c.fromDisplay} → ${c.toDisplay}`,
        })),
      }))
    : [];

  const categories: Category[] = plan
    ? [
        {
          key: 'create',
          label: 'Will create',
          count: plan.toCreate.length,
          rows: createRows,
        },
        {
          key: 'update',
          label: 'Will update',
          count: plan.toUpdate.length,
          rows: updateRows,
        },
        {
          key: 'match',
          label: 'Will match (adopt existing doc)',
          count: plan.toMatch.length,
          rows: plan.toMatch.map((e) => ({
            id: e.id,
            name: e.name || '(untitled)',
            detail: `adopts Zotero ${e.item.key} — doc and its content are kept`,
          })),
        },
        {
          key: 'push',
          label: 'Push to Zotero',
          count: plan.toPushTags.length,
          rows: plan.toPushTags.map((e) => ({
            id: e.id,
            name: e.name || '(untitled)',
            detail: e.tags.length ? e.tags.join(', ') : 'no tags',
          })),
        },
        {
          key: 'delete',
          label: 'Will delete',
          count: plan.toDelete.length,
          rows: plan.toDelete.map((e) => ({
            id: e.id,
            name: e.name || '(untitled)',
            detail: deleteReasonLabel(e.reason),
          })),
        },
        {
          key: 'already',
          label: 'Already on Remnote',
          selectable: false,
          count: plan.alreadyPresent.length,
          rows: plan.alreadyPresent.map((e) => ({
            id: e.id,
            name: e.name || '(untitled)',
            detail: e.key,
          })),
        },
      ].filter((c) => c.rows.length > 0)
    : [];

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const setMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const handlePreview = async () => {
    setBusy(true);
    setStatus('Fetching items from Zotero…');
    setPlan(null);
    setSelected(new Set());
    setDone(new Set());
    setFailed(new Set());
    setProgress(null);
    setApplied(false);
    // "Already on Remnote" comes up collapsed by default (big, non-actionable list).
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.add('already');
      return next;
    });

    const log = new SyncLog();
    logRef.current = log;
    setHasLog(true);
    log.log('run', 'Get from Zotero clicked — starting preview.');
    try {
      let reportedTotal = 0;
      const items = await fetchTopItems(plugin, log, (fetched, total) => {
        // The count is shown next to the progress bar, so keep the status text plain.
        if (total > 0) reportedTotal = total; // Zotero's Total-Results — used for the partial-fetch guard
        setProgress(total > 0 ? { completed: fetched, total } : null);
        setStatus('Fetching items from Zotero…');
      });
      setProgress(null);
      setStatus(`Fetched ${items.length} items. Loading collections & item types from Zotero…`);
      const ctx = await buildSyncContext(plugin, log);
      ctxRef.current = ctx;
      setStatus(`Comparing ${items.length} item(s) against Remnote…`);
      const newPlan = await computeSyncPlan(plugin, items, ctx, log, { reportedTotal });

      const allIds = [
        ...newPlan.toCreate.map((e) => e.id),
        ...newPlan.toDelete.map((e) => e.id),
        ...newPlan.toUpdate.flatMap((e) => e.changes.map((c) => `${e.id}:${c.field}`)),
        ...newPlan.toMatch.map((e) => e.id),
        ...newPlan.toPushTags.map((e) => e.id),
      ];
      setSelected(new Set(allIds));
      setPlan(newPlan);

      // First-ever run: seed the local-edit baseline so Remnote edits to Status/Rating/Tags made
      // *after* now become push-detectable. Without this, a fully-synced library (nothing to
      // Apply → handleApply early-returns and the Apply button is disabled) could never stamp
      // lastSyncAt, leaving the Remnote → Zotero push direction permanently unreachable.
      if (ctx.lastSyncAt === 0) {
        await plugin.storage.setSynced(STORAGE.lastSync, Date.now());
        ctx.lastSyncAt = Date.now();
        log.log('run', 'Seeded last-sync baseline (first run) — edits after now are push-detectable.');
      }

      const parts = [
        `Found ${items.length} items in Zotero — ${newPlan.alreadyPresent.length} already on Remnote, ${newPlan.toCreate.length} to create, ${newPlan.toUpdate.length} to update, ${newPlan.toMatch.length} to match, ${newPlan.toPushTags.length} to push to Zotero, ${newPlan.toDelete.length} to delete.`,
      ];
      if (newPlan.emptyLibrarySkippedDeletes) {
        parts.push(
          'Zotero returned 0 items — deletions were suppressed as a safety check; verify your credentials.'
        );
      }
      if (newPlan.partialFetchSkippedDeletes) {
        parts.push(
          `Fetched ${items.length} item(s) but Zotero reports ${reportedTotal || 'more'} — the fetch looks incomplete, so deletions of "missing" items were suppressed. Re-run once the full library loads.`
        );
      }
      if (
        newPlan.toCreate.length === 0 &&
        newPlan.toUpdate.length === 0 &&
        newPlan.toMatch.length === 0 &&
        newPlan.toPushTags.length === 0 &&
        newPlan.toDelete.length === 0
      ) {
        parts.push('Everything is already in sync.');
      }
      setStatus(parts.join(' '));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.log('run', `ERROR during preview: ${message}`);
      setStatus(`Error: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!plan) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const toCreate = plan.toCreate.filter((e) => selected.has(e.id));
    const toDelete = plan.toDelete.filter((e) => selected.has(e.id));
    const toUpdate = plan.toUpdate
      .map((e) => ({
        entry: e,
        fields: new Set(e.changes.map((c) => c.field).filter((f) => selected.has(`${e.id}:${f}`))),
      }))
      .filter((u) => u.fields.size > 0);
    const toMatch = plan.toMatch.filter((e) => selected.has(e.id));
    const toPushTags = plan.toPushTags.filter((e) => selected.has(e.id));
    const total = toCreate.length + toUpdate.length + toMatch.length + toPushTags.length + toDelete.length;
    if (total === 0) return;

    setBusy(true);
    setDone(new Set());
    setFailed(new Set());
    setProgress({ completed: 0, total });

    const log = logRef.current ?? new SyncLog();
    logRef.current = log;
    setHasLog(true);
    log.log(
      'run',
      `Apply changes clicked — ${toCreate.length} create(s), ${toUpdate.length} update(s), ${toMatch.length} adoption(s), ${toPushTags.length} push(es), ${toDelete.length} delete(s).`
    );
    try {
      const { created, updated, matched, pushed, deleted } = await applySyncPlan(
        plugin,
        { toCreate, toUpdate, toMatch, toPushTags, toDelete },
        ctx,
        {
          onItemDone: (id, ok) => {
            if (ok) setDone((prev) => new Set(prev).add(id));
            else setFailed((prev) => new Set(prev).add(id));
            setProgress((prev) => (prev ? { ...prev, completed: prev.completed + 1 } : prev));
          },
        },
        log
      );
      setApplied(true);
      const okCount = created + updated + matched + pushed + deleted;
      const failCount = total - okCount;
      setStatus(`Done. Created ${created}, updated ${updated}, matched ${matched}, pushed ${pushed}, deleted ${deleted}.`);
      await plugin.app.toast(
        `Zotero sync applied — ${created} created, ${updated} updated, ${matched} matched, ` +
          `${pushed} pushed, ${deleted} deleted${failCount > 0 ? `, ${failCount} failed` : ''}.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.log('run', `ERROR during apply: ${message}`);
      setStatus(`Error: ${message}`);
      await plugin.app.toast(`Zotero sync failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCopyLog = async () => {
    const text = logRef.current?.toText() ?? '(No log yet — click “Get from Zotero” first.)';
    const ok = await copyToClipboard(text);
    await plugin.app.toast(
      ok
        ? 'Sync log copied to clipboard.'
        : 'Could not copy automatically — the log was printed to the console instead.'
    );
    if (!ok) console.log(text);
  };

  // Count at item granularity: an update item counts once if any of its fields is ticked.
  const selectedCount = plan
    ? plan.toCreate.filter((e) => selected.has(e.id)).length +
      plan.toDelete.filter((e) => selected.has(e.id)).length +
      plan.toMatch.filter((e) => selected.has(e.id)).length +
      plan.toPushTags.filter((e) => selected.has(e.id)).length +
      plan.toUpdate.filter((e) => e.changes.some((c) => selected.has(`${e.id}:${c.field}`))).length
    : 0;
  const canApply = !busy && !applied && selectedCount > 0;
  const progressPct = progress && progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  return (
    <div className="fixed inset-0 flex flex-col gap-3 p-5 overflow-hidden rn-clr-background-primary rn-clr-content-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Zotero Sync</h1>
          <p className="text-sm rn-clr-content-secondary">
            Sync your personal Zotero library with Zotero/Items, matching each item by its
            Zotero key. Zotero's metadata is pulled in as document properties, and your Status,
            Rating, and Tags are pushed back to Zotero as that item's tags. A document under
            Items is deleted when its key is missing from Zotero (or it has no key) — except a
            keyless doc whose name matches a citation key, which is adopted in place instead.
            Review the grouped changes below, tick the ones you want, then Apply — nothing
            changes until you do.
          </p>
        </div>
        <button
          type="button"
          onClick={() => plugin.widget.closePopup()}
          title="Close"
          aria-label="Close"
          className="shrink-0 p-2 rounded-md rn-clr-content-secondary cursor-pointer"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handlePreview}
          disabled={busy}
          className="px-4 py-2 rounded-md rn-clr-background-light-accent rn-clr-content-accent disabled:opacity-50"
        >
          {busy && !progress ? 'Working…' : 'Get from Zotero'}
        </button>
        <button
          onClick={handleApply}
          disabled={!canApply}
          className="px-4 py-2 rounded-md rn-clr-background-light-positive rn-clr-content-positive disabled:opacity-50"
        >
          Apply changes{selectedCount > 0 ? ` (${selectedCount})` : ''}
        </button>

        {progress && (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="flex-1 h-2 rounded-full overflow-hidden rn-clr-background-secondary">
              <div
                className="h-full rn-clr-background-accent transition-all"
                style={{ width: `${progressPct}%`, backgroundColor: 'var(--rn-clr-content-accent)' }}
              />
            </div>
            <span className="text-xs rn-clr-content-secondary whitespace-nowrap">
              {progress.completed}/{progress.total}
            </span>
          </div>
        )}
      </div>

      {status && <div className="text-sm rn-clr-content-secondary">{status}</div>}

      <div className="flex-1 min-h-0 overflow-auto rounded-md rn-clr-background-secondary p-3">
        {categories.length === 0 ? (
          <span className="text-sm rn-clr-content-tertiary">
            Click “Get from Zotero” to preview the changes.
          </span>
        ) : (
          <div className="flex flex-col gap-4">
            {categories.map((cat) => {
              const selectable = cat.selectable !== false;
              const isUpdateCat = cat.key === 'update';
              const leafIds = cat.rows.flatMap(leafIdsOf);
              const selectedInCat = leafIds.filter((id) => selected.has(id)).length;
              const allSelected = leafIds.length > 0 && selectedInCat === leafIds.length;
              const someSelected = selectedInCat > 0;
              const isCollapsed = collapsed.has(cat.key);

              // Recursive row renderer — group rows (with children) nest to any depth.
              const renderRow = (row: Row, depth: number): JSX.Element => {
                const padLeft = `${1.5 + depth * 1.25}rem`;
                if (row.children) {
                  const leaves = leafIdsOf(row);
                  const selN = leaves.filter((id) => selected.has(id)).length;
                  const groupAll = leaves.length > 0 && selN === leaves.length;
                  const groupSome = selN > 0;
                  const groupCollapsed = collapsed.has(row.id);
                  return (
                    <div key={row.id}>
                      <div
                        style={{ paddingLeft: padLeft }}
                        className="flex items-center gap-2 py-1 pr-2 rounded min-w-0"
                      >
                        {selectable && (
                          <TriCheckbox
                            checked={groupAll}
                            indeterminate={groupSome}
                            disabled={busy}
                            onChange={() => setMany(leaves, !groupAll)}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => toggleCollapsed(row.id)}
                          aria-expanded={!groupCollapsed}
                          className="flex items-center gap-1.5 flex-1 min-w-0 text-left cursor-pointer hover:underline"
                        >
                          <span className="shrink-0 inline-block w-3 text-xs rn-clr-content-secondary">
                            {groupCollapsed ? '▸' : '▾'}
                          </span>
                          <span className="flex-1 min-w-0 font-mono text-sm truncate">{row.name}</span>
                        </button>
                        {row.childCountLabel && (
                          <span className="shrink-0 text-xs rn-clr-content-tertiary whitespace-nowrap">
                            {row.childCountLabel}
                          </span>
                        )}
                        <span className="shrink-0 w-5 text-right text-sm">
                          {done.has(row.id) ? '✅' : failed.has(row.id) ? '❌' : ''}
                        </span>
                      </div>
                      {!groupCollapsed && row.children.map((c) => renderRow(c, depth + 1))}
                    </div>
                  );
                }
                if (isUpdateCat) {
                  // Field-diff leaf: "field: old → new".
                  return (
                    <label
                      key={row.id}
                      style={{ paddingLeft: padLeft }}
                      className="flex items-center gap-2 py-1 pr-2 rounded min-w-0"
                    >
                      <TriCheckbox
                        checked={selected.has(row.id)}
                        disabled={busy}
                        onChange={() => toggleOne(row.id)}
                      />
                      <span className="shrink-0 font-mono text-sm rn-clr-content-secondary">
                        {row.name}:
                      </span>
                      {row.detail && (
                        <span className="flex-1 min-w-0 text-xs rn-clr-content-tertiary truncate">
                          {row.detail}
                        </span>
                      )}
                    </label>
                  );
                }
                if (selectable) {
                  // Selectable item leaf (create / delete).
                  return (
                    <label
                      key={row.id}
                      style={{ paddingLeft: padLeft }}
                      className="flex items-center gap-2 py-1 pr-2 rounded min-w-0"
                    >
                      <TriCheckbox
                        checked={selected.has(row.id)}
                        disabled={busy}
                        onChange={() => toggleOne(row.id)}
                      />
                      <span className="flex-1 min-w-0 font-mono text-sm truncate">{row.name}</span>
                      {row.detail && (
                        <span className="shrink min-w-0 text-xs rn-clr-content-tertiary truncate">
                          ({row.detail})
                        </span>
                      )}
                      <span className="shrink-0 w-5 text-right text-sm">
                        {done.has(row.id) ? '✅' : failed.has(row.id) ? '❌' : ''}
                      </span>
                    </label>
                  );
                }
                // Read-only leaf (Already on Remnote).
                return (
                  <div
                    key={row.id}
                    style={{ paddingLeft: padLeft }}
                    className="flex items-center gap-2 py-1 pr-2 rounded min-w-0"
                  >
                    <span className="flex-1 min-w-0 font-mono text-sm truncate rn-clr-content-secondary">
                      {row.name}
                    </span>
                    {row.detail && (
                      <span className="shrink-0 text-xs rn-clr-content-tertiary whitespace-nowrap">
                        ({row.detail})
                      </span>
                    )}
                  </div>
                );
              };

              return (
                <div key={cat.key}>
                  <div className="flex items-center gap-2 font-semibold sticky top-0 z-10 py-1 rn-clr-background-secondary">
                    {selectable && (
                      <TriCheckbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        disabled={busy}
                        onChange={() => setMany(leafIds, !allSelected)}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(cat.key)}
                      aria-expanded={!isCollapsed}
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-left cursor-pointer hover:underline"
                    >
                      <span className="shrink-0 inline-block w-3 text-xs rn-clr-content-secondary">
                        {isCollapsed ? '▸' : '▾'}
                      </span>
                      <span className="truncate">
                        {cat.label} ({cat.count ?? cat.rows.length})
                      </span>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="flex flex-col mt-1">
                      {cat.rows.map((row) => renderRow(row, 0))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hasLog && (
          <div className="mt-4 pt-2 border-t border-gray-300">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleCollapsed('log')}
                aria-expanded={!collapsed.has('log')}
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left font-semibold cursor-pointer hover:underline"
              >
                <span className="shrink-0 inline-block w-3 text-xs rn-clr-content-secondary">
                  {collapsed.has('log') ? '▸' : '▾'}
                </span>
                <span>Log</span>
              </button>
              <button
                type="button"
                onClick={handleCopyLog}
                title="Copy a verbose diagnostic log of this sync run to the clipboard"
                aria-label="Copy sync log to clipboard"
                className="shrink-0 p-1.5 rounded-md rn-clr-background-light-accent rn-clr-content-accent cursor-pointer"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <line x1="8" y1="9" x2="10" y2="9" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="16" y2="17" />
                </svg>
              </button>
            </div>
            {!collapsed.has('log') && (
              <pre
                className="mt-1 text-xs rn-clr-content-secondary overflow-auto whitespace-pre-wrap break-words"
                style={{ maxHeight: '16rem' }}
              >
                {logRef.current?.toText() ?? ''}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

renderWidget(ZoteroSync);
