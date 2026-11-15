import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import { Agent } from '../src/agent/agent.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { createActionOutcome, classifyFailure, inventorySnapshot } from '../src/agent/action_outcome.js';
import { setSettings } from '../src/agent/settings.js';
import { reflect, reflectionState, situationReport } from '../src/agent/reasoning.js';
import { maybeAutoReflect, noteStuckRecovery, recordCommandResult } from '../src/agent/reflection_triggers.js';
import { loadLessons, recordLesson } from '../src/agent/lessons.js';
import { adviceCorrections, verifiedMechanicsDetail } from '../src/agent/mechanics.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

const registry = minecraftData('1.21.6');
initializeMinecraftData('1.21.6');

const REFLECTION_SETTINGS = {
    think: false,
    keep_alive: -1,
    timeout_ms: 45000,
    cooldown_ms: 45000,
    max_consecutive: 2,
    max_concurrent: 1,
    max_predict: 1024,
    auto_reflection: true,
    auto_failure_threshold: 3,
    auto_cooldown_ms: 60000,
    options: { num_ctx: 8192, num_predict: 1024 },
};

function itemStack(name, count, slot) {
    return { name, count, slot, type: registry.itemsByName[name].id, stackSize: registry.itemsByName[name].stackSize };
}

/** Same scripted-world approach as the collection tests. */
function createWorld({ inventory = { stone_pickaxe: 1 }, blocks = [], onCollect = () => {} }) {
    const world = new Map();
    const air = position => ({ name: 'air', type: 0, position, metadata: 0, canHarvest: () => true, boundingBox: 'empty', shapes: [] });
    const makeBlock = (name, position) => {
        const data = registry.blocksByName[name];
        return {
            name, type: data.id, position, metadata: 0, boundingBox: data.boundingBox,
            shapes: data.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
            diggable: true, material: data.material, hardness: data.hardness, canHarvest: () => true,
        };
    };
    for (const [name, x, y, z] of blocks) world.set(`${x},${y},${z}`, makeBlock(name, new Vec3(x, y, z)));
    const bot = {
        output: '', interrupt_code: false, entities: {}, health: 20, food: 20,
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 64, 0) }, registry, heldItem: null,
        modes: { isOn: () => false, pause() {}, unpause() {}, flushBehaviorLog: () => '' },
        inventory: {
            inventoryStart: 9, slots: Array(46).fill(null),
            items() { return this.slots.filter(Boolean); },
            findInventoryItem(name) { return this.slots.find(slot => slot?.name === name) || null; },
        },
        blockAt: position => world.get(`${position.x},${position.y},${position.z}`) || air(position),
        findBlocks: ({ matching, maxDistance = 64, count = 1 }) => {
            const found = [];
            for (const block of world.values()) {
                if (bot.entity.position.distanceTo(block.position) <= maxDistance && matching(block)) found.push(block.position);
            }
            found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
            return found.slice(0, count);
        },
        tool: { equipForBlock: async () => {} },
        chat() {}, emit() {},
    };
    Object.entries(inventory).forEach(([name, count], index) => {
        bot.inventory.slots[9 + index] = itemStack(name, count, 9 + index);
    });
    const api = {
        bot, world,
        add(name, count) {
            const existing = bot.inventory.slots.find(slot => slot?.name === name);
            if (existing) existing.count += count;
            else {
                const free = bot.inventory.slots.findIndex((slot, index) => index >= 9 && index < 45 && !slot);
                bot.inventory.slots[free] = itemStack(name, count, free);
            }
        },
        breakBlock(block) { world.delete(`${block.position.x},${block.position.y},${block.position.z}`); },
    };
    bot.collectBlock = { collect: async block => onCollect({ ...api, block }), cancelTask: async () => {} };
    return api;
}

let logs;
let originalLog;
let lessonsDir;
let modelCalls;

beforeEach(() => {
    setSettings({ reasoning: { ...REFLECTION_SETTINGS } });
    logs = [];
    originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    lessonsDir = mkdtempSync(path.join(tmpdir(), 'lessons-'));
    modelCalls = [];
});

afterEach(() => {
    console.log = originalLog;
    rmSync(lessonsDir, { recursive: true, force: true });
});

function mockModel(content = 'The pickaxe is sufficient. Next: search a different area for iron.') {
    return {
        async complete(user, system, params) {
            modelCalls.push({ user, system, params });
            return { content: typeof content === 'function' ? content(modelCalls.length) : content, done_reason: 'stop', eval_count: 25, prompt_eval_count: 700 };
        },
    };
}

