import settings from '../agent/settings.js';
import { appendEpisode } from './episodes.js';
import { readableRemains } from './remains.js';
import { distanceBetween, DEFAULT_HEARING_BLOCKS } from './locality.js';
import { recordDeathKnowledge } from './death.js';

const SKIPPED = new Set([
    'stop', 'stats', 'inventory', 'nearbyBlocks', 'entities', 'goToCoordinates',
    'goToPlayer', 'moveAway', 'followPlayer', 'lookAt', 'searchWiki', 'goal', 'endGoal',
    'mode', 'stance',
]);

const LABELS = {
    takeFromChest: 'I inspected a container.',
    putInChest: 'I put something into a container.',
    givePlayer: 'I gave something to someone.',
    goToBed: 'I slept.',
    consume: 'I ate.',
    craftRecipe: 'I made something.',
    smeltItem: 'I cooked or smelted something.',
    placeHere: 'I placed a block.',
    collectBlocks: 'I gathered something.',
    goToPlace: 'I went to a place I know.',
    newPlace: 'I learned a place.',
    attack: 'I fought something.',
    attackPlayer: 'I fought someone.',
};

function commandLabel(commandName) {
    return String(commandName || '').replace(/^!/, '');
}

function plain(text) {
    return String(text || '').replace(/!\w+(\([^)]*\))?/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Turn a verified action into an episode, or return null for movement,
 * bookkeeping, and unnamed noise. Repeated identical outcomes dedupe later.
 */
export function episodeForAction({ commandName, failed = false, resultText = '' } = {}) {
    const name = commandLabel(commandName);
    if (!name || SKIPPED.has(name)) return null;
    const label = LABELS[name];
    if (!label && failed) return null;
    const detail = plain(resultText);
    const text = failed
        ? `A meaningful attempt failed. ${detail || label || name}`.trim()
        : (detail ? `${label || 'I did something.'} ${detail}` : (label || null));
    if (!text) return null;
    const refs = [];
    if (name === 'takeFromChest' || name === 'putInChest') refs.push('container');
    if (name === 'goToBed') refs.push('sleep');
    if (name === 'goToPlace' || name === 'newPlace') refs.push('place');
    return {
        kind: 'action',
        source: 'verified',
        text,
        refs,
    };
}

export function recordVillageAction(dataRoot, input) {
    if (settings.village_autonomy !== true || !dataRoot) return null;
    const episode = episodeForAction(input);
    if (!episode) return null;
    try {
        return appendEpisode(dataRoot, episode);
    } catch (error) {
        console.warn(`[village] Episode was not stored: ${error.message}`);
        return null;
    }
}

export function recordVillageSpeech(dataRoot, { speaker, text } = {}) {
    if (settings.village_autonomy !== true || !dataRoot) return null;
    if (!speaker || speaker === 'system') return null;
    const heard = plain(text);
    if (!heard) return null;
    try {
        return appendEpisode(dataRoot, {
            kind: 'conversation',
            source: 'observed',
            text: `${speaker} said: ${heard}`.slice(0, 240),
            refs: [speaker],
        });
    } catch (error) {
        console.warn(`[village] Conversation was not stored: ${error.message}`);
        return null;
    }
}

/**
 * A remains entity inside hearing range becomes one local observation.
 * Entities that are farther away, or that are not tagged remains, are ignored.
 */
export function noteNearbyRemains(dataRoot, bot, { range = DEFAULT_HEARING_BLOCKS } = {}) {
    if (settings.village_autonomy !== true || !dataRoot || !bot?.entity?.position) return [];
    const found = [];
    const entities = bot.entities ? Object.values(bot.entities) : [];
    for (const entity of entities) {
        const remains = readableRemains(entity);
        if (!remains) continue;
        const distance = distanceBetween(bot.entity.position, entity.position);
        if (distance == null || distance > range) continue;
        const recorded = recordDeathKnowledge(dataRoot, {
            channel: 'discovery',
            text: `I found a marker reading "${remains.label}".`,
            refs: ['remains', remains.label],
        });
        found.push(recorded);
    }
    return found;
}
