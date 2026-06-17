/** Minimal Zotero Web API client built on the browser `fetch` API.
 *
 * We hit the public REST API directly. Zotero responds with
 * `Access-Control-Allow-Origin: *`, so no client library or CORS proxy is needed
 * (unlike the heavier reference connector which depends on `zotero-api-client`).
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import { SETTINGS } from './consts';
import type { SyncLog } from './log';
import { normalizeDoi } from './semantic';

/** A Zotero creator (author/editor/translator/…). People have first/last; institutions have `name`. */
export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

/** A top-level Zotero item with the fields we read for metadata. */
export interface ZoteroItem {
  key: string;
  version: number;
  data: {
    itemType: string;
    title?: string;
    shortTitle?: string;
    /** Native Zotero / Better BibTeX citation key, when present. */
    citationKey?: string;
    creators?: ZoteroCreator[];
    publicationTitle?: string;
    publisher?: string;
    /** Container-title fields for non-journal item types (used as the "Publication" fallback). */
    bookTitle?: string;
    proceedingsTitle?: string;
    conferenceName?: string;
    university?: string;
    institution?: string;
    repository?: string;
    websiteTitle?: string;
    blogTitle?: string;
    encyclopediaTitle?: string;
    dictionaryTitle?: string;
    date?: string;
    url?: string;
    DOI?: string;
    /** Free-text "extra" field; books/reports/theses/preprints often put `DOI: 10.x` here. */
    extra?: string;
    abstractNote?: string;
    /** Keys of the collections this item is DIRECTLY in. */
    collections?: string[];
    tags?: { tag: string }[];
    /** Set to 1 while the item is in the Zotero trash — the single-item GET still returns it
     *  (HTTP 200) until it's purged, unlike `/items/top` which excludes trashed items. */
    deleted?: number;
  };
  meta?: {
    /** ISO-ish date string Zotero parsed from `data.date`; '' if unparseable. */
    parsedDate?: string;
    creatorSummary?: string;
  };
}

/** A Zotero collection, normalized (parentCollection:false → null). */
export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey: string | null;
}

const ZOTERO_API_BASE = 'https://api.zotero.org';
const PAGE_LIMIT = 100;

/**
 * Build an Error that's ALREADY been surfaced to the user via `plugin.app.toast`. Callers that
 * wrap these in their own try/catch (e.g. the on-page menu's Sync handler) can check `.toasted`
 * to avoid showing a second, duplicate toast. The main sync ignores the flag (no behavior change).
 */
function toastedError(msg: string): Error {
  const e = new Error(msg) as Error & { toasted?: boolean };
  e.toasted = true;
  return e;
}

/**
 * Name used for the item's Remnote document. Prefers the REAL citation key when Zotero exposes one
 * (`data.citationKey` — Better BibTeX / native), so the doc tracks BBT (and a global sync renames the
 * doc when BBT or the user later changes it). When there's no real citekey yet (e.g. a Citoid-created
 * item just added via the menu) it falls back to a GENERATED BBT-style key, then the title, then the
 * Zotero key.
 */
export function displayName(item: ZoteroItem): string {
  const data = item.data ?? ({} as ZoteroItem['data']);
  return data.citationKey || generateCitekey(item) || data.title || data.shortTitle || item.key;
}

/** Better BibTeX's DEFAULT `skipWords` list (verbatim from its `preferences.yaml`), the words dropped
 *  from a title when building a short title. Faithful to BBT so generated keys match the user's
 *  (default-config) ones \u2014 note it includes short function words like `ab`, `is`, `al`, `et`, `von`. */
const CITEKEY_SKIP_WORDS = new Set(
  ('a,ab,aboard,about,above,across,after,against,al,along,amid,among,an,and,anti,around,as,at,before,' +
    'behind,below,beneath,beside,besides,between,beyond,but,by,d,da,das,de,del,dell,dello,dei,degli,' +
    'della,dell,delle,dem,den,der,des,despite,die,do,down,du,during,ein,eine,einem,einen,einer,eines,' +
    'el,en,et,except,for,from,gli,i,il,in,inside,into,is,l,la,las,le,les,like,lo,los,near,nor,of,off,' +
    'on,onto,or,over,past,per,plus,round,save,since,so,some,sur,than,the,through,to,toward,towards,un,' +
    'una,unas,under,underneath,une,unlike,uno,unos,until,up,upon,versus,via,von,while,with,within,' +
    'without,yet,zu,zum').split(',')
);

/** Better BibTeX's `citekeyUnsafeChars` (default `\"#%'(),={}~`) plus whitespace and the unknown-char
 *  marker U+FFFD \u2014 removed from the assembled key. Hyphens, `$`, `+`, `.` are NOT unsafe and survive. */
