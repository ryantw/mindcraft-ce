import assert from 'assert';
import { readFileSync } from 'fs';
import path from 'path';
import test from 'node:test';
import { loadScenario } from '../src/village/load.js';
import { planFurnish } from '../src/village/furnish.js';

const RESERVED = ['Finn', 'Sawyer', 'Milo', 'Jasper', 'Rowan'];

test('village furnishing follows the measured site and the supply manifest', () => {
    const bundle = loadScenario(path.join('scenarios', 'village-alpha'), { reservedNames: RESERVED, forLaunch: true });
    const site = JSON.parse(readFileSync(path.join('scenarios', 'village-alpha', 'site.json'), 'utf8'));
    const plan = planFurnish(bundle.village, site, bundle.inhabitants);
    assert.equal(plan.houses.length, bundle.village.plots.length);
    assert.deepEqual(plan.origin, [-458, 73, -715]);
    assert.equal(plan.arrivals.length, 5);
    assert.deepEqual(plan.arrivals.map(arrival => arrival.name), bundle.inhabitants.map(profile => profile.name));
    const occupied = plan.chests.filter(chest => chest.occupied && chest.plot_id.startsWith('plot-'));
    const vacant = plan.chests.filter(chest => !chest.occupied);
    assert.equal(occupied.length, 5);
    assert.equal(vacant.length, 3);
    assert.ok(occupied.every(chest => chest.stacks.some(stack => stack.item === 'bread' && stack.count === 24)));
    assert.ok(vacant.every(chest => chest.stacks.length === 0));
    assert.deepEqual(occupied.map(chest => chest.stacks.at(-1).item), ['clock', 'fishing_rod', 'shears', 'flower_pot', 'book']);
    const shared = plan.chests.find(chest => chest.plot_id === 'common-house');
    assert.equal(shared.stacks.find(stack => stack.item === 'wheat_seeds').count, 16);
    const source = ['src/village/furnish.js', 'src/village/placement.js', 'src/village/target.js', 'scripts/village/provision.js']
        .map(file => readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(source, /Ione|Cass|Rufus|Nell|Bram/);
});
