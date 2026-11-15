import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { setSettings } from '../src/agent/settings.js';
import { Agent } from '../src/agent/agent.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import { Prompter } from '../src/models/prompter.js';
import { executeCommand, formatCommandSignature, getCommandDocs, parseCommandMessage } from '../src/agent/commands/index.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';
import { VILLAGE_AUTONOMY_PREAMBLE, villageDecisionMessage } from '../src/agent/startup_goal.js';
import { describeIntentionChoice, noteVerifiedProgress, readIntentions, updateIntention } from '../src/village/intentions.js';
import { renderVillageContext } from '../src/village/context.js';
import { readEpisodes } from '../src/village/episodes.js';
import { claimSpeech, isDelayedMirror, rememberInWorldSpeech, resetSpeechClaims } from '../src/village/locality.js';
import convoManager, { isClosingSpeech } from '../src/agent/conversation.js';
import { serverProxy } from '../src/agent/mindserver_proxy.js';
import { stripAddresseeLabels } from '../src/village/locality.js';
import { createTurnQueue, decisionKindForCommand, largelyOverlaps, noteSpeechTurn, observePeerSpeech, omitRepeatedDecisions, villageActionTurn, VILLAGE_SPEECH_RECOVERY } from '../src/village/turn_taking.js';

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
    assert.equal(largelyOverlaps('(To Cass) See you there.', 'See you there.'), true);
    assert.equal(largelyOverlaps('(To Cass) (To Cass) See you there.', '(To Cass) See you there.'), true);
    assert.equal(stripAddresseeLabels('(To Cass) (To Cass) See you there.'), 'See you there.');
    assert.equal(isClosingSpeech("I'm heading home. See you there."), true);
    assert.equal(isClosingSpeech("I'll stay here and watch for changes."), false);
    assert.deepEqual(parseCommandMessage('!stay(30)').args, [30]);
    assert.deepEqual(parseCommandMessage('!goToRememberedPlace("home")').args, ['home']);
    assert.deepEqual(parseCommandMessage('!intention("abandon", "a short note")').args, ['abandon', 'a short note']);
    assert.equal(decisionKindForCommand('!stay', true), 'wait');
    assert.equal(decisionKindForCommand('!intention', true), 'rejected');
    assert.equal(decisionKindForCommand('!goToRememberedPlace', false), 'action');

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
        let calls = 0;
        const agent = decisionAgent(async () => {
            active++;
            max = Math.max(max, active);
            await delay(40);
            active--;
            calls++;
            return calls === 1 ? 'I will walk toward the woods.' : 'The path you found is worth a look.';
        });
        const first = Agent.prototype.handleMessage.call(agent, 'system', villageDecisionMessage(), 1, { ephemeral: true });
        const second = Agent.prototype.handleMessage.call(agent, 'Nell', 'I found a path.', 1);
        await Promise.all([first, second]);
        assert.equal(max, 1);
        assert.equal(agent.routed.includes('I will walk toward the woods.'), true);
        assert.equal(agent.routed.includes('The path you found is worth a look.'), true);
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
            agent._lastDecisionKind = 'speech';
            agent._lastDecisionSpeech = EXPLORE;
            return false;
        }
        if (message === VILLAGE_SPEECH_RECOVERY) {
            agent._lastDecisionKind = 'action';
            return true;
        }
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

test('a speech-only action turn waits instead of calling the model again immediately', async () => {
    const agent = {
        name: 'Ione',
        shut_up: false,
        isIdle: () => true,
        actions: { stop: async () => {} },
        bot: {},
        history: { add: async () => {}, save: async () => {}, turns: [] },
    };
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.village_interval = 80;
    agent.self_prompter.cooldown = 80;
    const stamps = [];
    agent.handleMessage = async () => {
        stamps.push(Date.now());
        agent._lastDecisionKind = 'speech';
        agent._lastDecisionSpeech = "I'll stay here and watch for changes.";
        if (stamps.length >= 4) agent.self_prompter.stop(false);
        return false;
    };
    agent.self_prompter.start(VILLAGE_AUTONOMY_PREAMBLE);
    const started = Date.now();
    while (agent.self_prompter.loop_active) {
        if (Date.now() - started > 3000) break;
        await delay(5);
    }
    assert.equal(agent.self_prompter.loop_active, false);
    assert.equal(stamps.length, 4);
    assert.equal(stamps[3] - stamps[2] >= 60, true);
    assert.equal(agent._speechLoop.stalled, true);
});

