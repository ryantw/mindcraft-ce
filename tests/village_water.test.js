import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initializeMinecraftData } from '../src/utils/mcdata.js';
import { setSettings } from '../src/agent/settings.js';
import { classifyFailure } from '../src/agent/action_outcome.js';
import { interruptNeedsWait, modeStartsImmediately } from '../src/agent/modes.js';
import { readEpisodes } from '../src/village/episodes.js';
import {
    avoidWaterBlocks,
    combatWaitsForLand,
    configureDryLand,
    configureSwimEscape,
    isBankStand,
    navigationMode,
    rememberWater,
    selectExit,
    shortlistExits,
    shouldAbandonExit,
    shouldEscapeWater,
    waterBlockedOutcome,
    waterEpisodeText,
} from '../src/village/water.js';

test('village travel stays dry and survival swimming is unchanged', () => {
    assert.equal(navigationMode({ village: false, inWater: false }), 'survival');
    assert.equal(navigationMode({ village: false, inWater: true }), 'survival');
    assert.equal(navigationMode({ village: true, inWater: false }), 'dry');
    assert.equal(navigationMode({ village: true, inWater: true }), 'escape');
    assert.equal(navigationMode({ village: true, inWater: true, aquatic: true }), 'swim');
    assert.equal(navigationMode({ village: true, allowWater: true }), 'swim');
});

test('accidental water is escaped and an explicit aquatic flag is not', () => {
    assert.equal(shouldEscapeWater({ inWater: true, aquatic: false }), true);
    assert.equal(shouldEscapeWater({ inWater: true, aquatic: true }), false);
    assert.equal(shouldEscapeWater({ inWater: false, aquatic: false }), false);
    assert.equal(combatWaitsForLand({ inWater: true, aquatic: false }), true);
    assert.equal(combatWaitsForLand({ inWater: false }), false);
    assert.equal(isBankStand('air', 'air', 'stone'), true);
    assert.equal(isBankStand('water', 'air', 'stone'), false);
    assert.equal(isBankStand('air', 'air', 'water'), false);
    assert.equal(isBankStand('air', 'stone', 'stone'), false);
});

test('a steep near bank loses to a reachable step farther away', () => {
    const exits = shortlistExits([
        { x: 1, y: 5, z: 0, distance: 1, climb: 3 },
        { x: 8, y: 1, z: 0, distance: 8, climb: 1 },
    ]);
    assert.equal(exits[0].x, 8);
    const rejected = new Set(['1,5,0']);
    const chosen = selectExit([
        { x: 1, y: 5, z: 0, distance: 1, climb: 3, reachable: false, cost: Infinity },
        { x: 8, y: 1, z: 0, distance: 8, climb: 1, reachable: true, cost: 14 },
        { x: 2, y: 1, z: 0, distance: 2, climb: 1, reachable: true, cost: 4 },
    ], rejected);
    assert.equal(chosen.x, 2);
    rejected.add('2,1,0');
    const next = selectExit([
        { x: 2, y: 1, z: 0, distance: 2, reachable: true, cost: 4 },
        { x: 8, y: 1, z: 0, distance: 8, reachable: true, cost: 14 },
    ], rejected);
    assert.equal(next.x, 8);
    assert.equal(selectExit([
        { x: 2, y: 1, z: 0, reachable: true, cost: 4, distance: 2 },
    ], rejected), null);
});

test('an exit that does not move is abandoned, and a moving one is kept', () => {
    assert.equal(shouldAbandonExit({ moved: 0.1, elapsedMs: 2500 }), true);
    assert.equal(shouldAbandonExit({ moved: 2, elapsedMs: 2500 }), false);
    assert.equal(shouldAbandonExit({ moved: 0, elapsedMs: 400 }), false);
});

test('dry movements refuse water and escape movements do not dig or bridge', async () => {
    await initializeMinecraftData('1.21.6');
    const movements = {
        blocksToAvoid: new Set(),
        blocksCantBreak: new Set(),
        replaceables: new Set([1, 2, 9]),
    };
    avoidWaterBlocks(movements, [1, 2]);
    assert.equal(movements.blocksToAvoid.has(1), true);
    assert.equal(movements.blocksCantBreak.has(2), true);
    assert.equal(movements.replaceables.has(1), false);
    assert.equal(movements.replaceables.has(9), true);
    const dry = {
        blocksToAvoid: new Set(),
        blocksCantBreak: new Set(),
        replaceables: new Set(),
    };
    configureDryLand(dry);
    assert.ok(dry.blocksToAvoid.size >= 1);
    const swim = configureSwimEscape({
        canDig: true,
        allow1by1towers: true,
        scafoldingBlocks: [1],
        liquidCost: 50,
        placeCost: 1,
    });
    assert.equal(swim.canDig, false);
    assert.equal(swim.allow1by1towers, false);
    assert.deepEqual(swim.scafoldingBlocks, []);
});

test('a water-blocked destination is a failure and is not retried as progress', () => {
    const reason = classifyFailure('Could not reach the destination without entering water.');
    assert.equal(reason.code, 'water_blocked');
    assert.equal(reason.condition, 'unchanged_behavior');
    const outcome = waterBlockedOutcome({
        action: 'goToCoordinates',
        params: { x: 4, y: 70, z: 9 },
        x: 4,
        y: 70,
        z: 9,
        bot: null,
    });
    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.relevantProgress, false);
    assert.equal(outcome.retry.reasonableWithoutStateChange, false);
    assert.match(waterEpisodeText('blocked'), /without entering water/);
    assert.match(waterEpisodeText('entry', { x: 1.2, y: 70.1, z: 3.8 }), /I fell into the water at 1, 70, 3/);
    assert.match(waterEpisodeText('exit', { x: 2, y: 71, z: 3 }), /onto the bank/);
});

test('water escape interrupts an outstanding model call without waiting for it', async () => {
    assert.equal(modeStartsImmediately('water_escape'), true);
    assert.equal(modeStartsImmediately('hunting'), false);
    let waited = false;
    const prompter = {
        isActive: () => true,
        loop_active: true,
        interrupt: false,
        async stopLoop() { waited = true; },
    };
    assert.equal(interruptNeedsWait('water_escape', prompter), false);
    assert.equal(prompter.interrupt, true);
    assert.equal(waited, false);
    const idleLoop = { isActive: () => true, loop_active: false, interrupt: false };
    assert.equal(interruptNeedsWait('night_sleep', idleLoop), false);
    assert.equal(idleLoop.interrupt, false);
    const ordinary = { isActive: () => true, interrupt: false };
    assert.equal(interruptNeedsWait('hunting', ordinary), true);
    assert.equal(ordinary.interrupt, false);
});

test('falling in and climbing out are each recorded once', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'water-'));
    const previous = { village_autonomy: true };
    setSettings(previous);
    try {
        const first = rememberWater(dir, 'entry', { x: 3.4, y: 64, z: 8.2 });
        const again = rememberWater(dir, 'entry', { x: 3.4, y: 64, z: 8.2 });
        const exit = rememberWater(dir, 'exit', { x: 5, y: 65, z: 8 });
        assert.equal(first.created, true);
        assert.equal(again.created, false);
        assert.equal(exit.created, true);
        const texts = readEpisodes(dir).episodes.map(episode => episode.text);
        assert.deepEqual(texts, [
            'I fell into the water at 3, 64, 8.',
            'I got out of the water onto the bank at 5, 65, 8.',
        ]);
    } finally {
        setSettings({});
        rmSync(dir, { recursive: true, force: true });
    }
});
