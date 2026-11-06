/** Shared identifiers used across registration and runtime so they never drift. */

/** Plugin setting ids. */
export const SETTINGS = {
  userId: 'zotero-user-id',
  apiKey: 'zotero-api-key',
  /** Optional username SLUG (zotero.org/<username>) — numeric-id item URLs 404 on zotero.org. */
  username: 'zotero-username',
  /** When ON, every item the plugin CREATES (on-page Add + global-sync create) is also made an
   *  Incremental Everything "incremental rem". No-ops gracefully if IE isn't installed. */
  initIncremental: 'init-incremental-on-create',
} as const;

/**
 * Incremental Everything (IE) integration. IE marks a rem "incremental" by adding its `incremental`
 * powerup and writing four slots; the SDK has NO cross-plugin command/messaging API, but powerup codes
 * are GLOBAL, so we replicate IE's tagging directly (see `makeIncremental` in sync.ts). These codes
 * mirror IE's `src/lib/consts.ts` — keep in sync if a future IE version renames them. Not imported from
 * the gitignored `Information/` reference tree.
 */
export const IE = {
  powerup: 'incremental',
  prioritySlot: 'priority',
  nextRepDateSlot: 'nextRepDate',
  repHistSlot: 'repHist',
  originalIncDateSlot: 'originalIncDate',
  /** IE's powerup on a rem the user DISMISSED from the queue — never re-enroll one of those. */
  dismissedPowerup: 'dismissed',
  /** Default priority IE assigns (0–100; we can't read IE's own `default-priority` setting). */
  defaultPriority: 10,
} as const;

/** Powerup that marks a Rem as imported from Zotero and stores its key. */
export const ZOTERO_ITEM_POWERUP = 'zotero-item';

/** Property (slot) codes on the Zotero Item powerup. */
export const SLOTS = {
  // User-facing metadata (registered first, in display order).
  title: 'title',
  type: 'type',
  authors: 'authors',
  publication: 'publication',
  link: 'link',
  doi: 'doi',
  /**
   * The item's DATE. Slot code stays `year` (reused for continuity with already-synced docs), but it
   * now holds the date as a nested reference PATH Year-Month-Day under Zotero/Dates (e.g.
   * ‹2026›-‹07›-‹01›), like Collections render their ancestry path. Display name is "Date".
   */
  year: 'year',
  tags: 'tags',
  collections: 'collections',
  status: 'status',
  rating: 'rating',
  // Hidden identity slots (registered last).
  key: 'key',
  version: 'version',
  /**
   * Epoch-ms of the last per-item Sync (the on-page menu's Sync button), stored per-doc so there's
   * no central map to bloat/garbage-collect. Powers the menu's "Sync · <date>" label. NOT a
   * Zotero-derived field — never diffed, never in UPDATABLE_FIELDS.
   */
  lastSyncedAt: 'lastSyncedAt',
} as const;

/** Default Status value stamped on newly-created items (a reference into Zotero/Statuses). */
export const DEFAULT_STATUS = 'In Progress';

/**
 * The fields update detection may write. The Zotero-derived ones are compared and overwritten;
 * Tags and Rating are never touched. `name` is special: it's the document's TITLE (reconciled to the
 * Zotero citekey/displayName), not a powerup slot — it's written via `rem.setText`, not
 * `writeItemSlots`. `status` is special too: it is only ever FILLED with DEFAULT_STATUS when it is
 * empty, never compared or overwritten — a Status the user set is theirs (R-006). All others are slots.
 */
export const UPDATABLE_FIELDS = [
  'name',
  'title',
  'type',
  'authors',
  'publication',
  'link',
  'doi',
  'year',
  'collections',
  'status',
] as const;
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

/**
 * Document hierarchy under the `Zotero` root. `items` holds the synced item docs; the rest are
 * lookup documents whose entries are plain rems that metadata properties reference (and dedup).
 */
export const HIERARCHY = {
  root: 'Zotero',
  items: 'Items',
  types: 'Types',
  authors: 'Authors',
  publications: 'Publications',
  dates: 'Dates',
  collections: 'Collections',
  statuses: 'Statuses',
} as const;

/** Synced-storage keys for cross-device plugin state. */
export const STORAGE = {
  /** Epoch-ms timestamp of the last successful Apply (gates local-edit → Zotero push). */
  lastSync: 'lastSyncAt',
} as const;

/** Session-storage keys (per-client, ephemeral). */
export const SESSION = {
  /**
   * Bumped by index.tsx on every AppEvents.URLChange. Widgets read it at the top of their
   * tracker so the (reactive) session read re-runs the tracker on navigation — RemNote reuses
   * widget iframes across in-app navigation and getWidgetContext alone is not reactive.
   * (Pattern from Incremental Everything's inc_rem_counter / currentDocumentIdKey.)
   */
  navTick: 'remzot-nav-tick',
  /**
   * Papers that "Remzot: Convert Inline Citations" just added to Zotero/Items, as
   * `{ doi, remId, name }[]`, set when a conversion finishes. The on-page menu (another iframe, with
   * its own caches) watches it and turns those rows "✓ In library" without a reload.
   */
  addedPapers: 'remzot-added-papers',
  /**
   * The rem the caret was last in, and the last block selection of rems, each `{ ..., at }` (epoch
   * ms), recorded by index.tsx on every AppEvents.EditorSelectionChanged. A command run from the
   * Omnibar finds focus and selection already wiped (Rem2Tex measured it, 2026-10-12), so Convert
   * Inline Citations falls back to these. Same remedy as Rem2Tex and Incremental Everything.
   */
  lastFocus: 'remzot-last-focus',
  lastSelection: 'remzot-last-selection',
} as const;

/** Widget file name (matches src/widgets/zotero_sync.tsx). */
export const SYNC_WIDGET = 'zotero_sync';

/** Widget file name (matches src/widgets/item_menu.tsx) — the on-page menu on item docs. */
export const ITEM_MENU_WIDGET = 'item_menu';

/** Widget file name (matches src/widgets/convert_citations.tsx) — the Convert Inline Citations popup. */
export const CONVERT_WIDGET = 'convert_citations';
