import { ScenarioError } from './errors.js';

const CLOCK = ['north', 'east', 'south', 'west'];
const STYLES = [
    { wall: 'oak_planks', log: 'oak_log', roof: 'spruce_planks', roofStair: 'spruce_stairs', bed: 'white_bed', door: 'oak_door', foundation: 'cobblestone' },
    { wall: 'spruce_planks', log: 'spruce_log', roof: 'dark_oak_planks', roofStair: 'dark_oak_stairs', bed: 'blue_bed', door: 'spruce_door', foundation: 'cobblestone' },
    { wall: 'birch_planks', log: 'birch_log', roof: 'oak_planks', roofStair: 'oak_stairs', bed: 'yellow_bed', door: 'birch_door', foundation: 'stone_bricks' },
    { wall: 'stone_bricks', log: 'stripped_oak_log', roof: 'bricks', roofStair: 'brick_stairs', bed: 'red_bed', door: 'dark_oak_door', foundation: 'stone_bricks' },
];
const FLOWERS = ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'allium'];
const COTTAGE_ANGLES = [0, 40, 120, 160, 200, 240, 280, 320];
const COTTAGE_RADIUS = 54;
const CLEARING_HALF = 64;

function fail(message) {
    throw new ScenarioError(message);
}

function itemToken(name) {
    if (typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name)) fail(`Provision item '${name}' is not a plain Minecraft id.`);
    return `minecraft:${name}`;
}

function n0(value) {
    return Object.is(value, -0) ? 0 : value;
}

export function rotateLocal(lx, lz, doorFacing) {
    switch (doorFacing) {
        case 'south': return [n0(lx), n0(lz)];
        case 'north': return [n0(-lx), n0(-lz)];
        case 'east': return [n0(lz), n0(-lx)];
        case 'west': return [n0(-lz), n0(lx)];
        default: fail(`Unknown facing '${doorFacing}'.`);
    }
}

export function rotateFacing(localFacing, doorFacing) {
    const steps = (CLOCK.indexOf(doorFacing) - CLOCK.indexOf('south') + 4) % 4;
    return CLOCK[(CLOCK.indexOf(localFacing) + steps) % 4];
}

function directionToward(fromX, fromZ, toX, toZ) {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
    return dz > 0 ? 'south' : 'north';
}

function polar(origin, angleDeg, radius) {
    const rad = angleDeg * Math.PI / 180;
    return {
        x: origin.x + Math.round(radius * Math.cos(rad)),
        z: origin.z + Math.round(radius * Math.sin(rad)),
    };
}

export function chestStacks(plot, provisions, index) {
    const home = provisions?.per_home || {};
    if (plot.occupant == null) return [...(home.vacant_chest || [])];
    const stacks = [];
    for (const food of home.food || []) stacks.push({ item: food.item, count: food.count });
    for (const tool of home.tools || []) stacks.push({ item: tool, count: 1 });
    for (const piece of home.armor || []) stacks.push({ item: piece, count: 1 });
    for (const material of home.materials || []) stacks.push({ item: material.item, count: material.count });
    const cycle = home.personal_cycle || [];
    if (cycle.length) stacks.push({ item: cycle[index % cycle.length], count: 1 });
    if (stacks.length > 27) fail(`Plot '${plot.id}' has ${stacks.length} chest stacks; a chest holds 27.`);
    return stacks;
}

class Blocks {
    constructor() {
        this.map = new Map();
    }

    set(x, y, z, state) {
        this.map.set(`${x},${y},${z}`, { x, y, z, state });
    }

    get(x, y, z) {
        return this.map.get(`${x},${y},${z}`)?.state || null;
    }

    has(x, y, z) {
        return this.map.has(`${x},${y},${z}`);
    }
}