const CITEKEY_UNSAFE = /[\\"#%'(),={}~\s\ufffd]/g;

/** Unicode punctuation BBT's `nopunct` strips from a title word (open/close/initial/final/other
 *  punctuation). `:` and `/` are handled separately (replaced by spaces) before this runs. */
const CITEKEY_PUNCT = /[\p{Pe}\p{Pf}\p{Pi}\p{Po}\p{Ps}]/gu;
/** Dash characters BBT's `nopunct` collapses (here to '', so `Alkali-Ion` -> `AlkaliIon`). */
const CITEKEY_DASH = /[\p{Pd}\u2500\uff0d\u2015]/gu;

/** Fold a string to ASCII the way BBT's `citekeyFold` (default ON) does: transliterate the special
 *  Latin letters, normalize the Unicode hyphens BBT's fold maps to ASCII `-` (so `Guan\u2010ewang` keeps
 *  one hyphen), then NFKD-decompose and drop combining diacritics (\u00e9->e, \u00f1->n, \u00fc->u, ...). */
function foldAscii(s: string): string {
  return transliterateLatin(s).replace(/[\u2010\u2011]/g, '-').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Transliterate the non-decomposable Latin letters that NFKD leaves intact (so they aren't dropped
 *  by the ASCII strip), matching Better BibTeX's defaults: \u00df\u2192ss, \u00f8\u2192o, \u0142\u2192l, \u0111\u2192d, \u00fe\u2192th, \u00e6\u2192ae, \u0153\u2192oe. */
function transliterateLatin(s: string): string {
  return s
    .replace(/\u00df/g, 'ss')
    .replace(/\u00f8/g, 'o')
    .replace(/\u00d8/g, 'O')
    .replace(/\u0142/g, 'l')
    .replace(/\u0141/g, 'L')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .replace(/\u00fe/g, 'th')
    .replace(/\u00de/g, 'Th')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u00c6/g, 'Ae')
    .replace(/\u0153/g, 'oe')
    .replace(/\u0152/g, 'Oe');
}

/** BBT `nopunct(word, '')`: drop dashes then Unicode punctuation, leaving letters/digits and the
 *  symbols BBT keeps (`$`, `+`, ...). */
function nopunct(word: string): string {
  return word.replace(CITEKEY_DASH, '').replace(CITEKEY_PUNCT, '');
}

/** BBT's `titleWords`: the significant words of the title, in order. BBT delegates tokenization to the
 *  `compromise` NLP lib (`nlp(title).json()`); since it isn't vendored, its observable boundary rules
 *  are encoded as the pre-split `replace`s below. Each resulting word is then nopunct'd + ASCII-folded,
 *  and skip-words / single non-digit letters are dropped. */
function titleWords(title: string): string[] {
  return title
    // BBT strips ALL HTML from the title upstream (Li<sub>2</sub>O -> Li2O).
    .replace(/<[^>]+>/g, '')
    // compromise strips the possessive `'s` (Zemansky's -> Zemansky).
    .replace(/['’]s\b/g, '')
    // A parenthetical containing a comma is a list (Cu(In,Ga)Se2) -> compromise splits it into its
    // members; a comma-less one (Cu(InGa)Se) stays joined. Drop only the list parens (commas split next).
    .replace(/\(([^()]*,[^()]*)\)/g, ' $1 ')
    // Word boundaries in compromise's tokenizer: `/` and `:` (the only two BBT spells out), commas, and
    // the U+2212 chemistry MINUS (La1−x, Semiconductor−Liquid).
    .replace(/[/:,−]/g, ' ')
    // Only the ASCII hyphen `-` contracts a compound into one word (Alkali-Ion -> AlkaliIon); en/em/other
    // dashes are word SEPARATORS (Grimm–Sommerfeld -> Grimm + Sommerfeld, Mn–Ge–N -> Mn + Ge).
    .replace(/[\p{Pd}─－―]/gu, (m) => (m === '-' ? '-' : ' '))
    .split(/\s+/)
    .map((w) => foldAscii(nopunct(w)))
    .filter(
      (w) =>
        w.length > 0 &&
        !([...w].length === 1 && !/^\d+$/.test(w)) &&
        !CITEKEY_SKIP_WORDS.has(w.toLowerCase())
    );
}

/** BBT's `$shorttitle(n, n)`: the first `n` significant title words, each with its first letter
 *  capitalized (internal capitals preserved), concatenated. */
function shortTitle(words: string[], n = 3): string {
  return words
    .slice(0, n)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Generate a Better-BibTeX-style citation key in BBT's classic DEFAULT format
 * `auth.lower + shorttitle(3,3) + year`, faithfully reimplemented from BBT's `formatter.ts`:
 *   - auth.lower = first author's (else editor/translator/collaborator) last name, ASCII-folded +
 *     lowercased, hyphens kept (`burgos-caminal`), spaces/unsafe chars dropped (`van der Ven` ->
 *     `vanderven`);
 *   - shorttitle(3,3) = the first 3 significant title words — HTML stripped, `/` and `:` -> spaces,
 *     skip-words dropped, single non-digit letters dropped, punctuation/dashes removed, ASCII-folded
 *     — each with its first letter capitalized (internal capitals preserved), concatenated;
 *   - year = the 4-digit publication year.
 * Best-effort: the REAL `data.citationKey` always wins in `displayName`, and a global sync renames
 * the doc to it when BBT (or the user) assigns/changes/pins the key. It cannot reproduce library-wide
 * collision suffixes (`...a`/`...b`) or pinned keys. Returns '' if it can't build at least a letter.
 */
export function generateCitekey(item: ZoteroItem): string {
  const data = item.data ?? ({} as ZoteroItem['data']);
  // auth.lower: BBT's `*` creator precedence is author -> editor -> translator -> collaborator; take
  // the FIRST creator of the first non-empty kind.
  const creators = data.creators ?? [];
  const first =
    creators.find((c) => c.creatorType === 'author') ??
    creators.find((c) => c.creatorType === 'editor') ??
    creators.find((c) => c.creatorType === 'translator') ??
    creators[0];
  // Author name is folded + lowercased but NOT punctuation-stripped (only the final unsafe-char pass
  // touches it) — so `Burgos-Caminal` keeps its hyphen and `O'Brien` loses only the apostrophe.
  const auth = first ? foldAscii(first.lastName || first.name || '').toLowerCase() : '';

  // shorttitle(3,3): first 3 significant title words, each first-letter-capitalized (tokenization +
  // skip-word/single-char filtering live in titleWords; capitalization+join in shortTitle).
  const shorttitle = shortTitle(titleWords(data.title || data.shortTitle || ''));

  // Require at least one LETTER — else a numeric/symbol-only title (datasets, standards) would yield
  // a digit-soup key; returning '' lets displayName fall back to the readable title.
  if (!/[A-Za-z]/.test(auth + shorttitle)) return '';
  const year = parseYear(item.meta?.parsedDate) || (data.date?.match(/\d{4}/)?.[0] ?? '');
  // BBT removes its unsafe chars + whitespace from the assembled key (so `van der ven` -> `vanderven`).
  return `${auth}${shorttitle}${year}`.replace(CITEKEY_UNSAFE, '');
}

/** Reports fetch progress to the UI: items kept so far + the library total (0 if unknown). */
export type FetchProgressFn = (fetched: number, total: number) => void;

/**
 * Fetch every top-level item from the user's personal Zotero library.
 * Uses the `/items/top` endpoint (excludes child notes/attachments) and paginates
 * 100 items at a time. Throws (after a toast) if credentials are missing or a request fails.
 * Calls `onProgress` after each page (total comes from the `Total-Results` header).
 */
export async function fetchTopItems(
  plugin: RNPlugin,
  log?: SyncLog,
  onProgress?: FetchProgressFn
): Promise<ZoteroItem[]> {
  const userId = (await plugin.settings.getSetting<string>(SETTINGS.userId))?.trim();
  const apiKey = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();

  log?.section('Connect to Zotero');
  log?.log('fetch', `User ID setting: ${userId ? userId : '(missing)'}`);
  // Never log the key itself — only whether it's set and how long it is.
  log?.log('fetch', `API Key setting: ${apiKey ? `present (${apiKey.length} chars)` : '(missing)'}`);

  if (!userId || !apiKey) {
    const msg = 'Set your Zotero User ID and API Key in the plugin settings first.';
    log?.log('fetch', `ERROR: ${msg}`);
    await plugin.app.toast(msg);
    throw toastedError(msg);
  }

  const headers = { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': '3' };
  const items: ZoteroItem[] = [];
  let start = 0;
  let pageNum = 0;
  let dropped = 0;

  log?.log(
    'fetch',
    `Endpoint: GET ${ZOTERO_API_BASE}/users/${userId}/items/top (personal library, paginating ${PAGE_LIMIT}/page).`
  );

  while (true) {
    const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(
      userId
    )}/items/top?limit=${PAGE_LIMIT}&start=${start}`;

    pageNum += 1;
    log?.log('fetch', `Requesting page ${pageNum} (start=${start})…`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const msg = `Zotero API request failed: HTTP ${res.status} ${res.statusText}`;
      log?.log('fetch', `ERROR on page ${pageNum}: ${msg}`);
      await plugin.app.toast(msg);
      throw toastedError(msg);
    }

    const totalResults = res.headers.get('Total-Results');
    const page = (await res.json()) as ZoteroItem[];
    let keptInPage = 0;
    for (const item of page) {
      const type = item.data?.itemType;
      // `/top` already excludes these, but guard defensively.
      if (type === 'attachment' || type === 'note') {
        dropped += 1;
        continue;
      }
      items.push(item);
      keptInPage += 1;
    }
    log?.log(
      'fetch',
      `Page ${pageNum}: HTTP ${res.status}, ${page.length} returned, ${keptInPage} kept` +
        (totalResults ? ` (library reports Total-Results=${totalResults}).` : '.')
    );
    onProgress?.(items.length, Number(totalResults) || 0);

    if (page.length < PAGE_LIMIT) break;
    start += PAGE_LIMIT;
  }

  const byType = new Map<string, number>();
  for (const it of items) {
    const t = it.data?.itemType ?? '(unknown)';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  const typeSummary = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}=${n}`)
    .join(', ');
  log?.log(
    'fetch',
    `Fetched ${items.length} top-level item(s) across ${pageNum} page(s); ${dropped} attachment/note dropped.`
  );
  if (typeSummary) log?.log('fetch', `By item type: ${typeSummary}.`);

  return items;
}

/**
 * Fetch ONE top-level item by its Zotero key (for the on-page menu's per-item Sync).
 * Returns null on HTTP 404 (the item was deleted from Zotero); throws (after a toast) on
 * missing credentials or any other non-OK status. The single-item endpoint returns the item
 * object directly (same shape as a page element), including its current `version` + `tags`.
 */
export async function fetchItemByKey(
  plugin: RNPlugin,
  itemKey: string,
  log?: SyncLog
): Promise<ZoteroItem | null> {
  const { userId, headers } = await readZoteroCreds(plugin, log);
  const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(
    itemKey
  )}`;
  log?.log('fetch', `Endpoint: GET ${url} (single item).`);
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    log?.log('fetch', `Item ${itemKey} not found in Zotero (HTTP 404).`);
    return null;
  }
  if (!res.ok) {
    const msg = `Zotero item fetch failed for ${itemKey}: HTTP ${res.status} ${res.statusText}`;
    log?.log('fetch', `ERROR: ${msg}`);
    await plugin.app.toast(msg);
    throw toastedError(msg);
  }
  const item = (await res.json()) as ZoteroItem;
  // A trashed-but-not-purged item still returns HTTP 200 here (with data.deleted=1), but the main
  // sync's /items/top excludes it. Treat it as not-found so we neither pull it nor push tags back
  // to a trashed item — matching the documented "removed from Zotero" behavior.
  if (item.data?.deleted) {
    log?.log('fetch', `Item ${itemKey} is in the Zotero trash (data.deleted=${item.data.deleted}) — treating as not-found.`);
    return null;
  }
  return item;
}

/** Read + validate Zotero credentials, returning the auth headers. Throws (after a toast) if missing. */
export async function readZoteroCreds(
  plugin: RNPlugin,
  log?: SyncLog
): Promise<{ userId: string; headers: Record<string, string> }> {
  const userId = (await plugin.settings.getSetting<string>(SETTINGS.userId))?.trim();
  const apiKey = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();
  if (!userId || !apiKey) {
    const msg = 'Set your Zotero User ID and API Key in the plugin settings first.';
    log?.log('fetch', `ERROR: ${msg}`);
    await plugin.app.toast(msg);
    throw toastedError(msg);
  }
  return { userId, headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': '3' } };
}

/** Fetch every collection in the personal library, normalized for tree-building. */
export async function fetchCollections(plugin: RNPlugin, log?: SyncLog): Promise<ZoteroCollection[]> {
  const { userId, headers } = await readZoteroCreds(plugin, log);
  const out: ZoteroCollection[] = [];
  let start = 0;
  let pageNum = 0;
  log?.log(
    'fetch',
    `Endpoint: GET ${ZOTERO_API_BASE}/users/${userId}/collections (paginating ${PAGE_LIMIT}/page).`
  );
  while (true) {
    const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(
      userId
    )}/collections?limit=${PAGE_LIMIT}&start=${start}`;
    pageNum += 1;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const msg = `Zotero collections request failed: HTTP ${res.status} ${res.statusText}`;
      log?.log('fetch', `ERROR on collections page ${pageNum}: ${msg}`);
      await plugin.app.toast(msg);
      throw toastedError(msg);
    }
    const page = (await res.json()) as {
      key: string;
      data?: { name?: string; parentCollection?: string | false };
    }[];
    for (const c of page) {
      out.push({
        key: c.key,
        name: (c.data?.name ?? '').trim() || '(unnamed collection)',
        parentKey: c.data?.parentCollection || null,
      });
    }
    log?.log('fetch', `Collections page ${pageNum}: ${page.length} returned (total so far ${out.length}).`);
    if (page.length < PAGE_LIMIT) break;
    start += PAGE_LIMIT;
  }
  log?.log('fetch', `Fetched ${out.length} collection(s).`);
  return out;
}

/** Built-in fallback item-type → English label map (used if /itemTypes can't be fetched). */
const FALLBACK_TYPE_LABELS: Record<string, string> = {
  artwork: 'Artwork', audioRecording: 'Audio Recording', bill: 'Bill', blogPost: 'Blog Post',
  book: 'Book', bookSection: 'Book Section', case: 'Case', computerProgram: 'Software',
  conferencePaper: 'Conference Paper', dictionaryEntry: 'Dictionary Entry', document: 'Document',
  email: 'E-mail', encyclopediaArticle: 'Encyclopedia Article', film: 'Film', forumPost: 'Forum Post',
  hearing: 'Hearing', instantMessage: 'Instant Message', interview: 'Interview',
  journalArticle: 'Journal Article', letter: 'Letter', magazineArticle: 'Magazine Article',
  manuscript: 'Manuscript', map: 'Map', newspaperArticle: 'Newspaper Article', patent: 'Patent',
  podcast: 'Podcast', preprint: 'Preprint', presentation: 'Presentation',
  radioBroadcast: 'Radio Broadcast', report: 'Report', statute: 'Statute', thesis: 'Thesis',
  tvBroadcast: 'TV Broadcast', videoRecording: 'Video Recording', webpage: 'Web Page',
};

/**
 * Build an itemType → human label map. Seeds the built-in fallback, then overlays the official
 * localized labels from Zotero's public `/itemTypes` endpoint (no auth needed). Never throws.
 */
export async function fetchItemTypeLabels(plugin: RNPlugin, log?: SyncLog): Promise<Map<string, string>> {
  const map = new Map<string, string>(Object.entries(FALLBACK_TYPE_LABELS));
  try {
    const res = await fetch(`${ZOTERO_API_BASE}/itemTypes?locale=en-US`);
    if (res.ok) {
      const rows = (await res.json()) as { itemType: string; localized: string }[];
      for (const r of rows) if (r.itemType && r.localized) map.set(r.itemType, r.localized);
      log?.log('fetch', `Item-type labels: loaded ${rows.length} from Zotero /itemTypes.`);
    } else {
      log?.log('fetch', `Item-type labels: /itemTypes HTTP ${res.status}; using built-in fallback.`);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log?.log('fetch', `Item-type labels: fetch failed (${m}); using built-in fallback.`);
  }
  return map;
}

/**
 * Overwrite a Zotero item's **entire** tag set (replace-exactly). Sends a PATCH with the new tags
 * and the item's known `version` in `If-Unmodified-Since-Version`, so a server-side change since
 * fetch yields HTTP 412 (we surface it rather than clobber). Requires an API key with write access.
 * Returns the item's new version (from the `Last-Modified-Version` response header).
 */
export async function pushItemTags(
  plugin: RNPlugin,
  itemKey: string,
  itemVersion: number,
  tags: string[],
  log?: SyncLog
): Promise<number> {
  const { userId, headers } = await readZoteroCreds(plugin, log);
  const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(
    itemKey
  )}`;
  const body = JSON.stringify({ tags: tags.map((tag) => ({ tag })) });
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'If-Unmodified-Since-Version': String(itemVersion),
    },
    body,
  });
  if (res.status === 412) {
    const msg = `Item ${itemKey} changed on Zotero since the last fetch (HTTP 412). Re-fetch before pushing.`;
    log?.log('apply', `ERROR: ${msg}`);
    throw new Error(msg);
  }
  if (!res.ok) {
    const msg = `Zotero tag write failed for ${itemKey}: HTTP ${res.status} ${res.statusText}.`;
    log?.log('apply', `ERROR: ${msg}`);
    throw new Error(msg);
  }
  const parsed = Number(res.headers.get('Last-Modified-Version'));
  const newVersion = Number.isFinite(parsed) && parsed > 0 ? parsed : itemVersion;
  log?.log(
    'apply',
    `  pushed ${tags.length} tag(s) to Zotero item ${itemKey} (v${itemVersion}→v${newVersion}): [${tags.join(
      ', '
    )}]`
  );
  return newVersion;
}

// ───────────────────────── Add-to-Zotero (Citoid → create items) ─────────────────────────

/** A Zotero-format item-data object (already in Zotero shape — POST-ready after stripping). */
export type CitoidItem = Record<string, unknown> & {
  itemType: string;
  creators?: ZoteroCreator[];
  tags?: { tag: string; type?: number }[];
  collections?: string[];
};

/** Thrown when Citoid can't resolve a DOI (HTTP 404 / empty result). `.notFound` lets callers show
 *  a specific "couldn't find metadata" message instead of a generic error. */
export class CitoidNotFound extends Error {
  notFound = true;
  doi: string;
  constructor(doi: string) {
    super(`Citoid couldn't resolve DOI ${doi}.`);
    this.doi = doi;
  }
}

