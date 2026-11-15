import test from 'node:test';
import assert from 'node:assert/strict';
import manager, {
    Conversation,
    areMessagesSubstantiallySimilar,
} from '../src/agent/conversation.js';
import { serverProxy } from '../src/agent/mindserver_proxy.js';

test('substantially similar conversational filler is recognized', () => {
    assert.equal(
        areMessagesSubstantiallySimilar(
            "I'm just chilling, looking for some fun stuff to do. What about you?",
            "I'm still just chilling, looking for something fun to do. How about you?"
        ),
        true
    );
    assert.equal(
        areMessagesSubstantiallySimilar(
            'I found iron near the river at 10, 64, 20.',
            'I found coal behind the mountain at 42, 70, -8.'
        ),
        false
    );
});

test('watchdog fires after roughly three repetitive exchanges', () => {
    const convo = new Conversation('Milo');
    const incoming = "I'm just chilling, looking for some fun stuff to do. What about you?";
    const outgoing = "I'm just chilling too, Milo. What's new?";

    assert.equal(convo.observeProgress('incoming', incoming), false);
    assert.equal(convo.observeProgress('outgoing', outgoing), false);
    assert.equal(convo.observeProgress('incoming', incoming), false);
    assert.equal(convo.observeProgress('outgoing', outgoing), false);
    assert.equal(convo.observeProgress('incoming', incoming), false);
    assert.equal(convo.observeProgress('outgoing', outgoing), true);
});

test('new information and actionable commands reset repetitive progress', () => {
    const convo = new Conversation('Milo');
    const incoming = 'Still waiting here by the base.';
    const outgoing = 'Okay, I am still waiting too.';

    convo.observeProgress('incoming', incoming);
    convo.observeProgress('outgoing', outgoing);
    convo.observeProgress('incoming', incoming);
    convo.observeProgress('outgoing', outgoing);
    assert.equal(convo.repetitiveTurns, 2);

    assert.equal(
        convo.observeProgress('incoming', 'I found iron at coordinates 10, 64, 20.'),
        false
    );
    assert.equal(convo.repetitiveTurns, 0);

    convo.observeProgress('incoming', incoming);
    convo.observeProgress('outgoing', outgoing);
    assert.equal(convo.observeProgress('outgoing', '!givePlayer("Milo", "iron_ingot", 3)'), false);
    assert.equal(convo.repetitiveTurns, 0);
});

test('watchdog ends, resumes the paused goal, and blocks immediate restarts', async t => {
    const sent = [];
    const archived = [];
    const originalSocket = serverProxy.socket;
    const originalCooldown = manager.cooldown_ms;
    const originalResumeDelay = manager.resume_delay_ms;
    let selfPromptState = 'active';
    let pauses = 0;
    let resumes = 0;

    serverProxy.socket = {
        emit(event, recipient, packet) {
            sent.push({ event, recipient, packet });
        },
    };
    manager.convos = {};
    manager.activeConversation = null;
    manager._stopMonitor();
    manager.cooldown_ms = 1000;
    manager.resume_delay_ms = 0;
    manager.updateAgents([
        { name: 'Finn', in_game: true },
        { name: 'Milo', in_game: true },
    ]);

    const agent = {
        name: 'Finn',
        last_sender: null,
        shut_up: false,
        isIdle: () => false,
        actions: { currentActionLabel: 'action:dig' },
        history: { add: (name, message) => Promise.resolve(archived.push({ name, message })) },
        openChat: async () => {},
        handleMessage: async () => {},
        self_prompter: {
            prompt: 'Gather wood for the base.',
            isActive: () => selfPromptState === 'active',
            isPaused: () => selfPromptState === 'paused',
            pause: () => {
                pauses++;
                selfPromptState = 'paused';
                return Promise.resolve();
            },
            start: () => {
                resumes++;
                selfPromptState = 'active';
            },
        },
    };
    manager.initAgent(agent);

    t.after(() => {
        for (const convo of Object.values(manager.convos))
            convo.clearTimer();
        manager._stopMonitor();
        manager.convos = {};
        manager.activeConversation = null;
        manager.cooldown_ms = originalCooldown;
        manager.resume_delay_ms = originalResumeDelay;
        manager.updateAgents([]);
        serverProxy.socket = originalSocket;
    });

    const incoming = "I'm just chilling, looking for some fun stuff to do. What about you?";
    const outgoing = "I'm just chilling too, Milo. What's new?";
    await manager.receiveFromBot('Milo', { message: incoming, start: true, end: false });
    manager.sendToBot('Milo', outgoing, false, false);
    await manager.receiveFromBot('Milo', { message: incoming, start: false, end: false });
    manager.sendToBot('Milo', outgoing, false, false);
    await manager.receiveFromBot('Milo', { message: incoming, start: false, end: false });
    manager.sendToBot('Milo', outgoing, false, false);

    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(manager.inConversation('Milo'), false);
    assert.equal(pauses, 1);
    assert.equal(resumes, 1);
    assert.equal(agent.self_prompter.prompt, 'Gather wood for the base.');
    assert.equal(selfPromptState, 'active');
    assert.equal(archived.at(-1).message, [incoming, incoming, incoming].join('\n'));
    assert.equal(sent.at(-1).recipient, 'Milo');
    assert.equal(sent.at(-1).packet.end, true);
    assert.equal(sent.at(-1).packet.conversation_watchdog.reason, 'repetitive');

    const packetCount = sent.length;
    assert.equal(await manager.startConversation('Milo', 'Want to chat again?'), false);
    assert.equal(sent.length, packetCount);
    assert.equal(pauses, 1);

    await manager.receiveFromBot('Milo', {
        message: 'Want to chat again?',
        start: true,
        end: false,
    });
    assert.equal(manager.inConversation('Milo'), false);
    assert.equal(sent.length, packetCount + 1);
    assert.equal(sent.at(-1).packet.end, true);

    const convo = manager._getConvo('Milo');
    convo.cooldownUntil = 0;
    convo.ignore_until_start = false;
    convo.active = true;
    manager.activeConversation = convo;
    selfPromptState = 'paused';
    await manager.receiveFromBot('Milo', {
        message: 'Let us pause here.',
        start: false,
        end: true,
        conversation_watchdog: { reason: 'repetitive', cooldown_ms: 1000 },
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(manager.inConversation('Milo'), false);
    assert.ok(convo.cooldownRemaining() > 0);
    assert.equal(resumes, 2);
    assert.equal(selfPromptState, 'active');
});
