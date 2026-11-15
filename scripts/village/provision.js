import { execFile } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';

const { pathfinder, Movements, goals } = pf;
import { Vec3 } from 'vec3';
import settings from '../../settings.js';
import { ScenarioError } from '../../src/village/errors.js';
import { planFurnish } from '../../src/village/furnish.js';
import { loadScenario, resolveScenarioDirectory } from '../../src/village/load.js';
import { datapackFiles } from '../../src/village/placement.js';
import { assertProvisionTarget } from '../../src/village/target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTAINER = 'village-alpha';
const SURVIVAL_DATA = '/home/ryan/minecraft/minecraft-data';
const PROBE = 'PlaceTest';
const INSPECTOR = 'Surveyor';
const HOSTILES = ['zombie', 'skeleton', 'spider', 'creeper', 'witch', 'husk', 'drowned', 'zombie_villager', 'slime', 'phantom', 'cave_spider', 'stray'];

function fail(message) {
    throw new ScenarioError(message);
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            const output = `${stdout || ''}${stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '').trim();
            if (error && !output) {
                reject(error);
                return;
            }
            resolve({ output, code: error ? error.code ?? 1 : 0 });
        });
    });
}

async function rcon(command) {
    const result = await run('docker', ['exec', CONTAINER, 'rcon-cli', command]);
    return result.output;
}

async function rconResult(command) {
    return run('docker', ['exec', CONTAINER, 'rcon-cli', command]);
}

async function reloadPack() {
    const enabled = await rconResult('datapack enable "file/village_alpha_placement"');
    if (enabled.code !== 0 && !/already enabled/i.test(enabled.output)) {
        fail(`Could not enable the placement datapack: ${enabled.output}`);
    }
    const reloaded = await rconOk('reload confirm');
    if (!/Reload complete/i.test(reloaded)) fail(`Datapack reload did not complete: ${reloaded}`);
}

async function rconOk(command) {
    const result = await rconResult(command);
    if (result.code !== 0) fail(`Command failed: ${command}\n${result.output}`);
    return result.output;
}

function dataDir() {
    if (process.env.VILLAGE_DATA_DIR) return process.env.VILLAGE_DATA_DIR;
    const file = path.join(ROOT, 'services', 'village-alpha', '.env');
    const line = readFileSync(file, 'utf8').split('\n').find(entry => entry.startsWith('VILLAGE_DATA_DIR='));
    if (!line) fail('Set VILLAGE_DATA_DIR.');
    return line.slice('VILLAGE_DATA_DIR='.length).trim();
}

function parsePublishedPorts(json) {
    const bindings = JSON.parse(json);
    const ports = [];
    for (const [containerPort, hosts] of Object.entries(bindings || {})) {
        const container = Number(containerPort.split('/')[0]);
        for (const host of hosts || []) {
            ports.push({ hostIp: host.HostIp, hostPort: Number(host.HostPort), containerPort: container });
        }
    }
    return ports;
}

async function readTarget(dir) {
    const inspected = (await run('docker', ['inspect', CONTAINER])).output;
    const info = JSON.parse(inspected)[0];
    const dataMount = (info.Mounts || []).find(mount => mount.Destination === '/data');
    if (!dataMount) fail('Village container has no /data mount.');
    if (path.resolve(dataMount.Source) !== path.resolve(dir)) fail(`Village data mount is ${dataMount.Source}, not ${dir}.`);
    return assertProvisionTarget({
        scenarioPort: 25566,
        survivalPort: settings.port,
        dataDir: dir,
        survivalDataDir: SURVIVAL_DATA,
        containerName: info.Name.replace(/^\//, ''),
        publishedPorts: parsePublishedPorts(JSON.stringify(info.HostConfig.PortBindings)),
    });
}

function receiptPath(dir) {
    return path.join(dir, 'village-provision.json');
}

function packRoot(dir) {
    return path.join(dir, 'world', 'datapacks', 'village_alpha_placement');
}

function writePack(dir, files) {
    const root = packRoot(dir);
    for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents);
    }
}

function offlineUuid(name) {
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function forgetPlayer(dir, name) {
    const id = offlineUuid(name);
    for (const suffix of ['.dat', '.dat_old']) {
        const file = path.join(dir, 'world', 'playerdata', `${id}${suffix}`);
        if (existsSync(file)) rmSync(file);
    }
    const cache = path.join(dir, 'usercache.json');
    if (!existsSync(cache)) return;
    const entries = JSON.parse(readFileSync(cache, 'utf8'));
    writeFileSync(cache, JSON.stringify(entries.filter(entry => entry.name !== name), null, 2));
}

function reservedNames() {
    const names = [];
    for (const profilePath of settings.profiles || []) {
        try {
            const profile = JSON.parse(readFileSync(path.resolve(ROOT, profilePath), 'utf8'));
            if (profile.name) names.push(profile.name);
        } catch {
            // A missing survival profile must not block village provisioning.
        }
    }
    return names;
}

async function isBlock(x, y, z, name) {
    const result = await rconResult(`execute if block ${x} ${y} ${z} minecraft:${name}`);
    return result.output.includes('Test passed');
}

async function placeBlock(entry) {
    const [x, y, z] = entry.at;
    if (await isBlock(x, y, z, entry.block)) return;
    if (['chest', 'furnace', 'crafting_table', 'lantern', 'poppy', 'dandelion'].includes(entry.block)) {
        if (await isBlock(x, y - 1, z, 'air')) fail(`Refusing to place ${entry.block} at ${x} ${y} ${z} with air underneath.`);
    }
    for (const name of entry.allow) {
        if (await isBlock(x, y, z, name)) {
            await rconOk(`setblock ${x} ${y} ${z} minecraft:${entry.block}`);
            if (!await isBlock(x, y, z, entry.block)) fail(`Block at ${x} ${y} ${z} is not ${entry.block} after placement.`);
            return;
        }
    }
    fail(`Refusing to replace the block at ${x} ${y} ${z}. It is not an allowed ${entry.allow.join(' or ')} for ${entry.block}.`);
}

async function writeChest(chest) {
    const [x, y, z] = chest.at;
    if (!await isBlock(x, y, z, 'chest')) fail(`Chest missing at ${x} ${y} ${z}.`);
    await rconResult(`data remove block ${x} ${y} ${z} LootTable`);
    await rconResult(`data remove block ${x} ${y} ${z} LootTableSeed`);
    await rconOk(`data merge block ${x} ${y} ${z} {Items:[]}`);
    for (let index = 0; index < chest.stacks.length; index++) {
        const stack = chest.stacks[index];
        if (!/^[a-z0-9_]+$/.test(stack.item) || !Number.isInteger(stack.count)) fail(`Bad stack ${stack.item}.`);
        await rconOk(`item replace block ${x} ${y} ${z} container.${index} with minecraft:${stack.item} ${stack.count}`);
    }
}

async function readChest(chest) {
    const [x, y, z] = chest.at;
    const found = [];
    for (let index = 0; index < chest.stacks.length; index++) {
        const id = await rconResult(`data get block ${x} ${y} ${z} Items[${index}].id`);
        const count = await rconResult(`data get block ${x} ${y} ${z} Items[${index}].count`);
        const item = (id.output.match(/minecraft:([a-z0-9_]+)/) || [])[1];
        const amount = Number((count.output.match(/(\d+)\s*$/) || [])[1]);
        found.push(`${item}:${amount}`);
    }
    const extra = await rconResult(`data get block ${x} ${y} ${z} Items[${chest.stacks.length}].id`);
    if (/minecraft:[a-z0-9_]+/.test(extra.output)) fail(`Chest ${chest.plot_id} has an extra stack past the manifest.`);
    const expected = chest.stacks.map(stack => `${stack.item}:${stack.count}`);
    if (found.join(',') !== expected.join(',')) {
        fail(`Chest ${chest.plot_id} at ${x} ${y} ${z} holds [${found.join(', ')}], expected [${expected.join(', ')}].`);
    }
    return found;
}

async function assertStanding(label, at) {
    const [x, y, z] = at;
    if (!await isBlock(x, y, z, 'air')) fail(`${label} standing spot ${x} ${y} ${z} is not air.`);
    if (await isBlock(x, y - 1, z, 'air')) fail(`${label} standing spot ${x} ${y} ${z} has no floor.`);
    if (!await isBlock(x, y + 1, z, 'air')) fail(`${label} standing spot ${x} ${y} ${z} has no headroom.`);
}

function connect(username) {
    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: 25566, username, auth: 'offline', version: '1.21.6',
    });
    bot.loadPlugin(pathfinder);
    bot.on('error', error => console.error(username, error.message));
    return bot;
}

function waitSpawn(bot) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new ScenarioError(`${bot.username} did not spawn.`)), 30000);
        bot.once('spawn', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function waitNear(bot, x, z, ms = 8000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
        const pos = bot.entity?.position;
        if (pos && Math.abs(pos.x - x) < 4 && Math.abs(pos.z - z) < 4) return pos;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    fail(`${bot.username} did not arrive near ${x} ${z}. Last position ${bot.entity?.position}`);
}

async function checkRoutes(plan) {
    const bot = connect(INSPECTOR);
    await waitSpawn(bot);
    await rconOk(`gamemode survival ${INSPECTOR}`);
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.canOpenDoors = true;
    movements.allowEntityDetection = false;
    const [sx, sy, sz] = plan.publics.find(place => place.id === 'square').marker;
    const goal = new goals.GoalNear(sx, sy, sz, 2);
    try {
        for (const house of plan.houses) {
            const [x, y, z] = house.home_marker;
            await rconOk(`tp ${INSPECTOR} ${x} ${y} ${z}`);
            await waitNear(bot, x, z);
            await new Promise(resolve => setTimeout(resolve, 2000));
            const feet = bot.entity.position.floored();
            const blockLight = bot.world.getBlockLight(feet);
            const skyLight = bot.world.getSkyLight(feet);
            const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, {
                timeout: 30000,
                tickTimeout: 40,
                searchRadius: 160,
            });
            let route;
            for (const step of generator) {
                route = step.result;
                if (route.status !== 'partial') break;
            }
            if (route.status !== 'success') fail(`No walk from ${house.plot_id} to the square without breaking blocks (${route.status}, ${route.path.length} nodes).`);
            console.log(`route ${house.plot_id} ${route.path.length} nodes, block light ${blockLight}, sky ${skyLight}`);
        }
    } finally {
        bot.end();
    }
}

async function provePlacement(dir, plan) {
    const vacant = plan.houses.find(house => plan.chests.find(chest => chest.plot_id === house.plot_id && !chest.occupied));
    const files = datapackFiles(plan.arrivals);
    const [hx, hy, hz] = vacant.home_marker;
    const [bx, by, bz] = vacant.bed;
    const who = `@a[name=${PROBE},tag=!village_placed]`;
    files['data/village_alpha/function/place_first.mcfunction'] += [
        `execute as ${who} run tp @s ${hx} ${hy} ${hz}`,
        `execute as ${who} run spawnpoint @s ${bx} ${by} ${bz}`,
        `execute as ${who} run tag @s add village_placed`,
        '',
    ].join('\n');
    writePack(dir, files);
    await reloadPack();
    await rcon(`kick ${PROBE} reset-probe`);
    await rconOk('save-all');
    await new Promise(resolve => setTimeout(resolve, 500));
    forgetPlayer(dir, PROBE);
    const [sx, sy, sz] = plan.publics.find(place => place.id === 'square').marker;
    const first = connect(PROBE);
    try {
        await waitSpawn(first);
        await waitNear(first, hx, hz, 8000);
    } catch (error) {
        const placed = first.entity?.position;
        first.end();
        fail(`${PROBE} was not placed at the vacant home (${placed ? `${placed.x.toFixed(1)} ${placed.y.toFixed(1)} ${placed.z.toFixed(1)}` : 'no position'}). ${error.message}`);
    }
    await rconOk(`tp ${PROBE} ${sx} ${sy} ${sz}`);
    await waitNear(first, sx, sz);
    first.end();
    await new Promise(resolve => first.once('end', resolve));
    await rconOk('save-all');
    console.log(`${PROBE} placed once at the vacant home, then moved to the square.`);
    return { home: [hx, hy, hz], square: [sx, sy, sz] };
}

async function rejoinCheck(dir, plan, pending) {
    const bot = connect(PROBE);
    let stayed;
    try {
        await waitSpawn(bot);
        await new Promise(resolve => setTimeout(resolve, 1500));
        stayed = bot.entity.position;
    } finally {
        bot.end();
    }
    const [hx, hy, hz] = pending.home;
    const [sx, sy, sz] = pending.square;
    const homeAgain = stayed.distanceTo(new Vec3(hx + 0.5, hy, hz + 0.5));
    const square = stayed.distanceTo(new Vec3(sx + 0.5, sy, sz + 0.5));
    if (homeAgain < 3 || square > 4) fail(`${PROBE} second join moved (${stayed.x.toFixed(1)} ${stayed.y.toFixed(1)} ${stayed.z.toFixed(1)}).`);
    writePack(dir, datapackFiles(plan.arrivals));
    await reloadPack();
    await rcon(`kick ${PROBE} placement-check-finished`);
    await rconOk('save-all');
    await new Promise(resolve => setTimeout(resolve, 1000));
    forgetPlayer(dir, PROBE);
    console.log('placement tag sticks across a reconnect');
}

function writeScenarioVillage(bundle, plan, verifiedAt, numericSeed) {
    const village = bundle.village;
    const houses = new Map(plan.houses.map(house => [house.plot_id, house]));
    for (const plot of village.plots) {
        const house = houses.get(plot.id);
        plot.home_marker = house.home_marker;
        plot.bed = house.bed;
        plot.door = house.door;
        plot.chest = house.chest;
        plot.crafting_table = house.crafting_table;
        plot.furnace = house.furnace;
    }
    const publics = new Map(plan.publics.map(place => [place.id, place]));
    for (const place of village.public) {
        const measured = publics.get(place.id);
        place.marker = measured.marker;
        if (measured.chest) place.chest = measured.chest;
        else delete place.chest;
        if (measured.notes) place.notes = measured.notes;
    }
    village.notes = `Plains village generated by seed ${plan.seed} (numeric ${numericSeed}) and furnished once on ${verifiedAt}. Beds, doors, paths, crops, and the pond were already in the world. Chests were filled once from the manifest. Restart does not rebuild or refill.`;
    village.provision = {
        version: 1,
        method: plan.method,
        seed: plan.seed,
        floor_block_y: plan.floor_block_y,
        origin: plan.origin,
        verified_at: verifiedAt,
    };
    writeFileSync(path.join(bundle.directory, 'village.json'), `${JSON.stringify(village, null, 2)}\n`);
}

async function applyRules(plan) {
    const [ox, oy, oz] = plan.origin;
    await rconOk(`forceload add ${ox - 80} ${oz - 80} ${ox + 80} ${oz + 80}`);
    await rconOk('gamerule showDeathMessages false');
    await rconOk('gamerule keepInventory false');
    await rconOk('gamerule doDaylightCycle true');
    await rconOk('gamerule doWeatherCycle true');
    await rconOk('gamerule doMobSpawning true');
    await rconOk('gamerule mobGriefing true');
    await rconOk('difficulty normal');
    await rconOk('defaultgamemode survival');
    const square = plan.publics.find(place => place.id === 'square').marker;
    await rconOk(`setworldspawn ${square[0]} ${square[1]} ${square[2]}`);
    await rconOk('time set day');
    await rconOk('weather clear');
    const killed = await rconResult(`execute positioned ${ox} ${oy} ${oz} run kill @e[type=minecraft:villager,distance=..160]`);
    console.log('villagers', killed.output.split('\n').pop());
    for (const type of HOSTILES) {
        await rconResult(`execute positioned ${ox} ${oy} ${oz} run kill @e[type=minecraft:${type},distance=..120]`);
    }
}

async function verifyWorld(plan) {
    for (const house of plan.houses) {
        const [bx, by, bz] = house.bed;
        const [dx, dy, dz] = house.door;
        if (!await isBlock(bx, by, bz, house.expect.bed)) fail(`${house.plot_id} bed is not ${house.expect.bed}.`);
        if (!await isBlock(dx, dy, dz, house.expect.door)) fail(`${house.plot_id} door is not ${house.expect.door}.`);
        for (const point of ['chest', 'crafting_table', 'furnace', 'lantern']) {
            const [x, y, z] = house[point];
            const expected = point === 'crafting_table' ? 'crafting_table' : point === 'lantern' ? 'lantern' : point === 'furnace' ? 'furnace' : 'chest';
            if (!await isBlock(x, y, z, expected)) fail(`${house.plot_id} ${point} is missing at ${x} ${y} ${z}.`);
        }
        await assertStanding(house.plot_id, house.home_marker);
    }
    for (const place of plan.publics) await assertStanding(place.id, place.marker);
    const signatures = {};
    for (const chest of plan.chests) signatures[chest.plot_id] = await readChest(chest);
    const deaths = await rconOk('gamerule showDeathMessages');
    if (!/false/.test(deaths)) fail(`showDeathMessages is not false: ${deaths}`);
    const difficulty = await rconOk('difficulty');
    if (!/normal/i.test(difficulty)) fail(`Difficulty is not normal: ${difficulty}`);
    return signatures;
}

async function main() {
    const verifyOnly = process.argv.includes('--verify-only');
    const reprovision = process.argv.includes('--reprovision');
    const confirmErase = process.argv.includes('--confirm-erase');
    const bundle = loadScenario(resolveScenarioDirectory('village-alpha', ROOT), {
        reservedNames: reservedNames(),
        forLaunch: true,
    });
    if (bundle.scenario.connection.host !== '127.0.0.1' || bundle.scenario.connection.port !== 25566) {
        fail('village-alpha must point at 127.0.0.1:25566.');
    }
    const site = JSON.parse(readFileSync(path.join(bundle.directory, 'site.json'), 'utf8'));
    const plan = planFurnish(bundle.village, site, bundle.inhabitants);
    const dir = dataDir();
    await readTarget(dir);
    const receiptFile = receiptPath(dir);
    const pendingFile = path.join(dir, 'placement-pending.json');
    if (process.argv.includes('--rejoin-check')) {
        if (!existsSync(pendingFile)) fail('No placement is waiting for a reconnect check.');
        const pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
        await rejoinCheck(dir, plan, pending);
        writeScenarioVillage(bundle, plan, pending.verified_at, pending.numeric_seed);
        const receipt = {
            version: 1,
            method: plan.method,
            seed: plan.seed,
            numeric_seed: pending.numeric_seed,
            origin: plan.origin,
            floor_block_y: plan.floor_block_y,
            verified_at: pending.verified_at,
            container: CONTAINER,
            port: 25566,
            chests: pending.chests,
        };
        writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
        rmSync(pendingFile);
        console.log(`provisioned ${pending.verified_at}`);
        return;
    }
    if (verifyOnly) {
        if (!existsSync(receiptFile)) fail('Nothing has been provisioned. Refusing to verify an empty receipt.');
        const [ox, , oz] = plan.origin;
        await rconOk(`forceload add ${ox - 80} ${oz - 80} ${ox + 80} ${oz + 80}`);
        try {
            const signatures = await verifyWorld(plan);
            console.log('verified', JSON.stringify(signatures));
        } finally {
            await rconResult('forceload remove all');
        }
        return;
    }
    if (existsSync(receiptFile) && !reprovision) {
        console.log(`Receipt already exists at ${receiptFile}. Startup does not rebuild or refill. Use --reprovision --confirm-erase to apply the site again.`);
        return;
    }
    if (reprovision && !confirmErase) fail('Refusing to reprovision without --confirm-erase. That would refill chests.');
    await rcon(`kick ${INSPECTOR} provisioning`);
    await rcon(`kick ${PROBE} provisioning`);
    const online = await rconOk('list');
    if (!/There are 0 of/.test(online)) fail(`Refusing to provision while players are online: ${online}`);
    try {
        await applyRules(plan);
        for (const house of plan.houses) {
            const [bx, by, bz] = house.bed;
            const [dx, dy, dz] = house.door;
            if (!await isBlock(bx, by, bz, house.expect.bed)) fail(`Expected ${house.expect.bed} at ${house.plot_id} bed before furnishing.`);
            if (!await isBlock(dx, dy, dz, house.expect.door)) fail(`Expected ${house.expect.door} at ${house.plot_id} door before furnishing.`);
        }
        for (const entry of plan.places) await placeBlock(entry);
        for (const chest of plan.chests) await writeChest(chest);
        const signatures = await verifyWorld(plan);
        await checkRoutes(plan);
        const verifiedAt = new Date().toISOString();
        const seedLine = await rconOk('seed');
        const numeric = (seedLine.match(/\[(-?\d+)\]/) || [])[1] || seedLine;
        writePack(dir, datapackFiles(plan.arrivals));
        await reloadPack();
        const placement = await provePlacement(dir, plan);
        writeFileSync(pendingFile, `${JSON.stringify({
            ...placement,
            verified_at: verifiedAt,
            numeric_seed: numeric,
            chests: signatures,
        }, null, 2)}\n`);
        console.log('ready-for-rejoin');
    } finally {
        await rconResult('forceload remove all').catch(() => {});
        await rconResult(`kick ${INSPECTOR} provisioning-finished`).catch(() => {});
        await rconResult(`kick ${PROBE} provisioning-finished`).catch(() => {});
        await rconResult('save-all').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        forgetPlayer(dir, INSPECTOR);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
