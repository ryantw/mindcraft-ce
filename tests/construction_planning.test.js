import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/agent/plan_manager.js';
import { setSettings } from '../src/agent/settings.js';
import { constructionCapabilities } from '../src/agent/plan_feasibility.js';
import { analyzeConstruction } from '../src/agent/plan_geometry.js';
import { createActionOutcome, inventorySnapshot } from '../src/agent/action_outcome.js';

function makeAgent(counts = {}, { blocked = [] } = {}) {
    const slots = Array(46).fill(null);
    Object.entries(counts).forEach(([name, count], index) => { slots[9 + index] = { name, count, slot: 9 + index }; });
    return {
        name: 'Sawyer',
        blocked_actions: blocked,
        bot: {
            inventory: { inventoryStart: 9, slots },
            entity: { position: { x: 10.4, y: 64, z: -3.2 } },
            blockAt: () => ({ name: 'air' }),
        },
        prompter: { profile: { persistent_planning: true } },
        self_prompter: { prompt: 'Live independently.' },
        history: { memory: '' },
    };
}

let dir;
beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-build-plan-'));
    setSettings({});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const step = (id, name, params, extra = {}) => ({ id, description: `${name} step`, action: { name, params }, ...extra });
const plane = (id, type, x1, y1, z1, x2, y2, z2) => step(id, 'buildPlane', { type, x1, y1, z1, x2, y2, z2 }, { description: `Build a wall of ${type}` });

// An agent-chosen design: its own dimensions, material and location.
const wallsAndRoof = () => [
    plane('north', 'cobblestone', 0, 64, 0, 4, 66, 0),
    plane('south', 'cobblestone', 0, 64, 4, 4, 66, 4),
    plane('west', 'cobblestone', 0, 64, 1, 0, 66, 3),
    plane('east', 'cobblestone', 4, 64, 1, 4, 66, 3),
    plane('roof', 'cobblestone', 0, 67, 0, 4, 67, 4),
];
const sufficientShelter = () => ({
    objective: 'Build a 5x5 cobblestone shelter with a roof',
    materials: [{ item: 'cobblestone', count: 15 + 15 + 9 + 9 + 25 }],
    steps: [
        step('gather', 'collectBlocks', { type: 'stone', num: 64 }),
        ...wallsAndRoof(),
    ],
});

