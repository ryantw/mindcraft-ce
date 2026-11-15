import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createActionOutcome } from '../src/agent/action_outcome.js';
import { recordCommandResult } from '../src/agent/reflection_triggers.js';
import { formatKnownFacts, loadLessons, recordLesson } from '../src/agent/lessons.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

initializeMinecraftData('1.21.6');

const lessonsDir = mkdtempSync(path.join(tmpdir(), 'known-facts-'));

function agent(name) {
    const holder = {
        name,
        lessonsBaseDir: lessonsDir,
        actions: {
            getLastOutcome: () => holder.outcome,
            getLastBlocked: () => null,
        },
    };
    return holder;
}

function record(holder, commandName) {
    recordCommandResult(holder, {
        commandName,
        commandKey: commandName,
        failed: holder.outcome.status === 'failure',
        isAction: true,
    });
}

test.after(() => {
    rmSync(lessonsDir, { recursive: true, force: true });
});

test('a verified wooden pickaxe craft is remembered with the ingredients that were used', () => {
    const holder = agent('Milo');
    holder.outcome = createActionOutcome({
        action: 'craftRecipe',
        params: { recipe_name: 'wooden_pickaxe', num: 1 },
        status: 'success',
        before: { counts: { acacia_planks: 3, stick: 2 }, storage: null },
        after: { counts: { wooden_pickaxe: 1 }, storage: null },
        relevantProgress: true,
        details: { requestedExecutions: 1, produced: { item: 'wooden_pickaxe', count: 1 } },
    });
    record(holder, '!craftRecipe');

    const fact = loadLessons(holder, lessonsDir).find(lesson => lesson.id === 'crafted:wooden_pickaxe');
    assert.equal(fact.text, 'Crafted wooden_pickaxe from 3 acacia_planks + 2 stick at a crafting table.');
    assert.equal(fact.count, 1);
    assert.ok(fact.tags.includes('accomplishment'));

    const shown = formatKnownFacts(holder, lessonsDir);
    assert.match(shown, /KNOWN FACTS/);
    assert.match(shown, /not a live inventory/);
    assert.match(shown, /Trust CURRENT GAME STATE/);
    assert.match(shown, /Crafted wooden_pickaxe from 3 acacia_planks \+ 2 stick at a crafting table\. \(verified 1x\)/);
});

test('a 2x2 craft is remembered without a crafting table', () => {
    const holder = agent('Finn');
    holder.outcome = createActionOutcome({
        action: 'craftRecipe',
        params: { recipe_name: 'oak_planks', num: 1 },
        status: 'success',
        before: { counts: { oak_log: 1 }, storage: null },
        after: { counts: { oak_planks: 4 }, storage: null },
        relevantProgress: true,
        details: { requestedExecutions: 1, produced: { item: 'oak_planks', count: 4 } },
    });
    record(holder, '!craftRecipe');
    const fact = loadLessons(holder, lessonsDir).find(lesson => lesson.id === 'crafted:oak_planks');
    assert.equal(fact.text, 'Crafted oak_planks from 1 oak_log.');
    assert.doesNotMatch(fact.text, /crafting table/);
});

test('crafting again reinforces the same fact instead of adding another', () => {
    const holder = agent('Sawyer');
    const craft = (planks) => createActionOutcome({
        action: 'craftRecipe',
        params: { recipe_name: 'wooden_pickaxe', num: 1 },
        status: 'success',
        before: { counts: { [planks]: 3, stick: 2 }, storage: null },
        after: { counts: { wooden_pickaxe: 1 }, storage: null },
        relevantProgress: true,
        details: { requestedExecutions: 1, produced: { item: 'wooden_pickaxe', count: 1 } },
    });
    holder.outcome = craft('acacia_planks');
    record(holder, '!craftRecipe');
    holder.outcome = craft('oak_planks');
    record(holder, '!craftRecipe');
    const fact = loadLessons(holder, lessonsDir).find(lesson => lesson.id === 'crafted:wooden_pickaxe');
    assert.equal(fact.count, 2);
    assert.equal(fact.text, 'Crafted wooden_pickaxe from 3 oak_planks + 2 stick at a crafting table.');
});

