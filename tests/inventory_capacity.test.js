import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { ActionManager } from '../src/agent/action_manager.js';
import {
    canStoreCollectionTarget,
    createActionOutcome,
    inventorySnapshot,
    storageAcceptsItem,
} from '../src/agent/action_outcome.js';
import * as skills from '../src/agent/library/skills.js';
import * as world from '../src/agent/library/world.js';
import { initModes } from '../src/agent/modes.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

const require = createRequire(import.meta.url);
const { pathfinder } = require('mineflayer-pathfinder');
const { CollectBlock } = require('mineflayer-collectblock');
const { Vec3 } = require('vec3');
const registry = minecraftData('1.21.6');
initializeMinecraftData('1.21.6');

const FILLERS = [
    'stick', 'dirt', 'sand', 'gravel', 'oak_log', 'oak_planks', 'cobblestone', 'andesite', 'diorite', 'granite',
    'torch', 'bread', 'apple', 'carrot', 'potato', 'wheat', 'string', 'feather', 'flint', 'bone',
    'iron_ingot', 'gold_ingot', 'copper_ingot', 'clay_ball', 'brick', 'glass', 'oak_sapling', 'wheat_seeds', 'egg', 'leather',
    'paper', 'sugar_cane', 'cobbled_deepslate', 'tuff', 'spruce_log', 'birch_log',
];

function item(name, count) {
    return { name, count, type: registry.itemsByName[name].id, stackSize: registry.itemsByName[name].stackSize };
}

/** Builds a pack whose 36 normal storage slots are all occupied. */
function fullPack(overrides={}) {
    const stacks = [];
    for (const [name, count] of Object.entries(overrides)) stacks.push(item(name, count));
    for (const name of FILLERS) {
        if (stacks.length >= 36) break;
        if (!overrides[name]) stacks.push(item(name, 64));
    }
    const slots = Array(46).fill(null);
    stacks.slice(0, 36).forEach((stack, index) => { slots[9 + index] = { ...stack, slot: 9 + index }; });
    return slots;
}

function makeAgent(overrides) {
    const bot = {
        inventory: {
            inventoryStart: 9,
            slots: fullPack(overrides),
            items() { return this.slots.filter(Boolean); },
        },
        entity: { position: new Vec3(0, 64, 0) },
    };
    const agent = { name: 'Jasper', bot };
    agent.actions = new ActionManager(agent);
    return agent;
}

const CAPACITY = {
    code: 'inventory_capacity',
    message: 'Normal inventory storage is full.',
    prerequisites: ['Free at least one normal storage slot.'],
    condition: 'inventory_capacity',
};

function recordCapacityFailure(agent, params) {
    const snapshot = inventorySnapshot(agent.bot);
    agent.actions.recordOutcome(createActionOutcome({
        action: 'collectBlocks',
        params,
        status: 'failure',
        before: snapshot,
        after: snapshot,
        reason: CAPACITY,
        retryableWithoutStateChange: false,
        bot: agent.bot,
    }));
}

function recordDiscard(agent, itemName, count, slotIndex) {
    const before = inventorySnapshot(agent.bot);
    const slot = agent.bot.inventory.slots[slotIndex];
    slot.count -= count;
    if (slot.count <= 0) agent.bot.inventory.slots[slotIndex] = null;
    const after = inventorySnapshot(agent.bot);
    const outcome = createActionOutcome({
        action: 'discard',
        params: { item_name: itemName, num: count },
        status: 'success',
        before,
        after,
        relevantProgress: true,
        bot: agent.bot,
    });
    agent.actions.recordOutcome(outcome);
    return outcome;
}

function slotOf(agent, name) {
    return agent.bot.inventory.slots.findIndex(slot => slot?.name === name);
}

test('storage accepts an item only via an empty slot or room in a partial stack', () => {
    const partial = makeAgent({ coal: 60 });
    assert.equal(inventorySnapshot(partial.bot).storage.free, 0);
    assert.equal(storageAcceptsItem(partial.bot, 'coal', 4), true);
    assert.equal(storageAcceptsItem(partial.bot, 'coal', 5), false);
    assert.equal(storageAcceptsItem(partial.bot, 'diamond', 1), false);

    const fullStack = makeAgent({ coal: 64 });
    assert.equal(storageAcceptsItem(fullStack.bot, 'coal', 1), false);
});

