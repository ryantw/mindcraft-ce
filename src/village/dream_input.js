import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { readEpisodes } from './episodes.js';
import { readKnowledge } from './knowledge.js';
import { readRelationships } from './relationships.js';
import { readIntentions, activeIntentionText } from './intentions.js';

export const DREAM_EPISODE_CAP = 60;
export const DREAM_INPUT_CHAR_CAP = 9000;

function readJson(file, fallback) {
    if (!existsSync(file)) return fallback;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function clip(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function episodeCutoff(store) {
    const episodes = store?.episodes || [];
    const last = episodes[episodes.length - 1] || null;
    return { id: last?.id || null, index: episodes.length };
}

/**
 * Episodes at or before the cutoff. The newest sixty unpinned rows plus any
 * pinned row already in that prefix. Nothing after the cutoff is included,
 * so events during inference stay for a later dream.
 */
export function selectDreamEpisodes(store, cutoffIndex = null) {
    const all = store?.episodes || [];
    const end = cutoffIndex == null ? all.length : Math.max(0, Math.min(all.length, cutoffIndex));
    const episodes = all.slice(0, end);
    const pinned = episodes.filter(episode => episode.pinned);
    const recent = episodes.filter(episode => !episode.pinned).slice(-DREAM_EPISODE_CAP);
    const seen = new Set();
    const chosen = [];
    for (const episode of [...recent, ...pinned]) {
        if (!episode?.id || seen.has(episode.id)) continue;
        seen.add(episode.id);
        chosen.push(episode);
    }
    return chosen.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}

function coord(value) {
    if (!Array.isArray(value) || value.length < 3) return null;
    return value.slice(0, 3).join(', ');
}

/**
 * Private snapshot for one mind. Reads only `dataRoot`. Sibling directories,
 * the scenario death roll, and observer files are not opened.
 */
export function buildDreamInput(dataRoot, { cutoffIndex = null, sleepId = null } = {}) {
    const identity = readJson(path.join(dataRoot, 'identity.json'), null);
    const episodes = readEpisodes(dataRoot);
    const included = selectDreamEpisodes(episodes, cutoffIndex);
    const knowledge = readKnowledge(dataRoot);
    const relationships = readRelationships(dataRoot);
    const intentions = readIntentions(dataRoot);
    const longTerm = readJson(path.join(dataRoot, 'long_term.json'), { memories: [] });
    const morning = readJson(path.join(dataRoot, 'morning.json'), null);
    const lessons = readJson(path.join(dataRoot, 'verified_lessons.json'), { lessons: [] });
    const ledger = readJson(path.join(dataRoot, 'craft_ledger.json'), { rows: [] });
    const plan = readJson(path.join(dataRoot, 'plan.json'), null);
    const places = readJson(path.join(dataRoot, 'places.json'), {});

    const home = knowledge?.home || null;
    const lines = [];
    lines.push(`You are ${identity?.name || 'yourself'}, dreaming about your own life. This is private.`);
    lines.push('Use only the notes below. Anything not written here is unknown to you. A feeling is an interpretation. A fact needs the episode you cite, and an episode id does not make a new claim true.');
    lines.push('Write about what matters to you. You do not have to mention every note. Do not copy coordinates, inventory counts, or crafting steps, and do not write a mood piece that could belong to anyone.');
    lines.push('If you want to do something tomorrow, put that desire in intentions. Leave intentions empty only when you want no particular activity.');
    if (sleepId) lines.push(`This sleep is ${sleepId}. You really did get into bed.`);
    if (identity) {
        lines.push('ADMITTED IDENTITY (fixed; do not rewrite it):');
        for (const fact of identity.backstory || []) lines.push(`- ${fact.id}: ${clip(fact.text, 220)}`);
        if (identity.temperament?.length) lines.push(`Temperament: ${clip(identity.temperament, 300)}`);
        if (identity.interests?.length) lines.push(`Interests: ${clip(identity.interests, 200)}`);
    }
    const stance = morning?.stance || '';
    if (stance) lines.push(`Current personal stance: ${clip(stance, 240)}`);
    const active = activeIntentionText(intentions);
    if (active) {
        const progress = intentions.active?.progress ? ` Progress: ${clip(intentions.active.progress, 160)}` : '';
        lines.push(`Current intention (${intentions.active.status}): ${clip(active, 180)}.${progress}`);
    } else {
        lines.push('Current intention: none.');
    }
    const memories = (longTerm.memories || []).slice(-40);
    if (memories.length) {
        lines.push('LONG-TERM MEMORY:');
        for (const row of memories) {
            lines.push(`- ${row.id} [${row.kind || 'interpretation'} p${row.priority ?? 3}] ${clip(row.text, 180)} (episodes: ${(row.source_episode_ids || []).join(', ') || 'none'})`);
        }
    }
    const people = Object.entries(relationships.relationships || {});
    if (people.length) {
        lines.push('PRIVATE RELATIONSHIPS:');
        for (const [id, row] of people) {
            lines.push(`- ${id}: ${clip(row.stance, 60)}. ${clip(row.note, 160)} (episodes: ${(row.source_episode_ids || []).join(', ') || 'none'})`);
        }
    }
    if (home) {
        lines.push(`Home plot ${home.plot_id || 'unknown'} at ${coord(home.home_marker) || 'unknown'}. Bed ${coord(home.bed)}. Chest ${coord(home.chest)}. Crafting table ${coord(home.crafting_table)}. Furnace ${coord(home.furnace)}.`);
    }
    const publicPlaces = (knowledge?.public_places || []).slice(0, 8);
    if (publicPlaces.length) {
        lines.push(`Places: ${publicPlaces.map(place => `${place.id} ${coord(place.marker) || ''}`).join('; ')}`);
    }
    const named = Object.entries(places || {}).filter(([key]) => key !== 'schema_version').slice(0, 8);
    if (named.length) {
        lines.push(`Places you can return to: ${named.map(([key]) => key).join(', ')}.`);
    }
    const lessonLines = (lessons.lessons || []).slice(-12).map(lesson => clip(lesson.text, 180)).filter(Boolean);
    if (lessonLines.length) {
        lines.push('VERIFIED GAMEPLAY (code-owned; do not change these):');
        for (const line of lessonLines) lines.push(`- ${line}`);
    }
    const ledgerRows = Array.isArray(ledger) ? ledger : (ledger.rows || []);
    if (ledgerRows.length) {
        lines.push('CRAFT LEDGER (code-owned):');
        for (const row of ledgerRows.slice(-12)) {
            lines.push(`- ${row.item}: ${clip(row.recipe || row.last_outcome || '', 120)}`);
        }
    }
    const current = plan?.current || plan;
    if (current?.objective) {
        const step = (current.steps || []).find(item => item.status === 'active') || current.steps?.[0];
        lines.push(`Plan: ${clip(current.objective, 160)} (${current.status || 'unknown'}). ${step ? clip(step.description, 120) : ''}`);
    }
    lines.push('EPISODES (id, kind/source, what you actually recorded):');
    const rendered = [];
    for (const episode of included) {
        rendered.push(`- ${episode.id} ${episode.kind}/${episode.source}${episode.pinned ? ' pinned' : ''}: ${clip(episode.text, 180)}`);
    }
    let body = [...lines, ...rendered].join('\n');
    let dropped = 0;
    while (body.length > DREAM_INPUT_CHAR_CAP && rendered.length > 1) {
        const removable = rendered.findIndex(line => !line.includes(' pinned'));
        if (removable < 0) break;
        rendered.splice(removable, 1);
        dropped += 1;
        body = [...lines, ...rendered].join('\n');
    }
    const keptIds = new Set();
    for (const line of rendered) {
        const id = line.slice(2).split(' ')[0];
        keptIds.add(id);
    }
    const kept = included.filter(episode => keptIds.has(episode.id));
    return {
        text: body,
        chars: body.length,
        episodes: kept,
        episodeIds: kept.map(episode => episode.id),
        dropped,
        identityName: identity?.name || '',
        verifiedFacts: lessonLines,
        ledgerText: ledgerRows.map(row => `${row.item || ''} ${row.recipe || ''} ${row.last_outcome || ''}`),
    };
}
