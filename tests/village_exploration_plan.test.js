import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import settings, { setSettings } from '../src/agent/settings.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { createActionOutcome, observationSuccess } from '../src/agent/action_outcome.js';
import { executeCommand } from '../src/agent/commands/index.js';
import { PlanManager } from '../src/agent/plan_manager.js';
import { checkProposalFeasibility } from '../src/agent/plan_feasibility.js';
import { villagePlanningSystem } from '../src/models/prompter.js';
import { completedPlanLines, observationPlanCannotFinish, prepareVillageTurn } from '../src/village/goals.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

initializeMinecraftData('1.21.6');
const registry = minecraftData('1.21.6');

function step(id, name, params, description = id) {
    return { id, description, action: { name, params } };
}

function proposal(steps) {
    return { objective: 'Explore the square and its surroundings.', steps };
}

test('an exploration plan may look around and may not invent a block or entity', () => {
    const look = checkProposalFeasibility({}, proposal([
        step('go', 'goToCoordinates', { x: -460, y: 72, z: -715, closeness: 2 }),
        step('look', 'nearbyBlocks', {}),
        step('who', 'entities', {}),
    ]));
    assert.equal(look.ok, true, look.problems.join(' | '));

    const invented = checkProposalFeasibility({}, proposal([
        step('search', 'searchForBlock', { type: 'interesting_object', search_range: 10 }),
        step('take', 'collectBlocks', { type: 'interesting_object', num: 1 }),
    ]));
    assert.equal(invented.ok, false);
    assert.match(invented.problems.join('\n'), /not a valid block name/);
    assert.match(invented.problems.join('\n'), /observe with !nearbyBlocks\(\)/);

    const creature = checkProposalFeasibility({}, proposal([
        step('hunt', 'searchForEntity', { type: 'interesting_creature', search_range: 32 }),
    ]));
    assert.equal(creature.ok, false);
    assert.match(creature.problems.join('\n'), /not a known entity/);
});

test('the village planning prompt allows a partial look and forbids invented names', () => {
    const prompt = villagePlanningSystem({
        name: 'Cass',
        goal: 'Explore the square and its surroundings to discover new places and collect interesting objects.',
        known: 'Public place square at -460, 72, -715.',
        context: 'AVAILABLE ACTION COMMANDS\n!nearbyBlocks()',
    });
    assert.match(prompt, /does not have to achieve the whole goal/);
    assert.match(prompt, /does not visit another place/);
    assert.match(prompt, /nearbyBlocks/);
    assert.match(prompt, /Do not invent a placeholder name|Do not name a block, item, or entity/);
    assert.doesNotMatch(prompt, /interesting_object/);
    assert.doesNotMatch(prompt, /"type":"oak_log"/);
});

