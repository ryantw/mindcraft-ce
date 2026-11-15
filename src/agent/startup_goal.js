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
export function villageDecisionMessage() {
    return 'You are choosing your own next moment. You have no assigned quest, profession, or lifelong ambition. A current intention, if you have one, is optional. You may visit or talk with someone nearby, look around, tend or decorate, make or share something, organize your things, rest, follow a personal interest, or abandon an intention. Speak with ordinary words. There is no !say or !talkTo command, and command syntax is not conversation. A conversation or another simple activity does not need a multistep plan. Staying still for a while is a complete choice. If you do act, use one !commandName.';
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
