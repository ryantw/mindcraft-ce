import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/construction_world.js';
import { buildLine, describeBuildSurroundings } from '../src/agent/library/construction.js';
import { ConstructionAreaGuard, constructionTargetCenter } from '../src/agent/construction_area.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { createActionOutcome, inventorySnapshot } from '../src/agent/action_outcome.js';

function terrainFailure(params, extras = {}) {
    return {
        action: 'buildLine',
        params,
        status: 'failure',
        relevantProgress: false,
        evidence: { construction: { blockedCounts: extras.blockedCounts || { occupied: 4 } } },
    };
}

const line = (x, y, z) => ({ type: 'cobblestone', x1: x, y1: y, z1: z, x2: x, y2: y, z2: z + 4 });

describe('terrain hint in construction reports', () => {
    test('targets inside solid terrain explain themselves, with the agent position and a way to look', async () => {
        const world = createWorld({ inventory: { cobblestone: 20 }, position: [10.5, 64, 10.5] });
        // y <= 63 is solid stone in the scripted world.
        const report = await buildLine(world.bot, 'cobblestone', 10, 60, 12, 10, 60, 16, { navigate: world.navigate });
        assert.equal(report.complete, false);
        assert.match(report.summary, /Hint: most of these targets are inside solid blocks \(stone\)/);
        assert.match(report.summary, /standing at \(10, 64, 10\)/);
        assert.match(report.summary, /!nearbyBlocks/);
        assert.equal(world.log.forbidden, 0, 'no digging, chat or creative shortcuts');
    });

    test('no hint when the build succeeds, or when failure is not about terrain', async () => {
        const ok = createWorld({ inventory: { cobblestone: 20 } });
        const done = await buildLine(ok.bot, 'cobblestone', 2, 64, 0, 4, 64, 0, { navigate: ok.navigate });
        assert.equal(done.complete, true);
        assert.doesNotMatch(done.summary, /Hint:/);

        const poor = createWorld({ inventory: { cobblestone: 1 } });
        const short = await buildLine(poor.bot, 'cobblestone', 2, 64, 0, 6, 64, 0, { navigate: poor.navigate });
        assert.equal(short.complete, false);
        assert.doesNotMatch(short.summary, /Hint:/);
    });
});

describe('ConstructionAreaGuard', () => {
    const origin = { x: 1185, y: 49, z: 669 };

    test('target centre is derived for each construction command', () => {
        assert.deepEqual(constructionTargetCenter('placeBlockAt', { x: 4, y: 5, z: 6 }), { x: 4, y: 5, z: 6 });
        assert.deepEqual(constructionTargetCenter('buildLine', { x1: 0, y1: 0, z1: 0, x2: 4, y2: 0, z2: 0 }), { x: 2, y: 0, z: 0 });
        assert.equal(constructionTargetCenter('collectBlocks', {}), null);
        assert.equal(constructionTargetCenter('placeBlockAt', { x: 'a', y: 1, z: 2 }), null);
    });

    test('shifting coordinates after repeated terrain failures is declined, with a way forward', () => {
        const guard = new ConstructionAreaGuard();
        guard.record(terrainFailure(line(1185, 49, 669)), origin);
        assert.equal(guard.check('buildLine', line(1186, 49, 669), origin), null, 'one failure is not a pattern');
        guard.record(terrainFailure(line(1186, 49, 669)), origin);

        const block = guard.check('buildLine', line(1188, 45, 670), origin);
        assert.equal(block.condition, 'construction_area');
        assert.match(block.reason, /2 recent construction attempts/);
        assert.match(block.prerequisites.join(' '), /open air that rest on solid ground/);
        assert.ok(guard.check('placeBlockAt', { type: 'cobblestone', x: 1187, y: 50, z: 671 }, origin), 'applies to every construction command');
    });

    test('other areas, other actions, and failures that are not about terrain are unaffected', () => {
        const guard = new ConstructionAreaGuard();
        guard.record(terrainFailure(line(1185, 49, 669)), origin);
        guard.record(terrainFailure(line(1186, 49, 669)), origin);
        assert.equal(guard.check('buildLine', line(1185, 49, 700), origin), null, 'a different area is fine');
        assert.equal(guard.check('collectBlocks', { type: 'stone', num: 3 }, origin), null);

        const distance = new ConstructionAreaGuard();
        distance.record(terrainFailure(line(0, 64, 0), { blockedCounts: { too_far: 5 } }), origin);
        distance.record(terrainFailure(line(1, 64, 0), { blockedCounts: { missing_resource: 5 } }), origin);
        distance.record(terrainFailure(line(2, 64, 0), { blockedCounts: { too_far: 2, occupied: 1 } }), origin);
        assert.equal(distance.check('buildLine', line(1, 64, 0), origin), null);
    });

    test('verified progress, time and walking away all release the area', () => {
        let clock = 0;
        const guard = new ConstructionAreaGuard({ now: () => clock });
        const fail = () => {
            guard.record(terrainFailure(line(1185, 49, 669)), origin);
            guard.record(terrainFailure(line(1186, 49, 669)), origin);
        };

        fail();
        assert.ok(guard.check('buildLine', line(1187, 49, 669), origin));
        guard.record({ action: 'buildLine', params: line(1186, 49, 670), status: 'partial', relevantProgress: true }, origin);
        assert.equal(guard.check('buildLine', line(1187, 49, 669), origin), null, 'progress nearby clears it');

        fail();
        assert.ok(guard.check('buildLine', line(1187, 49, 669), origin));
        clock += 4 * 60 * 1000;
        assert.equal(guard.check('buildLine', line(1187, 49, 669), origin), null, 'evidence ages out');

        clock = 0;
        fail();
        assert.equal(guard.check('buildLine', line(1187, 49, 669), { x: 1185, y: 49, z: 700 }), null, 'a new vantage point resets it');
    });
});