test('a failed craft and an ordinary placement are not accomplishments', () => {
    const holder = agent('Jasper');
    const before = loadLessons(holder, lessonsDir).length;
    holder.outcome = createActionOutcome({
        action: 'craftRecipe',
        params: { recipe_name: 'stone_pickaxe', num: 1 },
        status: 'failure',
        before: { counts: { cobblestone: 3 }, storage: null },
        after: { counts: { cobblestone: 3 }, storage: null },
        relevantProgress: false,
        reason: { code: 'missing_resource', message: 'Missing sticks.', condition: 'state_changed' },
        details: { requestedExecutions: 1, produced: { item: 'stone_pickaxe', count: 0 } },
    });
    record(holder, '!craftRecipe');
    holder.outcome = createActionOutcome({
        action: 'placeHere',
        params: { type: 'cobblestone' },
        status: 'success',
        before: { counts: { cobblestone: 1 }, storage: null },
        after: { counts: {}, storage: null },
        relevantProgress: true,
        details: { placedBlock: { type: 'cobblestone', position: { x: 1, y: 64, z: 1 } } },
    });
    record(holder, '!placeHere');
    assert.equal(loadLessons(holder, lessonsDir).length, before);
    assert.equal(loadLessons(holder, lessonsDir).find(lesson => lesson.id === 'crafted:stone_pickaxe'), undefined);
    assert.equal(loadLessons(holder, lessonsDir).find(lesson => lesson.id === 'placed:cobblestone'), undefined);
});

test('a placed crafting table is remembered at its coordinates and a later one updates that place', () => {
    const holder = agent('Rowan');
    holder.outcome = createActionOutcome({
        action: 'placeHere',
        params: { type: 'crafting_table' },
        status: 'success',
        before: { counts: { crafting_table: 1 }, storage: null },
        after: { counts: {}, storage: null },
        relevantProgress: true,
        details: { placedBlock: { type: 'crafting_table', position: { x: 1174.2, y: 64, z: 645 } } },
    });
    record(holder, '!placeHere');
    holder.outcome = createActionOutcome({
        action: 'placeHere',
        params: { type: 'crafting_table' },
        status: 'success',
        before: { counts: { crafting_table: 1 }, storage: null },
        after: { counts: {}, storage: null },
        relevantProgress: true,
        details: { placedBlock: { type: 'crafting_table', position: { x: 1182, y: 41, z: 696 } } },
    });
    record(holder, '!placeHere');

    const fact = loadLessons(holder, lessonsDir).find(lesson => lesson.id === 'placed:crafting_table');
    assert.equal(fact.text, 'Placed crafting_table at (1182, 41, 696).');
    assert.equal(fact.count, 2);
    assert.match(formatKnownFacts(holder, lessonsDir), /Placed crafting_table at \(1182, 41, 696\)\. \(verified 2x\)/);
});

test('accomplishments survive a full lesson cap, and an agent with none adds no section', () => {
    const holder = agent('cap');
    recordLesson(holder, {
        id: 'crafted:wooden_pickaxe',
        text: 'Crafted wooden_pickaxe from 2 stick + 3 acacia_planks at a crafting table.',
        basis: 'observed',
        evidence: 'craftRecipe produced 1 wooden_pickaxe',
        tags: ['accomplishment', 'craftRecipe', 'wooden_pickaxe'],
    }, lessonsDir);
    recordLesson(holder, {
        id: 'placed:crafting_table',
        text: 'Placed crafting_table at (1182, 41, 696).',
        basis: 'observed',
        evidence: 'Placed crafting_table at (1182, 41, 696).',
        tags: ['accomplishment', 'placeHere', 'crafting_table'],
    }, lessonsDir);
    for (let index = 0; index < 30; index++) {
        recordLesson(holder, { id: `tool:${index}`, text: 't', basis: 'mechanics', evidence: 'e' }, lessonsDir);
    }
    const lessons = loadLessons(holder, lessonsDir);
    assert.ok(lessons.filter(lesson => !lesson.tags?.includes('accomplishment')).length <= 12);
    assert.ok(lessons.some(lesson => lesson.id === 'crafted:wooden_pickaxe'));
    assert.ok(lessons.some(lesson => lesson.id === 'placed:crafting_table'));

    const empty = { name: 'nobody', lessonsBaseDir: lessonsDir };
    assert.equal(formatKnownFacts(empty, lessonsDir), '');
});
