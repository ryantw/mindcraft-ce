import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { PlanManager } from '../src/agent/plan_manager.js';
import { setSettings } from '../src/agent/settings.js';
import { createActionOutcome, inventorySnapshot } from '../src/agent/action_outcome.js';

// Planning is opt-in; these tests exercise the enabled behavior.
setSettings({ persistent_planning: true });

function inventorySlots(counts={}) {
    const slots = Array(46).fill(null);
    let index = 9;
    for (const [name, count] of Object.entries(counts)) {
        slots[index] = { name, count, slot: index };
        index++;
    }
    return slots;
}

function makeAgent(name='Sawyer', counts={}) {
    return {
        name,
        bot: {
            inventory: { inventoryStart: 9, slots: inventorySlots(counts) },
            entity: { position: { x: 0, y: 64, z: 0 } },
            blockAt: () => ({ name: 'air' }),
        },
        self_prompter: { prompt: 'Live independently and pursue useful interests.' },
        history: { memory: 'Sawyer enjoys improving the settlement.' },
    };
}

function proposal() {
    return {
        objective: 'Make a useful supply of torches for exploring nearby caves',
        rationale: 'Dark caves nearby are interesting and safer with light.',
        steps: [
            {
                id: 'gather_coal',
                description: 'Collect enough coal for torches',
                action: { name: 'collectBlocks', params: { type: 'coal_ore', num: 2 } },
                evidence: { type: 'inventory_min', item: 'coal', count: 2 },
                requiredResources: ['stone_pickaxe'],
                prerequisites: ['reachable coal_ore'],
            },
            {
                id: 'craft_torches',
                description: 'Craft torches from the gathered coal and sticks',
                action: { name: 'craftRecipe', params: { recipe_name: 'torch', num: 1 } },
                evidence: {
                    type: 'verified_action',
                    action: 'craftRecipe',
                    params: { recipe_name: 'torch', num: 1 },
                },
                requiredResources: ['coal', 'stick'],
                prerequisites: [],
            },
        ],
    };
}

function outcome(agent, options) {
    const before = options.before || inventorySnapshot(agent.bot);
    const after = options.after || inventorySnapshot(agent.bot);
    return createActionOutcome({
        action: options.action,
        params: options.params,
        status: options.status,
        before,
        after,
        reason: options.reason || null,
        retryableWithoutStateChange: options.retryableWithoutStateChange ?? true,
        relevantProgress: options.relevantProgress ?? options.status !== 'failure',
        bot: agent.bot,
    });
}

