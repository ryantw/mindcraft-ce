import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, held } from './helpers/construction_world.js';
import {
    buildLine,
    buildPlane,
    canEscape,
    expandBuildRequest,
    placeBlockAt,
    unbuildableReason,
} from '../src/agent/library/construction.js';

describe('request validation', () => {
    test('lines and planes are expanded from axis-aligned requests', () => {
        assert.equal(expandBuildRequest('line', 'oak_planks', [0, 64, 0, 4, 64, 0]).count, 5);
        assert.equal(expandBuildRequest('plane', 'oak_planks', [0, 64, 0, 4, 66, 0]).count, 15);
        assert.equal(expandBuildRequest('plane', 'oak_planks', [4, 66, 0, 0, 64, 0]).count, 15);
        assert.equal(expandBuildRequest('block', 'cobblestone', [3.9, 64.2, -1.1]).positions[0].x, 3);
    });

    test('diagonal lines, boxes, oversized and out-of-world requests are rejected', () => {
        assert.match(expandBuildRequest('line', 'stone', [0, 64, 0, 3, 64, 3]).problems.join(' '), /axis-aligned/);
        assert.match(expandBuildRequest('plane', 'stone', [0, 64, 0, 3, 66, 3]).problems.join(' '), /flat/);
        assert.match(expandBuildRequest('line', 'stone', [0, 64, 0, 40, 64, 0]).problems.join(' '), /at most 32 blocks long/);
        assert.match(expandBuildRequest('plane', 'stone', [0, 64, 0, 11, 64, 11]).problems.join(' '), /at most 100 blocks/);
        assert.match(expandBuildRequest('plane', 'stone', [0, 64, 0, 40, 64, 1]).problems.join(' '), /at most 32 blocks/);
        assert.match(expandBuildRequest('block', 'stone', [0, 500, 0]).problems.join(' '), /outside the world height/);
        assert.match(expandBuildRequest('block', 'stone', [0, 64]).problems.join(' '), /3 numeric coordinates/);
    });

    test('only full solid blocks are built; removal, liquids, gravity blocks and special blocks are refused', () => {
        for (const type of ['oak_planks', 'cobblestone', 'oak_log', 'glass', 'dirt']) assert.equal(unbuildableReason(type), null, type);
        assert.match(unbuildableReason('air'), /Removing blocks/);
        assert.match(unbuildableReason('water'), /Liquids/);
        assert.match(unbuildableReason('sand'), /falls/);
        assert.match(unbuildableReason('tnt'), /cannot be placed/);
        assert.match(unbuildableReason('oak_slab'), /not a full solid block/);
        assert.match(unbuildableReason('not_a_block'), /not a block/);
        // Doors only as single blocks.
        assert.equal(unbuildableReason('oak_door', { allowDoors: true }), null);
        assert.match(expandBuildRequest('line', 'oak_door', [0, 64, 0, 2, 64, 0]).problems.join(' '), /not a full solid block/);
    });
});

