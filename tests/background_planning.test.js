import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { PlanManager } from '../src/agent/plan_manager.js';
import { setSettings } from '../src/agent/settings.js';

setSettings({ persistent_planning: true });

function makeManager(root, name = 'Finn') {
    const agent = {
        name,
        bot: {
            inventory: { inventoryStart: 9, slots: Array(46).fill(null) },
            entity: { position: { x: 0, y: 64, z: 0 } },
            blockAt: () => ({ name: 'air' }),
        },
        self_prompter: { prompt: 'Live independently.' },
        history: { memory: '' },
    };
    return new PlanManager(agent, root);
}

function withRoot(run) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-bgplan-'));
    return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('an agent without a plan requests one in the background, once', () => withRoot(async root => {
    const manager = makeManager(root);
    let release;
    let requests = 0;
    manager._requestPlan = () => {
        requests++;
        return new Promise(resolve => { release = resolve; });
    };

    const first = manager.ensurePlanInBackground();
    assert.ok(first, 'a request was started');
    assert.equal(manager.ensurePlanInBackground(), null, 'no second request while one is in flight');
    assert.equal(manager.ensurePlanInBackground(), null);
    assert.equal(requests, 1);

    release(null);
    await first;
    assert.equal(manager.planningPromise, null);
}));

test('a failed or rejected attempt backs off instead of replanning on every message', () => withRoot(async root => {
    const manager = makeManager(root);
    let requests = 0;
    manager._requestPlan = async () => {
        requests++;
        manager._planningFailed('Plan proposal rejected as not executable.');
        return null;
    };

    await manager.ensurePlanInBackground();
    for (let message = 0; message < 10; message++) manager.ensurePlanInBackground();
    assert.equal(requests, 1, 'ten more conversation messages trigger no further model calls');
    assert.ok(manager.nextPlanningAllowedAt > Date.now());
}));

test('a thrown planning error never escapes into the conversation', () => withRoot(async root => {
    const manager = makeManager(root);
    manager._requestPlan = async () => { throw new Error('ollama unavailable'); };
    const pending = manager.ensurePlanInBackground();
    await assert.doesNotReject(async () => { try { await pending; } catch (_error) { /* handled by manager */ } });
    // Settle the handler microtasks, then confirm it entered backoff.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.ensurePlanInBackground(), null);
}));

test('nothing is requested when a usable plan exists or planning is disabled', () => withRoot(async root => {
    const manager = makeManager(root);
    let requests = 0;
    manager._requestPlan = async () => { requests++; return null; };

    manager.planningReason = () => null; // active plan with an active step
    assert.equal(manager.ensurePlanInBackground(), null);

    setSettings({ persistent_planning: false });
    try {
        manager.planningReason = () => 'no_active_plan';
        assert.equal(manager.ensurePlanInBackground(), null);
    } finally {
        setSettings({ persistent_planning: true });
    }
    assert.equal(requests, 0);
}));
