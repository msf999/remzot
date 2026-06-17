<div align="center">

<img src="assets/png/icon/remzot-icon-256.png" alt="Remzot" width="120" height="120" />

# Remzot

**Sync your Zotero library into Remnote — and keep them in step.**

</div>

Remzot is a [Remnote](https://www.remnote.com) plugin that mirrors your **Zotero** library
into Remnote. Every top-level Zotero item becomes a Remnote **document** under a
`Zotero / Items` hierarchy, carrying its metadata as properties — and an on-page menu turns
each item into a hub for its references, citations, and related papers.

> [!WARNING]
> **Vibe-coded — use at your own risk.** Remzot was built almost entirely by prompting an AI
> assistant ("vibe coding"), with light human review. Treat it as experimental: **back up your
> Zotero library and your Remnote knowledge base** before relying on it, and expect rough edges.
>
> It's heavily inspired by — and borrows ideas from — the
> [Zotero RemNote Connector](https://github.com/coldenate/zotero-remnote-connector) (Zotero Web API
> approach) and [zoteroRoam](https://github.com/alixlahuec/zotero-roam) (the on-page item menu).

---

## What it does

### Library sync (Zotero → Remnote)
- **Each item → a document** under `Zotero / Items`, named by its citation key (Better-BibTeX
  style, falling back to the title), tagged with the **`Zotero Item`** powerup.
- **Rich metadata properties:** Title, Type, Authors, Publication, Link(s), **DOI** (a clickable
  `doi.org` link), Date, Tags, Collection(s), Status, Rating. Type / Authors / Publication /
  Date / Collection(s) / Status are **references** into deduped lookup docs
  (`Zotero/Types`, `/Authors`, `/Publications`, …) so you can click through and see everything
  filed under each.
- **Collections mirrored** as Remnote's own nested tree, with each item filed under its full
  collection path.
- **The abstract** is written into the document body on creation.
- **Per-field update detection:** a preview shows exactly which fields changed (`old → new`),
  so you sync only what you choose.
- **Adopt existing docs:** a keyless doc whose name already matches a Zotero citation key (e.g.
  one made by Supercharged citation picker) is *adopted* in place — its references and children are kept.

### Tag write-back (Remnote → Zotero)
Edit an item's **Status**, **Rating**, or **Tags** in Remnote and Remzot pushes them back to
Zotero as that item's tags on the next sync.

> [!WARNING]
> **For tags, Remnote is the source of truth.** On push, Remzot **overwrites** the item's Zotero tags
> with the set derived from Remnote (replace-exactly) — any tag that exists only on the Zotero side is
> removed. Be careful.

Everything else is **pull-only**: **Title, Date, Authors, Publication, DOI**, etc. sync **Zotero →
Remnote** only — editing them in Remnote does **not** push back. For those fields, **Zotero is the
source of truth**.

### Preview-then-apply
The **Open Zotero Sync** popup never changes anything until you say so. It groups the plan into
collapsible, selectable categories — *Will create*, *Will update*, *Will match (adopt)*,
*Push to Zotero*, *Will delete*, and read-only *Already on Remnote* — with a live fetch progress
bar and a completion summary. Safety guards suppress deletions when a fetch looks empty or
truncated, so a transient network hiccup can't wipe your tree.

### On-page item menu
Below the title of every synced item, Remzot renders a quiet card with:
- a one-click **per-item Sync** (pulls metadata, pushes your Status/Rating/Tags);
- **brand-icon links** out to Zotero (app & web), Connected Papers, Semantic Scholar, Google
  Scholar, OpenAlex, Inciteful, Litmaps, and ResearchRabbit;
- a **scite** tally pill (supporting / mentioning / contradicting / unclassified); and
- a **citations bar** — *References* · *In Library* · *Citations* · *Related* — pooled from
  Crossref, Semantic Scholar, OpenAlex, and OpenCitations, deduped by DOI, each row showing
  citation metrics and a one-click **Add to Zotero** (it lands in both Zotero and Remnote).

---

## How your library looks in Remnote

Remzot creates one top-level **`Zotero`** document and mirrors everything beneath it:

```
Zotero/
├─ Items/                 — one document per Zotero item (added newest-first)
│  ├─ smithStudy2021            ← named by its citation key (or title)
│  ├─ jonesReview2020
│  └─ …
├─ Types/                 — lookup: item types (Journal Article, Book, …)
├─ Authors/               — lookup: "Lastname, Firstname"
├─ Publications/          — lookup: journals / publishers / venues
├─ Dates/                 — nested date tree: year › month › day
│  └─ 2026/
│     └─ 07/
│        └─ 01/
├─ Collections/           — mirrors your Zotero collection tree (nested)
│  └─ Parent Collection/
│     ├─ Subcollection A/
│     └─ Subcollection B/
└─ Statuses/              — lookup: In Progress, …
```

**Each item document** is tagged with the **`Zotero Item`** powerup and carries its metadata as
properties at the top of the document:

| Property | Holds |
| --- | --- |
| **Title** | the item's title |
| **Type** | → reference into `Zotero/Types` |
| **Authors** | one or more → references into `Zotero/Authors` |
| **Publication** | → reference into `Zotero/Publications` |
| **Link(s)** | the item's URL, as a clickable link |
| **DOI** | a clickable `doi.org/<doi>` link (displays the bare DOI) |
| **Date** | the date as a nested **year-month-day** reference path into `Zotero/Dates` (e.g. ‹2026›-‹07›-‹01›) — click any part to find everything from that year/month/day |
| **Tags** | _yours to edit_ — multi-select, pushed back to Zotero |
| **Collection(s)** | the full collection path(s) → references into `Zotero/Collections` |
| **Status** | → reference into `Zotero/Statuses` (defaults to _In Progress_; _yours_, pushed back) |
| **Rating** | _yours to edit_, pushed back to Zotero |

> [!TIP]
> **Tags, Status, and Rating are yours to fill in — and they work best as *selection* properties.**
> If any of them shows as plain text, click the property → **Property Type** and pick
> **Single/Multi Select** — Single for **Status** and **Rating**, Multi for **Tags**. You then pick from reusable
> dropdown chips instead of typing free text, which is faster, keeps values consistent, and pushes
> back to Zotero cleanly.

The item's **abstract** is written into the document **body** once, when the document is created.

Because **Type, Authors, Publication, Date, Collection(s), and Status are references** into the
shared lookup docs, those docs double as automatic indexes — open *Authors → "Curie, Marie"* and
Remnote's references panel lists every item by her. Each item also carries three hidden slots
(`Zotero Key`, `Zotero Version`, `Last Synced`) that track sync identity; they aren't shown.

---

## Setup — connecting your Zotero account

Remzot talks to Zotero through its Web API, so it needs your **User ID** and a personal
**API key**. Both come from one page on zotero.org:

1. Sign in to Zotero and open **[Settings → Feeds/API → Applications](https://www.zotero.org/settings/keys)**
   (`https://www.zotero.org/settings/keys`).
2. **User ID** — copy the number shown under *"Your userID for use in API calls."*
3. **API key** — click **Create new private key**, name it (e.g. `Remzot`), and grant access:
   - **Allow library access** (read) — required.
   - **Allow write access** — needed for the two-way features (pushing Status/Rating/Tags back to
     Zotero, and *Add to Zotero* from the on-page menu). A read-only key still works for plain
     one-way import.
   - Save, then **copy the key immediately** — Zotero only shows it once.
4. In Remnote, open the plugin's settings (**Settings → Plugins → Remzot**, or the **Build** tab
   while developing from localhost) and paste your **User ID** and **API Key**.
5. **Type `/` anywhere** and run the **Open Zotero Sync** command (or use the quick code `zot`) to open
   the sync popup → **Get from Zotero** to preview, then **Apply** the changes you tick.

> Remzot syncs your **personal** (user) library only — group libraries aren't supported yet.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Zotero User ID** | — | Your numeric Zotero userID, from [zotero.org/settings/keys](https://www.zotero.org/settings/keys). Selects which personal library to sync. **Required.** |
| **Zotero API Key** | — | The private key Remzot uses to read — and, with write access, modify — your Zotero library. Create it at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). **Required.** Use a **read + write** key for tag write-back and *Add to Zotero*; a read-only key limits Remzot to one-way import. |
| **Zotero Username** | _(optional)_ | Your `zotero.org/<username>` slug. Powers the on-page menu's **Zotero Web** link only — Zotero's web library doesn't resolve numeric-ID URLs, so without this that one link won't work. Everything else syncs fine without it. |
| **Make new items Incremental** | Off | When **on**, every document Remzot *creates* (via a sync or the on-page **Add**) is also enrolled in [Incremental Everything](https://github.com/bjsi/incremental-everything) — added to its queue, due today, at the default priority. Requires that plugin installed (otherwise silently skipped). Existing and adopted docs are left untouched. |


