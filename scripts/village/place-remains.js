import { assertRemainsTarget, planRemains } from '../../src/village/remains.js';

/**
 * Operator-only. Prints the armor-stand placement for a death that already
 * has a safe site. It does not run unless --execute is present, and the
 * guard refuses the survival world. Village Alpha also requires
 * --allow-village-alpha. Inhabitants never receive this command.
 *
 * Example, against a disposable server only:
 *   node scripts/village/place-remains.js --container village-m3-smoke --data-dir /home/ryan/minecraft/village-m3-smoke-data --name TestOne --x 0 --y 64 --z 0 --block grass_block --execute
 */
function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

if (!/^[A-Za-z0-9_]{3,16}$/.test(arg('--name') || '')) {
    console.error('Name must be a Minecraft username.');
    process.exit(1);
}

const container = arg('--container');
const dataDir = arg('--data-dir');
const name = arg('--name');
const block = arg('--block');
const position = {
    x: Number(arg('--x')),
    y: Number(arg('--y')),
    z: Number(arg('--z')),
};

try {
    assertRemainsTarget({
        container,
        dataDir,
        allowVillageAlpha: process.argv.includes('--allow-village-alpha'),
    });
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const plan = planRemains({
    position,
    dimension: 'overworld',
    name,
    site: { block },
});
if (plan.status !== 'planned') {
    console.error(`No remains placed: ${plan.reason}`);
    process.exit(2);
}

const command = `summon minecraft:armor_stand ${plan.position.x} ${plan.position.y} ${plan.position.z} {CustomName:'{"text":"${plan.name}"}',CustomNameVisible:1b,Marker:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["village_remains"],DisabledSlots:4144959}`;
console.log(command);
if (!process.argv.includes('--execute')) {
    console.log('Not executed. Pass --execute to send this command to the named container.');
    process.exit(0);
}

const { spawnSync } = await import('child_process');
const result = spawnSync('docker', ['exec', container, 'rcon-cli', command], { encoding: 'utf8' });
if (result.status !== 0) {
    console.error(result.stderr || result.stdout || 'rcon failed');
    process.exit(result.status || 1);
}
console.log(result.stdout.trim());
