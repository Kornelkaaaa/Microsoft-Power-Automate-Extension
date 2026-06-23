# Flow Finder

A Manifest V3 Chrome extension — a fast, searchable catalog of **Power Automate / Power
Platform** connectors, actions, and triggers, living in a Chrome **side panel**.

Power Automate users often can't build a flow because they don't know which *block*
(connector / action / trigger) solves their use case. Flow Finder makes the entire
connector surface **browsable and searchable** — type a use case in plain language
(`wait until file approved`, `send message teams`) and the right operation surfaces.

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by Microsoft. Connector
> data comes from the public open-source [microsoft/PowerPlatformConnectors][repo] repo.

---

## Features

- **Local fuzzy search** over operation name, description, connector, and tags —
  typo-tolerant (Fuse.js, bundled locally) plus a token-overlap booster so keyword and
  out-of-order queries (`post message teams`) still rank correctly.
- **Filters:** Actions / Triggers toggles, Standard / Premium toggles, and a connector
  dropdown.
- **Dense, power-user UI:** action/trigger badge, tier badge, truncated-and-expandable
  descriptions, result count, light/dark aware.
- **Keyboard-first:** `/` focuses search, `↑`/`↓` navigate results, `Enter` expands,
  `Esc` clears.
- **100% offline at runtime.** The catalog is bundled as `catalog.json`; the extension
  makes **no network calls** and requests only the `sidePanel` permission — no host
  permissions. Passes Chrome Web Store review cleanly.

---

## Project layout

```
flow-finder/
├─ src/                     # extension source (copied verbatim into dist/)
│  ├─ manifest.json         # MV3, side_panel, sidePanel permission only
│  ├─ background.js         # opens the side panel on toolbar click
│  ├─ sidepanel.html/.js    # UI + search engine
│  ├─ styles.css
│  ├─ vendor/fuse.mjs       # Fuse.js v7 (vendored, MIT) — not loaded from any CDN
│  └─ icons/
├─ public/catalog.json      # generated catalog (the bundled data)
├─ scripts/
│  ├─ build-catalog.js      # fetches + flattens connector data from GitHub
│  ├─ curated-first-party.json  # SharePoint/Outlook/Teams/Dataverse/HTTP supplement
│  └─ build.js              # assembles dist/
├─ dist/                    # loadable unpacked extension (build output)
└─ package.json
```

---

## Build

Requires **Node.js ≥ 18** (uses the global `fetch`). No `npm install` needed — there are
no runtime dependencies; Fuse.js is already vendored in `src/vendor/`.

```bash
# 1. Generate the connector catalog from GitHub (writes public/catalog.json)
npm run build:catalog

# 2. Assemble the loadable extension into dist/
npm run build

# …or do both at once:
npm run build:all
```

`dist/` already ships pre-built in this repo, so you can skip straight to loading it.

### Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the **`dist/`** folder.
4. Click the Flow Finder toolbar icon to open the side panel.

> Side panels require **Chrome 114+**.

---

## Refresh the connector data

The catalog comes from **two complementary public sources**, neither needing an API key
or auth:

**1. Third-party connectors — `scripts/build-catalog.js`**
Reads connector definitions straight from [microsoft/PowerPlatformConnectors][repo]
(public GitHub REST API to list folders + `raw.githubusercontent.com` to fetch files, with
retry/backoff for rate limits). For each connector folder it parses
`apiDefinition.swagger.json` (and `apiProperties.json` when present) and emits one entry
per operation. Malformed swagger files are **skipped and logged**, never fatal.

**2. First-party connectors — `scripts/build-firstparty.js`**
The big Microsoft connectors (Dataverse, SharePoint, Teams, Outlook, Planner, Forms, …)
are **not** in that GitHub repo. Instead this script pulls their **complete** action and
trigger lists — with accurate Operation IDs and descriptions — from the public
[Microsoft Learn connector reference][learn] (`https://learn.microsoft.com/connectors/<slug>/`),
which is the authoritative rendered docs for every connector. It writes
`scripts/curated-first-party.json`, which `build-catalog.js` then merges in. Configure which
connectors to pull (and add new ones) in `scripts/firstparty-connectors.json`; built-ins
with no docs page (HTTP, Request) live in `scripts/firstparty-extras.json`.

