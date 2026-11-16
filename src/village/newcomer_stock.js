import { ScenarioError } from './errors.js';
import { chestStacks } from './blueprint.js';

export const RECEIPT_NAME = 'village-newcomer-stock.json';

export const TARGETS = [
    { plotId: 'plot-vacant', inhabitantId: 'hazel', name: 'Hazel' },
    { plotId: 'plot-vacant-2', inhabitantId: 'silas', name: 'Silas' },
    { plotId: 'plot-vacant-3', inhabitantId: 'wren', name: 'Wren' },
];

/** The placement function as furnished for the original five. Append only. */
export const PLACEMENT_PREFIX = [
    'execute as @a[name=Ione,tag=!village_placed] run tp @s -496 73 -760',
    'execute as @a[name=Ione,tag=!village_placed] run spawnpoint @s -497 73 -761',
    'execute as @a[name=Ione,tag=!village_placed] run tag @s add village_placed',
    'execute as @a[name=Cass,tag=!village_placed] run tp @s -470 85 -727',
    'execute as @a[name=Cass,tag=!village_placed] run spawnpoint @s -469 85 -728',
    'execute as @a[name=Cass,tag=!village_placed] run tag @s add village_placed',
    'execute as @a[name=Rufus,tag=!village_placed] run tp @s -427 69 -711',
    'execute as @a[name=Rufus,tag=!village_placed] run spawnpoint @s -426 69 -710',
    'execute as @a[name=Rufus,tag=!village_placed] run tag @s add village_placed',
    'execute as @a[name=Nell,tag=!village_placed] run tp @s -418 73 -732',
    'execute as @a[name=Nell,tag=!village_placed] run spawnpoint @s -419 73 -733',
    'execute as @a[name=Nell,tag=!village_placed] run tag @s add village_placed',
    'execute as @a[name=Bram,tag=!village_placed] run tp @s -400 67 -711',
    'execute as @a[name=Bram,tag=!village_placed] run spawnpoint @s -398 67 -710',
    'execute as @a[name=Bram,tag=!village_placed] run tag @s add village_placed',
].join('\n') + '\n';

function fail(message) {
    throw new ScenarioError(message);
}

function sameCoord(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === 3 && left.every((value, index) => value === right[index]);
}

export function placementEntries(name, home, bed) {
    const [x, y, z] = home;
    const [bx, by, bz] = bed;
    return [
        `execute as @a[name=${name},tag=!village_placed] run tp @s ${x} ${y} ${z}`,
        `execute as @a[name=${name},tag=!village_placed] run spawnpoint @s ${bx} ${by} ${bz}`,
        `execute as @a[name=${name},tag=!village_placed] run tag @s add village_placed`,
    ];
}

/**
 * Plan the one-time stock for the three formerly vacant cottages.
 * A receipt refuses the plan before any chest command is considered.
 * The original placement lines are kept byte for byte.
 */
export function planNewcomerStock(village, site, placementText, { receiptExists = false } = {}) {
    if (receiptExists) {
        return {
            refill: false,
            reason: 'Newcomer stock receipt already exists. Refusing to refill chests.',
        };
    }
    if (!village?.plots || !site?.houses) fail('Village and site are required.');
    const houses = new Map();
    for (const house of site.houses) {
        if (!house?.plot_id || houses.has(house.plot_id)) fail(`Site house '${house?.plot_id}' is missing or repeated.`);
        houses.set(house.plot_id, house);
    }
    const targets = [];
    for (const target of TARGETS) {
        const plot = village.plots.find(item => item.id === target.plotId);
        const index = village.plots.findIndex(item => item.id === target.plotId);
        if (!plot || plot.occupant !== target.inhabitantId) {
            fail(`Plot '${target.plotId}' must be occupied by ${target.inhabitantId} before stocking.`);
        }
        const house = houses.get(target.plotId);
        if (!house) fail(`Site is missing ${target.plotId}.`);
        for (const point of ['bed', 'door', 'home_marker', 'chest', 'crafting_table', 'furnace']) {
            if (!sameCoord(plot[point], house[point])) fail(`${target.plotId} ${point} does not match the measured site.`);
        }
        const stacks = chestStacks(plot, village.provisions, index);
        if (stacks.length < 1 || stacks.length > 27) fail(`${target.plotId} chest stack count is ${stacks.length}.`);
        targets.push({
            plotId: target.plotId,
            inhabitantId: target.inhabitantId,
            name: target.name,
            index,
            chest: plot.chest,
            home_marker: plot.home_marker,
            bed: plot.bed,
            stacks,
            fixtures: [
                { at: house.bed, block: house.expect.bed },
                { at: house.door, block: house.expect.door },
                { at: house.chest, block: 'chest' },
                { at: house.crafting_table, block: 'crafting_table' },
                { at: house.furnace, block: 'furnace' },
                { at: house.lantern, block: 'lantern' },
            ],
        });
    }
    const addition = targets.flatMap(target => placementEntries(target.name, target.home_marker, target.bed)).join('\n') + '\n';
    const combined = PLACEMENT_PREFIX + addition;
    let placement;
    if (placementText === PLACEMENT_PREFIX) placement = { action: 'append', text: combined };
    else if (placementText === combined) placement = { action: 'already', text: combined };
    else fail('Placement function does not match the original five inhabitants. Refusing to edit it.');
    if (!combined.startsWith(PLACEMENT_PREFIX)) fail('Placement update would rewrite the original five.');
    const targetIds = new Set(TARGETS.map(target => target.plotId));
    const preserve = [];
    for (const plot of village.plots) {
        if (targetIds.has(plot.id)) continue;
        preserve.push({ id: plot.id, chest: plot.chest });
    }
    const common = (village.public || []).find(place => place.id === 'common-house');
    if (!common?.chest) fail('The common-house chest is missing from the village description.');
    preserve.push({ id: 'common-house', chest: common.chest });
    return { refill: true, targets, placement, addition, preserve };
}

export function chestIsEmpty(output) {
    return typeof output === 'string' && /block data:\s*\[\]\s*$/.test(output.trim()) && !/minecraft:/.test(output);
}
