import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import rootSettings from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { History } from '../src/agent/history.js';
import { PlanManager } from '../src/agent/plan_manager.js';
import { AgentProcess } from '../src/process/agent_process.js';
import { assertOutsideSurvivalBots } from '../src/agent/data_dir.js';
import { ScenarioError } from '../src/village/errors.js';
import { loadScenario } from '../src/village/load.js';
import { prepareScenario } from '../src/village/launch.js';
import { admitPopulation } from '../src/village/admit.js';
import { readLife, markDeadForTest, transitionLife } from '../src/village/life.js';
import { beginProcess, recordProcessExit } from '../src/village/supervise.js';
import { createAgent } from '../src/mindcraft/mindcraft.js';
import { resolveStartupGoal, resolveVillageAutonomy, usableGoal, VILLAGE_AUTONOMY_PREAMBLE } from '../src/agent/startup_goal.js';

const RESERVED = ['Finn', 'Sawyer', 'Milo', 'Jasper', 'Rowan'];
const NOW = '2026-11-15T12:00:00.000Z';

function person(id, name, other = null) {
    return {
        schema_version: 1,
        id,
        name,
        profile_version: 1,
        backstory: [{ id: 'self', text: `${name} keeps their own counsel.` }],
        temperament: ['Chooses what to do when nothing is assigned.'],
        interests: ['walking'],
        seed_relationships: other ? [{ other_id: other, stance: 'acquaintance', note: `Has met ${other}.` }] : [],
    };
}

function writeScenario(dir, people, { vacant = 0, mutate, port = 25566 } = {}) {
    mkdirSync(path.join(dir, 'inhabitants'), { recursive: true });
    const plots = people.map((profile, index) => ({
        id: `plot-${profile.id}`,
        occupant: profile.id,
        home_marker: [index, 64, 0],
        bed: [index, 64, 1],
        chest: [index, 64, 2],
        door: [index, 64, -1],
        crafting_table: [index, 64, 3],
        furnace: [index, 64, 4],
    }));
    for (let index = 0; index < vacant; index++) {
        plots.push({
            id: `plot-vacant-${index}`,
            occupant: null,
            home_marker: [100 + index, 64, 0],
            bed: [100 + index, 64, 1],
            chest: [100 + index, 64, 2],
            door: [100 + index, 64, -1],
            crafting_table: [100 + index, 64, 3],
            furnace: [100 + index, 64, 4],
        });
    }
    const scenario = {
        schema_version: 1,
        id: path.basename(dir),
        title: 'Fixture',
        connection: { host: '127.0.0.1', port, minecraft_version: '1.21.6', auth: 'offline' },
        models: {
            day: { api: 'ollama', model: 'qwen3:8b' },
            dream: { api: 'ollama', model: 'qwen3:14b' },
        },
        inhabitants: people.map(profile => `inhabitants/${profile.id}.json`),
        village: 'village.json',
        settings: { base_profile: 'survival', allow_insecure_coding: false, load_memory: true },
    };
    const village = {
        schema_version: 1,
        id: `${scenario.id}-places`,
        spawn_dimension: 'overworld',
        plots,
        public: [{ id: 'square', marker: [0, 64, 20] }],
        provisions: {
            per_home: { food: [{ item: 'bread', count: 1 }], tools: ['stone_pickaxe'], also: ['crafting_table'] },
            refill: 'never',
        },
        paths: plots.map(plot => ({ from: plot.id, to: 'square', walkable_without_breaking: true })),
    };
    if (mutate) mutate({ scenario, village, people });
    writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
    writeFileSync(path.join(dir, 'village.json'), JSON.stringify(village, null, 2));
    for (const profile of people) {
        writeFileSync(path.join(dir, 'inhabitants', `${profile.id}.json`), JSON.stringify(profile, null, 2));
    }
    return dir;
}

function tempScenario(name, people, options) {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-'));
    const dir = path.join(parent, name);
    writeScenario(dir, people, options);
    return { parent, dir };
}

function loadTemp(dir, runtimeRoot, forLaunch = true) {
    return loadScenario(dir, { reservedNames: RESERVED, runtimeRoot, forLaunch });
}

