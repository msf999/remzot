// lib/menuOrder.ts — keep the on-page menu BELOW Incremental Everything's chip (mo, 2026-11-22).
//
// RemNote draws the widgets under a document's title in the order they were registered, across
// all plugins: its widget manager adds a widget to the end of the location's list on every
// registration, and nothing sorts that list (RemNote 1.30). On a Zotero item that is also an
// Incremental Rem, Incremental Everything's chip under the title (its `inc_rem_counter`: the Inc
// Rems count, the priority, the next date) came after this menu whenever Remzot registered first,
// and always after IE had been reloaded — a reload removes a plugin's widgets and registers them
// again, at the end.
//
// mo's fork of IE registers its chip as the first thing it does at start-up (same day). What is
// left is Remzot starting first — its bundle is a third of IE's — or IE being reloaded later. So
// whenever an IE widget is found AFTER the menu, the menu is unregistered and registered again,
// which puts it at the end. RemNote destroys the menu's frames and draws them again: the menu
// blinks once when that happens.
//
// When: every second for the first minute after Remzot starts (IE starts within seconds of it),
// then on every navigation (index.tsx's URLChange listener), which catches IE reloaded later — an
// update, or its dev server. Each check is one `getWidgetsAtLocation` call.
import { WidgetLocation, type ReactRNPlugin, type WidgetOptions } from '@remnote/plugin-sdk';
import { ITEM_MENU_WIDGET, REMZOT_PLUGIN_ID } from './consts';

/** How the menu is registered: in one place, since it is registered again when it moves. */
export const ITEM_MENU_OPTIONS: WidgetOptions = { dimensions: { height: 'auto', width: '100%' } };

/** Incremental Everything and mo's fork of it; the menu goes below every widget they put there. */
const INCREMENTAL_PLUGIN_IDS = new Set(['incremental-everything', 'incremental-everything-mo']);

const STARTUP_CHECK_MS = 1000;
const STARTUP_WINDOW_MS = 60_000;
/** How long to wait for RemNote to drop the old menu before registering it again, and how often
 *  to ask at most. */
const REMOVAL_WAIT_MS = 2000;
const REMOVAL_CHECKS = 400;

let moving = false;

/** Registers the menu, and checks its place every second for the first minute. */
export async function registerItemMenu(plugin: ReactRNPlugin): Promise<void> {
  await plugin.app.registerWidget(
    ITEM_MENU_WIDGET,
    WidgetLocation.DocumentBelowTitle,
    ITEM_MENU_OPTIONS
  );
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started >= STARTUP_WINDOW_MS) clearInterval(timer);
    void keepMenuBelowIncremental(plugin);
  }, STARTUP_CHECK_MS);
}

/**
 * When a widget of Incremental Everything sits after the menu under the title, registers the menu
 * again so that it comes last. Returns whether it moved the menu. Never throws.
 */
export async function keepMenuBelowIncremental(plugin: ReactRNPlugin): Promise<boolean> {
  if (moving) return false;
  moving = true;
  let removed = false;
  try {
    const ownId = plugin.id ?? REMZOT_PLUGIN_ID;
    const isMenu = (w: { pluginId: string; fileName: string }) =>
      w.pluginId === ownId && w.fileName === ITEM_MENU_WIDGET;
    const widgets = await plugin.widget.getWidgetsAtLocation(WidgetLocation.DocumentBelowTitle);
    const menu = widgets.findIndex(isMenu);
    let lastIncremental = -1;
    widgets.forEach((w, i) => {
      if (INCREMENTAL_PLUGIN_IDS.has(w.pluginId)) lastIncremental = i;
    });
    if (menu === -1 || lastIncremental < menu) return false;

    await plugin.app.unregisterWidget(ITEM_MENU_WIDGET, WidgetLocation.DocumentBelowTitle);
    removed = true;
    // RemNote answers before the menu is off its list: it first destroys the menu's frames, which
    // took 50–400 ms in the test. A registration sent meanwhile would draw two menus for a moment,
    // so ask until it is gone — with no timer in between: this frame is hidden, and Chrome holds a
    // hidden frame's short timer back for up to a second, which kept the menu away for 2–5 s in
    // the test. A question is answered in a few milliseconds.
    const removedAt = Date.now();
    let asked = 0;
    while (asked < REMOVAL_CHECKS && Date.now() - removedAt < REMOVAL_WAIT_MS) {
      asked++;
      const now = await plugin.widget.getWidgetsAtLocation(WidgetLocation.DocumentBelowTitle);
      if (!now.some(isMenu)) break;
    }
    await plugin.app.registerWidget(
      ITEM_MENU_WIDGET,
      WidgetLocation.DocumentBelowTitle,
      ITEM_MENU_OPTIONS
    );
    removed = false;
    console.log(
      `Remzot: moved the on-page menu below Incremental Everything (${Date.now() - removedAt} ms, ` +
        `${asked} checks)`
    );
    return true;
  } catch (error) {
    console.warn('Remzot: could not check the order of the widgets under the title', error);
    // Never leave the items without their menu.
    if (removed) {
      await plugin.app
        .registerWidget(ITEM_MENU_WIDGET, WidgetLocation.DocumentBelowTitle, ITEM_MENU_OPTIONS)
        .catch((e) => console.error('Remzot: could not register the on-page menu again', e));
    }
    return false;
  } finally {
    moving = false;
  }
}
