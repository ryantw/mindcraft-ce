import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import { ActionManager } from '../src/agent/action_manager.js';
import { updateRepeatCounts } from '../src/agent/action_outcome.js';
import { executeCommand } from '../src/agent/commands/index.js';
import { collectionResultFeedback } from '../src/agent/library/skills.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

const registry = minecraftData('1.21.6');
initializeMinecraftData('1.21.6');

function itemStack(name, count, slot) {
    return { name, count, slot, type: registry.itemsByName[name].id, stackSize: registry.itemsByName[name].stackSize };
}

/**
 * A small world: `blocks` maps "x,y,z" to a block name; everything else is air.
 * `onCollect(ctx)` scripts what the (mocked) collectblock library does for the
 * targeted block: it may break it, add inventory, move the bot, or throw.
 */
function createWorld({ inventory={ stone_pickaxe: 1 }, blocks=[], onCollect }) {
    const world = new Map();
    const air = position => ({ name: 'air', type: 0, position, metadata: 0, canHarvest: () => true, boundingBox: 'empty', shapes: [] });
    function makeBlock(name, position) {
        const data = registry.blocksByName[name];
        return {
            name,
            type: data.id,
            position,
            metadata: 0,
            boundingBox: data.boundingBox,
            shapes: data.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
            diggable: true,
            material: data.material,
            hardness: data.hardness,
            canHarvest: () => true,
        };
    }
    for (const [name, x, y, z] of blocks) world.set(`${x},${y},${z}`, makeBlock(name, new Vec3(x, y, z)));

    const bot = {
        output: '',
        interrupt_code: false,
        entities: {},
        entity: { position: new Vec3(0, 64, 0) },
        registry,
        heldItem: null,
        modes: { isOn: () => false, pause() {}, unpause() {} },
        inventory: {
            inventoryStart: 9,
            slots: Array(46).fill(null),
            items() { return this.slots.filter(Boolean); },
            findInventoryItem(name) { return this.slots.find(slot => slot?.name === name) || null; },
        },
        blockAt: position => world.get(`${position.x},${position.y},${position.z}`) || air(position),
        findBlocks: ({ matching, maxDistance=64, count=1 }) => {
            const found = [];
            for (const block of world.values()) {
                if (bot.entity.position.distanceTo(block.position) <= maxDistance && matching(block)) found.push(block.position);
            }
            found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
            return found.slice(0, count);
        },
        tool: { equipForBlock: async () => {} },
        chat() {},
        emit() {},
    };
    Object.entries(inventory).forEach(([name, count], index) => {
        bot.inventory.slots[9 + index] = itemStack(name, count, 9 + index);
    });
    const api = {
        bot,
        world,
        add(name, count) {
            const existing = bot.inventory.slots.find(slot => slot?.name === name);
            if (existing) existing.count += count;
            else {
                const free = bot.inventory.slots.findIndex((slot, index) => index >= 9 && index < 45 && !slot);
                bot.inventory.slots[free] = itemStack(name, count, free);
            }
        },
        breakBlock(block) { world.delete(`${block.position.x},${block.position.y},${block.position.z}`); },
    };
    bot.collectBlock = {
        collect: async block => onCollect({ ...api, block }),
        cancelTask: async () => {},
    };
    return api;
}

function createAgent(bot) {
    const agent = {
        name: 'Rowan',
        bot,
        kills: [],
        history: { add: async () => {} },
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        requestInterrupt() { bot.interrupt_code = true; },
        cleanKill(reason) { agent.kills.push(reason); },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

async function collect(scenario, command) {
    const sim = createWorld(scenario);
    const agent = createAgent(sim.bot);
    const feedback = await executeCommand(agent, command);
    return { sim, agent, feedback, outcome: agent.actions.getLastOutcome() };
}

test('incidental cobblestone without raw_iron is not collection progress', async () => {
    // The bot tunnels toward iron: 4 cobblestone arrive, the ore is never mined.
    const { outcome, feedback } = await collect({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ add }) => add('cobblestone', 4),
    }, '!collectBlocks("iron_ore", 1)');

    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.relevantProgress, false);
    assert.equal(outcome.success, false);
    assert.equal(outcome.reason.code, 'expected_drops_missing');
    assert.equal(outcome.retry.reasonableWithoutStateChange, false);
    assert.equal(outcome.evidence.collection.targetGained, 0);
    assert.equal(outcome.evidence.collection.incidentalGained, 4);
    assert.equal(outcome.evidence.collection.incidentalChanges.cobblestone.delta, 4);
    // Diagnostics still list the incidental change; human-readable feedback is kept.
    assert.equal(outcome.evidence.inventory.changes.cobblestone.delta, 4);
    assert.match(feedback, /Verified outcome: FAILURE/);
    assert.match(feedback, /cobblestone \+4/);
});