test('valid scenarios accept one, five, and fifteen inhabitants', () => {
    for (const count of [1, 5, 15]) {
        const people = Array.from({ length: count }, (_, index) => {
            const id = `p${String(index + 1).padStart(2, '0')}`;
            return person(id, `U${String(index + 1).padStart(2, '0')}`);
        });
        const { parent, dir } = tempScenario(`pop-${count}`, people);
        try {
            const bundle = loadTemp(dir, path.join(parent, 'runtime'));
            assert.equal(bundle.inhabitants.length, count);
            assert.equal(bundle.scenario.models.day.model, 'qwen3:8b');
            assert.equal(bundle.scenario.models.dream.model, 'qwen3:14b');
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    }
});

test('the sample village scenario is configuration for five new inhabitants and vacant houses', () => {
    const bundle = loadScenario(path.join('scenarios', 'village-alpha'), { reservedNames: RESERVED, forLaunch: true });
    assert.deepEqual(bundle.inhabitants.map(profile => profile.name), ['Ione', 'Cass', 'Rufus', 'Nell', 'Bram']);
    assert.equal(bundle.village.plots.filter(plot => plot.occupant === null).length, 3);
    assert.equal(bundle.scenario.connection.port, 25566);
    assert.equal(bundle.scenario.settings.allow_insecure_coding, false);
    assert.ok(bundle.village.plots.every(plot => plot.crafting_table && plot.furnace && plot.bed && plot.chest));
    assert.equal(bundle.village.provisions.refill, 'never');
});

test('a sixth inhabitant is admitted by data changes alone', () => {
    const people = Array.from({ length: 5 }, (_, index) => person(`p0${index + 1}`, `U0${index + 1}`));
    const { parent, dir } = tempScenario('six', people, { vacant: 1 });
    const runtimeRoot = path.join(parent, 'runtime');
    try {
        const first = loadTemp(dir, runtimeRoot);
        const admitted = admitPopulation(first, { runtimeRoot, now: () => NOW });
        assert.equal(admitted.records.length, 5);
        const before = readFileSync(path.join(runtimeRoot, 'six', 'p01', 'identity.json'));
        const sixth = person('p06', 'U06');
        const scenario = JSON.parse(readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
        const village = JSON.parse(readFileSync(path.join(dir, 'village.json'), 'utf8'));
        scenario.inhabitants.push('inhabitants/p06.json');
        village.plots.find(plot => plot.occupant === null).occupant = 'p06';
        writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
        writeFileSync(path.join(dir, 'village.json'), JSON.stringify(village, null, 2));
        writeFileSync(path.join(dir, 'inhabitants', 'p06.json'), JSON.stringify(sixth, null, 2));
        const second = loadTemp(dir, runtimeRoot);
        const again = admitPopulation(second, { runtimeRoot, now: () => NOW });
        assert.equal(again.records.length, 6);
        assert.equal(again.records.find(record => record.id === 'p06').created, true);
        assert.equal(readFileSync(path.join(runtimeRoot, 'six', 'p01', 'identity.json')).equals(before), true);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('duplicate ids, duplicate usernames, bad paths, home conflicts, and insecure settings are rejected', () => {
    const cases = [
        {
            name: 'duplicate id',
            build(dir) {
                writeScenario(dir, [person('ada', 'Ada'), person('ben', 'Ben')]);
                writeFileSync(path.join(dir, 'inhabitants', 'ben.json'), readFileSync(path.join(dir, 'inhabitants', 'ada.json')));
            },
            pattern: /duplicate inhabitant id/i,
        },
        {
            name: 'duplicate username',
            build(dir) {
                const ada = person('ada', 'Ada');
                const ben = person('ben', 'Ada');
                writeScenario(dir, [ada, ben]);
            },
            pattern: /duplicate minecraft username/i,
        },
        {
            name: 'escaping path',
            build(dir) {
                writeScenario(dir, [person('ada', 'Ada')], {
                    mutate({ scenario }) { scenario.inhabitants = ['../outside.json']; },
                });
            },
            pattern: /must not contain '\.\.'/,
        },
        {
            name: 'conflicting homes',
            build(dir) {
                writeScenario(dir, [person('ada', 'Ada'), person('ben', 'Ben')], {
                    mutate({ village }) { village.plots[1].occupant = 'ada'; },
                });
            },
            pattern: /conflicting home assignment/i,
        },
        {
            name: 'profile home field',
            build(dir) {
                const ada = person('ada', 'Ada');
                ada.home = 'plot-ada';
                writeScenario(dir, [ada]);
            },
            pattern: /unknown field 'home'/i,
        },
        {
            name: 'insecure coding',
            build(dir) {
                writeScenario(dir, [person('ada', 'Ada')], {
                    mutate({ scenario }) { scenario.settings.allow_insecure_coding = true; },
                });
            },
            pattern: /insecure/i,
        },
        {
            name: 'survival name',
            build(dir) {
                writeScenario(dir, [person('finn', 'Finn')]);
            },
            pattern: /survival-experiment/i,
        },
        {
            name: 'scanner port',
            build(dir) {
                writeScenario(dir, [person('ada', 'Ada')], { port: -1 });
            },
            pattern: /explicit TCP port/i,
        },
    ];
    for (const sample of cases) {
        const parent = mkdtempSync(path.join(os.tmpdir(), 'village-bad-'));
        const dir = path.join(parent, 'bad');
        try {
            sample.build(dir);
            assert.throws(() => loadTemp(dir, path.join(parent, 'runtime')), ScenarioError, sample.name);
            assert.throws(() => loadTemp(dir, path.join(parent, 'runtime')), sample.pattern, sample.name);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    }
});

test('scenario settings do not mutate survival settings, and runtime stays outside bots/', () => {
    const { parent, dir } = tempScenario('iso-a', [person('ada', 'Ada')]);
    const other = tempScenario('iso-b', [person('bea', 'Bea')]);
    const host = rootSettings.host;
    const port = rootSettings.port;
    const version = rootSettings.minecraft_version;
    const auth = rootSettings.auth;
    const message = rootSettings.init_message;
    try {
        const runtimeRoot = path.join(parent, 'runtime');
        const bundle = loadTemp(dir, runtimeRoot);
        const prepared = prepareScenario(bundle, rootSettings, { runtimeRoot, now: () => NOW });
        assert.equal(rootSettings.host, host);
        assert.equal(rootSettings.port, port);
        assert.equal(rootSettings.minecraft_version, version);
        assert.equal(rootSettings.auth, auth);
        assert.equal(rootSettings.init_message, message);
        const agent = prepared.agents[0];
        assert.equal(agent.host, '127.0.0.1');
        assert.equal(agent.port, 25566);
        assert.equal(agent.init_message, null);
        assert.equal(agent.village_autonomy, true);
        assert.equal(agent.allow_insecure_coding, false);
        assert.equal(agent.dream_model.model, 'qwen3:14b');
        assert.equal(agent.profile.model.model, 'qwen3:8b');
        assert.equal(agent.agent_data_root.includes(`${path.sep}bots${path.sep}`), false);
        const second = prepareScenario(loadTemp(other.dir, path.join(other.parent, 'runtime')), rootSettings, {
            runtimeRoot: path.join(other.parent, 'runtime'),
            now: () => NOW,
        });
        assert.notEqual(agent.agent_data_root, second.agents[0].agent_data_root);
        assert.throws(() => assertOutsideSurvivalBots(path.resolve('bots', 'Ada')));
    } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(other.parent, { recursive: true, force: true });
    }
});

test('restart keeps identity, relationships, and history, and a profile edit cannot rewrite the snapshot', () => {
    const { parent, dir } = tempScenario('keep', [person('ada', 'Ada', 'bea'), person('bea', 'Bea')]);
    const runtimeRoot = path.join(parent, 'runtime');
    try {
        const bundle = loadTemp(dir, runtimeRoot);
        admitPopulation(bundle, { runtimeRoot, now: () => NOW });
        const lifeDir = path.join(runtimeRoot, 'keep', 'ada');
        const identity = readFileSync(path.join(lifeDir, 'identity.json'));
        const relationships = readFileSync(path.join(lifeDir, 'relationships.json'));
        const memory = path.join(lifeDir, 'memory.json');
        writeFileSync(memory, '{"memory":"ada was here","turns":[{"role":"assistant","content":"hello"}]}');
        const profilePath = path.join(dir, 'inhabitants', 'ada.json');
        const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
        profile.backstory[0].text = 'A rewritten past that must not stick.';
        profile.profile_version = 2;
        writeFileSync(profilePath, JSON.stringify(profile, null, 2));
        const reloaded = loadTemp(dir, runtimeRoot);
        const again = admitPopulation(reloaded, { runtimeRoot, now: () => '2026-11-15T13:00:00.000Z' });
        assert.equal(again.records.find(record => record.id === 'ada').created, false);
        assert.equal(readFileSync(path.join(lifeDir, 'identity.json')).equals(identity), true);
        assert.equal(readFileSync(path.join(lifeDir, 'relationships.json')).equals(relationships), true);
        assert.match(readFileSync(memory, 'utf8'), /ada was here/);
        const life = readLife(lifeDir);
        assert.equal(life.lifecycle, 'admitted');
        assert.equal(life.identity_mismatch.file_profile_version, 2);
        assert.notEqual(life.identity_mismatch.file_checksum, life.identity_mismatch.snapshot_checksum);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('removing a person from the scenario does not delete history or mark them dead', () => {
    const { parent, dir } = tempScenario('leave', [person('ada', 'Ada'), person('bea', 'Bea')]);
    const runtimeRoot = path.join(parent, 'runtime');
    try {
        admitPopulation(loadTemp(dir, runtimeRoot), { runtimeRoot, now: () => NOW });
        const scenario = JSON.parse(readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
        scenario.inhabitants = ['inhabitants/ada.json'];
        writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
        const village = JSON.parse(readFileSync(path.join(dir, 'village.json'), 'utf8'));
        assert.equal(village.plots.find(plot => plot.id === 'plot-bea').occupant, 'bea');
        const admitted = admitPopulation(loadTemp(dir, runtimeRoot), { runtimeRoot, now: () => NOW });
        assert.deepEqual(admitted.records.map(record => record.id), ['ada']);
        const bea = path.join(runtimeRoot, 'leave', 'bea');
        assert.equal(existsSync(path.join(bea, 'identity.json')), true);
        assert.equal(readLife(bea).lifecycle, 'admitted');
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('a dead inhabitant is refused by launch, auto-restart, and operator start', async () => {
    const { parent, dir } = tempScenario('dead', [person('ada', 'Ada')]);
    const runtimeRoot = path.join(parent, 'runtime');
    try {
        const prepared = prepareScenario(loadTemp(dir, runtimeRoot), rootSettings, { runtimeRoot, now: () => NOW });
        const dataRoot = prepared.agents[0].agent_data_root;
        markDeadForTest(dataRoot);
        assert.throws(() => transitionLife(readLife(dataRoot), 'alive', 'start'), /terminal/);
        assert.equal(beginProcess(dataRoot).ok, false);
        assert.equal(readLife(dataRoot).lifecycle, 'dead');
        const crashed = recordProcessExit(dataRoot, { code: 1, signal: null });
        assert.equal(crashed.restart, false);
        assert.equal(readLife(dataRoot).lifecycle, 'dead');
        const operator = new AgentProcess('Ada', 1, 'token', { dataRoot });
        operator.start(true, null, 0);
        assert.match(operator.refused, /dead/i);
        assert.equal(operator.process, undefined);
        operator.forceRestart();
        assert.match(operator.refused, /dead/i);
        assert.equal(operator.running, false);
        const relaunch = prepareScenario(loadTemp(dir, runtimeRoot), rootSettings, { runtimeRoot, now: () => NOW });
        assert.equal(relaunch.launchable.length, 0);
        assert.equal(relaunch.refused.length, 1);
        assert.equal(existsSync(path.join(dataRoot, 'identity.json')), true);
        const launched = await createAgent(prepared.agents[0]);
        assert.equal(launched.success, false);
        assert.match(launched.error, /dead/i);
        const missing = await createAgent({ ...prepared.agents[0], agent_data_root: path.join(parent, 'no-such-life') });
        assert.equal(missing.success, false);
        assert.match(missing.error, /Missing life record/);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('a crash, disconnect, or operator stop is absence and a living inhabitant can recover', () => {
    const { parent, dir } = tempScenario('away', [person('ada', 'Ada')]);
    const runtimeRoot = path.join(parent, 'runtime');
    try {
        const prepared = prepareScenario(loadTemp(dir, runtimeRoot), rootSettings, { runtimeRoot, now: () => NOW });
        const dataRoot = prepared.agents[0].agent_data_root;
        assert.equal(beginProcess(dataRoot).ok, true);
        assert.equal(readLife(dataRoot).lifecycle, 'alive');
        const crashed = recordProcessExit(dataRoot, { code: 1, signal: null });
        assert.equal(crashed.restart, true);
        assert.equal(readLife(dataRoot).lifecycle, 'absent');
        assert.equal(beginProcess(dataRoot).life.lifecycle, 'alive');
        const disconnected = recordProcessExit(dataRoot, { code: 1, signal: null });
        assert.equal(disconnected.restart, true);
        assert.equal(readLife(dataRoot).lifecycle, 'absent');
        assert.equal(beginProcess(dataRoot).ok, true);
        const stopped = recordProcessExit(dataRoot, { code: 0, signal: 'SIGINT' });
        assert.equal(stopped.restart, false);
        assert.equal(readLife(dataRoot).lifecycle, 'absent');
        assert.notEqual(readLife(dataRoot).lifecycle, 'dead');
        assert.equal(beginProcess(dataRoot).ok, true);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('village autonomy does not inherit the survival settlement goal or stop without an intention', () => {
    const survival = resolveStartupGoal({
        saved: null,
        initMessage: null,
        directive: rootSettings.init_message,
    });
    assert.match(survival.goal, /settlement|Survive/i);
    assert.equal(usableGoal(VILLAGE_AUTONOMY_PREAMBLE), null);
    assert.equal(resolveVillageAutonomy({ saved: null, villageAutonomy: false }).mode, 'none');
    const village = resolveVillageAutonomy({ saved: null, villageAutonomy: true });
    assert.equal(village.mode, 'autonomous');
    assert.equal(village.goal, null);
    assert.equal(village.preamble, VILLAGE_AUTONOMY_PREAMBLE);
    assert.doesNotMatch(village.preamble, /settlement/i);
    const resumed = resolveVillageAutonomy({ saved: 'Visit Nell tomorrow.', villageAutonomy: true });
    assert.equal(resumed.mode, 'autonomous');
    assert.equal(resumed.goal, null);
    assert.equal(resumed.ignoredSavedGoal, 'Visit Nell tomorrow.');
});

test('village persistence files are written under the scenario runtime, not bots/', () => {
    const { parent, dir } = tempScenario('files', [person('ada', 'Ada')]);
    const runtimeRoot = path.join(parent, 'runtime');
    const previous = { ...rootSettings };
    try {
        const prepared = prepareScenario(loadTemp(dir, runtimeRoot), rootSettings, { runtimeRoot, now: () => NOW });
        const dataRoot = prepared.agents[0].agent_data_root;
        setSettings({ agent_data_root: dataRoot, persistent_planning: true });
        const agent = {
            name: 'Ada',
            self_prompter: { state: 0, prompt: '', isStopped: () => true },
            task: { taskStartTime: null },
            last_sender: null,
            prompter: { profile: { persistent_planning: true } },
        };
        const history = new History(agent);
        history.memory = 'kept';
        history.turns = [];
        history.save();
        assert.equal(existsSync(path.join(dataRoot, 'memory.json')), true);
        assert.equal(existsSync(path.join('bots', 'Ada', 'memory.json')), false);
        const plans = new PlanManager(agent, path.join(parent, 'should-not-use'));
        assert.equal(plans.file, path.join(dataRoot, 'plan.json'));
        assert.equal(plans.file.includes(`${path.sep}bots${path.sep}`), false);
        void previous;
    } finally {
        setSettings({});
        rmSync(parent, { recursive: true, force: true });
    }
});
