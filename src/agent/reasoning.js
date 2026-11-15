import settings from './settings.js';
import { adviceCorrections, inventoryCounts, verifiedMechanicsDetail } from './mechanics.js';
import { formatLessons, relevantLessons } from './lessons.js';
import { inventorySnapshot, storageAcceptsItem } from './action_outcome.js';
import { watchDayModel } from '../village/day_pulse.js';

const DEFAULTS = {
    think: false,
    keep_alive: -1,
    timeout_ms: 45000,
    cooldown_ms: 45000,
    max_consecutive: 2,
    max_concurrent: 1,
    max_predict: 1024,
    // Automatic reflection after repeated unsuccessful attempts.
    auto_reflection: true,
    auto_failure_threshold: 2,
    auto_cooldown_ms: 30000,
    options: {
        num_ctx: 8192,
        num_predict: 1024
    }
};

const SYSTEM_PROMPT = `You are the private reflective reasoning step of a Minecraft survival agent.

The user message contains the agent's actual situation. Sections marked VERIFIED are authoritative: the game's own item, block and recipe data, the agent's real inventory, and results observed after the agent's actions. Never contradict them. Do not claim a recipe, ingredient, tool or block is invalid, impossible or different when a VERIFIED fact says otherwise, and do not invent recipes, item names or tool tiers that are not stated there.

Anything you add beyond the VERIFIED sections is your own suggestion. Mining or collecting more items never frees inventory space.

Diagnose the specific problem: compare what was expected with what actually happened, and name the failed prerequisite if there is one. Then recommend one practical next step that changes the situation, such as a different route, location, tool, or action. Do not recommend repeating an unsuccessful action unless something meaningful has changed. Do not assign the agent a new long-term goal or role; it chooses its own objectives.

When the recent actions are inventory management (discarding, storing), judge them against the objective: say whether the blocking condition is actually resolved, using the free-slot numbers given. Placing a block does not need a free slot. Keeping, using, storing in a chest, and discarding are all legitimate; never recommend discarding something the objective or a recipe needs, and discarding is irreversible.

Do not write Minecraft commands. Answer in at most 4 short sentences: first the diagnosis, then "Next:" and the step.`;

let inFlight = 0;

export function reflectionConfig() {
    const configured = settings.reasoning || {};
    return {
        ...DEFAULTS,
        ...configured,
        options: {
            ...DEFAULTS.options,
            ...(configured.options || {})
        }
    };
}

/** Number of reflections currently running across all agents in this process. */
export function reflectionsInFlight() {
    return inFlight;
}

/**
 * Per-agent reflection state, shared by voluntary and automatic reflection.
 * `busy` is the per-agent single-flight guard; `inFlight` above is the global
 * concurrency count.
 */
export function reflectionState(agent) {
    if (!agent._reflection) {
        agent._reflection = {
            locked: false,
            lockedProblem: null,
            lastAdvice: '',
            fingerprint: '',
            busy: false,
            lastAutoAt: 0,
            recent: [],
            problems: new Map(),
            reflected: new Map(),
            pending: null,
            lastSkip: '',
            management: { streak: 0, entries: [], gain: null },
            blockedObjective: null,
        };
    }
    return agent._reflection;
}

export function noteReflectionAction(agent) {
    const state = agent?._reflection;
    if (!state) return;
    state.locked = false;
}

export function situationFingerprint(agent) {
    const bot = agent?.bot;
    const pos = bot?.entity?.position;
    const grid = pos
        ? `${Math.round(Number(pos.x) / 8)}:${Math.round(Number(pos.y) / 4)}:${Math.round(Number(pos.z) / 8)}`
        : 'no-pos';
    const health = bot?.health == null ? '?' : String(Math.round(bot.health));
    let inventory = 'no-inv';
    if (bot?.inventory?.slots) {
        const counts = {};
        for (const slot of bot.inventory.slots) {
            if (slot?.name) counts[slot.name] = (counts[slot.name] || 0) + (slot.count || 1);
        }
        inventory = Object.keys(counts).sort().map(name => `${name}:${counts[name]}`).join(',');
    }
    return `${grid}|${health}|${inventory}`;
}

