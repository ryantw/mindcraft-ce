import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/agent/plan_manager.js';
import { setSettings } from '../src/agent/settings.js';
import { getCommandDocs } from '../src/agent/commands/index.js';
import { constructionCapabilities } from '../src/agent/plan_feasibility.js';
import { describeLedger, materialLedger, normalizeMaterials } from '../src/agent/plan_resources.js';

function inventorySlots(counts = {}) {
    const slots = Array(46).fill(null);
    let index = 9;
    for (const [name, count] of Object.entries(counts)) {
        slots[index] = { name, count, slot: index };
        index++;
    }
    return slots;
}

function makeAgent(name, { counts = {}, profile = {}, blocked = [] } = {}) {
    const requests = [];
    const agent = {
        name,
        blocked_actions: blocked,
        bot: {
            inventory: { inventoryStart: 9, slots: inventorySlots(counts) },
            entity: { position: { x: 0, y: 64, z: 0 } },
            blockAt: () => ({ name: 'air' }),
        },
        prompter: {
            profile,
            requests,
            responses: [],
            async promptPlanning(reason, previous, feedback) {
                requests.push({ reason, feedback });
                return this.responses.shift() ?? null;
            },
        },
        self_prompter: { prompt: 'Live independently.' },
        history: { memory: '' },
    };
    return agent;
}

let dir;
beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-per-agent-'));
    setSettings({});
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setSettings({});
});

const step = (id, name, params, evidence) => ({
    id, description: `${name} step`, action: { name, params }, evidence,
});

const craftChestProposal = {
    objective: 'Craft and place a chest to organize storage',
    steps: [
        step('planks', 'craftRecipe', { recipe_name: 'chest', num: 1 }),
        step('place', 'placeHere', { type: 'chest' }),
    ],
};

const NO_BUILD_COMMANDS = ['!placeBlockAt', '!buildLine', '!buildPlane'];

const shelterProposal = {
    objective: 'Build a 5x5 shelter with walls and a roof',
    steps: [
        step('walls', 'placeHere', { type: 'cobblestone' }),
        { id: 'roof', description: 'Build the roof over the walls', action: { name: 'placeHere', params: { type: 'oak_planks' } } },
    ],
};

describe('planning is enabled per agent', () => {
    test("only an agent whose profile opts in plans; others keep autonomous behavior and touch nothing", async () => {
        setSettings({ persistent_planning: false });
        const sawyer = makeAgent('Sawyer', { profile: { persistent_planning: true } });
        const finn = makeAgent('Finn', { profile: {} });
        const sawyerPlans = new PlanManager(sawyer, dir);
        const finnPlans = new PlanManager(finn, dir);
        sawyer.plan_manager = sawyerPlans;
        finn.plan_manager = finnPlans;

        assert.equal(sawyerPlans.enabled, true);
        assert.equal(finnPlans.enabled, false);

        sawyer.prompter.responses.push(craftChestProposal);
        assert.ok(await sawyerPlans.ensurePlan());
        assert.equal(await finnPlans.ensurePlan(), null);

        assert.equal(sawyer.prompter.requests.length, 1);
        assert.equal(finn.prompter.requests.length, 0);
        assert.equal(existsSync(path.join(dir, 'Sawyer', 'plan.json')), true);
        assert.equal(existsSync(path.join(dir, 'Finn')), false);
        assert.equal(finnPlans.formatForPrompt(), '');
        assert.match(sawyerPlans.formatForPrompt(), /PERSISTENT PLAN/);
        assert.doesNotMatch(getCommandDocs(finn), /!reconsiderPlan/);
        assert.match(getCommandDocs(sawyer), /!reconsiderPlan/);
    });

    test('an explicit profile false overrides a global true, and a profile without the key follows the global setting', () => {
        setSettings({ persistent_planning: true });
        assert.equal(new PlanManager(makeAgent('Milo', { profile: { persistent_planning: false } }), dir).enabled, false);
        assert.equal(new PlanManager(makeAgent('Rowan', { profile: {} }), dir).enabled, true);
        assert.equal(new PlanManager({ ...makeAgent('Jasper'), prompter: undefined }, dir).enabled, true);
    });

    test('the opt-in preserves an existing plan file and does not assign an objective', async () => {
        const sawyer = makeAgent('Sawyer', { profile: { persistent_planning: true } });
        const manager = new PlanManager(sawyer, dir);
        assert.equal(manager.getCurrentPlan(), null);
        sawyer.prompter.responses.push(craftChestProposal);
        await manager.ensurePlan();
        // The objective is whatever the agent proposed, never injected by code.
        assert.equal(manager.getCurrentPlan().objective, craftChestProposal.objective);
        // The planner context states limits, never an objective to pursue.
        assert.doesNotMatch(manager.planningContext(), /your (objective|goal) is|you should (build|make|construct)|build a /i);
    });
});

