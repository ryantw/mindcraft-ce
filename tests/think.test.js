import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setSettings } from '../src/agent/settings.js';
import { reflect, noteReflectionAction } from '../src/agent/reasoning.js';
import { Ollama } from '../src/models/ollama.js';
import { executeCommand, getCommandDocs, isAction, parseCommandMessage, truncCommandMessage } from '../src/agent/commands/index.js';

function agent(name, model) {
    return {
        name,
        self_prompter: { prompt: 'Survive and thrive.' },
        history: {
            memory: 'I crafted a wooden pickaxe. Hitting iron ore did nothing.',
            turns: [
                { role: 'assistant', content: '!collectBlocks("iron_ore", 1)' },
                { role: 'system', content: 'Cannot mine iron_ore with a wooden_pickaxe. Collected 0.' }
            ]
        },
        bot: {
            health: 20,
            food: 18,
            game: { dimension: 'overworld' },
            entity: { position: { x: 12.2, y: 64, z: -4.4 } },
            heldItem: { name: 'wooden_pickaxe' },
            inventory: {
                slots: [
                    { name: 'wooden_pickaxe', count: 1 },
                    { name: 'oak_planks', count: 20 },
                    { name: 'stick', count: 4 }
                ]
            }
        },
        prompter: { chat_model: model },
        blocked_actions: []
    };
}

