import { commandExists } from './commands/index.js';

/**
 * Attribution hygiene for agent-to-agent conversation.
 *
 * Action results ("Verified outcome: ...", "Inventory before -> after: ...")
 * are private observations of the agent that performed the action. The model
 * sometimes reproduces them as chat; those echoes were then delivered to a
 * peer, stored in the peer's history as that peer's input, and re-reported by
 * the peer as its own. These helpers keep results private to their owner and
 * stop peers' claims and commands from being absorbed as the receiver's own.
 */

// Text produced by the game/action layer or by transcript formatting; never
// legitimate speech. Everything from the first marker onward is dropped.
const RESULT_MARKERS = [
    /Verified outcome:/i,
    /Observed changes:/i,
    /Inventory before\s*->\s*after:/i,
    /Normal storage:\s*\d+\/\d+/i,
    /Retry without a relevant state change:/i,
    /\bSystem output:/i,
    /\bUser input:/i,
    /\(AUTO MESSAGE\)/i,
];

// "Harvested 3 oak_log blocks ..." style lead-ins to a result block. A count is
// required so ordinary narration ("Placed the chest!") is kept.
const RESULT_SENTENCE = /^(?:harvested|collected|crafted|discarded|smelted|placed|dropped|cooked|failed to \w+)\b[^.!?]*\d/i;

// Conversation protocol commands that remain meaningful between agents.
const PROTOCOL_COMMANDS = new Set(['endConversation', 'startConversation']);

function firstMarkerIndex(text) {
    let index = -1;
    for (const marker of RESULT_MARKERS) {
        const found = text.search(marker);
        if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    return index;
}

function dropTrailingResultSentences(text) {
    const sentences = text.trim().split(/(?<=[.!?])\s+/);
    while (sentences.length && RESULT_SENTENCE.test(sentences[sentences.length - 1].trim())) {
        sentences.pop();
    }
    // A lead-in clause glued to preceding speech without punctuation.
    return sentences.join(' ').replace(/\s*\b(?:harvested|collected|crafted|discarded|smelted|placed|dropped|cooked)\s+\d[^.!?]*[.!?]?\s*$/i, '');
}

function firstCommandIndex(text) {
    const pattern = /!(\w+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (commandExists(match[1])) return match.index;
    }
    return -1;
}

function tidy(text) {
    // Collapse gaps left by removed text; a space before a command's "!" stays.
    return text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,?])/g, '$1').replace(/\s+(!)(?![A-Za-z])/g, '$1').trim();
}

function cutResults(text) {
    const cut = firstMarkerIndex(text);
    if (cut < 0) return { text, cut: false };
    return { text: dropTrailingResultSentences(text.slice(0, cut)), cut: true };
}

/**
 * Remove result-block text from something the agent is about to say.
 * A trailing command is preserved. `suppressed` means nothing speakable is
 * left, so the message should not be sent at all.
 */
export function sanitizeOutgoingChat(text) {
    const raw = String(text ?? '');
    const commandAt = firstCommandIndex(raw);
    const head = commandAt >= 0 ? raw.slice(0, commandAt) : raw;
    const tail = commandAt >= 0 ? raw.slice(commandAt) : '';

    const cleanedHead = tidy(cutResults(head.replace(/^\s*Your output:\s*/i, '')).text);
    const cleanedTail = tidy(cutResults(tail).text);
    const result = tidy([cleanedHead, cleanedTail].filter(Boolean).join(' '));
    const changed = result !== raw.trim();
    return {
        text: result,
        changed,
        suppressed: changed && cleanedHead === '' && cleanedTail === '',
    };
}

/**
 * Sanitize a message received from another agent. A peer cannot deliver
 * verified outcomes, so result-shaped text is dropped; action commands are
 * removed (they would not execute for the receiver, but models imitate them
 * and narrate the peer's actions as their own). Conversation protocol commands
 * are kept. What remains is the peer's spoken claim.
 */
export function sanitizeIncomingPeerMessage(text) {
    const raw = String(text ?? '');
    const marked = raw.match(/^(\s*\(FROM OTHER BOT\))?/i)?.[0] || '';
    const body = raw.slice(marked.length);
    // Commands first, so a result lead-in sentence is the trailing sentence
    // when the result block is cut.
    let cleaned = body.replace(/!(\w+)(?:\s*\([^)]*\))?/g, (match, name) => {
        if (PROTOCOL_COMMANDS.has(name) || !commandExists(name)) return match;
        return '';
    });
    cleaned = tidy(cutResults(tidy(cleaned)).text);
    const result = cleaned ? `${marked}${cleaned}` : '';
    return { text: result, changed: result !== raw.trim() };
}

/** Remove any command invocations from text that will be stored as memory. */
export function stripCommandSyntax(text) {
    return tidy(String(text ?? '').replace(/!(\w+)(?:\s*\([^)]*\))?/g, (match, name) => (commandExists(name) ? '' : match)));
}

const TRANSIENT_MEMORY_ACKNOWLEDGMENTS = [
    /^(?:sure[,!]?\s*)?i(?:'ll| will)\s+stop(?:\s+fighting)?[.!]?$/i,
    /^i(?:'ve| have)\s+stopped[.!]?(?:\s+what(?:(?:'s| is))?\s+next\??)?$/i,
    /^agent(?:\s+action)?\s+stopped[.!]?(?:\s+self-prompting\s+still\s+active[.!]?)?$/i,
];

/** Operational acknowledgments do not become durable experience or lessons. */
export function isTransientMemoryTurn(turn) {
    const content = stripCommandSyntax(turn?.content || '')
        .replace(/^\[SYSTEM OBSERVATION:[^\]]+\]\s*/i, '')
        .trim();
    return TRANSIENT_MEMORY_ACKNOWLEDGMENTS.some(pattern => pattern.test(content));
}

/**
 * Remove known operational acknowledgments from the prompt-time view of an
 * existing summary. This does not mutate or rewrite the saved memory file.
 */
export function durableMemoryView(text) {
    return tidy(String(text ?? '')
        .replace(/\bi(?:'ve| have)\s+stopped[.!]?\s*what(?:(?:'s| is))?\s+next\??/gi, '')
        .replace(/\b(?:sure[,!]?\s*)?i(?:'ll| will)\s+stop(?:\s+fighting)?[.!]?/gi, ''));
}

/**
 * Label turns for the memory summarizer so another agent's words are never
 * mistaken for the summarizing agent's own experience.
 * @param {{role:string,content:string}[]} turns
 * @param {string} selfName
 * @param {(name:string)=>boolean} isOtherAgent
 */
export function attributeTurnsForSummary(turns, selfName, isOtherAgent) {
    return turns.filter(turn => !isTransientMemoryTurn(turn)).map(turn => {
        const content = stripCommandSyntax(turn.content);
        if (turn.role !== 'user') return { ...turn, content };
        const match = String(content).match(/^([^:\s]+):\s*(?:\(FROM OTHER BOT\))?\s*([\s\S]*)$/);
        if (!match || match[1] === selfName) return { ...turn, content };
        const [, speaker, said] = match;
        const label = isOtherAgent?.(speaker)
            ? `${speaker} (ANOTHER AGENT, not you; unverified claim, not your experience): `
            : `${speaker}: `;
        return { ...turn, content: label + said };
    });
}
