import minecraftData from 'minecraft-data';
import settings from './settings.js';
import { getCraftingRecipeVariants } from '../utils/crafting.js';

/**
 * Resource sufficiency for persistent plans.
 *
 * A plan lists the materials its objective needs ({item, count}). The ledger
 * compares that against the LIVE inventory so the planner (and the prompt)
 * can tell materials already on hand apart from materials still needed, and
 * so gathering steps for sufficient materials can be skipped.
 */

let registryCache = null;

function registry() {
    if (!registryCache) {
        const version = settings.minecraft_version && settings.minecraft_version !== 'auto'
            ? settings.minecraft_version
            : '1.21.6';
        registryCache = minecraftData(version);
    }
    return registryCache;
}

function knownName(name) {
    const mc = registry();
    return Boolean(mc.itemsByName[name] || mc.blocksByName[name]);
}

/**
 * Accepts [{item, count}], [{name, count}] or {item: count}; drops entries that
 * are not real Minecraft items/blocks or have no positive quantity.
 */
export function normalizeMaterials(raw, limit=12) {
    const entries = [];
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            if (!entry || typeof entry !== 'object') continue;
            entries.push([entry.item ?? entry.name, entry.count ?? entry.quantity ?? entry.num]);
        }
    } else if (raw && typeof raw === 'object') {
        entries.push(...Object.entries(raw));
    }
    const merged = new Map();
    for (const [rawName, rawCount] of entries) {
        const name = String(rawName || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
        const count = Math.floor(Number(rawCount));
        if (!name || !Number.isFinite(count) || count < 1 || !knownName(name)) continue;
        merged.set(name, Math.min(4096, Math.max(merged.get(name) || 0, count)));
    }
    return [...merged].slice(0, limit).map(([item, count]) => ({ item, count }));
}

function effectiveCount(counts, name) {
    let count = counts[name] || 0;
    if (name.endsWith('_planks')) {
        const wood = name.slice(0, -'_planks'.length);
        count += (counts[`${wood}_log`] || 0) * 4;
        count += (counts[`${wood}_wood`] || 0) * 4;
    }
    return count;
}

function craftPlan(item, missing, counts) {
    if (missing <= 0) return null;
    let variants = [];
    try {
        variants = getCraftingRecipeVariants(registry(), item);
    } catch (_error) {
        return null;
    }
    for (const variant of variants) {
        if (variant.ingredients[item]) continue;
        const crafts = Math.ceil(missing / variant.resultCount);
        const feasible = Object.entries(variant.ingredients)
            .every(([name, required]) => required * crafts <= effectiveCount(counts, name));
        if (feasible) {
            return {
                crafts,
                produces: crafts * variant.resultCount,
                ingredients: Object.fromEntries(
                    Object.entries(variant.ingredients).map(([name, required]) => [name, required * crafts])
                ),
                requiresTable: variant.requiresTable,
            };
        }
    }
    return null;
}

function consume(remaining, name, amount) {
    let left = amount;
    const direct = Math.min(remaining[name] || 0, left);
    if (direct > 0) {
        remaining[name] -= direct;
        left -= direct;
    }
    if (left > 0 && name.endsWith('_planks')) {
        // Planks beyond what is held come from logs: 1 log -> 4 planks.
        const wood = name.slice(0, -'_planks'.length);
        for (const source of [`${wood}_log`, `${wood}_wood`]) {
            if (left <= 0) break;
            const logs = Math.min(remaining[source] || 0, Math.ceil(left / 4));
            if (logs > 0) {
                remaining[source] -= logs;
                left -= logs * 4;
            }
        }
    }
}

/**
 * @param {{item:string,count:number}[]} materials
 * @param {Object<string,number>} counts live inventory counts
 * @returns {{item,need,have,missing,surplus,status,craft}[]}
 *   status: 'available' (held), 'craftable' (obtainable by crafting what is
 *   held; no gathering needed) or 'missing' (must be gathered/obtained).
 */
export function materialLedger(materials, counts={}) {
    const remaining = { ...counts };
    const ledger = materials.map(({ item, count }) => {
        const have = counts[item] || 0;
        return { item, need: count, have, missing: Math.max(0, count - have), surplus: Math.max(0, have - count), status: 'missing', craft: null };
    });
    // Reserve directly held materials first so a held log isn't counted twice
    // (as a log need and as planks).
    for (const entry of ledger) {
        if (entry.have >= entry.need) {
            entry.status = 'available';
            consume(remaining, entry.item, entry.need);
        }
    }
    for (const entry of ledger) {
        if (entry.status === 'available') continue;
        const heldUse = Math.min(remaining[entry.item] || 0, entry.need);
        const stillMissing = entry.need - heldUse;
        const craft = craftPlan(entry.item, stillMissing, remaining);
        if (craft) {
            entry.status = 'craftable';
            entry.craft = craft;
            consume(remaining, entry.item, heldUse);
            for (const [name, amount] of Object.entries(craft.ingredients)) consume(remaining, name, amount);
        }
    }
    return ledger;
}

