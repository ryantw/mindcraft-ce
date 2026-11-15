import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { isCombatTarget, isEndermanAngry, isHostile } from '../src/utils/mcdata.js';
import { villageSafetyNote } from '../src/agent/startup_goal.js';
import { renderVillageContext, SHARED_WORLD_LINE } from '../src/village/context.js';

function enderman(screaming) {
    return {
        name: 'enderman',
        type: 'hostile',
        metadata: { 17: screaming },
    };
}

test('a calm enderman is not a fight and an angry one is fled from', () => {
    assert.equal(isEndermanAngry(enderman(false)), false);
    assert.equal(isEndermanAngry(enderman(true)), true);
    assert.equal(isHostile(enderman(false)), false);
    assert.equal(isHostile(enderman(true)), true);
    assert.equal(isCombatTarget(enderman(false)), false);
    assert.equal(isCombatTarget(enderman(true)), false);
    const zombie = { name: 'zombie', type: 'hostile' };
    assert.equal(isHostile(zombie), true);
    assert.equal(isCombatTarget(zombie), true);
    assert.equal(isHostile({ name: 'wolf', type: 'hostile' }), false);
    assert.equal(isCombatTarget({ name: 'piglin_brute', type: 'hostile' }), true);
});

test('night and low health are visible without asking the model', () => {
    assert.equal(villageSafetyNote({ time: { timeOfDay: 1000 }, health: 20 }), '');
    assert.match(villageSafetyNote({ time: { timeOfDay: 13000 }, health: 18 }), /It is night/);
    assert.match(villageSafetyNote({ time: { timeOfDay: 13000 }, health: 18 }), /not required to sleep/);
    assert.match(villageSafetyNote({ time: { timeOfDay: 4000 }, health: 8 }), /health is low/);
});

test('shared survival knowledge is part of every waking prompt', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-safety-'));
    try {
        writeFileSync(path.join(parent, 'identity.json'), JSON.stringify({
            name: 'Ione',
            backstory: 'Ione keeps to the path.',
            temperament: 'quiet',
            interests: 'paths',
        }));
        const shown = renderVillageContext(parent);
        assert.equal(shown.text.includes(SHARED_WORLD_LINE), true);
        assert.match(shown.text, /neutral creature/);
        assert.match(shown.text, /enderman/);
        assert.match(shown.text, /Sleep is a choice/);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});
