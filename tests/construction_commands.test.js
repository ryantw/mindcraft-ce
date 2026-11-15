import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { executeCommand, getCommand, getCommandDocs } from '../src/agent/commands/index.js';
import { setSettings } from '../src/agent/settings.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';
import Vec3 from 'vec3';
import { createWorld, held } from './helpers/construction_world.js';

initializeMinecraftData('1.21.6');

// Stands where the test structures are within reach, so no walking is needed.
const IN_REACH = [1.5, 64, 1.0];

let originalLog;
beforeEach(() => {
    setSettings({});
    originalLog = console.log;
    console.log = () => {};
});
afterEach(() => { console.log = originalLog; });

/** A real ActionManager and executeCommand over the scripted world. */
function createAgent(world) {
    const agent = Object.create(Agent.prototype);
    Object.assign(world.bot, {
        game: { dimension: 'overworld' },
        modes: { isOn: () => false, pause() {}, unpause() {}, flushBehaviorLog: () => '' },
        emit() {},
    });
    world.bot.inventory.inventoryStart = 9;
    Object.assign(agent, {
        name: 'Sawyer',
        bot: world.bot,
        blocked_actions: [],
        clearBotLogs() { world.bot.output = ''; world.bot.interrupt_code = false; },
        requestInterrupt() { world.bot.interrupt_code = true; },
        cleanKill() {},
        isIdle: () => true,
        history: { add: async () => {}, getHistory: () => [], save() {} },
        self_prompter: { isActive: () => false, shouldInterrupt: () => false, handleUserPromptedCmd() {} },
    });
    agent.actions = new ActionManager(agent);
    return agent;
}

