import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedMechanics } from '../src/agent/mechanics.js';

test('iron ore advice uses the verified harvest and crafting data', () => {
    const facts = verifiedMechanics({
        text: 'I have a wooden pickaxe but cannot mine iron. What am I missing?',
        inventory: { wooden_pickaxe: 1, oak_planks: 20, stick: 4 },
        held: 'wooden_pickaxe'
    });
    assert.match(facts, /wooden_pickaxe cannot harvest it/);
    assert.match(facts, /iron_ore/);
    assert.match(facts, /stone_pickaxe/);
    assert.match(facts, /3 cobblestone \+ 2 stick/);
    assert.match(facts, /crafting table/i);
    assert.match(facts, /can harvest stone, which drops cobblestone/);
    assert.doesNotMatch(facts, /wooden_pickaxe can harvest iron_ore/);
    assert.ok(facts.length < 1600);
});

test('a log does not require a pickaxe', () => {
    const facts = verifiedMechanics({
        text: 'I cannot reach the acacia logs.',
        inventory: { wooden_pickaxe: 1 },
        held: 'wooden_pickaxe'
    });
    assert.match(facts, /acacia_log/);
    assert.match(facts, /can harvest it/);
    assert.doesNotMatch(facts, /stone_pickaxe/);
});
