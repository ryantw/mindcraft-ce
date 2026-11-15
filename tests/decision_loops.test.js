import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Vec3 from 'vec3';
import { Agent } from '../src/agent/agent.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { executeCommand } from '../src/agent/commands/index.js';
import { digDown, MAX_DIG_DOWN } from '../src/agent/library/skills.js';
import { PlanManager } from '../src/agent/plan_manager.js';
import { reflectionState } from '../src/agent/reasoning.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import settings, { setSettings } from '../src/agent/settings.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';
import { createWorld } from './helpers/construction_world.js';

initializeMinecraftData('1.21.6');

const modelCalls = [];
const originalLog = console.log;
const originalWarn = console.warn;

function mockModel(content = 'The last command cannot succeed as written. Next: choose a different action.') {
    return {
        async complete(user, system) {
            modelCalls.push({ user, system });
            return { content, done_reason: 'stop', eval_count: 20, prompt_eval_count: 400 };
        },
    };
}

beforeEach(() => {
    modelCalls.length = 0;
    console.log = () => {};
    console.warn = () => {};
    setSettings({
        allow_insecure_coding: false,
        persistent_planning: true,
        reasoning: {
            think: false,
            auto_reflection: true,
            auto_failure_threshold: 2,
            auto_cooldown_ms: 0,
            max_concurrent: 2,
            timeout_ms: 45000,
            cooldown_ms: 0,
            max_consecutive: 2,
            max_predict: 1024,
            options: { num_ctx: 8192, num_predict: 1024 },
        },
    });
});

afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    setSettings({});
});

function modeStub() {
    return {
        state: null,
        isOn(name) { return Boolean(this.state?.on && this.state.name === name); },
        exists: name => name === 'hunting',
        setOn(name, on) { this.state = { name, on }; },
        pause() {}, unpause() {}, flushBehaviorLog: () => '', getDocs: () => '', getMiniDocs: () => '',
    };
}

function createAgent(bot, { name = 'Finn', responses = [] } = {}) {
    const queue = [...responses];
    let prompts = 0;
    const agent = Object.create(Agent.prototype);
    Object.assign(agent, {
        name,
        ready: true,
        shut_up: false,
        bot,
        blocked_actions: [],
        promptCount: () => prompts,
        checkTaskDone: async () => {},
        routeResponse() {},
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        requestInterrupt() { bot.interrupt_code = true; },
        cleanKill() {},
        isIdle: () => true,
        history: {
            memory: 'Keep the current shelter goal.',
            turns: [],
            async add(_role, content) { this.turns.push(content); },
            getHistory() { return this.turns.map(content => ({ role: 'system', content })); },
            save() {},
        },
        self_prompter: {
            prompt: 'Secure shelter area and plan settlement layout',
            shouldInterrupt: () => false,
            handleUserPromptedCmd() {},
            isActive: () => true,
        },
        prompter: {
            chat_model: mockModel(),
            async promptConvo() {
                prompts++;
                return queue.shift() ?? '';
            },
        },
        plan_manager: {
            observeOutcome: () => ({}),
            getCurrentPlan: () => null,
            getCurrentStep: () => null,
            ensurePlan: async () => null,
            ensurePlanInBackground() { return null; },
        },
    });
    agent.actions = new ActionManager(agent);
    return agent;
}