/** A real Agent running the real handleMessage loop over scripted model replies. */
function createAgent(sim, { responses = [], name = 'Rowan', model = mockModel() } = {}) {
    const agent = Object.create(Agent.prototype);
    const queue = [...responses];
    const added = [];
    Object.assign(agent, {
        name,
        ready: true,
        shut_up: false,
        bot: sim.bot,
        kills: [],
        lessonsBaseDir: lessonsDir,
        blocked_actions: [],
        checkTaskDone: async () => {},
        routeResponse() {},
        clearBotLogs() { sim.bot.output = ''; sim.bot.interrupt_code = false; },
        requestInterrupt() { sim.bot.interrupt_code = true; },
        cleanKill(reason) { agent.kills.push(reason); },
        history: {
            memory: 'I want iron to upgrade my tools.',
            turns: [],
            async add(role, content) { added.push({ role, content }); this.turns.push({ role, content }); },
            getHistory() { return this.turns; },
            save() {},
        },
        added,
        self_prompter: {
            prompt: 'Build a base with iron tools.',
            shouldInterrupt: () => false,
            handleUserPromptedCmd() {},
            isActive: () => true,
        },
        prompter: {
            chat_model: model,
            async promptConvo() { return queue.shift() ?? ''; },
        },
        plan_manager: { observeOutcome: () => ({}) },
    });
    agent.actions = new ActionManager(agent);
    return agent;
}

const reflections = agent => agent.added.filter(entry => entry.role === 'system' && /^Private reflection/.test(entry.content));

describe('voluntary !think is distinguished from framework-triggered reflection', () => {
    test('voluntary reflection with a question keeps working and is labelled voluntary', async () => {
        const agent = createAgent(createWorld({}), { model: mockModel() });
        const result = await reflect(agent, 'How do I get iron?', { source: 'voluntary' });
        assert.match(result, /^Private reflection \(not shared in chat\):/);
        assert.doesNotMatch(result, /prompted by/);
        const text = logs.join('\n');
        assert.match(text, /Reflection started: source=voluntary trigger=question/);
        assert.doesNotMatch(text, /automatic/i);
        assert.match(modelCalls[0].user, /Question: How do I get iron\?/);
    });

    test('voluntary reflection without a question is not mislabelled as automatic', async () => {
        const agent = createAgent(createWorld({}), { model: mockModel() });
        const result = await reflect(agent, '', { source: 'voluntary' });
        assert.match(result, /^Private reflection/);
        const text = logs.join('\n');
        assert.match(text, /source=voluntary trigger=no_question/);
        assert.doesNotMatch(text, /source=automatic/);
        assert.match(modelCalls[0].user, /What should I do next/);
    });

    test('reflection is private: nothing is routed to chat', async () => {
        const sim = createWorld({});
        const agent = createAgent(sim);
        const routed = [];
        agent.routeResponse = (to, message) => routed.push(message);
        sim.bot.chat = message => routed.push(message);
        await reflect(agent, 'Where next?', { source: 'voluntary' });
        assert.deepEqual(routed, []);
    });
});

describe('automatic reflection from structured outcomes', () => {
    test('repeated failed iron collection with incidental cobblestone triggers one grounded reflection', async () => {
        const sim = createWorld({
            blocks: [['iron_ore', 6, 64, 0], ['oak_log', 2, 64, 2]],
            onCollect: ({ block, breakBlock, add }) => {
                if (block.name === 'iron_ore') add('cobblestone', 4); // incidental tunnel spoil, never the ore
                else { breakBlock(block); add('oak_log', 1); }
            },
        });
        const agent = createAgent(sim, {
            responses: [
                '!collectBlocks("iron_ore", 1)',
                '!collectBlocks("iron_ore", 1)',
                '!collectBlocks("iron_ore", 1)',
                '!collectBlocks("oak_log", 1)',
            ],
        });
        await agent.handleMessage('system', 'Continue.', 4);

        const state = reflectionState(agent);
        // Incidental cobblestone never counted as progress or cleared the problem.
        assert.equal(state.problems.get('collectBlocks:iron_ore').count, 3);
        assert.equal(modelCalls.length, 1);
        const advice = reflections(agent);
        assert.equal(advice.length, 1);
        assert.match(advice[0].content, /Private reflection \(not shared in chat\), prompted by/);

        const prompt = modelCalls[0].user;
        assert.match(prompt, /VERIFIED recent action outcomes/);
        assert.match(prompt, /Expected raw_iron or deepslate_iron_ore|Expected raw_iron/);
        assert.match(prompt, /actual raw_iron \+0/);
        assert.match(prompt, /Incidental \(not progress\): cobblestone \+4/);
        assert.match(prompt, /stone_pickaxe in the inventory can harvest it/i);
        assert.doesNotMatch(prompt, /raw_iron is crafted from .*raw_iron_block/);
        assert.doesNotMatch(prompt, /\.\./);
        assert.ok(prompt.length < 3500, `prompt is compact (${prompt.length} chars)`);
        assert.match(modelCalls[0].system, /VERIFIED/);
        assert.match(modelCalls[0].system, /never contradict/i);

        const text = logs.join('\n');
        assert.match(text, /Reflection started: source=automatic_failure trigger=/);
        assert.match(text, /Reflection completed: \d+ms, 25 tokens \(prompt 700\)/);
        // The agent kept acting after the reflection.
        assert.ok(sim.bot.inventory.slots.some(slot => slot?.name === 'oak_log'));
    });

    test('repeated successful gathering never triggers reflection', async () => {
        let n = 0;
        const sim = createWorld({
            blocks: [['oak_log', 2, 64, 0], ['oak_log', 3, 64, 0], ['oak_log', 4, 64, 0], ['oak_log', 5, 64, 0]],
            onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('oak_log', 1); n++; },
        });
        const agent = createAgent(sim, {
            responses: ['!collectBlocks("oak_log", 1)', '!collectBlocks("oak_log", 1)', '!collectBlocks("oak_log", 1)', '!collectBlocks("oak_log", 1)'],
        });
        await agent.handleMessage('system', 'Continue.', 4);
        assert.equal(n, 4);
        assert.equal(modelCalls.length, 0);
        assert.equal(reflectionState(agent).problems.size, 0);
    });

    test('three failed torch placements trigger reflection', async () => {
        const agent = createAgent(createWorld({ inventory: { stone_pickaxe: 1 } }), {
            responses: ['!placeHere("torch")', '!placeHere("torch")', '!placeHere("torch")'],
        });
        await agent.handleMessage('system', 'Continue.', 3);
        assert.equal(reflectionState(agent).problems.get('placeHere:torch').count, 3);
        assert.equal(modelCalls.length, 1);
        assert.match(modelCalls[0].user, /placeHere/);
        assert.equal(reflections(agent).length, 1);
    });

    test('a verified success on one problem does not clear another problem', async () => {
        const sim = createWorld({
            blocks: [['iron_ore', 6, 64, 0], ['oak_log', 2, 64, 2]],
            onCollect: ({ block, breakBlock, add }) => {
                if (block.name === 'iron_ore') add('cobblestone', 2);
                else { breakBlock(block); add('oak_log', 1); }
            },
        });
        const agent = createAgent(sim, {
            responses: ['!collectBlocks("iron_ore", 1)', '!collectBlocks("oak_log", 1)', '!collectBlocks("iron_ore", 1)', '!collectBlocks("iron_ore", 1)'],
        });
        await agent.handleMessage('system', 'Continue.', 4);
        assert.equal(reflectionState(agent).problems.get('collectBlocks:iron_ore').count, 3);
        assert.equal(modelCalls.length, 1);
    });
});

