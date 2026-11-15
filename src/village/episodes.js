import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ScenarioError } from './errors.js';

export const RECENT_LIMIT = 12;
export const DREAM_INPUT_CAP = 60;
export const KINDS = new Set(['action', 'conversation', 'observed', 'told']);
export const SOURCES = new Set(['verified', 'observed', 'told', 'interpretation']);

function fileOf(dataRoot) {
    return path.join(dataRoot, 'episodes.json');
}

export function emptyEpisodes() {
    return { schema_version: 1, episodes: [] };
}

export function readEpisodes(dataRoot) {
    const file = fileOf(dataRoot);
    if (!existsSync(file)) return emptyEpisodes();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.episodes)) throw new ScenarioError('episodes.json is unreadable.');
    return parsed;
}

function writeEpisodes(dataRoot, store) {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(fileOf(dataRoot), JSON.stringify(store, null, 2));
    return store;
}

function fingerprint(episode) {
    const refs = [...(episode.refs || [])].map(String).sort().join(',');
    return [episode.kind, episode.source, episode.text, refs].join('|');
}

function nextId(episodes) {
    return `ep-${String(episodes.length + 1).padStart(4, '0')}`;
}

/**
 * Append a code-written episode. An identical kind, source, text, and refs
 * set is not stored twice. Nothing is deleted to satisfy the dream-input cap.
 */
export function appendEpisode(dataRoot, input, { now = () => new Date().toISOString() } = {}) {
    if (!KINDS.has(input?.kind)) throw new ScenarioError(`Episode kind '${input?.kind}' is not valid.`);
    if (!SOURCES.has(input?.source)) throw new ScenarioError(`Episode source '${input?.source}' is not valid.`);
    const text = String(input.text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new ScenarioError('An episode needs factual text.');
    if (/!\w+/.test(text)) throw new ScenarioError('Episode text must not store command syntax.');
    const episode = {
        id: nextId([]),
        at: input.at || now(),
        kind: input.kind,
        source: input.source,
        text: text.slice(0, 240),
        refs: [...new Set((input.refs || []).map(item => String(item)))].slice(0, 8),
        pinned: input.pinned === true,
    };
    const store = readEpisodes(dataRoot);
    episode.id = nextId(store.episodes);
    const seen = new Set(store.episodes.map(fingerprint));
    if (seen.has(fingerprint(episode))) {
        const existing = store.episodes.find(item => fingerprint(item) === fingerprint(episode));
        return { created: false, episode: existing, store };
    }
    store.episodes.push(episode);
    writeEpisodes(dataRoot, store);
    return { created: true, episode, store };
}

export function splitEpisodes(store) {
    const episodes = store?.episodes || [];
    const recent = episodes.slice(-RECENT_LIMIT);
    const archive = episodes.slice(0, Math.max(0, episodes.length - RECENT_LIMIT));
    const pinned = episodes.filter(episode => episode.pinned);
    const dreamInput = [
        ...episodes.filter(episode => !episode.pinned).slice(-DREAM_INPUT_CAP),
        ...pinned,
    ];
    return { recent, archive, dreamInput };
}

/**
 * Prompt slice. Pinned episodes stay. The rest are the newest few.
 * A relevance list (someone nearby, the active intention) pulls a matching
 * older episode forward without dumping the archive.
 */
export function selectEpisodes(store, { limit = 5, relevant = [] } = {}) {
    const episodes = store?.episodes || [];
    const chosen = [];
    const seen = new Set();
    const take = (episode) => {
        if (!episode || seen.has(episode.id) || chosen.length >= limit) return;
        seen.add(episode.id);
        chosen.push(episode);
    };
    for (const episode of episodes) if (episode.pinned) take(episode);
    const needles = relevant.map(item => String(item).toLowerCase()).filter(Boolean);
    if (needles.length) {
        for (const episode of [...episodes].reverse()) {
            const haystack = `${episode.text} ${(episode.refs || []).join(' ')}`.toLowerCase();
            if (needles.some(needle => haystack.includes(needle))) take(episode);
        }
    }
    for (const episode of [...episodes].reverse()) take(episode);
    return chosen.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
