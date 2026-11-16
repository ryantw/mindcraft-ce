import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { activeAmbitionText, ensureSeededAmbition, readAmbitions, reviseAmbition } from '../src/village/ambitions.js';
import { applyGoalDecision, chooseCurrentGoal, finishedPlanNeedsReplan, goalEvaluationPrompt, goalSelectionPrompt, syncPlanToGoal } from '../src/village/goals.js';
import { decorativePlacementTarget, isGroundPlant } from '../src/agent/decorative_placement.js';
import { readIntentions } from '../src/village/intentions.js';
import { nextNightAction, nightPhase, autonomyPausedForNight, bedNeedsAnother, nightHomeFrom } from '../src/village/night.js';
import { villageDecisionMessage } from '../src/agent/startup_goal.js';
import { commitDream } from '../src/village/dream_commit.js';

const SEED = 'Discover unfamiliar places and come home to the people who matter.';

function tempLife() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'village-ambition-'));
    writeFileSync(path.join(root, 'identity.json'), JSON.stringify({
        name: 'Wynn',
        profile_checksum: 'sum',
        backstory: [{ id: 'spark', text: 'Wynn likes a path not yet walked.' }],
        temperament: ['curious'],
        interests: ['paths'],
    }));
    writeFileSync(path.join(root, 'life.json'), JSON.stringify({ schema_version: 1, lifecycle: 'alive' }));
    writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
        schema_version: 1, active: null, history: [{ id: 'int-0001', text: 'Look in the chest.', status: 'abandoned' }],
    }));
    return root;
}

