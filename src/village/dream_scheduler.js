import { createModel } from '../models/_model_map.js';
import { dayModelsBusy, noteDayModel } from './day_pulse.js';
import { buildDreamInput, episodeCutoff } from './dream_input.js';
import { validateDreamOutput, journalOffersTomorrow } from './dream_validate.js';
import { commitDream } from './dream_commit.js';
import { readEpisodes } from './episodes.js';
import { readLife } from './life.js';
import {
    DREAM_GAP_MS,
    DREAM_MAX_DEFER_MS,
    DREAM_MODEL_UNAVAILABLE,
    DREAM_QUIET_MS,
    DREAM_TIMEOUT_MS,
    claimNext,
    clearLease,
    readQueue,
    setCooldown,
    updateJob,
    writeDreamResult,
    readDreamResult,
} from './dream_queue.js';
import path from 'path';

const SYSTEM = `You are asleep, dreaming about your own life. You are the same person who lived the day. You are not an assistant, a supervisor, a narrator, or a task assigner.

The user message is a pile of private notes. Many of them are repetitive chores. Reflect on what matters to you. Do not mention every episode. Do not transcribe inventory, coordinates, or crafting steps. Do not write a mood piece that could belong to anyone. An episode id does not make a new sentence true. If you are unsure, keep it as your own interpretation. Do not invent events, causes of death, recipes, or what someone else was thinking. Do not decide how you must feel about a person or a marker.

Write one JSON object and nothing else.
journal: a few first-person sentences about a person, a place, or a choice that stayed with you, grounded in the notes. Name them when the notes support it.
memories: a fact paraphrases a cited episode. A feeling or guess is an interpretation.
relationships: only someone who appears in a cited episode.
stance: one or two sentences on how you meet the morning.
intentions: if the journal says you want to do something tomorrow, put that desire here in your own words. Zero, one, two, or three. Leave the list empty only when you truly want no particular activity. Visiting, returning, decorating, resting, talking, helping a neighbor, or continuing a personal project are enough. An intention is not a gathering quota or a building plan.
ambition: omit this field to keep your long-term ambition. Include one sentence only when the ambition itself should change. It does not replace your admitted identity.
brief: at most ten short lines you would want in the morning. People, a place, a question. Not block counts, recipes, or coordinates.

{"journal":"","memories":[{"op":"upsert","kind":"interpretation","text":"","priority":3,"source_episode_ids":["ep-0001"]}],"relationships":[],"stance":"","intentions":[],"brief":""}`;

export function dreamCallOptions(dreamModel) {
    const name = String(dreamModel?.model || '');
    const configuredThink = dreamModel?.params?.think;
    const think = configuredThink === false ? false : (/qwen3/i.test(name) ? true : configuredThink === true);
    const timeoutMs = positive(dreamModel?.params?.timeout_ms, DREAM_TIMEOUT_MS);
    const maxPredict = Math.min(2048, positive(dreamModel?.params?.max_predict, 1536));
    const keepAlive = dreamModel?.params?.keep_alive ?? '45s';
    return { think, timeoutMs, maxPredict, keepAlive };
}

function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function intentionFollowUp(value) {
    if (!value || (value.intentions || []).length > 0) return null;
    if (!journalOffersTomorrow(value.journal)) return null;
    return 'The journal describes something you may want tomorrow. If you actually want it, put that desire in intentions as one ordinary sentence of your own. If you do not want a particular activity, leave intentions empty and rewrite the journal so it is not a promise. Do not invent a gathering quota or a building plan.';
}

function unavailable(message) {
    const error = new Error(message?.startsWith(DREAM_MODEL_UNAVAILABLE) ? message : `${DREAM_MODEL_UNAVAILABLE} ${message || ''}`.trim());
    error.code = 'unavailable';
    return error;
}