/** Feet at y, one stone block under them, then a drop. blockAt throws if digging should not start. */
function dropColumn({ armed = true } = {}) {
    let looks = 0;
    const bot = {
        output: '',
        interrupt_code: false,
        health: 20,
        food: 20,
        game: { gameMode: 'survival', dimension: 'overworld' },
        entity: { position: new Vec3(8.5, 64, 8.5) },
        inventory: { inventoryStart: 9, slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
        chat() {},
        emit() {},
        dig: async () => {},
        modes: modeStub(),
        blockAt(position) {
            looks++;
            if (!armed) throw new Error('digDown should not have run');
            const x = Math.floor(position.x);
            const y = Math.floor(position.y);
            const z = Math.floor(position.z);
            const name = y === 63 ? 'stone' : 'air';
            return { name, position: new Vec3(x, y, z) };
        },
    };
    bot.looks = () => looks;
    return bot;
}

function stoneColumn() {
    const bot = dropColumn();
    bot.modes.isOn = name => name === 'cheat';
    bot.blockAt = position => {
        const x = Math.floor(position.x);
        const y = Math.floor(position.y);
        const z = Math.floor(position.z);
        const name = y < 64 && y >= 56 ? 'stone' : 'air';
        return { name, position: new Vec3(x, y, z) };
    };
    return bot;
}

function reflections(agent) {
    return agent.history.turns.filter(text => /^Private reflection/.test(text));
}

describe('Finn: malformed discard is one failed decision, not a success', () => {
    test('repeated !discard with no arguments stops, reflects once, and still allows another action', async () => {
        const bot = dropColumn({ armed: false });
        const replies = Array.from({ length: 12 }, () => '!discard');
        const agent = createAgent(bot, { name: 'Finn', responses: replies });

        await agent.handleMessage('system', 'Decide.', 12);

        assert.ok(agent.promptCount() < replies.length, 'the inner decision loop stops instead of consuming every reply');
        assert.equal(modelCalls.length, 1);
        assert.match(modelCalls[0].user, /was given 0 args, but requires 2 args/);
        assert.match(modelCalls[0].user, /!discard\(item_name:string, num:number\)/);
        assert.match(modelCalls[0].user, /rejected before it ran/);
        assert.equal(reflections(agent).length, 1);
        const problem = [...reflectionState(agent).problems.keys()].find(key => key.startsWith('validation:!discard'));
        assert.ok(problem, 'every malformed discard is the same validation problem');

        agent.prompter.promptConvo = async () => '!setMode("hunting", true)';
        assert.equal(await agent.handleMessage('system', 'Next.', 1), true);
        assert.deepEqual(bot.modes.state, { name: 'hunting', on: true });
        assert.equal(agent.self_prompter.prompt, 'Secure shelter area and plan settlement layout');

        // The refused command is still refused. A human instruction is not.
        agent.prompter.promptConvo = async () => '!discard';
        assert.equal(await agent.handleMessage('system', 'Again.', 1), false);
        assert.equal(modelCalls.length, 1);
        const human = await agent.handleMessage('Steve', '!setMode("hunting", false)');
        assert.equal(human, true);
        assert.deepEqual(bot.modes.state, { name: 'hunting', on: false });
        assert.equal(settings.allow_insecure_coding, false);
    });
});

describe('Sawyer: digDown depth changes are one zero-progress problem', () => {
    test('digDown(800/801/802) is rejected and never executed', async () => {
        const bot = dropColumn({ armed: false });
        const agent = createAgent(bot, {
            name: 'Sawyer',
            responses: ['!digDown(800)', '!digDown(801)', '!digDown(802)', '!digDown(803)', '!digDown(804)'],
        });

        await agent.handleMessage('system', 'Dig.', 8);

        assert.ok(agent.promptCount() <= 4);
        assert.equal(modelCalls.length, 1);
        assert.match(modelCalls[0].user, /less than or equal to 16|1 to 16/);
        assert.match(modelCalls[0].user, /!digDown\(distance:number\)/);
        assert.equal([...reflectionState(agent).problems.keys()].filter(key => key === 'validation:!digDown').length, 1);
        assert.equal(MAX_DIG_DOWN, 16);
    });

    test('valid depths that excavate nothing share the drop and do not count as digging', async () => {
        const bot = dropColumn();
        const before = bot.looks();
        const agent = createAgent(bot, {
            name: 'Sawyer',
            responses: ['!digDown(8)', '!digDown(9)', '!digDown(10)', '!digDown(11)', '!digDown(12)'],
        });

        await agent.handleMessage('system', 'Dig.', 8);

        const outcome = agent.actions.getLastOutcome() || agent.actions.getLastBlocked();
        assert.equal(agent.actions.getLastOutcome()?.relevantProgress ?? false, false);
        assert.match(agent.history.turns.join('\n'), /Dug down 0 blocks, but reached a drop below the next block/);
        assert.match(agent.history.turns.join('\n'), /Excavated 0 of/);
        assert.equal(modelCalls.length, 1);
        assert.match(modelCalls[0].user, /unsafe drop|Dug down 0/);
        assert.equal(bot.looks() > before, true);
        const looksAfterBurst = bot.looks();

        agent.prompter.promptConvo = async () => '!digDown(13)';
        assert.equal(await agent.handleMessage('system', 'Again.', 1), false);
        assert.equal(bot.looks(), looksAfterBurst, 'a later depth does not dig again');
        assert.equal(modelCalls.length, 1);

        // Moving to another column is a real change and may be attempted.
        bot.entity.position = new Vec3(40.5, 64, 40.5);
        const text = await executeCommand(agent, '!digDown(1)');
        assert.match(text, /Dug down 0 blocks, but reached a drop below the next block/);
        assert.equal(agent.actions.getLastOutcome().status, 'failure');
        assert.equal(agent.actions.getLastOutcome().relevantProgress, false);
        assert.equal(agent.actions.getLastOutcome().evidence.dig.excavated, 0);
        assert.notEqual(outcome?.behaviorKey, agent.actions.getLastOutcome().behaviorKey);

        // A human can still order a dig while the autonomous column is blocked.
        bot.entity.position = new Vec3(8.5, 64, 8.5);
        const human = await executeCommand(agent, '!digDown(1)', { operator: true });
        assert.match(human, /Dug down 0 blocks/);
    });

    test('a dig that breaks blocks stays repeatable, and an interruption is not the drop', async () => {
        const bot = stoneColumn();
        const agent = createAgent(bot, { name: 'Sawyer', responses: ['!digDown(1)', '!digDown(1)'] });
        await agent.handleMessage('system', 'Dig.', 2);

        assert.equal(modelCalls.length, 0);
        assert.equal(agent.actions.getLastOutcome().status, 'success');
        assert.equal(agent.actions.getLastOutcome().evidence.dig.excavated, 1);
        assert.equal(agent.actions.getLastOutcome().relevantProgress, true);
        assert.equal(agent.actions.retryBlock('digDown', { distance: 1 }), null);

        // A column of natural stone stays diggable. A block this agent just
        // placed does not: digging it is how the same plank gets put back.
        const placed = dropColumn();
        placed.blockAt = position => {
            const x = Math.floor(position.x);
            const y = Math.floor(position.y);
            const z = Math.floor(position.z);
            const name = y === 63 ? 'oak_planks' : 'air';
            return { name, position: new Vec3(x, y, z) };
        };
        placed.dig = async () => { throw new Error('dig should not start'); };
        const builder = createAgent(placed, { name: 'Rowan' });
        builder.actions.recentPlacements.set('8,63,8', 'oak_planks');
        const undone = await executeCommand(builder, '!digDown(1)');
        assert.match(undone, /just placed/);
        assert.equal(builder.actions.getLastOutcome(), null);

        const observed = {};
        let seen = 0;
        bot.blockAt = position => {
            seen++;
            if (seen > 3) bot.interrupt_code = true;
            const x = Math.floor(position.x);
            const y = Math.floor(position.y);
            const z = Math.floor(position.z);
            return { name: y < 64 && y >= 56 ? 'stone' : 'air', position: new Vec3(x, y, z) };
        };
        await digDown(bot, 4, observed);
        assert.equal(observed.stop, 'interrupted');
        assert.ok(observed.excavated > 0);
        assert.notEqual(observed.stop, 'unsafe_drop');
    });
});

describe('Milo: equivalent blocked builds are one problem', () => {
    test('buildPlane and buildLine of the same blocks stop alternating', async () => {
        const placed = [0, 1, 2, 3, 4].map(z => ['cobblestone', 0, 64, z]);
        const world = createWorld({
            inventory: { cobblestone: 88 },
            position: [1.5, 64, 2],
            blocks: placed,
        });
        Object.assign(world.bot, {
            health: 20,
            food: 20,
            game: { gameMode: 'survival', dimension: 'overworld' },
            emit() {},
            modes: modeStub(),
        });
        const line = '!buildLine("cobblestone", 0, 64, 0, 0, 64, 4)';
        const plane = '!buildPlane("cobblestone", 0, 64, 0, 0, 64, 4)';
        const agent = createAgent(world.bot, {
            name: 'Milo',
            responses: [plane, line, plane, line, plane, line],
        });

        await agent.handleMessage('system', 'Build.', 8);

        assert.ok(agent.promptCount() < 6);
        assert.equal(world.log.placements.length, 0, 'nothing new is placed');
        assert.equal(world.nameAt(0, 64, 0), 'cobblestone');
        assert.equal(world.nameAt(0, 64, 4), 'cobblestone');
        assert.equal(modelCalls.length, 1);
        assert.match(modelCalls[0].user, /already in place|placed nothing new/);
        const keys = [...reflectionState(agent).problems.keys()];
        assert.equal(keys.filter(key => key.startsWith('construction:cobblestone:')).length, 1);
        assert.equal(agent.self_prompter.prompt, 'Secure shelter area and plan settlement layout');

        const elsewhere = await executeCommand(agent, '!buildLine("cobblestone", 10, 64, 10, 12, 64, 10)');
        assert.doesNotMatch(elsewhere, /UNCHANGED BLOCKING CONDITION: Those blocks are already in place/);

        agent.prompter.promptConvo = async () => '!setMode("hunting", true)';
        assert.equal(await agent.handleMessage('system', 'Next.', 1), true);
        assert.equal(modelCalls.length, 1);
    });
});

describe('planning does not spin on rejected or blocked plans', () => {
    test('repeated no_active_plan rejections wait longer and keep the goal', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'mindcraft-loop-plan-'));
        try {
            const agent = {
                name: 'Milo',
                blocked_actions: [],
                bot: {
                    inventory: { inventoryStart: 9, slots: Array(46).fill(null) },
                    entity: { position: { x: 0, y: 64, z: 0 } },
                    blockAt: () => ({ name: 'air' }),
                },
                self_prompter: { prompt: 'Secure shelter area and plan settlement layout' },
                history: { memory: '' },
                prompter: { calls: 0, async promptPlanning() { this.calls++; return null; } },
            };
            const manager = new PlanManager(agent, root);
            agent.plan_manager = manager;

            assert.equal(await manager.ensurePlan(), null);
            const firstWait = manager.nextPlanningAllowedAt - Date.now();
            assert.equal(agent.prompter.calls, 1);
            manager.nextPlanningAllowedAt = 0;
            assert.equal(await manager.ensurePlan(), null);
            const secondWait = manager.nextPlanningAllowedAt - Date.now();
            assert.ok(secondWait > firstWait * 1.5, 'the next rejected plan waits longer');
            await manager.ensurePlan();
            assert.equal(agent.prompter.calls, 2, 'backoff suppresses another planning call');
            assert.equal(agent.self_prompter.prompt, 'Secure shelter area and plan settlement layout');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('a blocked step does not replan immediately or drop a completed step', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'mindcraft-loop-plan-'));
        try {
            const slots = Array(46).fill(null);
            slots[9] = { name: 'coal', count: 2, slot: 9 };
            const agent = {
                name: 'Milo',
                blocked_actions: [],
                bot: {
                    inventory: { inventoryStart: 9, slots },
                    entity: { position: { x: 0, y: 64, z: 0 } },
                    blockAt: () => ({ name: 'air' }),
                },
                self_prompter: { prompt: 'Live independently.' },
                history: { memory: '' },
                prompter: { calls: 0, async promptPlanning() { this.calls++; return null; } },
            };
            const manager = new PlanManager(agent, root);
            manager.applyProposal({
                objective: 'Make torches',
                steps: [
                    {
                        id: 'gather_coal',
                        description: 'Collect coal',
                        action: { name: 'collectBlocks', params: { type: 'coal_ore', num: 2 } },
                        evidence: { type: 'inventory_min', item: 'coal', count: 2 },
                    },
                    {
                        id: 'craft_torches',
                        description: 'Craft torches',
                        action: { name: 'craftRecipe', params: { recipe_name: 'torch', num: 1 } },
                        evidence: { type: 'verified_action', action: 'craftRecipe', params: { recipe_name: 'torch', num: 1 } },
                    },
                ],
            });
            const { createActionOutcome, inventorySnapshot } = await import('../src/agent/action_outcome.js');
            const before = inventorySnapshot(agent.bot);
            manager.observeOutcome(createActionOutcome({
                action: 'collectBlocks',
                params: { type: 'coal_ore', num: 2 },
                status: 'success',
                before, after: before,
                relevantProgress: true,
                bot: agent.bot,
            }));
            assert.equal(manager.getCurrentPlan().steps[0].status, 'completed');

            manager.observeOutcome(createActionOutcome({
                action: 'craftRecipe',
                params: { recipe_name: 'torch', num: 1 },
                status: 'failure',
                before, after: before,
                reason: {
                    code: 'missing_resource',
                    message: 'Not enough sticks.',
                    prerequisites: ['Acquire sticks.'],
                    condition: 'state_changed',
                },
                retryableWithoutStateChange: false,
                relevantProgress: false,
                bot: agent.bot,
            }));
            assert.equal(manager.getCurrentStep().status, 'blocked');
            assert.equal(manager.getCurrentPlan().steps[0].status, 'completed');
            assert.ok(manager.nextPlanningAllowedAt > Date.now());
            assert.equal(await manager.ensurePlan(), manager.getCurrentPlan());
            assert.equal(agent.prompter.calls, 0);
            assert.equal(manager.getCurrentPlan().steps[0].status, 'completed');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

test('suppressed repeats wait instead of starting another recovery reflection', async () => {
    let calls = 0;
    const agent = {
        name: 'Finn',
        shut_up: false,
        actions: { repeatSuppressed: false, stop: async () => {} },
        plan_manager: {
            ensurePlan: async () => null,
            getCurrentPlan: () => null,
            getCurrentStep: () => null,
        },
        handleMessage: async () => {
            calls++;
            agent.actions.repeatSuppressed = true;
            if (calls >= 2) agent.self_prompter.state = 0;
            return false;
        },
        history: { add: async () => {}, save: async () => {} },
        isIdle: () => true,
    };
    const prompter = new SelfPrompter(agent);
    agent.self_prompter = prompter;
    prompter.recovery_backoff = 0;
    prompter.max_recovery_backoff = 0;
    prompter.cooldown = 0;
    prompter.prompt = 'Secure shelter area and plan settlement layout';
    prompter.state = 1;
    await prompter.startLoop();
    assert.equal(calls, 2);
    assert.equal(prompter.recovery_attempts, 1);
    assert.equal(prompter.prompt, 'Secure shelter area and plan settlement layout');
});