export function reflectionStatus(agent) {
    const state = agent?._reflection;
    if (!state?.locked) return { unavailable: false, advice: state?.lastAdvice || '' };
    if (situationFingerprint(agent) !== state.fingerprint) {
        state.locked = false;
        return { unavailable: false, advice: state.lastAdvice || '' };
    }
    return { unavailable: true, advice: state.lastAdvice || '' };
}

function clip(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return value.slice(0, max - 1) + '…';
}

function equipmentText(bot) {
    const held = bot?.heldItem?.name || 'nothing';
    const slots = bot?.inventory?.slots || [];
    const armor = [5, 6, 7, 8].map(index => slots[index]?.name).filter(Boolean);
    return `Equipment: holding ${held}; armor ${armor.length ? armor.join(', ') : 'none'}`;
}

function inventoryText(bot) {
    if (!bot?.inventory?.slots) return 'Inventory: unavailable';
    const counts = inventoryCounts(bot);
    const items = Object.entries(counts).map(([name, count]) => `${name} x${count}`).join(', ');
    let storage = '';
    try {
        const snapshot = inventorySnapshot(bot).storage;
        storage = `\nNormal storage: ${snapshot.occupied}/${snapshot.capacity} slots occupied, ${snapshot.free} free`;
    } catch {
        storage = '';
    }
    return `${equipmentText(bot)}\nInventory: ${items || 'empty'}${storage}`;
}

function recentTurns(agent) {
    const turns = agent.history?.turns;
    if (!Array.isArray(turns) || turns.length === 0) return 'none recorded';
    return turns.slice(-5).map(turn => {
        const role = turn.role || 'unknown';
        return `${role}: ${clip(turn.content, 200)}`;
    }).join('\n');
}

function outcomeLine(entry) {
    const verdict = entry.blocked
        ? 'REJECTED, unchanged blocking condition'
        : `${String(entry.status || '?').toUpperCase()}${entry.progress ? '' : ', no relevant progress'}`;
    const parts = [`${entry.command}: ${verdict}.`];
    if (entry.summary) parts.push(entry.summary);
    if (entry.reason) parts.push(`Reason: ${entry.reason}`);
    if (entry.cycle) parts.push(`Pattern: ${entry.cycle}.`);
    if (entry.prerequisites?.length) parts.push(`Unresolved prerequisite: ${entry.prerequisites.join(' ')}`);
    return `- ${clip(parts.join(' '), 420)}`;
}

function relevantRecent(state, trigger) {
    const recent = state.recent || [];
    if (trigger?.key === 'inventory_management') {
        const cycle = (state.management?.entries || []).slice(-5);
        const others = recent.filter(entry => !cycle.includes(entry)).slice(-2);
        return [...others, ...cycle];
    }
    if (!trigger?.key) return recent.slice(-5);
    const related = recent.filter(entry => entry.problemKey === trigger.key);
    if (related.length === 0) return recent.slice(-5);
    const others = recent.filter(entry => entry.problemKey !== trigger.key).slice(-2);
    return [...others, ...related.slice(-4)];
}

function activeBlocks(agent) {
    const blocks = agent.actions?.retryBlocks;
    if (!blocks || blocks.size === 0) return [];
    return [...blocks.entries()].slice(-3).map(([key, block]) =>
        `- ${key}: ${block.reason}${block.prerequisites?.length ? ` Required change: ${block.prerequisites.join(' ')}` : ''}`);
}

function slotText(storage) {
    return storage ? `${storage.free} free of ${storage.capacity}` : 'unknown';
}

/**
 * What the inventory management was for and whether it worked. All values are
 * read from live inventory and recorded outcomes. Nothing here tells the agent
 * what to do; it only states the blocked objective and the verified slot
 * numbers so the agent can judge the situation.
 */
