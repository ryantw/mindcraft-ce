import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import convoManager from '../agent/conversation.js';
import { attributeTurnsForSummary, durableMemoryView, isTransientMemoryTurn, stripCommandSyntax } from '../agent/chat_hygiene.js';
import { formatKnownFacts } from '../agent/lessons.js';
import { agentDataDir } from '../agent/data_dir.js';
import { appendVillageContext, renderVillageContext, wantsVillagePrompt } from '../village/context.js';
import { adaptVillagePrompt, villagePlanPrompt, villageSelfPromptLine } from '../village/voice.js';
import { watchDayModel } from '../village/day_pulse.js';
import { activeIntentionText, readIntentions } from '../village/intentions.js';
import { activeAmbitionText, readAmbitions } from '../village/ambitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function villagePlanningSystem({ name, goal, known, context }) {
    return [
        `You are ${name}. The current goal is already chosen: "${goal}".`,
        'Plan the next few concrete steps that pursue that goal. A plan does not have to achieve the whole goal. Do not choose a different objective. Do not invent places, materials, people, or events that are not in the known state.',
        'When the goal depends on a discovery you have not made, plan only the next information-gathering part. If the goal names a place in the known state and your position is somewhere else, the first step travels to that place\'s coordinates from the known state. The following step observes with nearbyBlocks and entities. Looking around where you already stand does not visit another place. After those steps succeed, a later plan can use what was observed. Do not name a block, item, or entity you have not seen. Do not substitute a familiar block for an object the goal has not identified. Placeholder names, invented entity names, and unknown item types are not executable.',
        'A flower is not a full solid block. placeBlockAt, buildLine, and buildPlane cannot place one. collectBlocks harvests the nearest blocks of a type into inventory. placeHere places one block you are holding at your feet, so walk to the spot first.',
        '',
        'KNOWN STATE',
        known || 'No additional notes.',
        '',
        context,
        '',
        'Return ONLY one JSON object with this shape:',
        '{"objective":"the current goal exactly","rationale":"why these steps pursue it","materials":[],"steps":[{"id":"go","description":"one travel step","action":{"name":"goToCoordinates","params":{"x":0,"y":0,"z":0,"closeness":2}},"evidence":{"type":"position_near","position":{"x":0,"y":0,"z":0},"radius":2},"requires":[],"requiredResources":[],"prerequisites":[]},{"id":"look","description":"one observation step","action":{"name":"nearbyBlocks","params":{}},"evidence":{"type":"verified_action","action":"nearbyBlocks","params":{}},"requires":[],"requiredResources":[],"prerequisites":[]}]}',
        '',
        'The example shows the required fields, not a destination. Do not copy its wording or coordinates. Use 1 to 6 ordered steps. One or two steps are enough when you still need to see the place. Travel with goToRememberedPlace(name) or goToCoordinates(x, y, z, closeness) only to a name or coordinates copied from the known state. Action names omit the leading !. Every step must use a command from AVAILABLE ACTION COMMANDS with its exact parameter names. Never plan a step that needs a command you do not have. nearbyBlocks, entities, inventory, and savedPlaces are valid steps when you need to look before acting; their evidence is verified_action with those same empty or listed parameters. Prefer commands with structured verification when applicable: collectBlocks, discard, craftRecipe, placeHere, placeBlockAt, buildLine, buildPlane, smeltItem. Allowed evidence types are: inventory_min, inventory_delta, block_at, block_nearby, position_near, and verified_action. For collectBlocks, inventory evidence must be the item that block drops, not an unrelated item. For placeHere, use verified_action for that same action and parameters. Do not use a claim, intention, chat message, or remembered quantity as completion evidence.',
    ].join('\n');
}