function fullInventoryWorld() {
    const sim = createWorld({ inventory: {}, blocks: [['iron_ore', 6, 64, 0]] });
    for (let slot = 9; slot < 45; slot++) sim.bot.inventory.slots[slot] = itemStack('dirt', 64, slot);
    return sim;
}

describe('inventory-capacity loop', () => {
    function capacityOutcome(agent) {
        const snapshot = inventorySnapshot(agent.bot);
        return createActionOutcome({
            action: 'collectBlocks', params: { type: 'iron_ore', num: 1 }, status: 'failure',
            before: snapshot, after: snapshot,
            reason: classifyFailure('Inventory full, no place to deposit', 'x'),
            retryableWithoutStateChange: false, bot: agent.bot,
        });
    }
    function partialDiscard(agent) {
        const before = inventorySnapshot(agent.bot);
        const slot = agent.bot.inventory.slots[9];
        slot.count -= 10; // part of one stack: no slot is freed
        const after = inventorySnapshot(agent.bot);
        return createActionOutcome({
            action: 'discard', params: { item_name: 'dirt', num: 10 }, status: 'success',
            before, after, relevantProgress: true, details: { requested: 10, removed: 10 }, bot: agent.bot,
        });
    }

    test('collect fails, partial discard frees nothing, retry is rejected: reflects with capacity facts and corrects bad advice', async () => {
        const sim = fullInventoryWorld();
        const agent = createAgent(sim, {
            model: mockModel('Your inventory is full. Mine stone, which will drop cobblestone and free inventory space.'),
        });
        const step = async (action, commandName, commandKey, prepare) => {
            agent.actions.clearLastOutcome();
            prepare();
            const key = recordCommandResult(agent, { commandName, commandKey, failed: true, isAction: true });
            return maybeAutoReflect(agent, key);
        };
        assert.equal(await step('collect', '!collectBlocks', '!collectBlocks("iron_ore", 1)', () => agent.actions.recordOutcome(capacityOutcome(agent))), null);
        assert.equal(await step('discard', '!discard', '!discard("dirt", 10)', () => agent.actions.recordOutcome(partialDiscard(agent))), null);
        const result = await step('collect', '!collectBlocks', '!collectBlocks("iron_ore", 1)', () => {
            agent.actions.recordBlockedAttempt('collectBlocks', { type: 'iron_ore', num: 1 }, {
                condition: 'inventory_capacity', reason: 'Normal inventory storage is full.',
                prerequisites: ['Free at least one normal storage slot.'], expectedItems: ['raw_iron'],
            });
        });

        assert.match(result, /Private reflection.*inventory-capacity loop/s);
        assert.equal(modelCalls.length, 1);
        const prompt = modelCalls[0].user;
        assert.match(prompt, /Normal storage: 36\/36 slots occupied, 0 free/);
        assert.match(prompt, /Removing part of a stack does not free a slot/);
        assert.match(prompt, /cannot free space/);
        assert.match(prompt, /normal storage slots freed: 0/);
        // The model's wrong advice is corrected against the verified fact.
        assert.match(result, /Verified correction: .*cannot free inventory space/);

        // A verified lesson (from observed evidence, not model text) was retained.
        const lessons = loadLessons(agent, lessonsDir);
        assert.ok(lessons.some(lesson => lesson.id === 'capacity:partial_discard' && lesson.basis === 'observed'));
        assert.ok(lessons.every(lesson => !/free inventory space/.test(lesson.text) || /does not free/.test(lesson.text)));
    });
});