test('a rejected village plan is told that a shorter look is valid', () => {
    const previous = { ...settings };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'explore-plan-'));
    try {
        setSettings({ ...previous, village_autonomy: true, agent_data_root: '' });
        const manager = new PlanManager({ name: 'Cass', prompter: { profile: { persistent_planning: false } } }, dir);
        const correction = manager.planningContext(['step search: !searchForBlock parameter "type" ("interesting_object") is not a valid block name.']);
        assert.match(correction, /A shorter plan is valid/);
        assert.match(correction, /!nearbyBlocks\(\)/);
        assert.match(correction, /Do not invent a block, item, or entity name/);
        setSettings({ ...previous, village_autonomy: false, agent_data_root: '' });
        const survival = new PlanManager({ name: 'Sawyer', prompter: { profile: { persistent_planning: false } } }, dir);
        assert.doesNotMatch(survival.planningContext(['step search failed']), /A shorter plan is valid/);
    } finally {
        setSettings(previous);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('two rejected plans keep the goal and wait instead of asking for another task', async () => {
    const previous = { ...settings };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'explore-wait-'));
    try {
        setSettings({ ...previous, village_autonomy: true, agent_data_root: dir, persistent_planning: true });
        const agent = {
            name: 'Cass',
            prompter: {
                profile: { persistent_planning: true },
                promptPlanning: async () => proposal([
                    step('search', 'searchForBlock', { type: 'interesting_object', search_range: 10 }),
                ]),
            },
        };
        const manager = new PlanManager(agent, dir);
        agent.plan_manager = manager;
        const kept = await manager._requestPlan('no_active_plan');
        assert.equal(kept, null);
        assert.ok(manager.nextPlanningAllowedAt > Date.now());
        writeFileSync(path.join(dir, 'intentions.json'), JSON.stringify({
            schema_version: 1,
            active: { id: 'int-1', text: 'Explore the square and its surroundings.', status: 'active' },
            milestone_review: { at: '2026-11-16T00:00:00.000Z', decision: 'selected', prior_text: '' },
            history: [],
        }));
        writeFileSync(path.join(dir, 'ambitions.json'), JSON.stringify({
            schema_version: 1,
            active: { text: 'Discover the world beyond the village.', status: 'active' },
        }));
        const turn = await prepareVillageTurn({
            name: 'Cass',
            bot: { time: { timeOfDay: 6000 }, inventory: { items: () => [] } },
            plan_manager: manager,
        });
        assert.equal(turn.planHold, true);
        assert.equal(turn.goal, 'Explore the square and its surroundings.');
        assert.equal(turn.step, '');
    } finally {
        setSettings(previous);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an observation step completes from what was actually seen', () => {
    const previous = { ...settings };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'explore-see-'));
    try {
        setSettings({ ...previous, agent_data_root: '', village_autonomy: true, persistent_planning: true });
        const bot = { inventory: { slots: Array(46).fill(null) }, entity: { position: new Vec3(0, 64, 0) } };
        const agent = { name: 'Cass', bot, prompter: { profile: { persistent_planning: true } } };
        const manager = new PlanManager(agent, dir);
        manager.applyProposal(proposal([
            step('look', 'nearbyBlocks', {}, 'Look at the square'),
        ]), 'agent_choice');
        const outcome = observationSuccess('nearbyBlocks', 'NEARBY_BLOCKS\n- lantern\n- oak_door', bot);
        const update = manager.observeOutcome(outcome);
        assert.equal(update.completed, true);
        const plan = manager.getCurrentPlan();
        assert.match(plan.steps[0].lastOutcome.observation, /lantern/);
        assert.match(completedPlanLines(plan), /Observed:.*lantern/);
    } finally {
        setSettings(previous);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('travel and observation do not close the goal when the model calls them achieved', async () => {
    const previous = { ...settings };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'explore-follow-'));
    const goal = 'Explore the square and its surroundings to discover new places and collect interesting objects';
    try {
        setSettings({ ...previous, village_autonomy: true, agent_data_root: dir, persistent_planning: true });
        writeFileSync(path.join(dir, 'intentions.json'), JSON.stringify({
            schema_version: 1,
            active: { id: 'int-1', text: goal, status: 'active' },
            milestone_review: { at: '2026-11-16T00:00:00.000Z', decision: 'selected', prior_text: '' },
            history: [],
        }));
        writeFileSync(path.join(dir, 'ambitions.json'), JSON.stringify({
            schema_version: 1,
            active: { text: 'Discover the world beyond the village.', status: 'active' },
        }));
        const bot = {
            inventory: { slots: Array(46).fill(null), items: () => [] },
            entity: { position: new Vec3(-460, 72, -715) },
            time: { timeOfDay: 6000 },
        };
        const agent = {
            name: 'Cass',
            bot,
            prompter: {
                profile: { persistent_planning: true },
                promptPlanning: async () => null,
                chat_model: {
                    async complete() {
                        return {
                            content: '{"decision":"achieved","goal":null,"note":"Interesting objects were collected."}',
                            done_reason: 'stop',
                        };
                    },
                },
            },
        };
        const manager = new PlanManager(agent, dir);
        agent.plan_manager = manager;
        manager.applyProposal(proposal([
            step('go', 'goToCoordinates', { x: -460, y: 72, z: -715, closeness: 2 }, 'Travel to the square'),
            step('look', 'nearbyBlocks', {}, 'Observe the square'),
        ]), 'agent_choice');
        manager.observeOutcome(createActionOutcome({
            action: 'goToCoordinates',
            params: { x: -460, y: 72, z: -715, closeness: 2 },
            status: 'success',
            relevantProgress: true,
            bot,
        }));
        manager.observeOutcome(observationSuccess('nearbyBlocks', 'NEARBY_BLOCKS - bell - copper_ore - lantern', bot));
        assert.equal(observationPlanCannotFinish(manager.getCurrentPlan()), true);
        const turn = await prepareVillageTurn(agent);
        assert.equal(manager.getCurrentPlan().goalDecision, 'follow_up');
        assert.equal(turn.goal, goal);
    } finally {
        setSettings(previous);
        rmSync(dir, { recursive: true, force: true });
    }
});

function itemStack(name, count, slot) {
    const data = registry.itemsByName[name];
    return { name, count, slot, type: data.id, stackSize: data.stackSize };
}

test('a missing crafting table stays blocking until a table is actually nearby', async () => {
    const blocks = new Map();
    const bot = {
        output: '',
        interrupt_code: false,
        entity: { position: new Vec3(0, 64, 0) },
        registry,
        inventory: {
            inventoryStart: 9,
            slots: Array(46).fill(null),
            items() { return this.slots.filter(Boolean); },
        },
        recipesFor: () => [],
        blockAt: position => blocks.get(`${position.x},${position.y},${position.z}`) || { name: 'air', type: 0, position },
        findBlocks({ matching, maxDistance = 16, count = 1 }) {
            const ids = new Set(Array.isArray(matching) ? matching : [matching]);
            const found = [];
            for (const block of blocks.values()) {
                if (!ids.has(block.type)) continue;
                if (bot.entity.position.distanceTo(block.position) > maxDistance) continue;
                found.push(block.position);
            }
            found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
            return found.slice(0, count);
        },
        emit() {},
    };
    bot.inventory.slots[9] = itemStack('cobblestone', 2, 9);
    const agent = {
        name: 'Cass',
        bot,
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        requestInterrupt() { bot.interrupt_code = true; },
    };
    agent.actions = new ActionManager(agent);

    const first = await executeCommand(agent, '!craftRecipe("stone_axe", 1)');
    const outcome = agent.actions.getLastOutcome();
    assert.equal(outcome.reason.code, 'missing_workstation');
    assert.equal(outcome.retry.relevantState.workstation, 'crafting_table');
    assert.match(first, /within 16 blocks/);
    assert.ok(agent.actions.retryBlock('craftRecipe', { recipe_name: 'stone_axe', num: 1 }));

    bot.inventory.slots[10] = itemStack('oak_log', 8, 10);
    assert.ok(
        agent.actions.retryBlock('craftRecipe', { recipe_name: 'stone_axe', num: 1 }),
        'gathering logs does not supply the missing table'
    );

    const table = registry.blocksByName.crafting_table;
    blocks.set('2,64,0', { name: 'crafting_table', type: table.id, position: new Vec3(2, 64, 0) });
    assert.equal(agent.actions.retryBlock('craftRecipe', { recipe_name: 'stone_axe', num: 1 }), null);
});
