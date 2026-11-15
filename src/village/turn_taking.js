import settings from '../agent/settings.js';
import { largelyOverlaps } from '../agent/conversation.js';
import { recordVillageSpeech } from './experience.js';
import { describeIntentionChoice } from './intentions.js';

export { largelyOverlaps };

/** Speech-only decisions with nothing new, then an action is requested. */
export const SPEECH_ONLY_LIMIT = 3;

/**
 * Asked once speech has stopped counting as progress. It is a scheduling
 * prompt, not a message from another person, and it is not stored.
 */
export function villageActionTurn(placeNames = '', intentionStore = null) {
    const names = String(placeNames || '').trim();
    const places = names
        ? `A place you already remember can be walked to with !goToRememberedPlace("name"). Known names include ${names}.`
        : 'A place you already remember can be walked to with !goToRememberedPlace("name").';
    return `Choose one concrete next action. Reply with exactly one command. !stay(30) waits where you are and is a complete choice. You may instead look, inspect, or move. ${places} ${describeIntentionChoice(intentionStore)} Do not pick a destination unless you want to go there. Danger, water, and injury come before this choice. A spoken sentence is not an action and will not be sent.`;
}

const NO_PROGRESS_TURN = /no active intention|was not saved as an intention|Repeating it changes nothing|UNCHANGED BLOCKING CONDITION|REPEATED ACTION BLOCKED|Do not immediately repeat|have been repetitive or unsuccessful|Intention action must be|There is no intention to pursue|needs your own words/i;

function commandIdentity(content) {
    const text = String(content || '');
    const named = text.match(/!([A-Za-z]\w*)/);
    if (!named) return '';
    if (named[1].toLowerCase() !== 'intention') return named[1].toLowerCase();
    const op = text.match(/!intention\s*\(\s*"?(pursue|revise|complete|abandon)/i);
    return op ? `intention:${op[1].toLowerCase()}` : 'intention';
}

/**
 * Drop the trailing run of repeated speech, failed intention commands, and
 * their correction lines so a recovery decision sees the current state.
 */
export function omitRepeatedDecisions(turns) {
    const copy = (turns || []).map(turn => ({ ...turn }));
    let removed = 0;
    while (copy.length && removed < 16) {
        const turn = copy[copy.length - 1];
        const content = String(turn?.content || '');
        const identity = commandIdentity(content);
        const earlier = copy.slice(0, -1);
        const noProgress = NO_PROGRESS_TURN.test(content);
        const intentionCommand = identity.startsWith('intention');
        const repeatedSpeech = !identity && turn?.role !== 'system' && earlier.some(item =>
            item && item.role !== 'system' && !commandIdentity(item.content) && largelyOverlaps(item.content, content)
        );
        if (!noProgress && !intentionCommand && !repeatedSpeech) break;
        copy.pop();
        removed++;
    }
    return copy;
}

export const VILLAGE_SPEECH_RECOVERY = villageActionTurn();

/**
 * A completed command clears the run. Similar speech, or several speeches
 * with no new event, asks for an action. An empty reply does not clear it.
 */
export function noteSpeechTurn(state, { text = '', acted = false, meaningfulEvent = false } = {}) {
    if (acted) return { last: [], stalled: false, speechOnly: 0 };
    const last = meaningfulEvent ? [] : [...(state?.last || [])];
    let speechOnly = meaningfulEvent ? 0 : (state?.speechOnly || 0);
    const spoken = String(text || '').trim();
    if (!spoken) {
        return { last, stalled: Boolean(state?.stalled) && !meaningfulEvent, speechOnly };
    }
    speechOnly += 1;
    const recent = [...last, spoken].slice(-4);
    const prior = recent.slice(0, -1).filter(previous => largelyOverlaps(previous, spoken)).length;
    return {
        last: recent,
        stalled: prior >= 1 || speechOnly >= SPEECH_ONLY_LIMIT,
        speechOnly,
    };
}

/** !stay is a finished wait. A rejected command is not progress. */
export function decisionKindForCommand(commandName, failed) {
    if (commandName === '!stay') return 'wait';
    if (commandName === '!intention') return failed ? 'rejected' : 'intention';
    return failed ? 'rejected' : 'action';
}

/**
 * Another inhabitant was heard nearby. Keep the words. Do not start a reply
 * while a decision is already being made.
 */
export function observePeerSpeech(agent, username, message) {
    recordVillageSpeech(settings.agent_data_root, { speaker: username, text: message });
    void agent.history.add(username, message);
    agent._heardSinceDecision = (agent._heardSinceDecision || 0) + 1;
    const echoed = (agent._outgoingSpeech || []).some(previous => largelyOverlaps(previous, message));
    if (!echoed) agent._meaningfulSinceDecision = true;
}

/** One decision at a time. A later ordinary turn waits. It does not cancel the current one. */
export function createTurnQueue() {
    let chain = Promise.resolve();
    return {
        run(task) {
            const result = chain.then(() => task(), () => task());
            chain = result.then(() => undefined, () => undefined);
            return result;
        },
    };
}
