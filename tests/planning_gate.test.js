import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { PlanManager } from '../src/agent/plan_manager.js';
import { setSettings } from '../src/agent/settings.js';
import { getCommandDocs, executeCommand } from '../src/agent/commands/index.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

initializeMinecraftData('1.21.6');

function makeAgent(name='Sawyer') {
    return {
        name,
        blocked_actions: [],
        bot: {
            inventory: { inventoryStart: 9, slots: Array(46).fill(null) },
            entity: { position: { x: 0, y: 64, z: 0 } },
            blockAt: () => ({ name: 'air' }),
        },
        prompter: {
            planningRequests: 0,
            async promptPlanning() { this.planningRequests++; return null; },
        },
        self_prompter: { prompt: 'Live independently.' },
        history: { memory: '' },
    };
}

const proposal = {
    objective: 'Collect oak logs',
    steps: [{
        id: 'logs',
        description: 'Collect logs',
        action: { name: 'collectBlocks', params: { type: 'oak_log', num: 2 } },
        evidence: { type: 'inventory_min', item: 'oak_log', count: 2 },
    }],
};

test('persistent planning is disabled by default and makes no model requests', async () => {
    setSettings({});
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-gate-'));
    try {
        const agent = makeAgent();
        const manager = new PlanManager(agent, dir);
        agent.plan_manager = manager;

        assert.equal(manager.enabled, false);
        assert.equal(await manager.ensurePlan(), null);
        assert.equal(agent.prompter.planningRequests, 0);
        assert.equal(manager.getCurrentPlan(), null);
        assert.equal(manager.formatForPrompt(), '');
        assert.deepEqual(manager.observeOutcome({ action: 'collectBlocks', params: {}, status: 'success' }), { advanced: false });
        assert.equal(manager.abandon('nope'), false);
        assert.throws(() => manager.applyProposal(proposal), /disabled/);
        // Nothing is created on disk while disabled.
        assert.equal(existsSync(path.join(dir, 'Sawyer')), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an existing plan file is neither read nor modified while planning is disabled', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-gate-'));
    try {
        setSettings({ persistent_planning: true });
        const enabledAgent = makeAgent();
        const enabled = new PlanManager(enabledAgent, dir);
        enabled.applyProposal(proposal);
        const file = path.join(dir, 'Sawyer', 'plan.json');
        assert.equal(existsSync(file), true);

        setSettings({ persistent_planning: false });
        const disabled = new PlanManager(makeAgent(), dir);
        assert.equal(disabled.getCurrentPlan(), null);
        assert.equal(await disabled.ensurePlan(), null);

        // Re-enabling restores the preserved plan: nothing was lost.
        setSettings({ persistent_planning: true });
        const restored = new PlanManager(makeAgent(), dir);
        assert.equal(restored.getCurrentPlan().objective, 'Collect oak logs');
    } finally {
        setSettings({});
        rmSync(dir, { recursive: true, force: true });
    }
});

test('!reconsiderPlan is hidden and inert while planning is disabled', async () => {
    setSettings({});
    const agent = makeAgent();
    agent.plan_manager = new PlanManager(agent, os.tmpdir());
    assert.doesNotMatch(getCommandDocs(agent), /!reconsiderPlan/);
    const result = await executeCommand(agent, '!reconsiderPlan("bored")');
    assert.match(result, /Persistent planning is disabled/);
});