function placeCottage(blocks, center, floorY, style, doorFacing) {
    const put = (lx, ly, lz, state) => {
        const [rx, rz] = rotateLocal(lx, lz, doorFacing);
        blocks.set(center.x + rx, floorY + ly, center.z + rz, state);
    };
    const face = (local) => rotateFacing(local, doorFacing);
    for (let lx = -3; lx <= 3; lx++) {
        for (let lz = -3; lz <= 3; lz++) {
            const edge = Math.abs(lx) === 3 || Math.abs(lz) === 3;
            const corner = Math.abs(lx) === 3 && Math.abs(lz) === 3;
            if (!edge) {
                put(lx, 0, lz, `minecraft:${style.wall}`);
                continue;
            }
            put(lx, 0, lz, `minecraft:${style.foundation}`);
            if (lx === 0 && lz === 3) continue;
            const window = lyWindow(lx, lz);
            for (let ly = 1; ly <= 2; ly++) {
                if (window && ly === 1) put(lx, ly, lz, 'minecraft:glass_pane');
                else put(lx, ly, lz, `minecraft:${corner ? style.log : style.wall}`);
            }
        }
    }
    put(0, 1, 3, `minecraft:${style.door}[facing=${face('south')},half=lower,hinge=left,open=false]`);
    put(0, 2, 3, `minecraft:${style.door}[facing=${face('south')},half=upper,hinge=left,open=false]`);
    put(-1, 1, -1, `minecraft:${style.bed}[facing=${face('north')},part=foot,occupied=false]`);
    put(-1, 1, -2, `minecraft:${style.bed}[facing=${face('north')},part=head,occupied=false]`);
    put(2, 1, -2, `minecraft:chest[facing=${face('south')}]`);
    put(2, 1, 2, 'minecraft:crafting_table');
    put(1, 1, 2, `minecraft:furnace[facing=${face('north')}]`);
    put(0, 2, 0, 'minecraft:lantern[hanging=true]');
    for (let lx = -3; lx <= 3; lx++) {
        for (let lz = -3; lz <= 3; lz++) {
            put(lx, 3, lz, `minecraft:${style.roof}`);
        }
    }
    for (let lx = -4; lx <= 4; lx++) {
        for (let lz = -4; lz <= 4; lz++) {
            if (Math.abs(lx) !== 4 && Math.abs(lz) !== 4) continue;
            const outward = Math.abs(lx) === 4
                ? (lx > 0 ? 'east' : 'west')
                : (lz > 0 ? 'south' : 'north');
            put(lx, 3, lz, `minecraft:${style.roofStair}[facing=${face(outward)},half=bottom,shape=straight]`);
        }
    }
    put(3, 1, -3, 'minecraft:cobblestone');
    put(3, 2, -3, 'minecraft:cobblestone');
    put(3, 3, -3, 'minecraft:cobblestone');
    put(3, 4, -3, 'minecraft:cobblestone_wall');
    put(2, 1, 5, 'minecraft:potted_dandelion');
    put(-2, 1, 5, 'minecraft:potted_poppy');
    const [mx, mz] = rotateLocal(0, 5, doorFacing);
    const [bx, bz] = rotateLocal(-1, -1, doorFacing);
    const [cx, cz] = rotateLocal(2, -2, doorFacing);
    const [tx, tz] = rotateLocal(2, 2, doorFacing);
    const [fx, fz] = rotateLocal(1, 2, doorFacing);
    const [dx, dz] = rotateLocal(0, 3, doorFacing);
    return {
        home_marker: [center.x + mx, floorY + 1, center.z + mz],
        bed: [center.x + bx, floorY + 1, center.z + bz],
        chest: [center.x + cx, floorY + 1, center.z + cz],
        crafting_table: [center.x + tx, floorY + 1, center.z + tz],
        furnace: [center.x + fx, floorY + 1, center.z + fz],
        door: [center.x + dx, floorY + 1, center.z + dz],
    };
}

function lyWindow(lx, lz) {
    if (lz === 3 && (lx === -2 || lx === 2)) return true;
    if (lx === 3 && lz === 0) return true;
    if (lx === -3 && lz === 0) return true;
    return false;
}

function placeBox(blocks, x1, y1, z1, x2, y2, z2, state, { hollow = false, skip } = {}) {
    const xa = Math.min(x1, x2);
    const xb = Math.max(x1, x2);
    const ya = Math.min(y1, y2);
    const yb = Math.max(y1, y2);
    const za = Math.min(z1, z2);
    const zb = Math.max(z1, z2);
    for (let x = xa; x <= xb; x++) {
        for (let y = ya; y <= yb; y++) {
            for (let z = za; z <= zb; z++) {
                const edge = x === xa || x === xb || y === ya || y === yb || z === za || z === zb;
                if (hollow && !edge) continue;
                if (skip && skip(x, y, z)) continue;
                blocks.set(x, y, z, state);
            }
        }
    }
}