test('a farewell exchange ends without another reply, and a repeated addressee does not broadcast', async (t) => {
    const sent = [];
    const chats = [];
    const archived = [];
    const originalSocket = serverProxy.socket;
    const originalResume = convoManager.resume_delay_ms;
    serverProxy.socket = { emit(_event, recipient, packet) { sent.push({ recipient, packet }); } };
    convoManager.convos = {};
    convoManager.activeConversation = null;
    convoManager._stopMonitor();
    convoManager.resume_delay_ms = 0;
    convoManager.updateAgents([
        { name: 'Bram', in_game: true },
        { name: 'Cass', in_game: true },
    ]);
    const agent = {
        name: 'Bram',
        last_sender: null,
        shut_up: false,
        isIdle: () => true,
        actions: { currentActionLabel: '' },
        history: { add: async (name, message) => archived.push({ name, message }) },
        openChat: async (message) => chats.push(message),
        handleMessage: async () => { throw new Error('a farewell must not request another reply'); },
        self_prompter: {
            prompt: VILLAGE_AUTONOMY_PREAMBLE,
            isActive: () => false,
            isPaused: () => true,
            pause: async () => {},
            start() {},
        },
        bot: {
            entity: { position: { x: 0, y: 64, z: 0 } },
            players: { Cass: { entity: { position: { x: 2, y: 64, z: 0 } } } },
        },
    };
    convoManager.initAgent(agent);
    setSettings({ village_autonomy: true, chat_bot_messages: true, hearing_blocks: 32, village_hearing_blocks: 32 });
    t.after(() => {
        for (const convo of Object.values(convoManager.convos)) convo.clearTimer();
        convoManager._stopMonitor();
        convoManager.convos = {};
        convoManager.activeConversation = null;
        convoManager.resume_delay_ms = originalResume;
        convoManager.updateAgents([]);
        serverProxy.socket = originalSocket;
        setSettings({});
    });

    convoManager.sendToBot('Cass', 'The well is quiet today.', false, true);
    convoManager.sendToBot('Cass', 'I found a cracked bucket beside it.', false, true);
    assert.equal(chats.length, 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].packet.end, false);
    chats.length = 0;
    sent.length = 0;
    for (const convo of Object.values(convoManager.convos)) convo.resetProgress();

    convoManager.sendToBot('Cass', '(To Cass) See you there.', false, true);
    convoManager.sendToBot('Cass', '(To Cass) (To Cass) See you there.', false, true);
    assert.equal(chats.length, 1);
    assert.equal(chats[0], '(To Cass) See you there.');
    assert.equal(sent[0].packet.message, 'See you there.');
    assert.equal(sent.at(-1).packet.conversation_watchdog.reason, 'yield');
    assert.equal(sent.at(-1).packet.message, '');

    for (const convo of Object.values(convoManager.convos)) convo.clearTimer();
    convoManager._stopMonitor();
    convoManager.convos = {};
    convoManager.activeConversation = null;
    sent.length = 0;
    chats.length = 0;
    agent._speechLoop = { last: [], stalled: false, speechOnly: 0 };

    await convoManager.receiveFromBot('Cass', {
        message: "I'm heading home. See you there.",
        start: true,
        end: false,
    });
    assert.equal(convoManager.inConversation('Cass'), true);
    assert.equal(convoManager._getConvo('Cass').partnerClosing, true);

    convoManager.sendToBot('Cass', '(To Cass) See you there.', false, true);
    assert.equal(chats.length, 1);
    assert.equal(chats[0], '(To Cass) See you there.');
    assert.equal(sent.at(-1).packet.message, 'See you there.');
    assert.equal(sent.at(-1).packet.end, true);
    assert.equal(sent.at(-1).packet.conversation_watchdog.reason, 'farewell');
    assert.equal(convoManager.inConversation('Cass'), false);
    assert.equal(agent._speechLoop.stalled, true);

    agent.name = 'Cass';
    agent._speechLoop = { last: [], stalled: false, speechOnly: 0 };
    agent.bot.players = { Bram: { entity: { position: { x: 2, y: 64, z: 0 } } } };
    convoManager.convos = {};
    convoManager.activeConversation = null;
    convoManager.updateAgents([
        { name: 'Cass', in_game: true },
        { name: 'Bram', in_game: true },
    ]);
    await convoManager.receiveFromBot('Bram', {
        message: '(To Cass) (To Cass) See you there.',
        start: false,
        end: true,
        conversation_watchdog: { reason: 'farewell' },
    });
    assert.equal(convoManager.inConversation('Bram'), false);
    assert.equal(agent._speechLoop.stalled, true);
    assert.equal(archived.some(turn => turn.message === 'See you there.'), true);
});

