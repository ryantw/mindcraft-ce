import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand, getCommandDocs, stripUnsharedCommands } from '../src/agent/commands/index.js';
import { resolveStartupGoal } from '../src/agent/startup_goal.js';
import { Agent } from '../src/agent/agent.js';
import { serverProxy } from '../src/agent/mindserver_proxy.js';

test('an autonomous agent cannot execute !restart', async () => {
    let killed = false;
    const agent = {
        name: 'Finn',
        blocked_actions: [],
        cleanKill() { killed = true; }
    };
    const result = await executeCommand(agent, '!restart');
    assert.match(result, /reserved for the human operator/);
    assert.equal(killed, false);
});

test('the human operator can still restart an agent', async () => {
    let killed = false;
    const agent = {
        name: 'Finn',
        blocked_actions: [],
        cleanKill() { killed = true; }
    };
    await executeCommand(agent, '!restart', { operator: true });
    assert.equal(killed, true);
});

test('autonomous command docs do not offer lifecycle commands', () => {
    const docs = getCommandDocs({ name: 'Finn', blocked_actions: [] });
    assert.doesNotMatch(docs, /!restart/);
    assert.doesNotMatch(docs, /!clearChat/);
    assert.doesNotMatch(docs, /!stfu/);
    assert.match(docs, /!think/);
});

test('administrative and reflection commands are not sent to another agent', () => {
    assert.equal(
        stripUnsharedCommands('Sure, I\'ll restart. !restart'),
        'Sure, I\'ll restart.'
    );
    assert.equal(
        stripUnsharedCommands('I considered it. !think("why am I stuck") Let\'s mine wood.'),
        'I considered it. Let\'s mine wood.'
    );
    assert.match(
        stripUnsharedCommands('Goodbye. !endConversation("Milo")'),
        /!endConversation\("Milo"\)/
    );
});

test('a restart notice never replaces a saved goal', () => {
    const kept = resolveStartupGoal({
        saved: 'Build a safe base near the river.',
        initMessage: 'Agent process restarted.',
        directive: 'Survive and thrive.'
    });
    assert.equal(kept.goal, 'Build a safe base near the river.');
    assert.equal(kept.notice, 'Agent process restarted.');
    assert.equal(kept.replacedSavedGoal, false);

    const restored = resolveStartupGoal({
        saved: 'Agent process restarted.',
        initMessage: 'Agent process restarted.',
        directive: 'Survive and thrive.'
    });
    assert.equal(restored.goal, 'Survive and thrive.');
    assert.equal(restored.replacedSavedGoal, true);
});

test('queued conversation work waits until the agent is ready', () => {
    const received = [];
    const previous = {
        chats: serverProxy.pendingBotChats,
        players: serverProxy.pendingPlayerMessages,
        manager: serverProxy.convoManager,
        agent: serverProxy.agent
    };
    serverProxy.pendingBotChats = [];
    serverProxy.pendingPlayerMessages = [];
    serverProxy.convoManager = {
        receiveFromBot(name, json) { received.push([name, json.message]); }
    };
    serverProxy.agent = { ready: false };
    serverProxy.pendingBotChats.push(['Milo', { message: 'Sure, I will restart. !restart' }]);
    assert.equal(received.length, 0);
    serverProxy.flushPending();
    assert.deepEqual(received, [['Milo', 'Sure, I will restart. !restart']]);
    serverProxy.pendingBotChats = previous.chats;
    serverProxy.pendingPlayerMessages = previous.players;
    serverProxy.convoManager = previous.manager;
    serverProxy.agent = previous.agent;
});

test('checkTaskDone does not read task data before the task exists', async () => {
    const agent = Object.create(Agent.prototype);
    agent.task = undefined;
    await agent.checkTaskDone();
});