function placeCommonHouse(blocks, center, floorY, doorFacing) {
    const putLocal = (lx, ly, lz, state) => {
        const [rx, rz] = rotateLocal(lx, lz, doorFacing);
        blocks.set(center.x + rx, floorY + ly, center.z + rz, state);
    };
    const face = (local) => rotateFacing(local, doorFacing);
    for (let lx = -5; lx <= 5; lx++) {
        for (let lz = -4; lz <= 4; lz++) {
            const edge = Math.abs(lx) === 5 || Math.abs(lz) === 4;
            putLocal(lx, 0, lz, edge ? 'minecraft:stone_bricks' : 'minecraft:oak_planks');
            if (!edge) continue;
            if (lx === 0 && lz === 4) continue;
            for (let ly = 1; ly <= 3; ly++) {
                const corner = Math.abs(lx) === 5 && Math.abs(lz) === 4;
                putLocal(lx, ly, lz, corner ? 'minecraft:stripped_spruce_log' : 'minecraft:oak_planks');
            }
        }
    }
    putLocal(0, 1, 4, `minecraft:oak_door[facing=${face('south')},half=lower,hinge=left,open=false]`);
    putLocal(0, 2, 4, `minecraft:oak_door[facing=${face('south')},half=upper,hinge=left,open=false]`);
    putLocal(-3, 1, 4, 'minecraft:glass_pane');
    putLocal(3, 1, 4, 'minecraft:glass_pane');
    for (let lx = -5; lx <= 5; lx++) {
        for (let lz = -4; lz <= 4; lz++) putLocal(lx, 4, lz, 'minecraft:dark_oak_planks');
    }
    putLocal(0, 3, 0, 'minecraft:lantern[hanging=true]');
    putLocal(-3, 3, -2, 'minecraft:lantern[hanging=true]');
    putLocal(3, 3, -2, 'minecraft:lantern[hanging=true]');
    putLocal(-3, 1, -2, `minecraft:chest[facing=${face('south')}]`);
    putLocal(-2, 1, -3, 'minecraft:bookshelf');
    putLocal(-1, 1, -3, 'minecraft:bookshelf');
    putLocal(2, 1, -3, 'minecraft:crafting_table');
    putLocal(3, 1, -3, `minecraft:furnace[facing=${face('south')}]`);
    putLocal(-4, 1, 1, `minecraft:oak_stairs[facing=${face('west')},half=bottom,shape=straight]`);
    putLocal(4, 1, 1, `minecraft:oak_stairs[facing=${face('east')},half=bottom,shape=straight]`);
    const [mx, mz] = rotateLocal(0, 6, doorFacing);
    const [cx, cz] = rotateLocal(-3, -2, doorFacing);
    const [dx, dz] = rotateLocal(0, 4, doorFacing);
    return {
        marker: [center.x + mx, floorY + 1, center.z + mz],
        chest: [center.x + cx, floorY + 1, center.z + cz],
        door: [center.x + dx, floorY + 1, center.z + dz],
    };
}

function placeGarden(blocks, center, floorY) {
    for (let x = center.x - 4; x <= center.x + 4; x++) {
        for (let z = center.z - 3; z <= center.z + 3; z++) {
            const rim = Math.abs(x - center.x) === 4 || Math.abs(z - center.z) === 3;
            if (rim) {
                blocks.set(x, floorY, z, 'minecraft:grass_block');
                continue;
            }
            if (x === center.x) {
                blocks.set(x, floorY, z, 'minecraft:water');
                continue;
            }
            blocks.set(x, floorY, z, 'minecraft:farmland[moisture=7]');
            const crop = (x + z) % 3 === 0 ? 'wheat[age=7]' : (x + z) % 3 === 1 ? 'carrots[age=7]' : 'potatoes[age=7]';
            blocks.set(x, floorY + 1, z, `minecraft:${crop}`);
        }
    }
    blocks.set(center.x + 4, floorY + 1, center.z, 'minecraft:composter');
    for (const [x, z, flower] of [[-4, -3, 'dandelion'], [4, -3, 'poppy'], [-4, 3, 'cornflower'], [4, 3, 'allium']]) {
        blocks.set(center.x + x, floorY + 1, center.z + z, `minecraft:${flower}`);
    }
    return { marker: [center.x, floorY + 1, center.z + 5] };
}

