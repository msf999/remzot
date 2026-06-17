/** Diff + write logic: mirror the Zotero library into Remnote under `Zotero / Items`. */
import type { PluginRem, RNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import {
  DEFAULT_STATUS,
  HIERARCHY,
  IE,
  SETTINGS,
  SLOTS,
  STORAGE,
  UPDATABLE_FIELDS,
  type UpdatableField,
  ZOTERO_ITEM_POWERUP,
} from './consts';
import {
  createZoteroItems,
  displayName,
  extractMetadata,
  fetchCitoidItem,
  fetchCollections,
  fetchItemByKey,
  fetchItemTypeLabels,
  findZoteroItemByDoi,
  type MetaContext,
  type NormalizedMeta,
  parseDateParts,
  pushItemCollections,
  pushItemTags,
  type ZoteroCollection,
  type ZoteroItem,
} from './zoteroApi';
import type { SyncLog } from './log';

/** Cap on how many individual rows each per-item enumeration writes to the log. */
const LOG_LIST_CAP = 200;

/** Cap on how many to-delete children get the (more expensive) per-rem diagnostic line. */
const DELETE_DIAG_CAP = 50;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A Zotero item that will be created as a Remnote document. */
export interface CreateEntry {
  /** Stable id for UI selection/progress (e.g. `c:<zoteroKey>`). */
  id: string;
  key: string;
  name: string;
  item: ZoteroItem;
  /** Sorted full collection paths this item is in (for grouping in the preview); [] if none. */
  collections: string[];
}

/**
 * A node in a collection-grouping tree (mirrors Zotero's collection nesting). Generic over the
 * entry type so both the create and update previews can be grouped the same way.
 */
export interface EntryGroup<T> {
  /** Collection key, or 'none' for the catch-all. */
  key: string;
  /** Collection name, or '(No collection)'. */
  name: string;
  /** Entries whose primary collection is this node (not those in its subcollections). */
  items: T[];
  /** Nested subcollection groups. */
  children: EntryGroup<T>[];
}
export type CreateGroup = EntryGroup<CreateEntry>;
export type UpdateGroup = EntryGroup<UpdateEntry>;

/** Why an existing document is being removed. */
export type DeleteReason = 'no-key' | 'missing-from-zotero' | 'duplicate-key';

/** An existing document under `Zotero / Items` that will be deleted. */
export interface DeleteEntry {
  /** Stable id for UI selection/progress (e.g. `d:<remId>`). */
  id: string;
  name: string;
  reason: DeleteReason;
  rem: PluginRem;
}

/** An existing Remnote document that already matches a live Zotero item (no action needed). */
export interface KeptEntry {
  /** Stable id (e.g. `k:<remId>`). */
  id: string;
  key: string;
  name: string;
}

/** One metadata field whose Zotero value differs from what's stored on the doc. */
export interface FieldChange {
  field: UpdatableField;
  fromDisplay: string;
  toDisplay: string;
}

/** An existing item whose Zotero metadata changed; carries its per-field diffs. */
export interface UpdateEntry {
  /** Stable id (e.g. `u:<remId>`); field ids are `u:<remId>:<field>`. */
  id: string;
  name: string;
  rem: PluginRem;
  item: ZoteroItem;
  changes: FieldChange[];
}

/**
 * An existing item the user edited in Remnote since the last sync, whose user-owned fields
 * (Status / Rating / Tags) will be written back to Zotero as the item's exact tag set.
 */
export interface PushEntry {
  /** Stable id (e.g. `p:<remId>`). */
  id: string;
  name: string;
  rem: PluginRem;
  /** The Zotero item key to PATCH. */
  itemKey: string;
  /** The Zotero item version known at compute time (the optimistic-concurrency guard). */
  itemVersion: number;
  /** The exact tag set to set on the Zotero item (replace-exactly). */
  tags: string[];
}

/**
 * A keyless doc under `Zotero/Items` whose NAME exactly matches a Zotero item's citation key
 * (e.g. created by a citation picker before the item was synced). Instead of delete+recreate
 * (which would break existing references to it), Apply ADOPTS it: stamps the hidden key/version,
 * tags it `zotero-item`, and backfills all metadata — the rem and its children survive.
 */
export interface MatchEntry {
  /** Stable id (e.g. `m:<remId>`). */
  id: string;
  /** The doc's name == the item's citation key. */
  name: string;
  rem: PluginRem;
  item: ZoteroItem;
}

/** The full set of changes a sync would make. */
export interface SyncPlan {
  toCreate: CreateEntry[];
  /** `toCreate` arranged as a nested collection tree for the preview. */
  createGroups: CreateGroup[];
  /** Existing docs whose Zotero metadata changed, with per-field diffs. */
  toUpdate: UpdateEntry[];
  /** `toUpdate` arranged as a nested collection tree for the preview. */
  updateGroups: UpdateGroup[];
  /** Keyless docs whose name matches a Zotero citekey — adopted instead of deleted/recreated. */
  toMatch: MatchEntry[];
  toDelete: DeleteEntry[];
  /** Items edited in Remnote since the last sync, whose tags will be pushed back to Zotero. */
  toPushTags: PushEntry[];
  /** Existing docs already synced and up to date — shown read-only. */
  alreadyPresent: KeptEntry[];
  /** True when the Zotero fetch came back empty, so deletions are suppressed for safety. */
  emptyLibrarySkippedDeletes: boolean;
  /**
   * True when the fetch looks INCOMPLETE (fewer items than Zotero's Total-Results, or a suspicious
   * mass of keyed docs gone missing) — the `missing-from-zotero` deletions are suppressed so a
   * truncated/throttled fetch can't falsely wipe real docs. (no-key / duplicate-key deletes still run.)
   */
  partialFetchSkippedDeletes: boolean;
}

/** Read a document's plain-text name. */
async function remName(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  return rem.text ? (await plugin.richText.toString(rem.text)).trim() : '';
}

/**
 * Normalize a doc name / citekey for the name-reconcile comparison ONLY. setText writes the raw
 * citekey, but a title that doesn't byte-for-byte round-trip through richText (a different Unicode
 * normalization form, collapsible whitespace) would otherwise make `name !== realKey` true on EVERY
 * preview — a permanent phantom `name: X → X` update that never converges (the same class as the
 * historically-fixed phantom `link` diff). Comparing NFC-normalized, whitespace-collapsed values
 * stops the loop while still catching genuine renames.
 */
function nameKey(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Read the Zotero key stored on a document (empty string if absent). */
async function storedKey(rem: PluginRem): Promise<string> {
  try {
    return (await rem.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.key)).trim();
  } catch {
    return '';
  }
}

/**
 * True for Remnote's internal/auto-generated "machinery" rems — powerup definitions, slots,
 * and property rems. These appear as children in the data model but never render as a visible
 * bullet (e.g. an auto-created "Status" rem), so they aren't user content and must never be
 * treated as items or deletion candidates.
 */
async function isStructuralRem(rem: PluginRem): Promise<boolean> {
  const flags = await Promise.all([
    rem.isPowerup().catch(() => false),
    rem.isPowerupProperty().catch(() => false),
    rem.isPowerupSlot().catch(() => false),
    rem.isPowerupEnum().catch(() => false),
    rem.isPowerupPropertyListItem().catch(() => false),
    rem.isSlot().catch(() => false),
  ]);
  return flags.some(Boolean);
}

/**
 * A short, human-readable description of a Rem for the diagnostic log — enough to tell what
 * an unexpected child (e.g. a "Status" rem) actually is: whether it's a document, whether it
 * carries our Zotero powerup, whether it's Remnote-internal machinery (slot/powerup/property),
 * its tags, and its child count.
 */
async function describeRem(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  const bits: string[] = [];
  const boolBit = async (label: string, p: Promise<boolean>): Promise<void> => {
    try {
      bits.push(`${label}=${await p}`);
    } catch {
      bits.push(`${label}=?`);
    }
  };
  await boolBit('document', rem.isDocument());
  await boolBit('zoteroTagged', rem.hasPowerup(ZOTERO_ITEM_POWERUP));
  await boolBit('slot', rem.isSlot());
  await boolBit('powerup', rem.isPowerup());
  await boolBit('powerupProp', rem.isPowerupProperty());
  try {
    const tags = await rem.getTagRems();
    const names = await Promise.all(tags.map((t) => remName(plugin, t)));
    bits.push(`tags=[${names.map((n) => n || '(unnamed)').join(', ')}]`);
  } catch {
    bits.push('tags=?');
  }
  try {
    bits.push(`children=${(await rem.getChildrenRem()).length}`);
  } catch {
    bits.push('children=?');
  }
  return bits.join(', ');
}

/** Find the existing `Items` Rem without creating anything; undefined if absent. */
async function findItemsParent(plugin: RNPlugin): Promise<PluginRem | undefined> {
  const root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) return undefined;
  return (await plugin.rem.findByName([HIERARCHY.items], root._id)) ?? undefined;
}

/** Find (or create) the `Zotero / Items` document hierarchy and return the `Items` Rem. */
export async function ensureItemsParent(plugin: RNPlugin): Promise<PluginRem> {
  let root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) {
    root = await plugin.rem.createRem();
    if (!root) throw new Error('Failed to create the Zotero root document.');
    await root.setText([HIERARCHY.root]);
    await root.setIsDocument(true);
  }

  let items = await plugin.rem.findByName([HIERARCHY.items], root._id);
  if (!items) {
    items = await plugin.rem.createRem();
    if (!items) throw new Error('Failed to create the Items document.');
    await items.setText([HIERARCHY.items]);
    await items.setParent(root);
    await items.setIsDocument(true);
  }

  return items;
}

// ───────────────────────── Metadata: context, lookups, writers ─────────────────────────

/**
 * Per-run context for metadata work. Built once (fetches type labels + collections) and threaded
 * through compute + apply. The caches guarantee each distinct lookup rem is found/created at most
 * once across thousands of items.
 */
export interface SyncContext {
  typeLabels: Map<string, string>;
  collections: ZoteroCollection[];
  /** Zotero collection key → name, for diffing the Collections field. */
  collectionNameByKey: Map<string, string>;
  /** Zotero collection key → parent key (null at root), for building full paths. */
  collectionParentByKey: Map<string, string | null>;
  meta: MetaContext;
  /** `doc <name>` → lookup doc rem; `ref <doc> <value>` → plain reference rem. */
  lookupCache: Map<string, PluginRem>;
  /**
   * Parent rem id → (trimmed child name → OLDEST child rem). Built lazily, one children scan
   * per lookup parent per run. Picking the oldest on a name collision makes every client
   * converge on the same canonical rem (matching the merge pass's keep-oldest rule) instead of
   * `findByName`'s arbitrary pick keeping duplicates alive.
   */
  childNameMaps: Map<string, Map<string, PluginRem>>;
  /** Zotero collection key → its rem under Zotero/Collections. */
  collectionRemByKey: Map<string, PluginRem>;
  collectionsBuilt: boolean;
  /** Rem id → resolved name, used by the diff to avoid re-resolving the same reference. */
  refNameCache: Map<string, string>;
  /** Epoch-ms of the last successful Apply (0 if never). Gates local-edit → Zotero push. */
  lastSyncAt: number;
  /**
   * Resolved Incremental-Everything setup for `makeIncremental`, computed ONCE per run (the parent
   * lookup + custom-slot enumeration must not repeat per created item). `undefined` = not resolved
   * yet; `null` = resolved but unavailable (setting off, or IE not installed). See `getIncSetup`.
   */
  incSetup?: IncSetup | null;
}