export async function requestDream(dreamModel, snapshot, { retries = 1, complete = null } = {}) {
    const options = dreamCallOptions(dreamModel || {});
    if (!complete) {
        if (!dreamModel?.model || !dreamModel?.api) throw unavailable(DREAM_MODEL_UNAVAILABLE);
        let model;
        try {
            model = createModel(structuredClone(dreamModel));
        } catch (error) {
            throw unavailable(error.message);
        }
        if (typeof model.complete !== 'function') throw unavailable('This provider cannot complete a dream.');
        complete = (user, system) => model.complete(user, system, {
            think: options.think,
            keep_alive: options.keepAlive,
            timeout_ms: options.timeoutMs,
            max_predict: options.maxPredict,
            allow_long_completion: true,
            options: { num_predict: options.maxPredict },
        });
    }
    let lastError = 'Dream output was not usable.';
    const attempts = retries + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const user = attempt === 1
            ? snapshot.text
            : `${snapshot.text}\n\nThe previous reply was rejected: ${lastError}\nReply with only the JSON object.`;
        const started = Date.now();
        let response;
        try {
            response = await complete(user, SYSTEM);
        } catch (error) {
            const missing = error.status === 404 || /not found|model/i.test(error.message || '');
            if (missing || error.code === 'unavailable') throw unavailable(error.message);
            lastError = error.message || 'Dream model request failed.';
            if (attempt === attempts) throw new Error(lastError);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
        }
        const validated = validateDreamOutput(response?.content, snapshot);
        if (validated.ok) {
            const followUp = attempt === 1 ? intentionFollowUp(validated.value) : null;
            if (followUp) {
                lastError = followUp;
                continue;
            }
            return {
                ok: true,
                validated: validated.value,
                dropped: validated.dropped,
                raw: String(response.content || '').slice(0, 8000),
                prompt_tokens: response.prompt_eval_count ?? null,
                generated_tokens: response.eval_count ?? null,
                duration_ms: Date.now() - started,
                attempts: attempt,
            };
        }
        lastError = validated.reason;
    }
    return { ok: false, error: lastError, attempts };
}

function inhabitantRoot(scenarioRoot, inhabitantId) {
    return path.join(scenarioRoot, inhabitantId);
}

function lifeOf(scenarioRoot, inhabitantId) {
    return readLife(inhabitantRoot(scenarioRoot, inhabitantId));
}

export async function tickDreams({
    scenarioRoot,
    actorId,
    allowApply = false,
    client = null,
    now = Date.now(),
    busy = false,
    dreamModel = null,
    gapMs = DREAM_GAP_MS,
} = {}) {
    if (!scenarioRoot || !actorId) return { action: 'idle' };
    const isDead = (id) => lifeOf(scenarioRoot, id)?.lifecycle === 'dead';
    if (allowApply && !busy) {
        const applied = applyReadyDreams(scenarioRoot, actorId, { now, isDead });
        if (applied.applied) return { action: 'applied', ...applied };
    }
    const queue = readQueue(scenarioRoot);
    if (queue.cooldown_until && now < queue.cooldown_until) return { action: 'gap' };
    const oldest = queue.jobs.find(job => job.status === 'queued' || (job.status === 'running' && !job.ready));
    const age = oldest ? now - Date.parse(oldest.enqueued_at) : 0;
    if (dayModelsBusy(scenarioRoot, now, DREAM_QUIET_MS) && age < DREAM_MAX_DEFER_MS) {
        return { action: 'defer' };
    }
    const claim = claimNext(scenarioRoot, actorId, { now, isDead });
    if (!claim.claimed) return { action: claim.reason || 'idle', ...claim };
    const job = claim.job;
    const dataRoot = inhabitantRoot(scenarioRoot, job.inhabitant_id);
    try {
        const outcome = client
            ? await client(job, dataRoot)
            : await runDreamClient(dreamModel, job, dataRoot);
        if (!outcome?.ok) {
            updateJob(scenarioRoot, job.sleep_id, {
                status: 'rejected',
                ready: false,
                error: outcome?.error || 'Dream output was not usable.',
                finished_at: new Date(now).toISOString(),
            });
            clearLease(scenarioRoot, job.sleep_id);
            setCooldown(scenarioRoot, Date.now() + gapMs);
            return { action: 'rejected', sleep_id: job.sleep_id, error: outcome?.error };
        }
        writeDreamResult(dataRoot, job.sleep_id, {
            sleep_id: job.sleep_id,
            validated: outcome.validated,
            episode_ids: outcome.episodeIds,
            input_text: outcome.input_text || '',
            metrics: {
                prompt_tokens: outcome.prompt_tokens ?? null,
                generated_tokens: outcome.generated_tokens ?? null,
                duration_ms: outcome.duration_ms ?? null,
                attempts: outcome.attempts ?? 1,
                input_chars: outcome.input_chars ?? null,
            },
        });
        updateJob(scenarioRoot, job.sleep_id, { ready: true, error: null });
        clearLease(scenarioRoot, job.sleep_id);
        setCooldown(scenarioRoot, Date.now() + gapMs);
        if (allowApply && !busy && job.inhabitant_id === actorId) {
            const applied = applyReadyDreams(scenarioRoot, actorId, { now: Date.now(), isDead });
            return { action: applied.applied ? 'applied' : 'ready', sleep_id: job.sleep_id, ...applied };
        }
        return { action: 'ready', sleep_id: job.sleep_id };
    } catch (error) {
        const message = error.code === 'unavailable' ? error.message : (error.message || 'Dream model request failed.');
        updateJob(scenarioRoot, job.sleep_id, {
            status: 'rejected',
            ready: false,
            error: message,
            finished_at: new Date(now).toISOString(),
        });
        clearLease(scenarioRoot, job.sleep_id);
        setCooldown(scenarioRoot, Date.now() + gapMs);
        return { action: 'rejected', sleep_id: job.sleep_id, error: message };
    }
}