function placeWell(blocks, center, floorY) {
    for (let x = center.x - 1; x <= center.x + 1; x++) {
        for (let z = center.z - 1; z <= center.z + 1; z++) {
            const rim = Math.abs(x - center.x) === 1 || Math.abs(z - center.z) === 1;
            if (!rim) {
                blocks.set(x, floorY, z, 'minecraft:water');
                blocks.set(x, floorY - 1, z, 'minecraft:cobblestone');
                continue;
            }
            blocks.set(x, floorY, z, 'minecraft:cobblestone');
            blocks.set(x, floorY + 1, z, 'minecraft:cobblestone_wall');
        }
    }
    blocks.set(center.x - 1, floorY + 1, center.z, 'minecraft:lantern');
    return { marker: [center.x + 3, floorY + 1, center.z] };
}

function placePasture(blocks, center, floorY) {
    for (let x = center.x - 3; x <= center.x + 3; x++) {
        for (let z = center.z - 2; z <= center.z + 2; z++) {
            const edge = Math.abs(x - center.x) === 3 || Math.abs(z - center.z) === 2;
            blocks.set(x, floorY, z, 'minecraft:grass_block');
            if (!edge) continue;
            if (x === center.x && z === center.z + 2) {
                blocks.set(x, floorY + 1, z, 'minecraft:oak_fence_gate[facing=south,open=false]');
                continue;
            }
            blocks.set(x, floorY + 1, z, 'minecraft:oak_fence');
        }
    }
    blocks.set(center.x, floorY, center.z - 1, 'minecraft:water');
    blocks.set(center.x, floorY - 1, center.z - 1, 'minecraft:cobblestone');
    return {
        marker: [center.x, floorY + 1, center.z + 4],
        animals: [
            { type: 'cow', x: center.x - 1, y: floorY + 1, z: center.z },
            { type: 'cow', x: center.x + 1, y: floorY + 1, z: center.z },
            { type: 'sheep', x: center.x - 1, y: floorY + 1, z: center.z + 1 },
            { type: 'sheep', x: center.x + 1, y: floorY + 1, z: center.z + 1 },
            { type: 'chicken', x: center.x, y: floorY + 1, z: center.z },
            { type: 'chicken', x: center.x - 2, y: floorY + 1, z: center.z },
            { type: 'chicken', x: center.x + 2, y: floorY + 1, z: center.z },
        ],
    };
}

function placeSquare(blocks, origin, floorY) {
    for (let x = origin.x - 6; x <= origin.x + 6; x++) {
        for (let z = origin.z - 6; z <= origin.z + 6; z++) {
            const edge = Math.abs(x - origin.x) === 6 || Math.abs(z - origin.z) === 6;
            blocks.set(x, floorY, z, edge ? 'minecraft:stone_bricks' : 'minecraft:grass_block');
        }
    }
    blocks.set(origin.x, floorY, origin.z, 'minecraft:stone_bricks');
    blocks.set(origin.x, floorY + 1, origin.z, 'minecraft:campfire[lit=true]');
    for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
        blocks.set(origin.x + x, floorY + 1, origin.z + z, 'minecraft:oak_fence');
        blocks.set(origin.x + x, floorY + 2, origin.z + z, 'minecraft:lantern[hanging=false]');
    }
    return { marker: [origin.x, floorY + 1, origin.z - 3] };
}

function groundState(blocks, x, floorY, z) {
    return blocks.get(x, floorY, z) || 'minecraft:grass_block';
}

function enterable(blocks, x, floorY, z) {
    return allowedGround(groundState(blocks, x, floorY, z))
        && passable(blocks.get(x, floorY + 1, z))
        && passable(blocks.get(x, floorY + 2, z));
}

function connectPath(blocks, from, to, floorY) {
    const route = routeWalkable(blocks, from, to, floorY);
    if (!route) return null;
    for (const [x, , z] of route) {
        const ground = blocks.get(x, floorY, z);
        if (!ground || ground === 'minecraft:grass_block' || ground === 'minecraft:stone_bricks') {
            blocks.set(x, floorY, z, 'minecraft:dirt_path');
        }
    }
    return route;
}

