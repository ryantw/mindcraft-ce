import minecraftData from 'minecraft-data';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from '../settings.js';
import * as world from './world.js';

/**
 * General-purpose, survival-safe construction.
 *
 *   placeBlockAt  one block at exact coordinates
 *   buildLine     axis-aligned line of blocks
 *   buildPlane    axis-aligned wall, floor or roof
 *
 * All three share one engine (buildBlocks) with these guarantees:
 *   - No server commands, no creative inventory, no teleporting, no generated
 *     resources, no generated code. Blocks come from the agent's own inventory.
 *   - Existing blocks are never broken or replaced (only air, fluids and
 *     trivially replaceable plants are built into). Movement for placement
 *     never digs and never scaffolds.
 *   - Every placement is verified against the actual world block. The final
 *     report comes from re-scanning the world, not from counters or from the
 *     placement call resolving.
 *   - Bounded: request size, distance, time, and attempts per block.
 *   - A placement that would seal the agent into an enclosed space is refused.
 *   - Interruptible, and resumable: re-running the same request skips blocks
 *     already in place.
 */

export const CONSTRUCTION_LIMITS = Object.freeze({
    maxLineLength: 32,
    maxPlaneBlocks: 100,
    maxPlaneSide: 32,
    maxDistance: 48,          // farthest requested block from the agent at the start
    maxMillis: 4 * 60 * 1000, // wall-clock budget for one request
    navigateMillis: 20 * 1000,
    attemptsPerBlock: 2,
});

const REACH = 4.0; // survival reach is 4.5; stay inside it
const MIN_Y = -64;
const MAX_Y = 319;

// Building into these never destroys anything of value.
const REPLACEABLE = new Set([
    'air', 'cave_air', 'void_air', 'water', 'short_grass', 'grass', 'tall_grass',
    'fern', 'large_fern', 'dead_bush', 'snow',
]);
const GRAVITY = /^(sand|red_sand|gravel)$|_concrete_powder$/;
const FORBIDDEN = /^(tnt|bedrock|barrier|spawner|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|end_portal_frame|respawn_anchor|light)$/;

let registryCache = null;
function registry() {
    if (!registryCache) {
        const version = settings.minecraft_version && settings.minecraft_version !== 'auto'
            ? settings.minecraft_version
            : '1.21.6';
        registryCache = minecraftData(version);
    }
    return registryCache;
}

function isFullCube(name) {
    const shapes = registry().blockCollisionShapes;
    if (!shapes) return false;
    const entry = shapes.blocks[name];
    const shape = shapes.shapes[Array.isArray(entry) ? entry[0] : entry];
    return Array.isArray(shape) && shape.length === 1 &&
        shape[0].length === 6 && shape[0].every((value, index) => value === [0, 0, 0, 1, 1, 1][index]);
}

const key = position => `${position.x},${position.y},${position.z}`;
const toVec = position => new Vec3(position.x, position.y, position.z);
const plain = position => ({ x: position.x, y: position.y, z: position.z });

