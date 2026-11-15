import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent } from '../src/agent/agent.js';
import convoManager from '../src/agent/conversation.js';
import { setSettings } from '../src/agent/settings.js';
import {
    attributeTurnsForSummary,
    durableMemoryView,
    isTransientMemoryTurn,
    sanitizeIncomingPeerMessage,
    sanitizeOutgoingChat,
    stripCommandSyntax,
} from '../src/agent/chat_hygiene.js';

// The exact shape live agents leaked into chat (Finn echoing Sawyer's result).
const LEAKED_RESULT =
    'Harvested 3 oak_log blocks and confirmed collected items. Inventory before -> after: cobblestone 203 -> 206 (+3), oak_log 85 -> 88 (+3). ' +
    'Verified outcome: PARTIAL for collectBlocks. Observed changes: cobblestone 203->206 (+3), oak_log 85->88 (+3). ' +
    'Retry without a relevant state change: reasonable.';

describe('outgoing chat never carries action results', () => {
    test('a reply that only restates a result is suppressed', () => {
        const speech = sanitizeOutgoingChat(LEAKED_RESULT);
        assert.equal(speech.suppressed, true);
        assert.equal(speech.text, '');
    });

    test('transcript labels echoed from the prompt are removed', () => {
        const speech = sanitizeOutgoingChat('System output: Verified outcome: SUCCESS for discard. Observed changes: leaf_litter 242->0 (-242).');
        assert.equal(speech.suppressed, true);
        const labelled = sanitizeOutgoingChat('Your output:\nOn it, clearing space.');
        assert.equal(labelled.text, 'On it, clearing space.');
    });

    test('genuine speech before a result block is kept and the block removed', () => {
        const speech = sanitizeOutgoingChat(`I cleared some room. ${LEAKED_RESULT}`);
        assert.equal(speech.suppressed, false);
        assert.equal(speech.text, 'I cleared some room.');
        assert.doesNotMatch(speech.text, /Inventory|Verified|Observed/);
    });

    test('a command after the speech is preserved untouched', () => {
        const speech = sanitizeOutgoingChat(`Gathering more. ${LEAKED_RESULT} !collectBlocks("oak_log", 3)`);
        assert.match(speech.text, /Gathering more\./);
        assert.match(speech.text, /!collectBlocks\("oak_log", 3\)$/);
        assert.doesNotMatch(speech.text, /Verified outcome/);
    });

    test('ordinary narration is untouched', () => {
        for (const text of ['Placed the chest! Let us gather more.', 'I found 3 cows near the river.', 'Hi Finn, what are you up to?']) {
            const speech = sanitizeOutgoingChat(text);
            assert.equal(speech.changed, false, text);
            assert.equal(speech.text, text);
        }
    });
});

describe('peer messages are claims, not observations', () => {
    test('result blocks and action commands in a peer message are removed', () => {
        const peer = sanitizeIncomingPeerMessage(`(FROM OTHER BOT)Making space. !discard("leaf_litter", 242) ${LEAKED_RESULT}`);
        assert.equal(peer.text, '(FROM OTHER BOT)Making space.');
        assert.equal(peer.changed, true);
    });

    test('a message that is only a command or result becomes empty', () => {
        assert.equal(sanitizeIncomingPeerMessage('(FROM OTHER BOT)!placeHere("oak_planks")').text, '');
        assert.equal(sanitizeIncomingPeerMessage(`(FROM OTHER BOT)${LEAKED_RESULT}`).text, '');
    });

    test('conversation protocol commands and normal speech survive', () => {
        const peer = sanitizeIncomingPeerMessage('(FROM OTHER BOT)Talk later! !endConversation("Sawyer")');
        assert.equal(peer.text, '(FROM OTHER BOT)Talk later! !endConversation("Sawyer")');
        assert.equal(peer.changed, false);
    });
});

