import fs from 'fs';
import mineflayer from 'mineflayer';

const target = process.argv.slice(2).map(Number);
const [x, y, z] = target.length === 3 ? target : [-448, 76, -720];
const outPath = process.env.SURVEY_OUT || '/tmp/village-survey.json';

function run(command) {
    return new Promise((resolve, reject) => {
        import('child_process').then(({ execFile }) => {
            execFile('docker', ['exec', 'village-alpha', 'rcon-cli', command], { timeout: 120000 }, (error, stdout, stderr) => {
                const output = `${stdout || ''}${stderr || ''}`.trim();
                if (error && !output) reject(error);
                else resolve(output);
            });
        });
    });
}

const KEEP = /(_bed|_door|_sign)$|^(bell|farmland|chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|dirt_path|composter|campfire|soul_campfire|lantern|soul_lantern|torch|wall_torch|wheat|carrots|potatoes|beetroots|hay_block|poppy|dandelion|cornflower|azure_bluet|oxeye_daisy|lily_of_the_valley|blue_orchid|allium|orange_tulip|pink_tulip|red_tulip|white_tulip|cobblestone_wall|oak_fence|lectern|grindstone|stonecutter|loom|cartography_table|fletching_table|smithing_table|cauldron|brewing_stand)$/;

function props(block) {
    try {
        return block.getProperties?.() || {};
    } catch {
        return {};
    }
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: 'Surveyor', auth: 'offline', version: '1.21.6',
});

function waitUntil(predicate, ms) {
    const started = Date.now();
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (predicate() || Date.now() - started > ms) {
                clearInterval(timer);
                resolve();
            }
        }, 200);
    });
}

bot.once('spawn', async () => {
    const points = [];
    const seen = new Map();
    try {
        await run('gamemode creative Surveyor');
        await run(`forceload add ${x - 160} ${z - 160} ${x + 32} ${z + 32}`);
        await run(`forceload add ${x - 32} ${z - 32} ${x + 160} ${z + 160}`);
        for (const dx of [-80, 0, 80]) {
            for (const dz of [-80, 0, 80]) points.push([x + dx, y, z + dz]);
        }
        for (const [px, py, pz] of points) {
            await run(`tp Surveyor ${px} ${py} ${pz}`);
            await waitUntil(() => {
                const pos = bot.entity.position;
                return Math.abs(pos.x - px) < 6 && Math.abs(pos.z - pz) < 6;
            }, 8000);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const found = bot.findBlocks({ matching: block => KEEP.test(block.name), maxDistance: 56, count: 5000 });
            for (const pos of found) {
                const block = bot.blockAt(pos);
                if (!block) continue;
                const key = `${pos.x},${pos.y},${pos.z}`;
                if (seen.has(key)) continue;
                const properties = props(block);
                seen.set(key, { x: pos.x, y: pos.y, z: pos.z, name: block.name, part: properties.part || properties.half || null, facing: properties.facing || null });
            }
            console.log('scanned', px, pz, 'unique', seen.size);
        }
        const blocks = [...seen.values()];
        const summary = {};
        for (const block of blocks) summary[block.name] = (summary[block.name] || 0) + 1;
        const beds = blocks.filter(block => block.name.endsWith('_bed') && block.part !== 'head');
        const doors = blocks.filter(block => block.name.endsWith('_door') && block.part !== 'upper');
        const report = {
            center: [x, y, z],
            summary,
            beds,
            doors,
            bells: blocks.filter(block => block.name === 'bell'),
            chests: blocks.filter(block => block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'barrel'),
            work: blocks.filter(block => ['furnace', 'blast_furnace', 'smoker', 'crafting_table', 'composter', 'lectern', 'grindstone', 'stonecutter', 'loom', 'cartography_table', 'fletching_table', 'smithing_table', 'cauldron', 'brewing_stand', 'campfire', 'soul_campfire'].includes(block.name)),
            crops: blocks.filter(block => ['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'hay_block'].includes(block.name)),
            flowers: blocks.filter(block => ['poppy', 'dandelion', 'cornflower', 'azure_bluet', 'oxeye_daisy', 'lily_of_the_valley', 'blue_orchid', 'allium', 'orange_tulip', 'pink_tulip', 'red_tulip', 'white_tulip'].includes(block.name)),
            paths: blocks.filter(block => block.name === 'dirt_path'),
        };
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(summary, null, 2));
        console.log('beds', beds.map(block => `${block.x},${block.y},${block.z}:${block.name}:${block.facing}`).join(' | '));
        console.log('doors', doors.map(block => `${block.x},${block.y},${block.z}:${block.facing}`).join(' | '));
        console.log('bells', report.bells.map(block => `${block.x},${block.y},${block.z}`).join(' | '));
        console.log('wrote', outPath);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        bot.end();
        setTimeout(() => process.exit(process.exitCode || 0), 400);
    }
});
bot.on('error', error => {
    console.error(error);
    process.exit(1);
});
