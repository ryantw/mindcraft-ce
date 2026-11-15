import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

function fileOf(dataRoot) {
    return path.join(dataRoot, 'ambitions.json');
}

function writeAtomic(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, file);
}

function clip(text, max = 240) {
    return String(text || '').replace(/!\w+(?:\([^)]*\))?/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function emptyAmbitions() {
    return { schema_version: 1, active: null, history: [] };
}

export function readAmbitions(dataRoot) {
    const file = fileOf(dataRoot);
    if (!dataRoot || !existsSync(file)) return emptyAmbitions();
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return {
            ...emptyAmbitions(),
            ...parsed,
            history: Array.isArray(parsed.history) ? parsed.history : [],
        };
    } catch {
        return emptyAmbitions();
    }
}

export function activeAmbitionText(store) {
    const text = String(store?.active?.text || '').trim();
    return store?.active?.status === 'active' ? text : '';
}

/**
 * Write the profile seed once. A later start, a dream, or a revision
 * does not replace an ambition the inhabitant already has.
 */
export function ensureSeededAmbition(dataRoot, seed, now = () => new Date().toISOString()) {
    if (!dataRoot || existsSync(fileOf(dataRoot))) return { seeded: false };
    const text = clip(Array.isArray(seed) ? seed.join(' ') : seed);
    if (!text) return { seeded: false };
    const at = now();
    const store = {
        ...emptyAmbitions(),
        active: { id: 'amb-0001', text, status: 'active', source: 'seed', created_at: at, updated_at: at },
    };
    writeAtomic(fileOf(dataRoot), store);
    return { seeded: true, ambitions: store };
}

/** Revise the private ambition. The admitted identity is not touched. */
export function reviseAmbition(dataRoot, text, { source = 'day', now = () => new Date().toISOString() } = {}) {
    const words = clip(text);
    if (!words) return { ok: false, reason: 'An ambition needs your own words.' };
    const store = readAmbitions(dataRoot);
    if (activeAmbitionText(store) === words) {
        return { ok: false, unchanged: true, reason: 'That is already your ambition. Repeating it changes nothing.' };
    }
    const at = now();
    if (store.active) {
        store.history = [...store.history, { ...store.active, status: 'revised', updated_at: at }].slice(-20);
    }
    const nextId = store.active?.id || `amb-${String(store.history.length + 1).padStart(4, '0')}`;
    store.active = {
        id: nextId,
        text: words,
        status: 'active',
        source,
        created_at: store.active?.created_at || at,
        updated_at: at,
    };
    writeAtomic(fileOf(dataRoot), store);
    return { ok: true, ambitions: store };
}

/** The store a dream commit should write, or null when the ambition is unchanged. */
export function ambitionAfterDream(store, text, now = new Date().toISOString()) {
    const words = clip(text);
    if (!words || activeAmbitionText(store) === words) return null;
    const at = now;
    const history = store?.active
        ? [...(store.history || []), { ...store.active, status: 'revised', updated_at: at }].slice(-20)
        : [...(store?.history || [])];
    return {
        schema_version: 1,
        history,
        active: {
            id: store?.active?.id || `amb-${String(history.length + 1).padStart(4, '0')}`,
            text: words,
            status: 'active',
            source: 'dream',
            created_at: store?.active?.created_at || at,
            updated_at: at,
        },
    };
}