describe('build plans are validated against what the build commands can do', () => {
    test('a concrete, sufficiently-supplied build plan is executable and skips redundant gathering', () => {
        const agent = makeAgent({ cobblestone: 300, oak_log: 80 });
        const manager = new PlanManager(agent, dir);
        assert.deepEqual(manager.validateProposal(sufficientShelter()), []);

        manager.applyProposal(sufficientShelter());
        const plan = manager.getCurrentPlan();
        assert.equal(plan.steps[0].status, 'skipped');
        assert.match(plan.steps[0].skipReason, /cobblestone: need 73, already have 300/);
        assert.equal(manager.getCurrentStep().id, 'north');
        assert.match(manager.formatForPrompt(), /cobblestone: need 73, have 300 -> AVAILABLE \(surplus 227\); no gathering needed/);
    });

    test('a structure claim needs concrete build steps, not just gathering', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 300 }), dir);
        const problems = manager.validateProposal({
            objective: 'Build a shelter near the river',
            steps: [step('gather', 'collectBlocks', { type: 'oak_log', num: 8 })],
        }).join('\n');
        assert.match(problems, /claims to build a structure .* no step uses a construction command/);
    });

    test('placing one flower beside the house is not a structure', () => {
        const manager = new PlanManager(makeAgent(), dir);
        const problems = manager.validateProposal({
            objective: 'Begin planting flowers in the garden beside my house',
            steps: [step('plant', 'placeHere', { type: 'dandelion' }, { description: 'Place a dandelion beside my house' })],
        });
        assert.deepEqual(problems, []);
    });

    test('!placeHere cannot stand in for walls', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 300 }), dir);
        const problems = manager.validateProposal({
            objective: 'Build a hut',
            materials: [{ item: 'cobblestone', count: 8 }],
            steps: [step('walls', 'placeHere', { type: 'cobblestone' }, { description: 'Place walls around me' }), ...wallsAndRoof().slice(0, 1)],
        }).join('\n');
        assert.match(problems, /uses !placeHere for part of a structure/);
    });

    test('construction material requirements are derived instead of trusting model estimates', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 300 }), dir);
        const none = { objective: 'Build a wall', steps: wallsAndRoof().slice(0, 1) };
        assert.deepEqual(manager.validateProposal(none), []);
        manager.applyProposal(none);
        assert.deepEqual(manager.getCurrentPlan().materials, [{ item: 'cobblestone', count: 15 }]);

        const shortManager = new PlanManager(makeAgent({ cobblestone: 300 }), `${dir}-short`);
        const short = { objective: 'Build a wall', materials: [{ item: 'cobblestone', count: 10 }], steps: wallsAndRoof().slice(0, 1) };
        assert.deepEqual(shortManager.validateProposal(short), []);
        shortManager.applyProposal(short);
        assert.deepEqual(shortManager.getCurrentPlan().materials, [{ item: 'cobblestone', count: 15 }]);
    });

    test('dimensions that cannot be built are rejected at planning time', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 900 }), dir);
        const run = steps => manager.validateProposal({ objective: 'Raise a wall', materials: [{ item: 'cobblestone', count: 500 }], steps }).join('\n');
        assert.match(run([plane('big', 'cobblestone', 0, 64, 0, 20, 64, 20)]), /at most 100 blocks/);
        assert.match(run([plane('box', 'cobblestone', 0, 64, 0, 3, 66, 3)]), /flat/);
        assert.match(run([step('diag', 'buildLine', { type: 'cobblestone', x1: 0, y1: 64, z1: 0, x2: 3, y2: 64, z2: 3 })]), /axis-aligned/);
        assert.match(run([plane('slab', 'oak_slab', 0, 64, 0, 3, 64, 0)]), /not a full solid block/);
        assert.match(run([step('coords', 'buildLine', { type: 'cobblestone', x1: 0, y1: 64, z1: 0 })]), /requires parameter "x2"/);
    });

    test('a needed material that is not held must be obtained by some step', () => {
        const manager = new PlanManager(makeAgent({ oak_planks: 4, oak_log: 3 }), dir);
        const buildOnly = {
            objective: 'Build a floor',
            materials: [{ item: 'oak_planks', count: 20 }],
            steps: [plane('floor', 'oak_planks', 0, 63, 0, 3, 63, 4)],
        };
        assert.match(manager.validateProposal(buildOnly).join('\n'), /no step obtains the 16 you are short/);

        const withSupply = {
            ...buildOnly,
            steps: [
                step('logs', 'collectBlocks', { type: 'oak_log', num: 4 }),
                step('craft', 'craftRecipe', { recipe_name: 'oak_planks', num: 16 }),
                buildOnly.steps[0],
            ],
        };
        assert.deepEqual(manager.validateProposal(withSupply), []);
    });

    test('sufficient materials held as logs still need the craft step, but never more gathering', () => {
        const manager = new PlanManager(makeAgent({ oak_log: 30 }), dir);
        const proposal = {
            objective: 'Build a floor',
            materials: [{ item: 'oak_planks', count: 20 }],
            steps: [
                step('logs', 'collectBlocks', { type: 'oak_log', num: 8 }),
                step('craft', 'craftRecipe', { recipe_name: 'oak_planks', num: 20 }),
                plane('floor', 'oak_planks', 0, 63, 0, 3, 63, 4),
            ],
        };
        assert.deepEqual(manager.validateProposal(proposal), []);
        const text = manager.planningContext();
        assert.match(text, /Materials you already hold \(or can craft from what you hold\) need NO gathering step/);
    });

    test('blocking the construction commands makes structure plans infeasible again', () => {
        const agent = makeAgent({ cobblestone: 300 }, { blocked: ['!placeBlockAt', '!buildLine', '!buildPlane'] });
        const manager = new PlanManager(agent, dir);
        assert.equal(constructionCapabilities(agent).canBuildStructures, false);
        assert.match(manager.validateProposal(sufficientShelter()).join('\n'), /unknown command !buildPlane|not available to you/);
    });
});