/**
 * The once-per-run inputs `makeIncremental` needs: the `incremental` powerup, the closest ancestor
 * folder (Items, else Zotero) that is itself tagged incremental (or undefined), the priority to stamp
 * (inherited from that parent when present, else IE's default), and — for the CUSTOM IE variant — the
 * rem ids of its extra "Rotation" / "First Added" property slots (undefined on the stock variant).
 */
interface IncSetup {
  pu: PluginRem;
  incParent: PluginRem | undefined;
  priority: string;
  rotationSlotId?: string;
  firstAddedSlotId?: string;
}

/** Build a SyncContext: fetch the item-type labels and the collection list once. */
export async function buildSyncContext(plugin: RNPlugin, log?: SyncLog): Promise<SyncContext> {
  const typeLabels = await fetchItemTypeLabels(plugin, log);
  const collections = await fetchCollections(plugin, log);
  const lastSyncAt = (await plugin.storage.getSynced<number>(STORAGE.lastSync)) ?? 0;
  log?.log(
    'fetch',
    lastSyncAt > 0
      ? `Last successful sync: ${new Date(lastSyncAt).toISOString()} — items edited in Remnote after this push their tags to Zotero.`
      : 'No prior sync recorded — local-edit detection (Remnote → Zotero) is skipped this run.'
  );
  return {
    typeLabels,
    collections,
    collectionNameByKey: new Map(collections.map((c) => [c.key, c.name])),
    collectionParentByKey: new Map(collections.map((c) => [c.key, c.parentKey])),
    meta: { typeLabel: (t) => typeLabels.get(t) ?? t },
    lookupCache: new Map(),
    childNameMaps: new Map(),
    collectionRemByKey: new Map(),
    collectionsBuilt: false,
    refNameCache: new Map(),
    lastSyncAt,
  };
}

/**
 * Find the OLDEST non-structural child of `parent` named `name` (trimmed). One children scan
 * per parent per run (cached in `ctx.childNameMaps`). Replaces `findByName` in the lookup
 * find-or-create paths: when duplicates exist (cross-device sync races create them), every
 * client now deterministically resolves to the SAME canonical rem — the oldest — instead of
 * an arbitrary copy, so new references stop feeding the duplicates.
 */
async function oldestChildByName(
  plugin: RNPlugin,
  ctx: SyncContext,
  parent: PluginRem,
  name: string
): Promise<PluginRem | undefined> {
  let map = ctx.childNameMaps.get(parent._id);
  if (!map) {
    map = new Map<string, PluginRem>();
    for (const child of await parent.getChildrenRem()) {
      if (await isStructuralRem(child)) continue;
      const n = (await remName(plugin, child)).trim();
      if (!n) continue;
      const cur = map.get(n);
      if (!cur || child.createdAt < cur.createdAt) map.set(n, child);
    }
    ctx.childNameMaps.set(parent._id, map);
  }
  return map.get(name.trim());
}

/** Record a child we just created so the cached name map stays accurate within the run. */
function registerChildName(ctx: SyncContext, parent: PluginRem, name: string, child: PluginRem): void {
  ctx.childNameMaps.get(parent._id)?.set(name.trim(), child);
}

/** Find-or-create a lookup document (Types/Authors/…) as a child of the Zotero root. Cached. */
async function ensureLookupDoc(plugin: RNPlugin, ctx: SyncContext, docName: string): Promise<PluginRem> {
  const cacheKey = `doc ${docName}`;
  const cached = ctx.lookupCache.get(cacheKey);
  if (cached) return cached;

  let root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) {
    root = await plugin.rem.createRem();
    if (!root) throw new Error('Failed to create the Zotero root document.');
    await root.setText([HIERARCHY.root]);
    await root.setIsDocument(true);
  }
  let doc = await oldestChildByName(plugin, ctx, root, docName);
  if (!doc) {
    doc = await plugin.rem.createRem();
    if (!doc) throw new Error(`Failed to create the "${docName}" document.`);
    await doc.setText([docName]);
    await doc.setParent(root);
    await doc.setIsDocument(true);
    registerChildName(ctx, root, docName, doc);
  }
  ctx.lookupCache.set(cacheKey, doc);
  return doc;
}

/** Find-or-create a PLAIN rem named `value` under lookup document `docName`. Cached. */
async function ensureRefRem(
  plugin: RNPlugin,
  ctx: SyncContext,
  docName: string,
  value: string
): Promise<PluginRem> {
  const cacheKey = `ref ${docName} ${value}`;
  const cached = ctx.lookupCache.get(cacheKey);
  if (cached) return cached;

  const doc = await ensureLookupDoc(plugin, ctx, docName);
  let rem = await oldestChildByName(plugin, ctx, doc, value);
  if (!rem) {
    rem = await plugin.rem.createRem();
    if (!rem) throw new Error(`Failed to create reference rem "${value}" under "${docName}".`);
    await rem.setText([value]);
    await rem.setParent(doc); // plain rem — no setIsDocument
    registerChildName(ctx, doc, value, rem);
  }
  ctx.lookupCache.set(cacheKey, rem);
  return rem;
}

/** Build a RichText of rem references joined by `separator`, each with an optional trailing suffix. */
async function buildRefsRichText(
  plugin: RNPlugin,
  parts: { remId: string; suffix?: string }[],
  separator: string
): Promise<RichTextInterface> {
  let builder = plugin.richText.rem(parts[0].remId);
  if (parts[0].suffix) builder = builder.text(parts[0].suffix);
  for (let i = 1; i < parts.length; i++) {
    builder = builder.text(separator).rem(parts[i].remId);
    if (parts[i].suffix) builder = builder.text(parts[i].suffix!);
  }
  return builder.value();
}

/** Find-or-create a plain rem named `value` directly under an arbitrary parent rem. Cached per run. */
async function ensureChildRem(
  plugin: RNPlugin,
  ctx: SyncContext,
  parent: PluginRem,
  value: string
): Promise<PluginRem> {
  const cacheKey = `child ${parent._id} ${value}`;
  const cached = ctx.lookupCache.get(cacheKey);
  if (cached) return cached;
  let rem = await oldestChildByName(plugin, ctx, parent, value);
  if (!rem) {
    rem = await plugin.rem.createRem();
    if (!rem) throw new Error(`Failed to create rem "${value}".`);
    await rem.setText([value]);
    await rem.setParent(parent); // plain rem — no setIsDocument
    registerChildName(ctx, parent, value, rem);
  }
  ctx.lookupCache.set(cacheKey, rem);
  return rem;
}

/**
 * Ensure the nested Zotero/Dates path for `parts` ([year] | [year,month] | [year,month,day]) — year
 * under the Dates doc, month under the year, day under the month — and return the rem for each level.
 * Like the Collections tree, but a single linear chain.
 */
async function ensureDatePathRems(
  plugin: RNPlugin,
  ctx: SyncContext,
  parts: string[]
): Promise<PluginRem[]> {
  const datesDoc = await ensureLookupDoc(plugin, ctx, HIERARCHY.dates);
  const rems: PluginRem[] = [];
  let parent: PluginRem = datesDoc;
  for (const part of parts) {
    const rem = await ensureChildRem(plugin, ctx, parent, part);
    rems.push(rem);
    parent = rem;
  }
  return rems;
}

/** Build the Date slot value: the date-path rems as references joined by "-" (e.g. ‹2026›-‹07›-‹01›). */
async function buildDateRichText(plugin: RNPlugin, rems: PluginRem[]): Promise<RichTextInterface> {
  if (rems.length === 0) return [];
  let b = plugin.richText.rem(rems[0]._id);
  for (let i = 1; i < rems.length; i++) b = b.text('-').rem(rems[i]._id);
  return b.value();
}

/** Ordered ancestor keys [root…leaf] for a collection (stops at unknown/cyclic parents). */
function collectionAncestryKeys(ctx: SyncContext, key: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = key;
  while (cur && !seen.has(cur) && ctx.collectionNameByKey.has(cur)) {
    chain.unshift(cur);
    seen.add(cur);
    cur = ctx.collectionParentByKey.get(cur) ?? null;
  }
  return chain;
}

/** Full "/"-joined path for a collection, e.g. "General/Defects". */
function collectionPath(ctx: SyncContext, key: string): string {
  return collectionAncestryKeys(ctx, key)
    .map((k) => ctx.collectionNameByKey.get(k) ?? '')
    .filter(Boolean)
    .join('/');
}

/**
 * Arrange create items into a nested collection tree mirroring Zotero's hierarchy. Each item
 * is placed under its **primary** collection (the one whose path sorts first); the primary's
 * ancestors become container nodes so e.g. items in `General/DFT` nest under a `General` node.
 * Items in no collection go under a final "(No collection)" group.
 */
function buildGroups<T extends { item: ZoteroItem }>(ctx: SyncContext, entries: T[]): EntryGroup<T>[] {
  const root: EntryGroup<T> = { key: '__root__', name: '', items: [], children: [] };
  const noColl: EntryGroup<T> = { key: 'none', name: '(No collection)', items: [], children: [] };
  const nodeByKey = new Map<string, EntryGroup<T>>();

  const ensureNode = (key: string): EntryGroup<T> => {
    const existing = nodeByKey.get(key);
    if (existing) return existing;
    const node: EntryGroup<T> = {
      key,
      name: ctx.collectionNameByKey.get(key) ?? '(unknown collection)',
      items: [],
      children: [],
    };
    nodeByKey.set(key, node);
    const parentKey = ctx.collectionParentByKey.get(key) ?? null;
    const parent = parentKey && ctx.collectionNameByKey.has(parentKey) ? ensureNode(parentKey) : root;
    parent.children.push(node);
    return node;
  };

  for (const e of entries) {
    const keys = [...new Set(e.item.data.collections ?? [])].filter((k) =>
      ctx.collectionNameByKey.has(k)
    );
    if (keys.length === 0) {
      noColl.items.push(e);
      continue;
    }
    let primaryKey = keys[0];
    let primaryPath = collectionPath(ctx, primaryKey);
    for (const k of keys) {
      const p = collectionPath(ctx, k);
      if (p < primaryPath) {
        primaryPath = p;
        primaryKey = k;
      }
    }
    ensureNode(primaryKey).items.push(e);
  }

  const sortRec = (g: EntryGroup<T>): void => {
    g.children.sort((a, b) => a.name.localeCompare(b.name));
    g.children.forEach(sortRec);
  };
  sortRec(root);

  const top = [...root.children];
  if (noColl.items.length) top.push(noColl);
  return top;
}

/**
 * Build the Collections slot value: each collection rendered as its full ancestry path of
 * references joined by "/" (e.g. ‹General›/‹Defects›), multiple collections one per line.
 */
