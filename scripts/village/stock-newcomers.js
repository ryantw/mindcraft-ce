import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ScenarioError } from '../../src/village/errors.js';
import { loadScenario, resolveScenarioDirectory } from '../../src/village/load.js';
import {
    RECEIPT_NAME,
    chestIsEmpty,
    planNewcomerStock,
} from '../../src/village/newcomer_stock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTAINER = 'village-alpha';
const SURVIVAL_DATA = '/home/ryan/minecraft/minecraft-data';

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

async function rconResult(command) {
    return run('docker', ['exec', CONTAINER, 'rcon-cli', command]);
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

async function assertVillageContainer(dir) {
    const inspected = (await run('docker', ['inspect', CONTAINER])).output;
    const info = JSON.parse(inspected)[0];
    const name = info.Name.replace(/^\//, '');
    if (name !== CONTAINER) fail(`Refusing to stock container ${name}.`);
    const dataMount = (info.Mounts || []).find(mount => mount.Destination === '/data');
    if (!dataMount) fail('Village container has no /data mount.');
    if (path.resolve(dataMount.Source) !== path.resolve(dir)) fail(`Village data mount is ${dataMount.Source}, not ${dir}.`);
    if (path.resolve(dir) === path.resolve(SURVIVAL_DATA) || path.resolve(dir).startsWith(path.resolve(SURVIVAL_DATA) + path.sep)) {
        fail('Refusing to stock the survival world.');
    }
}

async function assertNobodyPlaying() {
    const listed = await rconOk('list');
    if (!/^There are 0 of a max of 20 players online:\s*$/.test(listed)) {
        fail(`Refusing to stock chests while players are online: ${listed}`);
    }
    const processes = await run('ps', ['-eo', 'args']);
    if (/node .*main\.js/.test(processes.output)) fail('Refusing to stock chests while the agent manager is running.');
}

async function isBlock(x, y, z, name) {
    const result = await rconResult(`execute if block ${x} ${y} ${z} minecraft:${name}`);
    return result.output.includes('Test passed');
}

async function assertFixtures(targets) {
    for (const target of targets) {
        for (const fixture of target.fixtures) {
            const [x, y, z] = fixture.at;
            if (!await isBlock(x, y, z, fixture.block)) {
                fail(`${target.plotId} ${fixture.block} is missing at ${x} ${y} ${z}.`);
            }
        }
    }
}

async function readItems(chest) {
    const [x, y, z] = chest;
    const result = await rconResult(`data get block ${x} ${y} ${z} Items`);
    if (result.code !== 0) fail(`Could not read chest at ${x} ${y} ${z}: ${result.output}`);
    return result.output;
}

async function snapshotChests(chests) {
    const found = {};
    for (const chest of chests) {
        found[chest.id] = await readItems(chest.chest);
    }
    return found;
}

function sameSnapshot(before, after) {
    const keys = Object.keys(before);
    if (keys.join() !== Object.keys(after).join()) return false;
    return keys.every(key => before[key] === after[key]);
}

async function snapshotRemains() {
    const positions = await rconResult('execute as @e[type=minecraft:armor_stand,tag=village_remains] run data get entity @s Pos');
    const names = await rconResult('execute as @e[type=minecraft:armor_stand,tag=village_remains] run data get entity @s CustomName');
    const lines = `${positions.output}\n${names.output}`.split('\n').map(line => line.trim()).filter(Boolean).sort();
    return lines.join('\n');
}

async function writeChest(target) {
    const [x, y, z] = target.chest;
    if (!await isBlock(x, y, z, 'chest')) fail(`Chest missing at ${x} ${y} ${z}.`);
    const current = await readItems(target.chest);
    if (!chestIsEmpty(current)) fail(`${target.plotId} at ${x} ${y} ${z} is not empty: ${current}`);
    await rconResult(`data remove block ${x} ${y} ${z} LootTable`);
    await rconResult(`data remove block ${x} ${y} ${z} LootTableSeed`);
    await rconOk(`data merge block ${x} ${y} ${z} {Items:[]}`);
    for (let index = 0; index < target.stacks.length; index++) {
        const stack = target.stacks[index];
        if (!/^[a-z0-9_]+$/.test(stack.item) || !Number.isInteger(stack.count)) fail(`Bad stack ${stack.item}.`);
        await rconOk(`item replace block ${x} ${y} ${z} container.${index} with minecraft:${stack.item} ${stack.count}`);
    }
}

async function readChest(target) {
    const [x, y, z] = target.chest;
    const found = [];
    for (let index = 0; index < target.stacks.length; index++) {
        const id = await rconResult(`data get block ${x} ${y} ${z} Items[${index}].id`);
        const count = await rconResult(`data get block ${x} ${y} ${z} Items[${index}].count`);
        const item = (id.output.match(/minecraft:([a-z0-9_]+)/) || [])[1];
        const amount = Number((count.output.match(/(\d+)\s*$/) || [])[1]);
        found.push(`${item}:${amount}`);
    }
    const extra = await rconResult(`data get block ${x} ${y} ${z} Items[${target.stacks.length}].id`);
    if (/minecraft:[a-z0-9_]+/.test(extra.output)) fail(`Chest ${target.plotId} has an extra stack past the manifest.`);
    const expected = target.stacks.map(stack => `${stack.item}:${stack.count}`);
    if (found.join(',') !== expected.join(',')) {
        fail(`Chest ${target.plotId} at ${x} ${y} ${z} holds [${found.join(', ')}], expected [${expected.join(', ')}].`);
    }
    return found;
}

function placementPath(dir) {
    return path.join(dir, 'world', 'datapacks', 'village_alpha_placement', 'data', 'village_alpha', 'function', 'place_first.mcfunction');
}

async function main() {
    if (process.argv.includes('--reprovision') || process.argv.includes('--confirm-erase')) {
        fail('This operation does not accept --reprovision or --confirm-erase.');
    }
    const confirm = process.argv.includes('--confirm');
    const bundle = loadScenario(resolveScenarioDirectory('village-alpha', ROOT), { forLaunch: true });
    const site = JSON.parse(readFileSync(path.join(bundle.directory, 'site.json'), 'utf8'));
    const dir = dataDir();
    const receiptFile = path.join(dir, RECEIPT_NAME);
    const placementFile = placementPath(dir);
    const placementText = existsSync(placementFile) ? readFileSync(placementFile, 'utf8') : '';
    const plan = planNewcomerStock(bundle.village, site, placementText, { receiptExists: existsSync(receiptFile) });
    if (!plan.refill) {
        console.log(plan.reason);
        return;
    }
    if (!confirm) {
        for (const target of plan.targets) {
            console.log(`${target.name} ${target.plotId} chest ${target.chest.join(' ')}: ${target.stacks.map(stack => `${stack.item}x${stack.count}`).join(', ')}`);
        }
        console.log(`placement ${plan.placement.action}`);
        console.log('Dry run. Pass --confirm to write the three chests and append placement lines.');
        return;
    }
    await assertVillageContainer(dir);
    await assertNobodyPlaying();
    const origin = bundle.village.provision.origin;
    const [ox, , oz] = origin;
    let forceloadHeld = false;
    try {
        await rconOk(`forceload add ${ox - 80} ${oz - 80} ${ox + 80} ${oz + 80}`);
        forceloadHeld = true;
        await assertNobodyPlaying();
        const beforeChests = await snapshotChests(plan.preserve);
        const beforeRemains = await snapshotRemains();
        for (const target of plan.targets) {
            const items = await readItems(target.chest);
            if (!chestIsEmpty(items)) fail(`${target.plotId} is not empty: ${items}`);
        }
        await assertFixtures(plan.targets);
        await assertNobodyPlaying();
        const signatures = {};
        for (const target of plan.targets) {
            await assertNobodyPlaying();
            await writeChest(target);
            signatures[target.plotId] = await readChest(target);
            console.log(`filled ${target.plotId}`, signatures[target.plotId].join(', '));
        }
        const afterChests = await snapshotChests(plan.preserve);
        if (!sameSnapshot(beforeChests, afterChests)) fail('Another chest changed during the newcomer fill. Refusing to record success.');
        const afterRemains = await snapshotRemains();
        if (beforeRemains !== afterRemains) fail('A memorial marker changed during the newcomer fill. Refusing to record success.');
        await assertFixtures(plan.targets);
        if (plan.placement.action === 'append') {
            if (readFileSync(placementFile, 'utf8') !== placementText) fail('Placement function changed underfoot. Refusing to edit it.');
            writeFileSync(placementFile, plan.placement.text);
        }
        if (readFileSync(placementFile, 'utf8') !== plan.placement.text) fail('Placement function does not match the approved text.');
        const reloaded = await rconOk('reload confirm');
        if (!/Reload complete/i.test(reloaded)) fail(`Datapack reload did not complete: ${reloaded}`);
        const packs = await rconOk('datapack list');
        if (!packs.includes('village_alpha_placement')) fail(`Placement datapack is not loaded: ${packs}`);
        await assertNobodyPlaying();
        const ran = await rconOk('function village_alpha:place_first');
        console.log('placement', ran);
        await assertFixtures(plan.targets);
        for (const target of plan.targets) signatures[target.plotId] = await readChest(target);
        await rconOk('save-all');
        const receipt = {
            version: 1,
            kind: 'newcomer-stock',
            scenario: 'village-alpha',
            refill: 'never',
            filled_at: new Date().toISOString(),
            container: CONTAINER,
            plots: plan.targets.map(target => target.plotId),
            inhabitants: plan.targets.map(target => target.inhabitantId),
            chests: signatures,
            placement_file: path.relative(dir, placementFile),
            placement_action: plan.placement.action,
        };
        writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
        console.log(`recorded ${receiptFile}`);
    } finally {
        if (forceloadHeld) {
            await rconResult(`forceload remove ${ox - 80} ${oz - 80} ${ox + 80} ${oz + 80}`).catch(() => {});
        }
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
