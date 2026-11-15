import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { writeLife, readLife } from '../src/village/life.js';
import { placeConfiguredRemains, planRemains, REMAINS_ATTEMPT_LIMIT } from '../src/village/remains.js';

const AT = '2026-11-15T19:44:01.550Z';

function deadDir(evidence) {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'remains-'));
    const death = {
        at: AT,
        position: { x: -415.48, y: 71.9375, z: -725.88 },
        dimension: 'overworld',
        cause: null,
        server_message: null,
        evidence,
    };
    writeLife(parent, {
        schema_version: 1,
        lifecycle: 'dead',
        activity: null,
        admitted_at: AT,
        updated_at: AT,
        death,
    });
    return parent;
}

test('a missing container is recorded as not configured and does not look like an unloaded chunk', () => {
    const dir = deadDir(planRemains({ position: { x: 1, y: 71, z: 1 } }));
    try {
        const evidence = placeConfiguredRemains({
            village_remains_container: null,
            agent_data_root: dir,
            profile: { name: 'Rufus' },
        });
        const life = readLife(dir);
        assert.equal(evidence.reason, 'not_configured');
        assert.equal(life.lifecycle, 'dead');
        assert.equal(life.death.at, AT);
        assert.equal(life.death.cause, null);
        assert.equal(life.death.position.y, 71.9375);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an unloaded chunk stays retryable, then one marker is placed and a second call does not summon', () => {
    const dir = deadDir({ status: 'unplaced', reason: 'unloaded', id: null, kind: null, attempts: 0 });
    const commands = [];
    let loaded = false;
    const run = (command) => {
        commands.push(command);
        if (command.startsWith('forceload remove')) return 'Removed';
        if (command.startsWith('forceload add')) return 'Marked';
        if (command.includes('minecraft:stone')) return loaded ? 'Test failed' : 'That position is not loaded';
        if (command.includes('minecraft:air')) return 'Test passed';
        if (command.startsWith('execute if block')) return 'Test failed';
        if (command.includes('summon')) return 'Summoned new Armor Stand';
        return 'Saved';
    };
    try {
        const failed = placeConfiguredRemains({
            village_remains_container: 'village-m3-smoke',
            agent_data_root: dir,
            profile: { name: 'Rufus' },
        }, { run, sleep() {} });
        assert.equal(failed.status, 'unplaced');
        assert.equal(failed.reason, 'unloaded');
        assert.equal(failed.attempts, 1);
        assert.equal(commands.filter(command => command.startsWith('forceload add')).length, 5);
        assert.equal(commands.filter(command => command.startsWith('forceload remove')).length, 5);
        assert.equal(commands.some(command => command.includes('summon')), false);
        const life = readLife(dir);
        assert.equal(life.death.at, AT);
        assert.equal(life.death.cause, null);
        assert.equal(life.lifecycle, 'dead');

        loaded = true;
        commands.length = 0;
        const placed = placeConfiguredRemains({
            village_remains_container: 'village-m3-smoke',
            agent_data_root: dir,
            profile: { name: 'Rufus' },
        }, { run, sleep() {} });
        assert.equal(placed.status, 'placed');
        const summonAt = commands.findIndex(command => command.includes('summon'));
        const releaseAt = commands.findIndex(command => command.startsWith('forceload remove'));
        assert.equal(commands.filter(command => command.includes('summon')).length, 1);
        assert.ok(summonAt >= 0 && releaseAt > summonAt);
        const again = placeConfiguredRemains({
            village_remains_container: 'village-m3-smoke',
            agent_data_root: dir,
            profile: { name: 'Rufus' },
        }, { run() { throw new Error('should not place twice'); }, sleep() {} });
        assert.equal(again.status, 'placed');
        assert.equal(readLife(dir).death.at, AT);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('three failed attempts are the bound', () => {
    const dir = deadDir({ status: 'unplaced', reason: 'unloaded', attempts: REMAINS_ATTEMPT_LIMIT });
    try {
        const evidence = placeConfiguredRemains({
            village_remains_container: 'village-m3-smoke',
            agent_data_root: dir,
            profile: { name: 'Nell' },
        }, { run() { throw new Error('should not retry'); } });
        assert.equal(evidence.attempts, REMAINS_ATTEMPT_LIMIT);
        assert.equal(readLife(dir).death.cause, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