test('abandoning with no intention is a no-progress decision and leaves history untouched', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-abandon-'));
    const apples = '!intention("abandon", "I\'ll find some apples to make a sandwich.")';
    const seed = {
        schema_version: 1,
        active: null,
        waking_decision_at: '2026-11-15T20:44:26.842Z',
        history: [{
            id: 'int-0001',
            text: 'Look in the chest.',
            status: 'abandoned',
            progress: 'I will make a sandwich.',
            updated_at: '2026-11-15T20:00:00.000Z',
        }],
    };
    writeFileSync(path.join(parent, 'intentions.json'), JSON.stringify(seed, null, 2));
    const before = readFileSync(path.join(parent, 'intentions.json'));
    setSettings({
        village_autonomy: true,
        agent_data_root: parent,
        language: 'en',
        max_commands: -1,
        reasoning: { auto_reflection: false },
    });
    const calls = { n: 0 };
    const agent = decisionAgent(async () => {
        calls.n += 1;
        if (calls.n > 4) throw new Error('the abandon command asked the model again in the same decision');
        return apples;
    });
    agent.actions = new ActionManager(agent);
    try {
        assert.equal(villageActionTurn(), VILLAGE_SPEECH_RECOVERY);
        assert.match(villageActionTurn(), /!intention\("revise", "a short note"\)/);
        assert.doesNotMatch(villageActionTurn(), /!intention\("abandon"/);
        assert.match(describeIntentionChoice(null), /no active intention/);
        assert.match(getCommandDocs(agent), /no active intention/);
        assert.doesNotMatch(getCommandDocs(agent), /!intention\("abandon"/);

        await agent.handleMessage('system', 'choose', -1, { ephemeral: true });
        assert.equal(calls.n, 1);
        assert.equal(agent._lastDecisionKind, 'rejected');
        assert.equal(readFileSync(path.join(parent, 'intentions.json')).equals(before), true);
        const correction = agent.turns.map(turn => turn.content).join('\n');
        assert.match(correction, /no active intention to abandon/);
        assert.match(correction, /I'll find some apples to make a sandwich/);
        assert.match(correction, /was not saved as an intention/);
        assert.match(correction, /!intention\("revise", "a short note"\)/);

        const other = await executeCommand(agent, '!intention("abandon", "Maybe berries instead.")');
        assert.match(other, /UNCHANGED BLOCKING CONDITION/);
        assert.match(other, /no active intention to abandon/);
        assert.equal(readFileSync(path.join(parent, 'intentions.json')).equals(before), true);
        assert.equal(readIntentions(parent).history.length, 1);
        assert.equal(readIntentions(parent).history[0].text, 'Look in the chest.');
        assert.equal(readIntentions(parent).active, null);

        const kept = omitRepeatedDecisions([
            { role: 'assistant', content: 'The well is quiet.' },
            { role: 'assistant', content: apples },
            { role: 'system', content: 'Do not immediately repeat !intention("abandon", "apples"). You have no active intention to abandon.' },
            { role: 'system', content: 'ACTION RESULT: You have no active intention to abandon. "apples" was not saved as an intention.' },
        ]);
        assert.deepEqual(kept.map(turn => turn.content), ['The well is quiet.']);

        const opened = updateIntention(parent, { action: 'revise', text: 'Stack the chest.', now: () => NOW });
        assert.equal(opened.ok, true);
        assert.equal(opened.intentions.active.text, 'Stack the chest.');
        const same = updateIntention(parent, { action: 'revise', text: 'Stack the chest.', now: () => NOW });
        assert.equal(same.ok, false);
        assert.equal(readIntentions(parent).history.length, 1);
        const closed = updateIntention(parent, {
            action: 'abandon',
            text: 'I\'ll find some apples to make a sandwich.',
            now: () => NOW,
        });
        assert.equal(closed.ok, true);
        assert.equal(closed.intentions.active, null);
        assert.equal(closed.intentions.history.at(-1).text, 'Stack the chest.');
        assert.equal(closed.intentions.history.at(-1).status, 'abandoned');
        assert.match(closed.intentions.history.at(-1).progress, /apples/);
        assert.match(describeIntentionChoice(readIntentions(parent)), /no active intention/);
        writeFileSync(path.join(parent, 'identity.json'), JSON.stringify({
            name: 'Bram',
            backstory: 'Bram keeps the garden.',
            temperament: 'steady',
            interests: 'fruit',
        }));
        const active = updateIntention(parent, { action: 'pursue', text: 'Find some apples.', now: () => NOW });
        assert.match(villageActionTurn('', active.intentions), /!intention\("abandon", "a short note"\)/);
        assert.match(renderVillageContext(parent).text, /Find some apples/);
        assert.match(renderVillageContext(parent).text, /!intention\("revise", "a short note"\)/);
    } finally {
        setSettings({});
        rmSync(parent, { recursive: true, force: true });
    }
});

test('repeated abandon decisions back off instead of calling the model continuously', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'village-abandon-loop-'));
    writeFileSync(path.join(parent, 'intentions.json'), JSON.stringify({
        schema_version: 1,
        active: null,
        waking_decision_at: null,
        history: [{ id: 'int-0001', text: 'Look in the chest.', status: 'abandoned' }],
    }));
    const before = readFileSync(path.join(parent, 'intentions.json'));
    setSettings({
        village_autonomy: true,
        agent_data_root: parent,
        language: 'en',
        max_commands: -1,
        reasoning: { auto_reflection: false },
    });
    const seen = [];
    let calls = 0;
    const agent = decisionAgent(async (history) => {
        calls += 1;
        if (calls > 20) throw new Error('intention loop kept calling the model');
        seen.push(String(history?.at?.(-1)?.content || ''));
        return '!intention("abandon", "I\'ll find some apples to make a sandwich.")';
    });
    agent.actions = new ActionManager(agent);
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.village_interval = 5;
    agent.self_prompter.cooldown = 5;
    agent.self_prompter.recovery_backoff = 80;
    agent.self_prompter.max_recovery_backoff = 160;
    try {
        agent.self_prompter.start(VILLAGE_AUTONOMY_PREAMBLE);
        await delay(450);
        agent.self_prompter.stop(false);
        const started = Date.now();
        while (agent.self_prompter.loop_active && Date.now() - started < 1000) await delay(5);
        assert.equal(agent.self_prompter.loop_active, false);
        assert.ok(calls >= 3, `expected several bounded decisions, got ${calls}`);
        assert.ok(calls < 12, `inference was not bounded, got ${calls} calls`);
        assert.ok(seen.some(text => text.includes('You have no active intention') && text.includes('!intention("revise"') && !text.includes('!intention("abandon"')));
        assert.equal(readFileSync(path.join(parent, 'intentions.json')).equals(before), true);
    } finally {
        setSettings({});
        rmSync(parent, { recursive: true, force: true });
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
