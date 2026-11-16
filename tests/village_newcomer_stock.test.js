import assert from 'assert';
import { readFileSync } from 'fs';
import path from 'path';
import test from 'node:test';
import { loadScenario } from '../src/village/load.js';
import {
    PLACEMENT_PREFIX,
    TARGETS,
    chestIsEmpty,
    planNewcomerStock,
} from '../src/village/newcomer_stock.js';

const RESERVED = ['Finn', 'Sawyer', 'Milo', 'Jasper', 'Rowan'];

function bundle() {
    return loadScenario(path.join('scenarios', 'village-alpha'), { reservedNames: RESERVED, forLaunch: true });
}

test('newcomer stocking appends three homes and refuses a second fill', () => {
    const loaded = bundle();
    const site = JSON.parse(readFileSync(path.join('scenarios', 'village-alpha', 'site.json'), 'utf8'));
    const plan = planNewcomerStock(loaded.village, site, PLACEMENT_PREFIX, { receiptExists: false });
    assert.equal(plan.refill, true);
    assert.deepEqual(plan.targets.map(target => target.name), ['Hazel', 'Silas', 'Wren']);
    assert.deepEqual(plan.targets.map(target => target.stacks.at(-1)), [
        { item: 'poppy', count: 1 },
        { item: 'iron_ingot', count: 1 },
        { item: 'compass', count: 1 },
    ]);
    assert.ok(plan.targets.every(target => target.stacks.some(stack => stack.item === 'bread' && stack.count === 24)));
    assert.equal(plan.placement.action, 'append');
    assert.ok(plan.placement.text.startsWith(PLACEMENT_PREFIX));
    assert.equal(plan.placement.text.slice(PLACEMENT_PREFIX.length).trim().split('\n').length, 9);
    assert.match(plan.placement.text, /name=Hazel,tag=!village_placed/);
    assert.match(plan.placement.text, /name=Silas,tag=!village_placed/);
    assert.match(plan.placement.text, /name=Wren,tag=!village_placed/);
    const again = planNewcomerStock(loaded.village, site, plan.placement.text, { receiptExists: false });
    assert.equal(again.placement.action, 'already');
    assert.equal(again.placement.text, plan.placement.text);
    const blocked = planNewcomerStock(loaded.village, site, plan.placement.text, { receiptExists: true });
    assert.equal(blocked.refill, false);
    assert.match(blocked.reason, /Refusing to refill/);
    assert.deepEqual(plan.preserve.map(chest => chest.id), [
        'plot-ione', 'plot-cass', 'plot-rufus', 'plot-nell', 'plot-bram', 'common-house',
    ]);
    assert.deepEqual(TARGETS.map(target => target.inhabitantId), ['hazel', 'silas', 'wren']);
    assert.equal(chestIsEmpty('-480, 85, -729 has the following block data: []'), true);
    assert.equal(chestIsEmpty('-480, 85, -729 has the following block data: [{id:"minecraft:bread"}]'), false);
    assert.throws(
        () => planNewcomerStock(loaded.village, site, `${PLACEMENT_PREFIX}execute as @a[name=Hazel] run tp @s 0 0 0\n`),
        /original five/,
    );
});
