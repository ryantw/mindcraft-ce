import settings from '../agent/settings.js';
import { VILLAGE_AUTONOMY_PREAMBLE } from '../agent/startup_goal.js';
import { activeIntentionText, readIntentions } from './intentions.js';

const BOT_LEAD = 'You are an AI Minecraft bot named $NAME that can converse with players, see, move, mine, build, and interact with the world by using commands.';
const PERSON_LEAD = 'You are $NAME, a person who lives in this village. You can look, walk, speak, and use the same commands as every other inhabitant. You are not an assistant.';

const ROBOT_MANNERS = "Be a friendly, casual, effective, and efficient robot. Be very brief in your responses, don't apologize constantly, don't give instructions or make lists unless asked, and don't refuse requests. Don't pretend to act, use commands immediately when requested.";
const PERSON_MANNERS = 'Speak briefly as yourself. You do not have to introduce yourself, agree, help, or be useful. A request from someone else is optional. Words you write before a command are spoken aloud. There is no !say or !talkTo command, and command syntax is not something you say to other people.';

const BOT_MEMORY = 'You are a minecraft bot named $NAME that has been talking and playing minecraft by using commands.';
const PERSON_MEMORY = 'You are $NAME, a person living in a village, not an assistant and not a robot. You have been talking and acting by using commands.';

const SUMMARY_QUOTED = "HISTORICAL MEMORY\nSummarized memory:'$MEMORY'\n";
const SUMMARY_PLAIN = 'HISTORICAL MEMORY\n$MEMORY\n';
const PERSONAL_CONTINUITY = 'Personal continuity is your admitted identity, morning brief, current intention, and recent episodes. An old rolling summary is not an objective.\n';

/**
 * The shared survival prompt is what made inhabitants introduce themselves as
 * helpers. These replacements run only for a village session. Survival text
 * is left untouched when the caller does not ask for them.
 */
export function adaptVillagePrompt(prompt, { enabled = true } = {}) {
    if (!enabled || typeof prompt !== 'string') return prompt;
    return prompt
        .replaceAll(BOT_LEAD, PERSON_LEAD)
        .replaceAll(ROBOT_MANNERS, PERSON_MANNERS)
        .replaceAll(BOT_MEMORY, PERSON_MEMORY)
        .replaceAll(SUMMARY_QUOTED, PERSONAL_CONTINUITY)
        .replaceAll(SUMMARY_PLAIN, PERSONAL_CONTINUITY);
}

/**
 * An unfinished plan stays on file. When it pursues the current goal, the
 * next step is the ordinary action. Danger, night, or a change of mind can pause it.
 */
export function villagePlanPrompt(planManager) {
    const plan = planManager?.getCurrentPlan?.();
    if (!plan || plan.status === 'completed' || plan.status === 'abandoned') return '';
    const detail = String(planManager.formatForPrompt?.() || '')
        .replace('PERSISTENT PLAN', 'Steps on file')
        .replace('Objective chosen by you:', 'Current goal:');
    const goal = settings.agent_data_root ? activeIntentionText(readIntentions(settings.agent_data_root)) : '';
    const aligned = goal && plan.objective === goal;
    const lead = aligned
        ? 'CURRENT GOAL IN PROGRESS\nContinue the next step unless you are in danger, it is time to sleep, or you deliberately change your mind. Do not restart from inspecting the same container.'
        : 'UNFINISHED PRACTICAL WORK\nThis is optional. A personal intention comes first when you have one. You may continue this work or leave it.';
    return `${lead}\n${detail}\n`;
}

export function villageSelfPromptLine(currentPrompt, { stopped = false } = {}) {
    if (stopped) return '';
    const text = String(currentPrompt ?? '').trim();
    if (!text || text === VILLAGE_AUTONOMY_PREAMBLE) return '';
    return `YOUR CURRENT ASSIGNED GOAL: "${text}"\n`;
}
