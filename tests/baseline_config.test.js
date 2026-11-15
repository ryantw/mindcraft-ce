import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import rootSettings from '../settings.js';
import { PlanManager } from '../src/agent/plan_manager.js';
import { setSettings } from '../src/agent/settings.js';
import { Prompter } from '../src/models/prompter.js';
import { blacklistCommands, commandExists, getCommandDocs } from '../src/agent/commands/index.js';
import { constructionCapabilities } from '../src/agent/plan_feasibility.js';

const NAMES = ['Finn', 'Sawyer', 'Milo', 'Jasper', 'Rowan'];
const root = new URL('../', import.meta.url);
const loadProfile = file => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
const defaults = loadProfile('profiles/defaults/_default.json');

// What each agent process effectively sees: its profile with defaults filled in.
function effectiveProfile(file) {
    const profile = loadProfile(file);
    for (const key of Object.keys(defaults)) if (profile[key] === undefined) profile[key] = defaults[key];
    return profile;
}

function makeAgent(profile) {
    return {
        name: profile.name,
        blocked_actions: rootSettings.blocked_actions || [],
        bot: {
            inventory: { inventoryStart: 9, slots: Array(46).fill(null) },
            entity: { position: { x: 0, y: 64, z: 0 } },
            blockAt: () => ({ name: 'air' }),
        },
        prompter: { profile },
        self_prompter: { prompt: 'Live independently.' },
        history: { memory: '' },
    };
}

let dir;
beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-baseline-'));
    // Same effective settings an agent process receives from settings.js.
    setSettings({ ...rootSettings });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('shared baseline configuration', () => {
    test('settings.js lists exactly the five agents with distinct profiles', () => {
        const profiles = rootSettings.profiles.map(file => loadProfile(file.replace(/^\.\//, '')));
        assert.deepEqual(profiles.map(profile => profile.name).sort(), [...NAMES].sort());
    });

    test('persistent planning is on for every agent through one shared default, with no per-agent overrides', () => {
        assert.equal(rootSettings.persistent_planning, true);
        for (const file of rootSettings.profiles) {
            const profile = effectiveProfile(file.replace(/^\.\//, ''));
            assert.equal(profile.persistent_planning, undefined, `${profile.name} must not override the shared default`);
            const manager = new PlanManager(makeAgent(profile), dir);
            assert.equal(manager.enabled, true, profile.name);
        }
    });

    test('retrieved behavioral examples are disabled for non-human contexts for all five agents', () => {
        assert.equal(rootSettings.allow_retrieved_examples_in_non_human_contexts, false);
        for (const file of rootSettings.profiles) {
            const profile = effectiveProfile(file.replace(/^\.\//, ''));
            assert.equal(profile.allow_retrieved_examples_in_non_human_contexts, undefined, `${profile.name} must use the shared setting`);
        }
    });

    test('plans and files are independent per agent', () => {
        const managers = rootSettings.profiles.map(file => {
            const profile = effectiveProfile(file.replace(/^\.\//, ''));
            return new PlanManager(makeAgent(profile), dir);
        });
        managers[0].applyProposal({
            objective: 'Craft a chest',
            steps: [{ id: 'a', description: 'craft', action: { name: 'craftRecipe', params: { recipe_name: 'chest', num: 1 } } }],
        });
        assert.equal(existsSync(path.join(dir, managers[0].agent.name, 'plan.json')), true);
        for (const other of managers.slice(1)) {
            assert.equal(other.getCurrentPlan(), null);
            assert.equal(existsSync(path.join(dir, other.agent.name)), false);
        }
    });

    test('construction commands are registered, unblocked, and advertised to every agent', () => {
        assert.deepEqual((rootSettings.blocked_actions || []).filter(name => /place|build/i.test(name)), []);
        for (const name of ['placeBlockAt', 'buildLine', 'buildPlane']) assert.equal(commandExists(name), true, name);
        for (const file of rootSettings.profiles) {
            const profile = effectiveProfile(file.replace(/^\.\//, ''));
            const agent = makeAgent(profile);
            agent.plan_manager = new PlanManager(agent, dir);
            const docs = getCommandDocs(agent);
            for (const name of ['!placeBlockAt', '!buildLine', '!buildPlane', '!reconsiderPlan', '!think']) {
                assert.match(docs, new RegExp(name), `${profile.name} sees ${name}`);
            }
            assert.equal(constructionCapabilities(agent).canBuildStructures, true, profile.name);
        }
    });

    test('insecure generated-code execution stays disabled', () => {
        assert.equal(rootSettings.allow_insecure_coding, false);
        for (const file of rootSettings.profiles) {
            const profile = effectiveProfile(file.replace(/^\.\//, ''));
            const agent = makeAgent(profile);
            agent.plan_manager = new PlanManager(agent, dir);
            const context = agent.plan_manager.planningContext();
            assert.doesNotMatch(context, /!newAction/);
        }
    });

    test('reflection and memory/attribution settings are part of the baseline', () => {
        assert.equal(rootSettings.reasoning.auto_reflection, true);
        assert.equal(rootSettings.load_memory, true);
        assert.match(defaults.conversing, /ATTRIBUTION:/);
        assert.match(defaults.saving_memory, /ANOTHER AGENT/);
        assert.match(defaults.planning, /\$PLAN_CONTEXT/);
    });

    test('no profession, shelter design or construction objective is assigned in any profile or the planner', () => {
        for (const file of rootSettings.profiles) {
            const text = readFileSync(new URL(file.replace(/^\.\//, ''), root), 'utf8');
            assert.doesNotMatch(text, /profession|blueprint|5x5|you are a (builder|miner|farmer)/i, file);
        }
        assert.doesNotMatch(defaults.planning, /you are a (builder|miner|farmer)|build a (house|shelter)|5x5/i);
    });
});

describe('planner uses a budget large enough for a build plan', () => {
    test('promptPlanning uses the one-shot completion with 1024 tokens and a long timeout', async () => {
        const calls = [];
        const plan = { objective: 'Craft a chest', steps: [{ id: 'a', action: { name: 'craftRecipe', params: {} } }] };
        const fake = {
            agent: { name: 'Sawyer', plan_manager: { enabled: true, formatForPrompt: () => 'No plan.', planningContext: () => 'CONTEXT' } },
            profile: { planning: 'Plan. $PLAN_REASON $PREVIOUS_PLAN $PLAN_CONTEXT' },
            checkCooldown: async () => {},
            replaceStrings: async prompt => prompt,
            _saveLog: async () => {},
            chat_model: {
                complete: async (user, system, params) => { calls.push({ user, system, params }); return { content: JSON.stringify(plan), done_reason: 'stop' }; },
                sendRequest: async () => { throw new Error('should not use the 512-token chat path'); },
            },
        };
        const proposal = await Prompter.prototype.promptPlanning.call(fake, 'no_active_plan', null, null);
        assert.equal(proposal.objective, 'Craft a chest');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].params.options.num_predict, 1024);
        assert.equal(calls[0].params.max_predict, 1024);
        assert.equal(calls[0].params.timeout_ms, 120000);
        assert.equal(calls[0].params.think, false);
        assert.match(calls[0].system, /Plan\. no_active_plan No plan\. CONTEXT/);
    });
});