describe('placeBlockAt', () => {
    test('places one block on solid ground and verifies the target', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 } });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 64, 0, { navigate: world.navigate });

        assert.equal(report.complete, true);
        assert.deepEqual(report.placed, [{ x: 2, y: 64, z: 0 }]);
        assert.equal(report.consumed, 1);
        assert.equal(held(world, 'oak_planks'), 4);
        assert.equal(world.nameAt(2, 64, 0), 'oak_planks');
        assert.equal(world.log.forbidden, 0);
        assert.match(report.summary, /1 verified placed, 0 already in place, 0 remaining/);
    });

    test('a call that resolves without placing anything is not success', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, placement: { silent: () => true } });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 64, 0, { navigate: world.navigate });

        assert.equal(report.complete, false);
        assert.equal(report.placed.length, 0);
        assert.equal(report.dominantReason, 'placement_unverified');
        assert.equal(report.remaining[0].reason, 'placement_unverified');
        assert.equal(world.log.placements.length, 2); // bounded retry, then stop
    });

    test('a call that throws but whose block landed is verified as placed', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, placement: { throws: () => true } });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 64, 0, { navigate: world.navigate });
        assert.equal(report.complete, true);
        assert.equal(report.placed.length, 1);
    });

    test('an occupied target is reported and never replaced or broken', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, blocks: [['cobblestone', 2, 64, 0]] });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 64, 0, { navigate: world.navigate });

        assert.equal(report.complete, false);
        assert.equal(report.dominantReason, 'occupied');
        assert.equal(report.remaining[0].detail, 'cobblestone');
        assert.equal(world.nameAt(2, 64, 0), 'cobblestone');
        assert.equal(world.log.placements.length, 0);
        assert.equal(world.log.forbidden, 0);
        assert.equal(held(world, 'oak_planks'), 5);
    });

    test('a block already in place counts as satisfied and consumes nothing', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 }, blocks: [['oak_planks', 2, 64, 0]] });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 64, 0, { navigate: world.navigate });
        assert.equal(report.complete, true);
        assert.equal(report.placed.length, 0);
        assert.equal(report.satisfiedBefore.length, 1);
        assert.equal(report.consumed, 0);
        assert.equal(world.log.placements.length, 0);
    });

    test('nothing is placed without solid support, and nothing is scaffolded', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 } });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 70, 0, { navigate: world.navigate });
        assert.equal(report.dominantReason, 'unsupported');
        assert.equal(world.log.placements.length, 0);
        assert.equal(world.nameAt(2, 69, 0), 'air');
    });

    test('materials are required and missing ones are reported with the shortfall', async () => {
        const world = createWorld({ inventory: {} });
        const report = await placeBlockAt(world.bot, 'oak_planks', 2, 64, 0, { navigate: world.navigate });
        assert.equal(report.dominantReason, 'missing_resource');
        assert.equal(report.held, 0);
        assert.equal(report.required, 1);
    });

    test('an out-of-reach target is walked to using the supplied navigation', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 } });
        const report = await placeBlockAt(world.bot, 'oak_planks', 20, 64, 20, { navigate: world.navigate });
        assert.equal(report.complete, true);
        assert.equal(world.log.navigations, 1);
    });

    test('an unreachable target fails after bounded attempts without digging', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 } });
        const navigate = async () => { world.log.navigations++; throw new Error('No path'); };
        const report = await placeBlockAt(world.bot, 'oak_planks', 20, 64, 20, { navigate });
        assert.equal(report.complete, false);
        assert.equal(report.dominantReason, 'unreachable');
        assert.equal(world.log.navigations, 2);
        assert.equal(world.log.forbidden, 0);
        assert.equal(held(world, 'oak_planks'), 5);
    });

    test('a target beyond the navigation bound is rejected up front', async () => {
        const world = createWorld({ inventory: { oak_planks: 5 } });
        const report = await placeBlockAt(world.bot, 'oak_planks', 200, 64, 0, { navigate: world.navigate });
        assert.equal(report.dominantReason, 'too_far');
        assert.match(report.summary, /limited to 48 blocks/);
        assert.equal(world.log.navigations, 0);
    });

    test('invalid block types change nothing', async () => {
        const world = createWorld({ inventory: { oak_slab: 5 } });
        const report = await placeBlockAt(world.bot, 'oak_slab', 2, 64, 0, { navigate: world.navigate });
        assert.equal(report.invalid, true);
        assert.equal(world.log.placements.length, 0);
    });
});

describe('buildLine', () => {
    test('builds a short line, reusing a block that is already in place', async () => {
        const world = createWorld({ inventory: { oak_planks: 10 }, blocks: [['oak_planks', 4, 64, 0]] });
        const report = await buildLine(world.bot, 'oak_planks', 2, 64, 0, 6, 64, 0, { navigate: world.navigate });

        assert.equal(report.complete, true);
        assert.equal(report.placed.length, 4);
        assert.equal(report.satisfiedBefore.length, 1);
        assert.equal(report.required, 4);
        assert.equal(report.consumed, 4);
        assert.equal(held(world, 'oak_planks'), 6);
        for (let x = 2; x <= 6; x++) assert.equal(world.nameAt(x, 64, 0), 'oak_planks');
    });

    test('a vertical pillar rises from the ground, each block supported by the last', async () => {
        const world = createWorld({ inventory: { cobblestone: 10 } });
        const report = await buildLine(world.bot, 'cobblestone', 3, 64, 3, 3, 68, 3, { navigate: world.navigate });
        assert.equal(report.complete, true);
        assert.deepEqual(world.log.placements.map(entry => entry.y), [64, 65, 66, 67, 68]);
    });

    test('existing different blocks in the line are left alone and reported', async () => {
        const world = createWorld({ inventory: { oak_planks: 10 }, blocks: [['dirt', 4, 64, 0]] });
        const report = await buildLine(world.bot, 'oak_planks', 2, 64, 0, 6, 64, 0, { navigate: world.navigate });
        assert.equal(report.complete, false);
        assert.equal(report.placed.length, 4);
        assert.equal(report.dominantReason, 'occupied');
        assert.equal(world.nameAt(4, 64, 0), 'dirt');
        assert.deepEqual(report.remaining.map(entry => [entry.x, entry.reason]), [[4, 'occupied']]);
    });
});