function passable(state) {
    if (!state) return true;
    const id = state.replace('minecraft:', '').split('[')[0];
    return id === 'air' || id.endsWith('_door') || id.endsWith('_fence_gate') || id.endsWith('_carpet');
}

function allowedGround(state) {
    if (!state) return false;
    const id = state.replace('minecraft:', '').split('[')[0];
    if (id === 'campfire' || id === 'farmland' || id === 'water' || id === 'lava') return false;
    return id === 'grass_block' || id === 'dirt_path' || id === 'stone_bricks' || id === 'cobblestone'
        || id.endsWith('_planks') || id === 'bricks';
}

export function routeWalkable(blocks, from, to, floorY) {
    const start = `${from[0]},${from[2]}`;
    const goal = `${to[0]},${to[2]}`;
    const queue = [[from[0], from[2]]];
    const prev = new Map([[start, null]]);
    while (queue.length) {
        const [x, z] = queue.shift();
        const key = `${x},${z}`;
        if (key === goal) break;
        for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
            const next = `${nx},${nz}`;
            if (prev.has(next)) continue;
            if (Math.abs(nx - from[0]) > 80 || Math.abs(nz - from[2]) > 80) continue;
            if (!enterable(blocks, nx, floorY, nz)) continue;
            prev.set(next, key);
            queue.push([nx, nz]);
        }
    }
    if (!prev.has(goal)) return null;
    const cells = [];
    let cursor = goal;
    while (cursor) {
        const [x, z] = cursor.split(',').map(Number);
        cells.push([x, floorY + 1, z]);
        cursor = prev.get(cursor);
    }
    return cells.reverse();
}

function scatterFlowers(blocks, origin, floorY, plots) {
    let n = 0;
    for (const plot of plots) {
        const [x, , z] = plot.home_marker;
        for (const [dx, dz] of [[2, 2], [-2, 1], [1, -2]]) {
            const fx = x + dx;
            const fz = z + dz;
            if (blocks.get(fx, floorY, fz) !== 'minecraft:grass_block') continue;
            if (blocks.get(fx, floorY + 1, fz)) continue;
            blocks.set(fx, floorY + 1, fz, `minecraft:${FLOWERS[n % FLOWERS.length]}`);
            n += 1;
        }
    }
    for (let i = 0; i < 8; i++) {
        const spot = polar(origin, 45 * i + 20, 62);
        if (blocks.has(spot.x, floorY + 1, spot.z)) continue;
        blocks.set(spot.x, floorY, spot.z, 'minecraft:grass_block');
        blocks.set(spot.x, floorY + 1, spot.z, 'minecraft:oak_log[axis=y]');
        blocks.set(spot.x, floorY + 2, spot.z, 'minecraft:oak_log[axis=y]');
        blocks.set(spot.x, floorY + 3, spot.z, 'minecraft:oak_log[axis=y]');
        blocks.set(spot.x, floorY + 4, spot.z, 'minecraft:oak_leaves[persistent=true]');
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
            blocks.set(spot.x + dx, floorY + 5, spot.z + dz, 'minecraft:oak_leaves[persistent=true]');
        }
    }
}

/**
 * Build a village plan around origin for whatever plots the scenario lists.
 * Plot order selects cottage style. Names are not read.
 */
