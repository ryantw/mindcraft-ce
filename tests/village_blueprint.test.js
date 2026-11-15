import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { ScenarioError } from '../src/village/errors.js';
import {
    assessSite,
    chestStacks,
    planCommands,
    planVillage,
    rotateFacing,
    rotateLocal,
    routeWalkable,
} from '../src/village/blueprint.js';
import { datapackFiles, placementFunction } from '../src/village/placement.js';
import { assertProvisionTarget } from '../src/village/target.js';

const PROVISIONS = {
    refill: 'never',
    public_chest: [{ item: 'wheat_seeds', count: 16 }, { item: 'bread', count: 8 }],
    per_home: {
        food: [{ item: 'bread', count: 24 }, { item: 'cooked_beef', count: 16 }],
        tools: ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword'],
        armor: ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'],
        materials: [{ item: 'oak_log', count: 32 }, { item: 'torch', count: 16 }],
        personal_cycle: ['clock', 'fishing_rod', 'shears', 'flower_pot', 'book'],
        also: ['crafting_table', 'furnace', 'white_bed'],
        vacant_chest: [],
    },
};

function plots(occupied, vacant) {
    const homes = [];
    for (let index = 0; index < occupied; index++) {
        homes.push({ id: `plot-p${index}`, occupant: `p${index}` });
    }
    for (let index = 0; index < vacant; index++) {
        homes.push({ id: `plot-vacant-${index}`, occupant: null });
    }
    return homes;
}

test('rotation keeps the door aimed at the requested side', () => {
    assert.deepEqual(rotateLocal(0, 1, 'east'), [1, 0]);
    assert.deepEqual(rotateLocal(0, 1, 'north'), [0, -1]);
    assert.equal(rotateFacing('south', 'east'), 'east');
    assert.equal(rotateFacing('north', 'north'), 'south');
});

test('a flat dry site is accepted and a slope or water is not', () => {
    const flat = Array.from({ length: 16 }, (_, index) => ({ height: 70 + (index % 2), water: false }));
    assert.equal(assessSite(flat).ok, true);
    assert.equal(assessSite(flat).floorY, 70);
    const wet = flat.map((sample, index) => ({ ...sample, water: index === 3 }));
    assert.equal(assessSite(wet).ok, false);
    const steep = flat.map((sample, index) => ({ ...sample, height: index === 0 ? 80 : 70 }));
    assert.equal(assessSite(steep).reason, 'slope');
});

test('plans for one and eight homes do not overlap, stock only occupied chests, and reach the square', () => {
    for (const [occupied, vacant] of [[1, 0], [5, 3]]) {
        const plan = planVillage({
            plots: plots(occupied, vacant),
            provisions: PROVISIONS,
            origin: { x: 1000, z: -200 },
            floorY: 72,
        });
        assert.equal(plan.plots.length, occupied + vacant);
        const columns = new Map();
        for (const plot of plan.plots) {
            const [x, , z] = plot.home_marker;
            const key = `${x},${z}`;
            assert.equal(columns.has(key), false);
            columns.set(key, plot.id);
            const route = routeWalkable(plan.blocks, plot.home_marker, plan.publicPlaces[0].marker, plan.floorY);
            assert.ok(route, `${plot.id} cannot walk to the square`);
            assert.ok(route.length < 80);
        }
        const homeChests = plan.chests.slice(0, plan.plots.length);
        const occupiedChests = homeChests.filter(chest => chest.stacks.some(stack => stack.item === 'bread'));
        const empty = homeChests.filter(chest => chest.stacks.length === 0);
        assert.equal(occupiedChests.length, occupied);
        assert.equal(empty.length, vacant);
        assert.equal(chestStacks(plan.plots[0], PROVISIONS, 0)[0].item, 'bread');
        if (vacant) assert.deepEqual(chestStacks(plan.plots.at(-1), PROVISIONS, 7), []);
    }
});

test('the planner and placement function are not tied to the sample inhabitants', () => {
    const source = [
        'src/village/blueprint.js',
        'src/village/placement.js',
        'src/village/target.js',
    ].map(file => readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(source, /Ione|Cass|Rufus|Nell|Bram/);
    const text = placementFunction([
        { name: 'Ada', home_marker: [1, 65, 2], bed: [3, 65, 2] },
    ]);
    assert.match(text, /name=Ada,tag=!village_placed/);
    assert.match(text, /spawnpoint @s 3 65 2/);
    assert.doesNotMatch(text, /item replace|give |chest/);
    const files = datapackFiles([{ name: 'Ada', home_marker: [1, 65, 2], bed: [3, 65, 2] }]);
    assert.match(files['pack.mcmeta'], /"pack_format": 80/);
    assert.throws(() => placementFunction([{ name: 'A', home_marker: [0, 0, 0], bed: [0, 0, 0] }]), ScenarioError);
});

test('provisioning refuses the survival port, container, world directory, and public binds', () => {
    const survival = { scenarioPort: 25566, survivalPort: 25565, dataDir: '/tmp/village-data', survivalDataDir: '/home/ryan/minecraft/minecraft-data', containerName: 'village-alpha', publishedPorts: [
        { hostIp: '127.0.0.1', hostPort: 25566, containerPort: 25565 },
        { hostIp: '127.0.0.1', hostPort: 25576, containerPort: 25575 },
    ] };
    assert.equal(assertProvisionTarget(survival).gamePort, 25566);
    assert.throws(() => assertProvisionTarget({ ...survival, scenarioPort: 25565 }), /survival server port/);
    assert.throws(() => assertProvisionTarget({ ...survival, containerName: 'ai-village' }), /ai-village/);
    assert.throws(() => assertProvisionTarget({ ...survival, dataDir: '/home/ryan/minecraft/minecraft-data/world' }), /survival world/);
    assert.throws(() => assertProvisionTarget({
        ...survival,
        publishedPorts: [{ hostIp: '0.0.0.0', hostPort: 25566, containerPort: 25565 }],
    }), /127\.0\.0\.1/);
});

test('commands carry the manifest counts and do not run during ordinary startup', () => {
    const plan = planVillage({ plots: plots(1, 1), provisions: PROVISIONS, origin: { x: 0, z: 0 }, floorY: 64 });
    const commands = planCommands(plan);
    assert.ok(commands.fills.some(line => line.includes('minecraft:white_bed')));
    assert.ok(commands.items.some(line => line.includes('minecraft:bread 24')));
    assert.ok(commands.items.some(line => line.includes('container.0')));
    assert.equal(commands.items.filter(line => line.includes('minecraft:bread')).length, 2);
    assert.ok(commands.rules.some(line => line === 'gamerule showDeathMessages false'));
    assert.equal(commands.summons.length, 7);
});
