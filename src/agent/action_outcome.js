import * as world from './library/world.js';
import { expandBuildRequest } from './library/construction.js';
import { getBlockDropItems, getBlockMinimumDrop, getItemStackSize } from '../utils/mcdata.js';

export const ACTION_OUTCOME_VERSION = 1;
export const NORMAL_STORAGE_SLOTS = 36;

function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, stableObject(entry)])
    );
}

export function commandOutcomeKey(action, params={}) {
    return `${action}:${JSON.stringify(stableObject(params))}`;
}

export function normalStorageSnapshot(bot) {
    const slots = bot?.inventory?.slots || [];
    const configuredStart = Number(bot?.inventory?.inventoryStart);
    const start = Number.isInteger(configuredStart) ? configuredStart : 9;
    const end = Math.min(start + NORMAL_STORAGE_SLOTS, slots.length);
    let occupied = 0;
    for (let index = start; index < end; index++) {
        if (slots[index]) occupied++;
    }
    return {
        occupied,
        free: Math.max(0, NORMAL_STORAGE_SLOTS - occupied),
        capacity: NORMAL_STORAGE_SLOTS,
    };
}

/**
 * Whether the normal storage slots can take at least `count` more of an item:
 * either a completely empty slot exists, or existing partial stacks of that
 * same item have room. A full pack with a partial coal stack still accepts
 * coal; a full pack of unrelated stacks does not.
 */
export function storageAcceptsItem(bot, itemName, count=1) {
    const slots = bot?.inventory?.slots || [];
    const configuredStart = Number(bot?.inventory?.inventoryStart);
    const start = Number.isInteger(configuredStart) ? configuredStart : 9;
    const end = Math.min(start + NORMAL_STORAGE_SLOTS, slots.length);
    const stackSize = getItemStackSize(itemName);
    let room = 0;
    for (let index = start; index < end; index++) {
        const slot = slots[index];
        if (!slot) return true;
        if (slot.name === itemName) room += Math.max(0, (slot.stackSize || stackSize) - slot.count);
    }
    return room >= count;
}

/**
 * Items an action is expected to add to inventory, derived from drop data.
 * Returns [] when unknown, which callers treat conservatively.
 */
export function expectedItemsForCommand(action, params={}) {
    if (action === 'collectBlocks' && typeof params.type === 'string') {
        return getBlockDropItems(params.type);
    }
    return [];
}

/**
 * Used by the collection library to avoid refusing a block or item drop whose
 * product fits an existing partial stack even though no slot is empty.
 */
export function canStoreCollectionTarget(bot, target) {
    try {
        if (target?.constructor?.name === 'Entity') {
            const dropped = target.getDroppedItem?.();
            return Boolean(dropped?.name) && storageAcceptsItem(bot, dropped.name);
        }
        const items = getBlockDropItems(target?.name);
        return items.length > 0 && items.some(item => storageAcceptsItem(bot, item));
    }
    catch (_error) {
        return false;
    }
}

export function inventorySnapshot(bot) {
    return {
        counts: world.getInventoryCounts(bot),
        storage: normalStorageSnapshot(bot),
    };
}

export function inventoryChanges(before={}, after={}) {
    const changes = {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const previous = before[name] || 0;
        const current = after[name] || 0;
        if (previous !== current) {
            changes[name] = { before: previous, after: current, delta: current - previous };
        }
    }
    return changes;
}

export function positiveInventoryChange(changes={}) {
    return Object.values(changes).reduce((total, change) => total + Math.max(0, change.delta), 0);
}

/**
 * Verifies the product of a smelting action against inventory evidence.
 *
 * Only the expected product counts. Unrelated gains (cobblestone picked up
 * while the furnace ran, the placed furnace, a returned bucket) are never
 * evidence. The expected product comes from recipe knowledge when available,
 * otherwise from the item the furnace actually returned. When both exist and
 * disagree, nothing is verified. Verified quantity is capped at the amount
 * the furnace reported handing over, so stray pickups of the same item cannot
 * inflate it.
 */
export function verifySmeltingProduct({ changes={}, expectedProduct=null, observed=null }) {
    const observedProduct = observed?.product || null;
    const taken = Math.max(0, Number(observed?.taken) || 0);
    const product = expectedProduct || observedProduct;
    const mismatch = Boolean(expectedProduct && observedProduct && expectedProduct !== observedProduct);
    if (!product || mismatch) {
        return { product, observedProduct, taken, delta: 0, verified: 0, mismatch };
    }
    const delta = Math.max(0, changes[product]?.delta || 0);
    return { product, observedProduct, taken, delta, verified: Math.min(delta, taken), mismatch };
}

