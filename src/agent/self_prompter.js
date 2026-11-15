import { reflect } from './reasoning.js';
import { VILLAGE_AUTONOMY_PREAMBLE, VILLAGE_DECISION_INTERVAL_MS, villageDecisionMessage, villageSafetyNote } from './startup_goal.js';
import { noteSpeechTurn, VILLAGE_SPEECH_RECOVERY } from '../village/turn_taking.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this.no_command_limit = 3;
        this.recovery_backoff = 10000;
        this.max_recovery_backoff = 120000;
        this.recovery_attempts = 0;
        this.village_interval = VILLAGE_DECISION_INTERVAL_MS;
    }

    start(prompt) {
        if (this.agent.shut_up) {
            console.log(`[${this.agent.name}] Self-prompting remains stopped because the agent was intentionally silenced.`);
            return;
        }
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state, { resumePaused = false } = {}) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE || (state === PAUSED && resumePaused)) {
            if (state === PAUSED) {
                console.log(`[${this.agent.name}] Restoring a saved paused autonomous goal as active because no conversation remains to resume it.`);
            }
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        try {
            while (this._shouldContinue()) {
                const choosing = this.prompt === VILLAGE_AUTONOMY_PREAMBLE;
                if (choosing) {
                    await this.agent.applyReadyDream?.();
                    await this.agent.orientVillage?.();
                }
                if (!choosing) await this.agent.plan_manager?.ensurePlan?.();
                if (!this._shouldContinue()) break;
                const activePlan = this.agent.plan_manager?.getCurrentPlan?.();
                const activeStep = this.agent.plan_manager?.getCurrentStep?.();
                const planText = activePlan && activeStep
                    ? ` Your persistent objective is '${activePlan.objective}'. The current verified step is '${activeStep.description}'.`
                    : '';
                const stalled = choosing && this.agent._speechLoop?.stalled;
                const msg = !choosing
                    ? `You are self-prompting with the broad goal: '${this.prompt}'.${planText} ` +
                    `Retain freedom to react to safety, the environment, and social interaction, but otherwise advance the current plan. ` +
                    `Your next response MUST contain a command with this syntax: !commandName. Respond:`
                    : stalled
                        ? `${VILLAGE_SPEECH_RECOVERY} ${villageSafetyNote(this.agent.bot)}`.trim()
                        : `${villageDecisionMessage()} ${villageSafetyNote(this.agent.bot)}`.trim();

                if (choosing) this.agent._heardSinceDecision = 0;
                const used_command = await this.agent.handleMessage('system', msg, -1, { ephemeral: choosing });
                if (!this._shouldContinue())
                    break;

                if (choosing) {
                    if (stalled) {
                        this.agent._speechLoop = { last: [], stalled: false };
                    } else {
                        this.agent._speechLoop = noteSpeechTurn(this.agent._speechLoop, {
                            text: this.agent._lastDecisionSpeech || '',
                            acted: Boolean(used_command),
                        });
                    }
                    const heard = () => (this.agent._heardSinceDecision || 0) > 0;
                    if (!this.agent._speechLoop?.stalled) {
                        await this._wait(used_command ? this.cooldown : this.village_interval, heard);
                    }
                    continue;
                }

                if (!used_command) {
                    if (this.agent.actions?.repeatSuppressed) {
                        // The model chose an action the recovery path already
                        // refused. Wait, and do not start a second reflection.
                        this.agent.actions.repeatSuppressed = false;
                        this.recovery_attempts = Math.min(this.recovery_attempts + 1, 8);
                        const backoff = Math.min(
                            this.recovery_backoff * (2 ** (this.recovery_attempts - 1)),
                            this.max_recovery_backoff
                        );
                        console.warn(`[${this.agent.name}] Repeated action suppressed. Waiting ${backoff}ms before the next decision.`);
                        await this._wait(backoff);
                        continue;
                    }
                    no_command_count++;
                    console.warn(`[${this.agent.name}] Self-prompt produced no command (${no_command_count}/${this.no_command_limit}).`);
                    if (no_command_count >= this.no_command_limit) {
                        const recovered = await this._recoverFromNoCommand();
                        if (!this._shouldContinue())
                            break;
                        if (recovered) {
                            no_command_count = 0;
                            this.recovery_attempts = 0;
                            await this._wait(this.cooldown);
                        }
                        else {
                            no_command_count = 0;
                            this.recovery_attempts++;
                            const backoff = Math.min(
                                this.recovery_backoff * (2 ** (this.recovery_attempts - 1)),
                                this.max_recovery_backoff
                            );
                            console.warn(`[${this.agent.name}] Self-prompt recovery found no action. Retrying in ${backoff}ms (attempt ${this.recovery_attempts}).`);
                            await this._wait(backoff);
                        }
                    }
                    else {
                        await this._wait(this.cooldown);
                    }
                }
                else {
                    no_command_count = 0;
                    this.recovery_attempts = 0;
                    await this._wait(this.cooldown);
                }
            }
        }
        finally {
            console.log('self prompt loop stopped')
            this.loop_active = false;
            this.interrupt = false;
        }
    }

    _shouldContinue() {
        return this.state === ACTIVE && !this.interrupt && !this.agent.shut_up;
    }

    async _recoverFromNoCommand() {
        console.warn(`[${this.agent.name}] Self-prompt recovery started after ${this.no_command_limit} responses without a command.`);
        const reflection = await reflect(
            this.agent,
            'I have not selected an action in several attempts. Reconsider my current goal and situation. What meaningful action should I take next?',
            { source: 'no_command', trigger: { reason: 'no_command_recovery', key: 'no_command' } }
        );
        if (!this._shouldContinue())
            return false;

        await this.agent.history.add('system', reflection);
        await this.agent.history.save();

        const recovery_prompt = `Privately reconsider your current goal: '${this.prompt}'. Use the reflection you just received, select one meaningful next action, and respond with a command using this syntax: !commandName.`;
        const used_command = await this.agent.handleMessage('system', recovery_prompt, -1);
        if (used_command)
            console.log(`[${this.agent.name}] Self-prompt recovery selected an action.`);
        return used_command;
    }

    async _wait(delay, wake = null) {
        const interval = Math.min(delay, 500);
        let remaining = delay;
        while (remaining > 0 && this._shouldContinue()) {
            if (typeof wake === 'function' && wake()) return;
            await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
            remaining -= interval;
        }
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        // Stop the decision loop only. A conversation reply must not cancel
        // the collect, walk, or craft that is already in progress.
        this.interrupt = true;
        await this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
