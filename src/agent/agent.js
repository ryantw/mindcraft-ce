import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, stripUnsharedCommands, describeAttempt, formatCommandSignature } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { resolveStartupGoal, usableGoal } from './startup_goal.js';
import { PlanManager } from './plan_manager.js';
import { blockingRepeatCount, isCommandRejection, updateRepeatCounts } from './action_outcome.js';
import { maybeAutoReflect, recordCommandResult } from './reflection_triggers.js';
import { reflectionState } from './reasoning.js';
import { resumePausedAutonomy, systemObservation } from './system_events.js';
import { sanitizeIncomingPeerMessage, sanitizeOutgoingChat } from './chat_hygiene.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.ready = false;
        this._deferredMessages = [];
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this.plan_manager = new PlanManager(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.setOpts({
            priority: 'foodPoints',
            minHunger: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        });
        this.bot.autoEat.enableAuto();

        this.ready = true;
        const savedGoal = usableGoal(save_data?.self_prompt);
        const startup = resolveStartupGoal({
            saved: save_data?.self_prompt,
            initMessage: init_message,
            directive: settings.init_message,
        });
        if (startup.notice) {
            this.history.add('system', startup.notice);
        }
        if (savedGoal) {
            const resumablePause = save_data.self_prompting_state === 2
                && !(save_data.last_sender && convoManager.otherAgentInGame(save_data.last_sender));
            await this.self_prompter.handleLoad(savedGoal, save_data.self_prompting_state, { resumePaused: resumablePause });
        } else if (startup.goal) {
            if (startup.replacedSavedGoal || startup.notice) {
                console.log(`[${this.name}] Restored the autonomous goal. A restart notice is not a goal.`);
            }
            this.history.add('system', startup.goal);
            this.self_prompter.start(startup.goal);
            if (startup.replacedSavedGoal || startup.notice) {
                this.history.save();
            }
        }
        const deferred = this._deferredMessages.splice(0);
        for (const item of deferred) {
            await this.handleMessage(item.source, item.message, item.max_responses);
        }
        serverProxy.flushPending();
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        // else if (init_message) {
        //     await this.handleMessage('system', init_message, 2);
        // }
        else if (!startup.goal) {
            this.openChat("Hello world! I am " + this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;

        // dig() waits for look() before it installs stopDigging(). look()
        // itself waits for a movement packet, which a stationary or dead bot
        // does not send. Force look finishes that wait without physics.
        try {
            if (typeof this.bot.look === 'function') {
                const yaw = this.bot.entity?.yaw ?? 0;
                const pitch = this.bot.entity?.pitch ?? 0;
                this.bot.look(yaw, pitch, true).catch(err => {
                    console.warn(`[${this.name}] Failed to unblock look:`, err);
                });
            }
        } catch (err) {
            console.warn(`[${this.name}] Failed to unblock look:`, err);
        }

        try {
            this.bot.stopDigging();
        } catch (err) {
            console.warn(`[${this.name}] Failed to stop digging:`, err);
        }

        // Only allow one pending block collection cancellation.
        if (this.bot.collectBlock && !this._collectCancelPromise) {
            this._collectCancelPromise = this.bot.collectBlock
                .cancelTask()
                .catch(err => {
                    console.warn(
                        `[${this.name}] Block collection cancellation failed:`,
                        err
                    );
                })
                .finally(() => {
                    this._collectCancelPromise = null;
                });
        }

        try {
            this.bot.pathfinder.stop();
        } catch (err) {
            console.warn(`[${this.name}] Failed to stop pathfinder:`, err);
        }
        try {
            this.bot.pvp.stop();
        } catch (err) {
            console.warn(`[${this.name}] Failed to stop combat:`, err);
        }
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        if (!this.ready) {
            this._deferredMessages = this._deferredMessages || [];
            this._deferredMessages.push({ source, message, max_responses });
            console.log(`[${this.name || 'agent'}] Deferred message from ${source} until initialization completes.`);
            return false;
        }
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);
        const contextKind = self_prompt ? 'autonomous' : from_other_bot ? 'peer' : 'human';

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message, { operator: true });
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot) {
            this.last_sender = source;
            const shared = stripUnsharedCommands(message);
            if (shared !== message.trim()) {
                console.log(`[${this.name}] Removed private or administrative commands from ${source}'s message.`);
            }
            if (!shared) return false;
            // Another agent's words are its claims, never this agent's own
            // observations: drop result-shaped text and action commands.
            const peer = sanitizeIncomingPeerMessage(shared);
            if (peer.changed) {
                console.log(`[${this.name}] Removed result text or action commands from ${source}'s message.`);
            }
            if (!peer.text) return false;
            message = peer.text;
        }

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = systemObservation('SURVIVAL MODE ACTIVITY', 'Recent behaviors:\n' + behavior_log);
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        // The self-prompt loop requests plans itself. While it is paused (for
        // example inside a long peer conversation) an agent with no usable plan
        // asks for one in the background so planning does not depend on the
        // conversation ending. Shares ensurePlan's single request and backoff.
        if (!self_prompt && !this.self_prompter.isActive()) {
            try {
                this.plan_manager?.ensurePlanInBackground?.();
            } catch (error) {
                console.warn(`[${this.name}] Could not start background planning: ${error.message}`);
            }
        }

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history, { contextKind });

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    console.warn('Agent hallucinated command:', command_name);
                }

                if (checkInterrupt()) break;

                // Repetition is tracked by behavior, not only by the exact
                // command string. digDown(800) and digDown(801) that hit the
                // same drop, or buildLine and buildPlane of the same blocks,
                // are one unresolved attempt.
                const commandKey = res
                    .substring(res.indexOf(command_name))
                    .trim();
                const attempt = describeAttempt(res);

                this.repeatWatchdog ??= { counts: new Map() };

                const watchdog = this.repeatWatchdog;

                if (blockingRepeatCount(watchdog.counts, {
                    commandKey,
                    commandName: command_name,
                    action: attempt.action,
                    params: attempt.params,
                    bot: this.bot,
                    parsedOk: attempt.parsedOk,
                    missingArguments: attempt.missingArguments,
                }) >= 3) {
                    const prior = this.actions.getLastBlocked?.() || this.actions.getLastOutcome?.();
                    const why = prior?.reason?.message || prior?.reason || 'it is not making progress';
                    const signature = formatCommandSignature(command_name);
                    const warning =
                        `REPEATED ACTION BLOCKED: ${commandKey}. ${why} ` +
                        `${signature ? `Correct form: ${signature}. ` : ''}` +
                        `Do not repeat this action. Choose a different action, move, look around, or reconsider the goal.`;

                    console.warn(`[${this.name}] ${warning}`);
                    await this.history.add('system', warning);
                    this.history.save();
                    this.actions.repeatSuppressed = true;

                    try {
                        const problemKey = recordCommandResult(this, {
                            commandName: command_name,
                            commandKey,
                            failed: true,
                            isAction: isAction(command_name) || !commandExists(command_name),
                            resultText: warning,
                            behaviorKey: prior?.behaviorKey || attempt.behaviorHint || null,
                        });
                        // Suppression is the hard stop. Do not spend another
                        // reflection on a problem that was already explained.
                        const alreadyReflected = problemKey && reflectionState(this).reflected.has(problemKey);
                        const reflection = alreadyReflected ? null : await maybeAutoReflect(this, problemKey);
                        if (reflection) await this.history.add('system', reflection);
                    } catch (error) {
                        console.warn(`[${this.name}] Automatic reflection error: ${error.message}`);
                    }

                    // Not a completed action. The self-prompt loop backs off
                    // instead of treating the refusal as progress.
                    used_command = false;
                    break;
                }

                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    const spoken = this._speakable(res);
                    if (spoken) this.routeResponse(source, spoken);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = this._speakable(res.substring(0, res.indexOf(command_name)).trim());
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = this._speakable(res.substring(0, res.indexOf(command_name)).trim());
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                // Record the actual outcome of this command.
                const outcome = String(execute_res || '');
                const structuredOutcome = this.actions.getLastOutcome?.() || null;

                const blockedAttempt = structuredOutcome ? null : this.actions.getLastBlocked?.() || null;
                // An error string is a failed decision. Zero verified progress
                // with a reason is also a failure, even when status is success
                // because the requested blocks were already there.
                const failed = structuredOutcome
                    ? structuredOutcome.status === 'failure' || (!structuredOutcome.relevantProgress && Boolean(structuredOutcome.reason))
                    : !outcome.trim() || isCommandRejection(outcome) ||
                        /\b(error|invalid|failed|cannot|could not|unable to)\b/i.test(outcome) ||
                        /unchanged blocking condition|don't have|do not have|not enough|no resources|collected 0|no .* nearby to collect|took to long|could not reach|path not found|pathfinding stopped|reserved for the human operator/i.test(outcome);

                // A search that finds the same block is not progress, and a
                // different failed command must not erase this count.
                const isSearch =
                    command_name === '!searchForBlock' ||
                    command_name === '!searchForEntity';

                const isThink = command_name === '!think';
                const thought = isThink && /Private reflection \(not shared in chat\)/.test(outcome);
                // Reflections never reset other counts. Verified relevant progress
                // alone clears a structured command's count; incidental inventory
                // gains do not. See updateRepeatCounts.
                const behaviorKey = structuredOutcome?.behaviorKey || blockedAttempt?.behaviorKey || (!attempt.parsedOk ? attempt.behaviorHint : null);
                updateRepeatCounts(watchdog.counts, commandKey, {
                    structuredOutcome, failed, isSearch, isThink, thought, behaviorKey,
                });

                if (structuredOutcome?.retry?.reasonableWithoutStateChange === false) {
                    await this.history.add(
                        'system',
                        `Do not immediately repeat ${commandKey}: ${structuredOutcome.reason?.message || 'the blocking condition is unchanged'} ` +
                        `${structuredOutcome.reason?.prerequisites?.join(' ') || 'Change the relevant world or inventory state first.'}`
                    );
                }

                if (structuredOutcome) {
                    const planUpdate = this.plan_manager.observeOutcome(structuredOutcome);
                    if (planUpdate.advanced) {
                        const message = planUpdate.completed
                            ? `Persistent objective completed from verified game-state evidence: ${this.plan_manager.getCurrentPlan()?.objective}`
                            : `Persistent plan advanced from verified evidence. Current step: ${planUpdate.next?.description}`;
                        await this.history.add('system', message);
                    } else if (planUpdate.blocked) {
                        await this.history.add(
                            'system',
                            'The active plan step is blocked by an unchanged observed condition. Reconsider the approach before another routine action.'
                        );
                    }
                }

                if (execute_res)
                    await this.history.add('system', systemObservation('ACTION RESULT', execute_res));

                if ((watchdog.counts.get(behaviorKey || commandKey) || 0) === 3) {
                    await this.history.add(
                        'system',
                        `Your last three attempts at ${commandKey} ` +
                        `have been repetitive or unsuccessful. ` +
                        `Reassess your situation and choose a ` +
                        `different action.`
                    );

                    console.warn(
                        `[${this.name}] Watchdog: repeated action detected: ${commandKey}`
                    );
                }

                // Evidence-based automatic reflection. The next decision sees
                // the private advice; nothing is announced or shared.
                try {
                    const problemKey = recordCommandResult(this, {
                        commandName: command_name,
                        commandKey,
                        failed,
                        isAction: isAction(command_name) || !commandExists(command_name),
                        resultText: outcome,
                        behaviorKey,
                    });
                    const reflection = await maybeAutoReflect(this, problemKey);
                    if (reflection) await this.history.add('system', reflection);
                } catch (error) {
                    console.warn(`[${this.name}] Automatic reflection error: ${error.message}`);
                }

                if (!execute_res)
                    break;
            }
            else { // conversation response
                const speech = sanitizeOutgoingChat(res);
                if (speech.changed) {
                    this.chat_hygiene = this.chat_hygiene || { sanitized: 0, suppressed: 0 };
                    this.chat_hygiene.sanitized++;
                    console.warn(`[${this.name}] Removed action-result text from an outgoing reply${speech.suppressed ? ' (nothing left to say; not sent)' : ''}.`);
                }
                if (speech.suppressed) {
                    this.chat_hygiene.suppressed++;
                    // Private note so the next turn does not repeat the pattern.
                    await this.history.add('system', 'Your last reply only repeated an action result. Results are private observations; do not restate them in chat. Say something in your own words or take an action.');
                    break;
                }
                this.history.add(this.name, speech.text);
                this.routeResponse(source, speech.text);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    /**
     * Speech derived from a model reply, minus any restated action results.
     * Returns '' when nothing speakable remains.
     */
    _speakable(text) {
        const speech = sanitizeOutgoingChat(text);
        if (speech.changed) {
            this.chat_hygiene = this.chat_hygiene || { sanitized: 0, suppressed: 0 };
            this.chat_hygiene.sanitized++;
            console.warn(`[${this.name}] Removed action-result text from an outgoing message.`);
        }
        return speech.text;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender && !containsCommand(message)) {
            // A spoken event such as death can rejoin the conversation.
            // A command must not: sending it makes the other agent reply,
            // and that reply was cancelling the action that just started.
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // Administrative and private reflection commands stay local.
            const shared = stripUnsharedCommands(message);
            if (shared)
                convoManager.sendToBot(to_player, shared);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            Promise.resolve(this.actions.stop()).finally(() => {
                resumePausedAutonomy(this, 'death', convoManager.inConversation());
            });
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', systemObservation(
                    'DEATH AND RESPAWN',
                    `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. The action that was running ended automatically because you died; this does not request !stop. You have respawned. Continue your existing objective with an appropriate recovery action.`
                ));
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        console.error(`[cleanKill] ${this.name}: ${msg} (exit code ${code})`);
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (!this.task?.data) return;
        let res = this.task.isDone();
        if (res) {
            await this.history.add('system', `Task ended with score : ${res.score}`);
            await this.history.save();
            console.log('Task finished:', res.message);
            this.killAll();
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