describe('resource sufficiency', () => {
    test('materials already held are reported as available, with no gathering needed', () => {
        const ledger = materialLedger(
            normalizeMaterials([{ item: 'cobblestone', count: 64 }, { item: 'oak_planks', count: 40 }]),
            { cobblestone: 300, oak_planks: 90 }
        );
        assert.deepEqual(ledger.map(entry => entry.status), ['available', 'available']);
        const text = describeLedger(ledger).join('\n');
        assert.match(text, /cobblestone: need 64, have 300 -> AVAILABLE \(surplus 236\); no gathering needed/);
    });

    test('a shortfall is distinguished from what is held, and logs make planks craftable', () => {
        const [planks, torches] = materialLedger(
            normalizeMaterials([{ item: 'oak_planks', count: 10 }, { item: 'iron_ingot', count: 5 }]),
            { oak_planks: 4, oak_log: 3 }
        );
        assert.equal(planks.status, 'craftable');
        assert.equal(planks.missing, 6);
        assert.deepEqual(planks.craft.ingredients, { oak_log: 2 });
        assert.equal(torches.status, 'missing');
        assert.equal(torches.missing, 5);
        assert.match(describeLedger([planks, torches]).join('\n'), /still MISSING 5/);
    });

    test('one held log is not counted twice (as a log need and as planks)', () => {
        const ledger = materialLedger(
            normalizeMaterials([{ item: 'oak_log', count: 3 }, { item: 'oak_planks', count: 8 }]),
            { oak_log: 3 }
        );
        assert.equal(ledger[0].status, 'available');
        assert.equal(ledger[1].status, 'missing');
    });

    test('unknown item names and non-positive counts are dropped', () => {
        assert.deepEqual(
            normalizeMaterials([{ item: 'unobtainium', count: 5 }, { item: 'stone', count: 0 }, { item: 'minecraft:stone', count: 9 }]),
            [{ item: 'stone', count: 9 }]
        );
        assert.deepEqual(normalizeMaterials({ cobblestone: 12, bogus: 3 }), [{ item: 'cobblestone', count: 12 }]);
    });

    test('gathering steps for sufficient materials are skipped when the plan is applied', () => {
        const agent = makeAgent('Sawyer', { counts: { cobblestone: 300, oak_log: 80 }, profile: { persistent_planning: true } });
        const manager = new PlanManager(agent, dir);
        manager.applyProposal({
            objective: 'Craft a furnace and a chest',
            materials: [{ item: 'cobblestone', count: 8 }, { item: 'oak_log', count: 4 }],
            steps: [
                step('gather_stone', 'collectBlocks', { type: 'stone', num: 8 }),
                step('gather_wood', 'collectBlocks', { type: 'oak_log', num: 4 }),
                step('craft_furnace', 'craftRecipe', { recipe_name: 'furnace', num: 1 }),
            ],
        });
        const plan = manager.getCurrentPlan();
        assert.deepEqual(plan.steps.map(entry => entry.status), ['skipped', 'skipped', 'active']);
        assert.match(plan.steps[0].skipReason, /cobblestone: need 8, already have 300/);
        assert.equal(manager.getCurrentStep().id, 'craft_furnace');
        const prompt = manager.formatForPrompt();
        assert.match(prompt, /MATERIAL LEDGER/);
        assert.match(prompt, /\[skipped\] gather_stone/);
        assert.match(prompt, /not needed: cobblestone: need 8, already have 300/);
    });

    test('a step whose materials only become sufficient later is skipped on reconcile', () => {
        const agent = makeAgent('Sawyer', { counts: { cobblestone: 2 }, profile: { persistent_planning: true } });
        const manager = new PlanManager(agent, dir);
        manager.applyProposal({
            objective: 'Craft a furnace',
            materials: [{ item: 'cobblestone', count: 8 }],
            steps: [
                step('gather_stone', 'collectBlocks', { type: 'stone', num: 6 }, { type: 'verified_action', action: 'collectBlocks', params: { type: 'stone', num: 6 } }),
                step('craft_furnace', 'craftRecipe', { recipe_name: 'furnace', num: 1 }),
            ],
        });
        assert.equal(manager.getCurrentStep().id, 'gather_stone');
        agent.bot.inventory.slots[10] = { name: 'cobblestone', count: 20, slot: 10 };
        agent.bot.inventory.slots[9] = null;
        manager.reconcileObservedEvidence();
        assert.equal(manager.getCurrentStep().id, 'craft_furnace');
        assert.equal(manager.getCurrentPlan().steps[0].status, 'skipped');
    });

    test('a plan made entirely of redundant gathering is rejected with an explanation', () => {
        const agent = makeAgent('Sawyer', { counts: { cobblestone: 300 }, profile: { persistent_planning: true } });
        const manager = new PlanManager(agent, dir);
        const problems = manager.validateProposal({
            objective: 'Collect stone',
            materials: [{ item: 'cobblestone', count: 64 }],
            steps: [step('gather', 'collectBlocks', { type: 'stone', num: 64 })],
        });
        assert.ok(problems.some(problem => /already satisfies/.test(problem)));
    });
});

