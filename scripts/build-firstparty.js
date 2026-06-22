#!/usr/bin/env node
/**
 * build-firstparty.js — pull COMPLETE operation lists for first-party (and any
 * other) connectors from the public Microsoft Learn connector reference.
 *
 * The microsoft/PowerPlatformConnectors GitHub repo only contains third-party
 * (certified + independent-publisher) connectors. The big first-party connectors
 * (Dataverse, SharePoint, Teams, Outlook, …) live only in the rendered docs at
 *   https://learn.microsoft.com/en-us/connectors/<slug>/
 * which list every action and trigger with its Operation ID and description.
 *
 * This script fetches those pages (unauthenticated, no API key), parses each
 * operation, and writes scripts/curated-first-party.json — which build-catalog.js
 * then merges into public/catalog.json.
 *
 * Configure which connectors to pull in scripts/firstparty-connectors.json.
 * Requires Node 18+ (global fetch). No npm dependencies.
 *
 * Usage:
 *   node scripts/build-firstparty.js
 *   node scripts/build-firstparty.js --keep-deprecated   # include deprecated/MCP ops
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, 'firstparty-connectors.json');
const EXTRAS = path.join(__dirname, 'firstparty-extras.json');
const OUT = path.join(__dirname, 'curated-first-party.json');
const BASE = 'https://learn.microsoft.com/en-us/connectors';
const UA = 'flow-finder-firstparty-builder';

const keepDeprecated = process.argv.includes('--keep-deprecated');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tiny HTML helpers (no DOM dependency)
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// Parse the "Parameters" table of an operation block into a compact input list.
// Learn renders it as: <h4 ...>Parameters</h4> ... <table> with header <th> cells,
// data rows whose first <td> holds <div class="parameterName">Name</div> and whose
// third <td> holds "True" when required. Required parameters get a trailing "*".
function parseInputs(body) {
  const head = body.match(/<h4[^>]*>\s*Parameters\s*<\/h4>/i);
  if (!head) return [];
  let section = body.slice(head.index + head[0].length);
  const retIdx = section.search(/<h4[^>]*>\s*Returns\s*<\/h4>/i);
  if (retIdx >= 0) section = section.slice(0, retIdx);
  const tableMatch = section.match(/<table[\s\S]*?<\/table>/);
  if (!tableMatch) return [];

  const inputs = [];
  for (const row of tableMatch[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    if (/<th[\s>]/.test(row[1])) continue;          // header row
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1]));
    if (cells.length < 3) continue;
    const name = cells[0];
    if (!name || name.length > 60) continue;        // skip empty / body-object rows
    const required = cells[2].toLowerCase() === 'true';
    inputs.push(required ? `${name}*` : name);
    if (inputs.length >= 12) break;
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// Tagging (mirror of build-catalog so search stays consistent)
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'by',
  'from', 'this', 'that', 'is', 'are', 'be', 'as', 'at', 'it', 'your', 'you',
  'get', 'set', 'all', 'new', 'using', 'use', 'will', 'can', 'into', 'when',
  'api', 'id', 'ids', 'allows', 'action', 'trigger', 'connector', 'formerly', 'known',
]);
function buildTags(...fields) {
  const set = new Set();
  for (const f of fields) {
    for (const w of String(f || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
      if (w.length > 2 && !STOPWORDS.has(w)) set.add(w);
    }
  }
  return [...set].slice(0, 26);
}

// ---------------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------------
function parseConnectorPage(html, cfg) {
  const connector = cfg.connector;

  // Intro/description: first paragraph before the "Actions" section.
  let connectorDescription = '';
  const head = html.split(/id="actions"/)[0];
  const introMatch = head.match(/<p>([\s\S]*?)<\/p>/);
  if (introMatch) connectorDescription = stripTags(introMatch[1]);

  // Split into operation blocks at <h3 id="...">.
  const idxActions = html.search(/id="actions"/);
  const idxTriggers = html.search(/id="triggers"/);
  const idxDefs = html.search(/id="definitions"/);

  const h3re = /<h3[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/g;
  const blocks = [];
  let m;
  while ((m = h3re.exec(html)) !== null) {
    blocks.push({ pos: m.index, slug: m[1], name: stripTags(m[2]) });
  }

  const entries = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Only operations live between the Actions heading and the Definitions heading.
    if (idxActions >= 0 && b.pos < idxActions) continue;
    if (idxDefs >= 0 && b.pos > idxDefs) continue;

    const end = i + 1 < blocks.length ? blocks[i + 1].pos : html.length;
    const body = html.slice(b.pos, end);

    // An operation block has an "Operation ID" definition list; connection/auth
    // sections (also h3) do not, so this naturally filters them out.
    const opIdMatch = body.match(/Operation ID:\s*<\/dt>\s*<dd>\s*([A-Za-z0-9_]+)\s*<\/dd>/);
    if (!opIdMatch) continue;
    const operationId = opIdMatch[1];

    // Description: first <p> after the operation-id list.
    const afterDl = body.split(/<\/dl>/).slice(1).join('</dl>');
    const descMatch = afterDl.match(/<p>([\s\S]*?)<\/p>/);
    let description = descMatch ? stripTags(descMatch[1]) : '';
    // Trim the boilerplate "This connector was formerly known as…" tail.
    description = description.replace(/\s*This connector was formerly known as.*$/i, '').trim();

    const type = idxTriggers >= 0 && b.pos >= idxTriggers ? 'trigger' : 'action';
    const name = b.name;

    // Skip deprecated / MCP-server plumbing operations unless asked to keep them.
    if (!keepDeprecated && /deprecat|mcp server/i.test(name)) continue;

    entries.push({
      connector,
      connectorDescription,
      tier: cfg.tier || 'unknown',
      type,
      name,
      operationId,
      description,
      inputs: parseInputs(body),
      // Deep link to the exact operation on the Microsoft Learn connector reference.
      docUrl: `${BASE}/${cfg.slug}/#${b.slug}`,
      tags: buildTags(name, description, connector),
    });
  }
  return entries;
}

async function fetchPage(slug, retries = 3) {
  const url = `${BASE}/${slug}/`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(800 * Math.pow(2, attempt));
    }
  }
  return null;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const list = cfg.connectors || [];
  process.stderr.write(`Pulling ${list.length} first-party connectors from Microsoft Learn\n`);

  const all = [];
  let failed = 0;
  for (const c of list) {
    try {
      const html = await fetchPage(c.slug);
      if (!html) { process.stderr.write(`  ✗ ${c.connector} (${c.slug}): not found\n`); failed++; continue; }
      const entries = parseConnectorPage(html, c);
      if (!entries.length) { process.stderr.write(`  ⚠ ${c.connector}: 0 operations parsed\n`); failed++; continue; }
      all.push(...entries);
      const t = entries.filter((e) => e.type === 'trigger').length;
      process.stderr.write(`  ✓ ${c.connector}: ${entries.length} ops (${entries.length - t} actions / ${t} triggers)\n`);
    } catch (err) {
      process.stderr.write(`  ✗ ${c.connector} (${c.slug}): ${err.message}\n`);
      failed++;
    }
    await sleep(250);
  }

  // Robustness guard: refuse to overwrite a good catalog with a broken scrape
  // (e.g. if Microsoft changes the docs HTML and parsing silently breaks).
  if (!all.length) {
    process.stderr.write('\nNo operations parsed — leaving curated-first-party.json untouched.\n');
    process.exit(1);
  }
  if (failed > list.length / 2) {
    process.stderr.write(`\n${failed}/${list.length} connectors failed — likely a docs layout change. Leaving existing file untouched.\n`);
    process.exit(1);
  }

  // Append built-in operations that have no Learn /connectors/ page (HTTP, Request…).
  if (fs.existsSync(EXTRAS)) {
    try {
      const extras = JSON.parse(fs.readFileSync(EXTRAS, 'utf8')).operations || [];
      for (const e of extras) {
        e.tags = [...new Set([...(e.tags || []), ...buildTags(e.name, e.description, e.connector)])].slice(0, 26);
      }
      all.push(...extras);
      process.stderr.write(`  + ${extras.length} built-in extras (HTTP, Request, …)\n`);
    } catch (err) {
      process.stderr.write(`  ⚠ extras skipped: ${err.message}\n`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n');
  process.stderr.write(`\n✔ Wrote ${OUT}\n  ${all.length} operations across ${list.length} connectors\n`);
}

main().catch((err) => {
  process.stderr.write(`\nFatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
