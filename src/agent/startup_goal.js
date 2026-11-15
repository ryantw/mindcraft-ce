import { nightPhase } from '../village/night.js';

export const RECOVERY_NOTICE = 'Agent process restarted.';

/**
 * Starts the village autonomous loop without becoming a saved ambition.
 * usableGoal ignores it, so a restart does not treat it as a lifelong quest.
 */
export const VILLAGE_AUTONOMY_PREAMBLE = 'You are an independent inhabitant of this village. You have no assigned quest, profession, or lifelong ambition. A current intention, if one is active, is optional. When you have no intention and no ambition, choose for yourself what to do next from your surroundings and your own judgment.';

/** How long an inhabitant may stay still before the next unforced decision. */
export const VILLAGE_DECISION_INTERVAL_MS = 15000;

/**
 * Decision prompt for an inhabitant who has no personal intention.
 * A conversation or a simple activity is not a construction plan.
 */
export function villageDecisionMessage({ ambition = '', goal = '', step = '', planFinished = false } = {}) {
    const lines = [];
    if (ambition) lines.push(`Your long-term ambition: ${ambition}`);
    if (goal) lines.push(`Your current goal: ${goal}`);
    if (step) lines.push(`The next practical step is: ${String(step).replace(/\.+$/, '')}. Do that step unless danger, a person, or a change of mind comes first.`);
    if (planFinished && !step) lines.push('The last plan is finished. Do not repeat its last action.');
    lines.push('During the day, pursue your ambition and the goal you chose. You may rest, talk, change your mind, or do something unplanned. Staying still for a while is a complete choice. If you act, use one !commandName. Speak with ordinary words. There is no !say or !talkTo command.');
    if (!goal) lines.push('You have no current goal. Choose one from your ambition and what you actually know, with !intention("revise", "a short note"), or rest.');
    return lines.join(' ');
}

/** Facts the decision loop can see without waiting for the model to ask. */
export function villageSafetyNote(bot) {
    if (!bot) return '';
    const parts = [];
    const phase = nightPhase(bot.time?.timeOfDay);
    if (phase === 'dusk' || phase === 'night') {
        parts.push('It is night. Return to shelter and sleep. Immediate survival comes first, then resume the sleep routine.');
    }
    if (bot.health != null && bot.health <= 10) {
        parts.push('Your health is low. Eat, retreat, or reach shelter before any other plan.');
    }
    return parts.join(' ');
}

/** Ordinary social and domestic choices are not construction plans. */
export function activityNeedsPlan(activity) {
    const simple = new Set(['talk', 'visit', 'look', 'rest', 'tend', 'decorate', 'share', 'organize', 'explore']);
    return !simple.has(activity);
}

export function usableGoal(prompt) {
    const text = String(prompt ?? '').trim();
    if (!text || text === RECOVERY_NOTICE || text === VILLAGE_AUTONOMY_PREAMBLE) return null;
    return text;
}

/**
 * Village inhabitants always have a way back into the autonomous loop when
 * they have no personal goal stored. Survival startup does not call this.
 */
export function resolveVillageAutonomy({ saved, villageAutonomy = false } = {}) {
    if (villageAutonomy) {
        return { mode: 'autonomous', goal: null, preamble: VILLAGE_AUTONOMY_PREAMBLE, ignoredSavedGoal: usableGoal(saved) };
    }
    const savedGoal = usableGoal(saved);
    if (savedGoal) return { mode: 'saved-goal', goal: savedGoal, preamble: null };
    return { mode: 'none', goal: null, preamble: null };
}

export function resolveStartupGoal({ saved, initMessage, directive }) {
    const savedGoal = usableGoal(saved);
    const startupGoal = usableGoal(initMessage);
    const fallback = usableGoal(directive);
    return {
        notice: String(initMessage ?? '').trim() === RECOVERY_NOTICE ? RECOVERY_NOTICE : null,
        goal: savedGoal || startupGoal || fallback,
        replacedSavedGoal: !!String(saved ?? '').trim() && !savedGoal,
    };
}
