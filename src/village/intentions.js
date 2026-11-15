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

/**
 * A personal intention is a hint. It is not written into the self-prompt and
 * it does not create a plan. Simple social choices stay one action.
 */
export function updateIntention(dataRoot, { action, text = '', source = 'day', sleepId = null, now = () => new Date().toISOString() } = {}) {
    const kind = String(action || '').trim();
    if (!ACTIONS.has(kind)) return { ok: false, reason: 'Intention action must be pursue, revise, complete, or abandon.' };
    const at = now();
    const store = readIntentions(dataRoot);
    const words = clip(text, 180);
    const prior = store.active;
    if (kind === 'revise') {
        if (!words) return { ok: false, reason: 'Revising an intention needs your own words.' };
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
        if (!prior && !words) return { ok: false, reason: 'There is no intention to pursue.' };
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
        if (!prior) return { ok: false, reason: 'There is no intention to close.' };
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
    return { ok: true, intentions: store };
}

export function activeIntentionText(store) {
    const active = store?.active;
    if (!active) return '';
    if (active.status !== 'active' && active.status !== 'pursuing') return '';
    return String(active.text || '').trim();
}
