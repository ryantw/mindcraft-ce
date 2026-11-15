/**
 * Controlled reproduction of the Village Alpha speech loop.
 * Calls the local qwen3:8b model. Does not connect to Minecraft and does not
 * write runtime memory, identity, or death records.
 *
 * Usage: node scripts/village/speech-loop-repro.js
 */
import { readFileSync } from 'fs';
import { initializeMinecraftData } from '../../src/utils/mcdata.js';
import { parseCommandMessage } from '../../src/agent/commands/index.js';
import { stripAddresseeLabels } from '../../src/village/locality.js';
import { villageActionTurn } from '../../src/village/turn_taking.js';

initializeMinecraftData('1.21.6');

const OLD_RECOVERY = 'You have repeated yourself without a new action or a new observation. Do not say that again. You may use one !commandName, revise or abandon the intention with !intention, or stay still without repeating yourself. Saying an intention aloud is not doing it.';

function placesFor(id) {
    return JSON.parse(readFileSync(new URL(`../../runtime/scenarios/village-alpha/${id}/places.json`, import.meta.url)));
}

function placeNames(places) {
    return Object.keys(places).join(', ');
}

async function complete(messages) {
    const started = Date.now();
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'qwen3:8b',
            stream: false,
            think: false,
            options: { num_ctx: 8192, num_predict: 80 },
            messages,
        }),
        signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`ollama ${response.status}`);
    const body = await response.json();
    const text = String(body.message?.content || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
    return { text, ms: Date.now() - started };
}

function describeChoice(text, places, start) {
    const spoken = stripAddresseeLabels(text);
    const parsed = parseCommandMessage(spoken);
    if (!parsed || typeof parsed === 'string') {
        return {
            kind: 'speech',
            broadcast: false,
            said: spoken,
            detail: 'Action selection does not broadcast this sentence.',
        };
    }
    if (parsed.commandName === '!stay') {
        return {
            kind: 'wait',
            command: `!stay(${parsed.args[0]})`,
            position: start,
            outcome: `Wait ${parsed.args[0]} seconds at ${start}. The position does not change. This is a completed wait.`,
        };
    }
    if (parsed.commandName === '!goToRememberedPlace') {
        const name = String(parsed.args[0]);
        const destination = places[name] || null;
        return {
            kind: 'action',
            command: `!goToRememberedPlace("${name}")`,
            from: start,
            destination: destination ? { name, x: destination[0], y: destination[1], z: destination[2], closeness: 1 } : null,
            outcome: destination
                ? `Walk from ${start} to remembered place ${name} at ${destination.join(', ')}, stopping within 1 block.`
                : `No remembered place named ${name}.`,
        };
    }
    if (parsed.commandName === '!intention') {
        return {
            kind: 'intention',
            command: `${parsed.commandName}(${parsed.args.map(arg => JSON.stringify(arg)).join(', ')})`,
            position: start,
            outcome: 'The intention record changes. The body is not moved.',
        };
    }
    return {
        kind: 'action',
        command: parsed.commandName,
        args: parsed.args,
        from: start,
        outcome: 'Existing command accepted as the next action.',
    };
}

const cases = [
    {
        name: 'Ione',
        start: 'offline at sample time',
        history: [
            { role: 'assistant', content: "I'll stay here and watch for changes." },
            { role: 'assistant', content: "I'll stay here and watch for changes." },
            { role: 'assistant', content: "I'll stay here and watch for changes." },
        ],
    },
    {
        name: 'Bram',
        start: '[-442.5, 62.9, -698.7]',
        history: [
            { role: 'assistant', content: '(To Cass) See you there.' },
            { role: 'assistant', content: '(To Cass) (To Cass) See you there.' },
            { role: 'assistant', content: '(To Cass) See you there.' },
        ],
    },
    {
        name: 'Cass',
        start: '[-469.5, 82.9, -715.3]',
        history: [
            { role: 'assistant', content: "I'm heading home. See you there." },
            { role: 'user', content: 'Bram: See you there.' },
        ],
    },
];

const report = [];
for (const item of cases) {
    const places = placesFor(item.name.toLowerCase());
    const afterPrompt = villageActionTurn(placeNames(places));
    const system = `You are ${item.name}, an inhabitant of a Minecraft village. Recent turns are your own history. Reply to the scheduling instruction only.`;
    const before = await complete([
        { role: 'system', content: system },
        ...item.history,
        { role: 'user', content: OLD_RECOVERY },
    ]);
    const after = await complete([
        { role: 'system', content: system },
        ...item.history,
        { role: 'user', content: afterPrompt },
    ]);
    let follow = null;
    if (describeChoice(after.text, places, item.start).kind === 'speech') {
        const gapStarted = Date.now();
        follow = await complete([
            { role: 'system', content: system },
            ...item.history,
            { role: 'assistant', content: after.text },
            { role: 'user', content: `${afterPrompt} The previous sentence was not sent.` },
        ]);
        follow.gap_ms = Date.now() - gapStarted;
    }
    report.push({
        name: item.name,
        start: item.start,
        before: before.text,
        before_ms: before.ms,
        after: after.text,
        after_ms: after.ms,
        after_choice: describeChoice(after.text, places, item.start),
        follow_up: follow ? { text: follow.text, ms: follow.ms, choice: describeChoice(follow.text, places, item.start) } : null,
    });
    console.log(JSON.stringify(report.at(-1), null, 2));
}