describe('buildPlane', () => {
    test('builds a small wall bottom-up with every block verified', async () => {
        const world = createWorld({ inventory: { oak_planks: 20 } });
        const report = await buildPlane(world.bot, 'oak_planks', 0, 64, 5, 4, 66, 5, { navigate: world.navigate });

        assert.equal(report.complete, true);
        assert.equal(report.placed.length, 15);
        assert.equal(report.consumed, 15);
        assert.equal(held(world, 'oak_planks'), 5);
        const heights = world.log.placements.map(entry => entry.y);
        assert.deepEqual(heights, [...heights].sort((a, b) => a - b), 'rows are built bottom-up');
        for (let x = 0; x <= 4; x++) for (let y = 64; y <= 66; y++) assert.equal(world.nameAt(x, y, 5), 'oak_planks');
        assert.equal(world.log.forbidden, 0);
    });

    test('insufficient materials give verified partial progress, and the same command resumes', async () => {
        const world = createWorld({ inventory: { oak_planks: 6 } });
        const first = await buildPlane(world.bot, 'oak_planks', 0, 64, 5, 4, 66, 5, { navigate: world.navigate });

        assert.equal(first.complete, false);
        assert.equal(first.placed.length, 6);
        assert.equal(first.remaining.length, 9);
        assert.equal(first.required, 15);
        assert.equal(first.held, 6);
        assert.equal(first.dominantReason, 'missing_resource');
        assert.match(first.summary, /Blocking reasons: 9 ran out of the block/);

        world.give('oak_planks', 20);
        const second = await buildPlane(world.bot, 'oak_planks', 0, 64, 5, 4, 66, 5, { navigate: world.navigate });
        assert.equal(second.complete, true);
        assert.equal(second.satisfiedBefore.length, 6);
        assert.equal(second.placed.length, 9);
        assert.equal(second.consumed, 9);
    });

    test('cancellation stops promptly with truthful partial progress, then resumes', async () => {
        const world = createWorld({
            inventory: { oak_planks: 20 },
            placement: { onPlace: (attempt, bot) => { if (attempt === 3) bot.interrupt_code = true; } },
        });
        const first = await buildPlane(world.bot, 'oak_planks', 0, 64, 5, 4, 64, 5, { navigate: world.navigate });

        assert.equal(first.stoppedBecause, 'interrupted');
        assert.equal(first.dominantReason, 'interrupted');
        assert.equal(first.placed.length, 3);
        assert.equal(first.remaining.length, 2);
        assert.equal(world.log.placements.length, 3);

        world.bot.interrupt_code = false;
        const second = await buildPlane(world.bot, 'oak_planks', 0, 64, 5, 4, 64, 5, { navigate: world.navigate });
        assert.equal(second.complete, true);
        assert.equal(second.placed.length, 2);
        assert.equal(second.satisfiedBefore.length, 3);
    });

    test('a floating plane with nothing to build off places nothing', async () => {
        const world = createWorld({ inventory: { oak_planks: 20 } });
        const report = await buildPlane(world.bot, 'oak_planks', 0, 70, 0, 3, 70, 3, { navigate: world.navigate });
        assert.equal(report.dominantReason, 'unsupported');
        assert.equal(report.placed.length, 0);
        assert.equal(world.log.placements.length, 0);
    });

    test('a floor extends outward from solid ground; a roof grows from the wall tops', async () => {
        const walls = [];
        for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) {
            if (x === 0 || x === 4 || z === 0 || z === 4) for (const y of [64, 65]) walls.push(['cobblestone', x, y, z]);
        }
        const world = createWorld({ inventory: { oak_planks: 40 }, blocks: walls, position: [10.5, 64, 10.5] });
        const report = await buildPlane(world.bot, 'oak_planks', 0, 66, 0, 4, 66, 4, { navigate: world.navigate });
        assert.equal(report.complete, true);
        assert.equal(report.placed.length, 25);
    });

    test('limits are enforced before anything is touched', async () => {
        const world = createWorld({ inventory: { oak_planks: 500 } });
        const report = await buildPlane(world.bot, 'oak_planks', 0, 64, 0, 20, 64, 20, { navigate: world.navigate });
        assert.equal(report.invalid, true);
        assert.match(report.summary, /at most 100 blocks/);
        assert.equal(world.log.placements.length, 0);
    });

    test('the time budget bounds a request and reports what was not attempted', async () => {
        const world = createWorld({ inventory: { oak_planks: 20 } });
        const report = await buildPlane(world.bot, 'oak_planks', 0, 64, 5, 4, 64, 5, { navigate: world.navigate, limits: { maxMillis: -1 } });
        assert.equal(report.stoppedBecause, 'timeout');
        assert.equal(report.placed.length, 0);
        assert.equal(report.dominantReason, 'timeout');
    });
});