export function countChanges(changes={}) {
    return Object.values(changes).reduce((total, change) => total + change.delta, 0);
}

const TOOL_NAME = /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/;
export const COLLECTION_RETRY_AREA_RADIUS = 24;

/**
 * Collection-specific retry state. The broad fingerprint (exact position plus
 * every inventory count) is changed by the failed attempt's own side effects:
 * stuck recovery moves the bot a few blocks, and tunnelling picks up
 * incidental cobblestone. Neither makes the same target any more reachable.
 * What does: obtaining more of the expected drops, gaining or losing a tool,
 * or relocating to a genuinely different area.
 */
export function collectionRelevantState(bot, expectedItems=[]) {
    const counts = world.getInventoryCounts(bot);
    const pos = bot?.entity?.position;
    return {
        items: Object.fromEntries([...expectedItems].sort().map(name => [name, counts[name] || 0])),
        tools: Object.keys(counts).filter(name => TOOL_NAME.test(name)).sort(),
        position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    };
}

export function collectionRelevantStateChanged(previous, bot) {
    if (!previous) return true;
    const current = collectionRelevantState(bot, Object.keys(previous.items || {}));
    if (JSON.stringify(current.items) !== JSON.stringify(previous.items)) return true;
    if (JSON.stringify(current.tools) !== JSON.stringify(previous.tools)) return true;
    if (previous.position && current.position) {
        const dx = current.position.x - previous.position.x;
        const dz = current.position.z - previous.position.z;
        if (Math.hypot(dx, dz) >= COLLECTION_RETRY_AREA_RADIUS) return true;
        if (Math.abs(current.position.y - previous.position.y) >= COLLECTION_RETRY_AREA_RADIUS) return true;
    }
    return false;
}

/**
 * Items whose arrival counts as collecting the requested block. Includes the
 * requested block's normal drops, silk-touch drops (the block's own item), and
 * the drops of the blocks the skill actually mined (grass_block yields dirt,
 * stone yields cobblestone, deepslate variants share their ore's drops).
 */
export function collectionExpectedItems(requestedType, minedBlocks=[]) {
    const names = new Set(getBlockDropItems(requestedType, { includeSilkTouch: true }));
    for (const mined of minedBlocks) {
        for (const item of getBlockDropItems(mined, { includeSilkTouch: true })) names.add(item);
    }
    return [...names];
}

/**
 * Splits observed inventory changes into expected target drops and incidental
 * changes, and judges collection from target evidence only. Item counts are
 * never compared with block counts: Fortune, variable stack ranges and chance
 * drops make that unsound. Instead the verified-broken block count is compared
 * with the request, and item evidence must show at least one expected drop,
 * plus the guaranteed per-block minimum where the drop table defines one.
 */
export function verifyCollection({ requestedType, requested, changes={}, observed=null }) {
    const minedBlocks = observed?.minedBlocks || [];
    const harvested = Math.max(0, Number(observed?.harvested) || 0);
    const expectedItems = collectionExpectedItems(requestedType, minedBlocks);
    const targetChanges = {};
    const incidentalChanges = {};
    for (const [name, change] of Object.entries(changes)) {
        if (expectedItems.includes(name)) targetChanges[name] = change;
        else incidentalChanges[name] = change;
    }
    const targetGained = Object.values(targetChanges).reduce((total, change) => total + Math.max(0, change.delta), 0);
    const minimumExpected = minedBlocks.reduce((total, name) => total + getBlockMinimumDrop(name), 0);
    const incidentalGained = Object.values(incidentalChanges).reduce((total, change) => total + Math.max(0, change.delta), 0);
    let verdict = 'none';
    if (targetGained > 0) {
        verdict = harvested >= requested && targetGained >= minimumExpected ? 'complete' : 'partial';
    }
    return {
        requestedType,
        requestedBlocks: requested,
        harvestedBlocks: harvested,
        minedBlocks,
        expectedItems,
        targetChanges,
        targetGained,
        minimumExpected,
        incidentalChanges,
        incidentalGained,
        verdict,
    };
}

/**
 * Applies one command outcome to the repetition watchdog counts. Only
 * verified relevant progress clears a command's count; failures and outcomes
 * without relevant progress (including incidental inventory gains) add to it.
 * Equivalent attempts share `behaviorKey` (same intent and blocker). An
 * unstructured result never erases unrelated counts: a zero-progress dig or
 * a rejected command used to look like success and wipe the watchdog.
 */
