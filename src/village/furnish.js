import { ScenarioError } from './errors.js';
import { chestStacks } from './blueprint.js';

function fail(message) {
    throw new ScenarioError(message);
}

function coord(value, label) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => !Number.isInteger(item))) {
        fail(`${label} must be an integer coordinate.`);
    }
}

function placeEntry(entry, label) {
    if (!entry || typeof entry !== 'object') fail(`${label} must be an object.`);
    coord(entry.at, label);
    if (typeof entry.block !== 'string' || !/^[a-z0-9_]+$/.test(entry.block)) fail(`${label} block is invalid.`);
    if (!Array.isArray(entry.allow) || entry.allow.length < 1 || entry.allow.some(name => typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name))) {
        fail(`${label} allow list must name blocks that may be replaced.`);
    }
    return { at: entry.at, block: entry.block, allow: entry.allow };
}

/**
 * Turn a measured site file plus the scenario's plots and supply manifest into
 * the blocks and chest stacks a provisioner may apply. Names come from profiles.
 * This does not talk to a server and does not refill anything by itself.
 */
export function planFurnish(village, site, inhabitants) {
    if (!site || typeof site !== 'object') fail('Site file must be an object.');
    if (!Array.isArray(site.houses) || site.houses.length !== village.plots.length) {
        fail('Site houses must match the scenario plots one for one.');
    }
    coord(site.origin, 'site.origin');
    if (!Number.isInteger(site.floor_block_y)) fail('site.floor_block_y must be an integer.');
    const byId = new Map();
    for (const house of site.houses) {
        if (!house?.plot_id || byId.has(house.plot_id)) fail(`Site house '${house?.plot_id}' is missing or repeated.`);
        for (const point of ['bed', 'door', 'home_marker', 'chest', 'crafting_table', 'furnace', 'lantern']) coord(house[point], `${house.plot_id} ${point}`);
        if (house.expect?.bed && !/^[a-z0-9_]+$/.test(house.expect.bed)) fail(`${house.plot_id} bed expectation is invalid.`);
        if (house.expect?.door && !/^[a-z0-9_]+$/.test(house.expect.door)) fail(`${house.plot_id} door expectation is invalid.`);
        const place = (house.place || []).map((entry, index) => placeEntry(entry, `${house.plot_id} place ${index}`));
        byId.set(house.plot_id, { ...house, place });
    }
    const places = [];
    const chests = [];
    const arrivals = [];
    const names = new Map((inhabitants || []).map(profile => [profile.id, profile.name]));
    village.plots.forEach((plot, index) => {
        const house = byId.get(plot.id);
        if (!house) fail(`Site is missing plot '${plot.id}'.`);
        places.push(...house.place);
        chests.push({
            plot_id: plot.id,
            at: house.chest,
            stacks: chestStacks(plot, village.provisions, index),
            occupied: plot.occupant != null,
        });
        if (plot.occupant) {
            const name = names.get(plot.occupant);
            if (!name) fail(`Plot '${plot.id}' occupant '${plot.occupant}' has no profile.`);
            arrivals.push({ name, home_marker: house.home_marker, bed: house.bed });
        }
    });
    if (!Array.isArray(site.public)) fail('Site public places must be a list.');
    const publicIds = new Set((village.public || []).map(place => place.id));
    const publics = [];
    for (const place of site.public) {
        if (!publicIds.has(place.id)) fail(`Site public place '${place?.id}' is not in the scenario.`);
        coord(place.marker, `${place.id} marker`);
        if (place.chest) coord(place.chest, `${place.id} chest`);
        const placeBlocks = (place.place || []).map((entry, index) => placeEntry(entry, `${place.id} place ${index}`));
        places.push(...placeBlocks);
        publics.push(place);
    }
    for (const id of publicIds) {
        if (!site.public.some(place => place.id === id)) fail(`Site is missing public place '${id}'.`);
    }
    const decor = (site.decor || []).map((entry, index) => placeEntry(entry, `decor ${index}`));
    places.push(...decor);
    const common = publics.find(place => place.chest);
    if (common?.chest) {
        chests.push({
            plot_id: common.id,
            at: common.chest,
            stacks: [...(village.provisions.public_chest || [])],
            occupied: true,
        });
    }
    return {
        method: site.method,
        seed: site.seed,
        origin: site.origin,
        floor_block_y: site.floor_block_y,
        houses: village.plots.map(plot => byId.get(plot.id)),
        publics,
        places,
        chests,
        arrivals,
    };
}