describe('construction cannot trap the agent', () => {
    function walledRoom({ gap = true } = {}) {
        const blocks = [];
        for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) {
            if (x !== 0 && x !== 4 && z !== 0 && z !== 4) continue;
            for (const y of [64, 65]) {
                if (gap && x === 2 && z === 0) continue; // doorway
                blocks.push(['cobblestone', x, y, z]);
            }
        }
        return blocks;
    }

    test('escape analysis: open doorway is an exit, a sealed room is not', () => {
        const open = createWorld({ blocks: walledRoom({ gap: true }), position: [2.5, 64, 2.5] });
        const sealed = createWorld({ blocks: walledRoom({ gap: false }), position: [2.5, 64, 2.5] });
        assert.equal(canEscape(open.bot), true);
        assert.equal(canEscape(sealed.bot), false);
    });

    test('the placement that would seal the agent inside is refused and the block stays empty', async () => {
        const world = createWorld({
            blocks: walledRoom({ gap: true }),
            inventory: { cobblestone: 10 },
            position: [2.5, 64, 2.5],
        });
        // Closing the lower doorway block still leaves a step-over exit.
        const lower = await placeBlockAt(world.bot, 'cobblestone', 2, 64, 0, { navigate: world.navigate });
        assert.equal(lower.complete, true);

        // Closing the upper block would seal the agent in.
        const upper = await placeBlockAt(world.bot, 'cobblestone', 2, 65, 0, { navigate: world.navigate });
        assert.equal(upper.complete, false);
        assert.equal(upper.dominantReason, 'would_trap');
        assert.equal(upper.trapRefusals, 1);
        assert.equal(world.nameAt(2, 65, 0), 'air');
        assert.equal(held(world, 'cobblestone'), 9);
        assert.match(upper.summary, /seal you into an enclosed space/);
    });

    test('the same placement from outside is allowed', async () => {
        const world = createWorld({
            blocks: walledRoom({ gap: true }),
            inventory: { cobblestone: 10 },
            position: [2.5, 64, -2.5],
        });
        const lower = await placeBlockAt(world.bot, 'cobblestone', 2, 64, 0, { navigate: world.navigate });
        const upper = await placeBlockAt(world.bot, 'cobblestone', 2, 65, 0, { navigate: world.navigate });
        assert.equal(lower.complete, true);
        assert.equal(upper.complete, true);
    });

    test('a plane that would close the last exit leaves exactly that block unplaced', async () => {
        const world = createWorld({
            blocks: walledRoom({ gap: true }),
            inventory: { cobblestone: 10 },
            position: [2.5, 64, 2.5],
        });
        const report = await buildPlane(world.bot, 'cobblestone', 2, 64, 0, 2, 65, 0, { navigate: world.navigate });
        assert.equal(report.placed.length, 1);
        assert.deepEqual(report.remaining.map(entry => [entry.y, entry.reason]), [[65, 'would_trap']]);
    });

    test('an agent that is already enclosed is not blamed for further placements', async () => {
        const world = createWorld({
            blocks: walledRoom({ gap: false }),
            inventory: { cobblestone: 10 },
            position: [2.5, 64, 2.5],
        });
        const report = await placeBlockAt(world.bot, 'cobblestone', 1, 64, 1, { navigate: world.navigate });
        // The agent's own cell neighbour: placement is judged on its own merits.
        assert.notEqual(report.dominantReason, 'would_trap');
    });

    test('the agent never places a block into its own body', async () => {
        const world = createWorld({ inventory: { cobblestone: 5 }, position: [2.5, 64, 2.5] });
        const report = await placeBlockAt(world.bot, 'cobblestone', 2, 64, 2, { navigate: world.navigate });
        // Own cell: must step aside first, then place.
        assert.equal(world.log.navigations >= 1, true);
        assert.equal(report.complete, true);
        const feet = world.bot.entity.position;
        assert.ok(!(Math.floor(feet.x) === 2 && Math.floor(feet.z) === 2 && Math.floor(feet.y) === 64));
    });
});