describe('memory attribution hygiene', () => {
    test('command syntax is stripped from stored memory text', () => {
        assert.equal(
            stripCommandSyntax('Sawyer wants a shelter near the river. !collectBlocks("oak_log", 4)'),
            'Sawyer wants a shelter near the river.'
        );
    });

    test('summary turns label other agents and keep own turns unlabelled', () => {
        const turns = [
            { role: 'user', content: 'Sawyer: (FROM OTHER BOT)I have 242 cobblestone and built a house.' },
            { role: 'assistant', content: 'Nice! !placeHere("oak_planks")' },
            { role: 'system', content: 'Verified outcome: SUCCESS for placeHere.' },
            { role: 'user', content: 'ryan: please follow me' },
        ];
        const labelled = attributeTurnsForSummary(turns, 'Finn', name => name === 'Sawyer');
        assert.match(labelled[0].content, /^Sawyer \(ANOTHER AGENT, not you; unverified claim/);
        assert.match(labelled[0].content, /I have 242 cobblestone/);
        assert.doesNotMatch(labelled[0].content, /FROM OTHER BOT/);
        assert.equal(labelled[1].content, 'Nice!');
        assert.equal(labelled[2].content, turns[2].content);
        assert.equal(labelled[3].content, 'ryan: please follow me');
    });

    test('transient stop acknowledgments are omitted from future memory summaries', () => {
        const turns = [
            { role: 'assistant', content: "I've stopped. What next?" },
            { role: 'assistant', content: "I'll stop fighting. !stop" },
            { role: 'assistant', content: "Sure, I'll stop. !stop" },
            { role: 'system', content: 'Agent stopped.' },
            { role: 'system', content: '[SYSTEM OBSERVATION: ACTION RESULT — not a human instruction]\nAgent stopped. Self-prompting still active.' },
            { role: 'assistant', content: 'A stone pickaxe is required to harvest iron.' },
        ];
        assert.equal(turns.slice(0, 5).every(isTransientMemoryTurn), true);
        const summarized = attributeTurnsForSummary(turns, 'Milo', () => false);
        assert.deepEqual(summarized, [turns[5]]);
        const old = "I've stopped. What next? A stone pickaxe is required to harvest iron. I'll stop fighting.";
        assert.equal(durableMemoryView(old), 'A stone pickaxe is required to harvest iron.');
    });
});

describe('the real handleMessage loop keeps results private and attributed', () => {
    beforeEach(() => {
        setSettings({ max_commands: -1, show_command_syntax: 'full' });
        convoManager.updateAgents([{ name: 'Sawyer' }, { name: 'Finn' }]);
    });

    function createAgent(replies, name = 'Finn') {
        const agent = Object.create(Agent.prototype);
        const queue = [...replies];
        const history = [];
        const routed = [];
        Object.assign(agent, {
            name,
            ready: true,
            shut_up: false,
            blocked_actions: [],
            bot: { modes: { flushBehaviorLog: () => '' }, inventory: { slots: [] } },
            checkTaskDone: async () => {},
            routeResponse: (to, message) => routed.push({ to, message }),
            history: {
                turns: history,
                async add(who, content) { history.push({ who, content }); },
                getHistory() { return history; },
                save() {},
            },
            self_prompter: { shouldInterrupt: () => false, isActive: () => false, handleUserPromptedCmd() {} },
            prompter: { async promptConvo() { return queue.shift() ?? ''; } },
        });
        agent.routed = routed;
        agent.historyLog = history;
        return agent;
    }

    test("Finn does not broadcast a result block back to Sawyer or record it as his own words", async () => {
        const agent = createAgent([LEAKED_RESULT]);
        await agent.handleMessage('Sawyer', '(FROM OTHER BOT)How is the wood?', 1);

        assert.deepEqual(agent.routed, []);
        const ownTurns = agent.historyLog.filter(entry => entry.who === 'Finn');
        assert.deepEqual(ownTurns, []);
        const note = agent.historyLog.find(entry => entry.who === 'system');
        assert.match(note.content, /private observations/);
        assert.equal(agent.chat_hygiene.suppressed, 1);
    });

    test('genuine speech in a reply is still sent, without the result text', async () => {
        const agent = createAgent([`Sounds good, I'll help. ${LEAKED_RESULT}`]);
        await agent.handleMessage('Sawyer', '(FROM OTHER BOT)Want to help with wood?', 1);

        assert.deepEqual(agent.routed, [{ to: 'Sawyer', message: "Sounds good, I'll help." }]);
        assert.ok(agent.historyLog.some(entry => entry.who === 'Finn' && entry.content === "Sounds good, I'll help."));
    });

    test("a peer's result text and commands never enter the receiver's history", async () => {
        const agent = createAgent(['Got it.']);
        await agent.handleMessage('Sawyer', `(FROM OTHER BOT)Clearing space !discard("leaf_litter", 242) ${LEAKED_RESULT}`, 1);

        const received = agent.historyLog.find(entry => entry.who === 'Sawyer');
        assert.equal(received.content, '(FROM OTHER BOT)Clearing space');
        assert.ok(!agent.historyLog.some(entry => /Verified outcome|Inventory before|!discard/.test(entry.content) && entry.who !== 'Finn'));
    });

    test('a peer message with no spoken content is dropped before reaching the model', async () => {
        const agent = createAgent(['should not be asked']);
        const used = await agent.handleMessage('Sawyer', '(FROM OTHER BOT)!placeHere("oak_planks")', 1);
        assert.equal(used, false);
        assert.deepEqual(agent.historyLog, []);
    });
});

describe('own interruption events stay attributed to the agent (modes.js)', () => {
    test("survival observations are delivered as 'system', never as the conversation partner", () => {
        const source = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
        const calls = [...source.matchAll(/agent\.handleMessage\(([^,]+),\s*systemObservation\(/g)].map(match => match[1].trim());
        assert.ok(calls.length >= 2);
        assert.deepEqual([...new Set(calls)], ["'system'"]);
        assert.doesNotMatch(source, /agent\.last_sender\s*:\s*'system'/);
    });
});
