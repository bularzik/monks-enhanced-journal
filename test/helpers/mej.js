// MEJ-specific test actions. Everything acts through Foundry's own API via
// page.evaluate; DOM interaction only where the UI wiring itself is under test.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connect } from './foundry.js';

export async function withSession(name, opts, fn) {
  const session = await connect(opts);
  const gm = session.pages['Gamemaster'];
  try {
    if (gm) await sweep(gm);
    await fn(session);
  } catch (e) {
    for (const [user, page] of Object.entries(session.pages)) {
      await snap(page, `${name}-${user.replaceAll(' ', '')}-fail`).catch(() => {});
    }
    const buffered = [...session.logs.values()].flat();
    if (buffered.length) e.message += `\n--- browser console ---\n${buffered.join('\n')}`;
    throw e;
  } finally {
    try { if (gm) await sweep(gm); } catch {}
    try { await session.close(); } catch (e) { console.error(`withSession: session.close() failed: ${e.stack}`); }
  }
}

export async function createEntry(gmPage, type, name, flags = {}) {
  return await gmPage.evaluate(async ({ type, name, flags }) => {
    const entry = await JournalEntry.create({
      name,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: [{
        name,
        type: `monks-enhanced-journal.${type}`,
        flags: { 'monks-enhanced-journal': { type, ...flags } },
      }],
    });
    return entry.id;
  }, { type, name, flags });
}

export async function openEntry(page, entryId) {
  const ok = await page.evaluate(async (id) => {
    const entry = game.journal.get(id);
    if (!entry) return false;
    return !!(await game.MonksEnhancedJournal.openJournalEntry(entry));
  }, entryId);
  if (!ok) throw new Error(`openJournalEntry refused entry ${entryId}`);
  await page.waitForSelector('.monks-enhanced-journal', { state: 'visible' });
}

export async function entryFlag(page, entryId, key) {
  return await page.evaluate(({ id, key }) =>
    game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', key),
    { id: entryId, key });
}

export async function setEntryFlag(page, entryId, key, value) {
  await page.evaluate(({ id, key, value }) =>
    game.journal.get(id).pages.contents[0].setFlag('monks-enhanced-journal', key, value),
    { id: entryId, key, value });
}

export async function sweep(gmPage) {
  return await gmPage.evaluate(async () => {
    let n = 0;
    for (const coll of [game.journal, game.actors, game.items]) {
      for (const doc of coll.filter((d) => d.name.startsWith('TT-'))) {
        await doc.delete();
        n++;
      }
    }
    return n;
  });
}

export async function snap(page, label) {
  const dir = fileURLToPath(new URL('../screenshots/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const path = `${dir}${label}.png`;
  await page.screenshot({ path });
  return path;
}

export async function dropOnSheet(page, selector, data) {
  await page.evaluate(({ selector, data }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`dropOnSheet: no element matches ${selector}`);
    const dt = new DataTransfer();
    dt.setData('text/plain', JSON.stringify(data));
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
  }, { selector, data });
}

export function assertNoErrors(session) {
  const errs = [...session.logs.values()].flat();
  if (errs.length) throw new Error(`browser console errors:\n${errs.join('\n')}`);
}
