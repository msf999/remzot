import {
  AppEvents,
  declareIndexPlugin,
  type ReactRNPlugin,
  WidgetLocation,
  PropertyType,
  PropertyLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';
import {
  ITEM_MENU_WIDGET,
  SESSION,
  SETTINGS,
  SLOTS,
  SYNC_WIDGET,
  ZOTERO_ITEM_POWERUP,
} from '../lib/consts';

async function onActivate(plugin: ReactRNPlugin) {
  // --- Settings: Zotero credentials (personal library) ---
  await plugin.settings.registerStringSetting({
    id: SETTINGS.userId,
    title: 'Zotero User ID',
    description: 'Your numeric userID. Find it at https://www.zotero.org/settings/keys',
  });

  await plugin.settings.registerStringSetting({
    id: SETTINGS.apiKey,
    title: 'Zotero API Key',
    description:
      'Create a key at https://www.zotero.org/settings/keys. Enable read AND write access — write ' +
      'is needed to push Status/Rating/Tags back to Zotero and to add papers from the on-page menu ' +
      '(a read-only key still works for one-way import).',
  });

  await plugin.settings.registerStringSetting({
    id: SETTINGS.username,
    title: 'Zotero Username (optional)',
    description:
      'Your zotero.org username slug (zotero.org/<username>) — used to build "Open in Zotero ' +
      '[Web library]" links on item pages. Numeric-ID links do not work on zotero.org.',
  });
  await plugin.settings.registerBooleanSetting({
    id: SETTINGS.initIncremental,
    title: 'Make new items Incremental (Incremental Everything)',
    description:
      'When ON, every item this plugin CREATES — added from the on-page menu OR by a global sync — is ' +
      'also turned into an Incremental Everything item (added to its queue, due today, default priority). ' +
      'Requires the Incremental Everything plugin to be installed; otherwise this is silently skipped. ' +
      'Existing/adopted docs are not affected.',
    defaultValue: false,
  });

  // --- Powerup: marks a Rem as a synced Zotero item and holds its metadata ---
  // Order here is the display order in Remnote. Zotero-derived fields are
  // `onlyProgrammaticModifying` (the plugin owns them); Status/Tags/Rating are user-editable.
  await plugin.app.registerPowerup({
    name: 'Zotero Item',
    code: ZOTERO_ITEM_POWERUP,
    description: 'Marks a Rem as imported from Zotero and holds its metadata.',
    options: {
      properties: [
        // Every visible property is typed explicitly and rendered in the top-of-document panel
        // (ONLY_DOCUMENT = the UI's "At Top of Document"). NOTE (verified live 2026-06-12):
        // re-registration updates NEITHER the type NOR the location of an already-created
        // property definition — these values only govern FRESH installs. On an existing KB, each
        // property's type/location must be changed once via its config menu in the RemNote UI
        // (definition-level, so one change applies to every doc). Mo's KB was aligned by hand on
        // 2026-06-12 to exactly the types below.
        { code: SLOTS.title, name: 'Title', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.type, name: 'Type', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.authors, name: 'Authors', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.publication, name: 'Publication', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.link, name: 'Link(s)', onlyProgrammaticModifying: true,
          propertyType: PropertyType.URL, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.doi, name: 'DOI', onlyProgrammaticModifying: true,
          propertyType: PropertyType.URL, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        // "Date" — holds the date as a Year-Month-Day reference path into Zotero/Dates (slot code
        // stays `year` for continuity with already-synced docs; see SLOTS.year in consts.ts).
        { code: SLOTS.year, name: 'Date', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.tags, name: 'Tags',
          propertyType: PropertyType.MULTI_SELECT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.collections, name: 'Collection(s)', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.status, name: 'Status',
          propertyType: PropertyType.SINGLE_SELECT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SLOTS.rating, name: 'Rating',
          propertyType: PropertyType.SINGLE_SELECT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        // Hidden identity slots.
        { code: SLOTS.key, name: 'Zotero Key', onlyProgrammaticModifying: true, hidden: true },
        { code: SLOTS.version, name: 'Zotero Version', onlyProgrammaticModifying: true, hidden: true },
        // Per-item last-sync timestamp (epoch ms) — powers the on-page menu's "synced <date>".
        { code: SLOTS.lastSyncedAt, name: 'Last Synced', onlyProgrammaticModifying: true, hidden: true },
      ],
    },
  });

  // --- The sync popup and the command that opens it ---
  // Same size as Incremental Everything's main view popup.
  await plugin.app.registerWidget(SYNC_WIDGET, WidgetLocation.Popup, {
    dimensions: { height: 800, width: 1000 },
  });

  // --- On-page menu (zoteroRoam-style; design-only dummy for now) ---
  // Registered WITHOUT powerupFilter, on purpose: a filtered DocumentBelowTitle widget did NOT
  // re-mount on in-app (SPA) navigation — it showed only on the page that was active at plugin
  // load and never appeared after navigating to another item (verified live 2026-06-13). So we
  // mount on EVERY document (exactly like Incremental Everything's per-doc inc_rem_counter) and
  // the component decides whether to render: it returns null unless the doc has the zotero-item
  // powerup. Reactivity across navigation comes from the SESSION.navTick key bumped below.
  await plugin.app.registerWidget(ITEM_MENU_WIDGET, WidgetLocation.DocumentBelowTitle, {
    dimensions: { height: 'auto', width: '100%' },
  });

  // RemNote reuses DocumentBelowTitle widget iframes across in-app navigation, and
  // getWidgetContext is not reactive — without a signal the menu shows STALE data on the next
  // page (verified live). Bump a session key on every navigation; the widget's tracker reads it
  // (session reads ARE reactive), re-runs, and re-queries its context. (Pattern from
  // Incremental Everything's URLChange → currentDocumentIdKey.)
  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    try {
      await plugin.storage.setSession(SESSION.navTick, Date.now());
    } catch {
      // navigation signal only — never let it throw
    }
  });

  await plugin.app.registerCommand({
    id: 'open-zotero-sync',
    name: 'Open Zotero Sync',
    quickCode: 'zot',
    action: async () => {
      await plugin.widget.openPopup(SYNC_WIDGET);
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