describe('!think', { concurrency: 1 }, () => {
test('!think stays private, bounded, and does not loop', async () => {
    const routine = {
        think: false,
        keep_alive: -1,
        options: { num_ctx: 8192, num_predict: 512 }
    };
    const model = new Ollama('qwen3:8b', 'http://127.0.0.1:11434', routine);
    const sent = [];
    model.send = async (endpoint, body, signal) => {
        sent.push({ body, hasSignal: Boolean(signal) });
        assert.equal(body.timeout_ms, undefined);
        assert.ok(body.options.num_predict <= 1024);
        if (body.think) {
            return {
                message: { content: '', thinking: 'HIDDEN TRACE: search iron forever' },
                done_reason: 'length',
                eval_count: body.options.num_predict
            };
        }
        return {
            message: {
                content: 'Mine three cobblestone with the wooden pickaxe, then craft a stone pickaxe.',
                thinking: 'ALSO HIDDEN'
            },
            done_reason: 'stop',
            eval_count: 30
        };
    };

    setSettings({
        reasoning: {
            think: true,
            keep_alive: -1,
            timeout_ms: 45000,
            cooldown_ms: 60000,
            max_consecutive: 5,
            max_concurrent: 1,
            max_predict: 8000,
            options: { num_ctx: 8192, num_predict: 8000 }
        }
    });

    const finn = agent('Finn', model);
    const first = await reflect(finn, 'I have a wooden pickaxe but cannot mine iron. What am I missing?');
    assert.match(first, /Private reflection/);
    assert.match(first, /stone pickaxe/);
    assert.equal(first.includes('HIDDEN'), false);
    assert.equal(sent[0].body.think, true);
    assert.equal(sent[0].body.options.num_predict, 1024);
    assert.equal(sent[0].hasSignal, true);
    assert.equal(sent[1].body.think, false);
    assert.equal(sent[1].body.options.num_predict, 512);
    assert.equal(model.params.think, false);
    assert.equal(model.params.options.num_predict, 512);
    assert.equal(sent.length, 2);
    assert.match(sent[0].body.messages[1].content, /cannot harvest it/);
    assert.match(sent[0].body.messages[1].content, /stone_pickaxe/);
    assert.match(sent[0].body.messages[1].content, /cobblestone/);

    const duringCooldown = await reflect(finn, 'What am I missing now?');
    assert.match(duringCooldown, /Reflection blocked/);
    assert.match(duringCooldown, /stone pickaxe/);
    assert.equal(sent.length, 2);
    assert.match(getCommandDocs(finn), /!think: UNAVAILABLE/);

    finn.bot.entity.position = { x: 80, y: 70, z: 40 };
    const afterChange = await reflect(finn, 'The situation changed. What now?');
    assert.match(afterChange, /Private reflection/);
    assert.ok(sent.length > 2);

    setSettings({
        reasoning: {
            think: false,
            keep_alive: -1,
            timeout_ms: 1000,
            cooldown_ms: 0,
            max_consecutive: 2,
            max_concurrent: 1,
            max_predict: 1024,
            options: { num_ctx: 8192, num_predict: 128 }
        }
    });
    const sawyer = agent('Sawyer', model);
    sent.length = 0;
    await reflect(sawyer, 'First look at the failed iron attempt.');
    const blocked = await reflect(sawyer, 'Second look without doing anything.');
    assert.match(blocked, /Reflection blocked/);
    assert.match(blocked, /stone pickaxe/);
    assert.equal(sent.length, 1);

    const milo = agent('Milo', model);
    const miloAdvice = await reflect(milo, 'Milo has his own question.');
    assert.match(miloAdvice, /Private reflection/);
    assert.equal(sawyer._reflection.locked, true);

    noteReflectionAction(sawyer);
    await reflect(sawyer, 'After acting, a new reflection is allowed.');
    assert.equal(sawyer._reflection.locked, true);

    let active = 0;
    let maxActive = 0;
    model.send = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 40));
        active--;
        return { message: { content: 'Look at the nearby trees and gather wood.', thinking: 'nope' }, done_reason: 'stop' };
    };
    const jasper = agent('Jasper', model);
    const rowan = agent('Rowan', model);
    const [left, right] = await Promise.all([
        reflect(jasper, 'Should I gather wood?'),
        reflect(rowan, 'Should I gather wood too?')
    ]);
    const texts = [left, right];
    assert.equal(texts.filter(text => text.includes('Private reflection')).length, 1);
    assert.equal(texts.filter(text => text.includes('already running')).length, 1);
    assert.equal(maxActive, 1);

    assert.equal(isAction('!think'), false);
    noteReflectionAction(finn);
    const docs = getCommandDocs(finn);
    assert.match(docs, /!think\("I cannot reach the acacia logs/);
    assert.doesNotMatch(docs, /UNAVAILABLE/);

    finn.prompter.chat_model = model;
    model.send = async () => ({
        message: { content: 'Use the wooden pickaxe on stone, then craft a stone pickaxe.', thinking: 'secret', eval_count: 12 },
        done_reason: 'stop'
    });
    const bare = await executeCommand(finn, '!think');
    assert.match(bare, /Private reflection/);
    assert.match(bare, /stone pickaxe/);
    const repeated = await executeCommand(finn, '!think("another question")');
    assert.match(repeated, /Reflection blocked/);
    assert.equal(String(repeated).includes('secret'), false);

    noteReflectionAction(finn);
    const malformed = truncCommandMessage('!think "I cannot reach the acacia logs. What should I do?"');
    assert.equal(malformed, '!think("I cannot reach the acacia logs. What should I do?")');
    const parsed = parseCommandMessage(malformed);
    assert.equal(parsed.commandName, '!think');
    assert.deepEqual(parsed.args, ['I cannot reach the acacia logs. What should I do?']);
    const fromMalformed = await executeCommand(finn, '!think "I cannot reach the acacia logs. What should I do?"');
    assert.match(fromMalformed, /Private reflection/);

    const missing = parseCommandMessage('!searchWiki');
    assert.match(missing, /requires 1 args/);
    await executeCommand(finn, '!help');
    assert.equal(finn._reflection.locked, false);

    setSettings({});
});

test('live !think tells a wooden-pickaxe agent to make a stone pickaxe', { timeout: 90000 }, async () => {
    const routine = {
        think: false,
        keep_alive: -1,
        options: { num_ctx: 8192, num_predict: 512 }
    };
    const model = new Ollama('qwen3:8b', 'http://127.0.0.1:11434', routine);
    const original = model.send.bind(model);
    const bodies = [];
    model.send = async (endpoint, body, signal) => {
        bodies.push(JSON.parse(JSON.stringify(body)));
        return original(endpoint, body, signal);
    };
    setSettings({
        reasoning: {
            think: false,
            keep_alive: -1,
            timeout_ms: 45000,
            cooldown_ms: 45000,
            max_consecutive: 2,
            max_concurrent: 1,
            max_predict: 1024,
            options: { num_ctx: 8192, num_predict: 1024 }
        }
    });

    const finn = agent('Finn', model);
    const advice = await reflect(finn, 'I have a wooden pickaxe but cannot mine iron. What am I missing?');
    console.log('\n--- live !think ---\n' + advice + '\n--- end ---\n');

    assert.match(advice, /Private reflection/);
    assert.match(advice, /cobblestone|stone pickaxe/i);
    assert.doesNotMatch(advice, /!searchForBlock|search for (more )?iron|keep (searching|looking) for iron/i);
    assert.ok(advice.length < 1400);
    assert.ok(bodies.length >= 1);
    assert.ok(bodies.length <= 2);
    for (const body of bodies) {
        assert.ok(body.options.num_predict <= 1024);
        assert.equal(body.timeout_ms, undefined);
        assert.equal(JSON.stringify(body).includes('Sawyer'), false);
    }
    assert.equal(model.params.think, false);
    assert.equal(model.params.options.num_predict, 512);
    setSettings({});
});
});
