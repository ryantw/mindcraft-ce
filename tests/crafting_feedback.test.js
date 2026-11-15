import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import { craftRecipe } from '../src/agent/library/skills.js';
import { verifiedMechanics } from '../src/agent/mechanics.js';
import { reflect } from '../src/agent/reasoning.js';
import { setSettings } from '../src/agent/settings.js';
import {
    getCraftingRecipeInfo,
    getDetailedCraftingPlan,
    ingredientsFromPrismarineRecipe,
    initializeMinecraftData,
} from '../src/utils/mcdata.js';

const require = createRequire(import.meta.url);
const registry = minecraftData('1.21.6');
const Recipe = require('prismarine-recipe')(registry).Recipe;

initializeMinecraftData('1.21.6');

function inventorySlots(counts) {
    return Object.entries(counts).map(([name, count], slot) => ({
        ...registry.itemsByName[name],
        name,
        count,
        slot,
    }));
}

function inventoryCounts(bot) {
    const counts = {};
    for (const slot of bot.inventory.slots) {
        if (slot?.name) counts[slot.name] = (counts[slot.name] || 0) + slot.count;
    }
    return counts;
}

function addInventory(bot, itemName, count) {
    const existing = bot.inventory.slots.find(slot => slot?.name === itemName);
    if (existing) existing.count += count;
    else bot.inventory.slots.push({ ...registry.itemsByName[itemName], name: itemName, count, slot: bot.inventory.slots.length });
}

function createCraftingBot(counts, { nearbyTable=false }={}) {
    const tablePosition = new Vec3(1, 64, 0);
    const tableBlock = {
        name: 'crafting_table',
        type: registry.blocksByName.crafting_table.id,
        position: tablePosition,
    };
    const bot = {
        output: '',
        entity: { position: new Vec3(0, 64, 0) },
        inventory: {
            slots: inventorySlots(counts),
            items() { return this.slots.filter(Boolean); },
        },
        findBlocks: ({ matching }) => {
            const matches = Array.isArray(matching)
                ? matching.includes(tableBlock.type)
                : matching(tableBlock);
            return nearbyTable && matches ? [tablePosition] : [];
        },
        blockAt: position => nearbyTable && position.equals(tablePosition) ? tableBlock : null,
        recipesFor(itemId, _metadata, _minimum, craftingTable) {
            const available = inventoryCounts(bot);
            return Recipe.find(itemId).filter(recipe => {
                if (recipe.requiresTable && !craftingTable) return false;
                const ingredients = ingredientsFromPrismarineRecipe(recipe);
                return Object.entries(ingredients).every(([name, required]) => (available[name] || 0) >= required);
            });
        },
        async craft(recipe, executions) {
            await new Promise(resolve => setTimeout(resolve, 20));
            addInventory(bot, registry.items[recipe.result.id].name, recipe.result.count * executions);
        },
        armorManager: { equipAll() {} },
    };
    return bot;
}

test('recipe selection prefers inventory-matching oak and acacia variants', () => {
    const oakTable = getCraftingRecipeInfo('crafting_table', { oak_planks: 4 }).selected;
    const acaciaTable = getCraftingRecipeInfo('crafting_table', { acacia_planks: 4 }).selected;
    const acaciaFromLogs = getCraftingRecipeInfo('crafting_table', { acacia_log: 1 }).selected;

    assert.deepEqual(oakTable.ingredients, { oak_planks: 4 });
    assert.deepEqual(acaciaTable.ingredients, { acacia_planks: 4 });
    assert.deepEqual(acaciaFromLogs.ingredients, { acacia_planks: 4 });
});

test('plans include alternatives and crafting-table requirements', () => {
    const woodenPlan = getDetailedCraftingPlan('wooden_pickaxe', 1, { acacia_log: 2 });
    assert.match(woodenPlan, /acacia_planks/);
    assert.match(woodenPlan, /Valid ingredient alternatives/);
    assert.match(woodenPlan, /placed crafting_table/);

    const stonePlan = getDetailedCraftingPlan('stone_axe', 1, { cobblestone: 3, stick: 2 });
    assert.match(stonePlan, /3 cobblestone \+ 2 stick/);
    assert.match(stonePlan, /placed crafting_table/);
    assert.match(stonePlan, /cobbled_deepslate|blackstone/);
});