describe('limits: cooldown, single-flight, concurrency', () => {
    function failTimes(agent, times) {
        let key = null;
        for (let i = 0; i < times; i++) {
            agent.actions.clearLastOutcome();
            key = recordCommandResult(agent, { commandName: '!placeHere', commandKey: '!placeHere("torch")', failed: true, isAction: true, resultText: "You don't have torch" });
        }
        return key;
    }

    test('cooldown suppresses a second automatic reflection and unchanged repeats do not re-trigger', async () => {
        const agent = createAgent(createWorld({}));
        let key = failTimes(agent, 3);
        assert.match(await maybeAutoReflect(agent, key), /^Private reflection/);
        // Another full threshold of failures, but still inside the 60s cooldown.
        reflectionState(agent).locked = false;
        key = failTimes(agent, 3);
        assert.equal(await maybeAutoReflect(agent, key), null);
        assert.equal(modelCalls.length, 1);
        assert.match(logs.join('\n'), /Automatic reflection skipped: reason=cooldown problem=placeHere:torch/);

    });

    test('two retries rejected by the same unchanged condition reflect before the general threshold', async () => {
        const agent = createAgent(createWorld({}));
        const reject = () => {
            agent.actions.clearLastOutcome();
            agent.actions.recordBlockedAttempt('buildPlane', { type: 'cobblestone' }, {
                condition: 'state_changed',
                reason: 'The target positions are occupied by grass blocks.',
                prerequisites: ['Choose open-air coordinates above the ground.'],
            });
            return recordCommandResult(agent, {
                commandName: '!buildPlane',
                commandKey: '!buildPlane("cobblestone", 0, 63, 0, 0, 63, 3)',
                failed: true,
                isAction: true,
                resultText: 'UNCHANGED BLOCKING CONDITION',
            });
        };

        assert.equal(await maybeAutoReflect(agent, reject()), null);
        const result = await maybeAutoReflect(agent, reject());
        assert.match(result, /Private reflection.*repeated retries rejected/s);
        assert.equal(modelCalls.length, 1);
        assert.match(modelCalls[0].user, /What exact fact am I overlooking/);
        assert.match(modelCalls[0].user, /Choose open-air coordinates above the ground/);
    });

    test('unchanged conditions need a full new threshold of failures before reflecting again', async () => {
        setSettings({ reasoning: { ...REFLECTION_SETTINGS, auto_cooldown_ms: 0 } });
        const agent = createAgent(createWorld({}));
        await maybeAutoReflect(agent, failTimes(agent, 3));
        reflectionState(agent).locked = false;
        assert.equal(await maybeAutoReflect(agent, failTimes(agent, 1)), null);
        assert.equal(await maybeAutoReflect(agent, failTimes(agent, 1)), null);
        assert.match(logs.join('\n'), /reason=unchanged_conditions/);
        assert.equal(modelCalls.length, 1);
    });

    test('a separate cooled-down reflection can run once the threshold is exceeded again', async () => {
        setSettings({ reasoning: { ...REFLECTION_SETTINGS, auto_cooldown_ms: 0 } });
        const agent = createAgent(createWorld({}));
        let key = failTimes(agent, 3);
        await maybeAutoReflect(agent, key);
        reflectionState(agent).locked = false;
        key = failTimes(agent, 3);
        assert.match(await maybeAutoReflect(agent, key), /^Private reflection/);
        assert.equal(modelCalls.length, 2);
    });

    test('single-flight per agent and a global concurrency limit', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const slow = { async complete() { await gate; return { content: 'Try another area for the ore. Next: explore.', eval_count: 5 }; } };
        const first = createAgent(createWorld({}), { name: 'A', model: slow });
        const second = createAgent(createWorld({}), { name: 'B', model: mockModel() });

        const running = reflect(first, 'one', { source: 'voluntary' });
        assert.match(await reflect(first, 'again', { source: 'voluntary' }), /already running/);
        assert.match(await reflect(second, 'other agent', { source: 'voluntary' }), /Another reflection is already running/);
        release();
        assert.match(await running, /^Private reflection/);
        assert.match(await reflect(second, 'now free', { source: 'voluntary' }), /^Private reflection/);
    });

    test('repeated stuck recoveries during an action trigger reflection with that evidence', async () => {
        const agent = createAgent(createWorld({}));
        for (let i = 0; i < 3; i++) noteStuckRecovery(agent, 'action:collectBlocks');
        agent.actions.clearLastOutcome();
        const key = recordCommandResult(agent, { commandName: '!collectBlocks', commandKey: '!collectBlocks("iron_ore", 1)', failed: true, isAction: true, resultText: 'Failed to reach' });
        assert.equal(key, 'stuck:collectBlocks');
        const result = await maybeAutoReflect(agent, key);
        assert.match(result, /repeated stuck recovery/);
        assert.match(modelCalls[0].user, /unstuck recovery during collectBlocks/);
    });

    test('automatic reflection is skipped when auto_reflection is disabled', async () => {
        setSettings({ reasoning: { ...REFLECTION_SETTINGS, auto_reflection: false } });
        const agent = createAgent(createWorld({}));
        assert.equal(await maybeAutoReflect(agent, failTimes(agent, 5)), null);
        assert.equal(modelCalls.length, 0);
    });

    test('a failed reflection never throws into the decision loop', async () => {
        const broken = { async complete() { throw new Error('ollama down'); } };
        const sim = createWorld({ inventory: {} });
        const agent = createAgent(sim, { model: broken, responses: ['!placeHere("torch")', '!placeHere("torch")', '!placeHere("torch")'] });
        const used = await agent.handleMessage('system', 'Continue.', 3);
        assert.equal(used, true);
        assert.equal(reflections(agent).length, 0);
    });
});

