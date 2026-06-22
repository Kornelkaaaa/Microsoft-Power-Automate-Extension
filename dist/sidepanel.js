// Flow Finder side panel — local-only fuzzy search over the bundled catalog.
import Fuse from './vendor/fuse.mjs';

const els = {
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  count: document.getElementById('result-count'),
  connectorFilter: document.getElementById('connector-filter'),
  clearFilters: document.getElementById('clear-filters'),
  template: document.getElementById('result-template'),
};

const RESULT_LIMIT = 200; // cap rendered rows for snappiness

const state = {
  catalog: [],
  fuse: null,
  query: '',
  types: new Set(['action', 'trigger']),
  tiers: new Set(['Standard', 'Premium', 'unknown']),
  connector: '',
  results: [],
  activeIndex: -1,
};

// --------------------------------------------------------------------------
// Load
// --------------------------------------------------------------------------
async function load() {
  try {
    const res = await fetch(chrome.runtime.getURL('catalog.json'));
    if (!res.ok) throw new Error(`catalog.json HTTP ${res.status}`);
    state.catalog = await res.json();
  } catch (err) {
    console.error('Flow Finder: failed to load catalog', err);
    renderError();
    return;
  }

  // Precompute a search blob so token matching is cheap and forgiving.
  for (const e of state.catalog) {
    e._blob = `${e.name} ${e.description} ${e.connector} ${e.tags.join(' ')}`.toLowerCase();
  }

  state.fuse = new Fuse(state.catalog, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.4,
    minMatchCharLength: 2,
    keys: [
      { name: 'name', weight: 0.4 },
      { name: 'tags', weight: 0.3 },
      { name: 'connector', weight: 0.2 },
      { name: 'description', weight: 0.1 },
    ],
  });

  populateConnectors();
  run();
}

function populateConnectors() {
  const names = [...new Set(state.catalog.map((e) => e.connector))].sort((a, b) =>
    a.localeCompare(b));
  const frag = document.createDocumentFragment();
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    frag.appendChild(opt);
  }
  els.connectorFilter.appendChild(frag);
}

// --------------------------------------------------------------------------
// Search + filter
// --------------------------------------------------------------------------
const STOPWORDS = new Set(['the','a','an','and','or','to','of','in','on','for','with','by',
  'from','this','that','is','are','be','as','at','it','your','you','will','can','into','when','until','i']);

function tokenize(q) {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function passesFilters(e) {
  if (!state.types.has(e.type)) return false;
  if (!state.tiers.has(e.tier)) return false;
  if (state.connector && e.connector !== state.connector) return false;
  return true;
}

// Forgiving token-overlap score against the precomputed blob.
// Handles queries like "wait until file approved" or "send message teams"
// where no single exact phrase exists but the keywords do.
function tokenScore(e, tokens) {
  let hits = 0;
  for (const t of tokens) {
    if (e._blob.includes(t)) hits += 1;
  }
  return hits / tokens.length; // 0..1 fraction of query tokens present
}

function search() {
  const q = state.query.trim();
  const filtered = state.catalog.filter(passesFilters);

  if (!q) {
    // No query: show filtered catalog, connectors grouped, triggers first-ish by name.
    return filtered
      .slice()
      .sort((a, b) =>
        a.connector.localeCompare(b.connector) ||
        a.type.localeCompare(b.type) ||
        a.name.localeCompare(b.name));
  }

  const tokens = tokenize(q);
  const filteredSet = new Set(filtered);

  // 1) Fuzzy results from Fuse (typo-tolerant, ranked).
  const fuzzy = state.fuse.search(q, { limit: 400 });

  const scored = new Map(); // entry -> combined score (lower = better)
  for (const r of fuzzy) {
    if (!filteredSet.has(r.item)) continue;
    scored.set(r.item, r.score ?? 1);
  }

  // 2) Token-overlap boost across the filtered set — rescues multi-word,
  //    out-of-order, keyword-style queries that Fuse ranks poorly.
  for (const e of filtered) {
    const overlap = tokenScore(e, tokens); // 0..1
    if (overlap === 0) continue;
    // Convert overlap to a Fuse-like score (1 - overlap), then take the best
    // of fuzzy/token scores so strong keyword matches always surface.
    const tScore = 1 - overlap * 0.95;
    const prev = scored.has(e) ? scored.get(e) : 1;
    scored.set(e, Math.min(prev, tScore));
  }

  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].connector.localeCompare(b[0].connector))
    .map((x) => x[0]);
}

