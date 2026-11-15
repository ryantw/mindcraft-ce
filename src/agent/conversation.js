import settings from './settings.js';
import { containsCommand, stripUnsharedCommands } from './commands/index.js';
import { sendBotChatToServer } from './mindserver_proxy.js';
import { acceptInWorldSpeech, claimSpeech, DEFAULT_HEARING_BLOCKS, speakerDistance } from '../village/locality.js';

let agent;
let agent_names = [];
let agents_in_game = [];

const REPETITIVE_TURN_LIMIT = 4;
const PROGRESS_HISTORY_LIMIT = 4;
const CONVERSATION_COOLDOWN_MS = 30000;
const SELF_PROMPT_RESUME_DELAY_MS = 5000;
const CONVERSATIONAL_FILLER = new Set([
    'a', 'about', 'also', 'an', 'and', 'anything', 'are', 'at', 'but', 'currently',
    'do', 'doing', 'for', 'fun', 'here', 'how', 'i', 'im', 'is', 'it', 'its',
    'just', 'looking', 'maybe', 'much', 'new', 'no', 'nothing', 'now', 'okay',
    'or', 'pretty', 'really', 'so', 'some', 'something', 'still', 'stuff', 'sure',
    'the', 'there', 'to', 'too', 'up', 'we', 'were', 'what', 'yes', 'you',
    'youre', 'yeah',
]);

