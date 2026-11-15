import { readFileSync } from 'fs';
import path from 'path';
import settings from '../agent/settings.js';
import { readLife, setActivity } from './life.js';
import { enqueueSleep, rejectInhabitantDreams } from './dream_queue.js';
import { applyReadyDreams, scenarioRootFrom, tickDreams } from './dream_scheduler.js';
import { orientFirstDay } from './orientation.js';
import { makeSleepId, noteSleepEdge } from './sleep.js';

function checksumOf(dataRoot) {
    try {
        return JSON.parse(readFileSync(path.join(dataRoot, 'identity.json'), 'utf8')).profile_checksum || '';
    } catch {
        return '';
    }
}

function scenarioRoot() {
    return scenarioRootFrom(settings.agent_data_root);
}

/**
 * Hooks for one inhabitant process. Inference is never awaited by the action
 * that entered the bed, and a dream is applied only when this body is not
 * inside an action.
 */
export function attachVillageMind(agent) {
    if (settings.village_autonomy !== true || !settings.agent_data_root || !agent?.bot) return;
    const root = scenarioRoot();
    const inhabitantId = settings.village_inhabitant_id;
    const state = { session: null };
    agent._sleepState = state;

    const tick = (allowApply) => {
        const busy = Boolean(agent.actions?.executing);
        return tickDreams({
            scenarioRoot: root,
            actorId: inhabitantId,
            allowApply: allowApply && !busy,
            busy,
            dreamModel: settings.dream_model,
        }).catch((error) => {
            console.warn(`[${agent.name}] Dream tick failed: ${error.message}`);
        });
    };

    agent.bot.on('sleep', () => {
        // Pose sleep only. `bot.isSleeping` is set by that same event.
        if (agent.bot?.isSleeping !== true) return;
        const edge = noteSleepEdge(state, true, () => makeSleepId(inhabitantId, agent.bot));
        if (edge.edge !== 'asleep') return;
        try { setActivity(settings.agent_data_root, 'asleep'); } catch { /* life file is optional in tests */ }
        const life = readLife(settings.agent_data_root);
        const result = enqueueSleep(root, {
            inhabitantId,
            sleepId: edge.session.id,
            profileChecksum: checksumOf(settings.agent_data_root),
            life: life?.lifecycle || 'alive',
        });
        console.log(`[dream] ${inhabitantId} session ${edge.session.id} enqueued=${result.enqueued}${result.reason ? ` (${result.reason})` : ''}`);
        void tick(false);
    });

    agent.bot.on('wake', () => {
        noteSleepEdge(state, false, () => null);
        try { setActivity(settings.agent_data_root, 'awake'); } catch { /* ignore */ }
        void tick(true);
    });

    agent.applyReadyDream = () => applyReadyDreams(root, inhabitantId, {
        isDead: (id) => readLife(path.join(root, id))?.lifecycle === 'dead',
    });

    agent.orientVillage = () => {
        if (agent._orientStarted) return Promise.resolve();
        agent._orientStarted = true;
        return orientFirstDay(settings.agent_data_root, { model: settings.profile?.model }).then((result) => {
            if (result && !result.skipped) {
                console.log(`[orientation] ${inhabitantId} intention=${result.intention || 'none'} journal=${Boolean(result.journal)}`);
            }
            return result;
        }).catch((error) => {
            console.warn(`[${agent.name}] Orientation skipped: ${error.message}`);
        });
    };

    agent._dreamTimer = setInterval(() => { void tick(true); }, 2000);
    if (agent._dreamTimer.unref) agent._dreamTimer.unref();
}

export function cancelDreamsForDeath(dataRoot, inhabitantId) {
    const root = scenarioRootFrom(dataRoot);
    if (!root || !inhabitantId) return [];
    return rejectInhabitantDreams(root, inhabitantId);
}