/**
 * Resolve a DOI to a ready-to-write Zotero item via Wikipedia's Citoid service
 * (`GET …/api/rest_v1/data/citation/zotero/<DOI>`). Returns the FIRST item with the fields that
 * don't belong in a create payload stripped. No auth. The DOI is percent-encoded (raw "/" 404s
 * here, unlike the Zotero/citation-graph path APIs). Throws `CitoidNotFound` on 404 / empty.
 */
export async function fetchCitoidItem(doi: string, log?: SyncLog): Promise<CitoidItem> {
  const clean = normalizeDoi(doi);
  if (!clean) throw new CitoidNotFound(doi || '(empty)');
  const url = `https://en.wikipedia.org/api/rest_v1/data/citation/zotero/${encodeURIComponent(clean)}`;
  log?.log('apply', `Citoid: GET ${url}`);
  const res = await fetch(url, { headers: { Accept: 'application/json; charset=utf-8' } });
  if (res.status === 404) {
    log?.log('apply', `Citoid 404 for ${clean}.`);
    throw new CitoidNotFound(clean);
  }
  if (!res.ok) throw new Error(`Citoid request failed for ${clean}: HTTP ${res.status} ${res.statusText}.`);
  const arr = (await res.json()) as CitoidItem[];
  if (!Array.isArray(arr) || arr.length === 0) throw new CitoidNotFound(clean);

  const item: CitoidItem = { ...arr[0] };
  // Strip fields that mustn't be in a create payload (Citoid emits a placeholder key + version 0;
  // accessDate/libraryCatalog/relations are server-managed). Keep ISSN/volume/issue/date/etc.
  for (const f of ['key', 'version', 'dateAdded', 'dateModified', 'accessDate', 'libraryCatalog', 'relations']) {
    delete (item as Record<string, unknown>)[f];
  }
  (item as Record<string, unknown>).DOI = clean; // normalize to the bare DOI
  if (!item.tags) item.tags = [];
  return item;
}

