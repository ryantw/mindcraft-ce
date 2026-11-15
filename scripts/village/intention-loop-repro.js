/**
 * Reproduce Bram's abandon loop with no active intention.
 * Calls the local qwen3:8b model. Writes only a temporary intentions file.
 * Does not connect to Minecraft and does not change Village Alpha lives.
 *
 * Usage: node scripts/village/intention-loop-repro.js
 */
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeCommand } from '../../src/agent/commands/index.js';
import { ActionManager } from '../../src/agent/action_manager.js';
import { setSettings } from '../../src/agent/settings.js';
import { initializeMinecraftData } from '../../src/utils/mcdata.js';
import { parseCommandMessage } from '../../src/agent/commands/index.js';
import { readIntentions, updateIntention } from '../../src/village/intentions.js';
import { villageActionTurn } from '../../src/village/turn_taking.js';

initializeMinecraftData('1.21.6');

const APPLES = 'I\'ll find some apples to make a sandwich.';
const COMMAND = `!intention("abandon", "${APPLES}")`;
const LIVE = ['bram', 'cass', 'ione'].map(id =>
    new URL(`../../runtime/scenarios/village-alpha/${id}/intentions.json`, import.meta.url)
);

function digest(url) {
    if (!existsSync(url)) return null;
    return createHash('sha256').update(readFileSync(url)).digest('hex');
}

const before = Object.fromEntries(LIVE.map(url => [path.basename(path.dirname(fileURLToPath(url))), digest(url)]));
const liveBram = existsSync(LIVE[0]) ? JSON.parse(readFileSync(LIVE[0], 'utf8')) : { active: null, history: [] };

const parent = mkdtempSync(path.join(os.tmpdir(), 'village-intention-repro-'));
const copy = {
    schema_version: 1,
    active: null,
    waking_decision_at: liveBram.waking_decision_at || null,
    history: Array.isArray(liveBram.history) ? liveBram.history : [],
};
writeFileSync(path.join(parent, 'intentions.json'), JSON.stringify(copy, null, 2));
const historyBefore = JSON.stringify(readIntentions(parent).history);

setSettings({
    village_autonomy: true,
    agent_data_root: parent,
    language: 'en',
    reasoning: { auto_reflection: false },
});

const agent = {
    name: 'Bram',
    ready: true,
    blocked_actions: [],
    bot: { modes: { flushBehaviorLog: () => '' } },
    plan_manager: { enabled: false, observeOutcome: () => ({}) },
};
agent.actions = new ActionManager(agent);

const first = await executeCommand(agent, COMMAND);
const second = await executeCommand(agent, '!intention("abandon", "Maybe berries instead.")');
const afterFailed = readIntentions(parent);
const failedSame = JSON.stringify(afterFailed.history) === historyBefore && afterFailed.active === null;

const calls = [];
agent.prompter = {
    most_recent_msg_time: 0,
    async promptConvo() {
        calls.push(Date.now());
        return COMMAND;
    },
};
agent.history = {
    turns: [],
    add: async (_name, content) => agent.history.turns.push(content),
    save() {},
    getHistory() { return agent.history.turns.map(content => ({ role: 'assistant', content })); },
};
agent.self_prompter = {
    shouldInterrupt: () => false,
    isActive: () => true,
    handleUserPromptedCmd() {},
};
agent.routeResponse = () => {};
agent.checkTaskDone = async () => {};
agent.shut_up = false;

const { Agent } = await import('../../src/agent/agent.js');
agent.handleMessage = Agent.prototype.handleMessage;
agent._handleVillageOrSurvivalMessage = Agent.prototype._handleVillageOrSurvivalMessage;
const started = Date.now();
await agent.handleMessage('system', villageActionTurn(), -1, { ephemeral: true });
const oneDecisionMs = Date.now() - started;

async function complete(messages) {
    const startedAt = Date.now();
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
    const text = String(body.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return { text, ms: Date.now() - startedAt };
}

const recovery = villageActionTurn();
const model = await complete([
    { role: 'system', content: 'You are Bram, an inhabitant of a Minecraft village. You have no active intention. Reply to the scheduling instruction with exactly one command.' },
    { role: 'user', content: recovery },
]);
const parsed = parseCommandMessage(model.text);
const choice = typeof parsed === 'string'
    ? { kind: 'unparsed', detail: parsed }
    : { kind: parsed.commandName, args: parsed.args };

const opened = updateIntention(parent, { action: 'revise', text: 'Look in the chest.', now: () => '2026-11-15T21:00:00.000Z' });
const closed = updateIntention(parent, { action: 'abandon', text: APPLES, now: () => '2026-11-15T21:01:00.000Z' });
const finalStore = readIntentions(parent);

setSettings({});
rmSync(parent, { recursive: true, force: true });
const after = Object.fromEntries(LIVE.map(url => [path.basename(path.dirname(fileURLToPath(url))), digest(url)]));

const report = {
    live_intentions_unchanged: JSON.stringify(before) === JSON.stringify(after),
    live_active_before: liveBram.active,
    live_history_length: Array.isArray(liveBram.history) ? liveBram.history.length : 0,
    correction: first,
    equivalent_command: second,
    history_unchanged_by_failed_abandon: failedSame,
    inferences_in_one_decision: calls.length,
    one_decision_ms: oneDecisionMs,
    recovery_prompt_offers_abandon_command: recovery.includes('!intention("abandon"'),
    model: model.text,
    model_ms: model.ms,
    model_choice: choice,
    explicit_abandon_does_not_become_the_intention: closed.ok === true
        && closed.intentions.active === null
        && closed.intentions.history.at(-1).text === 'Look in the chest.'
        && String(closed.intentions.history.at(-1).progress).includes('apples'),
    opened_before_that_close: opened.ok === true,
    temp_history_length: finalStore.history.length,
};
console.log(JSON.stringify(report, null, 2));
