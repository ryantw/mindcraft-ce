/**
 * Disposable motivation trace. Uses local qwen3:14b.
 * Goal selection uses think false. Planning in this trace still thinks. The result is printed.
 * Writes only a temporary directory. Does not connect to Village Alpha
 * and does not read or write runtime/scenarios/village-alpha.
 *
 * Usage: node scripts/village/motivation-trace.js
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { Ollama } from '../../src/models/ollama.js';
import { PlanManager } from '../../src/agent/plan_manager.js';
import { chooseCurrentGoal, syncPlanToGoal } from '../../src/village/goals.js';
import { activeAmbitionText, ensureSeededAmbition, readAmbitions } from '../../src/village/ambitions.js';
import { readIntentions } from '../../src/village/intentions.js';
import { describeAvailableActions } from '../../src/agent/plan_feasibility.js';
import { nextNightAction, nightEmergency } from '../../src/village/night.js';
import { initializeMinecraftData } from '../../src/utils/mcdata.js';

initializeMinecraftData('1.21.6');

const SEED = 'Learn the quiet places around home, notice what has changed, and keep a life that does not need to fill every silence.';
const root = mkdtempSync(path.join(os.tmpdir(), 'village-motivation-'));
writeFileSync(path.join(root, 'identity.json'), JSON.stringify({
    name: 'Wynn',
    profile_checksum: 'trace',
    backstory: [
        { id: 'house', text: 'Wynn keeps the north-west house and treats the chest there as private.' },
        { id: 'manner', text: 'Wynn speaks briefly and would rather look at a doorway than fill a silence.' },
    ],
    temperament: ['Speaks briefly.', 'Notices when objects in the house move.'],
    interests: ['doorways', 'quiet mornings'],
}));
writeFileSync(path.join(root, 'knowledge.json'), JSON.stringify({
    schema_version: 1,
    home: { plot_id: 'north-west', home_marker: [0, 64, 0], bed: [2, 64, 2], door: [0, 64, 0], chest: [1, 64, 2] },
    public_places: [{ id: 'square', marker: [12, 64, 12] }, { id: 'well', marker: [16, 64, 8] }],
}));
writeFileSync(path.join(root, 'intentions.json'), JSON.stringify({ schema_version: 1, active: null, history: [] }));
writeFileSync(path.join(root, 'episodes.json'), JSON.stringify({
    schema_version: 1,
    episodes: [{ id: 'ep-0001', text: 'The doorway of the north-west house was closed when Wynn last looked.' }],
}));

setSettings({
    village_autonomy: true,
    agent_data_root: root,
    persistent_planning: true,
    minecraft_version: '1.21.6',
    base_profile: 'survival',
    profile: { ambition_seed: SEED },
    language: 'en',
    log_all_prompts: false,
});

ensureSeededAmbition(root, SEED, () => '2026-11-15T16:00:00.000Z');

const model = new Ollama('qwen3:14b', 'http://127.0.0.1:11434', {
    think: false,
    keep_alive: -1,
    options: { num_ctx: 8192, num_predict: 512 },
});

const goalResult = await chooseCurrentGoal(root, {
    now: () => '2026-11-15T16:05:00.000Z',
    complete: (prompt) => model.complete(
        prompt,
        'Choose a goal from the notes. Return only the JSON object. Do not invent events.',
        { think: false, timeout_ms: 120000, max_predict: 512, options: { num_predict: 512 } }
    ).then(response => response?.content || ''),
});

const agent = {
    name: 'Wynn',
    blocked_actions: [],
    bot: {
        game: { gameMode: 'survival' },
        health: 20,
        food: 18,
        rainState: 0,
        thunderState: 0,
        time: { timeOfDay: 6000 },
        entity: { position: { x: 24, y: 64, z: 24 } },
        inventory: { items: () => [] },
        nearbyEntities: () => [],
    },
};
agent.plan_manager = new PlanManager(agent, root);
const actions = describeAvailableActions(agent).slice(0, 40);
const goal = readIntentions(root).active?.text || '';
const ambition = activeAmbitionText(readAmbitions(root));
let planRaw = '';
let planDone = null;
let proposal = null;
let problems = [];
if (goal) {
    const request = `Your current goal is already chosen: "${goal}". Your long-term ambition, for context only: "${ambition}". Plan the next few concrete steps that pursue that goal. Do not invent places, materials, or events you have not seen. Known places: home, square, well. You are outdoors in daylight, holding nothing, health 20, hunger 18. Set objective to the current goal exactly. Return only the JSON object with objective, rationale, materials, and steps. Each step needs id, description, and action {name, params} using one of these commands:\n${actions.join('\n')}`;
    const planned = await model.complete(
        request,
        'Return only one JSON object. Do not narrate events that have not happened.',
        { think: true, timeout_ms: 180000, max_predict: 2048, allow_long_completion: true, options: { num_predict: 2048 } }
    );
    planRaw = planned?.content || '';
    planDone = planned?.done_reason || null;
    const start = planRaw.indexOf('{');
    const end = planRaw.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            proposal = JSON.parse(planRaw.slice(start, end + 1));
            proposal.objective = goal;
            problems = agent.plan_manager.validateProposal(proposal);
            if (problems.length) {
                const retry = await model.complete(
                    `${request}\n\nThe previous proposal was rejected: ${problems.join(' | ')}. Propose a different plan that fixes these problems. home is a remembered place. Return only the JSON object.`,
                    'Return only one JSON object. Do not narrate events that have not happened.',
                    { think: true, timeout_ms: 180000, max_predict: 2048, allow_long_completion: true, options: { num_predict: 2048 } }
                );
                planRaw = retry?.content || planRaw;
                planDone = retry?.done_reason || planDone;
                const retryStart = planRaw.indexOf('{');
                const retryEnd = planRaw.lastIndexOf('}');
                proposal = JSON.parse(planRaw.slice(retryStart, retryEnd + 1));
                proposal.objective = goal;
                problems = agent.plan_manager.validateProposal(proposal);
            }
            if (problems.length === 0) {
                syncPlanToGoal(agent.plan_manager, goal);
                agent.plan_manager.applyProposal(proposal, 'no_active_plan');
            }
        } catch (error) {
            problems = [error.message];
        }
    } else {
        problems = ['The model did not return a JSON object.'];
    }
}

const home = { door: [0, 64, 0], bed: [2, 64, 2] };
const far = { x: 24, y: 64, z: 24 };
const night = {
    dusk_far_from_home: nextNightAction({ phase: 'dusk', position: far, home }),
    night_emergency: nextNightAction({ phase: 'night', emergency: true, position: far, home }),
    night_after_emergency: nextNightAction({ phase: 'night', emergency: false, position: far, home, now: 10_000, nextSleepAt: 0 }),
    night_home_waits_out_a_failed_sleep: nextNightAction({
        phase: 'night',
        position: { x: 2, y: 64, z: 2 },
        home,
        now: 1000,
        nextSleepAt: 20_000,
    }),
    drowning_is_an_emergency: nightEmergency({
        health: 20,
        entity: { position: { x: 0, y: 64, z: 0, offset() { return this; } } },
        blockAt: () => ({ name: 'water' }),
    }),
};

const report = {
    temp_dir: root,
    model: 'qwen3:14b',
    goal_selection_think: false,
    planning_think: true,
    ambition,
    goal_result: { chosen: goalResult.chosen, goal: goalResult.goal || null, reason: goalResult.reason || null, raw: goalResult.raw || null },
    intention: readIntentions(root).active,
    plan_accepted: problems.length === 0 && Boolean(agent.plan_manager.getCurrentPlan()),
    plan_problems: problems,
    plan_on_file: agent.plan_manager.getCurrentPlan(),
    plan_done_reason: planDone,
    plan_raw: planRaw,
    night,
};
console.log(JSON.stringify(report, null, 2));
rmSync(root, { recursive: true, force: true });
