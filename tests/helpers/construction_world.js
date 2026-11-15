import Vec3 from 'vec3';

/**
 * A scripted world. placeBlock really mutates it, so tests can make the call
 * resolve without placing (or throw while placing) and check that results come
 * from the world and not from the call. Anything that would cheat or destroy
 * (chat/setblock, digging, creative inventory) is counted and must stay zero.
 */
export function createWorld({ blocks = [], inventory = {}, position = [0.5, 64, 0.5], placement = {} } = {}) {
    const overrides = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    for (const [name, x, y, z] of blocks) overrides.set(key(x, y, z), name);

    const nameAt = (x, y, z) => {
        const override = overrides.get(key(x, y, z));
        if (override) return override;
        return y <= 63 ? 'stone' : 'air';
    };
    const blockAt = pos => {
        const name = nameAt(pos.x, pos.y, pos.z);
        return {
            name,
            position: new Vec3(pos.x, pos.y, pos.z),
            boundingBox: name === 'air' ? 'empty' : 'block',
        };
    };

    const log = { placements: [], navigations: 0, forbidden: 0 };
    const bot = {
        output: '',
        interrupt_code: false,
        entity: { position: new Vec3(...position) },
        blockAt,
        heldItem: null,
        inventory: { slots: Array(46).fill(null) },
        waitForTicks: async () => {},
        lookAt: async () => {},
        equip: async item => { bot.heldItem = item; },
        // Forbidden shortcuts: count any use.
        chat: () => { log.forbidden++; },
        dig: async () => { log.forbidden++; },
        creative: new Proxy({}, { get: () => () => { log.forbidden++; } }),
        placeBlock: async (reference, face) => {
            const target = reference.position.plus(face);
            const attempt = log.placements.length + 1;
            log.placements.push({ x: target.x, y: target.y, z: target.z, name: bot.heldItem?.name });
            if (placement.onPlace) placement.onPlace(attempt, bot);
            if (placement.silent?.(target, attempt)) return; // resolves, but nothing lands
            overrides.set(key(target.x, target.y, target.z), bot.heldItem.name);
            const slot = bot.inventory.slots.find(entry => entry?.name === bot.heldItem.name);
            slot.count--;
            if (slot.count <= 0) bot.inventory.slots[bot.inventory.slots.indexOf(slot)] = null;
            // mineflayer often throws although the block landed.
            if (placement.throws?.(target, attempt)) throw new Error('Event blockUpdate did not fire');
        },
    };
    bot.inventory.items = () => bot.inventory.slots.filter(Boolean);
    const give = (name, count) => {
        const existing = bot.inventory.slots.find(entry => entry?.name === name);
        if (existing) { existing.count += count; return; }
        const free = bot.inventory.slots.findIndex((entry, index) => index >= 9 && !entry);
        bot.inventory.slots[free] = { name, count, slot: free };
    };
    for (const [name, count] of Object.entries(inventory)) give(name, count);

    // Stand beside the target so the reach check passes; never digs or scaffolds.
    const navigate = async (_bot, target) => {
        log.navigations++;
        bot.entity.position = new Vec3(target.x + 0.5, 64, target.z + 2.5);
    };
    return { bot, log, give, overrides, key, nameAt, navigate };
}

export const held = (world, name) => world.bot.inventory.slots.filter(slot => slot?.name === name).reduce((sum, slot) => sum + slot.count, 0);