export function planVillage({ plots, provisions, origin, floorY }) {
    if (!Array.isArray(plots) || plots.length < 1 || plots.length > COTTAGE_ANGLES.length) {
        fail(`This clearing fits 1 to ${COTTAGE_ANGLES.length} homes; the scenario has ${plots?.length}.`);
    }
    const blocks = new Blocks();
    const square = placeSquare(blocks, origin, floorY);
    const placed = [];
    plots.forEach((plot, index) => {
        const center = polar(origin, COTTAGE_ANGLES[index], COTTAGE_RADIUS);
        const doorFacing = directionToward(center.x, center.z, origin.x, origin.z);
        const style = STYLES[index % STYLES.length];
        const points = placeCottage(blocks, center, floorY, style, doorFacing);
        placed.push({ ...plot, ...points, style: style.wall });
    });
    const commonCenter = polar(origin, 90, 33);
    const commonFacing = directionToward(commonCenter.x, commonCenter.z, origin.x, origin.z);
    const common = placeCommonHouse(blocks, commonCenter, floorY, commonFacing);
    const garden = placeGarden(blocks, polar(origin, 140, 16), floorY);
    const well = placeWell(blocks, polar(origin, 180, 14), floorY);
    const pasture = placePasture(blocks, polar(origin, 260, 16), floorY);
    for (const plot of placed) connectPath(blocks, plot.home_marker, square.marker, floorY);
    connectPath(blocks, common.marker, square.marker, floorY);
    connectPath(blocks, garden.marker, square.marker, floorY);
    connectPath(blocks, well.marker, square.marker, floorY);
    connectPath(blocks, pasture.marker, square.marker, floorY);
    scatterFlowers(blocks, origin, floorY, placed);
    for (const plot of placed) ensureStanding(blocks, plot.home_marker, floorY);
    ensureStanding(blocks, square.marker, floorY);
    ensureStanding(blocks, common.marker, floorY);
    ensureStanding(blocks, garden.marker, floorY);
    ensureStanding(blocks, well.marker, floorY);
    ensureStanding(blocks, pasture.marker, floorY);
    const publicPlaces = [
        { id: 'square', marker: square.marker, notes: 'Central green. Campfire on stone, lantern posts at the corners.' },
        { id: 'common-house', marker: common.marker, chest: common.chest, notes: 'Communal room. The chest is shared and finite.' },
        { id: 'garden', marker: garden.marker, notes: 'Watered crops and flowers. Harvest is ordinary Minecraft farming.' },
        { id: 'well', marker: well.marker, notes: 'Stone well with water.' },
        { id: 'pasture', marker: pasture.marker, notes: 'Fenced grass with a few persistent animals and a water trough.' },
    ];
    const paths = [
        ...placed.map(plot => ({ from: plot.id, to: 'square', walkable_without_breaking: true })),
        ...publicPlaces.filter(place => place.id !== 'square').map(place => ({ from: 'square', to: place.id, walkable_without_breaking: true })),
    ];
    const unreachable = [];
    for (const plot of placed) {
        if (!routeWalkable(blocks, plot.home_marker, square.marker, floorY)) unreachable.push(plot.id);
    }
    for (const place of publicPlaces) {
        if (place.id === 'square') continue;
        if (!routeWalkable(blocks, place.marker, square.marker, floorY)) unreachable.push(place.id);
    }
    if (unreachable.length) fail(`No walkable path to the square from: ${unreachable.join(', ')}.`);
    const chests = placed.map((plot, index) => ({
        x: plot.chest[0], y: plot.chest[1], z: plot.chest[2],
        stacks: chestStacks(plot, provisions, index),
        occupied: plot.occupant != null,
    }));
    chests.push({
        x: common.chest[0], y: common.chest[1], z: common.chest[2],
        stacks: provisions?.public_chest || [],
        occupied: true,
    });
    return {
        blocks,
        plots: placed,
        publicPlaces,
        paths,
        chests,
        animals: pasture.animals,
        spawn: square.marker,
        floorY,
        origin: [origin.x, floorY, origin.z],
        half: CLEARING_HALF,
    };
}

function ensureStanding(blocks, marker, floorY) {
    const [x, y, z] = marker;
    if (y !== floorY + 1) fail('A marker must stand on the village floor.');
    for (const head of [y, y + 1]) {
        const state = blocks.get(x, head, z);
        if (state && !passable(state)) blocks.map.delete(`${x},${head},${z}`);
    }
    const ground = blocks.get(x, floorY, z);
    if (!allowedGround(ground) || ground === 'minecraft:farmland[moisture=7]') {
        blocks.set(x, floorY, z, 'minecraft:dirt_path');
    }
}

export function assertClearMarkers(plan) {
    for (const plot of plan.plots) {
        const [x, y, z] = plot.home_marker;
        const feet = plan.blocks.get(x, y, z);
        const head = plan.blocks.get(x, y + 1, z);
        const ground = plan.blocks.get(x, y - 1, z);
        if (!passable(feet) || !passable(head) || !allowedGround(ground)) {
            fail(`Home marker for '${plot.id}' is not a safe standing position.`);
        }
    }
}

