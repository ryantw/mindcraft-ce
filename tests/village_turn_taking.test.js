import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { setSettings } from '../src/agent/settings.js';
import { Agent } from '../src/agent/agent.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import { Prompter } from '../src/models/prompter.js';
import { formatCommandSignature, parseCommandMessage } from '../src/agent/commands/index.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';
import { VILLAGE_AUTONOMY_PREAMBLE, villageDecisionMessage } from '../src/agent/startup_goal.js';
import { noteVerifiedProgress, readIntentions, updateIntention } from '../src/village/intentions.js';
import { renderVillageContext } from '../src/village/context.js';
import { readEpisodes } from '../src/village/episodes.js';
import { claimSpeech, isDelayedMirror, rememberInWorldSpeech, resetSpeechClaims } from '../src/village/locality.js';
import { createTurnQueue, largelyOverlaps, noteSpeechTurn, observePeerSpeech, VILLAGE_SPEECH_RECOVERY } from '../src/village/turn_taking.js';

initializeMinecraftData('1.21.6');

const NOW = '2026-11-15T19:40:00.000Z';
const EXPLORE = "I'll explore the area around the home to see what unfamiliar things might be found.";
const INTENTION = 'Explore the area around the home to see what unfamiliar things might be found.';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('village daytime scheduling', { concurrency: 1 }, () => {

function decisionAgent(promptConvo) {
    const turns = [];
    const routed = [];
    const agent = {
        ready: true,
        name: 'Cass',
        turns,
        routed,
        shut_up: false,
        blocked_actions: [],
        checkTaskDone: async () => {},
        history: {
            turns,
            add: async (name, content) => turns.push({ name, content }),
            save() {},
            getHistory() { return turns.map(turn => ({ role: turn.name === 'Cass' ? 'assistant' : 'user', content: turn.content })); },
        },
        self_prompter: {
            shouldInterrupt: () => false,
            isActive: () => true,
            handleUserPromptedCmd() {},
        },
        bot: { modes: { flushBehaviorLog: () => '' } },
        prompter: {
            most_recent_msg_time: 0,
            promptConvo,
        },
        plan_manager: { enabled: false, observeOutcome: () => ({}) },
        routeResponse(_source, text) { routed.push(text); },
    };
    agent.handleMessage = Agent.prototype.handleMessage;
    agent._handleVillageOrSurvivalMessage = Agent.prototype._handleVillageOrSurvivalMessage;
    return agent;
}

test('repeated speech is recognized without treating it as progress', () => {
    assert.equal(largelyOverlaps(EXPLORE, INTENTION), true);
    assert.equal(largelyOverlaps("Let's go to the woods.", "Let's go to the woods."), true);
    assert.equal(largelyOverlaps('The chest held a map.', 'The flowers by the door need water.'), false);

    let state = noteSpeechTurn(null, { text: EXPLORE, acted: false });
    assert.equal(state.stalled, false);
    state = noteSpeechTurn(state, { text: "I'll explore the area around the home and see what unfamiliar things might be found.", acted: false });
    assert.equal(state.stalled, true);
    state = noteSpeechTurn(state, { text: EXPLORE, acted: true });
    assert.equal(state.stalled, false);
    assert.deepEqual(state.last, []);

    const woods = noteSpeechTurn(
        noteSpeechTurn(null, { text: "Let's go to the woods.", acted: false }),
        { text: "Let's go to the woods.", acted: false }
    );
    assert.equal(woods.stalled, true);
});

test('a delayed MindServer copy is one sentence, and a later new sentence is not', () => {
    resetSpeechClaims();
    rememberInWorldSpeech('Rufus', "I'll walk with you to the woods.", 1000);
    assert.equal(isDelayedMirror('Rufus', "(FROM OTHER BOT)I'll walk with you to the woods.", 11000), true);
    assert.equal(isDelayedMirror('Rufus', 'The chest is empty.', 11000), false);
    assert.equal(claimSpeech('Holt', 'The bell is loud today.', 1000), true);
    assert.equal(claimSpeech('Holt', 'The bell is loud today.', 5000), true);
    resetSpeechClaims();
});

test('heard speech is kept when nobody replies', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-heard-'));
    const turns = [];
    const agent = {
        _heardSinceDecision: 0,
        history: { add: async (name, content) => turns.push({ name, content }) },
    };
    setSettings({ village_autonomy: true, agent_data_root: parent, language: 'en' });
    try {
        observePeerSpeech(agent, 'Rufus', "I'll walk with you to the woods.");
        const episodes = readEpisodes(parent);
        assert.equal(episodes.episodes.length, 1);
        assert.match(episodes.episodes[0].text, /Rufus said: I'll walk with you to the woods/);
        assert.equal(turns.length, 1);
        assert.equal(agent._heardSinceDecision, 1);
    } finally {
        setSettings({});
        rmSync(parent, { recursive: true, force: true });
    }
});

test('intention progress follows a verified action and speech does not close it', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-intent-'));
    try {
        writeFileSync(path.join(parent, 'identity.json'), JSON.stringify({
            name: 'Cass',
            backstory: 'Cass looks around the home.',
            temperament: 'curious',
            interests: 'unfamiliar things',
        }));
        const opened = updateIntention(parent, {
            action: 'revise',
            text: INTENTION,
            source: 'orientation',
            now: () => NOW,
        });
        assert.equal(opened.ok, true);
        const noted = noteVerifiedProgress(parent, 'I walked to the path by the door.', () => NOW);
        assert.equal(noted.ok, true);
        assert.equal(noted.intentions.active.status, 'pursuing');
        assert.equal(noted.intentions.active.text, INTENTION);
        assert.equal(noted.intentions.active.source, 'orientation');
        assert.equal(noted.intentions.active.progress, 'I walked to the path by the door.');
        const same = noteVerifiedProgress(parent, 'I walked to the path by the door.', () => NOW);
        assert.equal(same.unchanged, true);
        const shown = renderVillageContext(parent);
        assert.match(shown.text, /Saying it aloud is not progress/);
        assert.match(shown.text, /Verified progress: I walked to the path by the door/);

        const before = JSON.stringify(readIntentions(parent));
        noteSpeechTurn(null, { text: EXPLORE, acted: false });
        assert.equal(JSON.stringify(readIntentions(parent)), before);

        const revised = updateIntention(parent, {
            action: 'revise',
            text: 'Sit by the door for a while.',
            source: 'day',
            now: () => '2026-11-15T19:41:00.000Z',
        });
        assert.equal(revised.intentions.history.at(-1).status, 'revised');
        assert.equal(revised.intentions.history.at(-1).source, 'orientation');
        assert.equal(revised.intentions.active.progress, '');
        const done = updateIntention(parent, { action: 'complete', text: 'enough looking', now: () => '2026-11-15T19:42:00.000Z' });
        assert.equal(done.intentions.active, null);
        assert.equal(done.intentions.history.at(-1).status, 'completed');
        const closed = updateIntention(parent, { action: 'abandon', now: () => NOW });
        assert.equal(closed.ok, false);
        assert.equal(renderVillageContext(parent).text.includes('Current intention:'), false);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test('movement closeness may be omitted and an unknown block stays unknown', () => {
    const player = parseCommandMessage('!goToPlayer("Nell")');
    assert.deepEqual(player.args, ['Nell']);
    const far = parseCommandMessage('!goToPlayer("Bram", 32)');
    assert.deepEqual(far.args, ['Bram', 32]);
    const place = parseCommandMessage('!goToCoordinates(1, 64, -3)');
    assert.deepEqual(place.args, [1, 64, -3]);
    assert.match(parseCommandMessage('!goToPlayer'), /requires 1 to 2 args/);
    assert.match(parseCommandMessage('!followPlayer("Nell")'), /requires 2 args/);
    assert.match(parseCommandMessage('!searchForBlock("wood", 16)'), /Invalid block type: wood/);
    assert.match(formatCommandSignature('!goToPlayer'), /closeness\?:number/);
    assert.match(formatCommandSignature('!goToCoordinates'), /closeness\?:number/);
});

test('ordinary speech waits and an urgent interruption does not', async () => {
    setSettings({ village_autonomy: true, language: 'en', max_commands: 1 });
    try {
        let active = 0;
        let max = 0;
        const agent = decisionAgent(async () => {
            active++;
            max = Math.max(max, active);
            await delay(40);
            active--;
            return 'I will walk toward the woods.';
        });
        const first = Agent.prototype.handleMessage.call(agent, 'system', villageDecisionMessage(), 1, { ephemeral: true });
        const second = Agent.prototype.handleMessage.call(agent, 'Nell', 'I found a path.', 1);
        await Promise.all([first, second]);
        assert.equal(max, 1);
        assert.equal(agent.routed.filter(text => text === 'I will walk toward the woods.').length, 2);
        assert.equal(agent.turns.some(turn => turn.content === villageDecisionMessage()), false);
        assert.equal(agent.turns.some(turn => turn.name === 'Nell'), true);

        let overlapped = false;
        const urgent = decisionAgent(async () => {
            active++;
            if (active > 1) overlapped = true;
            if (active === 1) {
                const nested = Agent.prototype.handleMessage.call(
                    urgent,
                    'system',
                    'SURVIVAL MODE INTERRUPTION you were attacked',
                    null,
                    { inline: true }
                );
                await delay(20);
                await nested;
            } else {
                await delay(10);
            }
            active--;
            return 'I step aside.';
        });
        active = 0;
        await Agent.prototype.handleMessage.call(urgent, 'system', 'look around', 1);
        assert.equal(overlapped, true);
    } finally {
        setSettings({});
    }
});

test('an operator command still cuts off an in-flight reply', async () => {
    setSettings({ village_autonomy: true, language: 'en', max_commands: 1 });
    try {
        const agent = decisionAgent(async () => {
            agent.prompter.most_recent_msg_time = 100;
            const command = Agent.prototype.handleMessage.call(agent, 'Operator', '!help');
            await delay(20);
            const superseded = agent.prompter.most_recent_msg_time !== 100;
            await command;
            return superseded ? '' : 'I will keep talking.';
        });
        const spoke = await Agent.prototype.handleMessage.call(agent, 'system', 'decide', 1, { ephemeral: true });
        assert.equal(spoke, false);
        assert.equal(agent.routed.some(text => String(text).includes('!goToPlayer')), true);
        assert.equal(agent.routed.includes('I will keep talking.'), false);
    } finally {
        setSettings({});
    }
});

test('a newer generation still discards the response it interrupted', async () => {
    setSettings({ base_profile: 'survival', language: 'en', village_autonomy: false, log_all_prompts: false });
    try {
        const prompter = new Prompter(
            { name: 'Finn' },
            { name: 'Finn', conversing: 'Say something.', cooldown: 0, model: { api: 'ollama', model: 'test', url: 'http://127.0.0.1:9' } }
        );
        prompter.chat_model = { sendRequest: async () => 'I will gather wood.' };
        const kept = await prompter.promptConvo([{ role: 'user', content: 'hello' }]);
        assert.equal(kept, 'I will gather wood.');
        prompter.chat_model = {
            sendRequest: async () => {
                prompter.most_recent_msg_time = 0;
                return 'I will gather wood.';
            },
        };
        const dropped = await prompter.promptConvo([{ role: 'user', content: 'hello again' }]);
        assert.equal(dropped, '');
    } finally {
        setSettings({});
    }
});

test('repeated announcements yield once, then an action lets the day continue', async () => {
    const agent = {
        name: 'Cass',
        shut_up: false,
        isIdle: () => true,
        actions: { stop: async () => {} },
        bot: {},
        history: { add: async () => {}, save: async () => {}, turns: [] },
        plan_manager: { ensurePlan: async () => { throw new Error('no plan'); } },
    };
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.village_interval = 1;
    agent.self_prompter.cooldown = 1;
    const prompts = [];
    agent.handleMessage = async (_source, message) => {
        prompts.push(message);
        if (prompts.length < 3) {
            agent._lastDecisionSpeech = EXPLORE;
            return false;
        }
        if (message === VILLAGE_SPEECH_RECOVERY) return true;
        agent.self_prompter.stop(false);
        return false;
    };
    agent.self_prompter.start(VILLAGE_AUTONOMY_PREAMBLE);
    const started = Date.now();
    while (agent.self_prompter.loop_active) {
        if (Date.now() - started > 3000) break;
        await delay(2);
    }
    assert.equal(agent.self_prompter.loop_active, false);
    assert.match(prompts[0], /Staying still for a while is a complete choice/);
    assert.match(prompts[1], /Staying still for a while is a complete choice/);
    assert.equal(prompts[2], VILLAGE_SPEECH_RECOVERY);
    assert.match(prompts[3], /Staying still for a while is a complete choice/);
    assert.equal(prompts.length, 4);
});

test('heard speech wakes the next decision instead of waiting out the interval', async () => {
    const agent = {
        name: 'Nell',
        shut_up: false,
        isIdle: () => true,
        actions: { stop: async () => {} },
        bot: {},
        history: { add: async () => {}, save: async () => {}, turns: [] },
    };
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.village_interval = 10000;
    agent.self_prompter.cooldown = 10000;
    let prompts = 0;
    agent.handleMessage = async () => {
        prompts++;
        agent._heardSinceDecision = 1;
        agent._lastDecisionSpeech = '';
        if (prompts === 2) agent.self_prompter.stop(false);
        return true;
    };
    const started = Date.now();
    agent.self_prompter.start(VILLAGE_AUTONOMY_PREAMBLE);
    while (agent.self_prompter.loop_active) {
        if (Date.now() - started > 3000) break;
        await delay(2);
    }
    assert.equal(prompts, 2);
    assert.equal(Date.now() - started < 2000, true);
});

test('survival decisions are not put behind the village turn queue', async () => {
    setSettings({ village_autonomy: false, language: 'en', max_commands: 1 });
    try {
        let active = 0;
        let max = 0;
        const agent = decisionAgent(async () => {
            active++;
            max = Math.max(max, active);
            await delay(30);
            active--;
            return 'I will check the trees.';
        });
        await Promise.all([
            Agent.prototype.handleMessage.call(agent, 'system', 'act', 1),
            Agent.prototype.handleMessage.call(agent, 'system', 'act again', 1),
        ]);
        assert.equal(max, 2);
    } finally {
        setSettings({});
    }
});

test('the turn queue does not run two tasks at once', async () => {
    const queue = createTurnQueue();
    let active = 0;
    let max = 0;
    const task = async (value) => {
        active++;
        max = Math.max(max, active);
        await delay(20);
        active--;
        return value;
    };
    const results = await Promise.all([queue.run(() => task('a')), queue.run(() => task('b'))]);
    assert.deepEqual(results, ['a', 'b']);
    assert.equal(max, 1);
});

});