function parseJsonObject(text) {
    const cleaned = String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
    const start = cleaned.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index++) {
        const character = cleaned[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') depth++;
        else if (character === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(cleaned.slice(start, index + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

export function shouldUseConversationExamples(contextKind='human') {
    if (contextKind === 'human') return true;
    return settings.allow_retrieved_examples_in_non_human_contexts !== false;
}

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            this.embedding_model = createModel({api: chat_model_profile.api});
        }

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        const dataDir = agentDataDir(name);
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(path.join(dataDir, 'last_profile.json'), JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        const includeVillage = settings.village_autonomy === true
            && settings.agent_data_root
            && wantsVillagePrompt(prompt);
        if (settings.village_autonomy === true) prompt = adaptVillagePrompt(prompt);
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES')) {
            const exampleText = examples !== null
                ? await examples.createExampleMessage(messages)
                : '';
            prompt = prompt.replaceAll('$EXAMPLES', exampleText);
        }
        if (prompt.includes('$KNOWN_FACTS'))
            prompt = prompt.replaceAll('$KNOWN_FACTS', formatKnownFacts(this.agent));
        if (prompt.includes('$MEMORY')) {
            const memory = settings.village_autonomy === true
                ? ''
                : durableMemoryView(this.agent.history.memory);
            prompt = prompt.replaceAll('$MEMORY', memory);
        }
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            const current = this.agent.self_prompter?.prompt || '';
            const self_prompt = settings.village_autonomy === true
                ? villageSelfPromptLine(current, { stopped: this.agent.self_prompter?.isStopped?.() })
                : (!this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${current}"\n` : '');
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$PLAN')) {
            // Nothing is injected while persistent planning is disabled.
            let plan = '';
            if (this.agent.plan_manager?.enabled) {
                plan = settings.village_autonomy === true
                    ? villagePlanPrompt(this.agent.plan_manager)
                    : (this.agent.plan_manager.formatForPrompt() ||
                        'PERSISTENT PLAN\nNo plan has been selected yet.') + '\n';
            }
            prompt = prompt.replaceAll('$PLAN', plan);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        if (includeVillage) {
            const intention = this.agent.self_prompter?.prompt || '';
            const village = renderVillageContext(settings.agent_data_root, { intention });
            prompt = appendVillageContext(prompt, village.text);
            const morning = village.text.includes('This morning you remember');
            const personal = village.text.includes('Current intention:');
            const summary = String(this.agent.history?.memory || '').trim();
            const legacy = summary.length > 24 && prompt.includes(summary.slice(0, 40));
            console.log(`[village-context] ${this.agent.name} chars=${village.chars} morning=${morning} intention=${personal} legacy_summary=${legacy ? 'present' : 'omitted'}`);
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages, { contextKind = 'human' } = {}) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            const contextMessages = contextKind === 'human'
                ? messages
                : messages.filter(turn => !isTransientMemoryTurn(turn));
            let prompt = this.profile.conversing;
            const useExamples = shouldUseConversationExamples(contextKind);
            if (!useExamples) {
                this.loggedExamplePolicies ??= new Set();
                if (!this.loggedExamplePolicies.has(contextKind)) {
                    this.loggedExamplePolicies.add(contextKind);
                    console.log(`[${this.agent.name}] Retrieved conversation examples disabled for ${contextKind} context.`);
                }
            }
            const examples = useExamples ? this.convo_examples : null;
            prompt = await this.replaceStrings(prompt, contextMessages, examples);
            let generation;

            try {
                watchDayModel(true);
                generation = await this.chat_model.sendRequest(contextMessages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            } finally {
                watchDayModel(false);
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        // Label other agents' words so they are not recorded as this agent's
        // own experience, and drop command syntax from what gets summarized.
        const attributed = attributeTurnsForSummary(to_summarize, this.agent.name, name => convoManager.isOtherAgent(name));
        prompt = await this.replaceStrings(prompt, null, null, attributed);
        let resp = await this.chat_model.sendRequest([], prompt);
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink;
        }
        // Memory holds durable lessons, never command invocations.
        return typeof resp === 'string' ? stripCommandSyntax(resp) : resp;
    }

    async promptPlanning(reason, previousPlan=null, feedback=null) {
        if (!this.agent.plan_manager?.enabled) return null;
        await this.checkCooldown();
        let prompt = this.profile.planning;
        const previous = this.agent.plan_manager?.formatForPrompt?.() ||
            (previousPlan ? JSON.stringify(previousPlan, null, 2) : 'No previous plan.');
        prompt = prompt
            .replaceAll('$PLAN_REASON', String(reason || 'no_active_plan'))
            .replaceAll('$PREVIOUS_PLAN', previous);
        // Live, code-built context (real command signatures, construction
        // limits, resource-sufficiency rules, rejection feedback). Appended
        // when a profile's planning prompt predates the $PLAN_CONTEXT slot.
        const context = this.agent.plan_manager?.planningContext?.(feedback) || '';
        prompt = prompt.includes('$PLAN_CONTEXT')
            ? prompt.replaceAll('$PLAN_CONTEXT', context)
            : `${prompt}\n\n${context}`;
        let response;
        watchDayModel(true);
        const villageGoal = settings.village_autonomy === true && settings.agent_data_root
            ? activeIntentionText(readIntentions(settings.agent_data_root))
            : '';
        const villageAmbition = villageGoal
            ? activeAmbitionText(readAmbitions(settings.agent_data_root))
            : '';
        if (villageGoal) {
            // The goal is already chosen. The survival planning essay asks the
            // model to invent an objective, which is the wrong request here.
            let known = '';
            try {
                known = await this.replaceStrings('CURRENT GAME STATE\n$STATS\n$INVENTORY\n$KNOWN_FACTS', []);
            } catch (error) {
                known = 'Live game state is unavailable.';
            }
            const notes = renderVillageContext(settings.agent_data_root, { intention: villageGoal }).text;
            const seen = (previous?.steps || [])
                .map(step => step?.lastOutcome?.observation ? `- ${step.id}: ${step.lastOutcome.observation}` : '')
                .filter(Boolean);
            if (seen.length) known = `${known}\n\nOBSERVED DURING THE FINISHED PLAN\n${seen.join('\n')}`;
            prompt = villagePlanningSystem({
                name: this.agent.name,
                goal: villageGoal,
                known: [known, notes].filter(Boolean).join('\n\n'),
                context,
            });
        } else {
            prompt = await this.replaceStrings(prompt, []);
        }
        const planningRequest = villageGoal
            ? `Your current goal is already chosen: "${villageGoal}". Your long-term ambition, for context only: "${villageAmbition || 'none recorded'}". Plan the next few concrete steps that pursue that goal. The plan does not have to finish the goal. If the goal names a place and you are not already there, travel to that place's coordinates from the known state, then observe. Do not only look around where you already stand. Do not invent a block, item, or entity name. Set objective to the current goal exactly. Return only the JSON object.`
            : 'Choose your objective and plan now. Return only the JSON object.';
        try {
        if (typeof this.chat_model.complete === 'function') {
            // One-shot call with room for a multi-step JSON plan (the chat
            // profile caps output at 512 tokens, which truncates build plans)
            // and a timeout that tolerates five agents sharing one Ollama.
            // qwen3 thinking is counted inside num_predict. A village plan that
            // thought with a 2048 budget returned an empty answer, so this
            // call does not think. The JSON has to be the whole response.
            const result = await this.chat_model.complete(
                planningRequest,
                prompt,
                {
                    think: false,
                    keep_alive: -1,
                    timeout_ms: villageGoal ? 180000 : 120000,
                    max_predict: 1024,
                    options: { num_predict: 1024 },
                }
            );
            response = result?.content ?? '';
            if (!String(response).trim()) {
                console.warn(`[${this.agent.name}] Planning returned no answer. done_reason=${result?.done_reason || 'unknown'} generated_tokens=${result?.eval_count ?? 'unknown'} thinking_chars=${(result?.thinking || '').length}`);
            } else if (result?.done_reason === 'length') {
                console.warn(`[${this.agent.name}] Planning response hit the token limit and may be truncated.`);
            }
        } else {
            response = await this.chat_model.sendRequest([], prompt);
        }
        await this._saveLog(prompt, [], response, 'planning');
        } finally {
            watchDayModel(false);
        }
        const proposal = parseJsonObject(response);
        if (!proposal || typeof proposal.objective !== 'string' || !Array.isArray(proposal.steps)) {
            console.warn(`[${this.agent.name}] Could not parse a valid persistent plan:`, response);
            return null;
        }
        if (villageGoal) proposal.objective = villageGoal;
        return proposal;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task?.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task?.task_id;
        const logRoot = settings.agent_data_root
            ? path.join(agentDataDir(this.agent.name), 'logs')
            : path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        const logDir = task_id == null ? logRoot : path.join(logRoot, String(task_id));

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
