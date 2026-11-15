import minecraftData from 'minecraft-data';
import settings from './settings.js';
import { getItemSmeltingIngredient } from '../utils/mcdata.js';
import { storageAcceptsItem } from './action_outcome.js';
import {
    formatIngredients,
    formatRecipeAlternatives,
    getCraftingRecipeVariants,
    selectCraftingRecipe,
} from '../utils/crafting.js';

let registryCache = null;
let phraseCache = null;

const MATERIALS = ['iron', 'diamond', 'gold', 'copper', 'coal', 'emerald', 'lapis', 'redstone'];

function registry() {
    if (!registryCache) {
        const version = settings.minecraft_version && settings.minecraft_version !== 'auto'
            ? settings.minecraft_version
            : '1.21.6';
        registryCache = minecraftData(version);
    }
    return registryCache;
}

function phraseIndex() {
    if (phraseCache) return phraseCache;
    const mc = registry();
    const phrases = [];
    for (const name of Object.keys(mc.blocksByName)) {
        if (name.length < 4) continue;
        phrases.push({ name, phrase: name.replace(/_/g, ' ') });
    }
    for (const name of Object.keys(mc.itemsByName)) {
        if (name.length < 4) continue;
        phrases.push({ name, phrase: name.replace(/_/g, ' ') });
    }
    phrases.sort((a, b) => b.phrase.length - a.phrase.length);
    phraseCache = phrases;
    return phrases;
}

export function inventoryCounts(bot) {
    const counts = {};
    for (const slot of bot?.inventory?.slots || []) {
        if (slot?.name) counts[slot.name] = (counts[slot.name] || 0) + (slot.count || 1);
    }
    return counts;
}