/** Result of creating one Zotero item (index-aligned with the input array). */
export interface ZoteroCreateResult {
  ok: boolean;
  key?: string;
  version?: number;
  error?: string;
}

/**
 * Create Zotero items: `POST /users/{id}/items` with a JSON array (max 50) and a fresh
 * `Zotero-Write-Token` (random; reusing one → 412). Returns one result per input index, mapping the
 * API's `successful`/`failed` maps (keyed by array index) back to positions. Requires write scope.
 */
export async function createZoteroItems(
  plugin: RNPlugin,
  datas: CitoidItem[],
  log?: SyncLog
): Promise<ZoteroCreateResult[]> {
  if (datas.length === 0) return [];
  if (datas.length > 50) throw new Error('createZoteroItems: max 50 items per request.');
  const { userId, headers } = await readZoteroCreds(plugin, log);
  const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items`;
  const writeToken = makeWriteToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Zotero-Write-Token': writeToken },
    body: JSON.stringify(datas),
  });
  if (res.status === 412) throw new Error('Zotero create failed: HTTP 412 (write token / version conflict).');
  if (!res.ok) throw new Error(`Zotero create failed: HTTP ${res.status} ${res.statusText}.`);
  const body = (await res.json()) as {
    successful?: Record<string, { key: string; version: number }>;
    failed?: Record<string, { key?: string; code: number; message: string }>;
  };
  const out: ZoteroCreateResult[] = datas.map(() => ({ ok: false, error: 'no response entry' }));
  for (const [idx, obj] of Object.entries(body.successful ?? {})) {
    out[Number(idx)] = { ok: true, key: obj.key, version: obj.version };
  }
  for (const [idx, f] of Object.entries(body.failed ?? {})) {
    out[Number(idx)] = { ok: false, error: `HTTP ${f.code}: ${f.message}` };
  }
  log?.log(
    'apply',
    `Zotero create: ${Object.keys(body.successful ?? {}).length} ok, ${Object.keys(body.failed ?? {}).length} failed.`
  );
  return out;
}

/**
 * Authoritative "is this DOI already in my Zotero library?" check — a Zotero quick-search by the
 * bare DOI, confirmed by an exact normalized-DOI match (ignoring trashed items). Used to avoid
 * creating a DUPLICATE Zotero item when adding a related paper: the widget's local in-library gate
 * only sees the locally-loaded RemNote docs, so on a partially-loaded KB it misses items that DO
 * exist in Zotero. Best-effort: any failure returns null (so a search hiccup never blocks adding).
 */
export async function findZoteroItemByDoi(
  plugin: RNPlugin,
  doi: string,
  log?: SyncLog
): Promise<ZoteroItem | null> {
  const clean = normalizeDoi(doi);
  if (!clean) return null;
  try {
    const { userId, headers } = await readZoteroCreds(plugin, log);
    const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items?q=${encodeURIComponent(
      clean
    )}&qmode=everything&limit=50`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const items = (await res.json()) as ZoteroItem[];
    for (const it of items) {
      if (it.data?.deleted) continue;
      if (normalizeDoi(it.data?.DOI) === clean) return it;
    }
    return null;
  } catch (err) {
    log?.log('apply', `DOI pre-existence check failed for ${clean} (proceeding): ${String(err)}`);
    return null;
  }
}

