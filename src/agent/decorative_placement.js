const PLANT_GROUND = new Set([
    'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'moss_block',
    'mud', 'muddy_mangrove_roots', 'rooted_dirt', 'farmland',
]);
const REPLACEABLE_PLANT_CELL = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'grass', 'fern', 'snow', 'dead_bush',
]);

/** Flowers and saplings. Torches and full blocks keep the ordinary placeHere path. */
export function isGroundPlant(type) {
    const name = String(type || '');
    if (name.endsWith('_sapling')) return true;
    if (/_tulip$/.test(name)) return true;
    return /^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|closed_eyeblossom|open_eyeblossom|pink_petals|wildflowers|sunflower|lilac|rose_bush|peony|pitcher_plant|spore_blossom|red_mushroom|brown_mushroom|sweet_berry_bush|bamboo|sugar_cane|cactus|short_grass|fern|dead_bush)$/.test(name);
}

/**
 * Nearest empty cell on plantable ground. Paths, flowers, and other blocks are left alone.
 * Returns null when nothing nearby is suitable.
 */
export function decorativePlacementTarget(blockAt, origin, radius = 2) {
    const x0 = Math.floor(Number(origin?.x));
    const y0 = Math.floor(Number(origin?.y));
    const z0 = Math.floor(Number(origin?.z));
    if (![x0, y0, z0].every(Number.isFinite)) return null;
    let best = null;
    let bestScore = Infinity;
    for (let dy = 1; dy >= -1; dy--) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const x = x0 + dx;
                const y = y0 + dy;
                const z = z0 + dz;
                const name = blockAt(x, y, z) || 'air';
                const below = blockAt(x, y - 1, z) || 'air';
                if (!REPLACEABLE_PLANT_CELL.has(name) || !PLANT_GROUND.has(below)) continue;
                const score = (dx * dx) + (dz * dz) + (Math.abs(dy) * 0.25);
                if (score < bestScore) {
                    bestScore = score;
                    best = { x, y, z };
                }
            }
        }
    }
    return best;
}
