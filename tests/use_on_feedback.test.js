import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import { getCommand } from '../src/agent/commands/index.js';
import {
    collectionResultFeedback,
    inventoryChangeSummary,
    useToolOnBlock,
} from '../src/agent/library/skills.js';

function createInteractionBot(counts={}) {
    const slots = Object.entries(counts).map(([name, count]) => ({ name, count, type: 1 }));
    return {
        output: '',
        game: { gameMode: 'survival' },
        modes: { isOn: () => true },
        entity: { position: new Vec3(0, 64, 0), height: 1.62 },
        inventory: {
            slots,
            findInventoryItem(name) {
                return this.slots.find(slot => slot?.name === name);
            },
        },
        chat() {},
        lookAt: async () => {},
        unequip: async () => {},
        equip(item) {
            this.heldItem = item;
            return Promise.resolve();
        },
        blockAtCursor: () => null,
        activateBlock: async () => {},
        activateItem: async () => {},
    };
}

test('hand interaction with a log explicitly reports no harvest or collection', async () => {
    const block = { name: 'acacia_log', position: new Vec3(1, 64, 0) };
    const bot = createInteractionBot();
    bot.blockAtCursor = () => block;

    assert.equal(await useToolOnBlock(bot, 'hand', block), true);

    assert.match(bot.output, /Interacted with acacia_log using hand/);
    assert.match(bot.output, /No block was mined or harvested by !useOn/);
    assert.match(bot.output, /No items were collected/);
    assert.match(bot.output, /acacia_log 0 -> 0 \(no change\)/);
    assert.match(bot.output, /use !collectBlocks\("acacia_log", 1\)/);
    assert.doesNotMatch(bot.output, /Used hand on acacia_log/);
});

test('item interactions report every before/after inventory change', async () => {
    const block = { name: 'water', position: new Vec3(1, 64, 0) };
    const bot = createInteractionBot({ bucket: 1 });
    bot.blockAtCursor = () => block;
    bot.activateItem = () => {
        bot.inventory.slots = [{ name: 'water_bucket', count: 1, type: 2 }];
        return Promise.resolve();
    };

    assert.equal(await useToolOnBlock(bot, 'bucket', block), true);

    assert.match(bot.output, /Inventory gains from the interaction: water_bucket \+1/);
    assert.match(bot.output, /bucket 1 -> 0 \(-1\)/);
    assert.match(bot.output, /water_bucket 0 -> 1 \(\+1\)/);
});

test('inventory summaries retain relevant zero-change resources', () => {
    assert.equal(
        inventoryChangeSummary({ stick: 2 }, { stick: 2 }, ['acacia_log']),
        'Inventory before -> after: acacia_log 0 -> 0 (no change).'
    );
});

test('collection feedback requires a confirmed inventory gain', () => {
    const missing = collectionResultFeedback('acacia_log', 1, {}, {});
    assert.equal(missing.success, false);
    assert.match(missing.message, /no collected items were confirmed/i);
    assert.match(missing.message, /acacia_log 0 -> 0 \(no change\)/);

    const collected = collectionResultFeedback('acacia_log', 2, {}, { acacia_log: 2 });
    assert.equal(collected.success, true);
    assert.match(collected.message, /confirmed collected items/i);
    assert.match(collected.message, /acacia_log 0 -> 2 \(\+2\)/);
});

test('command documentation distinguishes interaction from harvesting', () => {
    const useOn = getCommand('!useOn');
    const collectBlocks = getCommand('!collectBlocks');

    assert.match(useOn.description, /does not mine, break, or harvest/i);
    assert.match(useOn.description, /!collectBlocks/);
    assert.match(collectBlocks.description, /break and harvest/i);
    assert.match(collectBlocks.description, /logs/i);
});