/** A 32-char alphanumeric write token (random, never reused — reuse within 12h → 412). */
function makeWriteToken(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}-${Math.random()}`;
  return uuid.replace(/[^a-z0-9]/gi, '').slice(0, 32);
}

/**
 * Set a Zotero item's collections (replace-exactly with the given keys). PATCH with the item's
 * known `version` in `If-Unmodified-Since-Version` (412 if it changed server-side). Used to file an
 * already-existing item into a picked collection. Returns the item's new version.
 */
export async function pushItemCollections(
  plugin: RNPlugin,
  itemKey: string,
  itemVersion: number,
  collections: string[],
  log?: SyncLog
): Promise<number> {
  const { userId, headers } = await readZoteroCreds(plugin, log);
  const url = `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(itemKey)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', 'If-Unmodified-Since-Version': String(itemVersion) },
    body: JSON.stringify({ collections }),
  });
  if (res.status === 412) throw new Error(`Item ${itemKey} changed on Zotero since the last fetch (HTTP 412).`);
  if (!res.ok) throw new Error(`Zotero collection write failed for ${itemKey}: HTTP ${res.status} ${res.statusText}.`);
  const parsed = Number(res.headers.get('Last-Modified-Version'));
  const newVersion = Number.isFinite(parsed) && parsed > 0 ? parsed : itemVersion;
  log?.log('apply', `  filed item ${itemKey} into ${collections.length} collection(s) (v${itemVersion}→v${newVersion}).`);
  return newVersion;
}