describe('ActionManager integration', () => {
    function manager() {
        const world = createWorld({ inventory: { cobblestone: 50 }, position: [1185.5, 64, 669.5] });
        const agent = { name: 'Finn', bot: world.bot };
        return { manager: new ActionManager(agent), world };
    }

    function failedBuild(world, params, blockedCounts = { occupied: 5 }) {
        const snapshot = inventorySnapshot(world.bot);
        return createActionOutcome({
            action: 'buildLine',
            params,
            status: 'failure',
            before: snapshot,
            after: snapshot,
            reason: { code: 'occupied_target', message: 'occupied', prerequisites: [], condition: 'state_changed' },
            retryableWithoutStateChange: false,
            relevantProgress: false,
            details: { construction: { blockedCounts, summary: 'x' } },
            bot: world.bot,
        });
    }

    test('the third guess in the same rock is declined even though its coordinates are new', () => {
        const { manager: actions, world } = manager();
        const attempts = [line(1185, 49, 669), line(1186, 49, 669), line(1187, 45, 670)];

        for (const [index, params] of attempts.entries()) {
            const before = actions.retryBlock('buildLine', params);
            if (index < 2) assert.equal(before, null, `attempt ${index + 1} is allowed`);
            actions.recordOutcome(failedBuild(world, params));
        }

        const block = actions.retryBlock('buildLine', line(1184, 38, 670));
        assert.equal(block?.condition, 'construction_area');
        assert.equal(actions.retryBlock('buildLine', line(1185, 49, 800)), null, 'a distant area is still open');
    });
});


describe('describeBuildSurroundings', () => {
    test('reports position, the block at the requested centre, and nearby open flat ground', () => {
        const world = createWorld({ position: [10.5, 64, 10.5] });
        const text = describeBuildSurroundings(world.bot, { x: 10, y: 60, z: 12 });
        assert.match(text, /You are at \(10, 64, 10\), standing on stone\./);
        assert.match(text, /\(10, 60, 12\), is stone\./);
        assert.match(text, /Open, flat 3x3 ground you could stand on nearby: \(\d+, 64, \d+\) on stone/);
        const spots = text.match(/\(\d+, 64, \d+\) on stone/g);
        assert.ok(spots.length >= 1 && spots.length <= 3);
    });

    test('says so plainly when the agent is enclosed in terrain', () => {
        const blocks = [];
        for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) for (let y = 64; y <= 72; y++) {
            if (!(x === 0 && z === 0 && y <= 65)) blocks.push(['stone', x, y, z]);
        }
        const world = createWorld({ position: [0.5, 64, 0.5], blocks });
        const text = describeBuildSurroundings(world.bot, null);
        assert.match(text, /No open, flat 3x3 ground within 10 blocks/);
        assert.doesNotMatch(text, /Open, flat/);
    });

    test('water is not offered as somewhere to stand, and unloaded terrain is reported honestly', () => {
        const blocks = [];
        for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) blocks.push(['water', x, 64, z], ['water', x, 65, z]);
        const world = createWorld({ position: [0.5, 64, 0.5], blocks });
        assert.match(describeBuildSurroundings(world.bot, null), /No open, flat 3x3 ground/);

        world.bot.blockAt = () => null;
        assert.match(describeBuildSurroundings(world.bot, { x: 0, y: 0, z: 0 }), /not loaded/);
    });

    test('the guard carries the snapshot, and a failing snapshot never breaks the block', () => {
        const guard = new ConstructionAreaGuard();
        const origin = { x: 0, y: 64, z: 0 };
        guard.record(terrainFailure(line(0, 49, 0)), origin);
        guard.record(terrainFailure(line(1, 49, 0)), origin);
        assert.equal(guard.check('buildLine', line(2, 49, 0), origin, () => 'SNAPSHOT').context, 'SNAPSHOT');
        const broken = guard.check('buildLine', line(2, 49, 0), origin, () => { throw new Error('boom'); });
        assert.equal(broken.condition, 'construction_area');
        assert.equal(broken.context, '');
    });
});
