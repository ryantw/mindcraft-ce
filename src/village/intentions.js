import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

const ACTIONS = new Set(['pursue', 'revise', 'complete', 'abandon']);

function fileOf(dataRoot) {
    return path.join(dataRoot, 'intentions.json');
}

function writeAtomic(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, file);
}

export function emptyIntentions() {
    return {
        schema_version: 1,
        active: null,
        waking_decision_at: null,
        history: [],
    };
}

export function readIntentions(dataRoot) {
    const file = fileOf(dataRoot);
    if (!existsSync(file)) return emptyIntentions();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
        ...emptyIntentions(),
        ...parsed,
        history: Array.isArray(parsed.history) ? parsed.history : [],
    };
}

function clip(text, max) {
    return String(text || '').replace(/!\w+(?:\([^)]*\))?/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const CHOOSE_NEW = 'To choose a new intention, use !intention("revise", "a short note") or !intention("pursue", "a short note"). Or take a direct action. !stay(30) waits where you are.';

/** Shared watchdog key for equivalent intention operations, independent of the note text. */
export function intentionWatchKey(action, outcome = 'none') {
    const kind = String(action || '').trim().toLowerCase();
    if (!ACTIONS.has(kind)) return 'intention:invalid';
    return `intention:${kind}:${outcome}`;
}

function refuse(kind, outcome, reason, code) {
    return {
        ok: false,
        changed: false,
        code,
        behaviorKey: intentionWatchKey(kind, outcome),
        reason,
    };
}

/**
 * What the inhabitant can do with an intention right now.
 * With nothing active, abandon and complete are not offered.
 */
export function describeIntentionChoice(store) {
    const text = activeIntentionText(store);
    if (!text) {
        return `You have no active intention. ${CHOOSE_NEW} There is nothing to abandon or complete.`;
    }
    return `Current goal: ${clip(text, 180)}. Continue it unless danger, night, or a change of mind comes first. Saying it aloud is not progress. !intention("pursue", "what you did") notes progress. !intention("revise", "a short note") changes the words. !intention("complete", "a short note") or !intention("abandon", "a short note") closes it. The note on a close is not a new intention.`;
}

/** A real change, a rest, or another action ends the no-progress intention streak. */
export function clearIntentionRepetition(agent) {
    const blocks = agent?.actions?.retryBlocks;
    if (blocks) {
        for (const [key, block] of [...blocks]) {
            if (String(block?.behaviorKey || key).startsWith('intention:')) blocks.delete(key);
        }
    }
    const counts = agent?.repeatWatchdog?.counts;
    if (!counts) return;
    for (const key of [...counts.keys()]) {
        if (String(key).startsWith('intention:')) counts.delete(key);
    }
}

/**
 * A personal intention is the current goal. The plan manager turns an active
 * goal into steps. Closing it does not invent a new one from the close note.
 */
export function updateIntention(dataRoot, { action, text = '', source = 'day', sleepId = null, now = () => new Date().toISOString() } = {}) {
    const kind = String(action || '').trim();
    if (!ACTIONS.has(kind)) {
        return refuse(kind, 'none', 'Intention action must be pursue, revise, complete, or abandon.', 'invalid_action');
    }
    const at = now();
    const store = readIntentions(dataRoot);
    const words = clip(text, 180);
    const prior = store.active;
    if (kind === 'revise') {
        if (!words) {
            return refuse(kind, 'none', 'Revising an intention needs your own words. Say it with !intention("revise", "a short note"), or take a direct action.', 'needs_words');
        }
        if (prior && prior.text === words) {
            return refuse(kind, 'unchanged', 'That is already your intention. Repeating it changes nothing. Take a direct action, leave it, or use !intention("revise", "a short note") with different words.', 'unchanged');
        }
        if (prior) store.history.push({ ...prior, status: 'revised', updated_at: at });
        store.active = {
            id: prior?.id || `int-${String(store.history.length + 1).padStart(4, '0')}`,
            text: words,
            status: 'active',
            source,
            sleep_id: sleepId,
            progress: '',
            created_at: prior?.created_at || at,
            updated_at: at,
        };
        store.waking_decision_at = at;
    } else if (kind === 'pursue') {
        if (!prior && !words) {
            return refuse(kind, 'none', `You have no active intention to pursue. ${CHOOSE_NEW}`, 'no_active_intention');
        }
        if (prior) {
            const nextProgress = words || prior.progress || '';
            const echoed = !words || words === prior.text || words === (prior.progress || '');
            if (prior.status === 'pursuing' && (prior.progress || '') === nextProgress && echoed) {
                return refuse(kind, 'unchanged', 'That intention is already what you are doing. Repeating it changes nothing. Take a direct action, or change it with !intention("revise", "a short note").', 'unchanged');
            }
        }
        if (!prior) {
            store.active = {
                id: `int-${String(store.history.length + 1).padStart(4, '0')}`,
                text: words,
                status: 'pursuing',
                source,
                sleep_id: sleepId,
                progress: '',
                created_at: at,
                updated_at: at,
            };
        } else {
            store.active = {
                ...prior,
                status: 'pursuing',
                progress: words || prior.progress || '',
                updated_at: at,
            };
        }
        store.waking_decision_at = at;
    } else if (kind === 'complete' || kind === 'abandon') {
        if (!prior) {
            const saved = words ? ` "${words}" was not saved as an intention.` : '';
            return refuse(kind, 'none', `You have no active intention to ${kind}.${saved} ${CHOOSE_NEW}`, 'no_active_intention');
        }
        store.history.push({
            ...prior,
            status: kind === 'complete' ? 'completed' : 'abandoned',
            progress: words || prior.progress || '',
            updated_at: at,
        });
        store.active = null;
        store.waking_decision_at = at;
    }
    store.history = store.history.slice(-30);
    writeAtomic(fileOf(dataRoot), store);
    return { ok: true, changed: true, behaviorKey: intentionWatchKey(kind, 'done'), intentions: store };
}

/**
 * A verified action can note progress. It does not complete the intention.
 * Speech is not passed here.
 */
export function noteVerifiedProgress(dataRoot, text, now = () => new Date().toISOString()) {
    const store = readIntentions(dataRoot);
    const prior = store.active;
    if (!prior || (prior.status !== 'active' && prior.status !== 'pursuing')) {
        return { ok: false, reason: 'no intention' };
    }
    const words = clip(text, 160);
    if (!words) return { ok: false, reason: 'empty' };
    if (prior.progress === words) return { ok: true, unchanged: true, intentions: store };
    const at = now();
    store.active = { ...prior, status: 'pursuing', progress: words, updated_at: at };
    store.waking_decision_at = at;
    writeAtomic(fileOf(dataRoot), store);
    return { ok: true, intentions: store };
}

export function activeIntentionText(store) {
    const active = store?.active;
    if (!active) return '';
    if (active.status !== 'active' && active.status !== 'pursuing') return '';
    return String(active.text || '').trim();
}