describe('construction commands are registered and documented', () => {
    test('the three primitives exist as action commands with the documented signatures', () => {
        assert.deepEqual(Object.keys(getCommand('!placeBlockAt').params), ['type', 'x', 'y', 'z']);
        assert.deepEqual(Object.keys(getCommand('!buildLine').params), ['type', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2']);
        assert.deepEqual(Object.keys(getCommand('!buildPlane').params), ['type', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2']);
        const docs = getCommandDocs({ blocked_actions: [], plan_manager: { enabled: false } });
        for (const name of ['!placeBlockAt', '!buildLine', '!buildPlane']) assert.match(docs, new RegExp(name));
        assert.match(docs, /never breaks or replaces/i);
    });

    test('generated code stays disabled and no cheating command was introduced', () => {
        const names = ['!placeBlockAt', '!buildLine', '!buildPlane'].map(name => getCommand(name).perform.toString()).join('\n');
        assert.doesNotMatch(names, /setblock|\/fill|creative|newAction|teleport|\/tp/);
    });
});

describe('structured outcomes report verified construction', () => {
    test('a completed wall is SUCCESS with verified counts, materials and no remainder', async () => {
        const world = createWorld({ inventory: { oak_planks: 20 }, position: IN_REACH });
        const agent = createAgent(world);
        const text = await executeCommand(agent, '!buildPlane("oak_planks", 0, 64, 3, 3, 65, 3)');

        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'success');
        assert.equal(outcome.relevantProgress, true);
        assert.equal(outcome.evidence.construction.verifiedPlaced, 8);
        assert.equal(outcome.evidence.construction.remaining, 0);
        assert.equal(outcome.evidence.construction.materialsConsumed, 8);
        assert.equal(outcome.evidence.inventory.changes.oak_planks.delta, -8);
        assert.equal(outcome.evidence.world.length, 8);
        assert.deepEqual(outcome.evidence.world[0], { kind: 'block', position: { x: 0, y: 64, z: 3 }, before: 'air', after: 'oak_planks' });
        assert.match(text, /Verified outcome: SUCCESS for buildPlane\./);
        assert.match(text, /8 verified placed, 0 already in place, 0 remaining/);
    });

    test('a placement that resolved but landed nothing is a FAILURE, never success', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, placement: { silent: () => true } });
        const agent = createAgent(world);
        const text = await executeCommand(agent, '!placeBlockAt("oak_planks", 2, 64, 0)');

        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'failure');
        assert.equal(outcome.relevantProgress, false);
        assert.equal(outcome.reason.code, 'placement_unverified');
        assert.equal(outcome.evidence.construction.verifiedPlaced, 0);
        assert.match(text, /Verified outcome: FAILURE/);
        assert.equal(outcome.retry.reasonableWithoutStateChange, false);
    });

    test('shortage gives PARTIAL with real progress; the identical retry is blocked until materials change', async () => {
        const world = createWorld({ inventory: { oak_planks: 4 }, position: IN_REACH });
        const agent = createAgent(world);
        const command = '!buildPlane("oak_planks", 0, 64, 3, 3, 65, 3)';
        const text = await executeCommand(agent, command);

        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'partial');
        assert.equal(outcome.relevantProgress, true);
        assert.equal(outcome.reason.code, 'missing_resource');
        assert.equal(outcome.evidence.construction.verifiedPlaced, 4);
        assert.equal(outcome.evidence.construction.remaining, 4);
        assert.equal(outcome.evidence.construction.materialsRequired, 8);
        assert.equal(outcome.evidence.construction.materialsHeld, 4);
        assert.equal(outcome.retry.reasonableWithoutStateChange, false);
        assert.match(text, /Verified outcome: PARTIAL for buildPlane\./);
        assert.match(text, /Blocking reasons: 4 ran out of the block/);

        const blocked = await executeCommand(agent, command);
        assert.match(blocked, /UNCHANGED BLOCKING CONDITION/);
        assert.equal(held(world, 'oak_planks'), 0);

        world.give('oak_planks', 10);
        const resumed = await executeCommand(agent, command);
        assert.match(resumed, /Verified outcome: SUCCESS/);
        assert.equal(agent.actions.getLastOutcome().evidence.construction.alreadySatisfied, 4);
    });

    test('an occupied target is a FAILURE that names the blocking block and changes nothing', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, blocks: [['cobblestone', 2, 64, 0]] });
        const agent = createAgent(world);
        await executeCommand(agent, '!placeBlockAt("oak_planks", 2, 64, 0)');
        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'failure');
        assert.equal(outcome.reason.code, 'occupied_target');
        assert.equal(outcome.evidence.construction.remainingBlocks[0].detail, 'cobblestone');
        assert.equal(world.nameAt(2, 64, 0), 'cobblestone');
    });

    test('an invalid request is an invalid_request failure and builds nothing', async () => {
        const world = createWorld({ inventory: { oak_planks: 50 } });
        const agent = createAgent(world);
        const text = await executeCommand(agent, '!buildLine("oak_planks", 0, 64, 0, 4, 64, 4)');
        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'failure');
        assert.equal(outcome.reason.code, 'invalid_request');
        assert.match(text, /axis-aligned/);
        assert.equal(world.log.placements.length, 0);
    });

    test('an already-complete structure is SUCCESS without claiming new progress', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, blocks: [['oak_planks', 1, 64, 0], ['oak_planks', 2, 64, 0]] });
        const agent = createAgent(world);
        await executeCommand(agent, '!buildLine("oak_planks", 1, 64, 0, 2, 64, 0)');
        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'success');
        assert.equal(outcome.relevantProgress, false);
        assert.equal(outcome.evidence.construction.alreadySatisfied, 2);
        assert.equal(held(world, 'oak_planks'), 5);
    });

    test('a partial plane stopped by an occupied cell cannot be repeated or dug back up', async () => {
        const world = createWorld({
            inventory: { oak_planks: 8 },
            position: IN_REACH,
            blocks: [['cobblestone', 0, 64, 2]],
        });
        const agent = createAgent(world);
        const command = '!buildLine("oak_planks", 0, 64, 0, 0, 64, 3)';
        const first = await executeCommand(agent, command);
        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'partial');
        assert.equal(outcome.reason.code, 'occupied_target');
        assert.equal(outcome.relevantProgress, false);
        assert.ok(outcome.evidence.construction.verifiedPlaced > 0);
        assert.match(outcome.behaviorKey, /^construction:oak_planks:/);
        assert.match(first, /different footprint/);
        assert.equal(world.nameAt(0, 64, 0), 'oak_planks');
        assert.equal(world.nameAt(0, 64, 2), 'cobblestone');
        assert.equal(agent.actions.recentPlacements.get('0,64,0'), 'oak_planks');

        const again = await executeCommand(agent, command);
        assert.match(again, /UNCHANGED BLOCKING CONDITION/);
        assert.equal(world.log.placements.length, outcome.evidence.construction.verifiedPlaced);

        world.bot.entity.position = new Vec3(0.5, 65, 0.5);
        world.bot.dig = async () => { throw new Error('dig should not start'); };
        const dug = await executeCommand(agent, '!digDown(1)');
        assert.match(dug, /just placed/);
        assert.equal(world.nameAt(0, 64, 0), 'oak_planks');
    });

    test('an interrupted build reports partial progress and a resumable reason', async () => {
        const world = createWorld({
            inventory: { oak_planks: 20 },
            position: IN_REACH,
            placement: { onPlace: (attempt, bot) => { if (attempt === 2) bot.interrupt_code = true; } },
        });
        const agent = createAgent(world);
        // ActionManager resets interrupt_code before running; the mid-build interrupt below is the signal.
        await executeCommand(agent, '!buildLine("oak_planks", 0, 64, 3, 4, 64, 3)');
        const outcome = agent.actions.getLastOutcome();
        assert.equal(outcome.status, 'partial');
        assert.equal(outcome.reason.code, 'interrupted');
        assert.equal(outcome.evidence.construction.verifiedPlaced, 2);
        assert.equal(outcome.evidence.construction.remaining, 3);
        assert.equal(outcome.retry.reasonableWithoutStateChange, true);
    });
});