function mentionedNames(text) {
    const mc = registry();
    const normalized = ` ${String(text || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
    let scratch = normalized;
    const found = [];
    for (const entry of phraseIndex()) {
        const token = ` ${entry.phrase} `;
        const plural = ` ${entry.phrase}s `;
        if (!scratch.includes(token) && !scratch.includes(plural)) continue;
        found.push(entry.name);
        scratch = scratch.replaceAll(token, ' ');
        if (found.length >= 8) break;
    }
    const ores = [];
    if (/\b(mine|mining|dig|harvest|ore|pickaxe)\b/.test(normalized)) {
        for (const material of MATERIALS) {
            if (!new RegExp(`\\b${material}\\b`).test(normalized)) continue;
            const ore = material === 'lapis' ? 'lapis_ore' : `${material}_ore`;
            if (mc.blocksByName[ore]) ores.push(ore);
        }
    }
    return [...new Set([...ores, ...found])].slice(0, 6);
}

function canHarvest(blockName, toolName) {
    const mc = registry();
    const block = mc.blocksByName[blockName];
    if (!block) return null;
    if (!block.harvestTools) return true;
    if (!toolName) return false;
    const item = mc.itemsByName[toolName];
    if (!item) return false;
    return Boolean(block.harvestTools[item.id]);
}

function minimumTool(blockName) {
    const block = registry().blocksByName[blockName];
    if (!block?.harvestTools) return null;
    const id = Object.keys(block.harvestTools)[0];
    return registry().items[id]?.name || null;
}

function dropNames(blockName) {
    const block = registry().blocksByName[blockName];
    if (!block?.drops) return [];
    return block.drops.map(id => registry().items[id]?.name).filter(Boolean);
}

function bestRecipe(itemName, inventory) {
    return selectCraftingRecipe(registry(), itemName, inventory);
}

function hasDirectIngredients(recipe, inventory) {
    return Boolean(recipe) && Object.entries(recipe.ingredients).every(([name, count]) =>
        (inventory[name] || 0) >= count
    );
}

function nearbyWorkstation(bot, station, maxDistance=16) {
    if (typeof bot?.findBlock !== 'function') return null;
    const id = registry().blocksByName[station]?.id;
    if (id == null) return null;
    try {
        return bot.findBlock({ matching: id, maxDistance });
    } catch {
        return null;
    }
}

/**
 * Return a deliberately small set of capabilities grounded in current items,
 * registry recipes, nearby workstations, and harvest-tool metadata.
 */
export function inventoryCapabilities(bot, inventory=inventoryCounts(bot), limit=4) {
    const lines = [];
    const held = bot?.heldItem?.name || null;

    if (held) {
        for (const blockName of ['iron_ore', 'diamond_ore', 'obsidian']) {
            if (canHarvest(blockName, held) === true) {
                lines.push(`Held ${held} can harvest ${blockName}.`);
                break;
            }
        }
    }

    const tableNearby = nearbyWorkstation(bot, 'crafting_table');
    const plankOutputs = Object.keys(inventory)
        .filter(name => /_(log|wood)$/.test(name) && inventory[name] > 0)
        .map(name => name.replace(/_(log|wood)$/, '_planks'))
        .filter(name => registry().itemsByName[name]);
    const usefulOutputs = [...new Set([
        ...plankOutputs,
        'stick',
        'stone_pickaxe',
        'chest',
        'furnace',
        'crafting_table',
        'iron_pickaxe',
        'torch',
    ])];
    for (const itemName of usefulOutputs) {
        if (lines.length >= limit) break;
        if ((inventory[itemName] || 0) > 0 && itemName !== 'stick' && itemName !== 'torch') continue;
        const recipe = bestRecipe(itemName, inventory).selected;
        if (!hasDirectIngredients(recipe, inventory)) continue;

        const ingredients = formatIngredients(recipe.ingredients);
        const output = recipe.resultCount > 1 ? `${recipe.resultCount} ${itemName}` : itemName;
        if (!recipe.requiresTable) {
            lines.push(`Can craft ${output} from ${ingredients} without a workstation.`);
        } else if (tableNearby) {
            lines.push(`Can craft ${output} from ${ingredients} using the nearby crafting_table.`);
        } else if ((inventory.crafting_table || 0) > 0) {
            lines.push(`Has ingredients for ${output} (${ingredients}); the carried crafting_table must be placed first.`);
        } else {
            lines.push(`Has ingredients for ${output} (${ingredients}) but needs a placed crafting_table; none is nearby.`);
        }
    }

    return lines.slice(0, limit);
}

function stationLine(bot, inventory, station) {
    if ((inventory[station] || 0) > 0)
        return `${station} is in the inventory and can be placed with !placeHere("${station}")`;
    const craftingHint = station === 'crafting_table'
        ? (() => {
            const recipeInfo = bestRecipe('crafting_table', inventory);
            return recipeInfo.selected ? ` Craft one from ${formatIngredients(recipeInfo.selected.ingredients)}` : '';
        })()
        : '';
    if (typeof bot?.findBlock !== 'function') return `no ${station} is in the inventory.${craftingHint}`;
    const id = registry().blocksByName[station]?.id;
    if (id == null) return `no ${station} is in the inventory.${craftingHint}`;
    const found = bot.findBlock({ matching: id, maxDistance: 16 });
    return found
        ? `${station} is within 16 blocks and can be used`
        : `no ${station} is in the inventory or within 16 blocks.${craftingHint}`;
}

function sourceBlockFor(itemName, toolName) {
    const mc = registry();
    const item = mc.itemsByName[itemName];
    if (!item) return null;
    const preferred = ['stone', 'cobblestone', 'oak_log', 'deepslate'];
    const sources = [];
    for (const block of Object.values(mc.blocksByName)) {
        if (!block.drops?.includes(item.id)) continue;
        if (toolName && canHarvest(block.name, toolName) !== true) continue;
        sources.push(block.name);
    }
    sources.sort((a, b) => {
        const ap = preferred.indexOf(a);
        const bp = preferred.indexOf(b);
        return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
    });
    return sources[0] || null;
}

const NORMAL_STORAGE_SLOTS = 36;

function recipeLine(itemName, recipe, inventory, bot, alternatives='') {
    const ingredientText = formatIngredients(recipe.ingredients);
    const station = recipe.requiresTable
        ? ` Needs a crafting table; ${stationLine(bot, inventory, 'crafting_table').replace(/\.+$/, '')}.`
        : ' Inventory crafting is enough.';
    // One craft can make several items (1 log makes 4 planks). Saying so
    // prevents "4 logs are needed for 4 planks" style errors.
    const yieldText = ` One craft makes ${recipe.resultCount} ${itemName}.`;
    return `${itemName} is crafted from ${ingredientText}.${yieldText}${station}${alternatives ? ` ${alternatives}` : ''}`;
}

/**
 * Mining a block without Silk Touch does not always give the block itself.
 * Derived from the registry's loot tables, never hard-coded.
 */
function yieldNote(blockName) {
    const drops = registry().blockLoot?.[blockName]?.drops || [];
    const normal = drops.filter(drop => !drop.silkTouch).map(drop => drop.item);
    if (normal.length === 0 || normal.includes(blockName)) return null;
    const silk = drops.some(drop => drop.silkTouch && drop.item === blockName);
    return `Mining ${blockName} with a suitable pickaxe yields ${[...new Set(normal)].join(' / ')}, not ${blockName}` +
        `${silk ? `; ${blockName} itself requires Silk Touch` : ''}.`;
}

const PLACEMENT_MENTION = /\b(plac(?:e|es|ed|ing)|placeHere)\b/i;
export const PLACEMENT_FACT = 'Placing a block takes one item from an existing stack. It does not need a free inventory slot, and a full inventory does not prevent placing. If placing fails, the cause is something else, such as not carrying the item or having no valid target position.';

function storageStacks(bot) {
    const slots = bot?.inventory?.slots || [];
    const configuredStart = Number(bot?.inventory?.inventoryStart);
    const start = Number.isInteger(configuredStart) ? configuredStart : 9;
    const end = Math.min(start + NORMAL_STORAGE_SLOTS, slots.length);
    const stacks = [];
    let empty = 0;
    for (let index = start; index < end; index++) {
        if (slots[index]) stacks.push(slots[index]);
        else empty++;
    }
    return { stacks, empty: empty + Math.max(0, start + NORMAL_STORAGE_SLOTS - Math.max(end, start)) };
}

/**
 * Inventory capacity facts. Only normal storage (36 slots) holds loose items;
 * armor, offhand and crafting slots do not count.
 */
export function inventoryCapacityFacts(bot, wantedItems=[], { explainStacks = false } = {}) {
    if (!bot?.inventory?.slots) return [];
    const { stacks, empty } = storageStacks(bot);
    const lines = [`Normal storage: ${stacks.length}/${NORMAL_STORAGE_SLOTS} slots occupied, ${empty} free.`];
    const partial = stacks
        .map(stack => ({ name: stack.name, count: stack.count, max: stack.stackSize || registry().itemsByName[stack.name]?.stackSize || 64 }))
        .filter(stack => stack.count < stack.max)
        .slice(0, 4)
        .map(stack => `${stack.name} ${stack.count}/${stack.max}`);
    if (empty === 0) {
        lines.push('Storage is full: a new item type can only be picked up if an existing stack of that same item has room.');
        lines.push('Removing part of a stack does not free a slot; only emptying a whole stack does. Collecting or mining more of any item cannot free space.');
        if (partial.length) lines.push(`Stacks with room: ${partial.join(', ')}.`);
        for (const item of wantedItems.slice(0, 3)) {
            lines.push(storageAcceptsItem(bot, item)
                ? `${item} can still be picked up (it fits an existing stack).`
                : `${item} cannot be picked up until a slot is freed or a ${item} stack has room.`);
        }
    } else if (explainStacks) {
        // Shown while inventory management is being judged, even if space exists:
        // the usual mistake is believing a partial discard frees a slot.
        lines.push('Each stack occupies one slot: removing part of a stack never frees a slot; only emptying a whole stack does. A free slot is only needed to pick up an item type that has no stack with room.');
        for (const item of wantedItems.slice(0, 3)) {
            if (storageAcceptsItem(bot, item)) lines.push(`${item} can currently be picked up.`);
        }
    }
    return lines;
}

function breakableAdvice(text) {
    return /\b(inventory|slots?|space|full|discard|free up)\b/i.test(String(text || ''));
}

function bedFact() {
    const mc = registry();
    const bedName = mc.itemsByName.white_bed ? 'white_bed' : Object.keys(mc.itemsByName).find(name => name.endsWith('_bed'));
    if (!bedName) return null;
    // Coloured beds also have dye-recolouring recipes; the base recipe is the
    // one made from wool and planks.
    const recipe = getCraftingRecipeVariants(mc, bedName)
        .find(variant => Object.keys(variant.ingredients).some(name => name.endsWith('_wool')));
    if (!recipe) return null;
    const shape = Object.entries(recipe.ingredients).map(([name, count]) => {
        if (name.endsWith('_wool')) return `${count} wool (any colour)`;
        if (name.endsWith('_planks')) return `${count} planks (any wood)`;
        return `${count} ${name}`;
    });
    return `A bed is crafted from ${shape.join(' + ')}${recipe.requiresTable ? ' at a crafting table' : ''}. No other item (such as bedrock or stone) is an ingredient.`;
}

function toolList(inventory, held) {
    const tools = new Set();
    if (held && registry().itemsByName[held]) tools.add(held);
    for (const name of Object.keys(inventory)) {
        if (/_(pickaxe|axe|shovel|hoe)$/.test(name)) tools.add(name);
    }
    return [...tools];
}

export function verifiedMechanics(options = {}) {
    return verifiedMechanicsDetail(options).text;
}

/**
 * Same facts as verifiedMechanics plus structured data used to check advice:
 * { text, recipes: [{ item, ingredients, variants }], bed, capacity }.
 * `wantedItems` are items the agent is trying to obtain (capacity checks);
 * `forceCapacity` includes capacity facts for a known capacity problem.
 */
export function verifiedMechanicsDetail({ text, inventory = {}, held = null, bot = null, wantedItems = [], forceCapacity = false, beliefText = '', explainStacks = false } = {}) {
    const recipes = [];
    const yields = [];
    const names = mentionedNames(text);
    const craftingIntent = /\b(craft|crafting|recipe|make)\b/i.test(String(text || ''));
    const miningIntent = /\b(mine|mining|dig|harvest|collect|break|ore|pickaxe|drops?|reach)\b/i.test(String(text || ''));
    // A crafting question about planks is about the item, not about mining a block.
    // iron_ore and deepslate_iron_ore have identical drops and tool rules; one
    // line explains both and keeps the prompt short.
    // A question about placing a block is not about mining it.
    const placingOnly = PLACEMENT_MENTION.test(String(text || '')) && !miningIntent && !craftingIntent;
    const blocks = names.filter(name => registry().blocksByName[name] && !placingOnly &&
        (!craftingIntent || miningIntent || registry().blocksByName[name].harvestTools) &&
        !(name.startsWith('deepslate_') && names.includes(name.slice('deepslate_'.length))));
    const tools = toolList(inventory, held);
    const lines = [];
    const explained = new Set();
    // The agent's own recent statements decide which general facts are relevant
    // (for example a belief that a slot must be freed before placing a block),
    // but never which recipes or blocks are explained.
    const belief = `${text || ''}\n${beliefText || ''}`;
    const wantsCapacity = forceCapacity || breakableAdvice(belief);
    const placement = PLACEMENT_MENTION.test(belief) && (wantsCapacity || breakableAdvice(belief));
    const bed = /\bbeds?\b/i.test(String(text || '')) ? bedFact() : null;
    if (bed) lines.push(bed);
    if (wantsCapacity) lines.push(...inventoryCapacityFacts(bot, wantedItems, { explainStacks }));
    if (placement) lines.push(PLACEMENT_FACT);

    for (const blockName of blocks.slice(0, 3)) {
        const drops = dropNames(blockName);
        const dropText = drops.length ? `drops ${drops.join(', ')}` : 'has no listed drop';
        const usable = tools.filter(tool => canHarvest(blockName, tool) === true);
        const minimum = minimumTool(blockName);
        if (canHarvest(blockName, held) === true || (!held && canHarvest(blockName, null) === true && !minimum)) {
            lines.push(`${blockName} ${dropText}. ${held || 'An empty hand'} can harvest it.`);
        } else if (usable.length > 0) {
            lines.push(`${blockName} ${dropText}. ${usable.join(', ')} in the inventory can harvest it; the !collectBlocks command equips the best suitable tool automatically. ${held ? `(The currently held ${held} cannot.)` : ''}`.trim());
        } else if (minimum) {
            lines.push(`${blockName} ${dropText}. ${held || 'The held item'} cannot harvest it. It requires ${minimum} or another tool listed for that block.`);
        } else {
            lines.push(`${blockName} ${dropText}. No special tool is required.`);
        }
        const yieldLine = yieldNote(blockName);
        if (yieldLine) {
            lines.push(yieldLine);
            yields.push(blockName);
        }
        explained.add(blockName);

        if (minimum && !(inventory[minimum] > 0) && held !== minimum) {
            const recipeInfo = bestRecipe(minimum, inventory);
            const recipe = recipeInfo.selected;
            if (recipe) {
                const have = Object.keys(recipe.ingredients).map(name => `${name} x${inventory[name] || 0}`).join(', ');
                const alternatives = formatRecipeAlternatives(recipeInfo.variants, recipe);
                lines.push(`${recipeLine(minimum, recipe, inventory, bot, alternatives)} Inventory has ${have}.`);
                recipes.push({ item: minimum, ingredients: recipe.ingredients, variants: recipeInfo.variants });
                for (const [ingredientName, ingredientCount] of Object.entries(recipe.ingredients)) {
                    if ((inventory[ingredientName] || 0) >= ingredientCount) continue;
                    // Craftable intermediates (planks, sticks) are made, not mined.
                    if (bestRecipe(ingredientName, inventory).selected) continue;
                    const source = sourceBlockFor(ingredientName, held);
                    if (!source || explained.has(source)) continue;
                    const sourceDrops = dropNames(source);
                    lines.push(`${held || 'The current tool'} can harvest ${source}, which drops ${sourceDrops.join(', ') || ingredientName}.`);
                    explained.add(source);
                }
            }
        }
        const smeltOutput = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot' };
        for (const drop of drops) {
            if (!smeltOutput[drop]) continue;
            lines.push(`${drop} smelts into ${smeltOutput[drop]} in a furnace. ${stationLine(bot, inventory, 'furnace').replace(/\.+$/, '')}.`);
        }
    }

    for (const itemName of names) {
        if ((explained.has(itemName) || registry().blocksByName[itemName]) && !craftingIntent) continue;
        if (!registry().itemsByName[itemName]) continue;
        const smeltFrom = getItemSmeltingIngredient(itemName);
        if (smeltFrom) {
            lines.push(`${itemName} is obtained by smelting ${smeltFrom}, not by crafting it from unrelated materials.`);
            explained.add(itemName);
            continue;
        }
        const recipeInfo = bestRecipe(itemName, inventory);
        const recipe = recipeInfo.selected;
        if (!recipe) continue;
        // Un-compacting a storage block (raw_iron from raw_iron_block) is never
        // the answer to a mining or crafting problem; do not offer it.
        if (Object.keys(recipe.ingredients).every(name => name === `${itemName}_block`)) continue;
        const alternatives = formatRecipeAlternatives(recipeInfo.variants, recipe);
        lines.push(recipeLine(itemName, recipe, inventory, bot, alternatives));
        recipes.push({ item: itemName, ingredients: recipe.ingredients, variants: recipeInfo.variants });
        if (lines.length >= 8) break;
    }

    const capacity = wantsCapacity ? inventoryCapacityFacts(bot, wantedItems, { explainStacks }) : [];
    if (lines.length === 0) return { text: '', recipes, bed, capacity, yields, placement };
    const body = [...new Set(lines)].slice(0, 10).join('\n');
    return {
        text: `Verified Minecraft mechanics:\n${body.length > 1600 ? body.slice(0, 1599) + '…' : body}`,
        recipes,
        bed,
        capacity,
        yields,
        placement,
    };
}

/**
 * The inventory tool (if any) that can harvest a block, from registry data.
 * Returns null when the block has no tool requirement or no carried tool works.
 */
export function sufficientToolFor(blockName, inventory = {}, held = null) {
    const block = registry().blocksByName[blockName];
    if (!block?.harvestTools) return null;
    const candidates = [held, ...Object.keys(inventory)].filter(Boolean);
    return candidates.find(tool => canHarvest(blockName, tool) === true) || null;
}

function sentences(text) {
    return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(part => part.trim()).filter(Boolean);
}

const INVALID_CLAIM = /\binvalid\b|\b(?:cannot|can't|can not) be used\b|\b(?:not|n't)\b[^.!?]{0,40}\b(?:valid|recogni[sz]e[ds]?|accepted|usable|an ingredient)\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function countBefore(lower, noun) {
    const match = lower.match(new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join('|')})\\s+(?:\\w+\\s+)?${noun}s?\\b`));
    if (!match) return null;
    return NUMBER_WORDS[match[1]] ?? Number(match[1]);
}
const phrase = name => name.replace(/_/g, ' ');

