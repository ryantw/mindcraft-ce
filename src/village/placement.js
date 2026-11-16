import { ScenarioError } from './errors.js';

const NAME = /^[A-Za-z0-9_]{3,16}$/;

function fail(message) {
    throw new ScenarioError(message);
}

function coord(value, label) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => !Number.isInteger(item))) {
        fail(`${label} must be an integer coordinate.`);
    }
}

/**
 * One server function. It moves a player the first time they are seen and then
 * tags them. A later login still has the tag, so restart does not send them home.
 * Chest commands are intentionally absent.
 */
export function placementFunction(arrivals) {
    if (!Array.isArray(arrivals)) fail('Placement arrivals must be a list.');
    const lines = [];
    const seen = new Set();
    for (const arrival of arrivals) {
        if (!arrival?.name || !NAME.test(arrival.name)) fail(`Placement name '${arrival?.name}' is not a Minecraft username.`);
        const key = arrival.name.toLowerCase();
        if (seen.has(key)) fail(`Placement lists '${arrival.name}' twice.`);
        seen.add(key);
        coord(arrival.home_marker, arrival.name);
        coord(arrival.bed, arrival.name);
        const [x, y, z] = arrival.home_marker;
        const [bx, by, bz] = arrival.bed;
        const who = `@a[name=${arrival.name},tag=!village_placed]`;
        lines.push(`execute as ${who} run tp @s ${x} ${y} ${z}`);
        lines.push(`execute as ${who} run spawnpoint @s ${bx} ${by} ${bz}`);
        lines.push(`execute as ${who} run tag @s add village_placed`);
    }
    return `${lines.join('\n')}\n`;
}

const ITEM = /^[a-z0-9_]+$/;

/**
 * Food, stone tools, and leather armor carried on arrival, plus one personal item.
 * Issued once, under the same first-login tag as a home placement.
 */
export function carriedStarter(personalItem) {
    if (!ITEM.test(personalItem || '')) fail(`Personal item '${personalItem}' is not an item id.`);
    const stacks = [
        { item: 'bread', count: 24 },
        { item: 'cooked_beef', count: 16 },
        { item: 'apple', count: 8 },
    ];
    for (const item of ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots', personalItem]) {
        stacks.push({ item, count: 1 });
    }
    return stacks;
}

/**
 * First login for someone with no house: stand in the square, keep that as
 * the respawn, receive the starter kit, then never do this again.
 */
export function squareArrivalLines(name, marker, items) {
    if (!name || !NAME.test(name)) fail(`Placement name '${name}' is not a Minecraft username.`);
    coord(marker, name);
    if (!Array.isArray(items) || items.length < 1) fail(`${name} needs a starter kit.`);
    const who = `@a[name=${name},tag=!village_placed]`;
    const [x, y, z] = marker;
    const lines = [
        `execute as ${who} run tp @s ${x} ${y} ${z}`,
        `execute as ${who} run spawnpoint @s ${x} ${y} ${z}`,
    ];
    for (const stack of items) {
        if (!stack?.item || !ITEM.test(stack.item) || !Number.isInteger(stack.count) || stack.count < 1 || stack.count > 64) {
            fail(`${name} has a bad starter stack.`);
        }
        lines.push(`execute as ${who} run give @s minecraft:${stack.item} ${stack.count}`);
    }
    lines.push(`execute as ${who} run tag @s add village_placed`);
    return lines;
}

export function datapackFiles(arrivals) {
    return {
        'pack.mcmeta': `${JSON.stringify({
            pack: { pack_format: 80, description: 'One-time village home placement. Does not restock chests.' },
        }, null, 2)}\n`,
        'data/minecraft/tags/function/tick.json': `${JSON.stringify({ values: ['village_alpha:place_first'] }, null, 2)}\n`,
        'data/village_alpha/function/place_first.mcfunction': placementFunction(arrivals),
    };
}
