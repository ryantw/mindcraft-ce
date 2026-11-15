import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * Scheduling policy (one scenario, many processes):
 *
 * - Successful sleep is Mineflayer's sleep event after `bot.sleep()` resolves
 *   (`bot.isSleeping`). The 1.21 player NBT `Sleeping` byte stays 0 during
 *   real sleep; this queue does not read it. The model claiming it slept
 *   does not enqueue a dream.
 * - One row per sleep session. Polls of the same session share `sleep_id`.
 *   A second session is refused while a job is `queued` or `running`, and
 *   also within `MIN_SLEEP_GAP_MS` of the previous enqueue, so a rapid
 *   sleep/wake loop cannot create an unbounded series.
 * - `dream_queue.json` is the durable queue. A mkdir lock guards mutations.
 *   `dream_lease.json` is the cross-process turn: only the lease holder may
 *   call the dream model. A lock inside one Node process is not enough.
 * - Jobs are FIFO. The holder may build another inhabitant's dream from that
 *   person's files. Application of the result stays with that person, at a
 *   decision boundary when they are not inside an action.
 * - Day-model calls are never queued behind a dream. A dream waits up to
 *   `DREAM_MAX_DEFER_MS` for `DREAM_QUIET_MS` without a day call, then starts.
 *   After a dream, the next one waits `DREAM_GAP_MS` so the day model can
 *   return to memory. The dream model's keep_alive is short so it unloads.
 * - No sleep means no dream. A dead life is not enqueued, and a pending job
 *   is rejected instead of applied. Failed inference leaves prior files.
 */

export const MIN_SLEEP_GAP_MS = 90_000;
export const DREAM_QUIET_MS = 3_000;
export const DREAM_MAX_DEFER_MS = 45_000;
export const DREAM_GAP_MS = 20_000;
export const DREAM_TIMEOUT_MS = 180_000;
export const DREAM_LEASE_MS = 420_000;
export const DREAM_MODEL_UNAVAILABLE = 'Dream model unavailable.';

const STATUSES = new Set(['queued', 'running', 'applied', 'rejected']);

function queuePath(scenarioRoot) {
    return path.join(scenarioRoot, 'dream_queue.json');
}

function leasePath(scenarioRoot) {
    return path.join(scenarioRoot, 'dream_lease.json');
}

function lockPath(scenarioRoot) {
    return path.join(scenarioRoot, 'dream_queue.lock');
}

function writeAtomic(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, file);
}

export function emptyQueue() {
    return { schema_version: 1, cooldown_until: 0, jobs: [] };
}

export function readQueue(scenarioRoot) {
    const file = queuePath(scenarioRoot);
    if (!existsSync(file)) return emptyQueue();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
        ...emptyQueue(),
        ...parsed,
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
}

function writeQueue(scenarioRoot, queue) {
    writeAtomic(queuePath(scenarioRoot), queue);
    return queue;
}

