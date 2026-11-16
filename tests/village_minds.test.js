import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { setSettings } from '../src/agent/settings.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import { getCommandDocs } from '../src/agent/commands/index.js';
import convoManager from '../src/agent/conversation.js';
import { loadScenario } from '../src/village/load.js';
import { admitInhabitant, admitPopulation } from '../src/village/admit.js';
import { readLife } from '../src/village/life.js';
import { beginProcess, recordProcessExit } from '../src/village/supervise.js';
import { appendEpisode, readEpisodes, splitEpisodes } from '../src/village/episodes.js';
import { expressStance, readRelationships } from '../src/village/relationships.js';
import { readKnowledge } from '../src/village/knowledge.js';
import { renderVillageContext, SHARED_GAMEPLAY_LINE } from '../src/village/context.js';
import { acceptInWorldSpeech, claimSpeech, resetSpeechClaims, speakerDistance } from '../src/village/locality.js';
import { buildDeathFacts, recordDeathKnowledge, recordVerifiedDeath } from '../src/village/death.js';
import { episodeForAction } from '../src/village/experience.js';
import { assertRemainsTarget, chooseEvidenceColumn, interpretBlockProbe, placeConfiguredRemains, planRemains, readableRemains } from '../src/village/remains.js';
import { writeLife } from '../src/village/life.js';
import { activityNeedsPlan, VILLAGE_AUTONOMY_PREAMBLE, villageDecisionMessage } from '../src/agent/startup_goal.js';

const RESERVED = ['Finn', 'Sawyer', 'Milo', 'Jasper', 'Rowan'];
const NOW = '2026-11-15T18:00:00.000Z';

function person(id, name, backstory) {
    return {
        schema_version: 1,
        id,
        name,
        profile_version: 1,
        backstory: [{ id: 'self', text: backstory }],
        temperament: [`${name} decides without a script.`],
        interests: ['walking'],
        seed_relationships: [],
    };
}

function writeScenario(dir, people) {
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
    const scenario = {
        schema_version: 1,
        id: path.basename(dir),
        title: 'Minds fixture',
        connection: { host: '127.0.0.1', port: 25567, minecraft_version: '1.21.6', auth: 'offline' },
        models: {
            day: { api: 'ollama', model: 'qwen3:8b' },
            dream: { api: 'ollama', model: 'qwen3:14b' },
        },
        inhabitants: people.map(profile => `inhabitants/${profile.id}.json`),
        village: 'village.json',
        settings: {
            base_profile: 'survival',
            allow_insecure_coding: false,
            load_memory: true,
            permanent_death: true,
            hearing_blocks: 32,
        },
    };
    const village = {
        schema_version: 1,
        id: `${scenario.id}-places`,
        spawn_dimension: 'overworld',
        plots,
        public: [
            { id: 'square', marker: [0, 64, 20] },
            { id: 'common-house', marker: [5, 64, 20] },
        ],
        provisions: {
            per_home: { food: [{ item: 'bread', count: 4 }], tools: ['stone_pickaxe'], also: ['crafting_table'] },
            refill: 'never',
        },
        paths: plots.map(plot => ({ from: plot.id, to: 'square', walkable_without_breaking: true })),
    };
    writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
    writeFileSync(path.join(dir, 'village.json'), JSON.stringify(village, null, 2));
    for (const profile of people) {
        writeFileSync(path.join(dir, 'inhabitants', `${profile.id}.json`), JSON.stringify(profile, null, 2));
    }
    return { scenario, village };
}

function tempPopulation(people) {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-minds-'));
    const dir = path.join(parent, 'minds');
    writeScenario(dir, people);
    const runtimeRoot = path.join(parent, 'runtime');
    const bundle = loadScenario(dir, { reservedNames: RESERVED, runtimeRoot, forLaunch: true });
    const admitted = admitPopulation(bundle, { runtimeRoot, now: () => NOW });
    return { parent, bundle, admitted, runtimeRoot };
}

