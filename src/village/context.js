import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { readEpisodes, selectEpisodes } from './episodes.js';
import { readKnowledge, suppliesGuidance } from './knowledge.js';
import { readRelationships } from './relationships.js';
import { VILLAGE_AUTONOMY_PREAMBLE } from '../agent/startup_goal.js';

export const SHARED_GAMEPLAY_LINE = 'Shared actions, commands, and survival rules are the same for every inhabitant. Identity changes what you choose and what you say. It does not add a job, a script, or a different command set.';

const CONTEXT_FILES = ['identity.json', 'knowledge.json', 'relationships.json', 'episodes.json'];

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function clip(value, max) {
    const text = Array.isArray(value) ? value.map(item => item?.text || item).join(' ') : String(value || '');
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function coord(value) {
    if (!Array.isArray(value) || value.length < 3) return 'unknown';
    return `${value[0]}, ${value[1]}, ${value[2]}`;
}

/**
 * Compact waking context from this directory only.
 * `files` is the allowlist that was opened. Registry, life, and any other
 * inhabitant directory are not read.
 */
export function renderVillageContext(dataRoot, { intention = '', liveChest = undefined, relevant = [] } = {}) {
    const files = [];
    const identityFile = path.join(dataRoot, 'identity.json');
    if (!existsSync(identityFile)) return { text: '', chars: 0, files };
    const identity = readJson(identityFile);
    files.push('identity.json');
    const knowledge = existsSync(path.join(dataRoot, 'knowledge.json'))
        ? (files.push('knowledge.json'), readKnowledge(dataRoot))
        : null;
    const relationships = existsSync(path.join(dataRoot, 'relationships.json'))
        ? (files.push('relationships.json'), readRelationships(dataRoot))
        : { relationships: {} };
    const episodes = existsSync(path.join(dataRoot, 'episodes.json'))
        ? (files.push('episodes.json'), readEpisodes(dataRoot))
        : { episodes: [] };

    const lines = [
        'PRIVATE IDENTITY',
        SHARED_GAMEPLAY_LINE,
        'Live game state and verified lessons override this memory. Something another person said is a claim, not something you witnessed. Your own interpretations are not established facts.',
        `You are ${identity.name}. ${clip(identity.backstory, 420)}`,
        `Temperament: ${clip(identity.temperament, 220)}`,
    ];
    const interests = clip(identity.interests, 160);
    if (interests) lines.push(`Interests, as preferences rather than duties: ${interests}`);
    const current = String(intention || '').trim();
    if (current && current !== VILLAGE_AUTONOMY_PREAMBLE) {
        lines.push(`Current intention: ${clip(current, 180)}`);
    }
    if (knowledge?.home) {
        const home = knowledge.home;
        lines.push(`Your home stands at ${coord(home.home_marker)}. Bed ${coord(home.bed)}. Chest ${coord(home.chest)}. Entrance ${coord(home.door)}. Crafting table ${coord(home.crafting_table)}. Furnace ${coord(home.furnace)}.`);
        lines.push(suppliesGuidance(knowledge, episodes.episodes, liveChest));
    }
    const publicPlaces = (knowledge?.public_places || [])
        .slice(0, 6)
        .map(place => `${place.id} at ${coord(place.marker)}`)
        .join('; ');
    if (publicPlaces) lines.push(`Public places you know: ${publicPlaces}.`);
    const people = Object.entries(relationships.relationships || {})
        .sort((a, b) => String(b[1]?.updated_at || '').localeCompare(String(a[1]?.updated_at || '')))
        .slice(0, 4);
    if (people.length) {
        lines.push('Private views, which others may not share:');
        for (const [id, row] of people) {
            const kind = row.other_kind === 'human' ? ' human' : '';
            lines.push(`- ${id}${kind}: ${clip(row.stance, 60)}. ${clip(row.note, 100)}`);
        }
    }
    const selected = selectEpisodes(episodes, { limit: 5, relevant });
    if (selected.length) {
        lines.push('Recent experience:');
        for (const episode of selected) {
            lines.push(`- ${episode.at} ${episode.kind}/${episode.source}: ${clip(episode.text, 140)}`);
        }
    }
    lines.push('Someone you cannot see is not thereby missing or dead. You learn of a death only by seeing it or by being told.');
    const text = lines.join('\n');
    return { text, chars: text.length, files: CONTEXT_FILES.filter(name => files.includes(name)) };
}

export function wantsVillagePrompt(prompt) {
    return typeof prompt === 'string'
        && (prompt.includes('$COMMAND_DOCS') || prompt.includes('$PREVIOUS_PLAN'));
}

export function appendVillageContext(prompt, block) {
    if (!block || prompt.includes('PRIVATE IDENTITY')) return prompt;
    return `${prompt}\n\n${block}`;
}
