const SURVIVAL_CONTAINERS = new Set(['ai-village']);
const SURVIVAL_DIRS = ['/home/ryan/minecraft/minecraft-data'];
const VILLAGE_CONTAINERS = new Set(['village-alpha']);
const VILLAGE_DIRS = ['/home/ryan/minecraft/village-alpha-data'];

function blocked(value, names) {
    const text = String(value || '');
    return [...names].some(name => text === name || text.includes(name));
}

/**
 * Operator placement guard. Offline usernames are not credentials.
 * Survival data is never a legal target. The live village is legal only
 * when the operator passes the explicit allow flag.
 */
export function assertRemainsTarget({ container, dataDir, allowVillageAlpha = false } = {}) {
    if (!container) throw new Error('A remains placement needs an explicit container.');
    if (blocked(container, SURVIVAL_CONTAINERS) || blocked(dataDir, SURVIVAL_DIRS)) {
        throw new Error('Refusing to place remains in the survival world.');
    }
    if (!allowVillageAlpha && (blocked(container, VILLAGE_CONTAINERS) || blocked(dataDir, VILLAGE_DIRS))) {
        throw new Error('Refusing to place remains in Village Alpha without --allow-village-alpha.');
    }
    return true;
}

export function judgeRemainsSite(blockName, y) {
    if (y == null || !Number.isFinite(Number(y)) || Number(y) < -64) return { place: false, reason: 'void' };
    if (!blockName) return { place: false, reason: 'unloaded' };
    if (blockName === 'lava' || blockName === 'flowing_lava') return { place: false, reason: 'lava' };
    const fixtures = ['chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace'];
    if (fixtures.includes(blockName) || String(blockName).includes('bed')) {
        return { place: false, reason: 'would overwrite belongings or a fixture' };
    }
    return { place: true, reason: null };
}

/**
 * A named armor stand is the physical evidence. The name is the only
 * identity it carries. Cause, time, and coordinates are not written on it.
 * Calling this twice with the same existing plan returns that plan.
 */
export function planRemains({ position, dimension, name, site, existing = null } = {}) {
    if (existing && (existing.status === 'planned' || existing.status === 'placed' || existing.status === 'unplaced')) {
        return { ...existing, idempotent: true };
    }
    const judged = judgeRemainsSite(site?.block, position?.y);
    if (!judged.place) {
        return { status: 'unplaced', reason: judged.reason, id: null, kind: null, idempotent: false };
    }
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    const z = Math.round(position.z);
    return {
        status: 'planned',
        reason: null,
        id: `remains-${x}-${y}-${z}`,
        kind: 'named_armor_stand',
        tag: 'village_remains',
        name: name || null,
        position: { x: position.x, y: position.y, z: position.z },
        dimension: dimension || null,
        idempotent: false,
    };
}

/** What a nearby inhabitant can actually read. A tag without a name says nothing. */
export function readableRemains(entity) {
    const tags = new Set(entity?.tags || []);
    const custom = entity?.customName ? String(entity.customName).slice(0, 64) : '';
    if (!tags.has('village_remains') || !custom) return null;
    return { label: custom, entity_id: entity.id ?? null };
}