test('two inhabitants get different identities and the same gameplay baseline', () => {
    const ada = person('ada', 'Ada', 'Ada keeps a quiet house and prefers the square.');
    const ben = person('ben', 'Ben', 'Ben likes mending fences and saying little.');
    const { parent, admitted } = tempPopulation([ada, ben]);
    try {
        const adaDir = admitted.records.find(record => record.id === 'ada').directory;
        const benDir = admitted.records.find(record => record.id === 'ben').directory;
        const adaContext = renderVillageContext(adaDir);
        const benContext = renderVillageContext(benDir);
        assert.match(adaContext.text, /Ada keeps a quiet house/);
        assert.match(benContext.text, /Ben likes mending fences/);
        assert.equal(adaContext.text.includes('mending fences'), false);
        assert.equal(benContext.text.includes('quiet house'), false);
        assert.equal(adaContext.text.includes(SHARED_GAMEPLAY_LINE), true);
        assert.equal(benContext.text.includes(SHARED_GAMEPLAY_LINE), true);
        assert.ok(adaContext.chars < 2500);
        assert.ok(benContext.chars < 2500);
        console.log(`[village-context] Ada ${adaContext.chars} chars, Ben ${benContext.chars} chars`);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('an edited profile cannot rewrite an admitted backstory', () => {
    const ada = person('ada', 'Ada', 'Ada remembers the admission text.');
    const { parent, bundle, admitted } = tempPopulation([ada]);
    try {
        const dir = admitted.records[0].directory;
        ada.backstory = [{ id: 'self', text: 'This edited profile must not replace the snapshot.' }];
        ada.profile_version = 2;
        writeFileSync(path.join(bundle.directory, 'inhabitants', 'ada.json'), JSON.stringify(ada, null, 2));
        const reloaded = loadScenario(bundle.directory, { reservedNames: RESERVED, runtimeRoot: path.join(parent, 'runtime'), forLaunch: true });
        admitInhabitant(reloaded, reloaded.inhabitants[0], { runtimeRoot: path.join(parent, 'runtime'), now: () => NOW });
        const context = renderVillageContext(dir);
        assert.match(context.text, /Ada remembers the admission text/);
        assert.equal(context.text.includes('must not replace'), false);
        const identity = JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8'));
        assert.match(identity.backstory[0].text, /admission text/);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('home knowledge is isolated and a live chest overrides the admission list', () => {
    const ada = person('ada', 'Ada', 'Ada lives here.');
    const ben = person('ben', 'Ben', 'Ben lives next door.');
    const { parent, admitted } = tempPopulation([ada, ben]);
    try {
        const adaDir = admitted.records.find(record => record.id === 'ada').directory;
        const benDir = admitted.records.find(record => record.id === 'ben').directory;
        const adaKnowledge = readKnowledge(adaDir);
        const benKnowledge = readKnowledge(benDir);
        assert.deepEqual(adaKnowledge.home.chest, [0, 64, 2]);
        assert.deepEqual(benKnowledge.home.chest, [1, 64, 2]);
        assert.equal(JSON.stringify(adaKnowledge).includes('1,64,2') || JSON.stringify(adaKnowledge.home).includes('[1,64,2]'), false);
        assert.equal(adaKnowledge.public_places.some(place => place.id === 'ben'), false);
        const remembered = renderVillageContext(adaDir);
        assert.match(remembered.text, /bread x4/);
        assert.match(remembered.text, /not a live inventory|Inspect the chest/);
        const looked = renderVillageContext(adaDir, { liveChest: [{ item: 'apple', count: 2 }] });
        assert.match(looked.text, /apple x2/);
        assert.match(looked.text, /Trust that inspection/);
        assert.equal(looked.text.includes(benKnowledge.home.chest.join(', ')), false);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('no lifelong goal is required, and talking does not require a plan', async () => {
    assert.equal(activityNeedsPlan('talk'), false);
    assert.equal(activityNeedsPlan('visit'), false);
    assert.match(villageDecisionMessage(), /pursue your ambition/);
    assert.match(villageDecisionMessage(), /Staying still for a while is a complete choice/);
    assert.doesNotMatch(villageDecisionMessage(), /MUST contain a command|no assigned quest|not required to sleep/);
    let prompts = 0;
    let planned = false;
    const agent = {
        name: 'Ada',
        shut_up: false,
        isIdle: () => true,
        actions: { stop: async () => {} },
        bot: {},
        history: { add: async () => {}, save: async () => {}, turns: [] },
        plan_manager: { ensurePlan: async () => { planned = true; } },
    };
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.village_interval = 1;
    agent.handleMessage = async (_source, message) => {
        prompts++;
        assert.match(message, /Staying still for a while is a complete choice/);
        if (prompts === 2) agent.self_prompter.stop(false);
        return false;
    };
    agent.self_prompter.start(VILLAGE_AUTONOMY_PREAMBLE);
    while (agent.self_prompter.loop_active) {
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(planned, false);
    assert.equal(prompts >= 2, true);
});

test('episodes dedupe, keep their source, and survive a new read', () => {
    const { parent, admitted } = tempPopulation([person('ada', 'Ada', 'Ada lives here.')]);
    try {
        const dir = admitted.records[0].directory;
        const first = appendEpisode(dir, {
            kind: 'action',
            source: 'verified',
            text: 'I inspected a container.',
            refs: ['container'],
            at: NOW,
        });
        const second = appendEpisode(dir, {
            kind: 'action',
            source: 'verified',
            text: 'I inspected a container.',
            refs: ['container'],
            at: NOW,
        });
        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(second.episode.id, first.episode.id);
        const reloaded = readEpisodes(dir);
        assert.equal(reloaded.episodes.length, 1);
        assert.equal(reloaded.episodes[0].source, 'verified');
        for (let index = 0; index < 20; index++) {
            appendEpisode(dir, {
                kind: 'observed',
                source: 'observed',
                text: `I noticed something distinct ${index}.`,
                refs: [],
                at: `2026-11-15T18:${String(index).padStart(2, '0')}:00.000Z`,
            });
        }
        const grown = readEpisodes(dir);
        const split = splitEpisodes(grown);
        assert.equal(grown.episodes.length, 21);
        assert.equal(split.archive.length, 21 - 12);
        assert.equal(split.recent.length, 12);
        assert.equal(episodeForAction({ commandName: '!goToCoordinates', failed: false, resultText: 'moved' }), null);
        assert.equal(episodeForAction({ commandName: '!takeFromChest', failed: false, resultText: 'ok' }).refs.includes('container'), true);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('a conversation witnessed by two people is absent from a third memory', () => {
    const people = [
        person('ada', 'Ada', 'ada has a private life.'),
        person('ben', 'Ben', 'ben has a private life.'),
        person('cyn', 'Cyn', 'cyn has a private life.'),
    ];
    const { parent, admitted } = tempPopulation(people);
    try {
        const dirs = Object.fromEntries(admitted.records.map(record => [record.id, record.directory]));
        const text = 'Ada said: the bread was warm.';
        appendEpisode(dirs.ada, { kind: 'conversation', source: 'observed', text, refs: ['Ben'], at: NOW });
        appendEpisode(dirs.ben, { kind: 'conversation', source: 'observed', text, refs: ['Ada'], at: NOW });
        const cy = renderVillageContext(dirs.cyn);
        assert.equal(readEpisodes(dirs.cyn).episodes.length, 0);
        assert.equal(cy.text.includes('bread was warm'), false);
        assert.equal(cy.text.includes('Ada said'), false);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('private relationships can disagree and can name a human', () => {
    const ada = person('ada', 'Ada', 'Ada lives here.');
    const ben = person('ben', 'Ben', 'Ben lives here.');
    const { parent, admitted } = tempPopulation([ada, ben]);
    try {
        const adaDir = admitted.records.find(record => record.id === 'ada').directory;
        const benDir = admitted.records.find(record => record.id === 'ben').directory;
        appendEpisode(adaDir, { kind: 'conversation', source: 'observed', text: 'Ben said hello.', refs: ['ben'], at: NOW });
        appendEpisode(benDir, { kind: 'conversation', source: 'observed', text: 'Ada said hello.', refs: ['ada'], at: NOW });
        appendEpisode(adaDir, { kind: 'conversation', source: 'observed', text: 'Sam said they were visiting.', refs: ['Sam'], at: NOW });
        const adaStance = expressStance(adaDir, { other_id: 'ben', other_kind: 'inhabitant', stance: 'close', note: 'Ben came by.', now: () => NOW });
        const benStance = expressStance(benDir, { other_id: 'ada', other_kind: 'inhabitant', stance: 'acquaintance', note: 'Ada is only familiar.', now: () => NOW });
        const human = expressStance(adaDir, { other_id: 'Sam', other_kind: 'human', stance: 'wary', note: 'Sam arrived unannounced.', now: () => NOW });
        assert.equal(adaStance.ok, true);
        assert.equal(benStance.ok, true);
        assert.equal(human.ok, true);
        assert.equal(readRelationships(adaDir).relationships.ben.stance, 'close');
        assert.equal(readRelationships(benDir).relationships.ada.stance, 'acquaintance');
        assert.equal(readRelationships(adaDir).relationships.Sam.other_kind, 'human');
        assert.equal(readRelationships(benDir).relationships.Sam, undefined);
        const refused = expressStance(benDir, { other_id: 'nobody', other_kind: 'human', stance: 'friend', note: 'guessing', now: () => NOW });
        assert.equal(refused.ok, false);
        const adaPrompt = renderVillageContext(adaDir);
        const benPrompt = renderVillageContext(benDir);
        assert.match(adaPrompt.text, /close/);
        assert.equal(benPrompt.text.includes('came by'), false);
        assert.match(adaPrompt.text, /human/);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('a normal block probe is not treated as an unloaded chunk', () => {
    assert.deepEqual(interpretBlockProbe('Test passed', 'air'), { loaded: true, block: 'air' });
    assert.deepEqual(interpretBlockProbe('Test failed', 'air'), { loaded: true, block: null });
    assert.deepEqual(interpretBlockProbe('That position is not loaded', 'air'), { loaded: false, block: null });
    assert.equal(interpretBlockProbe('The target block is not a block entity', 'air').loaded, false);
});

test('the same utterance is claimed once across public and direct copies', () => {
    resetSpeechClaims();
    assert.equal(claimSpeech('Holt', 'The bell is loud today.', 1000), true);
    assert.equal(claimSpeech('Holt', '(To Wynn) The bell is loud today.', 1200), false);
    assert.equal(claimSpeech('Holt', '(FROM OTHER BOT)The bell is loud today.', 1400), false);
    assert.equal(claimSpeech('Nia', 'The bell is loud today.', 1400), true);
    assert.equal(claimSpeech('Holt', 'The bell is loud today.', 5000), true);
    resetSpeechClaims();
});

test('local speech does not reach a remote listener', async () => {
    const near = { x: 0, y: 64, z: 0 };
    const far = { x: 0, y: 64, z: 80 };
    const speaker = { x: 2, y: 64, z: 1 };
    assert.equal(acceptInWorldSpeech({ village: true, distance: 3, range: 32 }), true);
    assert.equal(acceptInWorldSpeech({ village: true, distance: 40, range: 32 }), false);
    assert.equal(acceptInWorldSpeech({ village: true, distance: null, range: 32 }), false);
    assert.equal(acceptInWorldSpeech({ village: false, distance: null }), true);
    const bot = {
        entity: { position: near },
        players: { Ben: { entity: { position: speaker } } },
    };
    assert.ok(speakerDistance(bot, 'Ben') < 32);
    assert.equal(speakerDistance(bot, 'Cy'), null);
    setSettings({ village_autonomy: true, village_hearing_blocks: 32 });
    try {
        convoManager.initAgent({
            name: 'Ada',
            bot: { entity: { position: far }, players: { Ben: { entity: { position: speaker } } } },
        });
        await convoManager.receiveFromBot('Ben', { message: 'a private remark', start: true });
        assert.equal(convoManager.inConversation(), false);
    } finally {
        setSettings({});
    }
});

test('a prompt does not open another life, the registry, or a death record', () => {
    const ada = person('ada', 'Ada', 'Ada keeps her own counsel.');
    const ben = person('ben', 'Ben', 'SECRET-BEN-BACKSTORY stays in Ben files.');
    const { parent, admitted, runtimeRoot } = tempPopulation([ada, ben]);
    try {
        const adaDir = admitted.records.find(record => record.id === 'ada').directory;
        const benDir = admitted.records.find(record => record.id === 'ben').directory;
        const life = readLife(benDir);
        life.death = { cause: 'SECRET-DEATH-CAUSE', position: { x: 9, y: 9, z: 9 } };
        writeFileSync(path.join(benDir, 'life.json'), JSON.stringify(life, null, 2));
        writeFileSync(path.join(runtimeRoot, 'minds', 'registry.json'), JSON.stringify({ secret: 'SECRET-REGISTRY' }));
        const context = renderVillageContext(adaDir);
        assert.equal(context.text.includes('SECRET-BEN-BACKSTORY'), false);
        assert.equal(context.text.includes('SECRET-DEATH-CAUSE'), false);
        assert.equal(context.text.includes('SECRET-REGISTRY'), false);
        for (const file of context.files) {
            assert.ok(['identity.json', 'knowledge.json', 'relationships.json', 'episodes.json', 'morning.json', 'intentions.json'].includes(file));
        }
        assert.equal(context.files.includes('life.json'), false);
        assert.equal(context.files.includes('registry.json'), false);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('verified death is terminal on every start path, and a crash is not death', () => {
    const { parent, admitted, bundle, runtimeRoot } = tempPopulation([
        person('ada', 'Ada', 'Ada lives here.'),
        person('ben', 'Ben', 'Ben lives here.'),
    ]);
    try {
        const adaDir = admitted.records.find(record => record.id === 'ada').directory;
        const benDir = admitted.records.find(record => record.id === 'ben').directory;
        beginProcess(adaDir);
        const facts = buildDeathFacts({
            at: NOW,
            position: { x: 3, y: 64, z: 3 },
            dimension: 'overworld',
            translate: 'death.attack.generic',
            message: 'Ada died',
            name: 'Ada',
            site: null,
        });
        assert.equal(facts.cause, null);
        const first = recordVerifiedDeath(adaDir, facts);
        assert.equal(first.created, true);
        assert.equal(first.life.lifecycle, 'dead');
        const withCause = buildDeathFacts({
            at: NOW,
            position: { x: 3, y: 64, z: 3 },
            dimension: 'overworld',
            translate: 'death.fell.accident.water',
            message: 'Ada fell',
            name: 'Ada',
        });
        const second = recordVerifiedDeath(adaDir, withCause);
        assert.equal(second.created, false);
        assert.equal(second.updated, true);
        assert.equal(second.life.death.cause, 'death.fell.accident.water');
        const third = recordVerifiedDeath(adaDir, withCause);
        assert.equal(third.updated, false);
        assert.equal(beginProcess(adaDir).ok, false);
        assert.equal(recordProcessExit(adaDir, { code: 1 }).restart, false);
        assert.equal(recordProcessExit(adaDir, { code: 1, signal: 'SIGINT' }).restart, false);
        const relaunch = admitPopulation(bundle, { runtimeRoot, now: () => NOW });
        assert.equal(relaunch.refused.some(record => record.id === 'ada'), true);
        assert.equal(relaunch.launchable.some(record => record.id === 'ada'), false);
        beginProcess(benDir);
        const crashed = recordProcessExit(benDir, { code: 1 });
        assert.equal(crashed.restart, true);
        assert.equal(readLife(benDir).lifecycle, 'absent');
        assert.equal(readLife(benDir).death, null);
        assert.equal(readEpisodes(benDir).episodes.some(episode => episode.text.includes('died')), false);
        const identity = readFileSync(path.join(adaDir, 'identity.json'), 'utf8');
        assert.match(identity, /Ada lives here/);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('a witnessed death, a later discovery, and a retelling stay separate', () => {
    const people = [
        person('ada', 'Ada', 'ada has a private life.'),
        person('ben', 'Ben', 'ben has a private life.'),
        person('cyn', 'Cyn', 'cyn has a private life.'),
    ];
    const { parent, admitted } = tempPopulation(people);
    try {
        const dirs = Object.fromEntries(admitted.records.map(record => [record.id, record.directory]));
        recordDeathKnowledge(dirs.ada, {
            channel: 'witness',
            text: 'I saw Ben fall at the square.',
            refs: ['Ben'],
        });
        const witness = readEpisodes(dirs.ada).episodes.at(-1);
        assert.equal(witness.kind, 'observed');
        assert.equal(witness.source, 'observed');
        recordDeathKnowledge(dirs.cyn, {
            channel: 'discovery',
            text: 'I found a marker reading "Ben".',
            refs: ['remains', 'Ben'],
        });
        recordDeathKnowledge(dirs.cyn, {
            channel: 'told',
            speaker: 'Ada',
            text: 'Ada said Ben fell at the square.',
            refs: ['Ben'],
        });
        const cy = readEpisodes(dirs.cyn).episodes;
        assert.equal(cy.length, 2);
        assert.equal(cy[0].kind, 'observed');
        assert.equal(cy[1].kind, 'told');
        assert.equal(cy[1].source, 'told');
        assert.equal(cy[1].refs.includes('Ada'), true);
        const benPrompt = renderVillageContext(dirs.ben);
        assert.equal(benPrompt.text.includes('I saw Ben fall'), false);
        assert.equal(benPrompt.text.includes('marker'), false);
        assert.equal(readEpisodes(dirs.ben).episodes.length, 0);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('remains plans are idempotent and refuse unsafe sites and protected worlds', () => {
    const site = { block: 'grass_block' };
    const planned = planRemains({
        position: { x: 1.2, y: 64, z: 3.4 },
        dimension: 'overworld',
        name: 'Ada',
        site,
    });
    assert.equal(planned.status, 'planned');
    assert.equal(planned.kind, 'named_armor_stand');
    const again = planRemains({
        position: { x: 9, y: 9, z: 9 },
        site: { block: 'lava' },
        existing: planned,
    });
    assert.equal(again.idempotent, true);
    assert.equal(again.id, planned.id);
    assert.equal(planRemains({ position: { x: 0, y: 64, z: 0 }, site: { block: 'lava' } }).reason, 'lava');
    assert.equal(planRemains({ position: { x: 0, y: -80, z: 0 }, site: { block: 'air' } }).reason, 'void');
    assert.equal(planRemains({ position: { x: 0, y: 64, z: 0 }, site: { block: 'chest' } }).reason, 'would overwrite belongings or a fixture');
    assert.equal(planRemains({ position: { x: 0, y: 64, z: 0 }, site: { block: 'water' } }).status, 'planned');
    assert.equal(planRemains({ position: { x: 0, y: 64, z: 0 }, site: null }).reason, 'not_attempted');
    assert.equal(readableRemains({ name: 'armor_stand', metadata: [{}, {}, { value: '{"text":"Ada"}' }], id: 4 }).label, 'Ada');
    assert.equal(readableRemains({ name: 'armor_stand', customName: 'Ada', id: 5 }).label, 'Ada');
    assert.equal(readableRemains({ name: 'armor_stand', tags: ['village_remains'] }), null);
    assert.equal(readableRemains({ name: 'player', customName: 'Ada' }), null);
    assert.throws(() => assertRemainsTarget({ container: 'ai-village', dataDir: '/tmp/other' }), /survival/);
    assert.throws(() => assertRemainsTarget({ container: 'village-alpha', dataDir: '/tmp/other' }), /Village Alpha/);
    assert.equal(assertRemainsTarget({ container: 'village-m3-smoke', dataDir: '/tmp/smoke' }), true);
});

test('a fifteenth inhabitant uses the same identity, home, and memory path', () => {
    const people = Array.from({ length: 15 }, (_, index) => {
        const id = `p${String(index + 1).padStart(2, '0')}`;
        return person(id, `U${String(index + 1).padStart(2, '0')}`, `Private story ${id} only.`);
    });
    const { parent, admitted } = tempPopulation(people);
    try {
        assert.equal(admitted.launchable.length, 15);
        const last = admitted.records.find(record => record.id === 'p15');
        const first = admitted.records.find(record => record.id === 'p01');
        const context = renderVillageContext(last.directory);
        assert.match(context.text, /Private story p15 only/);
        assert.equal(context.text.includes('Private story p01'), false);
        assert.deepEqual(readKnowledge(last.directory).home.chest, [14, 64, 2]);
        assert.deepEqual(readKnowledge(first.directory).home.chest, [0, 64, 2]);
        appendEpisode(last.directory, {
            kind: 'observed',
            source: 'observed',
            text: 'I looked at the square.',
            refs: ['square'],
            at: NOW,
        });
        assert.equal(readEpisodes(first.directory).episodes.length, 0);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('death remains are chosen without overwriting a chest and are not sent to Village Alpha', () => {
    const feet = { x: 1.4, y: 64.2, z: -3.2 };
    assert.deepEqual(chooseEvidenceColumn(feet, { '1,64,-4': 'air', '1,65,-4': 'air' }).y, 64);
    assert.equal(chooseEvidenceColumn(feet, { '1,64,-4': 'chest', '1,65,-4': 'air' }).y, 65);
    assert.equal(chooseEvidenceColumn(feet, { '1,64,-4': 'lava', '1,65,-4': 'lava' }).reason, 'lava');
    assert.equal(chooseEvidenceColumn({ x: 0, y: -80, z: 0 }, {}).reason, 'void');
    const { parent, admitted } = tempPopulation([person('ada', 'Ada', 'Ada lives here.')]);
    try {
        const dir = admitted.records[0].directory;
        const life = readLife(dir);
        life.lifecycle = 'dead';
        life.death = { at: NOW, position: { x: 1.4, y: 64.2, z: -3.2 }, cause: null, evidence: null };
        writeLife(dir, life);
        assert.throws(() => placeConfiguredRemains({
            village_remains_container: 'village-alpha',
            agent_data_root: dir,
            profile: { name: 'Ada' },
        }), /Village Alpha/);
        const commands = [];
        const placed = placeConfiguredRemains({
            village_remains_container: 'village-m3-smoke',
            agent_data_root: dir,
            profile: { name: 'Ada' },
        }, {
            run(command) {
                commands.push(command);
                if (command.includes('minecraft:air')) return 'Test passed';
                if (command.startsWith('execute if block')) return 'Test failed';
                return 'Summoned new Armor Stand';
            },
        });
        assert.equal(placed.status, 'placed');
        assert.equal(commands.filter(command => command.startsWith('summon') || command.includes('summon')).length, 1);
        const again = placeConfiguredRemains({
            village_remains_container: 'village-m3-smoke',
            agent_data_root: dir,
            profile: { name: 'Ada' },
        }, { run() { throw new Error('should not place twice'); } });
        assert.equal(again.status, 'placed');
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('survival command docs hide the village stance command', () => {
    const agent = { blocked_actions: [], plan_manager: { enabled: false } };
    setSettings({ village_autonomy: false });
    try {
        assert.equal(getCommandDocs(agent).includes('!stance'), false);
        setSettings({ village_autonomy: true });
        assert.equal(getCommandDocs(agent).includes('!stance'), true);
    } finally {
        setSettings({});
    }
});

test('known places survive a new memory bank', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-places-'));
    try {
        const file = path.join(parent, 'places.json');
        const first = new MemoryBank();
        first.bindPlaceFile(file, { home: [1, 64, 1] });
        first.rememberPlace('square', 0, 64, 20);
        const second = new MemoryBank();
        second.bindPlaceFile(file, { home: [9, 9, 9] });
        assert.deepEqual(second.recallPlace('home'), [1, 64, 1]);
        assert.deepEqual(second.recallPlace('square'), [0, 64, 20]);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('the real village scenario accepts permanent death without being admitted here', () => {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'village-alpha-check-'));
    try {
        const bundle = loadScenario(path.join('scenarios', 'village-alpha'), {
            reservedNames: RESERVED,
            runtimeRoot,
            forLaunch: true,
        });
        assert.equal(bundle.scenario.settings.permanent_death, true);
        assert.equal(bundle.scenario.settings.hearing_blocks, 32);
        assert.equal(bundle.inhabitants.length, 8);
    } finally {
        rmSync(runtimeRoot, { recursive: true, force: true });
    }
});
