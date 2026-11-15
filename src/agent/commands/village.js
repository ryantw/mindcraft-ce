import settings from '../settings.js';
import { createActionOutcome } from '../action_outcome.js';
import { expressStance } from '../../village/relationships.js';
import { clearIntentionRepetition, updateIntention } from '../../village/intentions.js';
import { reviseAmbition } from '../../village/ambitions.js';

function recordPrivate(agent, action, params, ok, message) {
    if (!agent.actions?.recordOutcome) return;
    agent.actions.recordOutcome(createActionOutcome({
        action,
        params,
        status: ok ? 'success' : 'failure',
        reason: ok ? null : {
            code: 'not_recorded',
            message,
            prerequisites: [],
            condition: 'unchanged_behavior',
        },
        retryableWithoutStateChange: !ok,
        relevantProgress: ok,
    }));
}

function recordIntention(agent, action, text, result) {
    if (!agent.actions?.recordOutcome) return;
    const changed = Boolean(result.ok && result.changed !== false);
    agent.actions.recordOutcome(createActionOutcome({
        action: 'intention',
        params: { action, text: String(text || '') },
        status: changed ? 'success' : 'failure',
        reason: changed ? null : {
            code: result.code || 'intention_rejected',
            message: result.reason,
            prerequisites: [],
            condition: 'unchanged_behavior',
        },
        retryableWithoutStateChange: changed,
        relevantProgress: changed,
        behaviorKey: result.behaviorKey || null,
        details: { signature: '!intention(action:string, text:string)' },
    }));
    if (changed) clearIntentionRepetition(agent);
}

export const villageCommands = [
    {
        name: '!stance',
        description: 'Record your private interpretation of someone you have actually met. This does not change their view of you, and it is not a verified fact.',
        villageOnly: true,
        params: {
            person: { type: 'string', description: 'The name of someone who appears in your own experience.' },
            kind: { type: 'string', description: 'inhabitant or human.' },
            stance: { type: 'string', description: 'Your private stance, in your own words.' },
            note: { type: 'string', description: 'What happened that this view is based on. This remains your interpretation.' },
        },
        perform: async (agent, person, kind, stance, note) => {
            if (settings.village_autonomy !== true || !settings.agent_data_root) {
                return 'That command is not part of this session.';
            }
            try {
                const result = expressStance(settings.agent_data_root, {
                    other_id: person,
                    other_kind: kind,
                    stance,
                    note,
                });
                if (!result.ok) {
                    recordPrivate(agent, 'stance', { person, kind }, false, result.reason);
                    return result.reason;
                }
                recordPrivate(agent, 'stance', { person, kind }, true);
                return 'You noted that privately. It is your interpretation, not an established fact.';
            } catch (error) {
                return error.message;
            }
        },
    },
    {
        name: '!ambition',
        description: 'Revise your private long-term ambition. This does not change your admitted identity and does not by itself start a plan.',
        villageOnly: true,
        params: {
            text: { type: 'string', description: 'The ambition in your own words.' },
        },
        perform: async (agent, text) => {
            if (settings.village_autonomy !== true || !settings.agent_data_root) {
                return 'That command is not part of this session.';
            }
            const result = reviseAmbition(settings.agent_data_root, text, { source: 'day' });
            if (!result.ok) {
                recordPrivate(agent, 'ambition', { text: String(text || '') }, false, result.reason);
                return result.reason;
            }
            recordPrivate(agent, 'ambition', { text: String(text || '') }, true);
            return 'You kept that as a private ambition. It is not an assigned quest.';
        },
    },
    {
        name: '!intention',
        description: 'Note or close your current personal goal. It is private and not an assigned quest. The next decisions can continue it. You may revise it, rest, or set it aside.',
        villageOnly: true,
        params: {
            action: { type: 'string', description: 'pursue or revise. complete and abandon apply only when an intention is already active.' },
            text: { type: 'string', description: 'Your own words. On pursue or revise, these words are the intention. On complete or abandon, they only explain the close and do not start a new intention.' },
        },
        perform: async (agent, action, text) => {
            if (settings.village_autonomy !== true || !settings.agent_data_root) {
                return 'That command is not part of this session.';
            }
            const result = updateIntention(settings.agent_data_root, { action, text, source: 'day' });
            recordIntention(agent, action, text, result);
            if (!result.ok) return result.reason;
            return 'You noted that as your current goal. It is yours to revise.';
        },
    },
];