async function buildCollectionsRichText(
  plugin: RNPlugin,
  ctx: SyncContext,
  collectionKeys: string[]
): Promise<RichTextInterface> {
  // Sort by full path so the multi-collection order is stable (keeps the diff order-independent
  // without having to split a space-joined string — collection names may contain spaces).
  const sortedKeys = [...collectionKeys].sort((a, b) => {
    const pa = collectionPath(ctx, a);
    const pb = collectionPath(ctx, b);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  const paths = sortedKeys
    .map((ck) =>
      collectionAncestryKeys(ctx, ck)
        .map((k) => ctx.collectionRemByKey.get(k))
        .filter((r): r is PluginRem => !!r)
    )
    .filter((rems) => rems.length > 0);
  if (paths.length === 0) return [];

  let b = plugin.richText.rem(paths[0][0]._id);
  for (let i = 1; i < paths[0].length; i++) b = b.text('/').rem(paths[0][i]._id);
  for (let p = 1; p < paths.length; p++) {
    b = b.text(' '); // separate multiple collections with a space
    for (let i = 0; i < paths[p].length; i++)
      b = i === 0 ? b.rem(paths[p][i]._id) : b.text('/').rem(paths[p][i]._id);
  }
  return b.value();
}

/**
 * Build the nested `Zotero/Collections` mirror once, populating `ctx.collectionRemByKey`.
 * Parents are created before children; orphaned parents (e.g. in a group library) attach at root.
 */
async function ensureCollectionsTree(plugin: RNPlugin, ctx: SyncContext, log?: SyncLog): Promise<void> {
  if (ctx.collectionsBuilt) return;
  ctx.collectionsBuilt = true;

  const collectionsDoc = await ensureLookupDoc(plugin, ctx, HIERARCHY.collections);
  const byKey = new Map(ctx.collections.map((c) => [c.key, c]));

  const ensureOne = async (key: string, seen: Set<string>): Promise<PluginRem | undefined> => {
    const existing = ctx.collectionRemByKey.get(key);
    if (existing) return existing;
    const coll = byKey.get(key);
    if (!coll || seen.has(key)) return undefined; // unknown key or cycle
    seen.add(key);

    let parentRem: PluginRem = collectionsDoc;
    if (coll.parentKey) {
      const p = await ensureOne(coll.parentKey, seen);
      if (p) parentRem = p;
      else
        log?.log('plan', `  collection "${coll.name}" parent ${coll.parentKey} missing — attaching at Collections root.`);
    }
    let rem = await oldestChildByName(plugin, ctx, parentRem, coll.name);
    if (!rem) {
      rem = await plugin.rem.createRem();
      if (!rem) throw new Error(`Failed to create collection rem "${coll.name}".`);
      await rem.setText([coll.name]);
      await rem.setParent(parentRem);
      registerChildName(ctx, parentRem, coll.name, rem);
    }
    ctx.collectionRemByKey.set(key, rem);
    return rem;
  };

  for (const c of ctx.collections) await ensureOne(c.key, new Set());
  log?.log('plan', `Collections tree ensured: ${ctx.collectionRemByKey.size}/${ctx.collections.length} mapped.`);
}

/** Options controlling which slots `writeItemSlots` writes. */
export interface WriteFieldOpts {
  /** If given, only these Zotero-derived fields are written (the update path). */
  fields?: ReadonlySet<UpdatableField>;
  /** Write the default Status reference (create path only). */
  setStatusOnCreate?: boolean;
}

/**
 * Write metadata slots onto an item doc. Reference rems are created before their slot value.
 * Shared by the create path (all fields + status) and the update path (selected fields only).
 */
export async function writeItemSlots(
  plugin: RNPlugin,
  ctx: SyncContext,
  rem: PluginRem,
  meta: NormalizedMeta,
  opts: WriteFieldOpts,
  log?: SyncLog
): Promise<void> {
  const want = (f: UpdatableField): boolean => !opts.fields || opts.fields.has(f);
  const P = ZOTERO_ITEM_POWERUP;

  if (want('title')) {
    await rem.setPowerupProperty(P, SLOTS.title, [meta.title]);
  }
  if (want('type')) {
    const typeRem = await ensureRefRem(plugin, ctx, HIERARCHY.types, meta.typeLabel);
    await rem.setPowerupProperty(P, SLOTS.type, await plugin.richText.rem(typeRem._id).value());
  }
  if (want('authors')) {
    if (meta.authors.length === 0) {
      await rem.setPowerupProperty(P, SLOTS.authors, []);
    } else {
      const parts: { remId: string; suffix?: string }[] = [];
      for (const a of meta.authors) {
        const aRem = await ensureRefRem(plugin, ctx, HIERARCHY.authors, a.name);
        parts.push({ remId: aRem._id, suffix: a.role ? ` (${a.role})` : undefined });
      }
      await rem.setPowerupProperty(P, SLOTS.authors, await buildRefsRichText(plugin, parts, ' '));
    }
  }
  if (want('publication')) {
    if (!meta.publication) {
      await rem.setPowerupProperty(P, SLOTS.publication, []);
    } else {
      const pubRem = await ensureRefRem(plugin, ctx, HIERARCHY.publications, meta.publication);
      await rem.setPowerupProperty(P, SLOTS.publication, await plugin.richText.rem(pubRem._id).value());
    }
  }
  if (want('link')) {
    if (!meta.link) {
      await rem.setPowerupProperty(P, SLOTS.link, []);
    } else {
      // A Remnote "link rem" renders as a real clickable hyperlink when referenced.
      const linkRem = await plugin.rem.createLinkRem(meta.link, false);
      await rem.setPowerupProperty(
        P,
        SLOTS.link,
        linkRem ? await plugin.richText.rem(linkRem._id).value() : [meta.link]
      );
    }
  }
  if (want('doi')) {
    if (!meta.doi) {
      await rem.setPowerupProperty(P, SLOTS.doi, []);
    } else {
      // A link rem (like the Link(s) slot) renders as a real clickable hyperlink. Its display
      // text is overridden to the BARE DOI so the property reads `10.x/...` (machine-readable
      // identity, used later to find related papers) but clicking it opens https://doi.org/<doi>.
      const doiRem = await plugin.rem.createLinkRem(`https://doi.org/${meta.doi}`, false);
      if (doiRem) {
        await doiRem.setText([meta.doi]);
        await rem.setPowerupProperty(P, SLOTS.doi, await plugin.richText.rem(doiRem._id).value());
      } else {
        await rem.setPowerupProperty(P, SLOTS.doi, [meta.doi]);
      }
    }
  }
  if (want('year')) {
    // "Date": the parsed date as a nested reference path Year-Month-Day under Zotero/Dates
    // (e.g. ‹2026›-‹07›-‹01›), so each part links to every item from that year / month / day.
    if (meta.dateParts.length === 0) {
      await rem.setPowerupProperty(P, SLOTS.year, []);
    } else {
      const rems = await ensureDatePathRems(plugin, ctx, meta.dateParts);
      await rem.setPowerupProperty(P, SLOTS.year, await buildDateRichText(plugin, rems));
    }
  }
  if (want('collections')) {
    if (meta.collectionKeys.length === 0) {
      await rem.setPowerupProperty(P, SLOTS.collections, []);
    } else {
      await ensureCollectionsTree(plugin, ctx, log);
      await rem.setPowerupProperty(
        P,
        SLOTS.collections,
        await buildCollectionsRichText(plugin, ctx, meta.collectionKeys)
      );
    }
  }
  if (opts.setStatusOnCreate) {
    const stRem = await ensureRefRem(plugin, ctx, HIERARCHY.statuses, DEFAULT_STATUS);
    await rem.setPowerupProperty(P, SLOTS.status, await plugin.richText.rem(stRem._id).value());
  }
}

// ───────────────────────── Metadata: update detection (diff) ─────────────────────────

/** Read the stored Zotero version as a number (NaN if missing/unset). */
async function storedVersion(rem: PluginRem): Promise<number> {
  try {
    const v = (await rem.getPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version)).trim();
    const n = Number(v);
    return v && Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

/** Resolve a reference rem id to its name (cached per run). */
async function resolveRefName(plugin: RNPlugin, ctx: SyncContext, id: string): Promise<string> {
  const cached = ctx.refNameCache.get(id);
  if (cached !== undefined) return cached;
  const r = await plugin.rem.findOne(id);
  const name = r ? await remName(plugin, r) : '';
  ctx.refNameCache.set(id, name);
  return name;
}

/** Read a slot as RichText, preserving reference elements (undefined if unset/error). */
async function getSlotRichText(rem: PluginRem, slot: string): Promise<RichTextInterface | undefined> {
  try {
    return await rem.getPowerupPropertyAsRichText(ZOTERO_ITEM_POWERUP, slot);
  } catch {
    return undefined;
  }
}

/** Flatten a slot's RichText to a comparable string: references → their names, text as-is. */
async function slotToComparable(
  plugin: RNPlugin,
  ctx: SyncContext,
  rt: RichTextInterface | undefined
): Promise<string> {
  if (!rt) return '';
  let out = '';
  for (const el of rt) {
    if (typeof el === 'string') out += el;
    else if (el && (el as { i?: string }).i === 'q')
      out += await resolveRefName(plugin, ctx, (el as { _id: string })._id);
    else if (el && (el as { i?: string }).i === 'm') out += (el as { text?: string }).text ?? '';
    else out += '\n'; // newline / other element our writer never emits
  }
  return out.trim();
}

/**
 * Read a slot's RichText as a LIST of tags: each reference element (a picked tag rem) is ONE tag
 * with its internal spaces preserved (so a multi-word tag like "Machine Learning" stays one Zotero
 * tag, not two); plain text/`{i:'m'}` runs are whitespace-split into tags (typed entries). Fixes
 * F5 — the old `split(/\s+/)` over the whole flattened string broke multi-word picked tags apart.
 */
async function slotToTagList(
  plugin: RNPlugin,
  ctx: SyncContext,
  rt: RichTextInterface | undefined
): Promise<string[]> {
  if (!rt) return [];
  const out: string[] = [];
  // Split plain-text runs on whitespace AND commas: the Tags multi-select stores ", " separators
  // BETWEEN picked reference chips as literal text, so splitting on whitespace alone leaks a bare
  // "," as a spurious tag. Commas also let a user type "a, b" as two tags. Picked refs (below) are
  // NOT split — they keep their internal spaces so a multi-word tag stays one tag.
  const pushWords = (s: string): void => {
    for (const w of s.split(/[\s,]+/)) if (w.trim()) out.push(w.trim());
  };
  for (const el of rt) {
    if (typeof el === 'string') pushWords(el);
    else if (el && (el as { i?: string }).i === 'q') {
      const name = (await resolveRefName(plugin, ctx, (el as { _id: string })._id)).trim();
      if (name) out.push(name); // a picked tag rem → exactly one tag (spaces kept)
    } else if (el && (el as { i?: string }).i === 'm') pushWords((el as { text?: string }).text ?? '');
  }
  return out;
}

/**
 * Canonical key for comparing a stored Link slot against a raw Zotero URL (F2). A Remnote link-rem
 * renders a prettified title (scheme dropped, `-` shown as a space, e.g. `example.org/zottest a`)
 * that never equals the raw URL (`https://example.org/zottest-a`), so a literal compare always
 * false-positives. We strip scheme/`www.` and all punctuation so only the meaningful characters
 * remain; genuine URL changes still differ, only punctuation-only differences are treated as equal.
 */
const linkKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '');

/** True if the rich text contains at least one rem-reference element (`{i:'q'}`). */
const hasRefElement = (rt: RichTextInterface | undefined): boolean =>
  (rt ?? []).some((el) => typeof el !== 'string' && (el as { i?: string }).i === 'q');

/**
 * True if any reference element in the given slots no longer resolves to a named rem — a
 * "dangling" ref (left behind e.g. by RemNote's native merge, an interrupted cross-device sync,
 * or a deleted lookup rem; renders as "Loading" in the property panel). Docs flagged here are
 * re-diffed, and applying the resulting field rows rewrites the slots against live lookup rems.
 */
async function hasDanglingRef(
  plugin: RNPlugin,
  ctx: SyncContext,
  rem: PluginRem,
  slots: string[]
): Promise<boolean> {
  for (const slot of slots) {
    const rt = await getSlotRichText(rem, slot);
    if (!rt) continue;
    for (const el of rt) {
      if (typeof el === 'string') continue;
      const obj = el as { i?: string; _id?: string };
      if (obj.i === 'q' && obj._id && (await resolveRefName(plugin, ctx, obj._id)) === '')
        return true;
    }
  }
  return false;
}

/** Normalize a multi-value string to an order-independent canonical form (for collections). */
const asSortedSet = (s: string): string =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join('\n');

/** Compact a comparable string for one-line UI display. */
const displayValue = (s: string): string => {
  const one = s.replace(/\n/g, ', ').trim();
  if (!one) return '(empty)';
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
};

/**
 * Compare an existing item doc's current slot values against freshly-computed metadata.
 * Only the Zotero-derived (updatable) fields are compared. Authors are order-sensitive;
 * collections are compared as a set. A pre-feature doc (empty slots) yields `(empty) → value`.
 */
export async function diffItem(
  plugin: RNPlugin,
  ctx: SyncContext,
  rem: PluginRem,
  meta: NormalizedMeta
): Promise<FieldChange[]> {
  const changes: FieldChange[] = [];
  const compare = async (field: UpdatableField, slot: string, desired: string, set = false): Promise<void> => {
    let from = await slotToComparable(plugin, ctx, await getSlotRichText(rem, slot));
    let to = desired;
    if (set) {
      from = asSortedSet(from);
      to = asSortedSet(to);
    }
    if (from !== to) changes.push({ field, fromDisplay: displayValue(from), toDisplay: displayValue(to) });
  };

  await compare('title', SLOTS.title, meta.title);
  await compare('type', SLOTS.type, meta.typeLabel);
  await compare(
    'authors',
    SLOTS.authors,
    meta.authors.map((a) => (a.role ? `${a.name} (${a.role})` : a.name)).join(' ')
  );
  await compare('publication', SLOTS.publication, meta.publication);
  // Link: compare by normalized URL key, not the link-rem's prettified display text (F2).
  {
    const from = await slotToComparable(plugin, ctx, await getSlotRichText(rem, SLOTS.link));
    if (linkKey(from) !== linkKey(meta.link))
      changes.push({ field: 'link', fromDisplay: displayValue(from), toDisplay: displayValue(meta.link) });
  }
  // DOI: the value is stored as a reference to a link rem whose text is the bare DOI (clickable
  // → https://doi.org/<doi>), so the text comparison resolves to the bare DOI on both sides.
  // ALSO re-stage when the stored value is pre-hyperlink plain text (no reference element), so
  // docs synced before the clickable-DOI format upgrade to it (one-time migration).
  {
    const rt = await getSlotRichText(rem, SLOTS.doi);
    const from = await slotToComparable(plugin, ctx, rt);
    if (from !== meta.doi || (!!meta.doi && !hasRefElement(rt)))
      changes.push({ field: 'doi', fromDisplay: displayValue(from), toDisplay: displayValue(meta.doi) });
  }
  // "Date": compare the Year-Month-Day reference path (refs flatten to their names joined by "-").
  await compare('year', SLOTS.year, meta.dateParts.join('-'));
  await compare(
    'collections',
    SLOTS.collections,
    [...meta.collectionKeys].map((k) => collectionPath(ctx, k)).filter(Boolean).sort().join(' ')
  );

  return changes;
}

/**
 * Build the exact Zotero tag set for a locally-edited item from its three user-owned slots:
 * Status (the referenced status name → one tag), Rating (the raw text → one tag), and Tags
 * (one tag per picked reference — multi-word tags stay intact; typed text is whitespace-split,
 * see `slotToTagList`). Empty values are dropped and duplicates removed (first occurrence wins).
 * This is what gets written back to Zotero, replacing the item's tags exactly.
 */
async function computePushTags(plugin: RNPlugin, ctx: SyncContext, rem: PluginRem): Promise<string[]> {
  const status = await slotToComparable(plugin, ctx, await getSlotRichText(rem, SLOTS.status));
  const rating = await slotToComparable(plugin, ctx, await getSlotRichText(rem, SLOTS.rating));
  const tagList = await slotToTagList(plugin, ctx, await getSlotRichText(rem, SLOTS.tags));
  const raw = [status, rating, ...tagList];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const tag = t.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Compute the changes needed to make `Zotero / Items` mirror the Zotero library.
 *
 * Identity is the **Zotero key** only:
 *   - A Zotero item is **created** if no existing document carries its key.
 *   - A child of Items is **deleted** if it has no stored key, or its stored key is no
 *     longer present in Zotero.
 *   - Exception: Remnote's own internal rems (powerup machinery, slots, property rems —
 *     see `isStructuralRem`) are **skipped**. `getChildrenRem()` returns these hidden rems
 *     even though they never render as a visible bullet, and they aren't user content.
 *
 * Safety: if the Zotero fetch returns zero items (likely an error rather than a truly
 * empty library), deletions are suppressed so a transient failure can't wipe the tree.
 */
/**
 * Merge same-name duplicate rems under the Zotero hierarchy (housekeeping, runs every preview).
 * Cross-device sync races create duplicates: machine B syncs before machine A's lookup rems
 * arrive, `findByName` misses, B creates its own copy, and RemNote's sync then keeps BOTH —
 * duplicated parents (two "Archive"s) subsequently breed duplicated children. This pass:
 *   1. dedupes the top-level docs themselves (Items + the six lookup docs) under the root,
 *   2. dedupes each lookup doc's children (and recursively for the nested Collections tree),
 * keeping the OLDEST of each name (same rule `oldestChildByName` uses, so all clients converge)
 * and folding the rest in via the manual `foldInto` below — move children, rewrite inbound
 * references, remove the dup. (RemNote's NATIVE `rem.merge` was tried first and REJECTED: it
 * left the duplicates' inbound references dangling — item docs' Collection(s) rendered
 * "Loading"; do not reintroduce it.) Items docs are NOT touched beyond the top-level doc dedup
 * (item identity is the Zotero key; the duplicate-key guard handles those). No-op (one children
 * scan) when everything is already unique.
 */
async function mergeDuplicateLookupRems(
  plugin: RNPlugin,
  ctx: SyncContext,
  log?: SyncLog
): Promise<number> {
  const root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) return 0;
  let merged = 0;

  // Manual fold (NOT rem.merge): RemNote's native merge was observed to leave the duplicate's
  // inbound references DANGLING (item docs' Collection(s) rendered "Loading" afterwards), so we
  // move the children, re-point every referencing rem's rich text to the canonical id ourselves,
  // and only then remove the duplicate.
  const foldInto = async (canonical: PluginRem, dup: PluginRem): Promise<void> => {
    for (const child of await dup.getChildrenRem()) {
      if (await isStructuralRem(child)) continue; // powerup machinery dies with the dup
      await child.setParent(canonical);
    }
    for (const refRem of await dup.remsReferencingThis()) {
      const txt = refRem.text;
      if (!txt) continue;
      const newTxt = txt.map((el) => {
        if (typeof el === 'string') return el;
        const obj = el as { i?: string; _id?: string };
        if (obj.i === 'q' && obj._id === dup._id)
          return { ...(el as Record<string, unknown>), _id: canonical._id };
        return el;
      });
      await refRem.setText(newTxt as RichTextInterface);
    }
    await dup.remove();
  };

  const mergeUnder = async (parent: PluginRem, label: string, recurse: boolean): Promise<void> => {
    const groups = new Map<string, PluginRem[]>();
    for (const child of await parent.getChildrenRem()) {
      if (await isStructuralRem(child)) continue;
      const name = (await remName(plugin, child)).trim();
      if (!name) continue;
      const g = groups.get(name);
      if (g) g.push(child);
      else groups.set(name, [child]);
    }
    for (const [name, rems] of groups) {
      if (rems.length < 2) continue;
      rems.sort((a, b) => a.createdAt - b.createdAt);
      const canonical = rems[0];
      for (let i = 1; i < rems.length; i++) {
        try {
          await foldInto(canonical, rems[i]);
          merged += 1;
          log?.log('plan', `  merged duplicate "${name}" under ${label} (kept oldest ${canonical._id}).`);
        } catch (err) {
          log?.log('plan', `  MERGE FAILED for duplicate "${name}" under ${label}: ${errMsg(err)}`);
        }
      }
    }
    if (recurse) {
      // Merging two parents can land same-name children next to each other — dedupe each level.
      for (const child of await parent.getChildrenRem()) {
        if (await isStructuralRem(child)) continue;
        const childName = (await remName(plugin, child)).trim();
        if (childName) await mergeUnder(child, `${label}/${childName}`, true);
      }
    }
  };

  // Top-level docs first (a duplicated "Collections"/"Items" doc hides half the tree), then
  // the entries inside each lookup doc. Only our known doc names are deduped at root level —
  // anything else under the Zotero root is the user's.
  const topLevel = new Set<string>([
    HIERARCHY.items,
    HIERARCHY.types,
    HIERARCHY.authors,
    HIERARCHY.publications,
    HIERARCHY.dates,
    HIERARCHY.collections,
    HIERARCHY.statuses,
  ]);
  const rootGroups = new Map<string, PluginRem[]>();
  for (const child of await root.getChildrenRem()) {
    if (await isStructuralRem(child)) continue;
    const name = (await remName(plugin, child)).trim();
    if (!topLevel.has(name)) continue;
    const g = rootGroups.get(name);
    if (g) g.push(child);
    else rootGroups.set(name, [child]);
  }
  for (const [name, rems] of rootGroups) {
    if (rems.length < 2) continue;
    rems.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < rems.length; i++) {
      try {
        await foldInto(rems[0], rems[i]);
        merged += 1;
        log?.log('plan', `  merged duplicate top-level doc "${name}" (kept oldest ${rems[0]._id}).`);
      } catch (err) {
        log?.log('plan', `  MERGE FAILED for top-level doc "${name}": ${errMsg(err)}`);
      }
    }
  }

  for (const docName of [
    HIERARCHY.types,
    HIERARCHY.authors,
    HIERARCHY.publications,
    HIERARCHY.dates,
    HIERARCHY.collections,
    HIERARCHY.statuses,
  ]) {
    const doc = await plugin.rem.findByName([docName], root._id);
    if (!doc) continue;
    // Collections + Dates are NESTED trees, so dedupe their entries recursively.
    await mergeUnder(doc, docName, docName === HIERARCHY.collections || docName === HIERARCHY.dates);
  }

  if (merged > 0)
    log?.log('plan', `Merged ${merged} duplicate lookup rem(s) — kept the oldest of each name.`);
  return merged;
}