/** Context passed to the pure metadata extractor (keeps it free of async/plugin calls). */
export interface MetaContext {
  /** itemType → human label. */
  typeLabel: (itemType: string) => string;
}

/** One creator, reduced to the display name + role ('' for plain authors). */
export interface NormalizedAuthor {
  name: string;
  role: string;
}

/** An item's Zotero metadata, normalized — the single source of truth for create AND diff. */
export interface NormalizedMeta {
  title: string;
  typeLabel: string;
  authors: NormalizedAuthor[];
  publication: string;
  link: string;
  /** Bare DOI (e.g. `10.1088/1361-6641/ae6942`), '' if none. */
  doi: string;
  /** Date parts: [year] | [year, month] | [year, month, day], from Zotero's normalized
   *  `meta.parsedDate` (ISO, zero-padded). Rendered as the nested Zotero/Dates reference path. [] if none. */
  dateParts: string[];
  collectionKeys: string[];
  /** Zotero abstractNote, '' if none. Written to the doc BODY once on create/adopt (not a slot). */
  abstract: string;
}

/** Extract a 4-digit year from Zotero's parsedDate (ISO-ish), '' if none. */
function parseYear(parsedDate?: string): string {
  const m = parsedDate?.match(/\d{4}/);
  return m ? m[0] : '';
}

