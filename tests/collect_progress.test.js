import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import {
    collectBlockWithProgress,
    isCollectionTargetTemporarilyAvoided,
    recordCollectionTargetFailure,
} from '../src/agent/library/skills.js';

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createBot(block) {
    let finishCollection;
    const collection = new Promise(resolve => { finishCollection = resolve; });
    const bot = {
        interrupt_code: false,
        entity: { position: new Vec3(0, 64, 0) },
        inventory: { items: () => [] },
        blockAt: () => block,
        collectBlock: {
            collect: () => collection,
            cancelTask: async () => {
                await delay(10);
                finishCollection();
            },
        },
    };
    return { bot, finishCollection };
}

test('jumping in place stalls collection and waits for cancellation', async () => {
    const block = { name: 'oak_log', type: 17, position: new Vec3(8, 70, 0) };
    const { bot } = createBot(block);
    let cancellationFinished = false;
    const cancelTask = bot.collectBlock.cancelTask;
    bot.collectBlock.cancelTask = async () => {
        await cancelTask();
        cancellationFinished = true;
    };
    const jumping = setInterval(() => {
        bot.entity.position.y = bot.entity.position.y === 64 ? 65 : 64;
    }, 4);

    const started = Date.now();
    await assert.rejects(
        collectBlockWithProgress(bot, block, 'oak_log', { stallTimeout: 40, checkInterval: 5 }),
        error => error.name === 'CollectionStalled'
            && error.message.includes('oak_log')
            && error.message.includes('(8, 70, 0)')
    );
    clearInterval(jumping);

    assert.ok(Date.now() - started >= 40);
    assert.equal(cancellationFinished, true);
});

test('meaningful movement toward the target extends collection time', async () => {
    const block = { name: 'oak_log', type: 17, position: new Vec3(12, 64, 0) };
    const { bot, finishCollection } = createBot(block);
    let cancelled = false;
    bot.collectBlock.cancelTask = async () => { cancelled = true; };

    setTimeout(() => { bot.entity.position = new Vec3(4, 64, 0); }, 25);
    setTimeout(() => { bot.entity.position = new Vec3(8, 64, 0); }, 55);
    setTimeout(finishCollection, 75);

    await collectBlockWithProgress(bot, block, 'oak_log', { stallTimeout: 40, checkInterval: 5 });
    assert.equal(cancelled, false);
});

test('a repeatedly failing coordinate is avoided temporarily', () => {
    const bot = {};
    const target = new Vec3(-589, 70, -135);

    recordCollectionTargetFailure(bot, 'acacia_log', target, 1000);
    assert.equal(isCollectionTargetTemporarilyAvoided(bot, 'acacia_log', target, 1000), false);

    recordCollectionTargetFailure(bot, 'acacia_log', target, 2000);
    assert.equal(isCollectionTargetTemporarilyAvoided(bot, 'acacia_log', target, 2000), true);
    assert.equal(isCollectionTargetTemporarilyAvoided(bot, 'acacia_log', target, 122001), false);
});

test('positionless block palette checks are not treated as failed targets', () => {
    assert.equal(isCollectionTargetTemporarilyAvoided({}, 'acacia_log', null), false);
});
