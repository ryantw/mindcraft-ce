import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import { ActionManager } from '../src/agent/action_manager.js';
import {
    classifyFailure,
    verifySmeltingProduct,
} from '../src/agent/action_outcome.js';
import { executeCommand } from '../src/agent/commands/index.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

const registry = minecraftData('1.21.6');
initializeMinecraftData('1.21.6');

function item(name, count) {
    // Mineflayer items expose the numeric item id as `type`.
    return { ...registry.itemsByName[name], name, count, type: registry.itemsByName[name].id };
}

/**
 * A bot whose furnace behaves like the real window API closely enough to run
 * the real skills.smeltItem. `yieldCount` is how many products the furnace
 * produces; `syncToInventory=false` simulates output that was reported taken
 * but never actually reached the inventory.
 */
function createSmeltingBot(counts, {
    furnaceNearby=true,
    furnaceInput=null,
    product='iron_ingot',
    yieldCount=0,
    syncToInventory=true,
    interruptAfterTake=false,
    onTakeOutput=null,
}={}) {
    const furnacePosition = new Vec3(1, 64, 0);
    const furnaceBlock = {
        name: 'furnace',
        type: registry.blocksByName.furnace.id,
        position: furnacePosition,
    };
    const bot = {
        output: '',
        interrupt_code: false,
        entity: { position: new Vec3(0, 64, 0) },
        modes: { pause() {} },
        inventory: {
            inventoryStart: 9,
            slots: Array(46).fill(null),
            items() { return this.slots.filter(Boolean); },
        },
        findBlocks: ({ matching }) => {
            const matches = Array.isArray(matching) ? matching.includes(furnaceBlock.type) : matching(furnaceBlock);
            return furnaceNearby && matches ? [furnacePosition] : [];
        },
        blockAt: position => furnaceNearby && position.equals(furnacePosition) ? furnaceBlock : null,
        lookAt: async () => {},
        closeWindow: async () => {},
        emit() {},
    };
    Object.entries(counts).forEach(([name, count], index) => {
        bot.inventory.slots[9 + index] = { ...item(name, count), slot: 9 + index };
    });

    function remove(name, count) {
        const slot = bot.inventory.slots.find(entry => entry?.name === name);
        slot.count -= count;
        if (slot.count <= 0) bot.inventory.slots[bot.inventory.slots.indexOf(slot)] = null;
    }
    function add(name, count) {
        const existing = bot.inventory.slots.find(entry => entry?.name === name);
        if (existing) existing.count += count;
        else {
            const free = bot.inventory.slots.findIndex((entry, index) => index >= 9 && index < 45 && !entry);
            bot.inventory.slots[free] = { ...item(name, count), slot: free };
        }
    }

    let input = furnaceInput ? item(furnaceInput.name, furnaceInput.count) : null;
    let fuel = null;
    let output = null;
    bot.openFurnace = async () => ({
        inputItem: () => input,
        fuelItem: () => fuel,
        outputItem: () => output,
        async putFuel(_type, _meta, count) {
            const fuelName = bot.inventory.slots.find(entry => ['coal', 'charcoal'].includes(entry?.name) || /log|planks/.test(entry?.name || '')).name;
            remove(fuelName, count);
            fuel = item(fuelName, count);
        },
        async putInput(type, _meta, count) {
            const name = registry.items[type].name;
            remove(name, count);
            input = item(name, count);
            if (yieldCount > 0) output = item(product, yieldCount);
        },
        async takeOutput() {
            const taken = output;
            output = null;
            // The furnace consumes input as it produces output.
            if (input) {
                input.count -= taken.count;
                if (input.count <= 0) input = null;
            }
            if (syncToInventory) add(taken.name, taken.count);
            if (interruptAfterTake) bot.interrupt_code = true;
            if (onTakeOutput) onTakeOutput({ add, taken });
            return taken;
        },
        async takeInput() {
            if (input) add(input.name, input.count);
            input = null;
        },
        async takeFuel() {
            if (fuel) add(fuel.name, fuel.count);
            fuel = null;
        },
    });
    return bot;
}