describe('live malformed construction plans are rejected semantically', () => {
    test('Jasper cannot satisfy floor, walls, and roof with the same single block', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 64, chest: 1 }), dir);
        const point = (id, description) => step(id, 'buildPlane', {
            type: 'cobblestone', x1: 1250, y1: 68, z1: 752, x2: 1250, y2: 68, z2: 752,
        }, { description });
        const proposal = {
            objective: 'Build a secure shelter with a chest for storage',
            materials: [{ item: 'cobblestone', count: 64 }, { item: 'chest', count: 1 }],
            steps: [
                point('floor', 'Build the shelter floor'),
                point('walls', 'Build the shelter walls'),
                point('roof', 'Build the shelter roof'),
                step('chest', 'placeHere', { type: 'chest' }, { description: 'Place a storage chest' }),
            ],
        };
        const problems = manager.validateProposal(proposal).join('\n');
        assert.match(problems, /Floor\/base geometry must form a horizontal area/);
        assert.match(problems, /Wall geometry must form a vertical area/);
        assert.match(problems, /Roof geometry must form a horizontal overhead area/);
        assert.match(problems, /reuse the same geometry/);
        assert.match(problems, /do not form a functional shelter/);
        assert.throws(() => manager.applyProposal(proposal), /Plan is not executable/);

        manager.state.current = {
            ...proposal,
            id: 'jasper_live_plan',
            status: 'completed',
            currentStepId: null,
            steps: proposal.steps.map(existing => ({ ...existing, status: 'completed' })),
        };
        manager.loadedPlanNeedsValidation = true;
        manager._revalidateLoadedPlan();
        assert.equal(manager.getCurrentPlan().status, 'invalidated');
        assert.equal(manager.getCurrentPlan().id, 'jasper_live_plan');
        assert.match(manager.getCurrentPlan().invalidationReason, /semantic validation/);
    });

    test('Sawyer cannot use three positions, a flat wall, and a solid overlapping door as a shelter', () => {
        const proposal = {
            objective: 'Build a secure shelter',
            materials: [{ item: 'cobblestone', count: 64 }],
            steps: [
                plane('base', 'cobblestone', 1211, 64, 687, 1211, 64, 687),
                plane('walls', 'cobblestone', 1210, 64, 687, 1212, 64, 687),
                step('door', 'placeBlockAt', { type: 'cobblestone', x: 1211, y: 64, z: 687 }, { description: 'Place the shelter door' }),
            ],
        };
        const manager = new PlanManager(makeAgent({ cobblestone: 62 }), dir);
        const problems = manager.validateProposal(proposal).join('\n');
        assert.match(problems, /Floor\/base geometry/);
        assert.match(problems, /Wall geometry must form a vertical area/);
        assert.match(problems, /door\/opening but places solid cobblestone/);
        assert.match(problems, /reuse the same geometry/);
        assert.deepEqual(analyzeConstruction(manager.agent, proposal).materials, [{ item: 'cobblestone', count: 3 }]);
    });

    test('Finn cannot label horizontal intersecting lines at one elevation as floor and walls', () => {
        const proposal = {
            objective: 'Build a secure shelter with a floor and walls',
            materials: [{ item: 'cobblestone', count: 64 }, { item: 'oak_planks', count: 13 }],
            steps: [
                plane('floor', 'oak_planks', 1220, 65, 719, 1220, 65, 723),
                plane('walls', 'cobblestone', 1220, 65, 719, 1224, 65, 719),
            ],
        };
        const problems = new PlanManager(makeAgent({ cobblestone: 64, oak_planks: 13 }), dir)
            .validateProposal(proposal).join('\n');
        assert.match(problems, /Floor\/base geometry/);
        assert.match(problems, /Wall geometry must form a vertical area/);
        assert.match(problems, /do not form a functional shelter/);
    });

    test('Rowan 4x4 floor needs 16 planks and navigation uses position evidence', () => {
        const agent = makeAgent({ acacia_planks: 44, acacia_log: 59 });
        const manager = new PlanManager(agent, dir);
        const proposal = {
            objective: 'Construct a secure base floor',
            materials: [{ item: 'acacia_planks', count: 64 }],
            steps: [
                step('navigate', 'goToCoordinates', { x: 1345, y: 63, z: 642, closeness: 5 }, {
                    evidence: { type: 'block_nearby', block: 'acacia_planks', radius: 10 },
                }),
                plane('floor', 'acacia_planks', 1345, 63, 642, 1348, 63, 645),
            ],
        };
        assert.deepEqual(manager.validateProposal(proposal), []);
        manager.applyProposal(proposal);
        assert.deepEqual(manager.getCurrentPlan().materials, [{ item: 'acacia_planks', count: 16 }]);
        assert.equal(manager.getCurrentPlan().steps[0].evidence.type, 'position_near');
        assert.deepEqual(manager.getCurrentPlan().steps[1].requires, [{ item: 'acacia_planks', count: 16 }]);
        assert.equal(manager.getCurrentStep().id, 'navigate');
    });

    test('already-satisfied coordinates and overlapping build requests are counted once', () => {
        const agent = makeAgent({ oak_planks: 20 });
        const satisfied = new Set(['0,63,0', '0,63,1']);
        agent.bot.blockAt = position => ({ name: satisfied.has(`${position.x},${position.y},${position.z}`) ? 'oak_planks' : 'air' });
        const proposal = {
            objective: 'Build a floor',
            materials: [{ item: 'oak_planks', count: 64 }],
            steps: [
                plane('floor_a', 'oak_planks', 0, 63, 0, 3, 63, 3),
                plane('floor_b', 'oak_planks', 0, 63, 0, 3, 63, 3),
            ],
        };
        const analysis = analyzeConstruction(agent, proposal);
        assert.deepEqual(analysis.materials, [{ item: 'oak_planks', count: 14 }]);
        assert.deepEqual(analysis.stepRequirements.get(0), [{ item: 'oak_planks', count: 14 }]);
        assert.deepEqual(analysis.stepRequirements.get(1), []);
    });

    test('Sawyer-style inflated gathering is skipped when live inventory covers unique targets', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 62 }), dir);
        const proposal = {
            objective: 'Place three cobblestone boundary markers',
            materials: [{ item: 'cobblestone', count: 64 }],
            steps: [
                step('gather_missing_cobblestone', 'collectBlocks', { type: 'cobblestone', num: 19 }, {
                    evidence: { type: 'inventory_min', item: 'cobblestone', count: 64 },
                }),
                step('markers', 'buildLine', {
                    type: 'cobblestone', x1: 1210, y1: 64, z1: 687, x2: 1212, y2: 64, z2: 687,
                }),
            ],
        };
        assert.deepEqual(manager.validateProposal(proposal), []);
        manager.applyProposal(proposal);
        assert.deepEqual(manager.getCurrentPlan().materials, [{ item: 'cobblestone', count: 3 }]);
        assert.equal(manager.getCurrentPlan().steps[0].status, 'skipped');
        assert.match(manager.getCurrentPlan().steps[0].skipReason, /need 3, already have 62/);
    });

    test('gathering quantity is clamped to the actual live construction deficit', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 2 }), dir);
        const proposal = {
            objective: 'Build a small freestanding wall',
            materials: [{ item: 'cobblestone', count: 64 }],
            steps: [
                step('gather', 'collectBlocks', { type: 'cobblestone', num: 40 }, {
                    evidence: { type: 'inventory_min', item: 'cobblestone', count: 64 },
                }),
                plane('wall', 'cobblestone', 0, 64, 0, 1, 65, 0),
            ],
        };
        assert.deepEqual(manager.validateProposal(proposal), []);
        manager.applyProposal(proposal);
        assert.equal(manager.getCurrentPlan().materials[0].count, 4);
        assert.equal(manager.getCurrentStep().action.params.num, 2);
        assert.equal(manager.getCurrentStep().evidence.count, 4);
    });
});