describe('construction and command feasibility', () => {
    const sawyer = () => makeAgent('Sawyer', { profile: { persistent_planning: true } });

    test('a structure plan built on single-block placement is rejected and pointed at the build commands', () => {
        const manager = new PlanManager(sawyer(), dir);
        const problems = manager.validateProposal(shelterProposal);
        assert.ok(problems.length >= 1);
        assert.match(problems.join('\n'), /!placeHere for part of a structure; !placeHere places a single block at your feet\. Use !buildPlane/);
    });

    test('with no build commands available, structure claims are rejected naming what remains', () => {
        const agent = makeAgent('Sawyer', { profile: { persistent_planning: true }, blocked: NO_BUILD_COMMANDS });
        const problems = new PlanManager(agent, dir).validateProposal(shelterProposal).join('\n');
        assert.match(problems, /no available command can build walls, floors, roofs or shelters/);
        assert.match(problems, /!placeHere: places ONE block at your current position only/);
    });

    test('executable single-item plans pass', () => {
        const manager = new PlanManager(sawyer(), dir);
        assert.deepEqual(manager.validateProposal(craftChestProposal), []);
    });

    test('gathering materials for a future shelter is allowed; claiming to build it is not', () => {
        const manager = new PlanManager(sawyer(), dir);
        assert.deepEqual(manager.validateProposal({
            objective: 'Gather wood and stone to prepare for a future shelter',
            steps: [step('wood', 'collectBlocks', { type: 'oak_log', num: 8 })],
        }), []);
        // Building is possible now, so a claim must come with concrete build steps.
        assert.match(manager.validateProposal({
            objective: 'Construct a house',
            steps: [step('wood', 'collectBlocks', { type: 'oak_log', num: 8 })],
        }).join('\n'), /claims to build a structure .* no step uses a construction command/);
    });

    test('unknown commands, bad parameters, meta commands and disabled newAction are rejected', () => {
        const manager = new PlanManager(sawyer(), dir);
        const run = steps => manager.validateProposal({ objective: 'Do something', steps }).join('\n');

        assert.match(run([step('a', 'buildHouse', {})]), /unknown command !buildHouse/);
        assert.match(run([step('a', 'collectBlocks', { block: 'stone', count: 3 })]), /no parameter "block"/);
        assert.match(run([step('a', 'collectBlocks', { type: 'stone' })]), /requires parameter "num"/);
        assert.match(run([step('a', 'collectBlocks', { type: 'not_a_block', num: 3 })]), /not a valid block name/);
        assert.match(run([{ id: 'a', description: 'think about it', action: { name: '', params: {} } }]), /names no command/);
        assert.match(run([step('a', 'think', { question: 'what next' })]), /not a world-changing action/);
        assert.match(run([step('a', 'newAction', { prompt: 'build a house' })]), /!newAction, which is disabled/);
    });

    test('generated-code execution stays disabled and is never advertised to the planner', () => {
        const agent = sawyer();
        const context = new PlanManager(agent, dir).planningContext();
        assert.doesNotMatch(context, /!newAction/);
        assert.match(context, /!collectBlocks\(type:string, num:number\)/);
        assert.match(context, /!buildPlane\(type:string, x1:number/);
        assert.deepEqual([...constructionCapabilities(agent).abilities].sort(), ['exact_block', 'fill_region', 'line', 'single_block_here']);
        assert.equal(constructionCapabilities(agent).canBuildStructures, true);
        const without = makeAgent('Sawyer', { profile: { persistent_planning: true }, blocked: NO_BUILD_COMMANDS });
        assert.match(new PlanManager(without, dir).planningContext(), /CANNOT currently construct walls, floors, roofs, shelters or houses/);
    });

    test('blocked commands are not usable plan steps or advertised capabilities', () => {
        const agent = makeAgent('Sawyer', { profile: { persistent_planning: true }, blocked: ['!placeHere', ...NO_BUILD_COMMANDS] });
        const manager = new PlanManager(agent, dir);
        assert.equal(constructionCapabilities(agent).available.length, 0);
        assert.match(manager.validateProposal(craftChestProposal).join('\n'), /!placeHere, which is not available to you/);
        assert.doesNotMatch(manager.planningContext(), /!placeHere\(/);
    });
});

describe('replanning is bounded and feedback-driven', () => {
    test('a rejected proposal is retried once with the reasons, then accepted', async () => {
        const agent = makeAgent('Sawyer', { profile: { persistent_planning: true } });
        const manager = new PlanManager(agent, dir);
        agent.plan_manager = manager;
        agent.prompter.responses.push(shelterProposal, craftChestProposal);

        const plan = await manager.ensurePlan();
        assert.equal(plan.objective, craftChestProposal.objective);
        assert.equal(agent.prompter.requests.length, 2);
        assert.equal(agent.prompter.requests[0].feedback, null);
        assert.match(agent.prompter.requests[1].feedback.join(' '), /!buildPlane/);
        assert.match(manager.planningContext(agent.prompter.requests[1].feedback), /YOUR PREVIOUS PROPOSAL WAS REJECTED/);
    });

    test('two rejections leave the agent autonomous and back off further model calls', async t => {
        const agent = makeAgent('Sawyer', { profile: { persistent_planning: true } });
        const manager = new PlanManager(agent, dir);
        agent.plan_manager = manager;
        agent.prompter.responses.push(shelterProposal, shelterProposal);
        const originalWarn = console.warn;
        console.warn = () => {};
        t.after(() => { console.warn = originalWarn; });

        assert.equal(await manager.ensurePlan(), null);
        assert.equal(agent.prompter.requests.length, 2);
        assert.equal(existsSync(path.join(dir, 'Sawyer', 'plan.json')), false);

        // Self-prompting calls ensurePlan every cycle: no extra requests during back-off.
        await manager.ensurePlan();
        await manager.ensurePlan();
        assert.equal(agent.prompter.requests.length, 2);

        setSettings({ planning_retry_ms: 0 });
        manager.nextPlanningAllowedAt = 0;
        agent.prompter.responses.push(craftChestProposal);
        assert.ok(await manager.ensurePlan());
        assert.equal(agent.prompter.requests.length, 3);
    });
});