describe('grounding the five historical wrong reflections', () => {
    const wrongAdvice = {
        sticks: ['I have oak planks but cannot craft sticks.', 'The game does not recognize oak planks as a valid ingredient for crafting sticks.'],
        planks: ['I want to craft acacia planks from acacia logs.', 'You need four acacia logs for four acacia planks.'],
        bed: ['I want to craft a bed.', 'A bed needs 3 wooden planks and 1 bedrock or stone block.'],
        stone: ['I want to mine stone.', 'Use your pickaxe to mine stone, which will produce stone blocks.'],
        capacity: ['My inventory is full.', 'Mine stone, which will drop cobblestone and free inventory space.'],
    };

    test('prompts carry the verified facts for sticks, planks, bed, stone and capacity', () => {
        const sim = createWorld({ inventory: { oak_planks: 10, acacia_log: 9, stone_pickaxe: 1 } });
        const agent = createAgent(sim);
        const prompt = question => situationReport(agent, question).text;

        const sticks = prompt(wrongAdvice.sticks[0]);
        assert.match(sticks, /stick is crafted from 2 oak_planks/i);
        assert.match(sticks, /One craft makes 4 stick/i);

        const planks = prompt(wrongAdvice.planks[0]);
        assert.match(planks, /acacia_planks is crafted from 1 acacia_log/i);
        assert.match(planks, /One craft makes 4 acacia_planks/i);

        const bed = prompt(wrongAdvice.bed[0]);
        assert.match(bed, /bed is crafted from 3 wool/i);
        assert.match(bed, /No other item \(such as bedrock or stone\) is an ingredient/);

        const stone = prompt(wrongAdvice.stone[0]);
        assert.match(stone, /Mining stone with a suitable pickaxe yields cobblestone, not stone/);
    });

    for (const [name, [question, advice]] of Object.entries(wrongAdvice)) {
        test(`wrong advice about ${name} is corrected before it reaches the agent`, async () => {
            const sim = createWorld({ inventory: { oak_planks: 10, acacia_log: 9, stone_pickaxe: 1 } });
            if (name === 'capacity') for (let slot = 9; slot < 45; slot++) sim.bot.inventory.slots[slot] = itemStack('dirt', 64, slot);
            const agent = createAgent(sim, { model: mockModel(advice) });
            const result = await reflect(agent, question, { source: 'voluntary' });
            assert.match(result, /Verified correction:/);
            assert.match(logs.join('\n'), /Corrected \d+ claim\(s\) against verified mechanics/);
        });
    }

    test('correct advice is left untouched', () => {
        const detail = verifiedMechanicsDetail({ text: 'craft sticks from oak planks', inventory: { oak_planks: 10 } });
        assert.deepEqual(adviceCorrections('Craft two sticks from the oak planks, then a wooden pickaxe.', detail), []);
        const planks = verifiedMechanicsDetail({ text: 'craft acacia planks', inventory: { acacia_log: 2 } });
        assert.deepEqual(adviceCorrections('You need 2 acacia logs for 8 acacia planks.', planks), []);
    });
});