describe('planner context describes the real construction tools', () => {
    test('lists signatures and limits, states the position, and assigns no design', () => {
        const manager = new PlanManager(makeAgent({ cobblestone: 5 }), dir);
        const context = manager.planningContext();
        assert.match(context, /YOUR POSITION: 10, 64, -4/);
        assert.match(context, /!placeBlockAt\(type:string, x:number, y:number, z:number\)/);
        assert.match(context, /!buildLine\(type:string, x1:number, y1:number, z1:number, x2:number, y2:number, z2:number\)/);
        assert.match(context, /!buildPlane\(type:string, x1:number/);
        assert.match(context, /at most 100 blocks, 32 per side/);
        assert.match(context, /You choose what to build, its dimensions, materials and location/);
        assert.match(context, /never break or replace existing blocks/);
        assert.doesNotMatch(context, /CANNOT currently construct/);
        assert.doesNotMatch(context, /5x5|shelter of|house design|blueprint/i);
        assert.doesNotMatch(context, /!newAction/);
    });
});

describe('build steps complete only on a verified full outcome', () => {
    function outcomeFor(agent, status, params) {
        const snapshot = inventorySnapshot(agent.bot);
        return createActionOutcome({
            action: 'buildPlane', params, status, before: snapshot, after: snapshot,
            relevantProgress: status !== 'failure', bot: agent.bot,
        });
    }

    test('a partial build does not advance the plan; a verified success does', () => {
        const agent = makeAgent({ cobblestone: 300 });
        const manager = new PlanManager(agent, dir);
        const proposal = { ...sufficientShelter(), objective: 'Build two freestanding walls', steps: wallsAndRoof().slice(0, 2) };
        manager.applyProposal(proposal);
        const params = manager.getCurrentStep().action.params;

        assert.equal(manager.observeOutcome(outcomeFor(agent, 'partial', params)).advanced, false);
        assert.equal(manager.getCurrentStep().id, 'north');

        assert.equal(manager.observeOutcome(outcomeFor(agent, 'success', params)).advanced, true);
        assert.equal(manager.getCurrentStep().id, 'south');
    });
});