describe('repeated guesses inside terrain get facts, then a nudge to reflect', () => {
    const buried = x => `!buildLine("cobblestone", ${x}, 60, 1, ${x}, 60, 4)`;

    test('the declined build shows what is really there, then suggests !think when the loop continues', async () => {
        const world = createWorld({ inventory: { cobblestone: 50 }, position: IN_REACH });
        const agent = createAgent(world);

        for (const x of [1, 2]) {
            const text = await executeCommand(agent, buried(x));
            assert.match(text, /Verified outcome: FAILURE/);
            assert.match(text, /Hint: most of these targets are inside solid blocks \(stone\)/);
        }

        const declined = await executeCommand(agent, buried(3));
        assert.match(declined, /UNCHANGED BLOCKING CONDITION: 2 recent construction attempts/);
        assert.match(declined, /What is actually around you: You are at \(1, 64, 1\), standing on stone\./);
        assert.match(declined, /is stone\./, 'names the block inside the requested area');
        assert.match(declined, /Open, flat 3x3 ground you could stand on nearby: \(\d+, 64, \d+\) on stone/);
        assert.doesNotMatch(declined, /!think/, 'the first decline only informs');

        const again = await executeCommand(agent, buried(4));
        assert.match(again, /declined 2 times in a row/);
        assert.match(again, /!think\("your question"\)/);
        assert.equal(world.log.forbidden, 0);
    });

    test('running anything allowed ends the streak, and other retry blocks get the nudge too', async () => {
        const world = createWorld({ inventory: { oak_planks: 4 }, position: IN_REACH });
        const agent = createAgent(world);
        const command = '!buildPlane("oak_planks", 0, 64, 3, 3, 65, 3)';
        await executeCommand(agent, command); // partial: out of planks
        assert.doesNotMatch(await executeCommand(agent, command), /!think/);
        assert.match(await executeCommand(agent, command), /!think\("your question"\)/);

        world.give('oak_planks', 10);
        await executeCommand(agent, command); // allowed again, resumes
        assert.equal(agent.actions.blockedStreak, 0);
    });
});
