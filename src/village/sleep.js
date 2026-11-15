/**
 * Actual sleep is Mineflayer's `sleep` event, which follows the client pose
 * for EntityPose.SLEEPING. Milestone 3 found that the player NBT field
 * `Sleeping` stays 0 on 1.21 while SleepTimer advances. This module does not
 * read that field, and it does not treat a model sentence as sleep.
 */
export function makeSleepId(inhabitantId, bot, now = Date.now()) {
    const day = Number.isFinite(Number(bot?.time?.day)) ? bot.time.day : 0;
    const tod = Number.isFinite(Number(bot?.time?.timeOfDay)) ? Math.floor(bot.time.timeOfDay) : 0;
    const pos = bot?.entity?.position;
    const bed = pos
        ? `${Math.floor(Number(pos.x))}_${Math.floor(Number(pos.y))}_${Math.floor(Number(pos.z))}`
        : 'bed';
    return {
        id: `sleep-${inhabitantId}-d${day}-t${tod}-b${bed}-${now}`,
        at: now,
    };
}

/**
 * Rising edge opens one session. Repeated polls while still asleep return
 * the same session. Waking closes it.
 */
export function noteSleepEdge(state, isSleeping, openSession) {
    if (isSleeping && !state.session) {
        state.session = openSession();
        return { edge: 'asleep', session: state.session };
    }
    if (!isSleeping && state.session) {
        const session = state.session;
        state.session = null;
        return { edge: 'awake', session };
    }
    if (isSleeping) return { edge: 'still', session: state.session };
    return { edge: 'idle', session: null };
}