export function updateRepeatCounts(counts, commandKey, { structuredOutcome=null, failed=false, isSearch=false, isThink=false, thought=false, behaviorKey=null }={}) {
    const key = behaviorKey || structuredOutcome?.behaviorKey || commandKey;
    const mark = () => {
        counts.set(key, (counts.get(key) || 0) + 1);
        // !placeBlockAt, !buildPlane and !buildLine with no arguments are one
        // mistake: the model emitted a command name and left off its parameters.
        if (structuredOutcome?.evidence?.missingArguments || structuredOutcome?.details?.missingArguments) {
            const shared = 'validation:missing_arguments';
            counts.set(shared, (counts.get(shared) || 0) + 1);
        }
    };
    const clear = () => {
        counts.delete(key);
        if (key !== commandKey) counts.delete(commandKey);
        counts.delete('validation:missing_arguments');
    };
    if (isThink) {
        if (!thought) counts.set(commandKey, (counts.get(commandKey) || 0) + 1);
    } else if (structuredOutcome) {
        if (failed || !structuredOutcome.relevantProgress) mark();
        else clear();
    } else if (failed || isSearch) {
        mark();
    } else {
        clear();
    }
    return counts;
}

const BUILD_KINDS = { placeBlockAt: 'block', buildLine: 'line', buildPlane: 'plane' };

/** Sorted target cells for a construction command, or null when the request is not a build. */
export function constructionCellKey(action, params = {}) {
    const kind = BUILD_KINDS[action];
    if (!kind || typeof params.type !== 'string') return null;
    const coords = kind === 'block'
        ? [params.x, params.y, params.z]
        : [params.x1, params.y1, params.z1, params.x2, params.y2, params.z2];
    try {
        const expanded = expandBuildRequest(kind, params.type, coords);
        if (!expanded?.ok || !expanded.positions?.length) return null;
        const cells = expanded.positions
            .map(position => `${position.x},${position.y},${position.z}`)
            .sort()
            .join('|');
        return `${params.type}:${cells}`;
    } catch {
        return null;
    }
}

export function positionAnchor(bot) {
    const pos = bot?.entity?.position;
    if (!pos || ![pos.x, pos.y, pos.z].every(value => Number.isFinite(Number(value)))) return null;
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/** Zero-progress digs at the same column share a key. Distance is not part of it. */
export function digBehaviorKey(stop, bot) {
    const anchor = positionAnchor(bot);
    if (!stop || !anchor || stop === 'interrupted' || stop === 'completed') return null;
    return `digDown:${stop}:${anchor}`;
}

export function validationBehaviorKey(commandName) {
    const name = String(commandName || '!unknown');
    return `validation:${name.startsWith('!') ? name : `!${name}`}`;
}

/**
 * How many times this attempt, or an equivalent one, has already failed.
 * Malformed commands group by command name. digDown groups by column and
 * stop reason. Construction groups by the exact set of target blocks.
 */
export function blockingRepeatCount(counts, { commandKey, commandName, action, params, bot, parsedOk, missingArguments = false }) {
    let highest = counts.get(commandKey) || 0;
    if (!parsedOk && commandName) {
        highest = Math.max(highest, counts.get(validationBehaviorKey(commandName)) || 0);
    }
    if (missingArguments) {
        highest = Math.max(highest, counts.get('validation:missing_arguments') || 0);
    }
    if (action === 'digDown' && bot) {
        const anchor = positionAnchor(bot);
        for (const [key, count] of counts) {
            if (anchor && key.startsWith('digDown:') && key.endsWith(`:${anchor}`)) highest = Math.max(highest, count);
        }
    }
    const cells = constructionCellKey(action, params);
    if (cells) {
        const marker = `construction:${cells}:`;
        for (const [key, count] of counts) {
            if (key.startsWith(marker)) highest = Math.max(highest, count);
        }
    }
    return highest;
}

/** A returned error string is not evidence that the command succeeded. */
export function isCommandRejection(text) {
    const value = String(text || '');
    return /was given \d+ args|is not a command|incorrectly formatted|Invalid parameter|Invalid block|Invalid item|UNCHANGED BLOCKING CONDITION|REPEATED ACTION BLOCKED|reserved for the human operator|\bError:/i.test(value)
        || /Dug down 0 blocks/i.test(value);
}

export function makeValidationOutcome({ agent, commandName, message, signature }) {
    const name = String(commandName || '!command');
    const action = name.replace(/^!/, '') || 'command';
    const behaviorKey = validationBehaviorKey(name);
    let before = { counts: {}, storage: null };
    let after = before;
    try {
        before = inventorySnapshot(agent?.bot);
        after = before;
    } catch {
        before = { counts: {}, storage: null };
        after = before;
    }
    return createActionOutcome({
        action,
        params: {},
        status: 'failure',
        before,
        after,
        reason: {
            code: /is not a command/i.test(message) ? 'unknown_command' : 'invalid_arguments',
            message,
            prerequisites: signature
                ? [`Use ${signature}. Do not repeat this invalid command.`]
                : ['Use a documented command with its required arguments.'],
            condition: 'invalid_request',
        },
        retryableWithoutStateChange: false,
        relevantProgress: false,
        behaviorKey,
        details: {
            validation: true,
            signature: signature || '',
            behaviorKey,
            missingArguments: /was given 0 args/.test(message),
        },
        bot: agent?.bot,
    });
}

function stateFingerprint(bot) {
    const snapshot = inventorySnapshot(bot);
    const pos = bot?.entity?.position;
    return JSON.stringify({
        counts: stableObject(snapshot.counts),
        free: snapshot.storage.free,
        position: pos ? [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)] : null,
    });
}