function log(bot, message) {
    if (typeof bot.output === 'string') bot.output += `${message}\n`;
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitTicks(bot, ticks) {
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(ticks);
    else await sleep(5);
}

// ---------------------------------------------------------------------------
// Request validation and expansion (pure; also used by plan feasibility)
// ---------------------------------------------------------------------------

/** Why a block type cannot be built with these commands, or null. */
export function unbuildableReason(type, { allowDoors = false } = {}) {
    const block = registry().blocksByName[type];
    if (!block) return `"${type}" is not a block.`;
    if (['air', 'cave_air', 'void_air'].includes(type)) return 'Removing blocks is not a construction operation; these commands only place blocks.';
    if (type === 'water' || type === 'lava') return 'Liquids cannot be placed with these commands.';
    if (FORBIDDEN.test(type)) return `${type} cannot be placed with these commands.`;
    if (GRAVITY.test(type)) return `${type} falls when unsupported and cannot be placed reliably.`;
    if (allowDoors && /_door$/.test(type)) return null;
    if (!isFullCube(type)) {
        return `${type} is not a full solid block. These commands place full solid blocks (planks, logs, stone, cobblestone, dirt, bricks, glass...)${allowDoors ? ' and doors' : ''}; use !placeHere for other items.`;
    }
    return null;
}

function integer(value) {
    return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : null;
}

/**
 * Validate and expand a construction request into block positions.
 * @param {'block'|'line'|'plane'} kind
 * @param {string} type
 * @param {number[]} coords  [x,y,z] for a block, [x1,y1,z1,x2,y2,z2] otherwise
 * @returns {{ok:boolean, problems:string[], positions:{x,y,z}[], count:number}}
 */
export function expandBuildRequest(kind, type, coords, limits = CONSTRUCTION_LIMITS) {
    const problems = [];
    const reason = unbuildableReason(type, { allowDoors: kind === 'block' });
    if (reason) problems.push(reason);

    const expected = kind === 'block' ? 3 : 6;
    const values = (coords || []).map(integer);
    if (values.length !== expected || values.some(value => value === null)) {
        problems.push(`Expected ${expected} numeric coordinates.`);
        return { ok: false, problems, positions: [], count: 0 };
    }
    const first = { x: values[0], y: values[1], z: values[2] };
    const second = kind === 'block' ? first : { x: values[3], y: values[4], z: values[5] };
    for (const position of [first, second]) {
        if (position.y < MIN_Y || position.y > MAX_Y) {
            problems.push(`y=${position.y} is outside the world height (${MIN_Y} to ${MAX_Y}).`);
        }
    }
    if (problems.length) return { ok: false, problems, positions: [], count: 0 };

    const axes = ['x', 'y', 'z'];
    const spans = axes.map(axis => Math.abs(second[axis] - first[axis]) + 1);
    const varying = axes.filter((axis, index) => spans[index] > 1);

    if (kind === 'line' && varying.length > 1) {
        problems.push(`A line must be axis-aligned: only one of x, y, z may differ between the two points (they differ in ${varying.join(', ')}).`);
    }
    if (kind === 'plane' && varying.length > 2) {
        problems.push('A plane must be axis-aligned and flat: at least one of x, y, z must be the same at both corners. Build a box as several planes.');
    }
    if ((kind === 'line' || kind === 'plane') && varying.length <= (kind === 'line' ? 1 : 2)) {
        const total = spans.reduce((product, span) => product * span, 1);
        if (kind === 'line' && total > limits.maxLineLength) {
            problems.push(`A line may be at most ${limits.maxLineLength} blocks long (requested ${total}). Split it into several lines.`);
        }
        if (kind === 'plane') {
            if (Math.max(...spans) > limits.maxPlaneSide) {
                problems.push(`A plane side may be at most ${limits.maxPlaneSide} blocks (requested ${Math.max(...spans)}).`);
            }
            if (total > limits.maxPlaneBlocks) {
                problems.push(`A plane may contain at most ${limits.maxPlaneBlocks} blocks (requested ${total}). Split it into several planes.`);
            }
        }
    }
    if (problems.length) return { ok: false, problems, positions: [], count: 0 };

    const range = axis => {
        const step = second[axis] >= first[axis] ? 1 : -1;
        return Array.from({ length: Math.abs(second[axis] - first[axis]) + 1 }, (_, index) => first[axis] + index * step);
    };
    const positions = [];
    for (const x of range('x')) for (const y of range('y')) for (const z of range('z')) positions.push({ x, y, z });
    return { ok: true, problems: [], positions, count: positions.length };
}

// ---------------------------------------------------------------------------
// World reading
// ---------------------------------------------------------------------------

const OPENABLE = /(?<!iron)_door$|fence_gate$|(?<!iron)_trapdoor$/;

function isSolid(block) {
    if (!block) return false; // unloaded: assume open so a trap is never falsely reported
    if (OPENABLE.test(block.name)) return false; // can be opened to leave
    return block.boundingBox === 'block' && !REPLACEABLE.has(block.name);
}

function isSupport(block) {
    return Boolean(block) && block.boundingBox === 'block' && !REPLACEABLE.has(block.name);
}

function classifyTarget(bot, position, type) {
    const block = bot.blockAt(toVec(position));
    if (!block) return { state: 'unloaded', name: null };
    if (block.name === type) return { state: 'satisfied', name: block.name };
    if (REPLACEABLE.has(block.name)) return { state: 'open', name: block.name };
    if (block.name === 'lava') return { state: 'hazard', name: block.name };
    return { state: 'occupied', name: block.name };
}

// Neighbour offsets relative to the target block (the neighbour is the
// reference block; the placement face is the negated offset).
const FACES = [
    new Vec3(0, -1, 0), // neighbour below: place on its top face
    new Vec3(0, 1, 0),
    new Vec3(0, 0, -1),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(1, 0, 0),
];
const FACE_INDEX = new Map([['0,-1,0', 0], ['0,1,0', 1], ['0,0,-1', 2], ['0,0,1', 3], ['-1,0,0', 4], ['1,0,0', 5]]);

/**
 * Solid neighbours the target can be built off. `offset` is the neighbour's
 * position relative to the target; the placement face is its negation.
 * Support below is preferred, then the sides, then above.
 */
function supportOptions(bot, position) {
    const options = [];
    const order = [FACES[0], FACES[2], FACES[3], FACES[4], FACES[5], FACES[1]];
    for (const offset of order) {
        const reference = bot.blockAt(toVec(position).plus(offset));
        if (isSupport(reference)) {
            options.push({ reference, face: new Vec3(-offset.x, -offset.y, -offset.z) });
        }
    }
    return options;
}

function bodyOverlaps(bot, position) {
    const feet = bot.entity.position;
    const half = 0.3;
    const overlap = (min, max, low, high) => min < high && max > low;
    return overlap(feet.x - half, feet.x + half, position.x, position.x + 1) &&
        overlap(feet.z - half, feet.z + half, position.z, position.z + 1) &&
        overlap(feet.y, feet.y + 1.8, position.y, position.y + 1);
}

function canPlaceFromHere(bot, option, position) {
    if (bodyOverlaps(bot, position)) return false;
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const center = option.reference.position.offset(0.5, 0.5, 0.5).plus(option.face.scaled(0.5));
    const direction = center.minus(eye);
    const distance = direction.norm();
    if (distance > REACH) return false;
    if (typeof bot.world?.raycast === 'function' && distance > 0) {
        const hit = bot.world.raycast(eye, direction.normalize(), REACH + 1);
        if (!hit || !hit.position.equals(option.reference.position)) return false;
        const expectedFace = FACE_INDEX.get(`${option.face.x},${option.face.y},${option.face.z}`);
        if (typeof hit.face === 'number' && hit.face !== expectedFace) return false;
    }
    return true;
}

/**
 * Could the agent still walk out of wherever it stands? Bounded breadth-first
 * search over walkable cells (walk, step up one, drop up to three). Reaching a
 * wide area counts as "open". `extraSolid` simulates a block about to be placed.
 */
export function canEscape(bot, extraSolid = null) {
    const start = bot.entity.position.floored();
    const solid = position => {
        if (extraSolid && position.x === extraSolid.x && position.y === extraSolid.y && position.z === extraSolid.z) return true;
        return isSolid(bot.blockAt(position));
    };
    if (solid(start)) return true; // not standing in open space; nothing to judge
    const up = new Vec3(0, 1, 0);
    const down = new Vec3(0, -1, 0);
    const seen = new Set([key(start)]);
    const queue = [start];
    const horizontal = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    while (queue.length) {
        const current = queue.shift();
        if (seen.size > 250 || Math.abs(current.x - start.x) > 12 || Math.abs(current.z - start.z) > 12) return true;
        for (const delta of horizontal) {
            const next = current.plus(delta);
            let landing = null;
            if (!solid(next) && !solid(next.plus(up))) {
                landing = next;
                let drops = 0;
                while (!solid(landing.plus(down)) && drops <= 3) {
                    landing = landing.plus(down);
                    drops++;
                }
                if (drops > 3) landing = null; // a drop this deep is not an exit
            } else if (solid(next) && !solid(next.plus(up)) && !solid(next.plus(up).plus(up)) && !solid(current.plus(up).plus(up))) {
                landing = next.plus(up); // step up one block
            }
            if (landing && !seen.has(key(landing))) {
                seen.add(key(landing));
                queue.push(landing);
            }
        }
    }
    return false;
}

/** True when placing at `position` would newly seal the agent into a closed space. */
export function wouldTrapAgent(bot, position) {
    if (!canEscape(bot)) return false; // already enclosed; this placement is not the cause
    return !canEscape(bot, position);
}

// ---------------------------------------------------------------------------
// Movement (never digs, never scaffolds)
// ---------------------------------------------------------------------------

async function withTimeout(promise, milliseconds, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { onTimeout?.(); } catch (_error) { /* best effort */ }
            reject(new Error('navigation timed out'));
        }, milliseconds);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function defaultNavigate(bot, position, limits) {
    const movements = new pf.Movements(bot);
    movements.canDig = false;              // never break existing blocks to get somewhere
    movements.scafoldingBlocks = [];        // never place blocks to get somewhere
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowSprinting = false;
    bot.pathfinder.setMovements(movements);
    const goal = new pf.goals.GoalPlaceBlock(toVec(position), bot.world, { range: REACH });
    await withTimeout(bot.pathfinder.goto(goal), limits.navigateMillis, () => bot.pathfinder.stop());
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

function inventoryCount(bot, item) {
    return world.getInventoryCounts(bot)[item] || 0;
}

function doorIsPlaceable(bot, position) {
    // A door occupies two cells; the upper one must also be free.
    const above = bot.blockAt(toVec(position).offset(0, 1, 0));
    return !above || REPLACEABLE.has(above.name);
}

/** One verified placement attempt. Returns {placed:boolean, reason?:string}. */
async function attemptPlacement(bot, type, position, deps, limits) {
    const options = supportOptions(bot, position);
    if (options.length === 0) return { placed: false, reason: 'unsupported' };
    if (/_door$/.test(type)) {
        // Doors go on top of a solid block.
        const below = options.find(option => option.face.y === 1);
        if (!below || !doorIsPlaceable(bot, position)) return { placed: false, reason: 'unsupported' };
        options.splice(0, options.length, below);
    }

    let usable = options.find(option => canPlaceFromHere(bot, option, position));
    if (!usable) {
        try {
            await deps.navigate(bot, position, limits);
        } catch (error) {
            return { placed: false, reason: 'unreachable', detail: error.message };
        }
        if (bot.interrupt_code) return { placed: false, reason: 'interrupted' };
        usable = supportOptions(bot, position).find(option => canPlaceFromHere(bot, option, position));
        if (!usable) return { placed: false, reason: 'unreachable' };
    }

    if (wouldTrapAgent(bot, position)) return { placed: false, reason: 'would_trap' };

    const item = bot.inventory.items?.().find(entry => entry.name === type) ||
        bot.inventory.slots.find(slot => slot?.name === type);
    if (!item) return { placed: false, reason: 'missing_resource' };

    try {
        await bot.equip(item, 'hand');
        await bot.lookAt(usable.reference.position.offset(0.5, 0.5, 0.5).plus(usable.face.scaled(0.5)));
        await withTimeout(bot.placeBlock(usable.reference, usable.face), 3000);
    } catch (_error) {
        // mineflayer often throws although the block landed; the world decides.
    }
    for (let check = 0; check < 4; check++) {
        await waitTicks(bot, 2);
        if (bot.blockAt(toVec(position))?.name === type) return { placed: true };
    }
    return { placed: false, reason: 'placement_unverified' };
}

const BLOCK_PRIORITY = ['missing_resource', 'would_trap', 'unsupported', 'unreachable', 'occupied', 'hazard', 'unloaded', 'placement_unverified'];

/**
 * Build a set of positions with one block type.
 *
 * @param {object} bot
 * @param {{kind:string, type:string, positions:{x,y,z}[], request?:object}} spec
 * @param {{navigate?:Function, limits?:object}} [options] test/override hooks
 * @returns a verified report; see `summarizeConstruction`.
 */
export async function buildBlocks(bot, spec, options = {}) {
    const limits = { ...CONSTRUCTION_LIMITS, ...(options.limits || {}) };
    const deps = { navigate: options.navigate || defaultNavigate };
    const { kind, type, positions } = spec;
    const startedAt = Date.now();

    const report = {
        kind,
        type,
        request: spec.request || null,
        requestedBlocks: positions.length,
        satisfiedBefore: [],
        placed: [],
        remaining: [],
        beforeNames: {},
        required: 0,
        held: inventoryCount(bot, type),
        consumed: 0,
        stoppedBecause: null,
        trapRefusals: 0,
        complete: false,
        origin: {
            x: Math.floor(bot.entity.position.x),
            y: Math.floor(bot.entity.position.y),
            z: Math.floor(bot.entity.position.z),
        },
    };

    // Bounded navigation: refuse requests far from the agent.
    const here = bot.entity.position;
    const farthest = Math.max(...positions.map(position => Math.max(Math.hypot(position.x - here.x, position.z - here.z), Math.abs(position.y - here.y))));
    if (farthest > limits.maxDistance) {
        report.rejected = `The requested area is ${Math.round(farthest)} blocks away; construction is limited to ${limits.maxDistance} blocks from where you stand. Move closer first.`;
        report.remaining = positions.map(position => ({ ...position, reason: 'too_far' }));
        return finalizeReport(bot, report, positions, type);
    }

    // Initial classification. Existing identical blocks are reused; other
    // existing blocks are never replaced.
    const pending = [];
    const blocked = new Map();
    for (const position of positions) {
        const target = classifyTarget(bot, position, type);
        report.beforeNames[key(position)] = target.name;
        if (target.state === 'satisfied') {
            report.satisfiedBefore.push(plain(position));
        } else if (target.state === 'open') {
            pending.push({ position, attempts: 0 });
        } else {
            blocked.set(key(position), { reason: target.state, detail: target.name });
        }
    }
    report.required = pending.length;

    const attemptsLeft = new Map(pending.map(entry => [key(entry.position), limits.attemptsPerBlock]));
    let remainingPending = pending.map(entry => entry.position);

    const stop = reason => { report.stoppedBecause = report.stoppedBecause || reason; };

    while (remainingPending.length > 0) {
        if (bot.interrupt_code) { stop('interrupted'); break; }
        if (Date.now() - startedAt > limits.maxMillis) { stop('timeout'); break; }
        if (inventoryCount(bot, type) <= 0) {
            for (const position of remainingPending) blocked.set(key(position), { reason: 'missing_resource' });
            remainingPending = [];
            break;
        }

        // Only blocks that can be built off something right now are candidates;
        // placing them grows the frontier (walls rise from the ground, roofs
        // extend from the wall tops).
        const candidates = remainingPending.filter(position => supportOptions(bot, position).length > 0);
        if (candidates.length === 0) {
            for (const position of remainingPending) blocked.set(key(position), { reason: 'unsupported' });
            remainingPending = [];
            break;
        }
        const origin = bot.entity.position;
        candidates.sort((a, b) =>
            (a.y - b.y) ||
            (Math.hypot(a.x + 0.5 - origin.x, a.z + 0.5 - origin.z) - Math.hypot(b.x + 0.5 - origin.x, b.z + 0.5 - origin.z)));
        const next = candidates[0];

        // The block may have been filled in by something else meanwhile.
        const state = classifyTarget(bot, next, type);
        if (state.state === 'satisfied') {
            report.satisfiedBefore.push(plain(next));
            remainingPending = remainingPending.filter(position => key(position) !== key(next));
            continue;
        }
        if (state.state !== 'open') {
            blocked.set(key(next), { reason: state.state, detail: state.name });
            remainingPending = remainingPending.filter(position => key(position) !== key(next));
            continue;
        }

        const result = await attemptPlacement(bot, type, next, deps, limits);
        if (result.reason === 'interrupted') { stop('interrupted'); break; }
        if (result.placed) {
            remainingPending = remainingPending.filter(position => key(position) !== key(next));
            continue;
        }
        if (result.reason === 'would_trap') {
            // Skipped so the agent is not sealed in; never retried from here.
            report.trapRefusals++;
            blocked.set(key(next), { reason: 'would_trap' });
            remainingPending = remainingPending.filter(position => key(position) !== key(next));
            continue;
        }
        const left = (attemptsLeft.get(key(next)) || 1) - 1;
        attemptsLeft.set(key(next), left);
        if (left <= 0) {
            blocked.set(key(next), { reason: result.reason, detail: result.detail });
            remainingPending = remainingPending.filter(position => key(position) !== key(next));
        }
    }

    for (const position of remainingPending) {
        // Stopped early (interrupt/time): not blocked, just not done.
        if (!blocked.has(key(position))) blocked.set(key(position), { reason: report.stoppedBecause || 'not_attempted' });
    }
    report.blocked = blocked;
    return finalizeReport(bot, report, positions, type);
}

/** The verified truth: re-read the world and derive every number from it. */
function finalizeReport(bot, report, positions, type) {
    const blocked = report.blocked || new Map();
    const satisfiedBefore = new Set(report.satisfiedBefore.map(key));
    report.placed = [];
    report.satisfiedBefore = [];
    report.remaining = [];
    for (const position of positions) {
        const matches = bot.blockAt(toVec(position))?.name === type;
        const wasThere = satisfiedBefore.has(key(position));
        if (matches && wasThere) {
            report.satisfiedBefore.push(plain(position));
        } else if (matches) {
            report.placed.push(plain(position));
        } else {
            const entry = blocked.get(key(position)) || { reason: report.rejected ? 'too_far' : 'placement_unverified' };
            report.remaining.push({ ...plain(position), reason: entry.reason, detail: entry.detail || null });
        }
    }
    report.consumed = Math.max(0, report.held - inventoryCount(bot, type));
    report.complete = report.remaining.length === 0;
    report.blockedCounts = {};
    for (const entry of report.remaining) report.blockedCounts[entry.reason] = (report.blockedCounts[entry.reason] || 0) + 1;
    report.dominantReason = report.complete ? null
        : report.stoppedBecause === 'interrupted' ? 'interrupted'
            : report.stoppedBecause === 'timeout' ? 'timeout'
                : report.rejected ? 'too_far'
                    : BLOCK_PRIORITY.find(reason => report.blockedCounts[reason]) || Object.keys(report.blockedCounts)[0] || 'placement_unverified';
    delete report.blocked;
    report.summary = summarizeConstruction(report);
    log(bot, report.summary);
    return report;
}

const REASON_TEXT = {
    missing_resource: 'ran out of the block (gather more, then repeat the command to resume)',
    would_trap: 'refused because it would seal you into an enclosed space (leave an opening, or stand outside)',
    unsupported: 'nothing solid adjacent to build off (build from the ground or an existing structure)',
    unreachable: 'could not reach a valid place to stand without digging or scaffolding',
    occupied: 'already occupied by a different block (never replaced)',
    hazard: 'lava at the target',
    unloaded: 'area not loaded',
    placement_unverified: 'placement was not confirmed in the world',
    interrupted: 'interrupted before it was attempted',
    timeout: 'time budget ran out before it was attempted',
    too_far: 'too far away',
    not_attempted: 'not attempted',
};

function coordinate(position) {
    return `(${position.x}, ${position.y}, ${position.z})`;
}

export function summarizeConstruction(report) {
    const shape = report.request ? ` ${report.request}` : '';
    const lines = [
        `Construction of ${report.requestedBlocks} ${report.type} block${report.requestedBlocks === 1 ? '' : 's'}${shape}: ` +
        `${report.placed.length} verified placed, ${report.satisfiedBefore.length} already in place, ${report.remaining.length} remaining.`,
        `Materials: ${report.required} ${report.type} needed to place, ${report.held} held at start, ${report.consumed} consumed.`,
    ];
    if (report.remaining.length) {
        const byReason = Object.entries(report.blockedCounts)
            .map(([reason, count]) => `${count} ${REASON_TEXT[reason] || reason}`)
            .join('; ');
        const shown = report.remaining.slice(0, 5).map(entry => `${coordinate(entry)} ${entry.reason}${entry.detail ? ` (${entry.detail})` : ''}`).join(', ');
        lines.push(`Blocking reasons: ${byReason}.`);
        lines.push(`Remaining: ${shown}${report.remaining.length > 5 ? `, and ${report.remaining.length - 5} more` : ''}. Repeat the same command to resume; blocks already placed are skipped.`);
    }
    const hint = terrainHint(report);
    if (hint) lines.push(hint);
    if (report.rejected) lines.push(report.rejected);
    return lines.join(' ');
}

/**
 * When most blocked targets are already filled by other blocks (typically
 * natural terrain) the agent probably chose coordinates it never looked at.
 * Say so once, with its own position, instead of leaving it to guess again.
 */
function terrainHint(report) {
    if (report.complete || !report.remaining.length) return null;
    const terrain = report.remaining.filter(entry => ['occupied', 'unreachable', 'unsupported'].includes(entry.reason)).length;
    if (terrain * 2 < report.remaining.length) return null;
    const blockers = [...new Set(report.remaining.filter(entry => entry.reason === 'occupied' && entry.detail).map(entry => entry.detail))].slice(0, 3);
    const where = report.origin ? ` You are standing at (${report.origin.x}, ${report.origin.y}, ${report.origin.z}).` : '';
    const inside = blockers.length ? ` (${blockers.join(', ')})` : '';
    return `Hint: most of these targets are inside solid blocks${inside} or cannot be reached, so these coordinates were probably chosen without looking at the terrain.${where} ` +
        `Use !nearbyBlocks to see what is around you, then choose coordinates in open air that rest on solid ground; shifting the numbers slightly will not help.`;
}

// ---------------------------------------------------------------------------
// Public entry points used by the commands
// ---------------------------------------------------------------------------

export async function placeBlockAt(bot, type, x, y, z, options) {
    const expanded = expandBuildRequest('block', type, [x, y, z], { ...CONSTRUCTION_LIMITS, ...(options?.limits || {}) });
    if (!expanded.ok) return invalidReport('block', type, expanded.problems, bot);
    return buildBlocks(bot, { kind: 'block', type, positions: expanded.positions, request: `at ${coordinate(expanded.positions[0])}` }, options);
}

export async function buildLine(bot, type, x1, y1, z1, x2, y2, z2, options) {
    const limits = { ...CONSTRUCTION_LIMITS, ...(options?.limits || {}) };
    const expanded = expandBuildRequest('line', type, [x1, y1, z1, x2, y2, z2], limits);
    if (!expanded.ok) return invalidReport('line', type, expanded.problems, bot);
    const first = expanded.positions[0];
    const last = expanded.positions[expanded.positions.length - 1];
    return buildBlocks(bot, { kind: 'line', type, positions: expanded.positions, request: `line from ${coordinate(first)} to ${coordinate(last)}` }, options);
}

export async function buildPlane(bot, type, x1, y1, z1, x2, y2, z2, options) {
    const limits = { ...CONSTRUCTION_LIMITS, ...(options?.limits || {}) };
    const expanded = expandBuildRequest('plane', type, [x1, y1, z1, x2, y2, z2], limits);
    if (!expanded.ok) return invalidReport('plane', type, expanded.problems, bot);
    const first = expanded.positions[0];
    const last = expanded.positions[expanded.positions.length - 1];
    return buildBlocks(bot, { kind: 'plane', type, positions: expanded.positions, request: `plane from ${coordinate(first)} to ${coordinate(last)}` }, options);
}

/**
 * A plain-language look at the ground around the agent, built only from blocks
 * the bot can already see in its loaded chunks. It names what the requested
 * area actually contains and where flat, open, solid ground exists nearby, so a
 * model that has been guessing coordinates can stop guessing. It chooses
 * nothing for the agent.
 */
export function describeBuildSurroundings(bot, center = null, { horizontal = 10, below = 8, above = 4, spots = 3 } = {}) {
    const origin = bot.entity.position;
    const base = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
    const nameAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null;
    const lines = [];

    const underfoot = nameAt(base.x, base.y - 1, base.z);
    lines.push(`You are at (${base.x}, ${base.y}, ${base.z}), standing on ${underfoot ?? 'unloaded ground'}.`);
    if (center) {
        const target = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
        const inside = nameAt(target.x, target.y, target.z);
        lines.push(`The middle of the area you asked for, (${target.x}, ${target.y}, ${target.z}), is ${inside ?? 'not loaded'}.`);
    }

    const open = (x, y, z) => {
        const block = bot.blockAt(new Vec3(x, y, z));
        return Boolean(block) && block.name !== 'water' && REPLACEABLE.has(block.name);
    };
    const flatClearing = (x, y, z) => {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (!isSupport(bot.blockAt(new Vec3(x + dx, y - 1, z + dz)))) return false;
                if (!open(x + dx, y, z + dz) || !open(x + dx, y + 1, z + dz)) return false;
            }
        }
        return true;
    };

    const candidates = [];
    for (let dx = -horizontal; dx <= horizontal; dx++) {
        for (let dz = -horizontal; dz <= horizontal; dz++) {
            for (let dy = -below; dy <= above; dy++) {
                const x = base.x + dx, y = base.y + dy, z = base.z + dz;
                if (flatClearing(x, y, z)) candidates.push({ x, y, z, distance: Math.hypot(dx, dy, dz) });
            }
        }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const chosen = [];
    for (const candidate of candidates) {
        if (chosen.every(other => Math.hypot(other.x - candidate.x, other.z - candidate.z) >= 4 || Math.abs(other.y - candidate.y) >= 3)) chosen.push(candidate);
        if (chosen.length >= spots) break;
    }

    if (chosen.length) {
        const described = chosen.map(spot => `(${spot.x}, ${spot.y}, ${spot.z}) on ${nameAt(spot.x, spot.y - 1, spot.z)}`).join('; ');
        lines.push(`Open, flat 3x3 ground you could stand on nearby: ${described}. (The listed block is open air; the block below it is solid.)`);
    } else {
        lines.push(`No open, flat 3x3 ground within ${horizontal} blocks: you appear to be inside solid terrain or a cave. Moving to the surface or a larger open area would give you somewhere to build.`);
    }
    return lines.join(' ');
}

function invalidReport(kind, type, problems, bot) {
    const report = {
        kind, type, invalid: true, problems,
        requestedBlocks: 0, satisfiedBefore: [], placed: [], remaining: [], required: 0,
        held: 0, consumed: 0, complete: false, dominantReason: 'invalid_request', blockedCounts: {},
        summary: `Nothing was built: ${problems.join(' ')}`,
    };
    log(bot, report.summary);
    return report;
}