async function runDreamClient(dreamModel, job, dataRoot) {
    const store = readEpisodes(dataRoot);
    const cutoff = episodeCutoff(store);
    const snapshot = buildDreamInput(dataRoot, { cutoffIndex: cutoff.index, sleepId: job.sleep_id });
    const result = await requestDream(dreamModel, snapshot);
    return { ...result, episodeIds: snapshot.episodeIds, input_chars: snapshot.chars, input_text: snapshot.text };
}

export function applyReadyDreams(scenarioRoot, actorId, { now = Date.now(), isDead = null } = {}) {
    const dead = isDead || ((id) => lifeOf(scenarioRoot, id)?.lifecycle === 'dead');
    const queue = readQueue(scenarioRoot);
    const ready = queue.jobs.filter(job => job.inhabitant_id === actorId && job.status === 'running' && job.ready);
    let applied = false;
    let rejected = false;
    for (const job of ready) {
        const dataRoot = inhabitantRoot(scenarioRoot, actorId);
        if (dead(actorId)) {
            updateJob(scenarioRoot, job.sleep_id, {
                status: 'rejected',
                ready: false,
                error: 'dead',
                finished_at: new Date(now).toISOString(),
            });
            rejected = true;
            continue;
        }
        const result = readDreamResult(dataRoot, job.sleep_id);
        if (!result?.validated) {
            updateJob(scenarioRoot, job.sleep_id, {
                status: 'rejected',
                ready: false,
                error: 'missing dream result',
                finished_at: new Date(now).toISOString(),
            });
            rejected = true;
            continue;
        }
        const commit = commitDream(dataRoot, {
            sleepId: job.sleep_id,
            profileChecksum: job.profile_checksum,
            validated: result.validated,
            episodeIds: result.episode_ids || [],
            enqueuedAt: job.enqueued_at,
            now: new Date(now).toISOString(),
        });
        if (!commit.applied) {
            updateJob(scenarioRoot, job.sleep_id, {
                status: 'rejected',
                ready: false,
                error: commit.reason,
                finished_at: new Date(now).toISOString(),
            });
            rejected = true;
            continue;
        }
        updateJob(scenarioRoot, job.sleep_id, {
            status: 'applied',
            ready: false,
            finished_at: new Date(now).toISOString(),
            error: null,
        });
        applied = true;
        console.log(`[dream] inhabitant=${actorId} sleep=${job.sleep_id} status=applied prompt_tokens=${result.metrics?.prompt_tokens ?? 'unknown'} generated_tokens=${result.metrics?.generated_tokens ?? 'unknown'} duration_ms=${result.metrics?.duration_ms ?? 'unknown'} input_chars=${result.metrics?.input_chars ?? 'unknown'}`);
    }
    return { applied, rejected };
}

export function scenarioRootFrom(dataRoot) {
    return dataRoot ? path.dirname(dataRoot) : null;
}

export { noteDayModel };
