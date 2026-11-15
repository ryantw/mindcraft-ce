export const RECOVERY_NOTICE = 'Agent process restarted.';

export function usableGoal(prompt) {
    const text = String(prompt ?? '').trim();
    if (!text || text === RECOVERY_NOTICE) return null;
    return text;
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