export async function computeSyncPlan(
  plugin: RNPlugin,
  items: ZoteroItem[],
  ctx: SyncContext,
  log?: SyncLog,
  opts?: { reportedTotal?: number }
): Promise<SyncPlan> {
  const zoteroKeys = new Set(items.map((i) => i.key));
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  log?.section('Compute sync plan (match by Zotero key)');
  log?.log('plan', `Zotero items to reconcile: ${items.length} (unique keys: ${zoteroKeys.size}).`);

  // Housekeeping FIRST (before any diff resolves references or any name map is cached): fold
  // duplicate lookup rems into their oldest copy so this run sees a clean tree.
  await mergeDuplicateLookupRems(plugin, ctx, log);

  const itemsParent = await findItemsParent(plugin);
  if (!itemsParent) {
    log?.log(
      'plan',
      'No existing "Zotero / Items" document — nothing to keep or delete; every Zotero item will be created.'
    );
  } else {
    log?.log('plan', `Found "Zotero / Items" (id=${itemsParent._id}); scanning its children…`);
  }

  const keptKeys = new Set<string>();
  const toDelete: DeleteEntry[] = [];
  const toUpdate: UpdateEntry[] = [];
  const toMatch: MatchEntry[] = [];
  const toPushTags: PushEntry[] = [];
  const alreadyPresent: KeptEntry[] = [];
  let skippedInternal = 0;
  let listed = 0;
  let diagged = 0;

  if (itemsParent) {
    const children = await itemsParent.getChildrenRem();
    log?.log('plan', `Raw children of Items (incl. Remnote-internal rems): ${children.length}.`);

    // ── Pass 0: classify children (skip internal; split keyed vs keyless). ──
    const keyedDocs: { child: PluginRem; name: string; key: string }[] = [];
    const keylessDocs: { child: PluginRem; name: string }[] = [];
    for (const child of children) {
      const name = await remName(plugin, child);
      const shown = name || '(untitled)';
      // Skip Remnote's internal/auto-generated rems (powerup machinery, slots, hidden
      // status rems): getChildrenRem() returns these, but they aren't user content and must
      // never be deleted or surfaced as items.
      if (await isStructuralRem(child)) {
        skippedInternal += 1;
        if (log && diagged < DELETE_DIAG_CAP) {
          log?.log(
            'plan',
            `  skip (Remnote-internal) "${shown}" — [${await describeRem(plugin, child)}] (id=${child._id}).`
          );
          diagged += 1;
        }
        continue;
      }
      const key = await storedKey(child);
      if (key) keyedDocs.push({ child, name, key });
      else keylessDocs.push({ child, name });
    }

    // ── Pass 1: duplicate-key guard — one Zotero key per doc. Keep the OLDEST doc (earliest
    // createdAt; most likely to carry accumulated links/notes); newer copies → Will delete. ──
    const winnerByKey = new Map<string, { child: PluginRem; name: string; key: string }>();
    for (const doc of keyedDocs) {
      const prev = winnerByKey.get(doc.key);
      if (!prev) {
        winnerByKey.set(doc.key, doc);
        continue;
      }
      const loser = doc.child.createdAt < prev.child.createdAt ? prev : doc;
      const winner = loser === prev ? doc : prev;
      winnerByKey.set(doc.key, winner);
      toDelete.push({ id: `d:${loser.child._id}`, name: loser.name, reason: 'duplicate-key', rem: loser.child });
      log?.log(
        'plan',
        `  DELETE "${loser.name || '(untitled)'}" — duplicate of key ${doc.key} (kept oldest doc id=${winner.child._id}).`
      );
    }

    // ── Pass 2: reconcile each unique keyed doc against Zotero. ──
    for (const { child, name, key } of winnerByKey.values()) {
      const shown = name || '(untitled)';
      if (!zoteroKeys.has(key)) {
        toDelete.push({ id: `d:${child._id}`, name, reason: 'missing-from-zotero', rem: child });
        if (listed < LOG_LIST_CAP)
          log?.log('plan', `  DELETE "${shown}" — key ${key} no longer in Zotero (id=${child._id}).`);
        listed += 1;
        continue;
      }
      keptKeys.add(key);
      const item = itemByKey.get(key)!;
      // Cheap gate: diff only if Zotero's version advanced, or the doc predates metadata
      // (version may match but the Title slot is still empty → needs backfill), or the doc
      // predates the DOI slot (item has a DOI but the slot is empty → backfill).
      let needDiff = (await storedVersion(child)) !== item.version;
      if (!needDiff)
        needDiff = !(await slotToComparable(plugin, ctx, await getSlotRichText(child, SLOTS.title)));
      if (!needDiff && item.data.DOI?.trim()) {
        // Re-diff when the DOI slot is empty (pre-DOI doc) OR still plain text (pre-hyperlink
        // doc) — both upgrade to the clickable bare-DOI link rem via a normal field update.
        const doiRt = await getSlotRichText(child, SLOTS.doi);
        needDiff = !(await slotToComparable(plugin, ctx, doiRt)) || !hasRefElement(doiRt);
      }
      if (!needDiff && (item.meta?.parsedDate || (item.data.date ?? '').trim())) {
        // Migrate/refresh the Date path: re-diff when the stored Date slot doesn't already equal the
        // freshly-computed Year-Month-Day path — covers docs synced before the Date feature (their
        // `year` slot still holds a single ref into the old Zotero/Years tree) plus any date change.
        const stored = await slotToComparable(plugin, ctx, await getSlotRichText(child, SLOTS.year));
        needDiff = stored !== parseDateParts(item.meta?.parsedDate, item.data.date).join('-');
      }
      if (!needDiff)
        // Repair gate: a slot ref that no longer resolves (dangling — renders "Loading") means
        // the doc needs its metadata rewritten against live lookup rems.
        needDiff = await hasDanglingRef(plugin, ctx, child, [
          SLOTS.type,
          SLOTS.authors,
          SLOTS.publication,
          SLOTS.year,
          SLOTS.collections,
        ]);
      const changes = needDiff ? await diffItem(plugin, ctx, child, extractMetadata(item, ctx.meta)) : [];
      // Name reconciliation: keep the doc title == the REAL Zotero/Better-BibTeX citation key. Gated
      // on a real `data.citationKey` ON PURPOSE — a GENERATED citekey (displayName's fallback) is for
      // NAMING new docs, NOT for mass-renaming every pre-existing title-named doc. So this only fires
      // when Zotero exposes a real key that the doc doesn't already match (BBT pinned/changed it, or
      // the user edited it, or a local rename drifted from it) — both directions, caught independently
      // of the version gate.
      const realKey = item.data.citationKey?.trim();
      if (realKey && nameKey(name) !== nameKey(realKey))
        changes.unshift({ field: 'name', fromDisplay: name || '(untitled)', toDisplay: realKey });
      if (changes.length > 0) {
        toUpdate.push({ id: `u:${child._id}`, name, rem: child, item, changes });
        if (listed < LOG_LIST_CAP)
          log?.log(
            'plan',
            `  UPDATE "${shown}" — ${changes.map((c) => c.field).join(', ')} (id=${child._id}).`
          );
      } else {
        alreadyPresent.push({ id: `k:${child._id}`, key, name });
        if (listed < LOG_LIST_CAP) log?.log('plan', `  KEEP   "${shown}" — key ${key} up to date.`);
      }

      // Local-edit → Zotero push: if the user touched this doc since the last sync, write its
      // user-owned fields (Status/Rating/Tags) back to Zotero as the item's exact tag set.
      // Skipped on the first run (no lastSyncAt) and when the resulting tags already match.
      if (ctx.lastSyncAt > 0 && child.updatedAt > ctx.lastSyncAt) {
        const tags = await computePushTags(plugin, ctx, child);
        const zoteroTags = [...new Set((item.data.tags ?? []).map((t) => t.tag))];
        if (asSortedSet(tags.join('\n')) !== asSortedSet(zoteroTags.join('\n'))) {
          toPushTags.push({
            id: `p:${child._id}`,
            name,
            rem: child,
            itemKey: key,
            itemVersion: item.version,
            tags,
          });
          if (listed < LOG_LIST_CAP)
            log?.log(
              'plan',
              `  PUSH   "${shown}" — edited in Remnote → Zotero tags [${tags.join(
                ', '
              )}] (was [${zoteroTags.join(', ')}]).`
            );
        }
      }
      listed += 1;
    }

    // ── Pass 3: keyless docs — try to ADOPT by citation key before deleting. A doc created by
    // a citation picker is named by the item's citekey; deleting+recreating it would break every
    // existing reference to it. Exact name == data.citationKey, against items not already kept
    // and not already claimed by another match. Unmatched keyless docs → Will delete (no-key). ──
    const itemByCitekey = new Map<string, ZoteroItem>();
    for (const item of items) {
      const ck = item.data.citationKey?.trim();
      if (ck && !keptKeys.has(item.key) && !itemByCitekey.has(ck)) itemByCitekey.set(ck, item);
    }
    const claimedKeys = new Set<string>();
    for (const { child, name } of keylessDocs) {
      const shown = name || '(untitled)';
      const match = itemByCitekey.get(name);
      if (match && !claimedKeys.has(match.key)) {
        claimedKeys.add(match.key);
        toMatch.push({ id: `m:${child._id}`, name, rem: child, item: match });
        if (listed < LOG_LIST_CAP)
          log?.log(
            'plan',
            `  MATCH  "${shown}" — name equals citekey of Zotero ${match.key}; will adopt (id=${child._id}).`
          );
      } else {
        toDelete.push({ id: `d:${child._id}`, name, reason: 'no-key', rem: child });
        if (listed < LOG_LIST_CAP)
          log?.log('plan', `  DELETE "${shown}" — no Zotero key stored (id=${child._id}).`);
      }
      listed += 1;
    }

    if (children.length > LOG_LIST_CAP)
      log?.log('plan', `  … (${children.length - LOG_LIST_CAP} more children not individually listed)`);
  }

  const matchedKeys = new Set(toMatch.map((m) => m.item.key));
  const toCreate: CreateEntry[] = [];
  for (const item of items) {
    if (keptKeys.has(item.key) || matchedKeys.has(item.key)) continue;
    const collections = [...new Set(item.data.collections ?? [])]
      .map((k) => collectionPath(ctx, k))
      .filter(Boolean)
      .sort();
    toCreate.push({ id: `c:${item.key}`, key: item.key, name: displayName(item), item, collections });
  }

  log?.log('plan', `Existing docs already up to date: ${alreadyPresent.length}.`);
  log?.log('plan', `Existing docs to update (metadata changed): ${toUpdate.length}.`);
  log?.log('plan', `Keyless docs matched by citekey → to adopt: ${toMatch.length}.`);
  log?.log('plan', `Existing docs edited locally → tags to push to Zotero: ${toPushTags.length}.`);
  log?.log('plan', `Remnote-internal rems skipped (not user content): ${skippedInternal}.`);
  log?.log('plan', `Docs to delete (no live Zotero key): ${toDelete.length}.`);
  log?.log('plan', `Zotero items missing from Remnote → to create: ${toCreate.length}.`);
  for (let i = 0; i < toCreate.length && i < LOG_LIST_CAP; i++) {
    const c = toCreate[i];
    log?.log('plan', `  CREATE "${c.name}" — key ${c.key}, type ${c.item.data.itemType}.`);
  }
  if (toCreate.length > LOG_LIST_CAP)
    log?.log('plan', `  … (${toCreate.length - LOG_LIST_CAP} more to create not individually listed)`);

  const emptyLibrarySkippedDeletes = items.length === 0 && toDelete.length > 0;
  if (emptyLibrarySkippedDeletes) {
    log?.log(
      'plan',
      `SAFETY GUARD: Zotero returned 0 items but ${toDelete.length} doc(s) would be deleted — suppressing ALL deletions (likely a credentials/network failure, not a truly empty library).`
    );
  }

  // PARTIAL-FETCH GUARD: a doc is staged `missing-from-zotero` only because its key wasn't in the
  // fetched set — so an INCOMPLETE fetch (transient short page, rate-limit truncation, re-scoped
  // library) would falsely delete real docs. Detect incompleteness two ways and suppress just those
  // deletions (no-key / duplicate-key deletes don't depend on fetch completeness, so they still run):
  //  (1) PRECISE: Zotero's Total-Results > what we fetched ⇒ the fetch was truncated. A genuine
  //      shrink reports Total-Results == items.length, so this never trips on real deletions.
  //  (2) FALLBACK (no Total-Results header): on a non-first run, ≥half of the keyed docs we saw
  //      suddenly missing (and an absolute floor) is treated as suspicious rather than real.
  const reportedTotal = opts?.reportedTotal ?? 0;
  const missingFromZotero = toDelete.filter((d) => d.reason === 'missing-from-zotero');
  const keyedSeen = keptKeys.size + missingFromZotero.length;
  const fetchTruncated = reportedTotal > 0 && items.length < reportedTotal;
  const massMissingNoTotal =
    reportedTotal === 0 &&
    ctx.lastSyncAt > 0 &&
    keyedSeen >= 20 &&
    missingFromZotero.length / keyedSeen >= 0.5;
  const partialFetchSkippedDeletes =
    !emptyLibrarySkippedDeletes && missingFromZotero.length > 0 && (fetchTruncated || massMissingNoTotal);
  if (partialFetchSkippedDeletes) {
    log?.log(
      'plan',
      `SAFETY GUARD: fetched ${items.length} item(s) but ${
        reportedTotal ? `Zotero reports Total-Results=${reportedTotal}` : 'could not confirm the library total'
      }; ${missingFromZotero.length} keyed doc(s) appear missing — suppressing those deletions (likely a truncated/throttled fetch, not real removals). Re-run a complete sync to delete genuinely-removed items.`
    );
  }

  const finalDelete = emptyLibrarySkippedDeletes
    ? []
    : partialFetchSkippedDeletes
    ? toDelete.filter((d) => d.reason !== 'missing-from-zotero')
    : toDelete;

  log?.log(
    'plan',
    `Plan summary → create=${toCreate.length}, update=${toUpdate.length}, match=${toMatch.length}, push=${toPushTags.length}, delete=${finalDelete.length}, skippedInternal=${skippedInternal}, emptyLibrarySkippedDeletes=${emptyLibrarySkippedDeletes}, partialFetchSkippedDeletes=${partialFetchSkippedDeletes}.`
  );

  return {
    toCreate,
    createGroups: buildGroups(ctx, toCreate),
    toUpdate,
    updateGroups: buildGroups(ctx, toUpdate),
    toMatch,
    toDelete: finalDelete,
    toPushTags,
    alreadyPresent,
    emptyLibrarySkippedDeletes,
    partialFetchSkippedDeletes,
  };
}