export function ledgerSatisfied(ledger) {
    return ledger.length > 0 && ledger.every(entry => entry.status !== 'missing');
}

export function describeLedger(ledger) {
    return ledger.map(entry => {
        const head = `- ${entry.item}: need ${entry.need}, have ${entry.have}`;
        if (entry.status === 'available') {
            return `${head} -> AVAILABLE${entry.surplus ? ` (surplus ${entry.surplus})` : ''}; no gathering needed`;
        }
        if (entry.status === 'craftable') {
            const parts = Object.entries(entry.craft.ingredients).map(([name, count]) => `${name} x${count}`).join(', ');
            return `${head} -> short ${entry.missing}, but CRAFTABLE from your inventory (${parts}${entry.craft.requiresTable ? '; needs a crafting table' : ''}); no gathering needed`;
        }
        return `${head} -> still MISSING ${entry.missing}; must be gathered, mined, smelted or otherwise obtained`;
    });
}

function dropItemsFor(blockName) {
    try {
        const drops = getBlockDrops(blockName);
        if (drops.length) return drops;
    } catch (_error) { /* fall through */ }
    return [blockName];
}

function getBlockDrops(blockName) {
    const mc = registry();
    const block = mc.blocksByName[blockName];
    if (!block) return [];
    return (block.drops || [])
        .map(drop => mc.items[typeof drop === 'object' ? (drop.drop?.id ?? drop.drop) : drop]?.name)
        .filter(Boolean);
}

/**
 * Decides whether a plan step only gathers or crafts something the plan's own
 * material ledger says is already on hand (or craftable without gathering).
 * Returns a human-readable reason, or null if the step is not redundant.
 */
export function redundantStepReason(step, ledger) {
    const action = step?.action;
    if (!action?.name || !ledger?.length) return null;
    const find = item => ledger.find(entry => entry.item === item);
    if (action.name === 'collectBlocks' && typeof action.params?.type === 'string') {
        for (const item of [action.params.type, ...dropItemsFor(action.params.type)]) {
            const entry = find(item);
            if (entry && entry.status === 'available') {
                return `${entry.item}: need ${entry.need}, already have ${entry.have}`;
            }
        }
    }
    if (action.name === 'craftRecipe' && typeof action.params?.recipe_name === 'string') {
        const entry = find(action.params.recipe_name);
        if (entry && entry.status === 'available') {
            return `${entry.item}: need ${entry.need}, already have ${entry.have}`;
        }
    }
    return null;
}

/**
 * Could this step put `item` in the inventory? Used to check that every
 * material a plan needs but does not hold has a step that obtains it.
 * smeltItem is accepted for any item because furnace products depend on
 * recipes the planner may legitimately rely on.
 */
export function stepProduces(step, item) {
    const action = step?.action;
    if (!action?.name) return false;
    const params = action.params || {};
    if (action.name === 'collectBlocks' && typeof params.type === 'string') {
        return params.type === item || dropItemsFor(params.type).includes(item);
    }
    if (action.name === 'craftRecipe') return params.recipe_name === item;
    if (action.name === 'takeFromChest') return params.item_name === item;
    if (action.name === 'smeltItem') return true;
    return false;
}

/**
 * Clamp resource-acquisition actions to the live deficit. Planner-proposed
 * quantities are suggestions; the authoritative need comes from the material
 * ledger (which, for construction, is derived from unsatisfied coordinates).
 */
export function rightsizeResourceStep(step, ledger) {
    const action = step?.action;
    if (!action?.name || !action.params || !Array.isArray(ledger)) return false;
    let entry = null;
    let requested = null;
    if (action.name === 'collectBlocks') {
        entry = ledger.find(candidate => candidate.missing > 0 && stepProduces(step, candidate.item));
        if (entry) requested = entry.missing;
    } else if (action.name === 'craftRecipe') {
        entry = ledger.find(candidate => candidate.item === action.params.recipe_name && candidate.missing > 0);
        if (entry) {
            let resultCount = 1;
            try {
                resultCount = getCraftingRecipeVariants(registry(), entry.item)[0]?.resultCount || 1;
            } catch (_error) { /* retain the conservative one-item yield */ }
            requested = Math.ceil(entry.missing / resultCount);
        }
    }
    if (!entry || !Number.isFinite(requested) || requested < 1) return false;
    let changed = false;
    if (action.params.num !== requested) {
        action.params.num = requested;
        changed = true;
    }
    if (step.evidence?.type === 'inventory_min' && step.evidence.item === entry.item && step.evidence.count !== entry.need) {
        step.evidence.count = entry.need;
        changed = true;
    }
    return changed;
}