export function readLease(scenarioRoot) {
    const file = leasePath(scenarioRoot);
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeLease(scenarioRoot, lease) {
    if (!lease) {
        if (existsSync(leasePath(scenarioRoot))) rmSync(leasePath(scenarioRoot), { force: true });
        return null;
    }
    writeAtomic(leasePath(scenarioRoot), lease);
    return lease;
}

function stampOf(file) {
    try {
        const text = readFileSync(path.join(file, 'owner'), 'utf8');
        return Number(text.split('\n')[1]) || 0;
    } catch {
        return 0;
    }
}

export function withQueueLock(scenarioRoot, fn, { timeoutMs = 8000, staleMs = 20000 } = {}) {
    mkdirSync(scenarioRoot, { recursive: true });
    const lock = lockPath(scenarioRoot);
    const start = Date.now();
    for (;;) {
        try {
            mkdirSync(lock);
            writeFileSync(path.join(lock, 'owner'), `${process.pid}\n${Date.now()}`);
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const stamp = stampOf(lock);
            if (stamp && Date.now() - stamp > staleMs) {
                rmSync(lock, { recursive: true, force: true });
                continue;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error('Dream queue lock timed out.');
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
    }
    try {
        return fn();
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}

function iso(now) {
    return new Date(now).toISOString();
}

export function enqueueSleep(scenarioRoot, {
    inhabitantId,
    sleepId,
    profileChecksum,
    life = 'alive',
    now = Date.now(),
    minGapMs = MIN_SLEEP_GAP_MS,
} = {}) {
    if (!scenarioRoot || !inhabitantId || !sleepId) return { enqueued: false, reason: 'incomplete' };
    if (life === 'dead') return { enqueued: false, reason: 'dead' };
    if (!STATUSES.has('queued')) return { enqueued: false, reason: 'incomplete' };
    return withQueueLock(scenarioRoot, () => {
        const queue = readQueue(scenarioRoot);
        const mine = queue.jobs.filter(job => job.inhabitant_id === inhabitantId);
        const same = mine.find(job => job.sleep_id === sleepId);
        if (same) return { enqueued: false, reason: 'duplicate-session', job: same };
        if (mine.some(job => job.status === 'queued' || job.status === 'running')) {
            return { enqueued: false, reason: 'in-progress' };
        }
        const latest = mine.reduce((max, job) => Math.max(max, Date.parse(job.enqueued_at) || 0), 0);
        if (latest && now - latest < minGapMs) return { enqueued: false, reason: 'rapid-cycle' };
        const job = {
            inhabitant_id: inhabitantId,
            sleep_id: sleepId,
            status: 'queued',
            profile_checksum: profileChecksum || '',
            enqueued_at: iso(now),
            started_at: null,
            finished_at: null,
            error: null,
            ready: false,
        };
        queue.jobs.push(job);
        writeQueue(scenarioRoot, queue);
        return { enqueued: true, job };
    });
}

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function leaseActive(lease, now) {
    if (!lease || Date.parse(lease.expires_at) <= now) return false;
    // A missing pid keeps the time-based lease. A dead pid is a crash, and
    // waiting out the full inference budget would freeze every other dream.
    if (lease.pid != null && !processAlive(lease.pid)) return false;
    return true;
}

/**
 * Claim the oldest dream that still needs the model. A live lease belonging
 * to any process blocks the claim. An expired lease can be taken so a crash
 * does not freeze the scenario.
 */
export function claimNext(scenarioRoot, actorId, { now = Date.now(), leaseMs = DREAM_LEASE_MS, isDead = () => false } = {}) {
    return withQueueLock(scenarioRoot, () => {
        const queue = readQueue(scenarioRoot);
        const lease = readLease(scenarioRoot);
        if (leaseActive(lease, now)) {
            return { claimed: false, reason: 'leased', holder: lease.inhabitant_id, sleep_id: lease.sleep_id };
        }
        let changed = false;
        for (const job of queue.jobs) {
            if ((job.status === 'queued' || job.status === 'running') && isDead(job.inhabitant_id)) {
                job.status = 'rejected';
                job.ready = false;
                job.error = 'dead';
                job.finished_at = iso(now);
                changed = true;
            }
        }
        const head = queue.jobs.find(job =>
            job.status === 'queued' || (job.status === 'running' && job.ready !== true)
        );
        if (!head) {
            if (changed) writeQueue(scenarioRoot, queue);
            writeLease(scenarioRoot, null);
            return { claimed: false, reason: 'empty' };
        }
        head.status = 'running';
        head.started_at = head.started_at || iso(now);
        writeQueue(scenarioRoot, queue);
        writeLease(scenarioRoot, {
            holder: actorId,
            inhabitant_id: head.inhabitant_id,
            sleep_id: head.sleep_id,
            pid: process.pid,
            expires_at: iso(now + leaseMs),
        });
        return { claimed: true, job: head };
    });
}

export function updateJob(scenarioRoot, sleepId, patch) {
    return withQueueLock(scenarioRoot, () => {
        const queue = readQueue(scenarioRoot);
        const job = queue.jobs.find(item => item.sleep_id === sleepId);
        if (!job) return null;
        Object.assign(job, patch);
        writeQueue(scenarioRoot, queue);
        return job;
    });
}

export function clearLease(scenarioRoot, sleepId = null) {
    return withQueueLock(scenarioRoot, () => {
        const lease = readLease(scenarioRoot);
        if (!lease) return;
        if (sleepId && lease.sleep_id !== sleepId) return;
        writeLease(scenarioRoot, null);
    });
}

export function rejectInhabitantDreams(scenarioRoot, inhabitantId, now = Date.now()) {
    if (!scenarioRoot || !inhabitantId) return [];
    return withQueueLock(scenarioRoot, () => {
        const queue = readQueue(scenarioRoot);
        const rejected = [];
        for (const job of queue.jobs) {
            if (job.inhabitant_id !== inhabitantId) continue;
            if (job.status !== 'queued' && job.status !== 'running') continue;
            job.status = 'rejected';
            job.ready = false;
            job.error = 'dead';
            job.finished_at = iso(now);
            rejected.push(job.sleep_id);
        }
        writeQueue(scenarioRoot, queue);
        const lease = readLease(scenarioRoot);
        if (lease?.inhabitant_id === inhabitantId) writeLease(scenarioRoot, null);
        return rejected;
    });
}

export function setCooldown(scenarioRoot, until) {
    return withQueueLock(scenarioRoot, () => {
        const queue = readQueue(scenarioRoot);
        queue.cooldown_until = until;
        writeQueue(scenarioRoot, queue);
    });
}

export function resultPath(dataRoot, sleepId) {
    const safe = String(sleepId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dataRoot, 'dream_results', `${safe}.json`);
}

export function writeDreamResult(dataRoot, sleepId, result) {
    writeAtomic(resultPath(dataRoot, sleepId), result);
}

export function readDreamResult(dataRoot, sleepId) {
    const file = resultPath(dataRoot, sleepId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Hold the scenario lease for `ms` and return the interval. Used to prove
 * two processes cannot dream at once. A second caller waits.
 */
export async function holdLease(scenarioRoot, holder, ms, now = Date.now()) {
    const sleepId = `hold-${holder}-${now}`;
    const claimedAt = Date.now();
    for (;;) {
        const claim = claimNext(scenarioRoot, holder, {
            now: Date.now(),
            leaseMs: ms + 1000,
            isDead: () => false,
        });
        if (claim.claimed || claim.reason === 'empty') {
            if (claim.reason === 'empty') {
                enqueueSleep(scenarioRoot, {
                    inhabitantId: holder,
                    sleepId,
                    profileChecksum: 'hold',
                    life: 'alive',
                    now: Date.now(),
                    minGapMs: 0,
                });
                continue;
            }
            const start = Date.now();
            await new Promise(resolve => setTimeout(resolve, ms));
            const end = Date.now();
            updateJob(scenarioRoot, claim.job.sleep_id, {
                status: 'applied',
                ready: false,
                finished_at: new Date(end).toISOString(),
            });
            clearLease(scenarioRoot, claim.job.sleep_id);
            return { holder, start, end, waited: start - claimedAt };
        }
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}
