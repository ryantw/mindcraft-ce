import { spawnSync } from 'child_process';
import { readLife, writeLife } from './life.js';

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

const REPLACEABLE = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'snow', 'dead_bush', 'water', 'flowing_water',
]);

export function minecraftBlockName(report) {
    const match = String(report || '').match(/minecraft:([a-z0-9_]+)/);
    return match ? match[1] : null;
}

/**
 * `data get block` only describes block entities. A normal block answers
 * "not a block entity", which is not an unloaded chunk. `execute if block`
 * is the check that distinguishes air, a fixture, and an unloaded position.
 */
export function interpretBlockProbe(report, name) {
    const text = String(report || '');
    if (/not loaded/i.test(text)) return { loaded: false, block: null };
    if (/Test passed/i.test(text)) return { loaded: true, block: name };
    if (/Test failed/i.test(text)) return { loaded: true, block: null };
    return { loaded: false, block: null };
}

const BLOCK_PROBES = [
    'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'snow', 'dead_bush',
    'water', 'flowing_water', 'lava', 'flowing_lava', 'chest', 'trapped_chest', 'barrel',
    'crafting_table', 'furnace',
];

function readLiveBlock(exec, x, y, z) {
    let loaded = false;
    for (const name of BLOCK_PROBES) {
        const found = interpretBlockProbe(exec(`execute if block ${x} ${y} ${z} minecraft:${name}`), name);
        if (!found.loaded) return null;
        loaded = true;
        if (found.block) return found.block;
    }
    const bed = interpretBlockProbe(exec(`execute if block ${x} ${y} ${z} #minecraft:beds`), 'bed');
    if (bed.block) return 'bed';
    return loaded ? 'other' : null;
}

/**
 * Feet first, then one block up. Solid ground, chests, and lava are left alone.
 * The void and an unloaded chunk produce no marker.
 */
export function chooseEvidenceColumn(position, blocksByKey) {
    if (!position) return { place: false, reason: 'no position' };
    const x = Math.floor(Number(position.x));
    const y = Math.floor(Number(position.y));
    const z = Math.floor(Number(position.z));
    if (!Number.isFinite(y) || y < -64) return { place: false, reason: 'void' };
    let sawLava = false;
    for (const dy of [0, 1]) {
        const block = blocksByKey[`${x},${y + dy},${z}`];
        if (!block) return { place: false, reason: 'unloaded' };
        if (block === 'lava' || block === 'flowing_lava') {
            sawLava = true;
            continue;
        }
        if (REPLACEABLE.has(block)) return { place: true, x, y: y + dy, z, block };
    }
    return { place: false, reason: sawLava ? 'lava' : 'no open block' };
}

export function armorStandCommand(name, x, y, z) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name || '')) throw new Error('Remains name is not a Minecraft username.');
    return `execute positioned ${x} ${y} ${z} unless entity @e[type=minecraft:armor_stand,tag=village_remains,distance=..2,limit=1] run summon minecraft:armor_stand ${x} ${y} ${z} {CustomName:'{"text":"${name}"}',CustomNameVisible:1b,Marker:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["village_remains"],DisabledSlots:4144959}`;
}

export function dockerRcon(container, command) {
    assertRemainsTarget({ container, dataDir: '/tmp/village-m3-unprotected' });
    const result = spawnSync('docker', ['exec', container, 'rcon-cli', command], {
        encoding: 'utf8',
        timeout: 20000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'rcon failed').trim());
    return (result.stdout || '').trim();
}

/**
 * Called by the dying process after life.json is already dead.
 * A second call does not summon another stand.
 */
export function placeConfiguredRemains(settings, { run } = {}) {
    const container = settings?.village_remains_container;
    if (!container || !settings.agent_data_root) return null;
    const life = readLife(settings.agent_data_root);
    const position = life?.death?.position;
    const name = settings.profile?.name;
    if (!life || life.lifecycle !== 'dead' || !position || !name) return null;
    if (life.death?.evidence?.status === 'placed') return life.death.evidence;
    const exec = run || ((command) => dockerRcon(container, command));
    const x = Math.floor(position.x);
    const y = Math.floor(position.y);
    const z = Math.floor(position.z);
    // forceload takes block coordinates on this Paper version. Hold the chunk
    // only while the stand is summoned, then release it.
    exec(`forceload add ${x} ${z}`);
    let evidence;
    try {
        const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
        let choice = { place: false, reason: 'unloaded' };
        for (const [dx, dz] of offsets) {
            const blocks = {};
            for (const dy of [0, 1]) {
                blocks[`${x + dx},${y + dy},${z + dz}`] = readLiveBlock(exec, x + dx, y + dy, z + dz);
            }
            choice = chooseEvidenceColumn({ x: x + dx, y, z: z + dz }, blocks);
            if (choice.place || choice.reason === 'void' || choice.reason === 'lava') break;
        }
        evidence = choice.place
        ? {
            status: 'placed',
            reason: null,
            id: `remains-${choice.x}-${choice.y}-${choice.z}`,
            kind: 'named_armor_stand',
            tag: 'village_remains',
            name,
            position: { x: choice.x, y: choice.y, z: choice.z },
            server_reply: String(exec(armorStandCommand(name, choice.x, choice.y, choice.z))).slice(0, 200),
        }
        : { status: 'unplaced', reason: choice.reason, id: null, kind: null };
        life.death = { ...life.death, evidence };
        writeLife(settings.agent_data_root, life);
        if (evidence.status === 'placed') exec('save-all');
        return evidence;
    } finally {
        try { exec(`forceload remove ${x} ${z}`); } catch { /* placement already recorded */ }
    }
}

/**
 * Scoreboard tags are not sent to Mineflayer. The visible custom name is.
 * Paper stores it as a JSON text component on metadata index 2.
 */
export function visibleCustomName(entity) {
    if (typeof entity?.customName === 'string' && entity.customName.trim()) {
        return entity.customName.trim().slice(0, 64);
    }
    const raw = entity?.metadata?.[2]?.value;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.text === 'string' && parsed.text.trim()) return parsed.text.trim().slice(0, 64);
    } catch {
        if (!raw.startsWith('{')) return raw.trim().slice(0, 64);
    }
    return null;
}

/** A named armor stand is the locally perceptible remains. An unnamed one is not. */
export function readableRemains(entity) {
    if (entity?.name !== 'armor_stand') return null;
    const label = visibleCustomName(entity);
    if (!label || !/^[A-Za-z0-9_]{3,16}$/.test(label)) return null;
    return { label, entity_id: entity.id ?? null };
}
