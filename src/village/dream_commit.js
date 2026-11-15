import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { readEpisodes } from './episodes.js';
import { readLife } from './life.js';
import { readRelationships } from './relationships.js';
import { readIntentions } from './intentions.js';
import { ambitionAfterDream, readAmbitions } from './ambitions.js';

const BANK_CAP = 40;

function writeAtomic(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, file);
}

function readJson(file, fallback) {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
}

function commitPath(dataRoot, sleepId) {
    const safe = String(sleepId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dataRoot, 'dream_commits', `${safe}.json`);
}

function readCommit(dataRoot, sleepId) {
    const file = commitPath(dataRoot, sleepId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

function nextMemoryId(memories) {
    const used = new Set(memories.map(row => row.id));
    let n = memories.length + 1;
    while (used.has(`mem-${String(n).padStart(4, '0')}`)) n += 1;
    return `mem-${String(n).padStart(4, '0')}`;
}

function trimBank(memories) {
    if (memories.length <= BANK_CAP) return memories;
    const ranked = [...memories].sort((a, b) => {
        const priority = (a.priority ?? 3) - (b.priority ?? 3);
        if (priority !== 0) return priority;
        return String(a.updated_at || '').localeCompare(String(b.updated_at || ''));
    });
    const drop = new Set(ranked.slice(0, memories.length - BANK_CAP).map(row => row.id));
    return memories.filter(row => !drop.has(row.id));
}

/**
 * Build the next private files from the validated dream. The payload is
 * stored before it is applied. A retry writes those same documents again,
 * so a crash cannot append a second journal entry.
 */
export function planConsolidation(dataRoot, { sleepId, validated, enqueuedAt = null, now = new Date().toISOString(), episodeIds = [] } = {}) {
    const journal = readJson(path.join(dataRoot, 'journal.json'), { schema_version: 1, entries: [] });
    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    const already = entries.some(entry => entry.sleep_id === sleepId);
    const nextJournal = {
        schema_version: 1,
        entries: already ? entries : [...entries, {
            id: `journal-${String(entries.length + 1).padStart(4, '0')}`,
            at: now,
            sleep_id: sleepId,
            text: validated.journal,
            episode_ids: episodeIds,
        }],
    };

    const bank = readJson(path.join(dataRoot, 'long_term.json'), { schema_version: 1, memories: [] });
    let memories = Array.isArray(bank.memories) ? bank.memories.map(row => ({ ...row })) : [];
    for (const row of validated.memories || []) {
        if (row.op === 'forget') {
            if (row.id) memories = memories.filter(item => item.id !== row.id);
            continue;
        }
        const existing = row.id ? memories.find(item => item.id === row.id) : null;
        if (existing) {
            existing.text = row.text;
            existing.kind = row.kind;
            existing.priority = row.priority;
            existing.source_episode_ids = row.source_episode_ids;
            existing.updated_at = now;
            existing.sleep_id = sleepId;
        } else {
            memories.push({
                id: row.id || nextMemoryId(memories),
                text: row.text,
                kind: row.kind,
                priority: row.priority,
                source_episode_ids: row.source_episode_ids,
                updated_at: now,
                sleep_id: sleepId,
            });
        }
    }
    memories = trimBank(memories);

    const relationships = readRelationships(dataRoot);
    const map = { ...(relationships.relationships || {}) };
    for (const row of validated.relationships || []) {
        const prior = map[row.other_id] || { source_episode_ids: [] };
        map[row.other_id] = {
            ...prior,
            stance: row.stance,
            note: row.note,
            updated_at: now,
            source_episode_ids: [...new Set([...(prior.source_episode_ids || []), ...row.source_episode_ids])],
            dream_sleep_id: sleepId,
        };
    }

    const morning = {
        schema_version: 1,
        brief: validated.brief,
        stance: validated.stance || readJson(path.join(dataRoot, 'morning.json'), {}).stance || '',
        intentions: validated.intentions || [],
        sleep_id: sleepId,
        at: now,
    };

    const intentions = readIntentions(dataRoot);
    const decidedAt = intentions.waking_decision_at ? Date.parse(intentions.waking_decision_at) : 0;
    const enqueued = enqueuedAt ? Date.parse(enqueuedAt) : 0;
    const protect = decidedAt && enqueued && decidedAt > enqueued;
    if (!protect) {
        const text = validated.intentions?.[0] || '';
        if (text) {
            if (intentions.active) {
                intentions.history = [...(intentions.history || []), { ...intentions.active, status: 'replaced', updated_at: now }].slice(-30);
            }
            intentions.active = {
                id: `int-${String((intentions.history || []).length + 1).padStart(4, '0')}`,
                text,
                status: 'active',
                source: 'dream',
                sleep_id: sleepId,
                progress: '',
                created_at: now,
                updated_at: now,
            };
        } else if (intentions.active?.source === 'dream') {
            intentions.history = [...(intentions.history || []), { ...intentions.active, status: 'completed', updated_at: now }].slice(-30);
            intentions.active = null;
        }
    }
    intentions.proposals = validated.intentions || [];

    const files = {
        'journal.json': nextJournal,
        'long_term.json': { schema_version: 1, memories },
        'relationships.json': { ...relationships, schema_version: relationships.schema_version || 1, relationships: map },
        'morning.json': morning,
        'intentions.json': intentions,
    };
    const nextAmbition = ambitionAfterDream(readAmbitions(dataRoot), validated.ambition, now);
    if (nextAmbition) files['ambitions.json'] = nextAmbition;

    return {
        schema_version: 1,
        sleep_id: sleepId,
        phase: 'prepared',
        episode_ids: episodeIds,
        files,
    };
}

function markConsolidated(dataRoot, episodeIds, sleepId) {
    const store = readEpisodes(dataRoot);
    const mark = new Set(episodeIds || []);
    if (mark.size === 0) return;
    const episodes = (store.episodes || []).map(episode => (
        mark.has(episode.id) && !episode.consolidated_by
            ? { ...episode, consolidated_by: sleepId }
            : episode
    ));
    writeAtomic(path.join(dataRoot, 'episodes.json'), { ...store, episodes });
}

/**
 * Apply a prepared consolidation, or the same payload again after a crash.
 * Identity, life, lessons, and the craft ledger are not in the payload.
 */
export function commitDream(dataRoot, input) {
    const life = readLife(dataRoot);
    if (!life) return { applied: false, reason: 'missing life' };
    if (life.lifecycle === 'dead') return { applied: false, reason: 'dead' };
    const identity = readJson(path.join(dataRoot, 'identity.json'), null);
    if (!identity) return { applied: false, reason: 'missing identity' };
    if (input.profileChecksum && identity.profile_checksum !== input.profileChecksum) {
        return { applied: false, reason: 'checksum' };
    }
    const existing = readCommit(dataRoot, input.sleepId);
    if (existing?.phase === 'applied') return { applied: true, duplicate: true, commit: existing };

    const payload = existing?.phase === 'prepared'
        ? existing
        : planConsolidation(dataRoot, input);
    writeAtomic(commitPath(dataRoot, input.sleepId), payload);
    for (const [name, body] of Object.entries(payload.files)) {
        writeAtomic(path.join(dataRoot, name), body);
    }
    // Mark the snapshotted episodes on the live file so rows written during
    // inference are kept and are not treated as already consolidated.
    markConsolidated(dataRoot, payload.episode_ids || input.episodeIds || [], input.sleepId);
    const applied = { ...payload, phase: 'applied', applied_at: input.now || new Date().toISOString() };
    writeAtomic(commitPath(dataRoot, input.sleepId), applied);
    return { applied: true, duplicate: false, commit: applied };
}