function run() {
  state.results = search();
  state.activeIndex = -1;
  render();
}

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------
function highlight(text, tokens) {
  if (!tokens.length || !text) return text;
  const esc = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
  if (!esc.length) return text;
  const re = new RegExp(`(${esc.join('|')})`, 'gi');
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    frag.appendChild(mark);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function render() {
  els.results.replaceChildren();

  // First-run / idle: no query and no filters → friendly welcome instead of
  // dumping the entire catalog at the user.
  if (state.catalog.length && !state.query.trim() && !hasActiveFilters()) {
    els.count.textContent = `${state.catalog.length.toLocaleString()} actions & triggers — start searching`;
    els.clearFilters.hidden = true;
    els.results.appendChild(welcomeState());
    return;
  }

  const total = state.results.length;
  const shown = Math.min(total, RESULT_LIMIT);
  const tokens = tokenize(state.query);

  // Count label
  if (state.catalog.length === 0) {
    els.count.textContent = 'Loading…';
  } else if (total === 0) {
    els.count.textContent = '0 results';
  } else {
    els.count.textContent = total > RESULT_LIMIT
      ? `Showing ${shown} of ${total} results`
      : `${total} result${total === 1 ? '' : 's'}`;
  }

  els.clearFilters.hidden = !hasActiveFilters();

  if (total === 0) {
    els.results.appendChild(emptyState());
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown; i++) {
    frag.appendChild(renderCard(state.results[i], i, tokens));
  }
  els.results.appendChild(frag);
}

function renderCard(entry, index, tokens) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.dataset.index = index;

  const connectorEl = node.querySelector('.card-connector');
  connectorEl.replaceChildren(highlight(entry.connector, tokens));

  const nameEl = node.querySelector('.card-name');
  nameEl.replaceChildren(highlight(entry.name, tokens));

  const typeBadge = node.querySelector('.badge-type');
  typeBadge.textContent = entry.type === 'trigger' ? 'Trigger' : 'Action';
  typeBadge.dataset.type = entry.type;

  const tierBadge = node.querySelector('.badge-tier');
  tierBadge.textContent = entry.tier;
  tierBadge.dataset.tier = entry.tier;

  const descEl = node.querySelector('.card-desc');
  if (entry.description) {
    descEl.replaceChildren(highlight(entry.description, tokens));
  } else {
    descEl.textContent = 'No description provided.';
    descEl.style.fontStyle = 'italic';
  }

  node.querySelector('.card-opid').textContent = entry.operationId;

  node.addEventListener('click', () => toggleExpand(node));
  node.addEventListener('focus', () => setActive(index, false));
  return node;
}

