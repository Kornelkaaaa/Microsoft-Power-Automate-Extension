#!/usr/bin/env node
/**
 * build-catalog.js — Flow Finder catalog builder
 *
 * Fetches connector definitions from microsoft/PowerPlatformConnectors
 * (MIT-licensed code, CC-BY-4.0 docs) and flattens every connector operation
 * into a single public/catalog.json array.
 *
 * Data source: https://github.com/microsoft/PowerPlatformConnectors
 *   - certified-connectors/<Name>/apiDefinition.swagger.json + apiProperties.json
 *   - independent-publisher-connectors/<Name>/...
 *
 * No API key / auth required. Uses the public GitHub REST API (only to list
 * folder names) and raw.githubusercontent.com (to fetch files) unauthenticated,
 * with retry + delay to ride out transient rate limits.
 *
 * Requires Node 18+ (uses the global `fetch`). No npm dependencies.
 *
 * Usage:
 *   node scripts/build-catalog.js                 # default: certified + independent, capped
 *   node scripts/build-catalog.js --full          # fetch every connector (slow)
 *   node scripts/build-catalog.js --limit 80      # cap connectors per folder
 *   node scripts/build-catalog.js --no-independent # certified only
 *   node scripts/build-catalog.js --no-curated    # skip the curated first-party supplement
 *   node scripts/build-catalog.js --branch dev    # override branch (default: repo default)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = 'microsoft/PowerPlatformConnectors';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const UA = 'flow-finder-catalog-builder';

const OUT_DIR = path.join(__dirname, '..', 'public');
const OUT_FILE = path.join(OUT_DIR, 'catalog.json');
const CURATED_FILE = path.join(__dirname, 'curated-first-party.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    full: false,
    limit: 120,        // per-folder cap unless --full
    independent: true,
    curated: true,
    branch: null,      // resolved from repo default when null
    delayMs: 60,       // polite delay between raw fetches
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--no-independent') args.independent = false;
    else if (a === '--no-curated') args.curated = false;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--delay') args.delayMs = parseInt(argv[++i], 10);
  }
  return args;
}

// ---------------------------------------------------------------------------
// HTTP helpers with retry/backoff
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, { json = false, retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' } });
      if (res.status === 403 || res.status === 429) {
        // Rate limited — honor reset header if present, else exponential backoff.
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const now = Math.floor(Date.now() / 1000);
        let waitMs = Math.min(60000, 1000 * Math.pow(2, attempt));
        if (reset && reset > now) waitMs = Math.min(60000, (reset - now) * 1000 + 500);
        process.stderr.write(`  rate limited (${res.status}); waiting ${Math.round(waitMs / 1000)}s...\n`);
        await sleep(waitMs);
        continue;
      }
      if (res.status === 404) return null; // missing file — caller decides
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return json ? res.json() : res.text();
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(8000, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new Error(`failed: ${url}`);
}

async function resolveBranch(explicit) {
  if (explicit) return explicit;
  try {
    const meta = await fetchWithRetry(`${API}/repos/${REPO}`, { json: true });
    return (meta && meta.default_branch) || 'dev';
  } catch {
    return 'dev';
  }
}

async function listConnectors(folder, branch) {
  // GitHub contents API returns up to 1000 entries — enough for each folder.
  const url = `${API}/repos/${REPO}/contents/${folder}?ref=${branch}`;
  const items = await fetchWithRetry(url, { json: true });
  if (!Array.isArray(items)) return [];
  return items.filter((i) => i.type === 'dir').map((i) => i.name);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'by',
  'from', 'this', 'that', 'is', 'are', 'be', 'as', 'at', 'it', 'your', 'you',
  'get', 'set', 'all', 'new', 'using', 'use', 'will', 'can', 'into', 'when',
  'api', 'id', 'ids',
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function buildTags(...fields) {
  const set = new Set();
  for (const f of fields) for (const t of tokenize(f)) set.add(t);
  return [...set].slice(0, 24);
}

// Detect tier/premium status from apiProperties.json (best-effort; often absent).
// `defaultTier` is the folder-based fallback used when nothing explicit is found:
// in Power Automate, virtually all non-first-party certified and independent-
// publisher connectors require a Premium license, so we default those to Premium
// rather than the less useful "unknown".
function detectTier(apiProperties, defaultTier = 'unknown') {
  if (apiProperties && apiProperties.properties) {
    const p = apiProperties.properties;
    const raw = (p.tier || (p.metadata && p.metadata.tier) || '').toString().toLowerCase();
    if (raw.includes('premium')) return 'Premium';
    if (raw.includes('standard')) return 'Standard';
  }
  return defaultTier;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

function isTrigger(op, pathKey) {
  if (op && op['x-ms-trigger']) return true;            // single/batch trigger marker
  if (op && op['x-ms-trigger-hint']) return true;
  const tags = (op && op.tags) || [];
  if (tags.some((t) => String(t).toLowerCase().includes('trigger'))) return true;
  if (/\btrigger/i.test(op && op.operationId || '')) return true;
  if (/\/trigger/i.test(pathKey || '')) return true;
  return false;
}

// Extract a compact input list from a swagger operation's parameters.
// Required parameters are marked with a trailing "*". $ref params are skipped
// (they can't be resolved without the shared parameters section).
function buildInputs(op) {
  if (!Array.isArray(op.parameters)) return [];
  const inputs = [];
  for (const p of op.parameters) {
    if (!p || typeof p !== 'object' || p.$ref) continue;
    if (p.in === 'header') continue;
    const name = p['x-ms-summary'] || p.name;
    if (!name) { if (p.in === 'body') inputs.push('Body'); continue; }
    inputs.push(p.required ? `${name}*` : name);
    if (inputs.length >= 12) break;
  }
  return inputs;
}

function parseConnector(swagger, apiProperties, defaultTier = 'unknown', sourceUrl = '') {
  if (!swagger || !swagger.info || !swagger.paths) return [];
  const connector = swagger.info.title || 'Untitled connector';
  const connectorDescription = (swagger.info.description || '').trim();
  const tier = detectTier(apiProperties, defaultTier);
  const entries = [];

  for (const [pathKey, pathItem] of Object.entries(swagger.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!op || typeof op !== 'object') continue;
      const operationId = op.operationId || `${method}${pathKey}`;
      const name = (op.summary || op.operationId || `${method.toUpperCase()} ${pathKey}`).trim();
      const description = (op.description || op.summary || '').trim();
      const type = isTrigger(op, pathKey) ? 'trigger' : 'action';
      entries.push({
        connector,
        connectorDescription,
        tier,
        type,
        name,
        operationId,
        description,
        inputs: buildInputs(op),
        docUrl: sourceUrl,
        tags: buildTags(name, description, connector),
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function harvestFolder(folder, branch, args) {
  // Third-party connectors are almost universally Premium-licensed in Power Automate.
  const defaultTier = 'Premium';
  process.stderr.write(`\nListing ${folder} ...\n`);
  let names = await listConnectors(folder, branch);
  process.stderr.write(`  ${names.length} connector folders found\n`);
  if (!args.full && names.length > args.limit) {
    names = names.slice(0, args.limit);
    process.stderr.write(`  capped to ${names.length} (use --full for all)\n`);
  }

  const all = [];
  let ok = 0;
  let skipped = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const enc = encodeURIComponent(name).replace(/%2F/g, '/');
    const base = `${RAW}/${REPO}/${branch}/${folder}/${enc}`;
    try {
      const swagger = await fetchWithRetry(`${base}/apiDefinition.swagger.json`, { json: true });
      if (!swagger) { skipped++; continue; }
      // apiProperties is optional; tolerate it being missing or malformed.
      let apiProperties = null;
      try {
        apiProperties = await fetchWithRetry(`${base}/apiProperties.json`, { json: true });
      } catch { /* ignore — tier falls back to unknown */ }

      const sourceUrl = `https://github.com/${REPO}/tree/${branch}/${folder}/${enc}`;
      const entries = parseConnector(swagger, apiProperties, defaultTier, sourceUrl);
      if (entries.length) { all.push(...entries); ok++; }
      else skipped++;
    } catch (err) {
      skipped++;
      process.stderr.write(`  skip "${name}": ${err.message}\n`);
    }
    if ((i + 1) % 25 === 0) process.stderr.write(`  ...${i + 1}/${names.length}\n`);
    await sleep(args.delayMs);
  }
  process.stderr.write(`  ${folder}: ${ok} connectors parsed, ${skipped} skipped\n`);
  return all;
}