describe('verified lessons', () => {
    test('only mechanics-derived or observed-evidence lessons are accepted; model advice never is', () => {
        const agent = createAgent(createWorld({}));
        agent.lessonsBaseDir = lessonsDir;
        const base = { id: 'x', text: 'A fact.', evidence: 'something observed', tags: ['t'] };
        assert.equal(recordLesson(agent, { ...base, basis: 'llm_advice' }, lessonsDir), false);
        assert.equal(recordLesson(agent, { ...base, basis: 'reflection' }, lessonsDir), false);
        assert.equal(recordLesson(agent, { ...base, basis: 'observed', evidence: '' }, lessonsDir), false);
        assert.equal(loadLessons(agent, lessonsDir).length, 0);
        assert.equal(recordLesson(agent, { ...base, basis: 'mechanics' }, lessonsDir), true);
        assert.equal(recordLesson(agent, { ...base, id: 'y', basis: 'observed' }, lessonsDir), true);
        assert.equal(loadLessons(agent, lessonsDir).length, 2);
        assert.ok(existsSync(path.join(lessonsDir, agent.name, 'verified_lessons.json')));
        assert.doesNotMatch(readFileSync(path.join(lessonsDir, agent.name, 'verified_lessons.json'), 'utf8'), /llm_advice/);
    });

    test('lessons are capped and duplicates reinforce instead of growing', () => {
        const agent = createAgent(createWorld({}));
        for (let i = 0; i < 30; i++) {
            recordLesson(agent, { id: `l${i}`, text: 't', basis: 'mechanics', evidence: 'e' }, lessonsDir);
        }
        assert.ok(loadLessons(agent, lessonsDir).length <= 12);
        recordLesson(agent, { id: 'l29', text: 't', basis: 'mechanics', evidence: 'e' }, lessonsDir);
        assert.equal(loadLessons(agent, lessonsDir).find(lesson => lesson.id === 'l29').count, 2);
    });
});

