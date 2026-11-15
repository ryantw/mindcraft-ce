import settings from '../settings.js';
import { expressStance } from '../../village/relationships.js';
import { updateIntention } from '../../village/intentions.js';

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
                if (!result.ok) return result.reason;
                return 'You noted that privately. It is your interpretation, not an established fact.';
            } catch (error) {
                return error.message;
            }
        },
    },
    {
        name: '!intention',
        description: 'Note a personal intention. pursue, revise, complete, or abandon. This is optional, private, and not a quest. It does not start a multistep plan. A visit, a conversation, or resting needs no plan.',
        villageOnly: true,
        params: {
            action: { type: 'string', description: 'pursue, revise, complete, or abandon.' },
            text: { type: 'string', description: 'Your own words. A short note is enough when you complete or abandon.' },
        },
        perform: async (agent, action, text) => {
            if (settings.village_autonomy !== true || !settings.agent_data_root) {
                return 'That command is not part of this session.';
            }
            const result = updateIntention(settings.agent_data_root, { action, text, source: 'day' });
            if (!result.ok) return result.reason;
            return 'You noted that for yourself. It is not an assigned goal.';
        },
    },
];