// ───────────────────────── Shared create-a-doc helpers ─────────────────────────
// Lifted to module scope so the bulk-sync create/adopt paths AND the on-page "Add related item"
// flow run through ONE code path (no copy-paste drift).

/** Write-once abstract: a plain text bullet appended to the doc body (create/adopt only). */
async function appendAbstractRem(plugin: RNPlugin, parent: PluginRem, abstract: string): Promise<void> {
  if (!abstract) return;
  const a = await plugin.rem.createRem();
  if (!a) return;
  await a.setText([abstract]);
  await a.setParent(parent);
}

/**
 * First-sync status write-back: ADD the default Status (In Progress) to the item's existing Zotero
 * tags (additive — never replace-exactly on a first sync, so Zotero-side tags survive). Bumps the
 * item's server version and writes it to the doc's version slot. Returns the outcome for counting;
 * a failure is logged but NON-fatal (the doc is fine; a later user edit re-pushes).
 */
async function writeStatusTagBack(
  plugin: RNPlugin,
  rem: PluginRem,
  item: ZoteroItem,
  log?: SyncLog
): Promise<'tagged' | 'skipped' | 'failed'> {
  try {
    const existing = (item.data.tags ?? []).map((t) => t.tag);
    if (existing.includes(DEFAULT_STATUS)) return 'skipped';
    const newVersion = await pushItemTags(plugin, item.key, item.version, [...existing, DEFAULT_STATUS], log);
    await rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version, [String(newVersion)]);
    return 'tagged';
  } catch (err) {
    log?.log(
      'apply',
      `  STATUS TAG-BACK FAILED for Zotero ${item.key}: ${errMsg(err)} (doc is fine; edit it later to re-push).`
    );
    return 'failed';
  }
}