test('missing feedback chooses acacia and explains the workstation', async () => {
    const bot = createCraftingBot({ acacia_planks: 3, stick: 2 });
    const crafted = await craftRecipe(bot, 'wooden_pickaxe', 1);

    assert.equal(crafted, false);
    assert.match(bot.output, /best matching wooden_pickaxe recipe \(3 acacia_planks \+ 2 stick\)/);
    assert.match(bot.output, /No crafting_table is in inventory or within 16 blocks/);
    assert.match(bot.output, /using 4 acacia_planks/);
    assert.match(bot.output, /Valid ingredient alternatives/);
    assert.doesNotMatch(bot.output, /requires: oak_planks/);
});

test('missing workstation feedback distinguishes carried and nearby tables', async () => {
    const carried = createCraftingBot({ crafting_table: 1, acacia_planks: 2, stick: 2 });
    assert.equal(await craftRecipe(carried, 'wooden_pickaxe', 1), false);
    assert.match(carried.output, /You have 1 crafting_table in inventory/);
    assert.match(carried.output, /Missing: acacia_planks: need 3, have 2/);

    const nearby = createCraftingBot({ acacia_planks: 2, stick: 2 }, { nearbyTable: true });
    assert.equal(await craftRecipe(nearby, 'wooden_pickaxe', 1), false);
    assert.match(nearby.output, /crafting_table is nearby at \(1, 64, 0\) and can be used/);
    assert.match(nearby.output, /Missing: acacia_planks: need 3, have 2/);
});

test('crafting reports recipe executions and verified produced quantities', async () => {
    const cases = [
        ['crafting_table', { acacia_planks: 4 }, false, 1],
        ['stick', { acacia_planks: 4 }, false, 8, 2],
        ['wooden_pickaxe', { acacia_planks: 3, stick: 2 }, true, 1],
        ['wooden_axe', { oak_planks: 3, stick: 2 }, true, 1],
        ['stone_pickaxe', { cobblestone: 3, stick: 2 }, true, 1],
        ['stone_axe', { cobblestone: 3, stick: 2 }, true, 1],
    ];

    for (const [itemName, inventory, nearbyTable, produced, executions=1] of cases) {
        const bot = createCraftingBot(inventory, { nearbyTable });
        const crafted = await craftRecipe(bot, itemName, executions);
        assert.equal(crafted, true, itemName);
        assert.match(bot.output, new RegExp(`Completed ${executions} recipe execution`), itemName);
        assert.match(bot.output, new RegExp(`produced ${produced} ${itemName}`), itemName);
        assert.doesNotMatch(bot.output, /undefined/, itemName);
    }
});

test('grounded reflection receives the inventory-matching recipe facts', async () => {
    setSettings({
        minecraft_version: '1.21.6',
        reasoning: { think: false, cooldown_ms: 0, max_concurrent: 1, options: { num_predict: 128 } },
    });
    let reflectionInput = '';
    const bot = createCraftingBot({ acacia_log: 2 });
    bot.health = 20;
    bot.food = 20;
    bot.heldItem = null;
    bot.findBlock = () => null;
    const agent = {
        name: 'Rowan',
        bot,
        self_prompter: { prompt: 'Survive and gather useful tools.' },
        history: { memory: '', turns: [] },
        prompter: {
            chat_model: {
                async complete(input) {
                    reflectionInput = input;
                    return { content: 'Craft acacia planks, then use four of them to craft a crafting table.' };
                },
            },
        },
    };

    await reflect(agent, 'How can I craft a crafting table with my acacia logs?');

    assert.match(reflectionInput, /crafting_table is crafted from 4 acacia_planks/);
    assert.match(reflectionInput, /Valid ingredient alternatives/);
    assert.doesNotMatch(reflectionInput, /crafting_table is crafted from 4 oak_planks/);
    setSettings({});
});

test('grounded mechanics cover every requested basic tool recipe', () => {
    for (const itemName of ['stick', 'wooden_pickaxe', 'wooden_axe', 'stone_pickaxe', 'stone_axe']) {
        const facts = verifiedMechanics({
            text: `How do I craft ${itemName}?`,
            inventory: itemName.startsWith('wooden') ? { acacia_planks: 3, stick: 2 } : { cobblestone: 3, stick: 2 },
        });
        assert.match(facts, new RegExp(`${itemName} is crafted from`), itemName);
        if (itemName !== 'stick') assert.match(facts, /crafting table/i, itemName);
    }
});
