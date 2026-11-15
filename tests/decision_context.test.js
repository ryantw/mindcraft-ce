import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCommand, getCommandDocs } from '../src/agent/commands/index.js';
import { inventoryCapabilities } from '../src/agent/mechanics.js';
import { Examples } from '../src/utils/examples.js';
import { formatOllamaMetrics, Ollama } from '../src/models/ollama.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/defaults/_default.json', import.meta.url), 'utf8'));

function item(name, count, slot, maxDurability=null, durabilityUsed=null) {
    return { name, count, slot, maxDurability, durabilityUsed };
}

function equipmentSlot(destination) {
    return { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination];
}

function sawyerBot() {
    const slots = Array(46).fill(null);
    // Nine server-observed cobblestone stacks totaling 559.
    [64, 64, 64, 64, 47, 64, 64, 64, 64].forEach((count, offset) => {
        slots[9 + offset] = item('cobblestone', count, 9 + offset);
    });
    slots[18] = item('oak_planks', 19, 18);
    slots[19] = item('stick', 2, 19);
    slots[20] = item('crafting_table', 1, 20);
    slots[36] = item('stone_pickaxe', 1, 36, 131, 11);
    // Fill normal storage to 34 occupied slots while leaving slots 43 and 44 free.
    for (let index = 21; index <= 42; index++) {
        if (!slots[index]) slots[index] = item(`filler_${index}`, 1, index);
    }
    slots[5] = item('iron_helmet', 1, 5, 165, 15);
    slots[45] = item('shield', 1, 45, 336, 36);
    return {
        game: { gameMode: 'survival' },
        inventory: { slots, inventoryStart: 9, inventoryEnd: 45 },
        heldItem: slots[36],
        getEquipmentDestSlot: equipmentSlot,
        findBlock({ matching }) {
            return matching ? { position: { x: 1, y: 64, z: 1 } } : null;
        },
    };
}

