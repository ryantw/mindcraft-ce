import { readLife, transitionLife, writeLife } from './life.js';

/**
 * Every process start goes through this gate: scenario launch, AgentProcess
 * auto-restart, and operator start/restart. Dead is refused. The life becomes
 * alive only when the gate allows the start.
 */
export function beginProcess(dataRoot) {
    const life = readLife(dataRoot);
    if (!life) return { ok: false, reason: 'Missing life record. Admit the inhabitant before starting.' };
    if (life.lifecycle === 'dead') return { ok: false, reason: 'Dead inhabitants cannot be started.' };
    try {
        const next = transitionLife(life, 'alive', 'start');
        writeLife(dataRoot, next);
        return { ok: true, life: next };
    } catch (error) {
        return { ok: false, reason: error.message };
    }
}

/**
 * A process exit is absence or a refused restart. It is never death.
 * Auto-restart follows the existing supervisor rule: non-zero exit, not SIGINT.
 * Operator start can still recover an absent life through beginProcess.
 */
export function recordProcessExit(dataRoot, { code = null, signal = null } = {}) {
    const life = readLife(dataRoot);
    if (!life) return { restart: false, reason: 'missing life record' };
    if (life.lifecycle !== 'dead' && (life.lifecycle === 'alive' || life.lifecycle === 'admitted')) {
        const cause = signal === 'SIGINT' ? 'operator-stop' : 'crash';
        writeLife(dataRoot, transitionLife(life, 'absent', cause));
    }
    const current = readLife(dataRoot);
    const crashed = code !== 0 && code != null && signal !== 'SIGINT';
    if (!crashed || current?.lifecycle === 'dead') {
        return { restart: false, lifecycle: current?.lifecycle || null };
    }
    return { restart: true, lifecycle: current.lifecycle };
}