describe('personal ambition and night sleep', () => {
    test('a seed is written once and does not replace a later ambition or the intention history', () => {
        const root = tempLife();
        try {
            const before = readFileSync(path.join(root, 'intentions.json'), 'utf8');
            const identity = readFileSync(path.join(root, 'identity.json'), 'utf8');
            assert.equal(ensureSeededAmbition(root, SEED, () => '2026-11-15T12:00:00.000Z').seeded, true);
            assert.equal(activeAmbitionText(readAmbitions(root)), SEED);
            const revised = reviseAmbition(root, 'Keep a garden people like to visit.', { source: 'day', now: () => '2026-11-15T13:00:00.000Z' });
            assert.equal(revised.ok, true);
            assert.equal(ensureSeededAmbition(root, 'A different assigned life.').seeded, false);
            assert.equal(activeAmbitionText(readAmbitions(root)), 'Keep a garden people like to visit.');
            assert.equal(readAmbitions(root).history.at(-1).text, SEED);
            assert.equal(readFileSync(path.join(root, 'intentions.json'), 'utf8'), before);
            assert.equal(readFileSync(path.join(root, 'identity.json'), 'utf8'), identity);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('goal selection uses the ambition and does not carry the command catalog', async () => {
        const root = tempLife();
        try {
            ensureSeededAmbition(root, SEED, () => '2026-11-15T12:00:00.000Z');
            const prompt = goalSelectionPrompt(root);
            assert.match(prompt, /Discover unfamiliar places/);
            assert.doesNotMatch(prompt, /COMMAND DOCS|!digDown|!collectBlocks/);
            const chosen = await chooseCurrentGoal(root, {
                complete: async () => '{"goal":"Walk the path north of home and notice what is unfamiliar."}',
                now: () => '2026-11-15T12:05:00.000Z',
            });
            assert.equal(chosen.chosen, true);
            assert.equal(readIntentions(root).active.text, 'Walk the path north of home and notice what is unfamiliar.');
            assert.equal(readIntentions(root).history[0].text, 'Look in the chest.');
            const message = villageDecisionMessage({
                ambition: SEED,
                goal: chosen.goal,
                step: 'Walk toward the remembered path.',
            });
            assert.match(message, /long-term ambition/i);
            assert.match(message, /Walk the path north of home/);
            assert.doesNotMatch(message, /no assigned quest|lifelong ambition|not required to sleep/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('night sends the body home and keeps the goal when sleep must wait', () => {
        assert.equal(nightPhase(6000), 'day');
        assert.equal(nightPhase(12500), 'dusk');
        assert.equal(nightPhase(18000), 'night');
        assert.equal(autonomyPausedForNight('night'), true);
        assert.equal(autonomyPausedForNight('day'), false);
        const home = { door: [0, 64, 0], bed: [2, 64, 2] };
        assert.equal(nextNightAction({
            phase: 'dusk',
            position: { x: 40, y: 64, z: 40 },
            home,
        }).kind, 'move');
        assert.equal(nextNightAction({
            phase: 'night',
            position: { x: 2, y: 64, z: 2 },
            home,
            now: 1000,
            nextSleepAt: 5000,
        }).kind, 'wait');
        assert.equal(nextNightAction({
            phase: 'night',
            emergency: true,
            position: { x: 40, y: 64, z: 40 },
            home,
        }).kind, 'idle');
        assert.equal(nextNightAction({
            phase: 'night',
            position: { x: 2, y: 64, z: 2 },
            home,
            now: 9000,
            nextSleepAt: 0,
        }).kind, 'sleep');
        assert.equal(nextNightAction({
            phase: 'dusk',
            position: { x: 40, y: 64, z: 40 },
            home: null,
        }).kind, 'wait');
        assert.equal(nextNightAction({
            phase: 'night',
            position: { x: 40, y: 64, z: 40 },
            home: null,
        }).kind, 'nearest_bed');
        assert.equal(nextNightAction({
            phase: 'night',
            position: { x: 40, y: 64, z: 40 },
            home: nightHomeFrom({ home: null }, { bed: [3, 64, 3] }),
        }).kind, 'move');
        assert.equal(bedNeedsAnother('the bed is occupied'), true);
        assert.equal(bedNeedsAnother('there are monsters nearby'), false);
        assert.deepEqual(nightHomeFrom({ home: { bed: [1, 64, 1] } }, { bed: [9, 64, 9] }).bed, [1, 64, 1]);
        const manager = {
            enabled: true,
            current: { status: 'active', objective: 'old goal' },
            getCurrentPlan() { return this.current; },
            abandon(reason) { this.current = { status: 'abandoned', reason }; return true; },
        };
        assert.equal(syncPlanToGoal(manager, 'Walk the path north of home.'), true);
        assert.equal(manager.current.status, 'abandoned');
    });

    test('a dream may revise an ambition and leaves identity and old intentions in place', () => {
        const root = tempLife();
        try {
            ensureSeededAmbition(root, SEED, () => '2026-11-15T12:00:00.000Z');
            const result = commitDream(root, {
                sleepId: 'sleep-wynn-1',
                profileChecksum: 'sum',
                validated: {
                    journal: 'The path past the house stayed with me.',
                    brief: 'The path is still there.',
                    stance: 'I want another look tomorrow.',
                    intentions: ['Walk past the house again.'],
                    memories: [],
                    relationships: [],
                    ambition: 'Learn the land beyond the house without losing the people at home.',
                },
                episodeIds: [],
                now: '2026-11-15T23:00:00.000Z',
            });
            assert.equal(result.applied, true);
            assert.equal(activeAmbitionText(readAmbitions(root)), 'Learn the land beyond the house without losing the people at home.');
            assert.equal(readAmbitions(root).history[0].text, SEED);
            assert.equal(JSON.parse(readFileSync(path.join(root, 'identity.json'), 'utf8')).name, 'Wynn');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('a finished plan asks for a decision and does not finish the ambition by itself', () => {
        const root = tempLife();
        try {
            ensureSeededAmbition(root, SEED, () => '2026-11-15T12:00:00.000Z');
            const goal = 'Plant flowers beside the house.';
            writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
                schema_version: 1,
                active: { id: 'int-0002', text: goal, status: 'pursuing', source: 'reflection', progress: '' },
                history: [],
            }));
            const plan = {
                status: 'completed',
                objective: goal,
                steps: [
                    { id: 'collect', description: 'Collect dandelions', action: { name: 'collectBlocks', params: { type: 'dandelion', num: 4 } }, status: 'completed', lastOutcome: { status: 'success' } },
                    { id: 'plant', description: 'Place a dandelion', action: { name: 'placeHere', params: { type: 'dandelion' } }, status: 'completed', lastOutcome: { status: 'success' } },
                ],
            };
            const prompt = goalEvaluationPrompt({ name: 'Lea', ambition: SEED, goal, plan });
            assert.match(prompt, /does not by itself finish the current goal/);
            assert.match(prompt, /does not finish the long-term ambition/);
            assert.match(prompt, /Verified status: success/);
            assert.doesNotMatch(prompt, /!placeHere/);
            assert.equal(finishedPlanNeedsReplan(plan, goal), false);
            assert.equal(finishedPlanNeedsReplan({ ...plan, goalDecision: 'follow_up' }, goal), true);
            assert.equal(finishedPlanNeedsReplan({ ...plan, goalDecision: 'achieved' }, goal), false);

            const achieved = applyGoalDecision(root, 'achieved', { note: 'Flowers are in the ground.', now: () => '2026-11-15T18:00:00.000Z' });
            assert.equal(achieved.applied, true);
            assert.equal(achieved.ambitionUnchanged, true);
            assert.equal(achieved.goal, '');
            assert.equal(activeAmbitionText(readAmbitions(root)), SEED);
            assert.equal(readIntentions(root).active, null);
            assert.equal(readIntentions(root).history.at(-1).status, 'completed');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('revising or abandoning a goal can name the next one without touching the ambition', () => {
        const root = tempLife();
        try {
            ensureSeededAmbition(root, SEED, () => '2026-11-15T12:00:00.000Z');
            writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
                schema_version: 1,
                active: { id: 'int-0002', text: 'Plant flowers beside the house.', status: 'pursuing', source: 'reflection' },
                history: [],
            }));
            const revised = applyGoalDecision(root, 'revise', {
                goal: 'Water the flowers already planted beside the house.',
                now: () => '2026-11-15T18:05:00.000Z',
            });
            assert.equal(revised.goal, 'Water the flowers already planted beside the house.');
            assert.equal(activeAmbitionText(readAmbitions(root)), SEED);
            const abandoned = applyGoalDecision(root, 'abandon', {
                goal: 'Walk to the square and see who is there.',
                note: 'The flowers can wait.',
                now: () => '2026-11-15T18:06:00.000Z',
            });
            assert.equal(abandoned.goal, 'Walk to the square and see who is there.');
            assert.equal(readIntentions(root).history.at(-1).status, 'abandoned');
            assert.equal(readIntentions(root).history.at(-1).text, 'Water the flowers already planted beside the house.');
            assert.equal(activeAmbitionText(readAmbitions(root)), SEED);
            assert.equal(finishedPlanNeedsReplan({ status: 'completed', goalDecision: 'abandon' }, abandoned.goal), true);
            assert.match(villageDecisionMessage({ goal: abandoned.goal, planFinished: true }), /Do not repeat its last action/);
            assert.doesNotMatch(villageDecisionMessage({ goal: abandoned.goal }), /Do not repeat its last action/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('decorative placement leaves existing blocks alone', () => {
    test('a flower prefers empty ground and refuses a path or an existing flower', () => {
        assert.equal(isGroundPlant('dandelion'), true);
        assert.equal(isGroundPlant('oak_sapling'), true);
        assert.equal(isGroundPlant('torch'), false);
        assert.equal(isGroundPlant('dirt_path'), false);
        const world = new Map([
            ['0,64,0', 'dirt_path'],
            ['0,63,0', 'stone'],
            ['1,64,0', 'dandelion'],
            ['1,63,0', 'grass_block'],
            ['0,64,1', 'air'],
            ['0,63,1', 'grass_block'],
            ['2,64,0', 'oak_planks'],
            ['2,63,0', 'stone'],
        ]);
        const blockAt = (x, y, z) => world.get(`${x},${y},${z}`) || 'air';
        assert.deepEqual(decorativePlacementTarget(blockAt, { x: 0.2, y: 64, z: 0.2 }), { x: 0, y: 64, z: 1 });
        const blocked = new Map([
            ['0,64,0', 'dirt_path'],
            ['0,63,0', 'grass_block'],
            ['1,64,0', 'poppy'],
            ['1,63,0', 'grass_block'],
        ]);
        assert.equal(decorativePlacementTarget((x, y, z) => blocked.get(`${x},${y},${z}`) || 'oak_planks', { x: 0, y: 64, z: 0 }, 1), null);
    });
});
