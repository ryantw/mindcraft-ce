import { readEpisodes, selectEpisodes } from './episodes.js';
import { readKnowledge, suppliesGuidance } from './knowledge.js';
import { readRelationships } from './relationships.js';
import { readIntentions, activeIntentionText } from './intentions.js';
import { VILLAGE_AUTONOMY_PREAMBLE } from '../agent/startup_goal.js';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export const SHARED_GAMEPLAY_LINE = 'Shared actions, commands, and survival rules are the same for every inhabitant. Identity changes what you choose and what you say. It does not add a job, a script, or a different command set.';

export const SHARED_WORLD_LINE = 'Darkness and night are dangerous outdoors. A house can shelter you, and a bed can be slept in when you choose and the game allows it. Do not attack a calm neutral creature such as an enderman, wolf, bee, or piglin. Retreating, eating, and seeking shelter are valid, and immediate danger outranks a personal intention. Sleep is a choice, not a schedule. Armor and a weapon left in a chest protect no one; wear what you are carrying. Stay on dry land. Water is not a path, and getting out of it comes before fighting.';

const CONTEXT_FILES = ['identity.json', 'knowledge.json', 'relationships.json', 'episodes.json', 'morning.json', 'intentions.json'];

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
        SHARED_WORLD_LINE,
        'Live game state and verified lessons override this memory. Something another person said is a claim, not something you witnessed. Your own interpretations are not established facts.',
        `You are ${identity.name}. ${clip(identity.backstory, 420)}`,
        `Temperament: ${clip(identity.temperament, 220)}`,
    ];
    const interests = clip(identity.interests, 160);
    if (interests) lines.push(`Interests, as preferences rather than duties: ${interests}`);
    const personalStore = existsSync(path.join(dataRoot, 'intentions.json'))
        ? (files.push('intentions.json'), readIntentions(dataRoot))
        : null;
    const personal = activeIntentionText(personalStore);
    const current = personal || String(intention || '').trim();
    if (current && current !== VILLAGE_AUTONOMY_PREAMBLE) {
        lines.push(`Current intention: ${clip(current, 180)}`);
        if (personal) {
            lines.push('That intention is optional. You may pursue it, revise it, finish it, or leave it. Saying it aloud is not progress.');
            if (personalStore?.active?.progress) {
                lines.push(`Verified progress: ${clip(personalStore.active.progress, 160)}`);
            }
        }
    }
    const morningFile = path.join(dataRoot, 'morning.json');
    if (existsSync(morningFile)) {
        files.push('morning.json');
        const morning = readJson(morningFile);
        if (morning?.stance) lines.push(`Personal stance: ${clip(morning.stance, 240)}`);
        if (morning?.brief) {
            const brief = String(morning.brief).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 10).join('\n');
            const shown = brief.length <= 700 ? brief : `${brief.slice(0, 699)}…`;
            lines.push(`This morning you remember:\n${shown}`);
        }
    }
    if (knowledge?.home) {
        const home = knowledge.home;
        lines.push(`Your home stands at ${coord(home.home_marker)}. Bed ${coord(home.bed)}. Chest ${coord(home.chest)}. Entrance ${coord(home.door)}. Crafting table ${coord(home.crafting_table)}. Furnace ${coord(home.furnace)}.`);
        lines.push('The crafting table and furnace at home are already there. Do not gather materials to craft or place another unless you have seen that the one at home is gone.');
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
