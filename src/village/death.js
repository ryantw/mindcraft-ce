import { readLife, transitionLife, writeLife } from './life.js';
import { ScenarioError } from './errors.js';
import { planRemains } from './remains.js';
import { appendEpisode } from './episodes.js';

function positionOf(position) {
    if (!position) return null;
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
}

/**
 * Cause is the server's death translation key when it names one.
 * A generic or missing key stays null. Null means the cause is unknown.
 */
export function buildDeathFacts({ at, position, dimension, translate, message, name, site, existingEvidence = null } = {}) {
    const cause = typeof translate === 'string'
        && translate.startsWith('death.')
        && translate !== 'death.attack.generic'
        ? translate
        : null;
    const pos = positionOf(position);
    return {
        at: at || new Date().toISOString(),
        position: pos,
        dimension: dimension || null,
        cause,
        server_message: message ? String(message).slice(0, 240) : null,
        evidence: planRemains({
            position: pos,
            dimension,
            name,
            site,
            existing: existingEvidence,
        }),
    };
}

/**
 * Persist dead before any restart decision. A second signal does not create
 * a second death. A later message may fill a cause that was still unknown.
 */
export function recordVerifiedDeath(dataRoot, facts) {
    const life = readLife(dataRoot);
    if (!life) throw new ScenarioError('Cannot record a death without a life.');
    if (life.lifecycle === 'dead') {
        if (!life.death?.cause && facts?.cause) {
            const next = {
                ...life,
                death: { ...life.death, cause: facts.cause, server_message: facts.server_message || life.death.server_message },
                updated_at: new Date().toISOString(),
            };
            writeLife(dataRoot, next);
            return { life: next, created: false, updated: true };
        }
        return { life, created: false, updated: false };
    }
    const next = transitionLife(life, 'dead', 'verified-death');
    next.death = facts;
    writeLife(dataRoot, next);
    return { life: next, created: true, updated: false };
}

/**
 * One inhabitant's own conclusion. This writes only `dataRoot`.
 * channel is witness, discovery, or told.
 */
export function recordDeathKnowledge(dataRoot, { channel, text, speaker = null, refs = [] } = {}) {
    if (channel === 'witness' || channel === 'discovery') {
        return appendEpisode(dataRoot, {
            kind: 'observed',
            source: 'observed',
            text,
            refs,
        });
    }
    if (channel === 'told') {
        if (!speaker) throw new ScenarioError('A secondhand death claim needs the speaker.');
        return appendEpisode(dataRoot, {
            kind: 'told',
            source: 'told',
            text,
            refs: [speaker, ...refs.filter(item => item !== speaker)],
        });
    }
    throw new ScenarioError(`Death knowledge channel '${channel}' is not valid.`);
}