test('breaking the ore but obtaining only incidental items is still a failure', async () => {
    const { outcome } = await collect({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('cobblestone', 4); },
    }, '!collectBlocks("iron_ore", 1)');

    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.relevantProgress, false);
    assert.equal(outcome.evidence.collection.harvestedBlocks, 1);
    assert.match(outcome.reason.message, /none of the expected drops \(.*raw_iron.*\)/);
});

test('a stalled approach that throws is also not progress when cobblestone was mined', async () => {
    const { outcome } = await collect({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ add }) => {
            add('cobblestone', 3);
            const error = new Error('no meaningful progress for 20 seconds');
            error.name = 'CollectionStalled';
            throw error;
        },
    }, '!collectBlocks("iron_ore", 1)');

    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.relevantProgress, false);
    assert.equal(outcome.reason.code, 'target_unavailable');
});

test('harvesting the requested block and obtaining raw_iron succeeds', async () => {
    const { outcome, feedback } = await collect({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('raw_iron', 1); },
    }, '!collectBlocks("iron_ore", 1)');

    assert.equal(outcome.status, 'success');
    assert.equal(outcome.relevantProgress, true);
    assert.deepEqual(outcome.evidence.collectedItemDeltas, { raw_iron: 1 });
    assert.equal(outcome.evidence.collection.harvestedBlocks, 1);
    assert.match(feedback, /Harvested 1 iron_ore block/);
});

test('harvesting 2 of 5 requested blocks with their drops is partial success', async () => {
    const { outcome } = await collect({
        blocks: [['iron_ore', 5, 64, 0], ['iron_ore', 7, 64, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('raw_iron', 1); },
    }, '!collectBlocks("iron_ore", 5)');

    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.relevantProgress, true);
    assert.equal(outcome.evidence.harvested, 2);
    assert.equal(outcome.evidence.requested, 5);
    assert.deepEqual(outcome.evidence.collectedItemDeltas, { raw_iron: 2 });
});

test('3 oak_log with incidental items succeeds and keeps the incidental diagnostics', async () => {
    const { outcome } = await collect({
        blocks: [['oak_log', 4, 64, 0], ['oak_log', 4, 65, 0], ['oak_log', 4, 66, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('oak_log', 1); add('stick', 1); },
    }, '!collectBlocks("oak_log", 3)');

    assert.equal(outcome.status, 'success');
    assert.equal(outcome.evidence.collection.targetChanges.oak_log.delta, 3);
    assert.equal(outcome.evidence.collection.incidentalChanges.stick.delta, 3);
    assert.deepEqual(outcome.evidence.collectedItemDeltas, { oak_log: 3 });
});

test('Silk Touch yielding the ore block itself counts as the expected drop', async () => {
    const { outcome } = await collect({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('iron_ore', 1); },
    }, '!collectBlocks("iron_ore", 1)');

    assert.equal(outcome.status, 'success');
    assert.deepEqual(outcome.evidence.collectedItemDeltas, { iron_ore: 1 });
});

test('Fortune: more items than blocks is success, never a count mismatch', async () => {
    const { outcome } = await collect({
        blocks: [['coal_ore', 4, 64, 0], ['coal_ore', 5, 64, 0], ['coal_ore', 6, 64, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('coal', block.position.x === 6 ? 3 : 1); },
    }, '!collectBlocks("coal_ore", 3)');

    assert.equal(outcome.status, 'success');
    assert.deepEqual(outcome.evidence.collectedItemDeltas, { coal: 5 });
});

test('variable and chance drops: flint instead of gravel is success; no drops at all is not', async () => {
    const flint = await collect({
        blocks: [['gravel', 4, 64, 0], ['gravel', 5, 64, 0]],
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('flint', 1); },
    }, '!collectBlocks("gravel", 2)');
    assert.equal(flint.outcome.status, 'success');
    assert.equal(flint.outcome.evidence.collection.minimumExpected, 0);

    const none = await collect({
        blocks: [['gravel', 4, 64, 0]],
        onCollect: ({ block, breakBlock }) => breakBlock(block),
    }, '!collectBlocks("gravel", 1)');
    assert.equal(none.outcome.status, 'failure');
    assert.equal(none.outcome.relevantProgress, false);
});