async function main() {
  const args = parseArgs(process.argv);
  const branch = await resolveBranch(args.branch);
  process.stderr.write(`Flow Finder catalog builder\nRepo: ${REPO}@${branch}\n`);

  let catalog = [];

  try {
    catalog.push(...(await harvestFolder('certified-connectors', branch, args)));
    if (args.independent) {
      catalog.push(...(await harvestFolder('independent-publisher-connectors', branch, args)));
    }
  } catch (err) {
    process.stderr.write(`\nLive fetch failed (${err.message}).\n`);
  }

  // Curated first-party supplement: the big Microsoft connectors users expect
  // (SharePoint, Outlook 365, Teams, Dataverse, HTTP) are NOT in the public
  // repo, so we ship a small, accurate hand-maintained set alongside.
  if (args.curated && fs.existsSync(CURATED_FILE)) {
    try {
      const curated = JSON.parse(fs.readFileSync(CURATED_FILE, 'utf8'));
      if (Array.isArray(curated)) {
        // Enrich each curated entry's tags with auto-generated keywords from
        // name + description + connector, so search stays forgiving even when
        // the hand-written tags are sparse.
        for (const e of curated) {
          const auto = buildTags(e.name, e.description, e.connector);
          const provided = Array.isArray(e.tags) ? e.tags : [];
          e.tags = [...new Set([...provided, ...auto])].slice(0, 28);
        }
        catalog.push(...curated);
        process.stderr.write(`\nMerged ${curated.length} curated first-party entries\n`);
      }
    } catch (err) {
      process.stderr.write(`Could not read curated supplement: ${err.message}\n`);
    }
  }

  if (!catalog.length) {
    process.stderr.write('\nNo entries produced. Aborting without overwriting catalog.json.\n');
    process.exit(1);
  }

  // De-duplicate on connector + operationId + type.
  const seen = new Set();
  const deduped = catalog.filter((e) => {
    const k = `${e.connector}::${e.operationId}::${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Stable sort: connector, then triggers/actions, then name.
  deduped.sort((a, b) =>
    a.connector.localeCompare(b.connector) ||
    a.type.localeCompare(b.type) ||
    a.name.localeCompare(b.name));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(deduped, null, 0));

  const connectors = new Set(deduped.map((e) => e.connector));
  const triggers = deduped.filter((e) => e.type === 'trigger').length;
  process.stderr.write(
    `\n✔ Wrote ${OUT_FILE}\n` +
    `  ${deduped.length} entries across ${connectors.size} connectors\n` +
    `  ${triggers} triggers / ${deduped.length - triggers} actions\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\nFatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
