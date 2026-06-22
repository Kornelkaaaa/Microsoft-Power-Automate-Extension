#!/usr/bin/env node
/**
 * build.js — assemble the loadable unpacked extension into /dist.
 *
 * No bundler: copies src/ (manifest, html, css, js, vendored Fuse.js, icons)
 * and the generated public/catalog.json into a single /dist folder that Chrome
 * loads directly via chrome://extensions → Load unpacked.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CATALOG = path.join(ROOT, 'public', 'catalog.json');
const DIST = path.join(ROOT, 'dist');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error('src/ not found');
  if (!fs.existsSync(path.join(SRC, 'vendor', 'fuse.mjs'))) {
    throw new Error('src/vendor/fuse.mjs missing — vendored Fuse.js is required.');
  }
  if (!fs.existsSync(CATALOG)) {
    throw new Error('public/catalog.json missing — run `npm run build:catalog` first.');
  }

  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  // Copy all source files.
  fs.cpSync(SRC, DIST, { recursive: true });

  // Drop the catalog at the extension root so fetch('catalog.json') resolves.
  fs.copyFileSync(CATALOG, path.join(DIST, 'catalog.json'));

  // Report.
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const sizeKb = Math.round(fs.statSync(CATALOG).size / 1024);
  process.stdout.write(
    `✔ Built dist/\n` +
    `  ${catalog.length} catalog entries (${sizeKb} KB)\n` +
    `  Load via chrome://extensions → Developer mode → Load unpacked → dist/\n`,
  );
}

main();
