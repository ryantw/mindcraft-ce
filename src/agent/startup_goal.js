export const RECOVERY_NOTICE = 'Agent process restarted.';

/**
 * Starts the village autonomous loop without becoming a saved ambition.
 * usableGoal ignores it, so a restart does not treat it as a lifelong quest.
 */
export const VILLAGE_AUTONOMY_PREAMBLE = 'You are an independent inhabitant of this village. You have no assigned quest, profession, or lifelong ambition. A current intention, if one is active, is optional. When you have no intention and no ambition, choose for yourself what to do next from your surroundings and your own judgment.';

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
    const savedGoal = usableGoal(saved);
    if (savedGoal) return { mode: 'saved-goal', goal: savedGoal, preamble: null };
    if (villageAutonomy) return { mode: 'autonomous', goal: null, preamble: VILLAGE_AUTONOMY_PREAMBLE };
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