/**
 * Split a date into reference-path parts: [year] | [year, month] | [year, month, day].
 *
 * Reads Zotero's `meta.parsedDate` — its OWN normalized parse of the freeform `data.date`, which is
 * ALWAYS ISO ("YYYY" / "YYYY-MM" / "YYYY-MM-DD", zero-padded, truncated — never "00" placeholders)
 * no matter how the user typed it ("2016/5/30"→"2016-05-30", "03-04-2012"→"2012-03-04", "2007/12"→
 * "2007-12", "Spring 2013"→"2013", "Thu, 10 Oct 2019…"→"2019-10-10"; verified live against the API).
 * So we never re-parse the messy raw string ourselves. When parsedDate is null (genuinely
 * unparseable, e.g. "n.d." / "2021b"), fall back to a bare 4-digit year salvaged from the raw `date`.
 * No usable date → [].
 */
export function parseDateParts(parsedDate?: string, rawDate?: string): string[] {
  const iso = (parsedDate ?? '').trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (iso) {
    const parts = [iso[1]];
    if (iso[2] && iso[2] !== '00') {
      parts.push(iso[2]);
      if (iso[3] && iso[3] !== '00') parts.push(iso[3]);
    }
    return parts;
  }
  const y = (rawDate ?? '').match(/\d{4}/);
  return y ? [y[0]] : [];
}