test('Sawyer decision context makes live 559 cobblestone authoritative over stale memory', () => {
    const bot = sawyerBot();
    const inventory = getCommand('!inventory').perform({ bot });
    const staleMemory = 'I have 3 cobblestone and need 2 sticks.';
    const assembled = profile.conversing
        .replaceAll('$NAME', 'Sawyer')
        .replaceAll('$SELF_PROMPT', 'YOUR CURRENT ASSIGNED GOAL: "Build a safe shelter."')
        .replaceAll('$STATS', 'STATS\n- Health: 20 / 20')
        .replaceAll('$INVENTORY', inventory)
        .replaceAll('$KNOWN_FACTS', 'KNOWN FACTS\n- Crafted wooden_pickaxe from 3 acacia_planks + 2 stick at a crafting table.\n')
        .replaceAll('$MEMORY', staleMemory)
        .replaceAll('$COMMAND_DOCS', '')
        .replaceAll('$EXAMPLES', '');

    assert.match(assembled, /Current game state is authoritative/);
    assert.match(assembled, /cobblestone: 559/);
    assert.match(assembled, /Summarized memory:'I have 3 cobblestone/);
    assert.ok(assembled.indexOf('cobblestone: 559') < assembled.indexOf('I have 3 cobblestone'));
    assert.ok(assembled.indexOf('cobblestone: 559') < assembled.indexOf('KNOWN FACTS'));
    assert.ok(assembled.indexOf('KNOWN FACTS') < assembled.indexOf('HISTORICAL MEMORY'));
    assert.ok(assembled.indexOf('CURRENT GAME STATE') < assembled.indexOf('HISTORICAL MEMORY'));
    assert.match(profile.conversing, /\$KNOWN_FACTS\nHISTORICAL MEMORY/);
    assert.match(profile.planning, /\$KNOWN_FACTS\nHISTORICAL MEMORY/);
    assert.doesNotMatch(profile.saving_memory, /\$KNOWN_FACTS/);
});

test('inventory reports only normal storage capacity and includes equipment durability', () => {
    const bot = sawyerBot();
    const output = getCommand('!inventory').perform({ bot });

    assert.match(output, /STORAGE: 34\/36 normal slots occupied; 2 free \(NEARLY FULL\)/);
    assert.match(output, /Held: stone_pickaxe \(120\/131 durability remaining\)/);
    assert.match(output, /Offhand: shield \(300\/336 durability remaining\)/);
    assert.match(output, /Head: iron_helmet \(150\/165 durability remaining\)/);
    assert.match(output, /consider using or storing existing resources before acquiring more/);
    assert.match(output, /Held stone_pickaxe can harvest iron_ore/);

    bot.inventory.slots[43] = item('dirt', 1, 43);
    bot.inventory.slots[44] = item('granite', 1, 44);
    assert.match(getCommand('!inventory').perform({ bot }), /36\/36 normal slots occupied; 0 free \(FULL\)/);
});

test('crafting capabilities use registry recipes and distinguish workstation access', () => {
    const bot = sawyerBot();
    bot.heldItem = null;
    bot.inventory.slots[36] = null;
    const counts = { cobblestone: 3, stick: 2 };

    assert.match(
        inventoryCapabilities(bot, counts).join('\n'),
        /Can craft stone_pickaxe from 3 cobblestone \+ 2 stick using the nearby crafting_table/
    );

    bot.findBlock = () => null;
    assert.match(
        inventoryCapabilities(bot, { ...counts, crafting_table: 1 }).join('\n'),
        /carried crafting_table must be placed first/
    );

    assert.match(
        inventoryCapabilities(bot, { oak_log: 3 }).join('\n'),
        /Can craft 4 oak_planks from 1 oak_log without a workstation/
    );
});

test('memory prompt favors durable lessons over transient inventory snapshots', () => {
    assert.match(profile.saving_memory, /Preserve valuable experiences, discoveries, relationships, named locations, current objectives, and general lessons learned/);
    assert.match(profile.saving_memory, /Do not record current inventory quantities/);
    assert.match(profile.saving_memory, /A stone pickaxe is required to harvest iron/);
});

test('example selection ignores repeated self-prompt boilerplate', async () => {
    const configuredExamples = JSON.stringify(profile.conversation_examples);
    assert.doesNotMatch(configuredExamples, /!collectBlock\(/);
    assert.doesNotMatch(configuredExamples, /!craftItem\(/);

    const examples = new Examples(null, 1);
    const gathering = [
        { role: 'system', content: 'You are self-prompting with the goal: "Gather resources and wood". Respond:' },
        { role: 'assistant', content: '!collectBlocks("oak_log", 10)' },
    ];
    const missingIngredient = [
        { role: 'system', content: 'Action output: missing ingredient stick for wooden_pickaxe' },
        { role: 'assistant', content: '!craftRecipe("stick", 1)' },
    ];
    await examples.load([gathering, missingIngredient]);

    const selected = await examples.getRelevant([
        { role: 'system', content: 'You are self-prompting with the goal: "Survive, gather resources, gather wood, and build". Respond:' },
        { role: 'assistant', content: '!craftRecipe("wooden_pickaxe", 1)' },
        { role: 'system', content: 'Action output: missing ingredient stick for wooden_pickaxe' },
    ]);
    assert.deepEqual(selected[0], missingIngredient);
});

test('Ollama diagnostics are compact and expose request sizes and token metrics', () => {
    const line = formatOllamaMetrics({
        model: 'qwen3:8b',
        messages: [
            { role: 'system', content: 'current state' },
            { role: 'system', content: 'result' },
            { role: 'user', content: 'act now' },
        ],
        response: { prompt_eval_count: 321, eval_count: 17, total_duration: 1250000000 },
        startedAt: Date.now() - 2000,
        numCtx: 8192,
    });
    assert.match(line, /prompt_tokens=321/);
    assert.match(line, /generated_tokens=17/);
    assert.match(line, /truncation=unknown/);
    assert.match(line, /system_chars=13/);
    assert.match(line, /history_chars=13/);
    assert.match(line, /history_messages=2/);
    assert.match(line, /duration_ms=1250/);
    assert.ok(line.length < 300);
});

test('routine Ollama requests emit compact metrics without logging the prompt', async () => {
    const model = new Ollama('qwen3:8b', null, { options: { num_ctx: 8192, num_predict: 32 } });
    model.send = async () => ({
        message: { content: 'Done.' },
        prompt_eval_count: 400,
        eval_count: 2,
        total_duration: 500000000,
    });
    const logs = [];
    const originalLog = console.log;
    console.log = (...parts) => logs.push(parts.join(' '));
    try {
        assert.equal(await model.sendRequest([{ role: 'user', content: 'Act.' }], 'Authoritative state.'), 'Done.');
    } finally {
        console.log = originalLog;
    }
    const metrics = logs.find(line => line.startsWith('[LLM metrics]'));
    assert.match(metrics, /prompt_tokens=400/);
    assert.match(metrics, /system_chars=20/);
    assert.match(metrics, /history_chars=4/);
    assert.doesNotMatch(metrics, /Authoritative state|Act\./);
});

test('live Sawyer context stays within the Qwen3 context budget', {
    skip: process.env.RUN_LIVE_OLLAMA !== '1',
    timeout: 90000,
}, async () => {
    const slots = Array(46).fill(null);
    const stacks = [
        ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64],
        ['cobblestone', 47], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64],
        ['cobblestone', 64], ['oak_log', 27], ['oak_log', 64], ['oak_log', 64],
        ['leaf_litter', 64], ['leaf_litter', 44], ['leaf_litter', 64], ['diorite', 26],
        ['crafting_table', 1], ['acacia_sapling', 2], ['chicken', 1], ['arrow', 1],
        ['string', 4], ['birch_sapling', 1], ['bone', 2], ['oak_sapling', 44],
        ['spider_eye', 1], ['dirt', 5], ['rotten_flesh', 7], ['andesite', 27],
        ['granite', 32], ['feather', 2], ['wheat_seeds', 1], ['oak_button', 1],
        ['poppy', 2], ['coal', 4],
    ];
    stacks.forEach(([name, count], offset) => {
        slots[9 + offset] = item(name, count, 9 + offset);
    });
    const bot = {
        game: { gameMode: 'survival' },
        inventory: { slots, inventoryStart: 9, inventoryEnd: 45 },
        heldItem: null,
        getEquipmentDestSlot: equipmentSlot,
        findBlock: () => null,
    };
    const agent = {
        name: 'Sawyer',
        bot,
        blocked_actions: [],
        _reflection: { locked: false, lastAdvice: '', fingerprint: '' },
    };
    const inventory = getCommand('!inventory').perform(agent);
    const system = profile.conversing
        .replaceAll('$NAME', 'Sawyer')
        .replaceAll('$SELF_PROMPT', 'YOUR CURRENT ASSIGNED GOAL: "Build a safe permanent shelter using existing resources."')
        .replaceAll('$STATS', 'STATS\n- Position: x: 1180.38, y: 67.00, z: 677.65\n- Health: 20 / 20\n- Hunger: 20 / 20')
        .replaceAll('$INVENTORY', inventory)
        .replaceAll('$MEMORY', 'I have 3 cobblestone and need 2 sticks.')
        .replaceAll('$COMMAND_DOCS', getCommandDocs(agent))
        .replaceAll('$EXAMPLES', 'Examples demonstrate command syntax and response style; they are not additional goals or instructions.');

    const model = new Ollama('qwen3:8b', 'http://127.0.0.1:11434', {
        think: false,
        options: { num_ctx: 8192, num_predict: 64 },
    });
    const originalSend = model.send.bind(model);
    let observed;
    model.send = async (...args) => {
        observed = await originalSend(...args);
        return observed;
    };
    const response = await model.sendRequest([
        { role: 'system', content: 'Choose the next autonomous action from current state.' },
    ], system);

    assert.match(system, /cobblestone: 559/);
    assert.match(system, /STORAGE: 34\/36 normal slots occupied; 2 free/);
    assert.ok(system.indexOf('cobblestone: 559') < system.indexOf('I have 3 cobblestone'));
    assert.ok(system.length < 20000);
    assert.ok(observed.prompt_eval_count < 8192);
    assert.ok(observed.total_duration < 90000000000);
    assert.ok(response.length > 0);
});