/**
 * Create ONE Remnote `zotero-item` document from a full ZoteroItem — the single source of truth for
 * the bulk-sync create loop AND the on-page Add-related flow. Tags the powerup, stamps key/version,
 * writes all metadata slots (+ default Status), appends the abstract body bullet, reflects the
 * status tag back to Zotero, and stamps `lastSyncedAt`. Returns the new rem + the status-tag outcome
 * (for the caller's counters). Throws if `createRem` fails.
 */
/**
 * Make a rem an Incremental Everything (IE) "incremental rem" — ONLY when the user's `initIncremental`
 * setting is ON. The SDK has no cross-plugin command/messaging API, so we REPLICATE IE's tagging:
 * add IE's `incremental` powerup + write its priority / nextRepDate / repHist / originalIncDate slots
 * (mirrors IE's `initIncrementalRem`: due today, default priority, a single `madeIncremental` history
 * marker). Idempotent (skips an already-incremental rem so a re-sync can't reset its schedule) and
 * graceful: if IE isn't installed (its powerup code doesn't resolve cross-plugin) it logs + returns.
 * Never throws — a missing/renamed IE slot must not fail the Zotero sync. Codes are IE-internal
 * (see consts.ts `IE`) — undocumented coupling, kept minimal + error-swallowed.
 */
/**
 * Resolve (once per run, memoized on ctx) the inputs `makeIncremental` needs. Returns null when the
 * `initIncremental` setting is off OR Incremental Everything isn't installed. When a parent folder
 * (Items, else Zotero) is tagged incremental we inherit its priority (the user opted into priority
 * inheritance) and, for the CUSTOM IE variant, locate its "Rotation" / "First Added" property slots
 * by NAME (their codes are unknown to us, so we read/write them by slot-rem id via get/setTagPropertyValue).
 */
async function getIncSetup(plugin: RNPlugin, ctx: SyncContext, log?: SyncLog): Promise<IncSetup | null> {
  if (ctx.incSetup !== undefined) return ctx.incSetup; // cached (object or null)
  let setup: IncSetup | null = null;
  if (await plugin.settings.getSetting<boolean>(SETTINGS.initIncremental)) {
    const pu = await plugin.powerup.getPowerupByCode(IE.powerup); // undefined if IE not installed
    if (!pu) {
      log?.log('apply', 'Incremental Everything not installed — skipped making items incremental.');
    } else {
      // Closest incremental-tagged ancestor of new item docs: Items (their parent), else Zotero (root).
      const itemsRem = await findItemsParent(plugin);
      const rootRem = await plugin.rem.findByName([HIERARCHY.root], null);
      let incParent: PluginRem | undefined;
      if (itemsRem && (await itemsRem.hasPowerup(IE.powerup))) incParent = itemsRem;
      else if (rootRem && (await rootRem.hasPowerup(IE.powerup))) incParent = rootRem;

      let priority = String(IE.defaultPriority);
      let rotationSlotId: string | undefined;
      let firstAddedSlotId: string | undefined;
      if (incParent) {
        const inherited = (await incParent.getPowerupProperty(IE.powerup, IE.prioritySlot)).trim();
        if (inherited) priority = inherited; // inherit the folder's priority
        // Detect the custom IE variant by its extra property slots (matched by display NAME, since the
        // custom plugin's slot CODES are unknown). Prefer isPowerupSlot children but fall back to any
        // same-named child (a powerup's property rems don't always report as slots — same lesson as the
        // migration's oldSlotIds).
        const slotByName = new Map<string, string>();
        const anyByName = new Map<string, string>();
        for (const child of await pu.getChildrenRem()) {
          const nm = (await plugin.richText.toString(child.text ?? [])).trim().toLowerCase();
          if (!nm) continue;
          if (!anyByName.has(nm)) anyByName.set(nm, child._id);
          if (await child.isPowerupSlot()) slotByName.set(nm, child._id);
        }
        const pickSlot = (n: string): string | undefined => slotByName.get(n) ?? anyByName.get(n);
        rotationSlotId = pickSlot('rotation');
        firstAddedSlotId = pickSlot('first added');
      }
      setup = { pu, incParent, priority, rotationSlotId, firstAddedSlotId };
      log?.log(
        'apply',
        `Incremental setup: parent=${incParent ? 'tagged' : 'none'}, priority=${priority}, customSlots=${
          rotationSlotId && firstAddedSlotId ? 'Rotation+FirstAdded' : 'none'
        }.`
      );
    }
  }
  ctx.incSetup = setup;
  return setup;
}

