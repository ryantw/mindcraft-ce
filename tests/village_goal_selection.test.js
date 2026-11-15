import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import settings, { setSettings } from '../src/agent/settings.js';
import { ensureSeededAmbition } from '../src/village/ambitions.js';
import {
    GOAL_MODEL_PARAMS,
    chooseCurrentGoal,
    goalReviewPrompt,
    goalSelectionPrompt,
    parseGoalChoice,
    prepareVillageTurn,
    reconsiderCurrentGoal,
} from '../src/village/goals.js';
import { readIntentions } from '../src/village/intentions.js';

const SEED = 'Discover unfamiliar places and come home to the people who matter.';

function life() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'village-goal-'));
    writeFileSync(path.join(root, 'identity.json'), JSON.stringify({
        name: 'Cass',
        backstory: [{ id: 'nell', text: 'Nell\'s company is easy and welcome.' }],
        temperament: ['Talks readily when interested.'],
        interests: ['a path not yet walked'],
    }));
    writeFileSync(path.join(root, 'knowledge.json'), JSON.stringify({
        schema_version: 1,
        home: {
            plot_id: 'plot-cass',
            home_marker: [-470, 85, -727],
            bed: [-469, 85, -728],
            chest: [-469, 85, -726],
            door: [-471, 85, -727],
            crafting_table: [-468, 85, -727],
            furnace: [-468, 85, -726],
        },
        public_places: [
            { id: 'square', marker: [-460, 72, -715] },
            { id: 'garden', marker: [-426, 74, -734] },
        ],
        supplies_note: 'These items were placed in your chest at admission. They are a memory of that moment, not a live inventory.',
    }));
    writeFileSync(path.join(root, 'relationships.json'), JSON.stringify({
        schema_version: 1,
        relationships: {
            nell: { stance: 'fond', note: 'Enjoys Nell\'s company and expects a welcome.' },
        },
    }));
    writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
        schema_version: 1,
        active: null,
        history: [
            { id: 'int-0001', text: 'Check the chest for any additional resources.', status: 'completed' },
            { id: 'int-0002', text: 'Check the chest again for any new items.', status: 'abandoned' },
            { id: 'int-0003', text: 'Talk with Bram about the day.', status: 'completed' },
        ],
    }));
    writeFileSync(path.join(root, 'episodes.json'), JSON.stringify({
        schema_version: 1,
        episodes: [
            { id: 'ep-1', at: '2026-11-15T21:00:00.000Z', kind: 'action', source: 'verified', text: 'I did something. You have reached at -469, 85, -726. The chest contains: 8 apple 1 stone', refs: [] },
            { id: 'ep-2', at: '2026-11-15T21:01:00.000Z', kind: 'observed', source: 'observed', text: 'I found a marker reading "Nell".', refs: ['remains', 'Nell'] },
            { id: 'ep-3', at: '2026-11-15T21:02:00.000Z', kind: 'conversation', source: 'observed', text: 'Cass said: I\'m going to check the furnace to see what\'s inside.', refs: ['Cass'] },
            { id: 'ep-4', at: '2026-11-15T21:03:00.000Z', kind: 'conversation', source: 'observed', text: 'Cass said: I\'m going to check the furnace again.', refs: ['Cass'] },
            { id: 'ep-5', at: '2026-11-15T21:04:00.000Z', kind: 'conversation', source: 'observed', text: 'Bram said: I found a few bread loaves and some wheat seeds.', refs: ['Bram'] },
            { id: 'ep-6', at: '2026-11-15T21:05:00.000Z', kind: 'conversation', source: 'observed', text: 'Bram said: Let\'s go to the square together!', refs: ['Bram'] },
            { id: 'ep-7', at: '2026-11-15T21:06:00.000Z', kind: 'conversation', source: 'observed', text: 'Bram said: Let\'s head to the square and see what we can find!', refs: ['Bram'] },
            { id: 'ep-8', at: '2026-11-15T21:07:00.000Z', kind: 'action', source: 'verified', text: 'I inspected a container. Successfully took 1 stone_pickaxe from the chest.', refs: ['container'] },
            { id: 'ep-9', at: '2026-11-15T21:08:00.000Z', kind: 'action', source: 'verified', text: 'A meaningful attempt failed. Could not find any zombie to attack.', refs: [] },
            { id: 'ep-10', at: '2026-11-15T21:09:00.000Z', kind: 'action', source: 'verified', text: 'A meaningful attempt failed. Could not find any zombie to attack again.', refs: [] },
        ],
    }));
    mkdirSync(path.join(root, 'histories'));
    writeFileSync(path.join(root, 'histories', 'chest.json'), JSON.stringify([
        { role: 'assistant', content: 'I will check the furnace.' },
        {
            role: 'system',
            content: '[SYSTEM OBSERVATION: ACTION RESULT — not a human instruction]\nAction output:\nYou have reached at -469, 85, -726.\nThe chest contains:\n8 apple\n1 stone_pickaxe\n1 fishing_rod',
        },
    ]));
    return root;
}