function createAgent(bot) {
    const agent = {
        name: 'Jasper',
        bot,
        kills: [],
        history: { add: async () => {} },
        clearBotLogs() {
            bot.output = '';
            bot.interrupt_code = false;
        },
        requestInterrupt() { bot.interrupt_code = true; },
        cleanKill(reason) { agent.kills.push(reason); },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

test('verified smelting reports the product that actually reached inventory', async () => {
    const bot = createSmeltingBot({ raw_iron: 3, coal: 2 }, { yieldCount: 3 });
    const agent = createAgent(bot);

    const result = await executeCommand(agent, '!smeltItem("raw_iron", 3)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.status, 'success');
    assert.equal(outcome.relevantProgress, true);
    assert.equal(outcome.evidence.inventory.changes.iron_ingot.delta, 3);
    assert.equal(outcome.evidence.inventory.changes.raw_iron.delta, -3);
    assert.equal(outcome.evidence.producedItems, 3);
    // Human-readable skill feedback is preserved alongside the verified outcome.
    assert.match(result, /Successfully smelted raw_iron, got 3 iron_ingot/);
    assert.match(result, /Verified outcome: SUCCESS for smeltItem/);
    assert.equal(agent.actions.retryBlock('smeltItem', { item_name: 'raw_iron', num: 3 }), null);

    // The old workaround restarted the whole process after a successful smelt.
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(agent.kills, []);
});

test('smelting fewer products than requested is a partial success that stays retryable', async () => {
    const bot = createSmeltingBot({ raw_iron: 4, coal: 2 }, { yieldCount: 2, interruptAfterTake: true });
    const agent = createAgent(bot);

    const result = await executeCommand(agent, '!smeltItem("raw_iron", 4)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.success, false);
    assert.equal(outcome.relevantProgress, true);
    assert.equal(outcome.evidence.producedItems, 2);
    assert.equal(outcome.retry.reasonableWithoutStateChange, true);
    assert.match(result, /Verified outcome: PARTIAL/);
    assert.equal(agent.actions.retryBlock('smeltItem', { item_name: 'raw_iron', num: 4 }), null);
});

test('a claimed smelt with no inventory evidence is a failure, not a success', async () => {
    const bot = createSmeltingBot({ raw_iron: 2, coal: 1 }, { yieldCount: 2, syncToInventory: false });
    const agent = createAgent(bot);

    await executeCommand(agent, '!smeltItem("raw_iron", 2)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.relevantProgress, false);
    assert.equal(outcome.reason.code, 'smelting_unverified');
    assert.equal(outcome.retry.reasonableWithoutStateChange, false);
    assert.equal(outcome.evidence.inventory.changes.iron_ingot, undefined);
});

test('missing furnace blocks identical retries until observed state changes', async () => {
    const bot = createSmeltingBot({ raw_iron: 3, coal: 2 }, { furnaceNearby: false });
    const agent = createAgent(bot);

    const first = await executeCommand(agent, '!smeltItem("raw_iron", 3)');
    const outcome = agent.actions.getLastOutcome();
    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.reason.code, 'missing_workstation');
    assert.equal(outcome.retry.reasonableWithoutStateChange, false);
    assert.match(first, /There is no furnace nearby/);
    assert.match(first, /Verified outcome: FAILURE/);

    const second = await executeCommand(agent, '!smeltItem("raw_iron", 3)');
    assert.match(second, /UNCHANGED BLOCKING CONDITION/);
    assert.match(second, /Place or find a furnace/);

    // Acquiring a furnace changes the observed inventory, lifting the block.
    bot.inventory.slots[30] = { ...item('furnace', 1), slot: 30 };
    assert.equal(agent.actions.retryBlock('smeltItem', { item_name: 'raw_iron', num: 3 }), null);
});

test('missing and insufficient fuel are classified as fuel failures', async () => {
    const noFuel = createSmeltingBot({ raw_iron: 3 });
    const noFuelAgent = createAgent(noFuel);
    await executeCommand(noFuelAgent, '!smeltItem("raw_iron", 3)');
    assert.equal(noFuelAgent.actions.getLastOutcome().reason.code, 'missing_fuel');
    assert.equal(noFuelAgent.actions.getLastOutcome().status, 'failure');

    const shortFuel = createSmeltingBot({ raw_iron: 8, oak_log: 1 });
    const shortFuelAgent = createAgent(shortFuel);
    const feedback = await executeCommand(shortFuelAgent, '!smeltItem("raw_iron", 8)');
    const outcome = shortFuelAgent.actions.getLastOutcome();
    assert.match(feedback, /You don't have enough oak_log to smelt 8 raw_iron; you need 6/);
    assert.equal(outcome.reason.code, 'missing_fuel');
    assert.equal(outcome.retry.reasonableWithoutStateChange, false);
    // Failed attempts must not leave the furnace or fuel unaccounted for.
    assert.equal(outcome.evidence.inventory.changes.oak_log, undefined);
});

test('insufficient input is a missing resource, not a fuel problem', () => {
    const reason = classifyFailure('You do not have enough raw_iron to smelt.');
    assert.equal(reason.code, 'missing_resource');
});

test('a furnace busy with a different job is a distinct, state-dependent failure', async () => {
    const bot = createSmeltingBot({ raw_iron: 3, coal: 2 }, { furnaceInput: { name: 'raw_gold', count: 4 } });
    const agent = createAgent(bot);

    await executeCommand(agent, '!smeltItem("raw_iron", 3)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.reason.code, 'workstation_busy');
    assert.match(outcome.reason.prerequisites.join(' '), /clearFurnace/);
    assert.equal(outcome.reason.condition, 'state_changed');
});

test('an unsmeltable item is a permanent request error for identical params', async () => {
    const bot = createSmeltingBot({ diamond: 1, coal: 1 });
    const agent = createAgent(bot);

    await executeCommand(agent, '!smeltItem("diamond", 1)');
    const outcome = agent.actions.getLastOutcome();
    assert.equal(outcome.reason.code, 'invalid_request');
    assert.equal(outcome.reason.condition, 'invalid_request');

    // Moving or gaining items cannot make the same invalid request valid.
    bot.entity.position.x = 50;
    bot.inventory.slots[31] = { ...item('stick', 4), slot: 31 };
    const retry = await executeCommand(agent, '!smeltItem("diamond", 1)');
    assert.match(retry, /UNCHANGED BLOCKING CONDITION/);
});

test('unrelated inventory gains cannot produce a false smelting success', async () => {
    // The furnace hands over 3 iron_ingot, but they never reach inventory.
    // Meanwhile 3 cobblestone are picked up. The skill believes it succeeded.
    const bot = createSmeltingBot({ raw_iron: 3, coal: 2 }, {
        yieldCount: 3,
        syncToInventory: false,
        onTakeOutput: ({ add }) => add('cobblestone', 3),
    });
    const agent = createAgent(bot);

    const result = await executeCommand(agent, '!smeltItem("raw_iron", 3)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.evidence.inventory.changes.cobblestone.delta, 3);
    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.success, false);
    assert.equal(outcome.relevantProgress, false);
    assert.equal(outcome.reason.code, 'smelting_unverified');
    assert.equal(outcome.evidence.smelting.product, 'iron_ingot');
    assert.equal(outcome.evidence.smelting.verified, 0);
    assert.match(result, /Verified outcome: FAILURE/);
});

test('real product gains still succeed when unrelated pickups also occur', async () => {
    const bot = createSmeltingBot({ raw_iron: 3, coal: 2 }, {
        yieldCount: 3,
        onTakeOutput: ({ add }) => add('cobblestone', 5),
    });
    const agent = createAgent(bot);

    await executeCommand(agent, '!smeltItem("raw_iron", 3)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.status, 'success');
    assert.deepEqual(outcome.evidence.smeltedProducts, { iron_ingot: 3 });
});

test('a furnace product that contradicts the recipe is not verified', async () => {
    const bot = createSmeltingBot({ raw_iron: 2, coal: 1 }, { yieldCount: 2, product: 'gold_ingot' });
    const agent = createAgent(bot);

    await executeCommand(agent, '!smeltItem("raw_iron", 2)');
    const outcome = agent.actions.getLastOutcome();

    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.evidence.smelting.mismatch, true);
    assert.equal(outcome.evidence.inventory.changes.gold_ingot.delta, 2);
});

test('product verification uses recipe knowledge, falls back to furnace output, and caps at what was taken', () => {
    const changes = {
        raw_iron: { before: 3, after: 0, delta: -3 },
        iron_ingot: { before: 0, after: 9, delta: 9 },
        furnace: { before: 0, after: 1, delta: 1 },
        cobblestone: { before: 0, after: 4, delta: 4 },
        charcoal: { before: 0, after: 2, delta: 2 },
    };
    // Stray pickups of the product itself cannot inflate the verified amount.
    assert.equal(verifySmeltingProduct({
        changes, expectedProduct: 'iron_ingot', observed: { product: 'iron_ingot', taken: 3 },
    }).verified, 3);
    // Unrelated gains verify nothing.
    assert.equal(verifySmeltingProduct({
        changes, expectedProduct: 'iron_ingot', observed: { product: 'iron_ingot', taken: 0 },
    }).verified, 0);
    assert.equal(verifySmeltingProduct({
        changes: { cobblestone: changes.cobblestone, furnace: changes.furnace },
        expectedProduct: 'iron_ingot', observed: { product: 'iron_ingot', taken: 3 },
    }).verified, 0);
    // Unknown recipe: trust only the item the furnace actually returned.
    assert.equal(verifySmeltingProduct({
        changes, expectedProduct: null, observed: { product: 'charcoal', taken: 2 },
    }).product, 'charcoal');
    assert.equal(verifySmeltingProduct({
        changes, expectedProduct: null, observed: null,
    }).verified, 0);
});

test('expected smelting products come from existing recipe data', async () => {
    const { getSmeltingProduct } = await import('../src/utils/mcdata.js');
    assert.equal(getSmeltingProduct('raw_iron'), 'iron_ingot');
    assert.equal(getSmeltingProduct('raw_porkchop'), 'cooked_porkchop');
    assert.equal(getSmeltingProduct('oak_log'), 'charcoal');
    assert.equal(getSmeltingProduct('cobblestone'), 'stone');
    assert.equal(getSmeltingProduct('diamond'), null);
});
