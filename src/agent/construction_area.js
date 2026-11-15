/**
 * Retry blocking for construction requests that keep failing in the same area.
 *
 * The exact-command retry block cannot catch an agent that guesses coordinates
 * inside solid terrain and shifts them by a block or two each attempt: every
 * attempt has a new key. This guard treats zero-progress construction failures
 * caused by the terrain itself (occupied, unreachable, unsupported targets) as
 * evidence about the *area*, and declines further requests there until the
 * agent moves well away, the evidence ages out, or construction succeeds.
 *
 * It never inspects or modifies the world; it only reasons about outcomes the
 * agent has already seen.
 */

export const CONSTRUCTION_ACTIONS = new Set(['placeBlockAt', 'buildLine', 'buildPlane']);

// Failure kinds that describe the terrain at the target. Distance, material
// and interruption failures say nothing about the area, so they do not count.
const TERRAIN_BLOCKS = ['occupied', 'unreachable', 'unsupported', 'hazard'];

function numbers(values) {
    const parsed = values.map(Number);
    return parsed.every(Number.isFinite) ? parsed : null;
}

/** Centre of the requested region, or null when the parameters are unusable. */
export function constructionTargetCenter(action, params = {}) {
    if (action === 'placeBlockAt') {
        const p = numbers([params.x, params.y, params.z]);
        return p ? { x: p[0], y: p[1], z: p[2] } : null;
    }
    if (action === 'buildLine' || action === 'buildPlane') {
        const p = numbers([params.x1, params.y1, params.z1, params.x2, params.y2, params.z2]);
        return p ? { x: (p[0] + p[3]) / 2, y: (p[1] + p[4]) / 2, z: (p[2] + p[5]) / 2 } : null;
    }
    return null;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}


function position(value) {
    if (!value) return null;
    const p = numbers([value.x, value.y, value.z]);
    return p ? { x: p[0], y: p[1], z: p[2] } : null;
}

function describe(center) {
    return `(${Math.round(center.x)}, ${Math.round(center.y)}, ${Math.round(center.z)})`;
}

export class ConstructionAreaGuard {
    constructor({ radius = 10, verticalRadius = 16, windowMs = 3 * 60 * 1000, failuresToBlock = 2, moveClearDistance = 16, maxEntries = 12, now = () => Date.now() } = {}) {
        this.radius = radius;
        this.verticalRadius = verticalRadius;
        this.windowMs = windowMs;
        this.failuresToBlock = failuresToBlock;
        this.moveClearDistance = moveClearDistance;
        this.maxEntries = maxEntries;
        this.now = now;
        this.failures = [];
    }

    _terrainFailure(outcome) {
        const counts = outcome?.evidence?.construction?.blockedCounts
            || outcome?.details?.construction?.blockedCounts
            || {};
        if (counts.too_far) return false;
        return TERRAIN_BLOCKS.some(kind => counts[kind] > 0);
    }

    /** Learn from a finished construction outcome. */
    record(outcome, botPosition) {
        if (!outcome || !CONSTRUCTION_ACTIONS.has(outcome.action)) return;
        const center = constructionTargetCenter(outcome.action, outcome.params);
        if (!center) return;

        if (outcome.status === 'success' || outcome.relevantProgress) {
            // Real progress here means the area is workable after all.
            this.failures = this.failures.filter(entry => !this._sameArea(entry.center, center));
            return;
        }
        if (outcome.status !== 'failure' || !this._terrainFailure(outcome)) return;

        this.failures.push({ center, bot: position(botPosition), at: this.now() });
        if (this.failures.length > this.maxEntries) this.failures.splice(0, this.failures.length - this.maxEntries);
    }

    // An "area" is a column: agents guessing underground drift much further
    // vertically than horizontally between attempts.
    _sameArea(a, b) {
        return Math.hypot(a.x - b.x, a.z - b.z) <= this.radius && Math.abs(a.y - b.y) <= this.verticalRadius;
    }

    _prune(botPosition) {
        const cutoff = this.now() - this.windowMs;
        const bot = position(botPosition);
        this.failures = this.failures.filter(entry => {
            if (entry.at < cutoff) return false;
            // The agent has gone somewhere else: it sees the area afresh.
            if (bot && entry.bot && distance(bot, entry.bot) > this.moveClearDistance) return false;
            return true;
        });
    }

    /** A block description when this request repeats a failing area, else null. */
    check(action, params, botPosition, describeSurroundings = null) {
        if (!CONSTRUCTION_ACTIONS.has(action)) return null;
        const center = constructionTargetCenter(action, params);
        if (!center) return null;
        this._prune(botPosition);
        const near = this.failures.filter(entry => this._sameArea(entry.center, center));
        if (near.length < this.failuresToBlock) return null;
        const anchor = near[near.length - 1].center;
        let context = '';
        if (typeof describeSurroundings === 'function') {
            try {
                context = describeSurroundings(center) || '';
            } catch (_error) {
                context = ''; // the snapshot is a courtesy; never let it break a command
            }
        }
        return {
            condition: 'construction_area',
            reason: `${near.length} recent construction attempts around ${describe(anchor)} placed nothing because the targets were occupied by terrain or could not be reached. Shifting the coordinates slightly will not change that.`,
            prerequisites: [
                'Choose coordinates in open air that rest on solid ground, or move to a different area first.',
            ],
            context,
            expectedItems: [],
            fingerprint: null,
            relevantState: null,
        };
    }

    clear() {
        this.failures = [];
    }
}
