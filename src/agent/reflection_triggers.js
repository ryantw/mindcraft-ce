import {
    reflect,
    reflectionConfig,
    reflectionState,
    reflectionsInFlight,
} from './reasoning.js';
import { ACCOMPLISHMENT_TAG, recordLesson } from './lessons.js';
import { sufficientToolFor, inventoryCounts } from './mechanics.js';
import { expectedItemsForCommand } from './action_outcome.js';
import { getCraftingRecipeInfo } from '../utils/mcdata.js';

/**
 * Automatic reflection. This module only decides WHEN to call the existing
 * reflect() and with what evidence. It does not prompt, reason, or hold model
 * state. Triggers come from structured action outcomes (relevant progress,
 * blocked retries, failure reasons) and never from items merely appearing in
 * the inventory.
 */

const RECENT_LIMIT = 8;

// Actions that do something in the world toward an objective. A verified
// success from one of these ends an inventory-management streak; navigation,
// conversation and bookkeeping do not. Chest storing is a legitimate way to
// manage inventory, so it neither counts toward nor breaks a streak.
const SUBSTANTIVE = new Set([
    'collectBlocks', 'craftRecipe', 'smeltItem', 'clearFurnace', 'placeHere', 'useOn',
    'digDown', 'attack', 'attackPlayer', 'consume', 'equip', 'tradeWithVillager', 'givePlayer',
]);
const CHEST_ACTIONS = new Set(['putInChest', 'takeFromChest']);
const MANAGEMENT_KEY = 'inventory_management';
const PENDING_GIVE_UP_ACTIONS = 6;

function firstQuoted(commandKey) {
    return String(commandKey || '').match(/"([^"]*)"/)?.[1] || '';
}

