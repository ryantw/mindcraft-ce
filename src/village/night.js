import { existsSync, readFileSync } from 'fs';
import path from 'path';
import settings from '../agent/settings.js';
import { readKnowledge } from './knowledge.js';

const ANOTHER_BED = /occupied|not a bed|half bed/i;

export const DUSK_START = 12000;
export const NIGHT_START = 13000;
export const NIGHT_END = 23000;
const SLEEP_RETRY_MS = 20000;
const HOME_RANGE = 6;

export function nightPhase(timeOfDay) {
    const value = Number(timeOfDay);
    if (!Number.isFinite(value)) return 'day';
    const time = ((value % 24000) + 24000) % 24000;
    if (time >= NIGHT_START && time < NIGHT_END) return 'night';
    if (time >= DUSK_START && time < NIGHT_START) return 'dusk';
    return 'day';
}

export function autonomyPausedForNight(phase) {
    return phase === 'dusk' || phase === 'night';
}

function point(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length >= 3) return { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) };
    if (Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)) && Number.isFinite(Number(value.z))) {
        return { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
    }
    return null;
}

function distance(from, to) {
    if (!from || !to) return Infinity;
    return Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
}

export function nightEmergency(bot) {
    if (!bot?.entity) return false;
    if ((bot.health ?? 20) <= 8) return true;
    let here = null;
    let above = null;
    try {
        here = bot.blockAt?.(bot.entity.position);
        above = bot.blockAt?.(bot.entity.position.offset(0, 1, 0));
    } catch {
        return false;
    }
    const names = [here?.name, above?.name];
    return names.some(name => name === 'water' || name === 'lava' || name === 'fire');
}

/**
 * What the body should do while the night routine is in force.
 * Emergencies return idle so combat and water modes keep the body.
 */
export function nextNightAction({ phase, sleeping = false, emergency = false, position = null, home = null, now = 0, nextSleepAt = 0 } = {}) {
    if (sleeping || phase === 'day') return { kind: 'idle' };
    if (emergency) return { kind: 'idle', reason: 'emergency' };
    if (phase !== 'dusk' && phase !== 'night') return { kind: 'idle' };
    const feet = point(position);
    const door = point(home?.door) || point(home?.home_marker);
    const bed = point(home?.bed);
    const anchor = door || bed;
    if (anchor && distance(feet, anchor) > HOME_RANGE) return { kind: 'move', target: anchor, label: 'home' };
    if (phase === 'dusk') return { kind: 'wait', reason: 'home before night' };
    if (now < nextSleepAt) return { kind: 'wait', reason: 'sleep retry' };
    if (bed && distance(feet, bed) > 2) return { kind: 'move', target: bed, label: 'bed' };
    if (bed) return { kind: 'sleep', target: bed, door: point(home?.door) };
    return { kind: 'nearest_bed' };
}

/** A home bed stays preferred. These failures mean that bed itself cannot be used. */
export function bedNeedsAnother(message) {
    return ANOTHER_BED.test(String(message || ''));
}

/**
 * Assigned home wins. With no home, a place saved as `bed` is the preference.
 * Anything else is left for a nearby bed.
 */
export function nightHomeFrom(knowledge, places = null) {
    if (knowledge?.home) return knowledge.home;
    const bed = places?.bed;
    if (Array.isArray(bed) && bed.length >= 3 && bed.slice(0, 3).every(value => Number.isFinite(Number(value)))) {
        return { bed: bed.slice(0, 3).map(Number) };
    }
    return null;
}

export function readNightHome(dataRoot = settings.agent_data_root) {
    try {
        const knowledge = readKnowledge(dataRoot);
        let places = null;
        if (!knowledge?.home && dataRoot) {
            const file = path.join(dataRoot, 'places.json');
            if (existsSync(file)) places = JSON.parse(readFileSync(file, 'utf8'));
        }
        return nightHomeFrom(knowledge, places);
    } catch {
        return null;
    }
}

function samePoint(loc, avoid) {
    if (!avoid || !loc) return false;
    return Number(loc.x) === Number(avoid.x)
        && Number(loc.y) === Number(avoid.y)
        && Number(loc.z) === Number(avoid.z);
}

async function sleepInReachableBed(bot, avoid, goToPosition) {
    const beds = bot.findBlocks?.({
        matching: block => String(block?.name || '').includes('bed'),
        maxDistance: 32,
        count: 8,
    }) || [];
    for (const loc of beds) {
        if (samePoint(loc, avoid)) continue;
        await goToPosition(bot, loc.x, loc.y, loc.z, 1);
        const bed = bot.blockAt?.(loc);
        if (!bed || !String(bed.name || '').includes('bed')) continue;
        try {
            await bot.sleep(bed);
        } catch (error) {
            if (bedNeedsAnother(error.message)) continue;
            throw error;
        }
        bot.modes?.pause?.('unstuck');
        while (bot.isSleeping) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return true;
    }
    return false;
}