function inventoryContext(agent, state, trigger) {
    const blocked = state.blockedObjective;
    const entries = state.management?.entries || [];
    const relevant = blocked || trigger?.key === 'inventory_management' || trigger?.key === 'capacity';
    if (!relevant || !agent.bot) return [];
    const lines = ['', 'VERIFIED inventory-management context:'];
    let storage = null;
    try { storage = inventorySnapshot(agent.bot).storage; } catch { storage = null; }
    if (blocked) {
        lines.push(`Original blocked objective: ${blocked.command}${blocked.expectedItems?.length ? ` (its drops: ${blocked.expectedItems.slice(0, 3).join(', ')})` : ''}. Blocked because: ${clip(blocked.reason, 160) || 'normal storage was full'}`);
        const fits = (blocked.expectedItems || []).length > 0
            && blocked.expectedItems.some(item => storageAcceptsItem(agent.bot, item));
        lines.push(fits
            ? `Current status: the blocking condition is RESOLVED. The drops of that objective can now be stored (normal storage ${slotText(storage)}). Nothing further needs to be freed for it.`
            : `Current status: the blocking condition is NOT resolved. The drops of that objective still cannot be stored (normal storage ${slotText(storage)}).`);
    } else if (trigger?.key === 'inventory_management') {
        lines.push(`No blocked objective is recorded, and no recent action failed for lack of inventory space. Normal storage is ${slotText(storage)}.`);
    }
    if (entries.length) {
        lines.push(`Inventory-management actions in a row without other progress: ${state.management.streak}.`);
        for (const entry of entries.slice(-4)) {
            const slots = String(entry.summary || '').match(/Free normal storage slots: (\d+) -> (\d+)/);
            lines.push(`- ${entry.command}: free slots ${slots ? `${slots[1]} -> ${slots[2]}` : 'not recorded'}${entry.cycle ? `; ${entry.cycle}` : ''}.`);
        }
    }
    return lines;
}

/**
 * The compact situation report. VERIFIED sections come from live game state,
 * registry data, and structured action outcomes; they are not model output.
 */
export function situationReport(agent, question, trigger = null) {
    const bot = agent.bot;
    const state = reflectionState(agent);
    const lines = [`Agent: ${agent.name || 'unknown'}`];
    const goal = agent.self_prompter?.prompt || '';
    if (settings.village_autonomy === true) {
        lines.push('Current objective: none assigned. A personal intention, when the private context names one, is optional.');
    } else {
        lines.push(`Current objective: ${clip(goal || 'No selected goal is recorded.', 400)}`);
    }
    if (trigger) {
        lines.push(`Why this reflection was triggered: ${trigger.reason}${trigger.count ? ` (${trigger.countText || `${trigger.count} consecutive attempts without relevant progress`})` : ''}.`);
    }
    lines.push('');
    lines.push('VERIFIED current state:');
    if (bot?.entity?.position) {
        const pos = bot.entity.position;
        const dimension = bot.game?.dimension ? ` in the ${bot.game.dimension}` : '';
        lines.push(`Position: x ${Number(pos.x).toFixed(1)}, y ${Number(pos.y).toFixed(1)}, z ${Number(pos.z).toFixed(1)}${dimension}`);
    }
    if (bot && bot.health != null) lines.push(`Health: ${Math.round(bot.health)} / 20`);
    if (bot && bot.food != null) lines.push(`Hunger: ${Math.round(bot.food)} / 20`);
    if (bot) lines.push(inventoryText(bot));

    const recent = relevantRecent(state, trigger);
    if (recent.length) {
        lines.push('');
        lines.push('VERIFIED recent action outcomes (expected versus actual, from inventory and world observation):');
        for (const entry of recent) lines.push(outcomeLine(entry));
    }
    const blocks = activeBlocks(agent);
    if (blocks.length) {
        lines.push('Active blocking conditions:');
        lines.push(...blocks);
    }

    lines.push(...inventoryContext(agent, state, trigger));

    // Facts are selected for the actual problem: the failed commands and their
    // reasons plus the question, not a general encyclopedia.
    const problemText = (trigger?.key ? recent.filter(entry => entry.problemKey === trigger.key) : recent)
        .map(entry => `${entry.command} ${entry.reason || ''}`).join(' ');
    const wantedItems = [...new Set(recent.flatMap(entry => entry.expectedItems || []))];
    const managing = Boolean(state.blockedObjective) || trigger?.key === 'inventory_management';
    const capacityProblem = recent.some(entry => entry.reasonCode === 'inventory_capacity')
        || trigger?.key === 'capacity' || managing;
    const wantedWithBlocked = [...new Set([...wantedItems, ...(state.blockedObjective?.expectedItems || [])])];
    // The agent's own recent statements pick which general facts apply (such as
    // a belief that a slot must be freed before placing a block).
    const beliefText = (agent.history?.turns || []).slice(-3).map(turn => String(turn.content || '').slice(0, 240)).join('\n');
    const detail = verifiedMechanicsDetail({
        text: `${question}\n${problemText}`,
        inventory: bot ? inventoryCounts(bot) : {},
        held: bot?.heldItem?.name || null,
        bot,
        wantedItems: wantedWithBlocked,
        forceCapacity: capacityProblem,
        beliefText,
        explainStacks: managing,
    });
    const lessons = formatLessons(relevantLessons(agent, trigger?.key ? [trigger.key.split(':')[0], trigger.key] : [], 3));
    if (lessons) {
        lines.push('');
        lines.push('VERIFIED lessons from this agent\'s own experience:');
        lines.push(lessons);
    }
    if (detail.text) {
        lines.push('');
        lines.push(detail.text.replace('Verified Minecraft mechanics:', 'VERIFIED Minecraft mechanics (game data):'));
    }

    lines.push('');
    lines.push('Context (not verified):');
    if (settings.village_autonomy === true) {
        lines.push('Personal memory: use the morning brief, current intention, and recent episodes. The old rolling summary is not an objective.');
    } else {
        lines.push(`Personal memory: ${clip(agent.history?.memory || '', 300) || 'none'}`);
    }
    lines.push('Recent actions and results:');
    lines.push(recentTurns(agent));
    lines.push('');
    lines.push(`Question: ${clip(question, 500)}`);
    return { text: lines.join('\n'), detail };
}

