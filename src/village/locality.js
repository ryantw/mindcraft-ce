/** Ordinary speech is audible inside this radius. Operators do not use this channel. */
export const DEFAULT_HEARING_BLOCKS = 32;

export function distanceBetween(left, right) {
    if (!left || !right) return null;
    const dx = Number(left.x) - Number(right.x);
    const dy = Number(left.y) - Number(right.y);
    const dz = Number(left.z) - Number(right.z);
    if (![dx, dy, dz].every(Number.isFinite)) return null;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function speakerDistance(bot, username) {
    const self = bot?.entity?.position;
    const other = bot?.players?.[username]?.entity?.position;
    return distanceBetween(self, other);
}

/**
 * Village speech requires a loaded body inside the hearing radius.
 * A missing position is silence. It is not described as a death or an absence.
 * Survival sessions do not call this; they keep the existing chat path.
 */
export function acceptInWorldSpeech({ village = false, distance = null, range = DEFAULT_HEARING_BLOCKS } = {}) {
    if (!village) return true;
    if (distance == null || !Number.isFinite(distance)) return false;
    return distance <= range;
}

const recentSpeech = new Map();
const SPEECH_DEDUPE_MS = 3000;

/** Public mirrors prefix the same sentence. Both copies are one utterance. */
export function comparableSpeech(message) {
    return String(message ?? '')
        .replace(/^\(To [^)]+\)\s*/i, '')
        .replace(/^\(FROM OTHER BOT\)/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * The first handler to claim an utterance within three seconds delivers it.
 * A later MindServer copy or public chat copy of that same sentence does not.
 */
export function claimSpeech(speaker, message, now = Date.now()) {
    const body = comparableSpeech(message);
    if (!speaker || !body) return false;
    const key = `${String(speaker).toLowerCase()}|${body}`;
    const previous = recentSpeech.get(key);
    recentSpeech.set(key, now);
    if (recentSpeech.size > 200) {
        for (const [stored, at] of recentSpeech) {
            if (now - at > SPEECH_DEDUPE_MS) recentSpeech.delete(stored);
        }
    }
    return previous == null || now - previous >= SPEECH_DEDUPE_MS;
}

export function resetSpeechClaims() {
    recentSpeech.clear();
}