async function noteSleepWait(agent, memory, reason) {
    memory.nextSleepAt = Date.now() + SLEEP_RETRY_MS;
    memory.lastFailure = reason;
    console.warn(`[${agent.name}] Sleep was not accepted (${reason}). Staying with the night routine.`);
}

async function closeDoorIfOpen(bot, door, bed) {
    if (!door || !bed || !bot.blockAt) return;
    const feet = point(bot.entity?.position);
    if (distance(feet, bed) > distance(feet, door)) return;
    let block;
    try {
        block = bot.blockAt(door);
    } catch {
        return;
    }
    if (!block || !String(block.name || '').includes('door') || !block._properties?.open) return;
    try {
        await bot.activateBlock(block);
    } catch {
        // A stuck door does not cancel the sleep attempt.
    }
}

/**
 * One night step. Successful sleep waits in bed until Minecraft wakes the body.
 * A rejected sleep waits out a retry instead of asking the model again.
 */
export async function performNightAction(agent, action) {
    const { goToPosition } = await import('../agent/library/skills.js');
    const bot = agent.bot;
    const memory = bot._nightSleep || (bot._nightSleep = { nextSleepAt: 0 });
    if (action.kind === 'move' && action.target) {
        await goToPosition(bot, action.target.x, action.target.y, action.target.z, action.label === 'bed' ? 1 : 2);
        return;
    }
    if (action.kind === 'nearest_bed') {
        try {
            const slept = await sleepInReachableBed(bot, null, goToPosition);
            if (!slept) memory.nextSleepAt = Date.now() + SLEEP_RETRY_MS;
        } catch (error) {
            await noteSleepWait(agent, memory, error.message);
        }
        return;
    }
    if (action.kind !== 'sleep') return;
    await closeDoorIfOpen(bot, action.door, action.target);
    const { Vec3 } = await import('vec3');
    let block = null;
    try {
        block = bot.blockAt(new Vec3(action.target.x, action.target.y, action.target.z));
    } catch {
        block = null;
    }
    if (!block || !String(block.name || '').includes('bed')) {
        console.warn(`[${agent.name}] The remembered bed is not usable (${block?.name || 'missing'}). Looking for another bed.`);
        try {
            const slept = await sleepInReachableBed(bot, action.target, goToPosition);
            if (!slept) memory.nextSleepAt = Date.now() + SLEEP_RETRY_MS;
        } catch (error) {
            await noteSleepWait(agent, memory, error.message);
        }
        return;
    }
    console.log(`[${agent.name}] Attempting to sleep.`);
    try {
        await bot.sleep(block);
        bot.modes?.pause?.('unstuck');
        while (bot.isSleeping) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } catch (error) {
        if (!bedNeedsAnother(error.message)) {
            await noteSleepWait(agent, memory, error.message);
            return;
        }
        console.warn(`[${agent.name}] The bed could not be used (${error.message}). Looking for another bed.`);
        try {
            const slept = await sleepInReachableBed(bot, action.target, goToPosition);
            if (!slept) memory.nextSleepAt = Date.now() + SLEEP_RETRY_MS;
        } catch (next) {
            await noteSleepWait(agent, memory, next.message);
        }
    }
}

export async function runNightRoutine(agent) {
    const bot = agent.bot;
    if (!bot) return { kind: 'idle' };
    const memory = bot._nightSleep || (bot._nightSleep = { nextSleepAt: 0, silenced: false });
    const phase = nightPhase(bot.time?.timeOfDay);
    if (phase === 'day') {
        memory.nextSleepAt = 0;
        memory.silenced = false;
        return { kind: 'idle' };
    }
    if (!memory.silenced) {
        memory.silenced = true;
        try {
            const { default: convoManager } = await import('../agent/conversation.js');
            convoManager.endAllConversations();
        } catch { /* no open conversation */ }
    }
    const action = nextNightAction({
        phase,
        sleeping: bot.isSleeping === true,
        emergency: nightEmergency(bot),
        position: bot.entity?.position,
        home: readNightHome(),
        now: Date.now(),
        nextSleepAt: memory.nextSleepAt || 0,
    });
    if (action.kind === 'idle' || action.kind === 'wait') return action;
    await performNightAction(agent, action);
    return action;
}
