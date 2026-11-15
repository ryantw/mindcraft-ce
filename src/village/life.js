import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ScenarioError } from './errors.js';

export const LIFECYCLES = new Set(['admitted', 'alive', 'absent', 'dead']);

export function lifePath(dataRoot) {
    return path.join(dataRoot, 'life.json');
}

export function readLife(dataRoot) {
    const file = lifePath(dataRoot);
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new ScenarioError(`Could not read ${file}: ${error.message}`);
    }
}

export function writeLife(dataRoot, life) {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(lifePath(dataRoot), JSON.stringify(life, null, 2));
    return life;
}

export function createAdmittedLife(admittedAt) {
    return {
        schema_version: 1,
        lifecycle: 'admitted',
        activity: null,
        admitted_at: admittedAt,
        updated_at: admittedAt,
        identity_mismatch: null,
        home_mismatch: null,
        death: null,
    };
}

/** Dead has no exit. Absence is not death. */
export function transitionLife(life, next, cause) {
    if (!life || !LIFECYCLES.has(life.lifecycle)) {
        throw new ScenarioError('Life record is missing a lifecycle.');
    }
    if (life.lifecycle === 'dead') {
        throw new ScenarioError('Dead is terminal. A deceased inhabitant cannot change lifecycle.');
    }
    if (next === 'dead') {
        if (cause !== 'verified-death') throw new ScenarioError('Only a verified death can end a life.');
        return { ...life, lifecycle: 'dead', activity: null, updated_at: new Date().toISOString() };
    }
    if (next === 'alive') {
        if (!['admitted', 'alive', 'absent'].includes(life.lifecycle)) {
            throw new ScenarioError(`Cannot start a life from '${life.lifecycle}'.`);
        }
        return { ...life, lifecycle: 'alive', activity: 'awake', updated_at: new Date().toISOString() };
    }
    if (next === 'absent') {
        if (cause === 'crash' || cause === 'disconnect' || cause === 'operator-stop') {
            return { ...life, lifecycle: 'absent', activity: null, updated_at: new Date().toISOString() };
        }
        throw new ScenarioError(`Absence requires a crash, disconnect, or operator stop, not '${cause}'.`);
    }
    throw new ScenarioError(`Unknown lifecycle '${next}'.`);
}

export function markDeadForTest(dataRoot, death = null) {
    const life = readLife(dataRoot);
    if (!life) throw new ScenarioError('Cannot mark a missing life dead.');
    const next = transitionLife(life, 'dead', 'verified-death');
    if (death) next.death = death;
    return writeLife(dataRoot, next);
}