function usable(content) {
    const text = String(content || '').trim();
    if (text.length < 8) return false;
    if (/^![\w]+(\(|$)/.test(text)) return false;
    return true;
}

function requestParams(cfg, think) {
    return {
        think,
        keep_alive: cfg.keep_alive,
        timeout_ms: cfg.timeout_ms,
        max_predict: cfg.max_predict,
        options: { ...cfg.options }
    };
}

const DEFAULT_QUESTION = 'What should I do next given my current goal, inventory, recent failures, and surroundings?';

function blockedReflection(agent, reason) {
    const advice = reflectionState(agent).lastAdvice;
    console.log(`[${agent.name}] Reflection blocked: ${reason}`);
    if (!advice) return `Reflection blocked. ${reason}`;
    return `Reflection blocked. ${reason}\n${advice}`;
}

function describeSource(source, trigger, asked) {
    const reason = trigger?.reason || (asked ? 'question' : 'no_question');
    return `source=${source} trigger=${reason}${trigger?.key ? ` problem=${trigger.key}` : ''}`;
}

/**
 * Run one reflection. `source` is one of:
 *   voluntary          the agent chose !think (with or without a question)
 *   automatic_failure  the framework detected repeated failure
 *   no_command         self-prompt recovery after several empty responses
 */
export async function reflect(agent, question, { source = 'voluntary', trigger = null } = {}) {
    const asked = String(question ?? '').trim();
    const promptQuestion = asked || DEFAULT_QUESTION;
    const name = agent.name || 'agent';
    const state = reflectionState(agent);
    const problemKey = trigger?.key || (source === 'no_command' ? 'no_command' : 'voluntary');

    // A lock only holds back the same problem. A materially different problem
    // (a different failing action or reason) may reflect without an intervening
    // action; voluntary calls keep the original "act on the advice first" rule.
    const status = reflectionStatus(agent);
    if (status.unavailable && (source === 'voluntary' || state.lockedProblem === problemKey)) {
        return blockedReflection(agent, 'Act on the previous advice before using !think again.');
    }

    const cfg = reflectionConfig();
    const model = agent.prompter?.chat_model;
    if (!model || typeof model.complete !== 'function') {
        return blockedReflection(agent, 'This model has no separate reasoning request.');
    }
    if (state.busy) {
        return blockedReflection(agent, 'A reflection is already running for this agent.');
    }
    if (inFlight >= cfg.max_concurrent) {
        return blockedReflection(agent, 'Another reflection is already running.');
    }

    const sourceLabel = describeSource(source, trigger, asked);
    console.log(`[${name}] Reflection started: ${sourceLabel}${asked ? ` question="${clip(asked, 160)}"` : ''}`);
    if (trigger?.evidence) console.log(`[${name}] Reflection evidence: ${clip(trigger.evidence, 400)}`);
    const started = Date.now();
    inFlight++;
    state.busy = true;
    let evalTokens = 0;
    let promptTokens = 0;
    const count = result => {
        evalTokens += Number(result?.eval_count) || 0;
        promptTokens += Number(result?.prompt_eval_count) || 0;
    };
    const finish = (advice, corrections) => {
        const ms = Date.now() - started;
        state.locked = true;
        state.lockedProblem = problemKey;
        state.lastAdvice = advice;
        state.fingerprint = situationFingerprint(agent);
        console.log(`[${name}] Reflection completed: ${ms}ms, ${evalTokens} tokens (prompt ${promptTokens}), ${sourceLabel}.` +
            `${corrections.length ? ` Corrected ${corrections.length} claim(s) against verified mechanics.` : ''} ${clip(advice, 400)}`);
        const header = trigger
            ? `Private reflection (not shared in chat), prompted by ${trigger.reason}:`
            : 'Private reflection (not shared in chat):';
        return `${header}\n${advice}`;
    };
    const withCorrections = (content, detail) => {
        const corrections = adviceCorrections(content, detail);
        const advice = clip(content, 1200) + (corrections.length
            ? `\nVerified correction: ${corrections.join(' ')}`
            : '');
        return { advice, corrections };
    };
    try {
        watchDayModel(true);
        const { text: user, detail } = situationReport(agent, promptQuestion, trigger);
        let result = await model.complete(user, SYSTEM_PROMPT, requestParams(cfg, cfg.think === true));
        count(result);
        if (!usable(result?.content) && cfg.think === true) {
            console.log(`[${name}] Reflection used its thinking budget without a final answer. Retrying without thinking.`);
            result = await model.complete(user, SYSTEM_PROMPT, {
                ...requestParams(cfg, false),
                options: { ...cfg.options, num_predict: Math.min(512, cfg.options.num_predict || 512) }
            });
            count(result);
        }
        if (!usable(result?.content)) {
            console.log(`[${name}] Reflection completed: ${Date.now() - started}ms, ${evalTokens} tokens. No usable advice. ${sourceLabel}`);
            return 'Reflection produced no usable advice. Choose a different action from what you can see and what you already know.';
        }
        const { advice, corrections } = withCorrections(result.content, detail);
        return finish(advice, corrections);
    } catch (err) {
        console.warn(`[${name}] Reflection failed: ${err.message}`);
        if (cfg.think === true) {
            try {
                const { text: user, detail } = situationReport(agent, promptQuestion, trigger);
                const result = await model.complete(user, SYSTEM_PROMPT, {
                    ...requestParams(cfg, false),
                    options: { ...cfg.options, num_predict: Math.min(512, cfg.options.num_predict || 512) }
                });
                count(result);
                if (usable(result?.content)) {
                    const { advice, corrections } = withCorrections(result.content, detail);
                    return finish(advice, corrections);
                }
            } catch (fallbackErr) {
                console.warn(`[${name}] Reflection fallback failed: ${fallbackErr.message}`);
            }
        }
        console.log(`[${name}] Reflection completed: ${Date.now() - started}ms, ${evalTokens} tokens. Request failed. ${sourceLabel}`);
        return 'Reflection could not be completed. Continue with a different action.';
    } finally {
        watchDayModel(false);
        state.busy = false;
        inFlight--;
    }
}
