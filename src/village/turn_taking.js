import settings from '../agent/settings.js';
import { areMessagesSubstantiallySimilar, normalizeConversationMessage } from '../agent/conversation.js';
import { recordVillageSpeech } from './experience.js';

/**
 * Said after the same speech-only choice repeats. It is a scheduling prompt,
 * not a message from another person, and it is not stored as conversation.
 */
export const VILLAGE_SPEECH_RECOVERY = 'You have repeated yourself without a new action or a new observation. Do not say that again. You may use one !commandName, revise or abandon the intention with !intention, or stay still without repeating yourself. Saying an intention aloud is not doing it.';

const FILLER = new Set([
    'a', 'an', 'and', 'around', 'at', 'be', 'for', 'i', 'ill', 'in', 'is', 'it',
    'just', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'with',
]);

function significantTokens(text) {
    return new Set(
        normalizeConversationMessage(text)
            .split(' ')
            .filter(token => token && !FILLER.has(token))
    );
}

/** Similar sentences, including an intention read back with a few extra words. */
export function largelyOverlaps(first, second) {
    if (areMessagesSubstantiallySimilar(first, second)) return true;
    const left = significantTokens(first);
    const right = significantTokens(second);
    if (left.size < 4 || right.size < 4) return false;
    let shared = 0;
    for (const token of left) {
        if (right.has(token)) shared++;
    }
    return shared / Math.min(left.size, right.size) >= 0.8;
}

/**
 * Speech with no command. The second similar announcement is a stall.
 * A real action clears the run.
 */
export function noteSpeechTurn(state, { text = '', acted = false } = {}) {
    if (acted || !String(text || '').trim()) {
        return { last: [], stalled: false };
    }
    const last = [...(state?.last || []), String(text)].slice(-4);
    const prior = last.slice(0, -1).filter(previous => largelyOverlaps(previous, text)).length;
    return { last, stalled: prior >= 1 };
}

/**
 * Another inhabitant was heard nearby. Keep the words. Do not start a reply
 * while a decision is already being made.
 */
export function observePeerSpeech(agent, username, message) {
    recordVillageSpeech(settings.agent_data_root, { speaker: username, text: message });
    void agent.history.add(username, message);
    agent._heardSinceDecision = (agent._heardSinceDecision || 0) + 1;
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
