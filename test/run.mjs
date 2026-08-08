#!/usr/bin/env node
// Runs all specs (or those whose filename contains the given substring).
//   node run.mjs            → all specs
//   node run.mjs smoke      → specs matching "smoke"
import { readdir } from 'node:fs/promises';

const filter = process.argv[2]?.replace(/^specs\//, '').replace(/\.mjs$/, '');
const dir = new URL('./specs/', import.meta.url);
let files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
if (filter) files = files.filter((f) => f.includes(filter));
if (!files.length) {
  console.error(`no specs match "${filter}"`);
  process.exit(2);
}

let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  try {
    await import(new URL(f, dir));
    console.log(`PASS ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n${e.stack}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} specs passed`);
process.exit(failed ? 1 : 0);
