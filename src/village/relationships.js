import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { appendEpisode, readEpisodes } from './episodes.js';

const KINDS = new Set(['inhabitant', 'human']);

function fileOf(dataRoot) {
    return path.join(dataRoot, 'relationships.json');
}

export function readRelationships(dataRoot) {
    if (!existsSync(fileOf(dataRoot))) return { schema_version: 1, relationships: {} };
    return JSON.parse(readFileSync(fileOf(dataRoot), 'utf8'));
}

function writeRelationships(dataRoot, store) {
    writeFileSync(fileOf(dataRoot), JSON.stringify(store, null, 2));
    return store;
}

function supportingEpisode(store, otherId) {
    const needle = String(otherId);
    return [...(store.episodes || [])].reverse().find(episode =>
        episode.source !== 'interpretation'
        && ((episode.refs || []).includes(needle) || episode.text.includes(needle))
    ) || null;
}

/**
 * A private stance. The supporting episode must already exist in this
 * inhabitant's own store. Nothing here copies the profile or another mind.
 */
export function expressStance(dataRoot, { other_id, other_kind, stance, note, now = () => new Date().toISOString() } = {}) {
    const otherId = String(other_id || '').trim();
    const kind = String(other_kind || '').trim();
    const stanceText = String(stance || '').replace(/!\w+/g, '').replace(/\s+/g, ' ').trim();
    const noteText = String(note || '').replace(/!\w+/g, '').replace(/\s+/g, ' ').trim();
    if (!otherId) return { ok: false, reason: 'Name the person this is about.' };
    if (!KINDS.has(kind)) return { ok: false, reason: 'Kind must be inhabitant or human.' };
    if (!stanceText || !noteText) return { ok: false, reason: 'A stance needs your own words and what it is based on.' };
    const support = supportingEpisode(readEpisodes(dataRoot), otherId);
    if (!support) {
        return { ok: false, reason: `You have no recorded experience with ${otherId} to base that on.` };
    }
    const interpretation = appendEpisode(dataRoot, {
        kind: 'observed',
        source: 'interpretation',
        text: `My view of ${otherId} is ${stanceText}. ${noteText}`,
        refs: [otherId, support.id],
        at: now(),
    });
    const store = readRelationships(dataRoot);
    const prior = store.relationships[otherId] || { source_episode_ids: [] };
    const sources = [...new Set([...(prior.source_episode_ids || []), support.id])];
    store.relationships[otherId] = {
        stance: stanceText.slice(0, 80),
        note: noteText.slice(0, 240),
        updated_at: now(),
        source_episode_ids: sources,
        other_kind: kind,
        opinion_episode_id: interpretation.episode.id,
    };
    writeRelationships(dataRoot, store);
    return { ok: true, relationship: store.relationships[otherId], support_episode_id: support.id };
}