export function observedStateFingerprint(bot) {
    return stateFingerprint(bot);
}

export function classifyFailure(message='', fallback='action_failed') {
    const text = String(message || '');
    if (/inventory full|no place to deposit/i.test(text)) {
        return {
            code: 'inventory_capacity',
            message: 'Normal inventory storage is full.',
            prerequisites: ['Free at least one normal storage slot.'],
            condition: 'inventory_capacity',
        };
    }
    if (/right tools?|without a pickaxe|need(?:s)? .*pickaxe|cannot break .*current tools/i.test(text)) {
        return {
            code: 'missing_tool',
            message: 'A suitable harvesting tool is not available.',
            prerequisites: ['Acquire and equip a tool that can harvest the target block.'],
            condition: 'state_changed',
        };
    }
    // Deterministic request errors: the identical request can never succeed.
    if (/cannot smelt .*hint|not an item, or it does not have a crafting recipe/i.test(text)) {
        return {
            code: 'invalid_request',
            message: 'The requested item cannot be used with this command.',
            prerequisites: ['Choose a different item, or use the raw form of the item for smelting.'],
            condition: 'invalid_request',
        };
    }
    if (/furnace is currently smelting/i.test(text)) {
        return {
            code: 'workstation_busy',
            message: 'The nearby furnace is occupied by a different smelting job.',
            prerequisites: ['Clear the furnace (!clearFurnace) or use a different furnace.'],
            condition: 'state_changed',
        };
    }
    // Must precede the generic "don't have" check: the skill reports short
    // fuel as "You don't have enough <fuel> to smelt N <item>; you need M."
    if (/don't have enough .+ to smelt .+; you need \d+/i.test(text)) {
        return {
            code: 'missing_fuel',
            message: 'Smelting fuel is missing or insufficient.',
            prerequisites: ['Acquire enough coal, charcoal, or usable wood fuel.'],
            condition: 'state_changed',
        };
    }
    if (/no furnace nearby|no furnace/i.test(text)) {
        return {
            code: 'missing_workstation',
            message: 'A furnace must be available and placed nearby.',
            prerequisites: ['Place or find a furnace.'],
            condition: 'state_changed',
        };
    }
    if (/crafting_table|crafting table/i.test(text) && /requires|no |need/i.test(text)) {
        return {
            code: 'missing_workstation',
            message: 'A crafting table must be available and placed nearby.',
            prerequisites: ['Place or find a crafting table.'],
            condition: 'state_changed',
        };
    }
    if (/no fuel|need coal, charcoal, or wood|enough .*fuel/i.test(text)) {
        return {
            code: 'missing_fuel',
            message: 'Smelting fuel is missing or insufficient.',
            prerequisites: ['Acquire enough coal, charcoal, or usable wood fuel.'],
            condition: 'state_changed',
        };
    }
    if (/do not have|don't have|not enough|missing:|resources allowed \d+/i.test(text)) {
        return {
            code: 'missing_resource',
            message: 'Required inventory resources are missing or insufficient.',
            prerequisites: ['Acquire the resources named in the command feedback.'],
            condition: 'state_changed',
        };
    }
    if (/no .* nearby|could not reach|unable to reach|no path|pathfinding stopped|repeatedly unreachable|no meaningful progress|temporarily avoiding/i.test(text)) {
        return {
            code: 'target_unavailable',
            message: 'No currently reachable target was found.',
            prerequisites: ['Move to a different area or make the target reachable.'],
            condition: 'state_changed',
        };
    }
    if (/timed out|took to long/i.test(text)) {
        return {
            code: 'timeout',
            message: 'The action exceeded its execution time limit.',
            prerequisites: ['Change the route, target, or approach before retrying.'],
            condition: 'state_changed',
        };
    }
    if (/interrupt/i.test(text)) {
        return {
            code: 'interrupted',
            message: 'The action was interrupted.',
            prerequisites: [],
            condition: 'state_changed',
        };
    }
    return {
        code: fallback,
        message: 'The requested action was not verified as complete.',
        prerequisites: [],
        condition: 'state_changed',
    };
}

