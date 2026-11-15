import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { pathfinder, goals } = require('mineflayer-pathfinder');
const { CollectBlock } = require('mineflayer-collectblock');
const { Vec3 } = require('vec3');
const minecraftData = require('minecraft-data');
const diggingPlugin = require('mineflayer/lib/plugins/digging.js');
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils.js');

const registry = minecraftData('1.21.6');

function createBot() {
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.entity = {
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
        yaw: 0,
        pitch: 0,
        onGround: true,
        effects: {}
    };
    bot.inventory = {
        items: () => [],
        emptySlotCount: () => 36
    };
    bot.clearControlStates = () => {};
    bot.controlState = {};
    bot.blockAt = () => null;
    bot.heldItem = null;
    bot.tool = { equipForBlock: async () => {} };
    bot.world = {};
    bot.output = '';
    return bot;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('pathfinder.stop rejects an active goto without physics ticks', async () => {
    const bot = createBot();
    pathfinder(bot);
    const pending = bot.pathfinder.goto(new goals.GoalBlock(8, 64, 8));
    const started = Date.now();

    bot.pathfinder.stop();

    await assert.rejects(pending, (err) => err.name === 'PathStopped');
    assert.ok(Date.now() - started < 500);
    assert.equal(bot.pathfinder.goal, null);
});

test('a timed-out path with somewhere to walk does not abort goto', async () => {
    const bot = createBot();
    pathfinder(bot);
    const pending = bot.pathfinder.goto(new goals.GoalBlock(30, 64, 0));
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    bot.emit('path_update', { status: 'partial', path: [] });
    bot.emit('path_update', { status: 'timeout', path: [{ x: 4, y: 64, z: 0 }] });
    await delay(30);
    assert.equal(settled, false);
    assert.ok(bot.pathfinder.goal);

    bot.emit('path_update', { status: 'timeout', path: [] });
    await assert.rejects(pending, (err) => err.name === 'Timeout');
    assert.equal(bot.pathfinder.goal, null);
});

test('pathfinder.stop while idle does not cancel the next goal', async () => {
    const bot = createBot();
    pathfinder(bot);
    bot.pathfinder.stop();

    const pending = bot.pathfinder.goto(new goals.GoalBlock(5, 64, 5));
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await delay(50);

    assert.equal(settled, false);
    bot.pathfinder.stop();
    await assert.rejects(pending, (err) => err.name === 'PathStopped');
    assert.equal(bot.pathfinder.goal, null);
});

test('cancelling block collection settles and does not stack listeners', async () => {
    const bot = createBot();
    pathfinder(bot);
    bot.collectBlock = new CollectBlock(bot);
    class Block {
        constructor(position) {
            this.name = 'oak_log';
            this.position = position;
            this.type = 17;
        }
        canHarvest() { return true; }
    }

    const pending = bot.collectBlock.collect(new Block(new Vec3(12, 64, 4)));
    await delay(20);
    assert.equal(bot.collectBlock._collecting, true);

    const cancels = [
        bot.collectBlock.cancelTask(),
        bot.collectBlock.cancelTask(),
        bot.collectBlock.cancelTask()
    ];
    assert.ok(bot.listenerCount('collectBlock_finished') <= 2);

    await Promise.all([pending, ...cancels]);
    assert.equal(bot.listenerCount('collectBlock_finished'), 0);
    assert.equal(bot.collectBlock.targets.empty, true);
    assert.equal(bot.collectBlock._collecting, false);
});

test('cancelling item pickup does not wait for entityGone', async () => {
    const bot = createBot();
    pathfinder(bot);
    bot.collectBlock = new CollectBlock(bot);
    bot.pathfinder.goto = async () => {};
    bot.pathfinder.setMovements = () => {};
    class Entity {
        constructor() {
            this.isValid = true;
            this.position = new Vec3(1, 64, 1);
            this.name = 'item';
        }
    }

    const pending = bot.collectBlock.collect(new Entity());
    await delay(30);
    const started = Date.now();
    await Promise.all([pending, bot.collectBlock.cancelTask()]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(bot.listenerCount('entityGone'), 0);
});

test('an uncollected item drop does not keep collection pending', async () => {
    const bot = createBot();
    pathfinder(bot);
    bot.collectBlock = new CollectBlock(bot);
    bot.pathfinder.goto = async () => {};
    bot.pathfinder.setMovements = () => {};
    class Entity {
        constructor() {
            this.isValid = true;
            this.position = new Vec3(1, 64, 1);
            this.name = 'item';
        }
    }

    const started = Date.now();
    await bot.collectBlock.collect(new Entity());
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2900 && elapsed < 4500);
    assert.equal(bot.listenerCount('entityGone'), 0);
});

test('digging aborted during look settles once look is forced', async () => {
    const bot = new EventEmitter();
    bot.entity = { position: new Vec3(0, 64, 0), yaw: 1, pitch: 0, eyeHeight: 1.62 };
    let digPackets = 0;
    bot._client = { write() { digPackets++; } };
    bot.swingArm = () => {};
    bot.world = { raycast() { return null; } };
    let lookingTask = createDoneTask();
    bot.look = async (yaw, pitch, force) => {
        if (!lookingTask.done) lookingTask.finish();
        lookingTask = createTask();
        if (force) return;
        await lookingTask.promise;
    };
    bot.lookAt = async (_point, force) => {
        await bot.look(0, 0, force);
    };
    diggingPlugin(bot);
    bot.digTime = () => 50;

    const block = {
        name: 'stone',
        position: new Vec3(1, 64, 0),
        type: 1
    };
    const pending = bot.dig(block);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await delay(20);
    assert.equal(settled, false);

    // Match requestInterrupt: force the look, then stop, before either promise yields.
    const lookPromise = bot.look(bot.entity.yaw, bot.entity.pitch, true);
    bot.stopDigging();
    await assert.rejects(pending, /Digging aborted/);
    await lookPromise;
    assert.equal(digPackets, 0);
});