export function normalizeConversationMessage(message) {
    if (typeof message !== 'string')
        return '';
    return message
        .toLocaleLowerCase()
        .normalize('NFKC')
        .replace(/[’']/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

export function areMessagesSubstantiallySimilar(first, second) {
    const normalizedFirst = normalizeConversationMessage(first);
    const normalizedSecond = normalizeConversationMessage(second);
    if (!normalizedFirst || !normalizedSecond)
        return false;
    if (normalizedFirst === normalizedSecond)
        return true;

    const firstTokens = new Set(normalizedFirst.split(' '));
    const secondTokens = new Set(normalizedSecond.split(' '));
    if (Math.min(firstTokens.size, secondTokens.size) < 4)
        return false;

    let intersection = 0;
    for (const token of firstTokens) {
        if (secondTokens.has(token))
            intersection++;
    }
    const union = firstTokens.size + secondTokens.size - intersection;
    const lengthRatio = Math.min(firstTokens.size, secondTokens.size)
        / Math.max(firstTokens.size, secondTokens.size);
    const meaningfulChanges = [...firstTokens, ...secondTokens].filter(token =>
        !CONVERSATIONAL_FILLER.has(token)
        && !(firstTokens.has(token) && secondTokens.has(token))
    );
    return meaningfulChanges.length === 0
        && lengthRatio >= 0.7
        && intersection / union >= 0.6;
}

function runDetached(operation, context) {
    Promise.resolve(operation).catch(error => {
        console.error(`${context}:`, error);
    });
}

export class Conversation {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
        this.responseGeneration = 0;
        this.progressHistory = { incoming: [], outgoing: [] };
        this.repetitiveTurns = 0;
        this.repetitiveDirections = new Set();
        this.cooldownUntil = 0;
    }

    clearTimer() {
        // Invalidate decisions still waiting on a model or self-prompter pause.
        this.responseGeneration++;
        if (this.inMessageTimer) {
            clearTimeout(this.inMessageTimer);
            this.inMessageTimer = null;
        }
    }

    reset() {
        this.clearTimer();
        this.active = false;
        this.ignore_until_start = false;
        this.in_queue = [];
        this.resetProgress();
    }

    end() {
        this.clearTimer();
        this.active = false;
        this.ignore_until_start = true;
        const full_message = compileInMessages(this);
        if (full_message.message.trim().length > 0) {
            runDetached(
                agent.history.add(this.name, full_message.message),
                `Failed to archive queued conversation with ${this.name}`
            );
        }
        // add the full queued messages to history, but don't respond

        if (agent.last_sender === this.name)
            agent.last_sender = null;

        this.resetProgress();
    }

    queue(message) {
        this.in_queue.push(message);
    }

    resetProgress() {
        this.progressHistory = { incoming: [], outgoing: [] };
        this.repetitiveTurns = 0;
        this.repetitiveDirections = new Set();
    }

    observeProgress(direction, message) {
        if (containsCommand(message)) {
            this.resetProgress();
            return false;
        }

        const history = this.progressHistory[direction];
        const repeated = history.some(previous =>
            areMessagesSubstantiallySimilar(previous, message)
        );
        history.push(message);
        if (history.length > PROGRESS_HISTORY_LIMIT)
            history.shift();

        if (!repeated) {
            this.repetitiveTurns = 0;
            this.repetitiveDirections.clear();
            return false;
        }

        this.repetitiveTurns++;
        this.repetitiveDirections.add(direction);
        return this.repetitiveTurns >= REPETITIVE_TURN_LIMIT
            && this.repetitiveDirections.size === 2;
    }

    startCooldown(duration = CONVERSATION_COOLDOWN_MS) {
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + duration);
    }

    cooldownRemaining() {
        return Math.max(0, this.cooldownUntil - Date.now());
    }
}

const WAIT_TIME_START = 30000;
class ConversationManager {
    constructor() {
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.wait_time_limit = WAIT_TIME_START;
        this.cooldown_ms = CONVERSATION_COOLDOWN_MS;
        this.resume_delay_ms = SELF_PROMPT_RESUME_DELAY_MS;
    }

    initAgent(a) {
        agent = a;
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return; // will clean itself up
            }

            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && agent.isIdle()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    runDetached(
                        agent.handleMessage('system', `${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds, respond with a message to them or your own action.`),
                        `Failed to prompt for stalled conversation with ${convo_partner}`
                    );
                    wait_time = 0;
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = WAIT_TIME_START;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        runDetached(
                            agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`),
                            `Failed to report disconnected conversation partner ${convo_partner}`
                        );
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, 1000);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message) {
        const convo = this._getConvo(send_to);
        const cooldownRemaining = convo.cooldownRemaining();
        if (cooldownRemaining > 0) {
            console.log(`[${agent.name}] Conversation with ${send_to} not restarted: progress-watchdog cooldown has ${Math.ceil(cooldownRemaining / 1000)}s remaining.`);
            return false;
        }
        convo.reset();
        const generation = convo.responseGeneration;

        if (agent.self_prompter.isActive()) {
            await agent.self_prompter.pause();
        }
        if (convo.responseGeneration !== generation || convo.active)
            return;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        this.sendToBot(send_to, message, true, settings.village_autonomy === true);
        return true;
    }

    startConversationFromOtherBot(name) {
        const convo = this._getConvo(name);
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            console.warn(`${agent.name} tried to send bot message to non-bot ${send_to}`);
            return;
        }
        const convo = this._getConvo(send_to);

        message = stripUnsharedCommands(message);
        if (!message) return;
        if (settings.chat_bot_messages && open_chat)
            runDetached(agent.openChat(`(To ${send_to}) ${message}`), `Failed to mirror message to ${send_to}`);

        if (convo.ignore_until_start)
            return;
        convo.active = true;

        const end = message.includes('!endConversation');
        if (!end && convo.observeProgress('outgoing', message)) {
            this._endRepetitiveConversation(send_to);
            return;
        }
        const json = {
            'message': message,
            start,
            end,
        };

        this.awaiting_response = true;
        sendBotChatToServer(send_to, json);
    }

    async receiveFromBot(sender, received) {
        if (settings.village_autonomy === true) {
            const range = settings.village_hearing_blocks || DEFAULT_HEARING_BLOCKS;
            const distance = speakerDistance(agent?.bot, sender);
            if (!acceptInWorldSpeech({ village: true, distance, range })) {
                console.log(`[${agent?.name}] Did not hear ${sender}; no body is within ${range} blocks.`);
                return;
            }
            if (!claimSpeech(sender, received?.message)) return;
        }
        const convo = this._getConvo(sender);

        if (received.start && convo.cooldownRemaining() > 0) {
            const cooldownRemaining = convo.cooldownRemaining();
            console.log(`[${agent.name}] Declined conversation restart from ${sender}: progress-watchdog cooldown has ${Math.ceil(cooldownRemaining / 1000)}s remaining.`);
            this._sendWatchdogEnd(sender, cooldownRemaining);
            return;
        }

        if (convo.ignore_until_start && !received.start)
            return;

        // check if any convo is active besides the sender
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation("${sender}")`, false, false);
            this.endConversation(sender);
            return;
        }

        if (received.start) {
            convo.reset();
            this.startConversationFromOtherBot(sender);
        }

        this._clearMonitorTimeouts();
        convo.clearTimer();
        const generation = convo.responseGeneration;
        convo.queue(received);

        if (received.conversation_watchdog?.reason === 'repetitive') {
            const cooldown = Number(received.conversation_watchdog.cooldown_ms);
            convo.startCooldown(Number.isFinite(cooldown) ? cooldown : this.cooldown_ms);
            const reason = 'peer progress watchdog detected a repetitive conversation';
            console.warn(`[${agent.name}] Conversation with ${sender} ended by peer progress watchdog: repetitive conversation without new information.`);
            this.endConversation(sender, reason);
            return;
        }
        else if (!received.end && convo.observeProgress('incoming', received.message)) {
            this._endRepetitiveConversation(sender);
            return;
        }

        // responding to conversation takes priority over self prompting
        if (agent.self_prompter.isActive()){
            await agent.self_prompter.pause();
        }

        if (convo.responseGeneration !== generation)
            return;
        _scheduleProcessInMessage(sender, received, convo, generation);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return agents_in_game.some((n) => n === name);
    }

    updateAgents(agents) {
        agent_names = agents.map(a => a.name);
        agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return agents_in_game;
    }

    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }

    endConversation(sender, reason=null) {
        const convo = this.convos[sender];
        if (!convo)
            return;

        convo.end();
        if (this.activeConversation?.name === sender) {
            this._stopMonitor();
            this.activeConversation = null;
            if (agent.self_prompter.isPaused() && !this.inConversation()) {
                if (reason)
                    console.log(`[${agent.name}] Autonomous self-prompting resume scheduled after conversation with ${sender} ended (${reason}).`);
                runDetached(
                    _resumeSelfPrompter(sender, reason, this.resume_delay_ms),
                    'Failed to resume self-prompting after conversation end'
                );
            }
            else if (reason) {
                console.log(`[${agent.name}] Autonomous self-prompting was not resumed after conversation with ${sender}: it was not paused or another conversation is active.`);
            }
        }
    }

    endAllConversations() {
        for (const sender in this.convos) {
            this.endConversation(sender);
        }
        if (agent.self_prompter.isPaused()) {
            runDetached(
                _resumeSelfPrompter(null, null, this.resume_delay_ms),
                'Failed to resume self-prompting after ending conversations'
            );
        }
    }

    _sendWatchdogEnd(sender, cooldown=this.cooldown_ms) {
        sendBotChatToServer(sender, {
            message: `Let's pause here and return to our other goals. !endConversation("${sender}")`,
            start: false,
            end: true,
            conversation_watchdog: {
                reason: 'repetitive',
                cooldown_ms: Math.max(0, Math.ceil(cooldown)),
            },
        });
    }

    _endRepetitiveConversation(sender) {
        const convo = this._getConvo(sender);
        if (!convo.active)
            return;

        convo.startCooldown(this.cooldown_ms);
        const reason = `${convo.repetitiveTurns} consecutive repetitive turns across both agents without new information`;
        console.warn(`[${agent.name}] Conversation with ${sender} ended by progress watchdog: ${reason}. Cooldown ${this.cooldown_ms}ms.`);
        this._sendWatchdogEnd(sender, this.cooldown_ms);
        this.endConversation(sender, reason);
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation("' + sender + '")', false, false);
            this.endConversation(sender);
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

/*
This function controls conversation flow by deciding when the bot responds.
The logic is as follows:
- If neither bot is busy, respond quickly with a small delay.
- If only the other bot is busy, respond with a long delay to allow it to finish short actions (ex check inventory)
- If I'm busy but other bot isn't, let LLM decide whether to respond
- If both bots are busy, don't respond until someone is done, excluding a few actions that allow fast responses
- New messages received during the delay will reset the delay following this logic, and be queued to respond in bulk
*/
const talkOverActions = ['stay', 'followPlayer', 'mode:']; // all mode actions
const fastDelay = 200;
const longDelay = 5000;
function _scheduleProcessInMessage(sender, received, convo, generation) {
    let otherAgentBusy = containsCommand(received.message);

    const scheduleResponse = (delay) => {
        if (convo.responseGeneration !== generation || convo.ignore_until_start)
            return;
        convo.inMessageTimer = setTimeout(() => {
            if (convo.responseGeneration !== generation)
                return;
            const busy = !agent.isIdle()
                && !talkOverActions.some(action => agent.actions.currentActionLabel.includes(action));
            if (busy) {
                scheduleResponse(1000);
                return;
            }
            _processInMessageQueue(sender);
        }, delay);
    };

    const canTalkOver = !agent.isIdle() && talkOverActions.some(a => agent.actions.currentActionLabel.includes(a));
    if (!agent.isIdle() && !canTalkOver) {
        // The queued message is answered after the current physical action
        // finishes. Replying now would start a new command and cancel it.
        scheduleResponse(1000);
    }
    else if (otherAgentBusy)
        // other bot is busy but I'm not
        scheduleResponse(longDelay);
    else
        scheduleResponse(fastDelay);
}

function _processInMessageQueue(name) {
    const convo = convoManager._getConvo(name);
    convo.inMessageTimer = null;
    if (convo.ignore_until_start || convo.in_queue.length === 0)
        return;
    _handleFullInMessage(name, compileInMessages(convo));
}

export function compileInMessages(convo) {
    let pack = {};
    const messages = [];
    while (convo.in_queue.length > 0) {
        pack = convo.in_queue.shift();
        messages.push(pack.message);
    }
    pack.message = messages.join('\n');
    return pack;
}

function _handleFullInMessage(sender, received) {
    console.log(`${agent.name} responding to "${received.message}" from ${sender}`);

    const convo = convoManager._getConvo(sender);
    convo.active = true;

    let message = _tagMessage(received.message);
    if (received.end) {
        const reason = received.conversation_watchdog?.reason === 'repetitive'
            ? 'peer progress watchdog detected a repetitive conversation'
            : null;
        if (reason)
            console.warn(`[${agent.name}] Conversation with ${sender} ended by peer progress watchdog: repetitive conversation without new information.`);
        convoManager.endConversation(sender, reason);
        message = `Conversation with ${sender} ended with message: "${message}"`;
        sender = 'system'; // bot will respond to system instead of the other bot
    }
    else if (received.start)
        agent.shut_up = false;
    convo.inMessageTimer = null;
    runDetached(agent.handleMessage(sender, message), `Failed to handle queued conversation message from ${sender}`);
}

function _tagMessage(message) {
    return "(FROM OTHER BOT)"+message;
}

async function _resumeSelfPrompter(sender, reason, delay) {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (agent.self_prompter.isPaused() && !convoManager.inConversation()) {
        agent.self_prompter.start();
        const outcome = agent.self_prompter.isActive() ? 'resumed' : 'did not resume';
        console.log(`[${agent.name}] Autonomous self-prompting ${outcome}${sender ? ` after conversation with ${sender}` : ''}${reason ? ` (${reason})` : ''}.`);
    }
    else if (reason) {
        console.log(`[${agent.name}] Autonomous self-prompting did not resume after conversation with ${sender}: state changed or another conversation started.`);
    }
}