test('verified inventory evidence advances steps and the plan survives reload', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, root);
        agent.plan_manager = manager;
        manager.applyProposal(proposal());

        assert.equal(manager.getCurrentStep().id, 'gather_coal');
        assert.equal(manager.getCurrentStep().status, 'active');

        const before = inventorySnapshot(agent.bot);
        agent.bot.inventory.slots[9] = { name: 'coal', count: 2, slot: 9 };
        const after = inventorySnapshot(agent.bot);
        const update = manager.observeOutcome(outcome(agent, {
            action: 'collectBlocks',
            params: { type: 'coal_ore', num: 2 },
            status: 'success',
            before,
            after,
        }));

        assert.equal(update.advanced, true);
        assert.equal(manager.getCurrentStep().id, 'craft_torches');
        assert.equal(manager.getCurrentPlan().steps[0].status, 'completed');

        const restartedAgent = makeAgent('Sawyer', { coal: 2 });
        const restarted = new PlanManager(restartedAgent, root);
        assert.equal(restarted.getCurrentPlan().objective, proposal().objective);
        assert.equal(restarted.getCurrentStep().id, 'craft_torches');
        assert.equal(restarted.getCurrentPlan().steps[0].status, 'completed');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a success claim without satisfying observed evidence does not advance', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, root);
        manager.applyProposal(proposal());

        const update = manager.observeOutcome(outcome(agent, {
            action: 'collectBlocks',
            params: { type: 'coal_ore', num: 2 },
            status: 'success',
        }));

        assert.equal(update.advanced, false);
        assert.equal(manager.getCurrentStep().id, 'gather_coal');
        assert.equal(manager.getCurrentStep().status, 'active');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a non-retryable structured failure blocks the step and requests replanning', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, root);
        manager.applyProposal(proposal());
        const update = manager.observeOutcome(outcome(agent, {
            action: 'collectBlocks',
            params: { type: 'coal_ore', num: 2 },
            status: 'failure',
            reason: {
                code: 'target_unavailable',
                message: 'No currently reachable target was found.',
                prerequisites: ['Move to a different area.'],
                condition: 'state_changed',
            },
            retryableWithoutStateChange: false,
            relevantProgress: false,
        }));

        assert.equal(update.blocked, true);
        assert.equal(manager.getCurrentStep().status, 'blocked');
        assert.equal(manager.planningReason(), 'step_blocked');
        assert.match(manager.formatForPrompt(), /Blocked because: No currently reachable target/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a remembered-place arrival advances that step, and a search cannot require an unrelated item', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, root);
        manager.applyProposal({
            objective: 'Look at the place already saved as home',
            rationale: 'The saved place is the next concrete step.',
            steps: [
                {
                    id: 'walk',
                    description: 'Walk to the saved place',
                    action: { name: 'goToRememberedPlace', params: { name: 'home' } },
                    evidence: { type: 'inventory_min', item: 'oak_log', count: 1 },
                },
                {
                    id: 'look',
                    description: 'See whether anyone is there',
                    action: { name: 'searchForEntity', params: { type: 'player', search_range: 32 } },
                    evidence: { type: 'inventory_min', item: 'oak_log', count: 1 },
                },
            ],
        });
        assert.equal(manager.getCurrentStep().evidence.type, 'verified_action');
        assert.equal(manager.getCurrentStep().evidence.action, 'goToRememberedPlace');
        assert.equal(manager.getCurrentPlan().steps[1].evidence.action, 'searchForEntity');
        assert.equal(manager.getCurrentPlan().steps[1].evidence.item, undefined);

        const update = manager.observeOutcome(outcome(agent, {
            action: 'goToRememberedPlace',
            params: { name: 'home' },
            status: 'success',
            relevantProgress: true,
        }));
        assert.equal(update.advanced, true);
        assert.equal(manager.getCurrentStep().id, 'look');
        assert.equal(manager.getCurrentPlan().steps[0].status, 'completed');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('placing one block is verified by that action, even if the model asked for an unrelated item', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, root);
        manager.applyProposal({
            objective: 'Place one flower beside the house',
            rationale: 'A held flower can be placed at my feet.',
            steps: [
                {
                    id: 'plant',
                    description: 'Place a dandelion beside my house',
                    action: { name: 'placeHere', params: { type: 'dandelion' } },
                    evidence: { type: 'inventory_min', item: 'oak_log', count: 1 },
                },
                {
                    id: 'look',
                    description: 'Look at the spot',
                    action: { name: 'searchForBlock', params: { type: 'dandelion', search_range: 32 } },
                    evidence: { type: 'verified_action', action: 'searchForBlock', params: { type: 'dandelion', search_range: 32 } },
                },
            ],
        });
        assert.equal(manager.getCurrentStep().evidence.type, 'verified_action');
        assert.equal(manager.getCurrentStep().evidence.action, 'placeHere');
        assert.equal(manager.getCurrentStep().evidence.item, undefined);
        const update = manager.observeOutcome(outcome(agent, {
            action: 'placeHere',
            params: { type: 'dandelion' },
            status: 'success',
            relevantProgress: true,
        }));
        assert.equal(update.advanced, true);
        assert.equal(manager.getCurrentStep().id, 'look');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an empty planning response is retried once and does not drop an existing plan', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, root);
        manager.applyProposal(proposal());
        const calls = [];
        agent.prompter = {
            async promptPlanning(_reason, _previous, feedback) {
                calls.push(feedback);
                return null;
            },
        };
        const result = await manager._requestPlan('objective_changed');
        assert.equal(calls.length, 2);
        assert.equal(calls[0], null);
        assert.match(calls[1].join(' '), /JSON object/);
        assert.equal(result.status, 'active');
        assert.equal(result.objective, proposal().objective);
        assert.equal(manager.getCurrentPlan().status, 'active');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('planning is requested only at a plan boundary', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const agent = makeAgent();
        let requests = 0;
        agent.prompter = {
            async promptPlanning(reason) {
                requests++;
                assert.equal(reason, 'no_active_plan');
                return proposal();
            },
        };
        const manager = new PlanManager(agent, root);
        agent.plan_manager = manager;

        await manager.ensurePlan();
        await manager.ensurePlan();

        assert.equal(requests, 1);
        assert.equal(manager.getCurrentStep().id, 'gather_coal');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
