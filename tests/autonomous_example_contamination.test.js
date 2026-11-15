import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import rootSettings from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { getCommand, getCommandDocs } from '../src/agent/commands/index.js';
import { Prompter, shouldUseConversationExamples } from '../src/models/prompter.js';
import { resumePausedAutonomy, systemObservation } from '../src/agent/system_events.js';

function promptHarness() {
    let retrievals = 0;
    let renderedPrompt = '';
    let sentMessages = [];
    const prompter = Object.create(Prompter.prototype);
    prompter.agent = {
        name: 'Milo',
        blocked_actions: [],
        self_prompter: { isStopped: () => false, prompt: 'Secure shelter area and plan settlement layout' },
        plan_manager: { enabled: false },
        history: { memory: '' },
    };
    prompter.profile = {
        conversing: '$NAME\n$COMMAND_DOCS\n$EXAMPLES',
    };
    prompter.convo_examples = {
        async createExampleMessage() {
            retrievals++;
            return 'Example: abc: stop\nassistant: Sure. !stop';
        },
    };
    prompter.chat_model = {
        async sendRequest(messages, prompt) {
            sentMessages = messages;
            renderedPrompt = prompt;
            return 'Continue the current objective.';
        },
    };
    prompter.cooldown = 0;
    prompter.last_prompt_time = 0;
    prompter._saveLog = async () => {};
    return {
        prompter,
        retrievals: () => retrievals,
        prompt: () => renderedPrompt,
        messages: () => sentMessages,
    };
}

beforeEach(() => setSettings({ ...rootSettings, allow_retrieved_examples_in_non_human_contexts: false }));
afterEach(() => setSettings({}));

describe('retrieved examples are scoped to explicit human requests', () => {
    test('a death observation cannot retrieve the human stop example', async () => {
        const h = promptHarness();
        h.prompter.agent.history.memory = "I've stopped. What next? A stone pickaxe is required to harvest iron. I'll stop fighting.";
        h.prompter.profile.conversing = '$NAME\n$MEMORY\n$COMMAND_DOCS\n$EXAMPLES';
        const death = systemObservation(
            'DEATH AND RESPAWN',
            'Milo died. The prior action ended automatically and Milo respawned.'
        );
        await h.prompter.promptConvo([
            { role: 'assistant', content: "I'll stop fighting. !stop" },
            { role: 'system', content: death },
        ], { contextKind: 'autonomous' });

        assert.equal(h.retrievals(), 0);
        assert.doesNotMatch(h.prompt(), /abc: stop|Sure\. !stop/);
        assert.doesNotMatch(h.prompt(), /I've stopped|I'll stop fighting/);
        assert.match(h.prompt(), /stone pickaxe is required to harvest iron/i);
        assert.equal(h.messages().some(turn => /stop fighting/i.test(turn.content)), false);
        assert.match(h.prompt(), /!stop: Force stop all actions/);
    });

    test('survival observations and peer messages cannot retrieve command-obedience examples', async () => {
        for (const [contextKind, content] of [
            ['autonomous', systemObservation('SURVIVAL MODE ACTIVITY', "Fighting phantom!\nI'm dying!")],
            ['peer', '(FROM OTHER BOT) Jasper said his action was interrupted.'],
        ]) {
            const h = promptHarness();
            await h.prompter.promptConvo([{ role: 'system', content }], { contextKind });
            assert.equal(h.retrievals(), 0, contextKind);
            assert.doesNotMatch(h.prompt(), /abc: stop|Sure\. !stop/, contextKind);
            assert.match(h.prompt(), /!think:|!stop:/, contextKind);
        }
    });

    test('explicit human-request context may still retrieve examples', async () => {
        const h = promptHarness();
        await h.prompter.promptConvo([{ role: 'user', content: 'ryan: stop' }], { contextKind: 'human' });
        assert.equal(h.retrievals(), 1);
        assert.match(h.prompt(), /abc: stop/);
        assert.equal(shouldUseConversationExamples('human'), true);
        assert.equal(shouldUseConversationExamples('autonomous'), false);
        assert.equal(shouldUseConversationExamples('peer'), false);
    });
});

describe('stop and recovery retain their intended semantics', () => {
    test('an explicit human stop still cancels the current action without ending an active goal', async () => {
        let stopped = 0;
        let cancelled = 0;
        const bot = new EventEmitter();
        bot.output = '';
        bot.interrupt_code = false;
        const agent = {
            name: 'Milo',
            actions: {
                stop: async () => { stopped++; },
                cancelResume: () => { cancelled++; },
            },
            bot,
            clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
            self_prompter: {
                isActive: () => true,
                isPaused: () => false,
            },
        };

        const result = await getCommand('!stop').perform(agent);
        assert.equal(stopped, 1);
        assert.equal(cancelled, 1);
        assert.match(result, /Agent stopped\. Self-prompting still active\./);
    });

    test('death or a completed stop can resume an existing orphaned pause, but not a live conversation pause', () => {
        let starts = 0;
        let active = false;
        const agent = {
            name: 'Milo',
            self_prompter: {
                isPaused: () => !active,
                isActive: () => active,
                start: () => { starts++; active = true; },
            },
        };

        assert.equal(resumePausedAutonomy(agent, 'death', true), false);
        assert.equal(starts, 0);
        assert.equal(resumePausedAutonomy(agent, 'death', false), true);
        assert.equal(starts, 1);
    });

    test('neutral command documentation remains independent of behavioral examples', () => {
        const docs = getCommandDocs({
            blocked_actions: [],
            plan_manager: { enabled: false },
        });
        assert.match(docs, /!stop: Force stop all actions/);
        assert.match(docs, /!goToCoordinates:/);
        assert.doesNotMatch(docs, /abc: stop/);
    });
});