```bash
npm run build:all          # firstparty + catalog + dist, the full refresh

# or run the stages individually:
npm run build:firstparty   # scrape first-party connectors from Microsoft Learn
npm run build:catalog      # third-party from GitHub (capped at 90/folder, fast)
npm run build:catalog:full # every third-party connector (1000+, slow)
npm run build              # assemble dist/

# advanced flags:
node scripts/build-catalog.js --limit 200          # cap per folder
node scripts/build-catalog.js --no-independent     # certified connectors only
node scripts/build-catalog.js --no-curated         # skip the first-party merge
node scripts/build-firstparty.js --keep-deprecated # include deprecated/MCP-server ops
```

### Want *all* actions for a connector?

- **Third-party:** run `npm run build:catalog:full` to fetch every connector and every
  operation from the GitHub repo (the default capped run is just for speed).
- **First-party:** every operation is already pulled in full from Microsoft Learn. To add
  another first-party connector, append its slug to `scripts/firstparty-connectors.json`
  (the slug is the last path segment of its `learn.microsoft.com/connectors/<slug>/` URL)
  and re-run `npm run build:firstparty && npm run build`.

### catalog.json schema

```json
{
  "connector": "SharePoint",
  "connectorDescription": "SharePoint helps organizations share and collaborate…",
  "tier": "Standard",                       // "Standard" | "Premium" | "unknown"
  "type": "trigger",                        // "action" | "trigger"
  "name": "When an item is created",        // operation summary
  "operationId": "GetOnNewItems",
  "description": "Triggers a flow when a new item is created in a SharePoint list.",
  "inputs": ["Site Address*", "List Name*"], // operation parameters; "*" = required
  "docUrl": "https://learn.microsoft.com/en-us/connectors/sharepointonline/#when-an-item-is-created",
  "tags": ["sharepoint", "item", "created", "list", "new", "trigger"]
}
```

- **`inputs`** is a compact, ordered list of an operation's parameters (a trailing
  `*` marks a required one). Third-party inputs come from the swagger `parameters`
  array; first-party inputs are parsed from each operation's **Parameters** table on
  Microsoft Learn. The side panel renders these as pills when a card is expanded.
- **`docUrl`** deep-links to the operation's documentation — the Microsoft Learn
  connector reference anchor for first-party connectors, the GitHub connector folder
  for third-party ones. Shown as a "View docs" link on each card.

### Notes on the data

- **Two sources, by design:** third-party *certified* and *independent-publisher*
  connectors come from the PowerPlatformConnectors GitHub repo; first-party Microsoft
  connectors come from the Microsoft Learn connector reference (see above). Both are
  public and unauthenticated.
- `scripts/curated-first-party.json` is **generated** by `build:firstparty` — don't edit
  it by hand; change `firstparty-connectors.json` / `firstparty-extras.json` instead.
- By default the first-party scrape **omits deprecated and MCP-server plumbing**
  operations (to match what you see in the Power Automate designer). Pass
  `--keep-deprecated` to include them.
- **Tier:** `apiProperties.json` rarely exposes a tier. Since nearly all non-first-party
  connectors require a **Premium** license in Power Automate, the builder defaults
  repo-sourced connectors to `Premium` (overridden by an explicit tier when present).
  First-party tiers are set in `firstparty-connectors.json`.

---

## Data source & license

Connector definitions are derived from two Microsoft sources:

- **[microsoft/PowerPlatformConnectors][repo]** (third-party connectors) — repository
  **code** is **MIT**, **documentation/content** is **CC-BY-4.0**.
- **[Microsoft Learn connector reference][learn]** (first-party connectors) — Microsoft
  technical documentation, licensed **CC-BY-4.0** per the
  [MicrosoftDocs terms](https://github.com/MicrosoftDocs/microsoft-docs#legal-notices).

Flow Finder reuses the connector titles, descriptions, and operation metadata from those
sources. Per **CC-BY-4.0**, attribution is given here and in [NOTICE](NOTICE). This project
is **unofficial** and is **not affiliated with Microsoft**. "Power Automate", "Power
Platform", "SharePoint", "Microsoft Teams", "Dataverse", and related names are trademarks
of Microsoft.

Flow Finder's own source code is licensed **MIT** (see [LICENSE](LICENSE)). Fuse.js is
licensed **MIT** (see `src/vendor/fuse.mjs` header).

[repo]: https://github.com/microsoft/PowerPlatformConnectors
[learn]: https://learn.microsoft.com/en-us/connectors/connector-reference/