test('a capacity-blocked collection becomes retryable when the drop fits a partial stack', () => {
    const agent = makeAgent({ coal: 64 });
    recordCapacityFailure(agent, { type: 'coal_ore', num: 8 });
    assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 8 }));

    // 36 occupied slots, but the coal stack now has room for four more.
    agent.bot.inventory.slots[slotOf(agent, 'coal')].count = 60;
    assert.equal(inventorySnapshot(agent.bot).storage.free, 0);
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 4 }), null);
});

test('discarding part of an unrelated full stack does not clear a coal capacity block', () => {
    const agent = makeAgent({ coal: 64, cobblestone: 64 });
    recordCapacityFailure(agent, { type: 'coal_ore', num: 8 });

    const outcome = recordDiscard(agent, 'cobblestone', 10, slotOf(agent, 'cobblestone'));
    assert.equal(outcome.evidence.storage.capacityRelief, false);
    assert.equal(agent.bot.inventory.slots[slotOf(agent, 'cobblestone')].count, 54);
    assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 8 }));
});

test('discarding an entire unrelated stack frees a slot and clears the block', () => {
    const agent = makeAgent({ coal: 64, cobblestone: 64 });
    recordCapacityFailure(agent, { type: 'coal_ore', num: 8 });

    const outcome = recordDiscard(agent, 'cobblestone', 64, slotOf(agent, 'cobblestone'));
    assert.equal(outcome.evidence.storage.capacityRelief, true);
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 8 }), null);
});

test('discarding some of the blocked item itself makes room for it without freeing a slot', () => {
    const agent = makeAgent({ coal: 64 });
    recordCapacityFailure(agent, { type: 'coal_ore', num: 8 });

    const outcome = recordDiscard(agent, 'coal', 10, slotOf(agent, 'coal'));
    assert.equal(outcome.evidence.storage.capacityRelief, false);
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 8 }), null);
});

test('a capacity block on one target does not block a different target that fits', () => {
    const agent = makeAgent({ coal: 60, oak_log: 64 });
    recordCapacityFailure(agent, { type: 'oak_log', num: 4 });

    assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'oak_log', num: 1 }));
    // Coal fits the partial stack even though oak_log does not fit anywhere.
    assert.equal(agent.actions.retryBlock('collectBlocks', { type: 'coal_ore', num: 4 }), null);
    // The oak_log block must survive that check.
    assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'oak_log', num: 1 }));
    // A target with no room anywhere is still blocked.
    assert.ok(agent.actions.retryBlock('collectBlocks', { type: 'diamond_ore', num: 1 }));
});

test('collection-target storage check uses block drops', () => {
    const partial = makeAgent({ coal: 60 });
    assert.equal(canStoreCollectionTarget(partial.bot, { name: 'coal_ore' }), true);
    assert.equal(canStoreCollectionTarget(partial.bot, { name: 'deepslate_coal_ore' }), true);
    assert.equal(canStoreCollectionTarget(partial.bot, { name: 'diamond_ore' }), false);
    assert.equal(canStoreCollectionTarget(partial.bot, { name: 'unknown_block' }), false);
});

function collectionBot(slots) {
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) };
    bot.inventory = {
        inventoryStart: 9,
        slots,
        items() { return this.slots.filter(Boolean); },
        emptySlotCount() { return this.slots.slice(9, 45).filter(slot => !slot).length; },
    };
    bot.clearControlStates = () => {};
    bot.controlState = {};
    bot.blockAt = () => null;
    bot.world = {};
    bot.tool = { equipForBlock: async () => {} };
    pathfinder(bot);
    bot.pathfinder.goto = async () => {};
    bot.pathfinder.setMovements = () => {};
    bot.collectBlock = new CollectBlock(bot);
    return bot;
}

class Entity {
    constructor(name) {
        this.isValid = true;
        this.name = 'item';
        this.position = new Vec3(1, 64, 1);
        this.getDroppedItem = () => ({ name });
    }
}

test('the collection library no longer refuses a drop that fits a partial stack', async () => {
    const bot = collectionBot(fullPack({ coal: 60 }));
    const drop = new Entity('coal');
    const pending = bot.collectBlock.collect(drop, { canStoreTarget: target => canStoreCollectionTarget(bot, target) });
    setTimeout(() => bot.emit('entityGone', drop), 30);
    await pending; // must not throw NoChests
});