function toggleExpand(node) {
  const expanded = node.classList.toggle('is-expanded');
  node.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

// Example searches phrased the way a real user would describe a use case.
const EXAMPLE_QUERIES = [
  'send an email',
  'when a file is created',
  'post a message in teams',
  'add a row to dataverse',
  'wait for approval',
  'create calendar event',
  'call an http api',
  'when a new email arrives',
];

// Connectors to surface as quick browse chips (only those present in the catalog).
const SUGGESTED_CONNECTORS = [
  'SharePoint', 'Office 365 Outlook', 'Microsoft Teams',
  'Microsoft Dataverse', 'HTTP',
];

// Fill the search box with a query and run it (used by example chips).
function applyQuery(q) {
  els.search.value = q;
  state.query = q;
  run();
  els.search.focus();
}

// Jump straight to a connector via the dropdown filter (used by browse chips).
function browseConnector(name) {
  state.connector = name;
  els.connectorFilter.value = name;
  els.search.value = '';
  state.query = '';
  run();
}

function chip(label, onClick, kind = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip ${kind}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Friendly first-run / idle screen with clickable starters.
function welcomeState() {
  const wrap = document.createElement('div');
  wrap.className = 'welcome';

  const intro = document.createElement('div');
  intro.className = 'welcome-intro';
  intro.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
    <h3>What do you want your flow to do?</h3>
    <p>Describe it in your own words, or pick a starting point below. ${state.catalog.length.toLocaleString()} actions &amp; triggers are searchable.</p>`;
  wrap.appendChild(intro);

  const ex = document.createElement('div');
  ex.className = 'chip-group';
  ex.innerHTML = '<span class="chip-label">Try a search</span>';
  const exRow = document.createElement('div');
  exRow.className = 'chip-row';
  EXAMPLE_QUERIES.forEach((q) => exRow.appendChild(chip(q, () => applyQuery(q))));
  ex.appendChild(exRow);
  wrap.appendChild(ex);

  const present = new Set(state.catalog.map((e) => e.connector));
  const available = SUGGESTED_CONNECTORS.filter((c) => present.has(c));
  if (available.length) {
    const br = document.createElement('div');
    br.className = 'chip-group';
    br.innerHTML = '<span class="chip-label">Browse a connector</span>';
    const brRow = document.createElement('div');
    brRow.className = 'chip-row';
    available.forEach((c) => brRow.appendChild(chip(c, () => browseConnector(c), 'chip-connector')));
    br.appendChild(brRow);
    wrap.appendChild(br);
  }

  const tip = document.createElement('p');
  tip.className = 'welcome-tip';
  tip.innerHTML = 'Tip: press <kbd>/</kbd> to jump to search, <kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>Enter</kbd> to expand.';
  wrap.appendChild(tip);
  return wrap;
}

// No-results state for an active query or filter set.
function emptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'state';
  wrap.innerHTML = `
    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
    <h3>No matching blocks</h3>
    <p>Try fewer or different words — search is forgiving, so keywords work better than full sentences.</p>`;
  if (hasActiveFilters()) {
    const btn = document.createElement('button');
    btn.className = 'reset-inline';
    btn.textContent = 'Reset filters';
    btn.addEventListener('click', () => els.clearFilters.click());
    wrap.appendChild(btn);
  }
  return wrap;
}

function renderError() {
  els.count.textContent = '';
  els.results.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'state';
  wrap.innerHTML = `<h3>Couldn’t load the catalog</h3>
    <p>catalog.json is missing from the build. Run <code>npm run build:catalog</code> then <code>npm run build</code>.</p>`;
  els.results.appendChild(wrap);
}

// --------------------------------------------------------------------------
// Keyboard navigation
// --------------------------------------------------------------------------
function cards() {
  return [...els.results.querySelectorAll('.card')];
}

function setActive(index, scroll = true) {
  const list = cards();
  list.forEach((c) => c.classList.remove('is-active'));
  if (index < 0 || index >= list.length) { state.activeIndex = -1; return; }
  state.activeIndex = index;
  const el = list[index];
  el.classList.add('is-active');
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

function moveActive(delta) {
  const list = cards();
  if (!list.length) return;
  let next = state.activeIndex + delta;
  if (next < 0) next = 0;
  if (next >= list.length) next = list.length - 1;
  setActive(next);
  list[next].focus({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  // "/" focuses search from anywhere (unless already typing in it).
  if (e.key === '/' && document.activeElement !== els.search) {
    e.preventDefault();
    els.search.focus();
    els.search.select();
    return;
  }

  const inSearch = document.activeElement === els.search;

  if (e.key === 'ArrowDown') {
    if (inSearch) return; // handled by the search-box listener below
    e.preventDefault();
    if (state.activeIndex < 0) setActiveFirst(); else moveActive(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (inSearch) return;
    if (state.activeIndex <= 0) { els.search.focus(); setActive(-1); return; }
    moveActive(-1);
  } else if (e.key === 'Enter') {
    if (state.activeIndex >= 0) {
      const el = cards()[state.activeIndex];
      if (el) { e.preventDefault(); toggleExpand(el); }
    }
  } else if (e.key === 'Escape') {
    if (inSearch && els.search.value) {
      els.search.value = '';
      state.query = '';
      run();
    } else {
      setActive(-1);
      els.search.focus();
    }
  }
});

function setActiveFirst() {
  if (cards().length) { setActive(0); cards()[0].focus({ preventScroll: true }); }
}

// Down arrow from the search box jumps into results.
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActiveFirst();
  }
});

// --------------------------------------------------------------------------
// Filter wiring
// --------------------------------------------------------------------------
function hasActiveFilters() {
  return state.types.size < 2 || state.tiers.size < 3 || state.connector !== '';
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

els.search.addEventListener('input', debounce((e) => {
  state.query = e.target.value;
  run();
}, 90));

document.querySelectorAll('[data-type-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.typeToggle;
    if (state.types.has(t)) state.types.delete(t); else state.types.add(t);
    if (state.types.size === 0) state.types.add(t); // keep at least one
    btn.classList.toggle('is-active', state.types.has(t));
    btn.setAttribute('aria-pressed', state.types.has(t) ? 'true' : 'false');
    run();
  });
});

document.querySelectorAll('[data-tier-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tierToggle;
    if (state.tiers.has(t)) {
      state.tiers.delete(t);
      // Standard toggle also governs the "unknown" tier bucket alongside it.
      if (t === 'Standard') state.tiers.delete('unknown');
    } else {
      state.tiers.add(t);
      if (t === 'Standard') state.tiers.add('unknown');
    }
    btn.classList.toggle('is-active', state.tiers.has(t));
    btn.setAttribute('aria-pressed', state.tiers.has(t) ? 'true' : 'false');
    run();
  });
});

els.connectorFilter.addEventListener('change', (e) => {
  state.connector = e.target.value;
  run();
});

els.clearFilters.addEventListener('click', () => {
  state.types = new Set(['action', 'trigger']);
  state.tiers = new Set(['Standard', 'Premium', 'unknown']);
  state.connector = '';
  els.connectorFilter.value = '';
  document.querySelectorAll('[data-type-toggle],[data-tier-toggle]').forEach((b) => {
    b.classList.add('is-active');
    b.setAttribute('aria-pressed', 'true');
  });
  run();
});

load();