/**
 * Deterministic check of model advice against the verified facts that were
 * given to it. The prompt tells the model not to contradict them, but a small
 * local model sometimes does anyway, so contradictions are corrected in the
 * returned text instead of trusted. Only specific, checkable claims are
 * handled; everything else passes through untouched.
 */
export function adviceCorrections(advice, detail = {}) {
    const corrections = [];
    const parts = sentences(advice);

    // 1. Claiming a verified recipe ingredient is invalid for the crafted item.
    for (const recipe of detail.recipes || []) {
        const names = new Set();
        for (const variant of recipe.variants || []) {
            for (const name of Object.keys(variant.ingredients)) names.add(name);
        }
        for (const name of Object.keys(recipe.ingredients || {})) names.add(name);
        const itemPhrase = phrase(recipe.item).replace(/s$/, '');
        for (const part of parts) {
            const lower = part.toLowerCase();
            if (!lower.includes(itemPhrase) || !INVALID_CLAIM.test(part)) continue;
            const claimed = [...names].find(name => lower.includes(phrase(name)));
            if (!claimed) continue;
            const variant = recipe.variants.find(entry => claimed in entry.ingredients) || { ingredients: recipe.ingredients };
            corrections.push(`${claimed} IS a valid ingredient for ${recipe.item} (recipe: ${formatIngredients(variant.ingredients)}).`);
            break;
        }
        // 2. A wrong crafting yield, e.g. "4 logs are needed for 4 planks".
        const single = (recipe.variants || []).find(entry => {
            const entries = Object.entries(entry.ingredients);
            return entries.length === 1 && entries[0][1] === 1 && entry.resultCount > 1;
        });
        if (single) {
            const ingredient = Object.keys(single.ingredients)[0];
            const base = phrase(ingredient).split(' ').pop();
            const itemBase = phrase(recipe.item).split(' ').pop().replace(/s$/, '');
            // Wrong only when the claim equates the two counts ("4 logs for 4
            // planks"); "2 logs for 8 planks" is correct and is left alone.
            const wrong = parts.find(part => {
                const lower = part.toLowerCase();
                if (!lower.includes(itemBase) || !/\b(need|needs|require|requires)\b/.test(lower)) return false;
                const inputs = countBefore(lower, base);
                const outputs = countBefore(lower, itemBase);
                return inputs != null && outputs != null && inputs === outputs && inputs > 1;
            });
            if (wrong) corrections.push(`One ${ingredient} makes ${single.resultCount} ${recipe.item} in a single craft.`);
        }
    }

    // 3. Bed ingredients.
    if (detail.bed) {
        const wrong = parts.find(part => /\bbed\b/i.test(part) && /\b(bedrock|stone)\b/i.test(part) &&
            !/\b(not|no other|isn't|never)\b/i.test(part));
        if (wrong) corrections.push(detail.bed);
    }

    // 4. Mining a block does not always give the block itself.
    for (const blockName of detail.yields || []) {
        const word = blockName.replace(/_/g, '[ _]');
        const pattern = new RegExp(`\\b(?:mine|mining|break|breaking|harvest|harvesting)\\b[^.!?]*\\b${word}\\b[^.!?]*\\b(?:yields?|gives?|produces?|drops?)\\b[^.!?]*\\b${word}\\b`, 'i');
        if (parts.some(part => pattern.test(part))) corrections.push(yieldNote(blockName));
    }

    // 4b. Needing a free slot in order to place a block.
    const placementClaim = parts.some(part => {
        if (!/\bplac(?:e|ing|ement)\b/i.test(part) || !/\b(slots?|inventory space|room|space)\b/i.test(part)) return false;
        if (/\b(not|n't|doesn't|does not|never|no need)\b/i.test(part)) return false;
        return /\b(free|empty|clear|make)\b[^.!?]{0,40}\b(slots?|space|room)\b/i.test(part)
            || /\b(need|needs|require|requires)\b[^.!?]{0,30}\b(free|empty|open)\b[^.!?]{0,15}\b(slots?|space)\b/i.test(part);
    });
    if (placementClaim) corrections.push(PLACEMENT_FACT);

    // 5. Gathering more items never frees inventory space.
    if ((detail.capacity || []).length > 0) {
        const wrong = parts.some(part =>
            /\b(mine|mining|collect|gather|harvest)\b[^.!?]{0,60}\b(to|will|would|can|and)\b[^.!?]{0,30}\b(free|clear|make)\b[^.!?]{0,30}\b(space|slots?|room)\b/i.test(part));
        if (wrong) corrections.push('Collecting or mining more of an item cannot free inventory space; only emptying a whole stack, placing, or storing items does.');
    }
    return [...new Set(corrections.filter(Boolean))];
}