async function makeIncremental(
  plugin: RNPlugin,
  rem: PluginRem,
  ctx: SyncContext,
  log?: SyncLog
): Promise<void> {
  try {
    if (await rem.hasPowerup(IE.powerup)) return; // already incremental — don't reset its schedule
    const setup = await getIncSetup(plugin, ctx, log); // null = setting off or IE not installed
    if (!setup) return;
    await rem.addPowerup(IE.powerup);
    // nextRepDate + originalIncDate = today, as a daily-doc reference (IE's getDailyDocReferenceForDate).
    const dailyDoc = await plugin.date.getDailyDoc(new Date());
    const dateRef = dailyDoc ? await plugin.richText.rem(dailyDoc).value() : undefined;
    if (dateRef) {
      await rem.setPowerupProperty(IE.powerup, IE.nextRepDateSlot, dateRef);
      await rem.setPowerupProperty(IE.powerup, IE.originalIncDateSlot, dateRef);
    }
    // Priority: inherited from the tagged parent folder when present, else IE's default.
    await rem.setPowerupProperty(IE.powerup, IE.prioritySlot, [setup.priority]);
    const priorityNum = Number(setup.priority) || IE.defaultPriority;
    // repHist: a single 'madeIncremental' marker — the exact shape IE's scheduler counts reps from.
    const marker = { date: Date.now(), scheduled: Date.now(), eventType: 'madeIncremental', priority: priorityNum };
    await rem.setPowerupProperty(IE.powerup, IE.repHistSlot, [JSON.stringify([marker])]);
    // CUSTOM IE variant + a tagged parent folder → inherit the folder's Rotation and stamp First
    // Added = today (read/written by slot-rem id since the custom plugin's slot codes are unknown).
    if (setup.incParent && setup.rotationSlotId && setup.firstAddedSlotId) {
      const rotation = await setup.incParent.getTagPropertyValue(setup.rotationSlotId);
      await rem.setTagPropertyValue(setup.rotationSlotId, rotation);
      if (dateRef) await rem.setTagPropertyValue(setup.firstAddedSlotId, dateRef);
    }
    log?.log(
      'apply',
      `Made the item incremental (priority ${setup.priority}${setup.incParent ? ' inherited' : ''}` +
        `${setup.incParent && setup.rotationSlotId ? ' +Rotation/FirstAdded' : ''}).`
    );
  } catch (err) {
    log?.log('apply', `Incremental-init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function createItemDoc(
  plugin: RNPlugin,
  ctx: SyncContext,
  item: ZoteroItem,
  parent: PluginRem,
  powerup: PluginRem,
  syncedAt: number,
  log?: SyncLog
): Promise<{ rem: PluginRem; statusTag: 'tagged' | 'skipped' | 'failed' }> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('createRem returned undefined');
  await rem.setText([displayName(item)]);
  // Insert at the TOP of Items (positionAmongstSiblings 0), not the bottom, so freshly-added items
  // are immediately visible. (In a bulk create, items thus appear newest-first within the run.)
  await rem.setParent(parent, 0);
  await rem.setIsDocument(true);
  await rem.addTag(powerup._id);
  await rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.key, [item.key]);
  await rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version, [String(item.version)]);
  const meta = extractMetadata(item, ctx.meta);
  await writeItemSlots(plugin, ctx, rem, meta, { setStatusOnCreate: true }, log);
  // The abstract lands as the doc's first body bullet (fresh doc → no other body children yet).
  await appendAbstractRem(plugin, rem, meta.abstract);
  // Stamp lastSyncedAt BEFORE the (network) status tag-back so a local-write failure can't hide a
  // tag-back that already succeeded — writeStatusTagBack swallows its own errors and never throws,
  // so the return (and the caller's counter) always runs once we reach it. The two writes target
  // different slots, so the order is otherwise immaterial.
  await rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.lastSyncedAt, [String(syncedAt)]);
  const statusTag = await writeStatusTagBack(plugin, rem, item, log);
  // Optionally enroll the new item in Incremental Everything (gated by the `initIncremental` setting;
  // no-op if off / IE absent). Covers BOTH create paths since both route through createItemDoc.
  await makeIncremental(plugin, rem, ctx, log);
  return { rem, statusTag };
}

/** The subset of changes to actually apply (after the user's per-item selection). */
export interface ApplySelection {
  toCreate: CreateEntry[];
  /** Update items with the specific fields the user ticked for each. */
  toUpdate: { entry: UpdateEntry; fields: ReadonlySet<UpdatableField> }[];
  /** Keyless docs to adopt (stamp key/version + backfill metadata; rem + children preserved). */
  toMatch: MatchEntry[];
  /** Items whose user-owned tags will be written back to Zotero. */
  toPushTags: PushEntry[];
  toDelete: DeleteEntry[];
}

/** Callbacks for reporting per-item progress to the UI. */
export interface ApplyCallbacks {
  /** Fired after each change finishes, with its stable id and whether it succeeded. */
  onItemDone?: (id: string, ok: boolean) => void;
}

/**
 * Apply the selected changes: delete the stale documents, then create the new ones
 * (tagging each with the Zotero Item powerup that stores its key/type/version).
 * Every doc this writes (create/update/match/push) also gets its `lastSyncedAt` slot stamped
 * (one timestamp per run) so the on-page menu's "Sync (date)" label reflects global syncs too.
 * Invokes `onItemDone` after every individual change. Returns the counts.
 */
export async function applySyncPlan(
  plugin: RNPlugin,
  selection: ApplySelection,
  ctx: SyncContext,
  callbacks: ApplyCallbacks = {},
  log?: SyncLog
): Promise<{ created: number; updated: number; matched: number; pushed: number; deleted: number }> {
  const onItemDone = callbacks.onItemDone ?? (() => {});

  // PRECONDITION: the Zotero Item powerup MUST be registered before we mutate ANYTHING. If it isn't
  // (plugin not finished activating, or not reloaded after an update), then computeSyncPlan also
  // mis-read every doc as keyless — `storedKey` swallows the read error and returns '' — so the
  // plan's deletions/adoptions are bogus. The create/adopt phases used to throw on a missing powerup,
  // but ONLY after the delete/update/push loops had already committed irreversibly (net data loss
  // with nothing recreated). Check up front so a missing powerup aborts with zero changes made.
  const powerup = await plugin.powerup.getPowerupByCode(ZOTERO_ITEM_POWERUP);
  if (!powerup) {
    const msg =
      'Zotero Item powerup is not registered — reload the plugin (toggle it off/on in Settings → ' +
      'Plugins → Build) and try again. No changes were made.';
    log?.log('apply', `ERROR (precondition): ${msg}`);
    // The caller (handleApply) surfaces apply errors via a toast, so don't double-toast here.
    throw new Error(msg);
  }

  // One timestamp for this whole run, written to the lastSyncedAt slot of every doc this Apply
  // writes (create/update/match/push) — so the on-page menu's "Sync (date)" label reflects a global
  // sync too, not just the per-item Sync button. (Already-in-sync docs aren't in the selection, so
  // their label keeps the date of their last actual write — which is the meaningful "last synced".)
  const syncedAt = Date.now();
  const stampSynced = (rem: PluginRem): Promise<void> =>
    rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.lastSyncedAt, [String(syncedAt)]);

  log?.section('Apply changes');
  log?.log(
    'apply',
    `Applying selection → ${selection.toDelete.length} deletion(s), ${selection.toUpdate.length} update(s), ${selection.toMatch.length} adoption(s), ${selection.toPushTags.length} tag push(es), ${selection.toCreate.length} creation(s).`
  );

  // Status tag-back counters for the finish log. The actual logic (additive In-Progress tag-back,
  // version bump, non-fatal on failure) + the abstract append now live in the module-level
  // writeStatusTagBack / appendAbstractRem helpers, shared with the on-page Add-related flow.
  let statusTagged = 0;
  let statusTagFailed = 0;
  const countStatusTag = (outcome: 'tagged' | 'skipped' | 'failed'): void => {
    if (outcome === 'tagged') statusTagged += 1;
    else if (outcome === 'failed') statusTagFailed += 1;
  };

  let deleted = 0;
  let deleteFailed = 0;
  let delListed = 0;
  for (const entry of selection.toDelete) {
    let ok = true;
    try {
      await entry.rem.remove();
      deleted += 1;
      if (delListed < LOG_LIST_CAP) {
        log?.log('apply', `  deleted "${entry.name || '(untitled)'}" (${entry.reason}).`);
        delListed += 1;
      }
    } catch (err) {
      ok = false;
      deleteFailed += 1;
      log?.log('apply', `  DELETE FAILED "${entry.name || '(untitled)'}": ${errMsg(err)}`);
    }
    onItemDone(entry.id, ok);
  }
  if (deleted > LOG_LIST_CAP)
    log?.log('apply', `  … (${deleted - LOG_LIST_CAP} more successful deletions not individually listed)`);

  let updated = 0;
  let updateFailed = 0;
  for (const sel of selection.toUpdate) {
    let ok = true;
    try {
      const meta = extractMetadata(sel.entry.item, ctx.meta);
      await writeItemSlots(plugin, ctx, sel.entry.rem, meta, { fields: sel.fields }, log);
      // `name` isn't a powerup slot — reconcile the doc title to the REAL Zotero citekey via setText.
      // (computeSyncPlan only stages a `name` change when a real citationKey exists, so it's present.)
      if (sel.fields.has('name')) {
        const realKey = sel.entry.item.data.citationKey?.trim();
        if (realKey) await sel.entry.rem.setText([realKey]);
      }
      // Only advance the stored version if every changed field was applied; otherwise leave
      // it so the un-applied fields resurface on the next sync.
      const allApplied = sel.entry.changes.every((c) => sel.fields.has(c.field));
      if (allApplied) {
        await sel.entry.rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version, [
          String(sel.entry.item.version),
        ]);
      }
      await stampSynced(sel.entry.rem);
      updated += 1;
      log?.log(
        'apply',
        `  updated "${sel.entry.name}" — ${[...sel.fields].join(', ')}${allApplied ? '' : ' (partial; version kept)'}.`
      );
    } catch (err) {
      ok = false;
      updateFailed += 1;
      log?.log('apply', `  UPDATE FAILED "${sel.entry.name}": ${errMsg(err)}`);
    }
    onItemDone(sel.entry.id, ok);
  }

  // Push phase runs after pull-updates so an item's stored version ends on the post-push value.
  let pushed = 0;
  let pushFailed = 0;
  for (const entry of selection.toPushTags) {
    let ok = true;
    try {
      const newVersion = await pushItemTags(plugin, entry.itemKey, entry.itemVersion, entry.tags, log);
      await entry.rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version, [String(newVersion)]);
      await stampSynced(entry.rem);
      pushed += 1;
      log?.log('apply', `  pushed tags for "${entry.name}" → [${entry.tags.join(', ')}].`);
    } catch (err) {
      ok = false;
      pushFailed += 1;
      log?.log('apply', `  PUSH FAILED "${entry.name}" (key ${entry.itemKey}): ${errMsg(err)}`);
    }
    onItemDone(entry.id, ok);
  }

  // Adopt phase: stamp identity onto citekey-matched keyless docs and backfill their metadata.
  // The rem (and its children / inbound references) is preserved — that's the whole point.
  let matched = 0;
  let matchFailed = 0;
  if (selection.toMatch.length > 0) {
    // `powerup` is verified non-null by the precondition at the top of applySyncPlan.
    for (const entry of selection.toMatch) {
      let ok = true;
      try {
        await entry.rem.addTag(powerup._id);
        await entry.rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.key, [entry.item.key]);
        await entry.rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version, [
          String(entry.item.version),
        ]);
        await entry.rem.setIsDocument(true);
        const meta = extractMetadata(entry.item, ctx.meta);
        await writeItemSlots(plugin, ctx, entry.rem, meta, { setStatusOnCreate: true }, log);
        await appendAbstractRem(plugin, entry.rem, meta.abstract);
        countStatusTag(await writeStatusTagBack(plugin, entry.rem, entry.item, log));
        await stampSynced(entry.rem);
        matched += 1;
        log?.log('apply', `  adopted "${entry.name}" — stamped key ${entry.item.key} + metadata.`);
      } catch (err) {
        ok = false;
        matchFailed += 1;
        log?.log('apply', `  ADOPT FAILED "${entry.name}" (key ${entry.item.key}): ${errMsg(err)}`);
      }
      onItemDone(entry.id, ok);
    }
  }

  let created = 0;
  let createFailed = 0;
  if (selection.toCreate.length > 0) {
    const parent = await ensureItemsParent(plugin);
    log?.log('apply', `"Zotero / Items" parent ready (id=${parent._id}).`);
    // `powerup` is verified non-null by the precondition at the top of applySyncPlan.

    // Successful creations are summarized (not logged per-item) to keep large runs readable;
    // every failure is logged individually.
    for (const entry of selection.toCreate) {
      let ok = true;
      try {
        // entry.name === displayName(entry.item) and entry.key === entry.item.key (computeSyncPlan),
        // so the shared createItemDoc reproduces the previous inline create exactly.
        const { statusTag } = await createItemDoc(plugin, ctx, entry.item, parent, powerup, syncedAt, log);
        countStatusTag(statusTag);
        created += 1;
      } catch (err) {
        ok = false;
        createFailed += 1;
        log?.log('apply', `  CREATE FAILED "${entry.name}" (key ${entry.key}): ${errMsg(err)}`);
      }
      onItemDone(entry.id, ok);
    }
  }

  // Record the sync time so the next run can detect Remnote-side edits (Status/Rating/Tags)
  // made after this point and push them to Zotero. Stamped even on partial failure: this run
  // did write to the libraries, and re-detection of any failed item would need a fresh edit.
  await plugin.storage.setSynced(STORAGE.lastSync, Date.now());
  log?.log('apply', 'Stamped last-sync time (gates Remnote → Zotero push on the next run).');

  log?.log(
    'apply',
    `Finished. Created ${created} (${createFailed} failed), updated ${updated} (${updateFailed} failed), matched ${matched} (${matchFailed} failed), pushed ${pushed} (${pushFailed} failed), deleted ${deleted} (${deleteFailed} failed), status tag-backs ${statusTagged} (${statusTagFailed} failed).`
  );
  return { created, updated, matched, pushed, deleted };
}

// ───────────────────────── Single-item sync (on-page menu) ─────────────────────────

/** Outcome of a one-item Sync (the on-page menu's Sync button). */
export interface SingleSyncResult {
  /** 'synced' = ran OK; 'missing-key' = no key stored; 'not-found' = HTTP 404 (gone from Zotero). */
  status: 'synced' | 'missing-key' | 'not-found';
  /** The doc's (post-sync) display name, for the toast. */
  name: string;
  /** Names of the metadata fields rewritten from Zotero this run (incl. a 'name' reconcile). */
  pulled: string[];
  /** Tags written back to Zotero (replace-exactly), or null when they already matched. */
  pushed: string[] | null;
  /** Human-readable summary suitable for a toast. */
  message: string;
}

/**
 * Sync a SINGLE item doc, bidirectionally, by its stored Zotero key — the on-page menu's Sync
 * button. PULL: re-fetch the item and rewrite every changed metadata slot, plus reconcile the doc
 * name to the citekey. PUSH: write the user-owned Status/Rating/Tags back to Zotero as the item's
 * EXACT tag set (replace-exactly — Remnote is the source of truth for tags, the same rule the main
 * push uses; any Zotero-side tags not represented in Remnote are dropped). Stamps the post-sync
 * version + a per-doc `lastSyncedAt` timestamp.
 *
 * Returns 'missing-key' (no key stored) or 'not-found' (HTTP 404 — deleted from Zotero) WITHOUT
 * throwing; THROWS on credential / network / 412-version-conflict errors so the caller can toast.
 * Does NOT touch the global STORAGE.lastSync baseline (that gates the library-wide push) or the
 * doc body / abstract.
 *
 * TODO (notes): a later feature will also push this item's Remnote notes → Zotero from here.
 */
export async function syncSingleItem(
  plugin: RNPlugin,
  rem: PluginRem,
  ctx: SyncContext,
  log?: SyncLog
): Promise<SingleSyncResult> {
  log?.section('Sync single item');
  const name = await remName(plugin, rem);
  const key = await storedKey(rem);
  if (!key) {
    log?.log('apply', `"${name}": no Zotero key stored — cannot sync.`);
    return {
      status: 'missing-key',
      name,
      pulled: [],
      pushed: null,
      message: `"${name || 'This item'}" has no Zotero key — can't sync it.`,
    };
  }

  const item = await fetchItemByKey(plugin, key, log);
  if (!item) {
    return {
      status: 'not-found',
      name,
      pulled: [],
      pushed: null,
      message: `"${name}" (key ${key}) wasn't found in Zotero — it may have been deleted.`,
    };
  }

  // PULL: rewrite changed metadata slots, then reconcile the doc name to the Zotero citekey.
  const meta = extractMetadata(item, ctx.meta);
  const changes = await diffItem(plugin, ctx, rem, meta);
  const pulledFields = new Set<UpdatableField>(changes.map((c) => c.field));
  if (pulledFields.size > 0) await writeItemSlots(plugin, ctx, rem, meta, { fields: pulledFields }, log);
  // Reconcile the doc name to the REAL Zotero/BBT citation key only (same rule as the global sync —
  // a generated citekey names new docs but must never rename an existing title-named doc).
  const realKey = item.data.citationKey?.trim();
  const nameChanged = !!realKey && nameKey(name) !== nameKey(realKey);
  if (nameChanged) await rem.setText([realKey!]);
  const wantName = nameChanged ? realKey! : name;
  const pulled = [...pulledFields].map(String).concat(nameChanged ? ['name'] : []);

  // PUSH: user-owned tags → Zotero (replace-exactly), only when they differ from the live set.
  // Normalize BOTH sides identically (trim + drop-empties + sort via asSortedSet, dedup the Zotero
  // side via Set) — exactly the library push gate's comparison — so a stray empty/duplicate Zotero
  // tag doesn't trigger a needless replace-exactly PATCH. `desiredTags` is already clean.
  const desiredTags = await computePushTags(plugin, ctx, rem);
  const currentTags = [...new Set((item.data.tags ?? []).map((t) => t.tag))];
  let pushed: string[] | null = null;
  let version = item.version;
  if (asSortedSet(desiredTags.join('\n')) !== asSortedSet(currentTags.join('\n'))) {
    version = await pushItemTags(plugin, key, item.version, desiredTags, log);
    pushed = desiredTags;
  }

  // Stamp the post-sync version (so the next library sync won't re-diff) + this doc's last-sync
  // time (per-doc slot → powers the menu's "Sync · <date>"; no central map to bloat).
  await rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.version, [String(version)]);
  await rem.setPowerupProperty(ZOTERO_ITEM_POWERUP, SLOTS.lastSyncedAt, [String(Date.now())]);

  const parts: string[] = [];
  if (pulled.length) parts.push(`refreshed ${pulled.join(', ')}`);
  if (pushed) parts.push(`pushed ${pushed.length} tag${pushed.length === 1 ? '' : 's'} to Zotero`);
  const message = parts.length
    ? `Synced "${wantName}" — ${parts.join(', ')}.`
    : `"${wantName}" is already up to date.`;
  log?.log('apply', message);
  return { status: 'synced', name: wantName, pulled, pushed, message };
}

