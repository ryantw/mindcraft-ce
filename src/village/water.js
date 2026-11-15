import settings from '../agent/settings.js';
import { appendEpisode } from './episodes.js';
import { createActionOutcome } from '../agent/action_outcome.js';
import { getBlockId } from '../utils/mcdata.js';

const WATER_NAMES = new Set(['water', 'flowing_water', 'bubble_column']);
const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'grass', 'fern', 'snow', 'dead_bush']);

export function isWaterName(name) {
    return WATER_NAMES.has(name);
}

/**
 * Feet, head, and the entity flag. Oxygen below a full bar while in water
 * means the head is under. `aquatic` is reserved for a future explicit swim.
 */
export function readWaterState(bot) {
    const position = bot?.entity?.position;
    const feet = position && bot.blockAt ? bot.blockAt(position) : null;
    const head = position?.offset && bot.blockAt ? bot.blockAt(position.offset(0, 1, 0)) : null;
    const feetWater = isWaterName(feet?.name);
    const headWater = isWaterName(head?.name);
    const entityWater = bot?.entity?.isInWater === true;
    const inWater = feetWater || headWater || entityWater;
    const oxygen = typeof bot?.oxygenLevel === 'number' ? bot.oxygenLevel : null;
    const submerged = headWater || (inWater && oxygen != null && oxygen < 20);
    return {
        inWater,
        submerged,
        aquatic: bot?.aquaticActivity === true,
        oxygen,
    };
}

export function shouldEscapeWater(state) {
    return state?.inWater === true && state.aquatic !== true;
}

/** Survival keeps the stock swimmer. Village travel stays dry unless already escaping. */
export function navigationMode({ village = false, inWater = false, aquatic = false, allowWater = false } = {}) {
    if (!village) return 'survival';
    if (aquatic || allowWater) return 'swim';
    if (inWater) return 'escape';
    return 'dry';
}

export function isBankStand(feet, head, below) {
    if (isWaterName(feet) || isWaterName(head) || isWaterName(below)) return false;
    if (!below || PASSABLE.has(below) || below === 'lava' || below === 'flowing_lava') return false;
    if (feet && !PASSABLE.has(feet)) return false;
    if (head && !PASSABLE.has(head)) return false;
    return true;
}

export function exitKey(exit) {
    return `${exit.x},${exit.y},${exit.z}`;
}

/** Low climb first, then nearby columns. A steep face does not crowd out a step. */
export function shortlistExits(candidates, { limit = 12 } = {}) {
    const byDistance = [...candidates].sort((a, b) => a.distance - b.distance);
    const byClimb = [...candidates].sort((a, b) => Math.abs(a.climb) - Math.abs(b.climb) || a.distance - b.distance);
    const seen = new Set();
    const chosen = [];
    for (const candidate of [...byClimb, ...byDistance]) {
        const key = exitKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        chosen.push(candidate);
        if (chosen.length >= limit) break;
    }
    return chosen;
}

/** Lowest path cost among exits the search actually reached. Rejected exits stay out. */
export function selectExit(candidates, rejected = new Set()) {
    const open = candidates.filter(candidate => candidate.reachable && !rejected.has(exitKey(candidate)));
    open.sort((a, b) => a.cost - b.cost || a.distance - b.distance);
    return open[0] || null;
}

export function shouldAbandonExit({ moved = 0, elapsedMs = 0, limitMs = 2500, minimumMove = 0.75 } = {}) {
    return elapsedMs >= limitMs && moved < minimumMove;
}

export function avoidWaterBlocks(movements, ids) {
    for (const id of ids) {
        if (id == null) continue;
        movements.blocksToAvoid.add(id);
        movements.blocksCantBreak.add(id);
        movements.replaceables?.delete(id);
    }
    return movements;
}

export function configureDryLand(movements) {
    const ids = ['water', 'flowing_water', 'bubble_column'].map(name => getBlockId(name));
    return avoidWaterBlocks(movements, ids);
}

/** Swim to a bank. Do not dig the shore or place a bridge. */
export function configureSwimEscape(movements) {
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    movements.liquidCost = 1;
    movements.dontCreateFlow = true;
    movements.placeCost = 1000;
    return movements;
}

export function combatWaitsForLand(state) {
    return shouldEscapeWater(state);
}

export function waterBlockedOutcome({ action, params = {}, x, y, z, bot }) {
    return createActionOutcome({
        action,
        params,
        status: 'failure',
        before: { counts: {}, storage: null },
        after: { counts: {}, storage: null },
        reason: {
            code: 'water_blocked',
            message: 'Could not reach the destination without entering water.',
            prerequisites: ['Choose a destination that can be reached on dry ground.'],
            condition: 'unchanged_behavior',
        },
        retryableWithoutStateChange: false,
        relevantProgress: false,
        behaviorKey: `water:${Math.floor(Number(x))}:${Math.floor(Number(y))}:${Math.floor(Number(z))}`,
        bot,
    });
}

function floored(position) {
    if (!position) return '';
    const x = Math.floor(Number(position.x));
    const y = Math.floor(Number(position.y));
    const z = Math.floor(Number(position.z));
    if (![x, y, z].every(Number.isFinite)) return '';
    return `${x}, ${y}, ${z}`;
}

export function waterEpisodeText(kind, position) {
    const where = floored(position);
    const place = where ? ` at ${where}` : '';
    if (kind === 'entry') return `I fell into the water${place}.`;
    if (kind === 'exit') return `I got out of the water onto the bank${place}.`;
    if (kind === 'blocked') return 'I could not reach that place without entering water.';
    return null;
}

export function rememberWater(dataRoot, kind, position) {
    if (settings.village_autonomy !== true || !dataRoot) return null;
    const text = waterEpisodeText(kind, position);
    if (!text) return null;
    try {
        return appendEpisode(dataRoot, {
            kind: 'observed',
            source: 'verified',
            text,
            refs: ['water', kind],
        });
    } catch (error) {
        console.warn(`[village] Water episode was not stored: ${error.message}`);
        return null;
    }
}