test('the collection library still refuses a drop with nowhere to go', async () => {
    const bot = collectionBot(fullPack({ coal: 64 }));
    const drop = new Entity('coal');
    await assert.rejects(
        bot.collectBlock.collect(drop, { canStoreTarget: target => canStoreCollectionTarget(bot, target) }),
        error => error.name === 'NoChests'
    );
});

function discardBot() {
    const dropped = [];
    const bot = new EventEmitter();
    bot.entity = { position: new Vec3(0, 64, 0) };
    bot.inventory = {
        inventoryStart: 9,
        slots: fullPack({ cobblestone: 64 }),
        items() { return this.slots.filter(Boolean); },
        findInventoryItem(name) { return this.slots.find(slot => slot?.name === name) || null; },
        emptySlotCount() { return this.slots.slice(9, 45).filter(slot => !slot).length; },
    };
    bot.output = '';
    bot.entities = {};
    bot.toss = async (type, _meta, count) => {
        const slot = bot.inventory.slots.find(entry => entry?.type === type);
        slot.count -= count;
        const entity = new Entity(slot.name);
        entity.position = bot.entity.position.offset(1, 0, 0);
        bot.entities[`drop${dropped.length}`] = entity;
        dropped.push(entity);
        if (slot.count <= 0) bot.inventory.slots[bot.inventory.slots.indexOf(slot)] = null;
    };
    bot.nearestEntity = predicate => Object.values(bot.entities).find(predicate) || null;
    return { bot, dropped };
}

test('deliberately discarded items are not collectable by idle pickup, other items still are', async () => {
    const { bot, dropped } = discardBot();
    assert.equal(await skills.discard(bot, 'cobblestone', 64), true);
    assert.equal(dropped.length, 1);

    assert.equal(world.isDiscardedItemEntity(bot, dropped[0]), true);
    assert.equal(world.getNearestCollectableItem(bot, 8), null);

    // A different item at the same place, or the same item far away, is fair game.
    const other = new Entity('coal');
    other.position = bot.entity.position.offset(2, 0, 0);
    bot.entities.other = other;
    assert.equal(world.getNearestCollectableItem(bot, 8), other);
    delete bot.entities.other;
    const far = new Entity('cobblestone');
    far.position = bot.entity.position.offset(30, 0, 0);
    bot.entities.far = far;
    assert.equal(world.getNearestCollectableItem(bot, 100), far);
});

test('discard suppression expires', async () => {
    const { bot, dropped } = discardBot();
    await skills.discard(bot, 'cobblestone', 10);
    assert.equal(world.isDiscardedItemEntity(bot, dropped[0]), true);
    assert.equal(world.isDiscardedItemEntity(bot, dropped[0], Date.now() + world.DISCARD_SUPPRESS_MS + 1000), false);
});

test('the item_collecting mode ignores discarded items but notices other items', async () => {
    const { bot, dropped } = discardBot();
    bot.modes = null;
    let pathQueries = 0;
    bot.registry = registry;
    bot.clearControlStates = () => {};
    bot.world = {};
    pathfinder(bot);
    bot.pathfinder.getPathTo = async () => { pathQueries++; return { status: 'success', path: [] }; };

    const agent = {
        bot,
        shut_up: true,
        isIdle: () => true,
        actions: { currentActionLabel: '' },
        self_prompter: { isActive: () => false },
        prompter: { getInitModes: () => null },
    };
    initModes(agent);
    const everyModeOff = Object.fromEntries(Object.keys(bot.modes.getJson()).map(name => [name, name === 'item_collecting']));
    bot.modes.loadJson(everyModeOff);

    await skills.discard(bot, 'cobblestone', 64);
    assert.ok(world.getNearestEntityWhere(bot, entity => entity.name === 'item', 8), 'the raw nearest item exists');

    await bot.modes.update();
    assert.equal(pathQueries, 0, 'mode must not even consider the discarded item');

    // Control: an ordinary item is considered by the same mode.
    bot.entities.fresh = Object.assign(new Entity('coal'), { position: bot.entity.position.offset(2, 0, 0) });
    await bot.modes.update();
    assert.equal(pathQueries, 1);
});