describe('successful-but-unproductive inventory-management cycles (live scenarios)', () => {
    /** A discard exactly as the real command reports it: a verified inventory and storage delta. */
    function discardOutcome(agent, item, count, { empty = false } = {}) {
        const before = inventorySnapshot(agent.bot);
        const index = agent.bot.inventory.slots.findIndex(slot => slot?.name === item);
        assert.ok(index >= 0, `${item} must be in the inventory`);
        const slot = agent.bot.inventory.slots[index];
        const requested = count;
        if (empty || slot.count <= count) agent.bot.inventory.slots[index] = null;
        else slot.count -= count;
        const after = inventorySnapshot(agent.bot);
        return createActionOutcome({
            action: 'discard', params: { item_name: item, num: requested }, status: 'success',
            before, after, relevantProgress: true, details: { requested, removed: requested }, bot: agent.bot,
        });
    }

    async function discard(agent, item, count, options) {
        agent.actions.clearLastOutcome();
        agent.actions.recordOutcome(discardOutcome(agent, item, count, options));
        const key = recordCommandResult(agent, {
            commandName: '!discard', commandKey: `!discard("${item}", ${count})`, failed: false, isAction: true,
        });
        return maybeAutoReflect(agent, key);
    }

    async function collect(agent, command) {
        agent.actions.clearLastOutcome();
        const { executeCommand } = await import('../src/agent/commands/index.js');
        await executeCommand(agent, command);
        const [, name] = command.match(/^(!\w+)/);
        const key = recordCommandResult(agent, { commandName: name, commandKey: command, failed: false, isAction: true });
        return maybeAutoReflect(agent, key);
    }

    test('Finn: repeated successful discards of different items with no blocked objective trigger reflection', async () => {
        const sim = createWorld({ inventory: { light_gray_wool: 4, wheat_seeds: 6, stone_pickaxe: 1 } });
        const agent = createAgent(sim, {
            model: mockModel('Your storage has plenty of room, so discarding is not helping. Next: return to your objective.'),
        });
        assert.equal(await discard(agent, 'light_gray_wool', 1), null);
        assert.equal(await discard(agent, 'wheat_seeds', 1), null);
        const result = await discard(agent, 'light_gray_wool', 1);

        assert.match(result, /^Private reflection .*repeated inventory management/s);
        assert.equal(modelCalls.length, 1);
        const prompt = modelCalls[0].user;
        // No blocker exists, and the context says so with real slot numbers.
        assert.match(prompt, /VERIFIED inventory-management context/);
        assert.match(prompt, /No blocked objective is recorded, and no recent action failed for lack of inventory space/);
        assert.match(prompt, /Normal storage is 33 free of 36/);
        assert.match(prompt, /Inventory-management actions in a row without other progress: 3/);
        assert.match(prompt, /!discard\("wheat_seeds", 1\): free slots 33 -> 33/);
        assert.match(prompt, /Current objective: Build a base with iron tools/);
        assert.match(prompt, /Normal storage: 3\/36 slots occupied, 33 free/);
        assert.match(logs.join('\n'), /source=automatic_failure trigger=repeated inventory management without returning to an objective problem=inventory_management/);
        // The framework only advises: nothing was discarded on the agent's behalf.
        assert.equal(sim.bot.inventory.slots.find(slot => slot?.name === 'light_gray_wool').count, 2);
        assert.match(modelCalls[0].system, /Keeping, using, storing in a chest, and discarding are all legitimate/);
        assert.doesNotMatch(modelCalls[0].system, /you should discard/i);
    });

    test('Finn: collecting dirt only to discard it is recognised as a cycle', async () => {
        const sim = createWorld({
            inventory: { stone_pickaxe: 1 },
            blocks: [['dirt', 2, 64, 0], ['dirt', 3, 64, 0]],
            onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('dirt', 1); },
        });
        const agent = createAgent(sim, { model: mockModel('You collected dirt only to throw it away. Next: pursue your objective.') });
        assert.equal(await collect(agent, '!collectBlocks("dirt", 1)'), null);
        assert.equal(await discard(agent, 'dirt', 1), null); // collect + discard = 2
        assert.equal(await collect(agent, '!collectBlocks("dirt", 1)'), null);
        const result = await discard(agent, 'dirt', 1);

        assert.match(result, /^Private reflection/);
        const prompt = modelCalls[0].user;
        assert.match(prompt, /collected dirt and then discarded it/);
        assert.match(prompt, /discarded the dirt it had just collected/);
        assert.match(prompt, /Inventory-management actions in a row without other progress: 4/);
    });

    test('productive work between discards ends the streak: no reflection', async () => {
        const sim = createWorld({
            inventory: { light_gray_wool: 9, wheat_seeds: 9, stone_pickaxe: 1 },
            blocks: [['oak_log', 2, 64, 0], ['oak_log', 3, 64, 0], ['oak_log', 4, 64, 0], ['oak_log', 5, 64, 0]],
            onCollect: ({ block, breakBlock, add }) => { breakBlock(block); add('oak_log', 1); },
        });
        const agent = createAgent(sim);
        const results = [
            await discard(agent, 'light_gray_wool', 1),
            await discard(agent, 'wheat_seeds', 1),
            await collect(agent, '!collectBlocks("oak_log", 1)'),   // objective work that is kept
            await discard(agent, 'light_gray_wool', 1),
            await discard(agent, 'wheat_seeds', 1),
            await collect(agent, '!collectBlocks("oak_log", 1)'),
            await discard(agent, 'light_gray_wool', 1),
        ];
        assert.deepEqual(results, results.map(() => null));
        assert.equal(modelCalls.length, 0);
    });

    test('storing in a chest neither counts as a cycle nor hides one', async () => {
        const agent = createAgent(createWorld({ inventory: { light_gray_wool: 9, stone_pickaxe: 1 } }));
        for (let i = 0; i < 5; i++) {
            agent.actions.clearLastOutcome();
            const key = recordCommandResult(agent, { commandName: '!putInChest', commandKey: '!putInChest("cobblestone", 20)', failed: false, isAction: true });
            assert.equal(await maybeAutoReflect(agent, key), null);
        }
        assert.equal(modelCalls.length, 0);
        // Two discards, a chest store, then a third discard is still one streak.
        await discard(agent, 'light_gray_wool', 1);
        await discard(agent, 'light_gray_wool', 1);
        agent.actions.clearLastOutcome();
        recordCommandResult(agent, { commandName: '!putInChest', commandKey: '!putInChest("dirt", 5)', failed: false, isAction: true });
        assert.match(await discard(agent, 'light_gray_wool', 1), /^Private reflection/);
    });

    test('Rowan: discarding after the blocking condition is resolved triggers reflection with the blocked objective', async () => {
        const sim = fullInventoryWorld();
        sim.bot.inventory.slots[9] = itemStack('acacia_planks', 12, 9);
        sim.bot.inventory.slots[10] = itemStack('cobblestone', 7, 10);
        const agent = createAgent(sim, { model: mockModel('The blocker is already resolved, so more discarding is unnecessary. Next: retry the collection.') });

        // The original objective is blocked by a full inventory.
        agent.actions.clearLastOutcome();
        agent.actions.recordOutcome(createActionOutcome({
            action: 'collectBlocks', params: { type: 'iron_ore', num: 1 }, status: 'failure',
            before: inventorySnapshot(agent.bot), after: inventorySnapshot(agent.bot),
            reason: classifyFailure('Inventory full, no place to deposit', 'x'),
            retryableWithoutStateChange: false, bot: agent.bot,
        }));
        recordCommandResult(agent, { commandName: '!collectBlocks', commandKey: '!collectBlocks("iron_ore", 1)', failed: true, isAction: true });

        assert.equal(await discard(agent, 'dirt', 10), null);                       // partial: frees nothing
        assert.equal(await discard(agent, 'acacia_planks', 12, { empty: true }), null); // frees a whole slot: resolved
        const result = await discard(agent, 'cobblestone', 7, { empty: true });      // discards on after resolution

        assert.match(result, /^Private reflection .*repeated inventory management/s);
        const prompt = modelCalls[0].user;
        assert.match(prompt, /Original blocked objective: !collectBlocks\("iron_ore", 1\)/);
        assert.match(prompt, /the blocking condition is RESOLVED/);
        assert.match(prompt, /Nothing further needs to be freed for it/);
        // Actual free slots before and after each management action.
        assert.match(prompt, /!discard\("dirt", 10\): free slots 0 -> 0/);
        assert.match(prompt, /!discard\("acacia_planks", 12\): free slots 0 -> 1/);
        assert.match(prompt, /!discard\("cobblestone", 7\): free slots 1 -> 2/);
        // Verified mechanics are included.
        assert.match(prompt, /VERIFIED Minecraft mechanics/);
        assert.match(prompt, /removing part of a stack never frees a slot; only emptying a whole stack does/);
        assert.match(prompt, /raw_iron can currently be picked up/);
        assert.match(prompt, /3 inventory-management actions in a row without other progress/);
    });

    test('Rowan: management that never resolves the blocked objective is shown as NOT resolved', async () => {
        const sim = fullInventoryWorld();
        const agent = createAgent(sim);
        agent.actions.clearLastOutcome();
        agent.actions.recordOutcome(createActionOutcome({
            action: 'collectBlocks', params: { type: 'iron_ore', num: 1 }, status: 'failure',
            before: inventorySnapshot(agent.bot), after: inventorySnapshot(agent.bot),
            reason: classifyFailure('Inventory full, no place to deposit', 'x'),
            retryableWithoutStateChange: false, bot: agent.bot,
        }));
        recordCommandResult(agent, { commandName: '!collectBlocks', commandKey: '!collectBlocks("iron_ore", 1)', failed: true, isAction: true });
        await discard(agent, 'dirt', 1);
        const result = await discard(agent, 'dirt', 1);
        assert.match(result, /^Private reflection/);
        const prompt = modelCalls[0].user;
        assert.match(prompt, /Original blocked objective: !collectBlocks\("iron_ore", 1\)/);
        assert.match(prompt, /the blocking condition is NOT resolved/);
        assert.match(prompt, /Free normal storage slots: 0 -> 0/);
    });

    test('resuming the blocked objective clears it, so later discards are not tied to it', async () => {
        const sim = fullInventoryWorld();
        const agent = createAgent(sim);
        const blocked = createActionOutcome({
            action: 'collectBlocks', params: { type: 'iron_ore', num: 1 }, status: 'failure',
            before: inventorySnapshot(agent.bot), after: inventorySnapshot(agent.bot),
            reason: classifyFailure('Inventory full, no place to deposit', 'x'),
            retryableWithoutStateChange: false, bot: agent.bot,
        });
        agent.actions.recordOutcome(blocked);
        recordCommandResult(agent, { commandName: '!collectBlocks', commandKey: '!collectBlocks("iron_ore", 1)', failed: true, isAction: true });
        assert.ok(reflectionState(agent).blockedObjective);
        const before = inventorySnapshot(agent.bot);
        agent.actions.clearLastOutcome();
        agent.actions.recordOutcome(createActionOutcome({
            action: 'collectBlocks', params: { type: 'iron_ore', num: 1 }, status: 'success',
            before, after: before, relevantProgress: true, bot: agent.bot,
        }));
        recordCommandResult(agent, { commandName: '!collectBlocks', commandKey: '!collectBlocks("iron_ore", 1)', failed: false, isAction: true });
        assert.equal(reflectionState(agent).blockedObjective, null);
    });

    test('Rowan: a false belief that a slot must be freed before placing is grounded and corrected', async () => {
        const sim = createWorld({ inventory: { stone_pickaxe: 1 } });
        const agent = createAgent(sim, {
            model: mockModel('You must free an inventory slot before you can place the stone. Next: discard something.'),
            responses: ['!placeHere("stone")', '!placeHere("stone")', '!placeHere("stone")'],
        });
        agent.history.turns.push({ role: 'assistant', content: 'I need to free up inventory slots before I can place stone.' });
        await agent.handleMessage('system', 'Continue.', 3);

        assert.equal(modelCalls.length, 1);
        const prompt = modelCalls[0].user;
        assert.match(prompt, /Placing a block takes one item from an existing stack\. It does not need a free inventory slot/);
        // A placement problem is not turned into a mining lesson.
        assert.doesNotMatch(prompt, /Mining stone with a suitable pickaxe yields cobblestone/);
        const advice = reflections(agent)[0].content;
        assert.match(advice, /Verified correction: Placing a block takes one item from an existing stack/);
    });

    test('a problem that made progress starts fresh and can reflect again', async () => {
        setSettings({ reasoning: { ...REFLECTION_SETTINGS, auto_cooldown_ms: 0 } });
        const agent = createAgent(createWorld({}));
        const fail = () => {
            agent.actions.clearLastOutcome();
            return recordCommandResult(agent, { commandName: '!placeHere', commandKey: '!placeHere("torch")', failed: true, isAction: true, resultText: "You don't have torch" });
        };
        fail(); fail();
        assert.match(await maybeAutoReflect(agent, fail()), /^Private reflection/);
        reflectionState(agent).locked = false;
        agent.actions.clearLastOutcome();
        recordCommandResult(agent, { commandName: '!placeHere', commandKey: '!placeHere("torch")', failed: false, isAction: true });
        fail(); fail();
        assert.match(await maybeAutoReflect(agent, fail()), /^Private reflection/);
        assert.equal(modelCalls.length, 2);
    });
});