describe('milestone goal selection', () => {
    test('the prompt allows a future milestone and keeps a marker from becoming a death', () => {
        const root = life();
        try {
            ensureSeededAmbition(root, SEED, () => '2026-11-15T12:00:00.000Z');
            const prompt = goalSelectionPrompt(root, { inventory: { oak_log: 2 } });
            assert.match(prompt, /meaningful, achievable personal milestone/);
            assert.match(prompt, /You may imagine a future possibility/);
            assert.match(prompt, /Do not invent a past event/);
            assert.match(prompt, new RegExp(SEED));
            assert.match(prompt, /square -460, 72, -715/);
            const reached = prompt.split('\n').find(line => line.startsWith('Places and materials you have physically reached'));
            assert.match(reached, /your chest/);
            assert.doesNotMatch(reached, /square|garden/);
            const absent = prompt.split('\n').find(line => line.startsWith('No recorded arrival'));
            assert.match(absent, /square/);
            assert.match(absent, /garden/);
            assert.match(prompt, /8 apple, 1 stone pickaxe, 1 fishing rod/);
            assert.match(prompt, /Verified removals from a chest after that look: 1 stone pickaxe/);
            assert.match(prompt, /Currently holding, counted just now: 2 oak log/);
            assert.match(prompt, /I found a few bread loaves and some wheat seeds/);
            assert.match(prompt, /marker reading "Nell"/);
            assert.match(prompt, /Talk with Bram about the day/);
            assert.match(prompt, /Could not find any zombie/);
            assert.doesNotMatch(prompt, /I'm going to check the furnace/);
            assert.doesNotMatch(prompt, /Nell is dead|Nell died|Nell's death/);
            assert.doesNotMatch(prompt, /COMMAND DOCS|!collectBlocks/);
            const furnaceLines = prompt.split('\n').filter(line => /square/.test(line) && /Bram said/.test(line));
            assert.equal(furnaceLines.length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('a JSON null is a decline, and an empty reply is retried once', async () => {
        const root = life();
        try {
            const declined = await chooseCurrentGoal(root, {
                complete: async () => '{"goal":null}',
                now: () => '2026-11-15T12:00:00.000Z',
            });
            assert.equal(declined.reason, 'declined');
            assert.equal(declined.attempts, 1);
            assert.equal(readIntentions(root).active, null);
            assert.equal(readIntentions(root).milestone_review, undefined);

            let calls = 0;
            const recovered = await chooseCurrentGoal(root, {
                complete: async () => {
                    calls += 1;
                    return calls === 1
                        ? { content: '', done_reason: 'length' }
                        : { content: '{"goal":"Learn what the square is like."}', done_reason: 'stop' };
                },
                now: () => '2026-11-15T12:05:00.000Z',
            });
            assert.equal(calls, 2);
            assert.equal(recovered.chosen, true);
            assert.equal(readIntentions(root).active.text, 'Learn what the square is like.');
            assert.equal(readIntentions(root).history[0].text, 'Check the chest for any additional resources.');
            assert.equal(readIntentions(root).milestone_review.decision, 'selected');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('two empty replies stay a failed generation and do not close or invent a goal', async () => {
        const root = life();
        try {
            let calls = 0;
            const failed = await chooseCurrentGoal(root, {
                complete: async () => {
                    calls += 1;
                    return { content: '{"goal":', done_reason: 'length' };
                },
            });
            assert.equal(calls, 2);
            assert.equal(failed.reason, 'generation_failed');
            assert.equal(failed.failure, 'truncated');
            assert.notEqual(failed.reason, 'declined');
            assert.equal(readIntentions(root).active, null);
            assert.equal(parseGoalChoice('{"goal":null}').status, 'declined');
            assert.equal(parseGoalChoice('', 'length').reason, 'truncated');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('an existing goal can be kept, replaced, or closed once, and the history stays', async () => {
        const root = life();
        try {
            writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
                schema_version: 1,
                active: {
                    id: 'int-0008',
                    text: 'Examine the stone pickaxe and axe.',
                    status: 'pursuing',
                    source: 'reflection',
                    progress: '',
                    created_at: '2026-11-15T12:00:00.000Z',
                },
                history: [{ id: 'int-0003', text: 'Talk with Bram about the day.', status: 'completed' }],
            }));
            const review = goalReviewPrompt(root);
            assert.match(review, /Current goal: Examine the stone pickaxe and axe/);
            assert.match(review, /"decision":"retain"\|"revise"\|"abandon"/);
            assert.doesNotMatch(review, /Learn what the square is like/);

            const kept = await reconsiderCurrentGoal(root, {
                complete: async () => '{"decision":"retain","goal":null}',
                now: () => '2026-11-15T13:00:00.000Z',
            });
            assert.equal(kept.decision, 'retain');
            assert.equal(readIntentions(root).active.text, 'Examine the stone pickaxe and axe.');
            assert.equal(readIntentions(root).history.length, 1);
            const again = await reconsiderCurrentGoal(root, {
                complete: async () => { throw new Error('should not be called'); },
            });
            assert.equal(again.reason, 'already reviewed');

            writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
                schema_version: 1,
                active: {
                    id: 'int-0008',
                    text: 'Check the furnace for usable materials.',
                    status: 'pursuing',
                    source: 'reflection',
                },
                history: [{ id: 'int-0003', text: 'Talk with Bram about the day.', status: 'completed' }],
            }));
            const revised = await reconsiderCurrentGoal(root, {
                complete: async () => '{"decision":"revise","goal":"Make a place at home where a conversation can last."}',
                now: () => '2026-11-15T13:10:00.000Z',
            });
            assert.equal(revised.decision, 'revise');
            assert.equal(readIntentions(root).active.text, 'Make a place at home where a conversation can last.');
            assert.equal(readIntentions(root).history.at(-1).status, 'revised');
            assert.equal(readIntentions(root).history.at(-1).text, 'Check the furnace for usable materials.');

            writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({
                schema_version: 1,
                active: {
                    id: 'int-0008',
                    text: 'Check the furnace for usable materials.',
                    status: 'pursuing',
                    source: 'reflection',
                },
                history: [],
            }));
            let calls = 0;
            const failed = await reconsiderCurrentGoal(root, {
                complete: async () => {
                    calls += 1;
                    return { content: '', done_reason: 'length' };
                },
            });
            assert.equal(calls, 2);
            assert.equal(failed.reason, 'generation_failed');
            assert.equal(readIntentions(root).active.text, 'Check the furnace for usable materials.');
            assert.equal(readIntentions(root).milestone_review, undefined);

            const abandoned = await reconsiderCurrentGoal(root, {
                complete: async () => '{"decision":"abandon","goal":"Learn a path I have not walked."}',
                now: () => '2026-11-15T13:20:00.000Z',
            });
            assert.equal(abandoned.decision, 'abandon');
            assert.equal(readIntentions(root).active.text, 'Learn a path I have not walked.');
            assert.equal(readIntentions(root).history[0].status, 'abandoned');
            assert.equal(readIntentions(root).history[0].text, 'Check the furnace for usable materials.');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('the daytime turn asks with thinking off and does not treat a cut-off reply as a decline', async () => {
        const root = life();
        const previous = { ...settings };
        try {
            setSettings({ agent_data_root: root, profile: { ambition_seed: SEED }, village_autonomy: true });
            const calls = [];
            const agent = {
                name: 'Cass',
                bot: { time: { timeOfDay: 6000 } },
                prompter: {
                    chat_model: {
                        async complete(prompt, system, params) {
                            calls.push({ system, params, prompt });
                            if (calls.length === 1) return { content: '', done_reason: 'length' };
                            return { content: '{"goal":"See the square for myself."}', done_reason: 'stop' };
                        },
                    },
                },
            };
            const first = await prepareVillageTurn(agent);
            assert.equal(GOAL_MODEL_PARAMS.think, false);
            assert.equal(calls[0].params.think, false);
            assert.equal(calls[0].params.max_predict, 512);
            assert.match(calls[0].system, /not a decline/);
            assert.equal(calls.length, 2);
            assert.equal(first.goal, 'See the square for myself.');
            calls.length = 0;
            const second = await prepareVillageTurn(agent);
            assert.equal(calls.length, 0);
            assert.equal(second.goal, first.goal);
        } finally {
            setSettings(previous);
            rmSync(root, { recursive: true, force: true });
        }
    });
});