test('fewer drops than the guaranteed per-block minimum is only partial', async () => {
    const { outcome } = await collect({
        blocks: [['iron_ore', 4, 64, 0], ['iron_ore', 5, 64, 0], ['iron_ore', 6, 64, 0]],
        // Three blocks broken, but only two raw_iron arrive (one drop was lost).
        onCollect: ({ block, breakBlock, add }) => { breakBlock(block); if (block.position.x !== 6) add('raw_iron', 1); },
    }, '!collectBlocks("iron_ore", 3)');

    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.evidence.collection.minimumExpected, 3);
    assert.equal(outcome.evidence.collection.targetGained, 2);
});

test('a collect call that resolves without removing the block does not count as harvested', async () => {
    const { outcome } = await collect({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ add }) => add('raw_iron', 1), // e.g. a picked-up stray item; block untouched
    }, '!collectBlocks("iron_ore", 1)');

    assert.equal(outcome.evidence.collection.harvestedBlocks, 0);
    // The expected item did arrive, so this is partial progress, never full success.
    assert.equal(outcome.status, 'partial');
});

test('collection feedback separates expected drops from incidental gains', () => {
    const missing = collectionResultFeedback('iron_ore', 1, {}, { cobblestone: 4 }, ['raw_iron', 'iron_ore']);
    assert.equal(missing.success, false);
    assert.match(missing.message, /no collected items were confirmed/i);
    assert.match(missing.message, /expected: raw_iron, iron_ore/);
    assert.match(missing.message, /Incidental gains \(not collection progress\): cobblestone \+4/);

    const good = collectionResultFeedback('iron_ore', 1, {}, { raw_iron: 1, cobblestone: 4 }, ['raw_iron']);
    assert.equal(good.success, true);
    assert.match(good.message, /Incidental gains .*cobblestone \+4/);
});

test('a repeated failed collection stays blocked through stuck recovery and incidental pickups', async () => {
    const sim = createWorld({
        blocks: [['iron_ore', 6, 64, 0]],
        onCollect: ({ add }) => add('cobblestone', 2),
    });
    const agent = createAgent(sim.bot);
    const command = '!collectBlocks("iron_ore", 1)';

    await executeCommand(agent, command);
    assert.equal(agent.actions.getLastOutcome().status, 'failure');

    // Stuck recovery climbs out a few blocks away and more cobblestone is picked up.
    sim.bot.entity.position = new Vec3(3, 67, 4);
    sim.add('cobblestone', 5);
    sim.add('dirt', 2);
    const blocked = await executeCommand(agent, command);
    assert.match(blocked, /UNCHANGED BLOCKING CONDITION/);

    // Relevant changes lift the block: moving to a genuinely different area...
    sim.bot.entity.position = new Vec3(60, 64, 0);
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'iron_ore', num: 1 }), null);
});

test('obtaining a tool or the expected item lifts a collection block', async () => {
    for (const change of [sim => sim.add('iron_pickaxe', 1), sim => sim.add('raw_iron', 1)]) {
        const sim = createWorld({ blocks: [['iron_ore', 6, 64, 0]], onCollect: () => {} });
        const agent = createAgent(sim.bot);
        await executeCommand(agent, '!collectBlocks("iron_ore", 1)');
        assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'iron_ore', num: 1 }));
        change(sim);
        assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'iron_ore', num: 1 }), null);
    }
});

test('the no-progress watchdog is not reset by incidental items from a failed collection', async () => {
    const counts = new Map();
    const key = '!collectBlocks("iron_ore", 1)';
    const sim = createWorld({ blocks: [['iron_ore', 6, 64, 0]], onCollect: ({ add }) => add('cobblestone', 4) });

    for (let attempt = 1; attempt <= 3; attempt++) {
        const agent = createAgent(sim.bot);
        await executeCommand(agent, key);
        const structuredOutcome = agent.actions.getLastOutcome();
        updateRepeatCounts(counts, key, { structuredOutcome, failed: structuredOutcome.status === 'failure' });
        assert.equal(counts.get(key), attempt);
        sim.bot.entity.position = new Vec3(attempt * 2, 64, 0); // stuck-recovery drift
    }

    // Unrelated commands do not erase it; verified progress does.
    updateRepeatCounts(counts, '!discard("dirt", 1)', { structuredOutcome: { relevantProgress: true }, failed: false });
    assert.equal(counts.get(key), 3);
    updateRepeatCounts(counts, key, { structuredOutcome: { relevantProgress: true, status: 'success' }, failed: false });
    assert.equal(counts.has(key), false);
});
