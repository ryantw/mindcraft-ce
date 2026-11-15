import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionManager } from '../src/agent/action_manager.js';
import {
    createActionOutcome,
    formatActionOutcome,
    inventorySnapshot,
} from '../src/agent/action_outcome.js';
import { executeCommand } from '../src/agent/commands/index.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

initializeMinecraftData('1.21.6');

function makeSlots(occupied, item='cobblestone') {
    const slots = Array(46).fill(null);
    for (let index = 0; index < occupied; index++) {
        slots[9 + index] = { name: index === 0 ? item : `${item}_${index}`, count: 64, slot: 9 + index };
    }
    return slots;
}

function makeAgent(occupied=36) {
    const bot = {
        inventory: {
            inventoryStart: 9,
            slots: makeSlots(occupied),
        },
        entity: { position: { x: 0, y: 64, z: 0 } },
    };
    const agent = { name: 'Jasper', bot };
    agent.actions = new ActionManager(agent);
    return agent;
}

test('inventory snapshot counts only the 36 normal storage slots for capacity', () => {
    const agent = makeAgent(34);
    agent.bot.inventory.slots[5] = { name: 'iron_helmet', count: 1, slot: 5 };
    agent.bot.inventory.slots[45] = { name: 'shield', count: 1, slot: 45 };

    const snapshot = inventorySnapshot(agent.bot);
    assert.equal(snapshot.storage.occupied, 34);
    assert.equal(snapshot.storage.free, 2);
});

test('discarding part of a stack records item progress but no capacity relief', () => {
    const agent = makeAgent(36);
    const before = inventorySnapshot(agent.bot);
    agent.bot.inventory.slots[9].count = 32;
    const after = inventorySnapshot(agent.bot);

    const outcome = createActionOutcome({
        action: 'discard',
        params: { item_name: 'cobblestone', num: 32 },
        status: 'success',
        before,
        after,
        relevantProgress: true,
        bot: agent.bot,
    });

    assert.equal(outcome.evidence.inventory.changes.cobblestone.delta, -32);
    assert.equal(outcome.evidence.storage.freedSlots, 0);
    assert.equal(outcome.evidence.storage.capacityRelief, false);
    assert.match(formatActionOutcome(outcome), /0 slots freed/);
});

test('an unchanged full-inventory blocker survives unrelated discard progress', async () => {
    const agent = makeAgent(36);
    const full = inventorySnapshot(agent.bot);
    const collectFailure = createActionOutcome({
        action: 'collectBlocks',
        params: { type: 'coal_ore', num: 8 },
        status: 'failure',
        before: full,
        after: full,
        reason: {
            code: 'inventory_capacity',
            message: 'Normal inventory storage is full.',
            prerequisites: ['Free at least one normal storage slot.'],
            condition: 'inventory_capacity',
        },
        retryableWithoutStateChange: false,
        bot: agent.bot,
    });
    agent.actions.recordOutcome(collectFailure);

    const beforeDiscard = inventorySnapshot(agent.bot);
    agent.bot.inventory.slots[9].count = 32;
    const afterDiscard = inventorySnapshot(agent.bot);
    agent.actions.recordOutcome(createActionOutcome({
        action: 'discard',
        params: { item_name: 'cobblestone', num: 32 },
        status: 'success',
        before: beforeDiscard,
        after: afterDiscard,
        relevantProgress: true,
        bot: agent.bot,
    }));

    const blocked = await executeCommand(agent, '!collectBlocks("coal_ore", 8)');
    assert.match(blocked, /UNCHANGED BLOCKING CONDITION/);
    assert.match(blocked, /Free at least one normal storage slot/);

    agent.bot.inventory.slots[9] = null;
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 8 }), null);
});

test('a world-state-changing failure is blocked only while its fingerprint is unchanged', () => {
    const agent = makeAgent(10);
    const snapshot = inventorySnapshot(agent.bot);
    agent.actions.recordOutcome(createActionOutcome({
        action: 'collectBlocks',
        params: { type: 'coal_ore', num: 1 },
        status: 'failure',
        before: snapshot,
        after: snapshot,
        reason: {
            code: 'target_unavailable',
            message: 'No currently reachable target was found.',
            prerequisites: ['Move to a different area.'],
            condition: 'state_changed',
        },
        retryableWithoutStateChange: false,
        bot: agent.bot,
    }));

    assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 1 }));
    agent.bot.entity.position.x = 20;
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 1 }), null);
});
