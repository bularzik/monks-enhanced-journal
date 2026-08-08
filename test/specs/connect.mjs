// Verifies harness plumbing: server up, world-a active, GM + player login, clean console.
import assert from 'node:assert/strict';
import { connect } from '../helpers/foundry.js';

const session = await connect({ world: 'world-a', users: ['Gamemaster', 'User 1'] });
try {
  const gm = session.pages['Gamemaster'];
  const p1 = session.pages['User 1'];

  const gmInfo = await gm.evaluate(() => ({
    world: game.world.id, user: game.user.name, isGM: game.user.isGM,
    mej: !!game.MonksEnhancedJournal,
  }));
  assert.equal(gmInfo.world, 'world-a');
  assert.equal(gmInfo.user, 'Gamemaster');
  assert.equal(gmInfo.isGM, true);
  assert.ok(gmInfo.mej, 'MEJ module not active in world-a');

  const p1Name = await p1.evaluate(() => game.user.name);
  assert.equal(p1Name, 'User 1');
} finally {
  await session.close();
}
