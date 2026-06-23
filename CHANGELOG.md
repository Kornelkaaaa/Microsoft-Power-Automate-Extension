# Changelog

All notable changes to Flow Finder are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-06-22

### Added
- **Copilot Studio support.** 49 native Microsoft Copilot Studio building blocks are now
  in the catalog — authoring-canvas nodes (Send a message, Ask a question, Condition,
  variable management, HTTP request, generative answers…), topic triggers, system topics,
  knowledge sources, and tools — curated from the public Copilot Studio documentation on
  Microsoft Learn.
- **Power Automate / Copilot Studio product toggle.** A header switch scopes results to
  either product. Connectors appear in both (Copilot Studio can call them as agent tools
  and in flows); Copilot Studio's native blocks appear only in Copilot Studio mode. The
  connector dropdown, example searches, welcome screen, and counts all adapt to the
  selected product.
- **`products` field** in the `catalog.json` schema, marking which product(s) each block
  is usable in (`["Power Automate", "Copilot Studio"]` for connectors, `["Copilot Studio"]`
  for native blocks).
- **`scripts/copilot-studio-blocks.json`** data source and a `--no-copilot` build flag for
  `build-catalog.js`.

### Fixed
- **Operation inputs and documentation links now render.** Every result card can show its
  inputs (with required fields marked) and a "View docs" deep link. The side-panel UI
  already supported these, but the shipped catalog never populated the `inputs` and
  `docUrl` fields — they are now generated for all entries (swagger `parameters` and GitHub
  folder for third-party connectors; the Microsoft Learn Parameters table and operation
  anchor for first-party connectors; the Copilot Studio docs page for native blocks).

### Changed
- Catalog refreshed and expanded to **4,105 entries across 248 connectors** (from 3,546 /
  190), re-pulled from the current Microsoft sources.
- Footer attribution now credits **Microsoft Learn** alongside the
  microsoft/PowerPlatformConnectors repository.
- Side-panel subtitle and search placeholder updated to reflect both products.

### Docs
- README updated: documented the `products`, `inputs`, and `docUrl` fields; the Copilot
  Studio data source; and the new build flag.

## [1.0.0] — Initial release

### Added
- Manifest V3 Chrome extension presenting an offline, side-panel catalog of Power Automate
  / Power Platform connectors, actions, and triggers.
- Local fuzzy search (Fuse.js, vendored) with a token-overlap booster for keyword and
  out-of-order queries.
- Filters for Actions/Triggers, Standard/Premium, and a connector dropdown; keyboard-first
  navigation; light/dark aware UI.
- 100% offline at runtime — bundled catalog, no network calls, `sidePanel` permission only.

[1.2.0]: https://github.com/Kornelkaaaa/Microsoft-Power-Automate-Extension/releases/tag/v1.2.0
[1.0.0]: https://github.com/Kornelkaaaa/Microsoft-Power-Automate-Extension/releases/tag/v1.0.0
