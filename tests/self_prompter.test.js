import test from 'node:test';
import assert from 'node:assert/strict';
import { setSettings } from '../src/agent/settings.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import { interruptNeedsWait } from '../src/agent/modes.js';
import { VILLAGE_AUTONOMY_PREAMBLE } from '../src/agent/startup_goal.js';

function createFinn(handleMessage) {
    const turns = [];
    const agent = {
        name: 'Finn',
        shut_up: false,
        isIdle: () => true,
        actions: { stop: async () => {} },
        bot: {},
        history: {
            memory: 'Finn is gathering wood for a safe base.',
            turns,
            add: async (role, content) => turns.push({ role, content }),
            save: async () => {},
        },
        prompter: {
            chat_model: {
                complete: async () => ({
                    content: 'Check the nearby blocks, then gather reachable wood for the base.',
                    eval_count: 24,
                }),
            },
        },
    };
    agent.handleMessage = (source, message, maxResponses) => handleMessage(agent, source, message, maxResponses);
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.cooldown = 1;
    agent.self_prompter.recovery_backoff = 1;
    agent.self_prompter.max_recovery_backoff = 4;
    return agent;
}

test('Finn reflects and selects an action instead of permanently stopping', async () => {
    setSettings({
        reasoning: {
            think: false,
            cooldown_ms: 0,
            max_consecutive: 2,
            max_concurrent: 1,
            options: { num_predict: 128 },
        },
    });

    let prompts = 0;
    let recovered = false;
    const finn = createFinn(async (agent, source, message, maxResponses) => {
        assert.equal(source, 'system');
        assert.equal(maxResponses, -1);
        prompts++;
        if (prompts <= 3)
            return false;

        assert.match(message, /reconsider your current goal/i);
        assert.match(agent.history.turns.at(-1).content, /Private reflection/);
        recovered = true;
        agent.self_prompter.stop(false);
        return true;
    });

    const goal = 'Build a safe base near the river.';
    finn.self_prompter.start(goal);
    while (finn.self_prompter.loop_active)
        await new Promise(resolve => setTimeout(resolve, 2));

    assert.equal(recovered, true);
    assert.equal(prompts, 4);
    assert.equal(finn.self_prompter.prompt, goal);
    assert.match(finn.history.memory, /safe base/);
    setSettings({});
});

test('an intentional silence cannot be undone by a delayed resume', () => {
    let prompts = 0;
    const finn = createFinn(async () => {
        prompts++;
        return false;
    });
    finn.shut_up = true;

    finn.self_prompter.start('Keep exploring.');

    assert.equal(finn.self_prompter.isStopped(), true);
    assert.equal(finn.self_prompter.loop_active, false);
    assert.equal(prompts, 0);
});

test('a conversation pause is not counted as indecision', async () => {
    let prompts = 0;
    const finn = createFinn(async agent => {
        prompts++;
        agent.self_prompter.setPromptPaused(agent.self_prompter.prompt);
        return false;
    });

    finn.self_prompter.start('Keep exploring.');
    while (finn.self_prompter.loop_active)
        await new Promise(resolve => setTimeout(resolve, 2));

    assert.equal(finn.self_prompter.isPaused(), true);
    assert.equal(prompts, 1);
    assert.equal(finn.self_prompter.recovery_attempts, 0);
});

test('a saved paused goal resumes after restart when no conversation remains', async () => {
    let prompts = 0;
    const finn = createFinn(async agent => {
        prompts++;
        agent.self_prompter.stop(false);
        return true;
    });

    const goal = 'Secure shelter area and plan settlement layout';
    await finn.self_prompter.handleLoad(goal, 2, { resumePaused: true });
    while (finn.self_prompter.loop_active)
        await new Promise(resolve => setTimeout(resolve, 2));

    assert.equal(prompts, 1);
    assert.equal(finn.self_prompter.prompt, goal);
});

test('a stopped night loop can decide again the next morning', async () => {
    setSettings({ village_autonomy: true });
    const decisions = [];
    try {
        const inhabitant = createFinn(async (agent, source, message) => {
            decisions.push({ source, message });
            agent.self_prompter.interrupt = true;
            return true;
        });
        inhabitant.bot = { time: { timeOfDay: 8761 }, health: 20 };
        const loop = inhabitant.self_prompter;
        loop.prompt = VILLAGE_AUTONOMY_PREAMBLE;
        loop.state = 1;
        loop.loop_active = false;
        loop.interrupt = true;
        loop.cooldown = 0;
        loop.idle_time = 0;
        loop.update(1);
        assert.equal(decisions.length, 0);

        loop.interrupt = false;
        assert.equal(interruptNeedsWait('night_sleep', loop), false);
        assert.equal(loop.interrupt, false);
        loop.idle_time = 0;
        loop.update(1);
        while (loop.loop_active) await new Promise(resolve => setTimeout(resolve, 2));

        assert.equal(decisions.length, 1);
        assert.equal(decisions[0].source, 'system');
        assert.match(decisions[0].message, /During the day, pursue your ambition/);
        assert.equal(loop.isActive(), true);
    } finally {
        setSettings({});
    }
});
