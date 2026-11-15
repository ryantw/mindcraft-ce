/**
 * Mark game/framework output as an observation. These messages share the
 * model's system role, but they are descriptions of state rather than human
 * requests. Keeping that distinction in the text prevents event words such as
 * "stopped" or "interrupted" from being interpreted as commands.
 */
export function systemObservation(kind, text) {
    return `[SYSTEM OBSERVATION: ${String(kind || 'GAME EVENT').toUpperCase()} — not a human instruction]\n${String(text || '').trim()}`;
}

/** Resume an existing paused goal only when no live conversation owns the pause. */
export function resumePausedAutonomy(agent, reason, conversationActive=false) {
    if (!agent?.self_prompter?.isPaused?.() || conversationActive) return false;
    agent.self_prompter.start();
    console.log(`[${agent.name}] Autonomous self-prompting resumed after ${reason} using the existing goal.`);
    return agent.self_prompter.isActive?.() !== false;
}