/**
 * "Publication" for ANY item type: prefer the most specific container title, fall back to publisher.
 * journalArticle keeps publicationTitle and book keeps publisher (no earlier field matches), while
 * bookSection→bookTitle, conferencePaper→proceedingsTitle/conferenceName, thesis→university,
 * report→institution, preprint→repository, webpage→websiteTitle, etc. now resolve instead of blank.
 */
function containerTitle(data: ZoteroItem['data']): string {
  const candidates = [
    data.publicationTitle,
    data.bookTitle,
    data.proceedingsTitle,
    data.conferenceName,
    data.university,
    data.institution,
    data.repository,
    data.websiteTitle,
    data.blogTitle,
    data.encyclopediaTitle,
    data.dictionaryTitle,
    data.publisher,
  ];
  for (const c of candidates) {
    const v = (c ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * Many item types (book/report/thesis/dataset/preprint) store their DOI in the free-text `extra`
 * field as a `DOI: 10.x/…` line rather than in `data.DOI`. Pull it out so those items still get a
 * clickable DOI + the citations/related/scite pipeline. Strips a leading doi.org URL if present.
 */
function parseDoiFromExtra(extra?: string): string {
  if (!extra) return '';
  const m = extra.match(/^\s*DOI:\s*(\S+)/im);
  if (!m) return '';
  return m[1].replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/[.,;]+$/, '').trim();
}

/** Pure: map a Zotero item to its normalized metadata. No awaits, no plugin access. */
export function extractMetadata(item: ZoteroItem, ctx: MetaContext): NormalizedMeta {
  const data = item.data ?? ({} as ZoteroItem['data']);
  const authors: NormalizedAuthor[] = (data.creators ?? [])
    .map((c): NormalizedAuthor => {
      const role = c.creatorType === 'author' ? '' : c.creatorType ?? '';
      if (c.name) return { name: c.name.trim(), role };
      const last = (c.lastName ?? '').trim();
      const first = (c.firstName ?? '').trim();
      return { name: last && first ? `${last}, ${first}` : last || first, role };
    })
    .filter((a) => a.name.length > 0);
  const doi = (data.DOI?.trim() || parseDoiFromExtra(data.extra) || '').trim();
  const url = data.url?.trim() ?? '';
  // Leave Link(s) EMPTY when the URL is just the DOI's own doi.org link. Two reasons, both about
  // the DOI slot: (1) it already renders that exact clickable link, so a Link(s) duplicate is
  // redundant; (2) RemNote de-dupes link rems BY URL, so the Link(s) and DOI slots would share ONE
  // rem whose display text the DOI feature overrides to the BARE DOI — then the link diff compares
  // that bare-DOI text against the full doi.org URL and mismatches FOREVER (a phantom "link"
  // update). (Extends the 2026-06-12 "no doi.org fallback" fix — which only covered items with NO
  // URL — to items whose actual Zotero URL IS the doi.org link.)
  const urlIsDoiLink =
    !!doi &&
    /^https?:\/\/(dx\.)?doi\.org\//i.test(url) &&
    url.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/\/+$/, '').toLowerCase() ===
      doi.toLowerCase();
  return {
    title: (data.title ?? '').trim(),
    typeLabel: ctx.typeLabel(data.itemType),
    authors,
    publication: containerTitle(data),
    link: urlIsDoiLink ? '' : url,
    doi,
    dateParts: parseDateParts(item.meta?.parsedDate, data.date),
    collectionKeys: data.collections ?? [],
    abstract: (data.abstractNote ?? '').trim(),
  };
}