// ───────────────────────── Add a related paper to Zotero + Remnote ─────────────────────────

/** Options for adding a related paper. */
export interface AddRelatedOpts {
  /** Zotero collection keys to file the new item under (e.g. the current item's collections). */
  collectionKeys?: string[];
}

/** Outcome of adding one related paper. */
export interface AddRelatedResult {
  ok: boolean;
  /** The new Remnote doc's rem id (when ok). */
  remId?: string;
  /** The new Zotero item key (set even if the Remnote-doc step then failed). */
  key?: string;
  /** Human-readable summary suitable for a toast. */
  message: string;
}

/**
 * Add a single related paper (a reference/citation row) to BOTH Zotero and Remnote, by its DOI:
 *   0) DEDUP: if the DOI is already in the Zotero library, reuse that item (don't POST a duplicate)
 *      — the widget's local in-library gate misses items on a partially-loaded KB.
 *   1) Else Citoid (Wikipedia) resolves the DOI → a ready Zotero item.
 *   2) POST it to the user's Zotero library (filed into `opts.collectionKeys` if given).
 *   3) Re-fetch the (created or existing) item and run the SAME create path the bulk sync uses
 *      (`createItemDoc`) to make the `Zotero/Items` doc.
 *
 * Requires a DOI (Citoid is DOI-keyed). Returns `{ok:false, message}` for every failure WITHOUT
 * throwing (no DOI, Citoid 404, Zotero create failure, read-back miss, powerup not registered), so
 * the UI can toast a single clear message. Does NOT touch the global push baseline.
 *
 * Note: when it reuses an existing Zotero item whose RemNote doc just wasn't loaded locally, this
 * may create a second doc for that key; the bulk sync's duplicate-key guard then keeps the oldest —
 * an acceptable, self-healing transient, far better than a duplicate ZOTERO item.
 */
export async function addRelatedItem(
  plugin: RNPlugin,
  paper: { doi?: string; title?: string },
  ctx: SyncContext,
  opts: AddRelatedOpts = {},
  log?: SyncLog
): Promise<AddRelatedResult> {
  log?.section('Add related item');
  const title = paper.title || 'This paper';
  if (!paper.doi?.trim()) return { ok: false, message: `"${title}" has no DOI — can't add it automatically.` };

  // 0) Authoritative dedup: reuse an existing Zotero item with this DOI rather than POST a duplicate.
  let item: ZoteroItem | null = await findZoteroItemByDoi(plugin, paper.doi, log);
  const adopted = !!item;

  if (!item) {
    // 1 + 2) Citoid → Zotero create.
    let key: string;
    try {
      const data = await fetchCitoidItem(paper.doi, log);
      if (opts.collectionKeys?.length) data.collections = opts.collectionKeys;
      const [r] = await createZoteroItems(plugin, [data], log);
      if (!r?.ok || !r.key) {
        return { ok: false, message: `Couldn't add "${title}" to Zotero: ${r?.error ?? 'no key returned'}.` };
      }
      key = r.key;
    } catch (err) {
      const e = err as Error & { notFound?: boolean };
      return {
        ok: false,
        message: e.notFound
          ? `Couldn't find metadata for DOI ${paper.doi} (Citoid) — "${title}" not added.`
          : `Couldn't add "${title}" to Zotero: ${errMsg(err)}`,
      };
    }

    // 3) Re-fetch the created item in full (version, parsedDate, tags) — fetchItemByKey is
    //    eventually-consistent, so one short retry covers Zotero's replication lag.
    item = await fetchItemByKey(plugin, key, log);
    if (!item) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      item = await fetchItemByKey(plugin, key, log);
    }
    if (!item) {
      return {
        ok: false,
        key,
        message: `Added "${title}" to Zotero (key ${key}), but couldn't read it back to build the Remnote doc — it'll appear on the next full sync.`,
      };
    }
  }

  // If the item ALREADY existed in Zotero (adopted) and we have target collection(s) — from the
  // chevron picker or the host item — file it into them server-side (ADDITIVE union; never removes
  // its existing collections), then re-fetch so the doc's Collection(s) slot reflects the add.
  // Otherwise the picked collection would be a silent no-op for adopted items. Non-fatal on failure.
  if (adopted && opts.collectionKeys?.length) {
    const have = new Set(item.data.collections ?? []);
    const missing = opts.collectionKeys.filter((c) => !have.has(c));
    if (missing.length) {
      try {
        await pushItemCollections(plugin, item.key, item.version, [...have, ...missing], log);
        const refreshed = await fetchItemByKey(plugin, item.key, log);
        if (refreshed) item = refreshed;
      } catch (err) {
        log?.log('apply', `Couldn't file existing item ${item.key} into the picked collection(s): ${errMsg(err)}`);
      }
    }
  }

  // Build the Remnote doc from the created-or-existing item (shared tail).
  const parent = await ensureItemsParent(plugin);
  const powerup = await plugin.powerup.getPowerupByCode(ZOTERO_ITEM_POWERUP);
  if (!powerup) {
    return { ok: false, key: item.key, message: 'Added to Zotero, but the Zotero Item powerup is not registered — reload the plugin.' };
  }
  try {
    const { rem } = await createItemDoc(plugin, ctx, item, parent, powerup, Date.now(), log);
    return {
      ok: true,
      remId: rem._id,
      key: item.key,
      message: adopted
        ? `"${displayName(item)}" is already in Zotero — linked it into Remnote.`
        : `Added "${displayName(item)}" to Zotero and Remnote.`,
    };
  } catch (err) {
    return {
      ok: false,
      key: item.key,
      message: adopted
        ? `"${title}" is already in Zotero; the Remnote doc failed: ${errMsg(err)}`
        : `Added "${title}" to Zotero (key ${item.key}); the Remnote doc failed: ${errMsg(err)}`,
    };
  }
}
