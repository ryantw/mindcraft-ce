import { spawnSync } from 'child_process';
import mineflayer from 'mineflayer';

const container = process.env.SMOKE_CONTAINER || 'village-m3-smoke';
const port = Number(process.env.SMOKE_PORT || 25567);
const target = process.env.SMOKE_TARGET || 'Wynn';

function rcon(command) {
    const result = spawnSync('docker', ['exec', container, 'rcon-cli', command], { encoding: 'utf8' });
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status !== 0) throw new Error(text || `rcon failed: ${command}`);
    console.log('RCON', command, '=>', text.replace(/\s+/g, ' ').slice(0, 240));
    return text;
}

function posOf(name) {
    const text = rcon(`data get entity ${name} Pos`);
    const match = text.match(/\[([-0-9.]+)d, ([-0-9.]+)d, ([-0-9.]+)d\]/);
    if (!match) throw new Error(`No position in: ${text}`);
    return match.slice(1).map(Number);
}

function near(actual, expected, radius) {
    const dx = actual[0] - expected[0];
    const dy = actual[1] - expected[1];
    const dz = actual[2] - expected[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
}

async function waitUntil(label, predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    username: 'Clerk',
    auth: 'offline',
    version: '1.21.6',
});

bot.once('spawn', async () => {
    try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const home = posOf(target);
        rcon(`tp Clerk ${home[0]} ${home[1]} ${home[2]}`);
        await waitUntil('adjacent to target', () => {
            const other = bot.players[target]?.entity?.position;
            const self = bot.entity?.position;
            if (!other || !self) return false;
            const dx = other.x - self.x;
            const dy = other.y - self.y;
            const dz = other.z - self.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) < 8;
        }, 20000);

        const say = async (message) => {
            console.log('SAY', message);
            bot.chat(message);
            await new Promise(resolve => setTimeout(resolve, 1500));
        };

        if (process.env.SMOKE_FROM !== 'square') {
        await say('!goToRememberedPlace("entrance")');
        await waitUntil('entrance', () => near(posOf(target), [-496, 73, -759], 3), 60000);
        console.log('PASS entrance', posOf(target).join(','));

        await say('!goToRememberedPlace("chest")');
        await waitUntil('chest', () => near(posOf(target), [-495, 73, -761], 4), 60000);
        const before = rcon('clear Wynn bread 0');
        await say('!takeFromChest("bread", 1)');
        await waitUntil('bread in inventory', () => {
            const after = rcon('clear Wynn bread 0');
            return /Found/.test(after) && !/Found 0/.test(after);
        }, 60000);
        console.log('PASS bread', before);

        rcon('difficulty peaceful');
        rcon('time set night');
        await say('!goToBed');
        await waitUntil('sleeping', () => {
            const timer = rcon('data get entity Wynn SleepTimer');
            const value = Number(timer.match(/(-?\d+)s/)?.[1] ?? 0);
            return value > 0;
        }, 90000);
        console.log('PASS bed');
        rcon('time set day');
        rcon('difficulty normal');
        await waitUntil('awake', () => /0s/.test(rcon('data get entity Wynn SleepTimer')), 30000);
        }

        await say('!goToRememberedPlace("square")');
        await waitUntil('square', () => near(posOf(target), [-460, 72, -715], 4), 180000);
        console.log('PASS square', posOf(target).join(','));

        await say('!goToRememberedPlace("home")');
        await waitUntil('home', () => near(posOf(target), [-496, 73, -760], 4), 180000);
        console.log('PASS home', posOf(target).join(','));
        bot.quit();
    } catch (error) {
        console.error('FAIL', error.message);
        bot.quit();
        process.exitCode = 1;
    }
});
bot.on('error', (error) => {
    console.error('BOT', error.message);
    process.exit(1);
});