export function groundCommands(origin, floorY, half = CLEARING_HALF) {
    const x1 = origin.x - half;
    const x2 = origin.x + half;
    const z1 = origin.z - half;
    const z2 = origin.z + half;
    const commands = [];
    for (let y = floorY + 1; y <= floorY + 12; y++) {
        commands.push(...sliceFill(x1, y, z1, x2, y, z2, 'minecraft:air'));
    }
    commands.push(...sliceFill(x1, floorY, z1, x2, floorY, z2, 'minecraft:grass_block'));
    commands.push(...sliceFill(x1, floorY - 1, z1, x2, floorY - 1, z2, 'minecraft:dirt'));
    return commands;
}

export function sliceFill(x1, y1, z1, x2, y2, z2, state) {
    const commands = [];
    const maxVolume = 30000;
    const ySpan = Math.abs(y2 - y1) + 1;
    const xSpan = Math.abs(x2 - x1) + 1;
    const zSpan = Math.abs(z2 - z1) + 1;
    if (xSpan * ySpan * zSpan <= maxVolume) {
        commands.push(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${state}`);
        return commands;
    }
    const rows = Math.max(1, Math.floor(maxVolume / (xSpan * ySpan)));
    const zStart = Math.min(z1, z2);
    const zEnd = Math.max(z1, z2);
    for (let z = zStart; z <= zEnd; z += rows) {
        const zB = Math.min(zEnd, z + rows - 1);
        commands.push(`fill ${Math.min(x1, x2)} ${Math.min(y1, y2)} ${z} ${Math.max(x1, x2)} ${Math.max(y1, y2)} ${zB} ${state}`);
    }
    return commands;
}

export function planCommands(plan) {
    const grouped = new Map();
    for (const block of plan.blocks.map.values()) {
        const key = `${block.y}\t${block.z}\t${block.state}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(block.x);
    }
    const fills = [];
    for (const [key, xs] of grouped) {
        const [y, z, state] = key.split('\t');
        xs.sort((a, b) => a - b);
        let start = xs[0];
        let prev = xs[0];
        for (const x of xs.slice(1)) {
            if (x === prev + 1) {
                prev = x;
                continue;
            }
            fills.push(`fill ${start} ${y} ${z} ${prev} ${y} ${z} ${state}`);
            start = x;
            prev = x;
        }
        fills.push(`fill ${start} ${y} ${z} ${prev} ${y} ${z} ${state}`);
    }
    const items = [];
    for (const chest of plan.chests) {
        items.push(`data merge block ${chest.x} ${chest.y} ${chest.z} {Items:[]}`);
        chest.stacks.forEach((stack, slot) => {
            items.push(`item replace block ${chest.x} ${chest.y} ${chest.z} container.${slot} with ${itemToken(stack.item)} ${stack.count}`);
        });
    }
    const summons = plan.animals.map(animal => (
        `summon ${animal.type} ${animal.x} ${animal.y} ${animal.z} {PersistenceRequired:1b,Tags:["village_livestock"]}`
    ));
    const [sx, sy, sz] = plan.spawn;
    const rules = [
        'gamerule showDeathMessages false',
        'gamerule keepInventory false',
        'gamerule doDaylightCycle true',
        'gamerule doWeatherCycle true',
        'gamerule doMobSpawning true',
        'gamerule mobGriefing true',
        'gamerule doImmediateRespawn false',
        'difficulty normal',
        'defaultgamemode survival',
        `setworldspawn ${sx} ${sy} ${sz}`,
        'time set day',
        'weather clear',
    ];
    return { fills, items, summons, rules };
}

export function assessSite(samples) {
    if (!Array.isArray(samples) || samples.length < 16) return { ok: false, reason: 'incomplete' };
    if (samples.some(sample => sample.water || sample.lava)) return { ok: false, reason: 'water' };
    const heights = samples.map(sample => sample.height);
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    if (max - min > 1) return { ok: false, reason: 'slope', min, max };
    if (min < 50 || max > 120) return { ok: false, reason: 'altitude', min, max };
    return { ok: true, floorY: min, min, max };
}
