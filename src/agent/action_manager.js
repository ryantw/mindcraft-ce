import {
    collectionRelevantStateChanged,
    commandOutcomeKey,
    constructionCellKey,
    expectedItemsForCommand,
    inventorySnapshot,
    observedStateFingerprint,
    positionAnchor,
    workstationStillMissing,
    storageAcceptsItem,
    validationBehaviorKey,
} from './action_outcome.js';
import { ConstructionAreaGuard } from './construction_area.js';
import { describeBuildSurroundings } from './library/construction.js';
import { intentionWatchKey } from '../village/intentions.js';

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this.lastOutcome = null;
        this.lastBlocked = null;
        this.retryBlocks = new Map();
        this.recentPlacements = new Map();
        this.constructionAreas = new ConstructionAreaGuard();
        this.blockedStreak = 0; // consecutive declined retries with no action executed in between
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        const stuckActionLabel = this.currentActionLabel;
        console.log(`[${this.agent.name}] Stopping action "${stuckActionLabel}"`);
        const timeout = setTimeout(() => {
            this.agent.cleanKill(`Code execution refused stop after 10 seconds (stuck action: "${stuckActionLabel}"). Killing process.`);
        }, 10000);
        while (this.executing) {
            try {
                this.agent.requestInterrupt();
            } catch (err) {
                console.warn(`[${this.agent.name}] Interrupt failed during "${stuckActionLabel}":`, err);
            }
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    clearLastOutcome() {
        this.lastOutcome = null;
        this.lastBlocked = null;
    }

    /** An identical retry was rejected before running (unchanged blocking condition). */
    recordBlockedAttempt(action, params, block) {
        this.blockedStreak++;
        this.lastBlocked = {
            action,
            params,
            condition: block.condition,
            reason: block.reason,
            prerequisites: block.prerequisites || [],
            expectedItems: block.expectedItems || [],
            behaviorKey: block.behaviorKey || null,
            signature: block.signature || null,
            reasonCode: block.reasonCode || null,
        };
        console.log(`[${this.agent.name}] Retry rejected: action=${action} reason=${block.reason}`);
    }

    getLastBlocked() {
        return this.lastBlocked;
    }

    getLastOutcome() {
        return this.lastOutcome;
    }

    recordOutcome(outcome) {
        this.lastOutcome = outcome;
        if (!outcome) return;
        this.blockedStreak = 0;
        console.log(
            `[${this.agent.name}] Action outcome: action=${outcome.action} status=${outcome.status} ` +
            `progress=${outcome.relevantProgress} reason=${outcome.reason?.code || 'none'} ` +
            `retry_without_change=${outcome.retry?.reasonableWithoutStateChange}`
        );

        this.constructionAreas.record(outcome, this.agent.bot?.entity?.position);
        this._rememberPlacements(outcome);

        const storage = outcome.evidence?.storage;
        if (storage?.capacityRelief) {
            for (const [key, block] of this.retryBlocks) {
                if (block.condition === 'inventory_capacity') this.retryBlocks.delete(key);
            }
        }

        if (outcome.retry?.reasonableWithoutStateChange === false) {
            const block = {
                condition: outcome.retry.condition || 'state_changed',
                expectedItems: expectedItemsForCommand(outcome.action, outcome.params),
                fingerprint: outcome.retry.stateFingerprint,
                relevantState: outcome.retry.relevantState || null,
                reason: outcome.reason?.message || 'The previous attempt made no relevant progress.',
                prerequisites: outcome.reason?.prerequisites || [],
                behaviorKey: outcome.behaviorKey || null,
                signature: outcome.evidence?.signature || null,
                reasonCode: outcome.reason?.code || null,
                cells: outcome.evidence?.cells || null,
                anchor: outcome.evidence?.anchor || null,
                action: outcome.action,
            };
            this.retryBlocks.set(outcome.commandKey, block);
            if (outcome.behaviorKey && outcome.behaviorKey !== outcome.commandKey) {
                this.retryBlocks.set(outcome.behaviorKey, block);
            }
        } else if (outcome.relevantProgress) {
            this._forget(outcome.commandKey, outcome.behaviorKey);
            this.retryBlocks.delete(validationBehaviorKey(`!${outcome.action}`));
        }
    }

    _forget(commandKey, behaviorKey) {
        this.retryBlocks.delete(commandKey);
        if (behaviorKey) this.retryBlocks.delete(behaviorKey);
    }

    _cellsRemain(block) {
        const cells = String(block.cells || '');
        const split = cells.indexOf(':');
        if (split < 0) return false;
        const type = cells.slice(0, split);
        const positions = cells.slice(split + 1).split('|').filter(Boolean);
        const bot = this.agent.bot;
        if (!bot?.blockAt || positions.length === 0) return true;
        return positions.every(entry => {
            const [x, y, z] = entry.split(',').map(Number);
            try {
                return bot.blockAt({ x, y, z })?.name === type;
            } catch {
                return true;
            }
        });
    }

    _rememberPlacements(outcome) {
        const changes = outcome?.evidence?.world;
        if (!Array.isArray(changes)) return;
        for (const change of changes) {
            if (change?.kind !== 'block' || !change.after || !change.position) continue;
            const x = Math.floor(Number(change.position.x));
            const y = Math.floor(Number(change.position.y));
            const z = Math.floor(Number(change.position.z));
            if (![x, y, z].every(Number.isFinite)) continue;
            this.recentPlacements.set(`${x},${y},${z}`, change.after);
        }
        while (this.recentPlacements.size > 128) {
            this.recentPlacements.delete(this.recentPlacements.keys().next().value);
        }
    }

    /**
     * The block digDown would break first. Refusing it before the dig keeps
     * a just-placed floor or wall from being picked up and put back.
     */
    _undoPlacementBlock() {
        const bot = this.agent.bot;
        const pos = bot?.entity?.position;
        if (!pos || typeof bot.blockAt !== 'function' || this.recentPlacements.size === 0) return null;
        let origin;
        try {
            origin = bot.blockAt(pos);
        } catch {
            return null;
        }
        const x = Math.floor(Number(origin?.position?.x ?? pos.x));
        const y = Math.floor(Number(origin?.position?.y ?? pos.y));
        const z = Math.floor(Number(origin?.position?.z ?? pos.z));
        if (![x, y, z].every(Number.isFinite)) return null;
        let below;
        try {
            below = bot.blockAt({ x, y: y - 1, z });
        } catch {
            return null;
        }
        if (!below || below.name === 'air' || below.name === 'cave_air') return null;
        const key = `${Math.floor(below.position?.x ?? x)},${Math.floor(below.position?.y ?? (y - 1))},${Math.floor(below.position?.z ?? z)}`;
        if (this.recentPlacements.get(key) !== below.name) return null;
        const anchor = positionAnchor(bot);
        return {
            condition: 'unchanged_behavior',
            expectedItems: [],
            fingerprint: null,
            relevantState: null,
            reason: `The block below you is ${below.name} at (${key}), which you just placed. Digging it removes the structure you are building.`,
            prerequisites: ['Leave that block in place. Build the next part on a different footprint.'],
            behaviorKey: anchor ? `digDown:undo_placement:${anchor}` : 'digDown:undo_placement',
            signature: '!digDown(distance:number)',
            reasonCode: 'undo_placement',
            cells: null,
            anchor,
            action: 'digDown',
        };
    }

    /** Same intent and blocker, even when the command text or arguments differ. */
    _equivalentBlock(action, params) {
        if (action === 'intention') {
            const op = String(params?.action || '').trim().toLowerCase();
            if (op !== 'abandon' && op !== 'complete') return null;
            const wanted = intentionWatchKey(op, 'none');
            for (const [key, candidate] of this.retryBlocks) {
                if (candidate.behaviorKey === wanted) return { key, block: candidate };
            }
            return null;
        }
        if (action === 'digDown') {
            const anchor = positionAnchor(this.agent.bot);
            if (!anchor) return null;
            for (const [key, candidate] of this.retryBlocks) {
                if (candidate.anchor === anchor && String(candidate.behaviorKey || '').startsWith('digDown:')) {
                    return { key, block: candidate };
                }
            }
            return null;
        }
        const cells = constructionCellKey(action, params);
        if (!cells) return null;
        for (const [key, candidate] of this.retryBlocks) {
            if (candidate.cells !== cells) continue;
            if (String(candidate.behaviorKey || '').endsWith(':already_satisfied') && !this._cellsRemain(candidate)) {
                this._forget(key, candidate.behaviorKey);
                continue;
            }
            return { key, block: candidate };
        }
        return null;
    }

    _areaBlock(action, params) {
        const bot = this.agent.bot;
        return this.constructionAreas.check(
            action, params, bot?.entity?.position,
            center => bot?.entity ? describeBuildSurroundings(bot, center) : ''
        );
    }

    retryBlock(action, params={}) {
        if (action === 'digDown') {
            const undo = this._undoPlacementBlock();
            if (undo) return undo;
        }
        const key = commandOutcomeKey(action, params);
        let block = this.retryBlocks.get(key);
        let blockKey = key;
        if (!block) {
            // Capacity is a global inventory condition, not a property of one
            // requested quantity or one block type. Changing collectBlocks(..., 8)
            // to (..., 1) cannot make a full pack accept a drop. Whether a
            // *different* target is blocked depends on whether its own drops
            // can be stored, evaluated below.
            for (const [candidateKey, candidate] of this.retryBlocks) {
                if (candidate.condition === 'inventory_capacity' && candidateKey.startsWith(`${action}:`)) {
                    block = candidate;
                    blockKey = candidateKey;
                    break;
                }
            }
        }
        if (!block) {
            const equivalent = this._equivalentBlock(action, params);
            if (equivalent) {
                block = equivalent.block;
                blockKey = equivalent.key;
            }
        }
        if (!block) {
            // Not an identical retry: a construction request may still repeat
            // an area that has already refused every recent attempt.
            return this._areaBlock(action, params);
        }

        let stillBlocked = true;
        if (block.condition === 'unchanged_behavior') {
            stillBlocked = true;
        } else if (block.condition === 'inventory_capacity') {
            // The requested command's own drops decide, falling back to the
            // blocked attempt's drops, and finally to "no empty slot".
            let items = expectedItemsForCommand(action, params);
            if (items.length === 0) items = block.expectedItems || [];
            const bot = this.agent.bot;
            stillBlocked = items.length > 0
                ? !items.some(item => storageAcceptsItem(bot, item))
                : inventorySnapshot(bot).storage.free === 0;
        } else if (block.condition === 'state_changed' && block.relevantState?.workstation) {
            // A missing table or furnace is not repaired by gathering some other item.
            stillBlocked = workstationStillMissing(this.agent.bot, block.relevantState.workstation);
        } else if (block.condition === 'state_changed') {
            // Actions that declare which state matters (collection) are not
            // unblocked by their own side effects such as stuck-recovery
            // movement or incidental pickups.
            stillBlocked = block.relevantState
                ? !collectionRelevantStateChanged(block.relevantState, this.agent.bot)
                : observedStateFingerprint(this.agent.bot) === block.fingerprint;
        }
        if (!stillBlocked) {
            // Only forget the block when it was the one that matched this exact
            // request; another target's block may still apply to its own items.
            if (blockKey === key) this._forget(blockKey, block.behaviorKey);
            return this._areaBlock(action, params);
        }
        return block;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        try {
            this.timedout = false;
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}