function clipText(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

/**
 * Problems are keyed by what the agent is trying to do, not by quantity:
 * collectBlocks("iron_ore", 1) and (..., 4) are the same problem. Inventory
 * capacity is one global problem regardless of which item hit it.
 */
export function problemKeyFor(action, commandKey, outcome = null, blocked = null) {
    if (outcome?.reason?.code === 'inventory_capacity' || blocked?.condition === 'inventory_capacity') {
        return 'capacity';
    }
    // Equivalent attempts (different text, same intent and blocker) share a key.
    if (outcome?.behaviorKey) return outcome.behaviorKey;
    if (blocked?.behaviorKey) return blocked.behaviorKey;
    return `${action}:${firstQuoted(commandKey)}`;
}

function gains(changes) {
    return Object.entries(changes || {})
        .filter(([, change]) => change.delta > 0)
        .map(([name, change]) => `${name} +${change.delta}`)
        .join(', ');
}

/** One line of expected versus actual, from the structured evidence. */
export function summarizeOutcome(outcome) {
    if (!outcome) return '';
    const evidence = outcome.evidence || {};
    const collection = evidence.collection;
    if (collection) {
        // Name the normal drop (raw_iron), not the ore block that only a
        // Silk Touch tool would yield as an item.
        const normal = collection.expectedItems.filter(item => item !== collection.requestedType);
        const shown = normal.length ? normal : collection.expectedItems;
        const expected = shown.slice(0, 3).join(' or ') || 'the requested drop';
        const target = gains(collection.targetChanges) || `${shown[0] || 'target item'} +0`;
        const incidental = gains(collection.incidentalChanges);
        return `Expected ${expected}; actual ${target}; ${collection.harvestedBlocks}/${collection.requestedBlocks} blocks confirmed broken.` +
            `${incidental ? ` Incidental (not progress): ${incidental}.` : ''}`;
    }
    if (evidence.smelting) {
        return `Expected ${evidence.smelting.product || 'a smelted product'}; verified ${evidence.smelting.verified} of ${evidence.requested ?? '?'}.`;
    }
    if (evidence.produced) {
        return `Expected ${evidence.requestedExecutions} craft(s) of ${evidence.produced.item}; produced ${evidence.produced.count}.`;
    }
    if (evidence.dig) {
        return `Excavated ${evidence.dig.excavated} of ${evidence.dig.requested} blocks (stop: ${evidence.dig.stop}).`;
    }
    if (evidence.validation) {
        return `${outcome.reason?.message || 'The command was rejected.'} Correct form: ${evidence.signature || 'see the command docs'}.`;
    }
    if (evidence.construction) {
        const construction = evidence.construction;
        return `Expected new ${construction.type}; placed ${construction.verifiedPlaced}, already in place ${construction.alreadySatisfied}, remaining ${construction.remaining}.`;
    }
    if (outcome.action === 'discard') {
        const storage = evidence.storage;
        const slots = storage ? ` Free normal storage slots: ${storage.before.free} -> ${storage.after.free}.` : '';
        return `Removed ${evidence.removed ?? 0} of ${evidence.requested ?? '?'}; normal storage slots freed: ${storage?.freedSlots ?? 0}.${slots}`;
    }
    if (evidence.placedBlock) {
        return `Placed ${evidence.placedBlock.type} (verified in the world).`;
    }
    return `Observed: ${gains(evidence.inventory?.changes) || 'no inventory gain'}.`;
}

function tryRecord(agent, lesson) {
    try {
        if (recordLesson(agent, lesson)) {
            console.log(`[${agent.name}] Verified lesson retained: ${lesson.id} (${lesson.basis})`);
        }
    } catch (error) {
        console.warn(`[${agent.name}] Could not retain lesson ${lesson.id}: ${error.message}`);
    }
}

/**
 * Lessons come only from code-verified facts: registry data, or evidence in a
 * structured outcome. Never from reflection text.
 */
const REMEMBERED_PLACEMENTS = new Set([
    'crafting_table', 'furnace', 'chest', 'trapped_chest', 'barrel',
    'smoker', 'blast_furnace', 'enchanting_table', 'anvil', 'brewing_stand',
    'loom', 'cartography_table', 'fletching_table', 'smithing_table',
    'stonecutter', 'grindstone', 'composter', 'cauldron', 'lectern',
]);

function rememberPlacement(type) {
    return REMEMBERED_PLACEMENTS.has(type) || String(type || '').endsWith('_bed');
}

/** Ingredients actually consumed, per craft when the count divides evenly. */
function consumedIngredients(outcome, item) {
    const changes = outcome.evidence?.inventory?.changes || {};
    const executions = Math.max(1, Number(outcome.evidence?.requestedExecutions) || 1);
    const consumed = [];
    for (const [name, change] of Object.entries(changes)) {
        if (name === item || !(change?.delta < 0)) continue;
        const total = -change.delta;
        consumed.push([name, total % executions === 0 ? total / executions : total]);
    }
    consumed.sort((a, b) => a[0].localeCompare(b[0]));
    return consumed;
}

function craftFactText(outcome) {
    const produced = outcome.evidence?.produced;
    if (!produced?.item || !(produced.count > 0)) return null;
    const item = produced.item;
    const consumed = consumedIngredients(outcome, item);
    let requiresTable = false;
    try {
        requiresTable = Boolean(getCraftingRecipeInfo(item, outcome.evidence?.inventory?.before || {}).selected?.requiresTable);
    } catch {
        requiresTable = false;
    }
    let text = `Crafted ${item}`;
    if (consumed.length) text += ` from ${consumed.map(([name, count]) => `${count} ${name}`).join(' + ')}`;
    if (requiresTable) text += ' at a crafting table';
    return `${text}.`;
}

function placementFactText(outcome) {
    const placed = outcome.evidence?.placedBlock;
    if (!placed?.type || !rememberPlacement(placed.type)) return null;
    const position = placed.position;
    const coords = [position?.x, position?.y, position?.z];
    const where = coords.every(value => Number.isFinite(Number(value)))
        ? ` at (${coords.map(value => Math.floor(Number(value))).join(', ')})`
        : '';
    return `Placed ${placed.type}${where}.`;
}

function retainOutcomeLessons(agent, outcome) {
    if (!outcome) return;
    if (outcome.action === 'discard') {
        const storage = outcome.evidence?.storage;
        const change = Object.values(outcome.evidence?.inventory?.changes || {})[0];
        if (storage && storage.freedSlots === 0 && change && change.delta < 0) {
            tryRecord(agent, {
                id: 'capacity:partial_discard',
                text: 'Discarding part of a stack does not free an inventory slot; only emptying the whole stack does.',
                basis: 'observed',
                evidence: `discard changed ${outcome.params.item_name} ${change.before}->${change.after} and freed ${storage.freedSlots} normal storage slots`,
                tags: ['capacity', 'discard'],
            });
        }
    }
    // A verified craft or workstation placement is a fact of its own. It is
    // not left to the 500-character summary, which is told to drop equipment
    // and routine successes.
    if (outcome.status === 'failure' || !outcome.relevantProgress) return;
    const craft = outcome.action === 'craftRecipe' ? craftFactText(outcome) : null;
    if (craft) {
        const item = outcome.evidence.produced.item;
        tryRecord(agent, {
            id: `crafted:${item}`,
            text: craft,
            basis: 'observed',
            evidence: `craftRecipe produced ${outcome.evidence.produced.count} ${item}`,
            tags: [ACCOMPLISHMENT_TAG, 'craftRecipe', item],
        });
    }
    const placement = outcome.action === 'placeHere' ? placementFactText(outcome) : null;
    if (placement) {
        const type = outcome.evidence.placedBlock.type;
        tryRecord(agent, {
            id: `placed:${type}`,
            text: placement,
            basis: 'observed',
            evidence: placement,
            tags: [ACCOMPLISHMENT_TAG, 'placeHere', type],
        });
    }
}

function retainMechanicLesson(agent, key, last) {
    if (!key.startsWith('collectBlocks:') || !agent.bot) return;
    const block = key.split(':')[1];
    if (!block || last?.reasonCode === 'missing_tool') return;
    const tool = sufficientToolFor(block, inventoryCounts(agent.bot), agent.bot.heldItem?.name || null);
    if (tool) {
        tryRecord(agent, {
            id: `tool:${tool}:${block}`,
            text: `${tool} is sufficient to harvest ${block}; a failure to collect it is not a tool problem.`,
            basis: 'mechanics',
            evidence: `minecraft-data harvestTools for ${block} includes ${tool}`,
            tags: ['collectBlocks', key],
        });
    }
}

function trackPending(agent, state, key, entry, outcome) {
    const pending = state.pending;
    if (!pending) return;
    const resolved = key === pending.key
        || (pending.key === 'capacity' && outcome?.evidence?.storage?.capacityRelief);
    if (!resolved) {
        pending.actionsSince++;
    } else {
        console.log(`[${agent.name}] Reflection follow-up: RESOLVED problem=${pending.key} after ${pending.actionsSince + 1} action(s): ${entry.command} ${entry.status}. ${entry.summary}`);
        tryRecord(agent, {
            id: `resolved:${pending.key}`,
            text: `After repeated failures of ${pending.key}, a later attempt made verified progress.`,
            basis: 'observed',
            evidence: clipText(`${entry.command}: ${entry.summary || entry.status}`, 200),
            tags: [pending.key.split(':')[0], pending.key],
        });
        state.pending = null;
        return;
    }
    if (pending.actionsSince >= PENDING_GIVE_UP_ACTIONS) {
        console.log(`[${agent.name}] Reflection follow-up: UNRESOLVED problem=${pending.key} after ${pending.actionsSince} action(s).`);
        state.pending = null;
    }
}

/** A problem that made progress starts fresh, including its reflection history. */
function clearProblem(state, key) {
    state.problems.delete(key);
    state.reflected.delete(key);
}

function managementState(state) {
    state.management ??= { streak: 0, entries: [], gain: null };
    return state.management;
}

function gainedItems(outcome) {
    return Object.entries(outcome?.evidence?.inventory?.changes || {})
        .filter(([, change]) => change.delta > 0)
        .map(([name]) => name);
}

/**
 * Successful-but-unproductive cycles. Repeated discards report success every
 * time, so failure counting never sees them. A streak of successful discards
 * with no substantive progress in between is itself the signal, whether or not
 * a blocked objective exists. Collecting an item and then discarding that same
 * item counts as part of the cycle.
 * Returns the problem key when the streak has reached the threshold.
 */
function trackManagement(state, action, outcome, entry, threshold) {
    const m = managementState(state);
    if (CHEST_ACTIONS.has(action)) return null;

    if (action === 'discard' && outcome && outcome.status !== 'failure') {
        const item = outcome.params?.item_name;
        if (m.gain && item && m.gain.items.includes(item)) {
            // Undo the reset the collection caused: it was management, not progress.
            m.streak = m.gain.prevStreak + 1;
            m.entries = [...m.gain.prevEntries, m.gain.entry];
            m.gain.entry.cycle = `collected ${item} and then discarded it`;
            entry.cycle = `discarded the ${item} it had just collected`;
            if (m.gain.prevReflected) state.reflected.set(MANAGEMENT_KEY, m.gain.prevReflected);
        }
        m.gain = null;
        m.streak++;
        m.entries.push(entry);
        if (m.entries.length > RECENT_LIMIT) m.entries.shift();
        if (m.streak < threshold) return null;
        state.problems.set(MANAGEMENT_KEY, {
            count: m.streak, blocked: 0, lastReasonCode: MANAGEMENT_KEY, lastCommand: entry.command,
        });
        return MANAGEMENT_KEY;
    }

    if (SUBSTANTIVE.has(action) && entry.progress) {
        m.gain = {
            items: gainedItems(outcome), prevStreak: m.streak, prevEntries: m.entries, entry,
            prevReflected: state.reflected.get(MANAGEMENT_KEY) || null,
        };
        m.streak = 0;
        m.entries = [];
        clearProblem(state, MANAGEMENT_KEY);
        return null;
    }
    m.gain = null; // only the action immediately before a discard links to it
    return null;
}

function bump(state, key, entry) {
    const problem = state.problems.get(key) || { count: 0, blocked: 0 };
    problem.count++;
    if (entry.blocked) problem.blocked++;
    problem.lastReasonCode = entry.reasonCode || null;
    problem.lastCommand = entry.command;
    state.problems.set(key, problem);
}

function pushRecent(state, entry) {
    state.recent.push(entry);
    if (state.recent.length > RECENT_LIMIT) state.recent.shift();
}

/**
 * Record the result of one executed command. `isAction` separates commands
 * that act in the world from pure queries, which are ignored. Returns the
 * problem key if this attempt left that problem without progress, else null.
 */
export function recordCommandResult(agent, { commandName, commandKey, failed = false, isAction = true, resultText = '', behaviorKey = null }) {
    if (!isAction || commandName === '!think') return null;
    const state = reflectionState(agent);
    const action = commandName.replace(/^!/, '');
    const outcome = agent.actions?.getLastOutcome?.() || null;
    const blocked = outcome ? null : agent.actions?.getLastBlocked?.() || null;
    let key = behaviorKey || problemKeyFor(action, commandKey, outcome, blocked);
    const params = outcome?.params || blocked?.params || {};
    const entry = {
        command: commandKey,
        action,
        problemKey: key,
        status: outcome?.status || (blocked ? 'blocked' : failed ? 'failure' : 'success'),
        progress: Boolean(outcome ? outcome.relevantProgress : (!failed && !blocked)),
        blocked: Boolean(blocked),
        reasonCode: outcome?.reason?.code
            || blocked?.reasonCode
            || (blocked?.condition === 'inventory_capacity' ? 'inventory_capacity'
                : blocked?.condition === 'invalid_request' ? 'invalid_arguments' : null),
        reason: outcome?.reason?.message || blocked?.reason || (failed ? clipText(resultText, 160) : ''),
        prerequisites: outcome?.reason?.prerequisites || blocked?.prerequisites || [],
        summary: outcome ? summarizeOutcome(outcome) : '',
        signature: outcome?.evidence?.signature || blocked?.signature || '',
        expectedItems: outcome?.evidence?.collection?.expectedItems
            || blocked?.expectedItems
            || expectedItemsForCommand(action, params),
        at: Date.now(),
    };

    let noProgress;
    if (blocked) {
        noProgress = true;
    } else if (outcome) {
        // While a capacity problem is open, a discard that frees no normal
        // storage slot is part of the capacity loop, not progress.
        if (action === 'discard' && state.problems.has('capacity') && !outcome.evidence?.storage?.capacityRelief) {
            key = 'capacity';
            entry.problemKey = key;
            entry.progress = false;
            entry.reasonCode = 'inventory_capacity';
            entry.reason = 'The discard did not free a normal storage slot.';
            noProgress = true;
        } else {
            noProgress = outcome.status === 'failure' || !outcome.relevantProgress;
        }
    } else {
        noProgress = failed;
    }
    pushRecent(state, entry);
    retainOutcomeLessons(agent, outcome);
    const threshold = Math.max(1, Number(reflectionConfig().auto_failure_threshold) || 3);
    const managementKey = trackManagement(state, action, outcome, entry, threshold);
    noteBlockedObjective(state, action, commandKey, entry, outcome);

    if (noProgress) {
        bump(state, key, entry);
        if (state.pending) state.pending.actionsSince++;
        if (managementKey) return managementKey;
        // Repeated stuck recoveries during the same kind of action are evidence
        // of a problem even when the command's own failures are mixed.
        const stuck = `stuck:${action}`;
        if (key !== stuck && (state.problems.get(stuck)?.count || 0) >= threshold) return stuck;
        return key;
    }
    // Verified progress clears only its own problem; unrelated successes and
    // incidental inventory gains clear nothing.
    trackPending(agent, state, key, entry, outcome);
    clearProblem(state, key);
    clearProblem(state, `stuck:${action}`);
    if (outcome?.evidence?.storage?.capacityRelief) clearProblem(state, 'capacity');
    return managementKey;
}

/**
 * The objective a capacity problem blocked. Remembered so reflection can show
 * what the inventory management was for, and whether it already succeeded.
 * Cleared when that same objective later makes verified progress.
 */
function noteBlockedObjective(state, action, commandKey, entry, outcome) {
    const objectiveKey = `${action}:${firstQuoted(commandKey)}`;
    if (action !== 'discard' && entry.problemKey === 'capacity' && !entry.progress) {
        state.blockedObjective = {
            command: commandKey,
            action,
            objectiveKey,
            expectedItems: entry.expectedItems || [],
            reason: entry.reason,
            at: Date.now(),
        };
        return;
    }
    const blocked = state.blockedObjective;
    if (blocked && entry.progress && objectiveKey === blocked.objectiveKey && outcome?.status !== 'failure') {
        state.blockedObjective = null;
    }
}

/** The unstuck mode interrupted an action that was making no progress. */
export function noteStuckRecovery(agent, interruptedAction) {
    if (!interruptedAction) return null;
    const state = reflectionState(agent);
    const action = String(interruptedAction).replace(/^action:/, '');
    const key = `stuck:${action}`;
    const entry = {
        command: `unstuck recovery during ${action}`,
        action: 'unstuck',
        problemKey: key,
        status: 'failure',
        progress: false,
        blocked: false,
        reasonCode: 'stuck',
        reason: 'The bot was wedged and the unstuck mode had to interrupt the action.',
        prerequisites: [],
        summary: '',
        expectedItems: [],
        at: Date.now(),
    };
    pushRecent(state, entry);
    bump(state, key, entry);
    console.log(`[${agent.name}] Stuck recovery noted: action=${action} count=${state.problems.get(key).count}`);
    return key;
}

function triggerReason(key, problem) {
    if (key === MANAGEMENT_KEY) return 'repeated inventory management without returning to an objective';
    if (key.startsWith('stuck:')) return 'repeated stuck recovery';
    if (key === 'capacity') return 'an inventory-capacity loop';
    if (problem.blocked >= 2) return 'repeated retries rejected by an unchanged blocking condition';
    if (problem.lastReasonCode === 'target_unavailable') return 'repeated inaccessible-target failures';
    return 'repeated attempts without relevant progress';
}

function skipReason(agent) {
    const bot = agent.bot;
    if (bot?.health != null && bot.health <= 6) return 'low_health';
    try {
        const here = bot?.entity?.position;
        if (here && Object.values(bot.entities || {}).some(entity =>
            entity?.type === 'hostile' && entity.position && here.distanceTo(entity.position) < 8)) {
            return 'hostile_nearby';
        }
    } catch {
        // Entity data is advisory and must never break the decision loop.
    }
    return null;
}

function skip(agent, state, key, problem, reason) {
    const signature = `${key}|${reason}|${problem.count}`;
    if (state.lastSkip !== signature) {
        state.lastSkip = signature;
        console.log(`[${agent.name}] Automatic reflection skipped: reason=${reason} problem=${key} attempts=${problem.count}`);
    }
    return null;
}

/**
 * If the problem the agent just attempted has reached the threshold, run the
 * existing reflection and return its private text for the agent's decision
 * context. Evaluating only `latestKey` means productive work on anything else
 * never triggers reflection. Returns null when nothing should be added.
 */
export async function maybeAutoReflect(agent, latestKey) {
    const cfg = reflectionConfig();
    if (!cfg.auto_reflection || !latestKey) return null;
    const state = reflectionState(agent);
    const problem = state.problems.get(latestKey);
    if (!problem) return null;
    const configuredThreshold = Math.max(1, Number(cfg.auto_failure_threshold) || 2);
    // Two retries rejected by the same unchanged condition are stronger
    // evidence than ordinary failures: nothing ran and the agent ignored a
    // concrete prerequisite twice. Reflect immediately even when an operator
    // configured a more conservative general failure threshold.
    const threshold = problem.blocked >= 2
        ? Math.min(configuredThreshold, 2)
        : configuredThreshold;
    if (problem.count < threshold) return null;

    // Already reflected on this problem: wait for another full threshold of
    // failed attempts so identical conditions do not re-trigger.
    const previous = state.reflected.get(latestKey);
    if (previous && problem.count < previous.count + threshold) {
        return skip(agent, state, latestKey, problem, 'unchanged_conditions');
    }
    const emergency = skipReason(agent);
    if (emergency) return skip(agent, state, latestKey, problem, emergency);
    if (state.busy) return skip(agent, state, latestKey, problem, 'agent_reflection_in_flight');
    if (reflectionsInFlight() >= cfg.max_concurrent) return skip(agent, state, latestKey, problem, 'global_concurrency_limit');
    if (Date.now() - state.lastAutoAt < Math.max(0, Number(cfg.auto_cooldown_ms) || 0)) {
        return skip(agent, state, latestKey, problem, 'cooldown');
    }

    const related = latestKey === MANAGEMENT_KEY
        ? [...(state.management?.entries || [])]
        : state.recent.filter(entry => entry.problemKey === latestKey);
    const failures = related.slice(-3)
        .map(entry => `${entry.command} -> ${entry.blocked ? 'rejected' : entry.status}${entry.reasonCode ? ` (${entry.reasonCode})` : ''}`);
    const blocks = [...(agent.actions?.retryBlocks?.values?.() || [])].slice(-2).map(block => block.reason);
    const label = latestKey === 'capacity' ? 'making room in my inventory' : latestKey.replace(':', ' ');
    const trigger = {
        reason: triggerReason(latestKey, problem),
        key: latestKey,
        count: problem.count,
        countText: latestKey === MANAGEMENT_KEY ? `${problem.count} inventory-management actions in a row without other progress` : null,
        evidence: `${failures.join('; ')}${blocks.length ? ` | blocking: ${blocks.join('; ')}` : ''}`,
    };
    const latest = related.at(-1);
    const form = latest?.signature ? ` The correct command form is ${latest.signature}.` : '';
    const question = latestKey === MANAGEMENT_KEY
        ? `I have repeatedly managed my inventory (${problem.count} actions in a row). Did that resolve what was blocking me, and what is the most useful thing to do next?`
        : latest?.reasonCode === 'invalid_arguments' || latest?.reasonCode === 'unknown_command'
            ? `My command was rejected before it ran: ${latest.reason}.${form} What different valid action should I take instead of repeating it?`
        : problem.blocked >= 2
            ? `The game rejected my recent ${label} attempts because the blocking condition did not change.${form} What exact fact am I overlooking, and what single different action would satisfy the stated prerequisite?`
        : `My recent attempts at ${label} keep failing. Why, and what practical next step could change the situation?${form}`;

    state.lastAutoAt = Date.now();
    const text = await reflect(agent, question, { source: 'automatic_failure', trigger });
    if (!text.startsWith('Private reflection')) {
        return skip(agent, state, latestKey, problem, 'reflection_unavailable');
    }
    state.reflected.set(latestKey, { count: problem.count, at: Date.now() });
    state.pending = { key: latestKey, actionsSince: 0 };
    retainMechanicLesson(agent, latestKey, related.at(-1));
    return text;
}