export function createActionOutcome({
    action,
    params={},
    status,
    before,
    after,
    worldChanges=[],
    reason=null,
    retryableWithoutStateChange=true,
    relevantProgress=false,
    details={},
    relevantState=null,
    behaviorKey=null,
    bot=null,
}) {
    const inventoryBefore = before?.counts || {};
    const inventoryAfter = after?.counts || {};
    const changes = inventoryChanges(inventoryBefore, inventoryAfter);
    const storageBefore = before?.storage || null;
    const storageAfter = after?.storage || null;
    const freedSlots = storageBefore && storageAfter
        ? Math.max(0, storageAfter.free - storageBefore.free)
        : 0;
    return {
        version: ACTION_OUTCOME_VERSION,
        action,
        params,
        commandKey: commandOutcomeKey(action, params),
        behaviorKey: behaviorKey || null,
        status,
        success: status === 'success',
        relevantProgress: Boolean(relevantProgress),
        evidence: {
            inventory: { before: inventoryBefore, after: inventoryAfter, changes },
            storage: storageBefore && storageAfter
                ? { before: storageBefore, after: storageAfter, freedSlots, capacityRelief: freedSlots > 0 }
                : null,
            world: worldChanges,
            ...details,
        },
        reason,
        retry: {
            reasonableWithoutStateChange: Boolean(retryableWithoutStateChange),
            condition: reason?.condition || null,
            stateFingerprint: bot ? stateFingerprint(bot) : null,
            relevantState,
        },
        observedAt: new Date().toISOString(),
    };
}

function changedSummary(changes) {
    const entries = Object.entries(changes || {});
    if (entries.length === 0) return 'inventory unchanged';
    return entries
        .map(([name, change]) => `${name} ${change.before}->${change.after} (${change.delta > 0 ? '+' : ''}${change.delta})`)
        .join(', ');
}

export function formatActionOutcome(outcome) {
    if (!outcome) return '';
    const parts = [
        `Verified outcome: ${outcome.status.toUpperCase()} for ${outcome.action}.`,
        `Observed changes: ${changedSummary(outcome.evidence?.inventory?.changes)}.`,
    ];
    if (outcome.evidence?.construction?.summary) parts.push(outcome.evidence.construction.summary);
    if (outcome.evidence?.dig) {
        const dig = outcome.evidence.dig;
        parts.push(`Excavated ${dig.excavated} of ${dig.requested} block(s) (${dig.stop}).`);
    }
    if (outcome.evidence?.validation && outcome.evidence.signature) {
        parts.push(`Correct form: ${outcome.evidence.signature}.`);
    }
    const storage = outcome.evidence?.storage;
    if (storage) {
        parts.push(
            `Normal storage: ${storage.before.occupied}/${storage.before.capacity} -> ` +
            `${storage.after.occupied}/${storage.after.capacity} occupied; ` +
            `${storage.freedSlots} slot${storage.freedSlots === 1 ? '' : 's'} freed.`
        );
    }
    if (outcome.reason) {
        parts.push(`Reason: ${outcome.reason.message}`);
        if (outcome.reason.prerequisites?.length)
            parts.push(`Prerequisite: ${outcome.reason.prerequisites.join(' ')}`);
    }
    parts.push(
        `Retry without a relevant state change: ${outcome.retry.reasonableWithoutStateChange ? 'reasonable' : 'not reasonable'}.`
    );
    return parts.join(' ');
}

export function isStructuredOutcome(value) {
    return Boolean(value && value.version === ACTION_OUTCOME_VERSION && value.action && value.status);
}
