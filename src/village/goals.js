import settings from '../agent/settings.js';
import { activeAmbitionText, ensureSeededAmbition, readAmbitions } from './ambitions.js';
import { milestoneNotes } from './goal_context.js';
import { activeIntentionText, noteMilestoneReview, readIntentions, updateIntention } from './intentions.js';
import { autonomyPausedForNight, nightPhase } from './night.js';

export const GOAL_SYSTEM = 'Return only a JSON object. {"goal":null} is a real decline. An empty or cut-off reply is not a decline.';

export const GOAL_MODEL_PARAMS = {
    think: false,
    timeout_ms: 120000,
    max_predict: 512,
    options: { num_predict: 512 },
};

const CHOICE_INSTRUCTIONS = [
    'Choose one meaningful, achievable personal milestone for this stretch of your life, or decline.',
    'A milestone is a result you could reach and later recognize. It is not the next physical action.',
    'Inspecting a furnace, checking a chest, examining a tool, walking to a spot you already know, or announcing what you are about to do are steps toward a milestone. They are not the milestone.',
    'You may imagine a future possibility. You may aim to construct something that does not exist yet, to explore a location you have not visited, or to form a new personal aspiration.',
    'Do not invent a past event, an item, a relationship, or a feature of the world that is not written in these notes. If you have not visited a place, do not claim you already know what is there.',
    'If you do not want a milestone, return {"goal":null}. Use that only for a genuine decline.',
    'Return only JSON: {"goal":null} or {"goal":"one sentence"}.',
].join('\n');

const REVIEW_INSTRUCTIONS = [
    'You already have a current goal. Decide privately whether it is a meaningful milestone toward your ambition, or only a next action.',
    'Inspecting a furnace, checking a chest, examining a tool, or announcing the action are steps. They are not the milestone.',
    'You may imagine a future possibility, including something that does not exist yet. Do not invent a past event, an item, a relationship, or a feature of the world that is not written in these notes.',
    'retain: the current goal is worth continuing. Set goal to null.',
    'revise: replace it with one milestone. Set goal to the new sentence.',
    'abandon: stop it. Set goal to a different milestone, or null if you do not want one now.',
    'Return only JSON: {"decision":"retain"|"revise"|"abandon","goal":null}.',
    'An empty or cut-off reply is not a decision to keep or drop the goal.',
].join('\n');

const CORRECTION = 'The previous reply was empty, cut off, or not the required JSON object. Return only the JSON object.';

function clip(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A private chance to choose a milestone. No command catalog.
 * The model may decline with {"goal":null}. The engine does not invent the goal.
 */
export function goalSelectionPrompt(dataRoot, options = {}) {
    return [CHOICE_INSTRUCTIONS, milestoneNotes(dataRoot, options)].join('\n');
}

/**
 * One review of a goal that is already active. The model may keep, replace, or close it.
 */
export function goalReviewPrompt(dataRoot, options = {}) {
    const current = activeIntentionText(readIntentions(dataRoot));
    return [
        REVIEW_INSTRUCTIONS,
        `Current goal: ${clip(current, 180) || 'none'}`,
        milestoneNotes(dataRoot, options),
    ].join('\n');
}

export function parseGoalChoice(text, doneReason = '') {
    const raw = String(text || '').trim();
    if (!raw) return { status: 'failed', reason: doneReason === 'length' ? 'truncated' : 'empty' };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { status: 'failed', reason: doneReason === 'length' ? 'truncated' : 'malformed' };
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return { status: 'failed', reason: 'malformed' };
    }
    if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'goal')) {
        return { status: 'failed', reason: 'malformed' };
    }
    if (parsed.goal === null) return { status: 'declined', goal: null };
    if (typeof parsed.goal === 'string' && clip(parsed.goal, 180)) {
        return { status: 'goal', goal: clip(parsed.goal, 180) };
    }
    return { status: 'failed', reason: 'malformed' };
}

export function parseGoalReview(text, doneReason = '') {
    const raw = String(text || '').trim();
    if (!raw) return { status: 'failed', reason: doneReason === 'length' ? 'truncated' : 'empty' };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { status: 'failed', reason: doneReason === 'length' ? 'truncated' : 'malformed' };
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return { status: 'failed', reason: 'malformed' };
    }
    const decision = String(parsed?.decision || '').trim();
    if (!['retain', 'revise', 'abandon'].includes(decision)) {
        return { status: 'failed', reason: 'malformed' };
    }
    const goal = typeof parsed.goal === 'string' ? clip(parsed.goal, 180) : null;
    if (decision === 'revise' && !goal) return { status: 'failed', reason: 'malformed' };
    return { status: 'decision', decision, goal };
}

function responseOf(value) {
    if (typeof value === 'string') return { content: value, done_reason: '' };
    return { content: value?.content || '', done_reason: value?.done_reason || '' };
}

async function requestParsed(complete, prompt, parse) {
    let attempts = 0;
    let raw = '';
    let parsed = { status: 'failed', reason: 'empty' };
    for (let attempt = 0; attempt < 2; attempt++) {
        const asked = attempt === 0 ? prompt : `${prompt}\n${CORRECTION}`;
        attempts += 1;
        try {
            const response = responseOf(await complete(asked));
            raw = response.content;
            parsed = parse(response.content, response.done_reason);
        } catch (error) {
            raw = '';
            parsed = { status: 'failed', reason: 'empty', message: error.message };
        }
        if (parsed.status !== 'failed') break;
    }
    return { parsed, attempts, raw };
}

export async function chooseCurrentGoal(dataRoot, { complete, now = () => new Date().toISOString(), inventory } = {}) {
    if (!dataRoot || activeIntentionText(readIntentions(dataRoot))) return { chosen: false, reason: 'has goal' };
    if (typeof complete !== 'function') return { chosen: false, reason: 'no model' };
    const { parsed, attempts, raw } = await requestParsed(
        complete,
        goalSelectionPrompt(dataRoot, { inventory }),
        parseGoalChoice,
    );
    if (parsed.status === 'declined') return { chosen: false, reason: 'declined', raw, attempts };
    if (parsed.status !== 'goal') return { chosen: false, reason: 'generation_failed', failure: parsed.reason, raw, attempts };
    const saved = updateIntention(dataRoot, { action: 'revise', text: parsed.goal, source: 'reflection', now });
    if (!saved.ok) return { chosen: false, reason: saved.reason, raw, attempts };
    noteMilestoneReview(dataRoot, { decision: 'selected', priorText: parsed.goal, now });
    return { chosen: true, goal: parsed.goal, intentions: readIntentions(dataRoot), attempts };
}

/**
 * Ask once about a goal that was already active. A failed reply leaves the goal in place.
 * The experimental sample goals are not written here.
 */
export async function reconsiderCurrentGoal(dataRoot, { complete, now = () => new Date().toISOString(), inventory } = {}) {
    const current = activeIntentionText(readIntentions(dataRoot));
    if (!current) return { reviewed: false, reason: 'no goal' };
    if (readIntentions(dataRoot).milestone_review) return { reviewed: false, reason: 'already reviewed' };
    if (typeof complete !== 'function') return { reviewed: false, reason: 'no model' };
    const { parsed, attempts, raw } = await requestParsed(
        complete,
        goalReviewPrompt(dataRoot, { inventory }),
        parseGoalReview,
    );
    if (parsed.status !== 'decision') {
        return { reviewed: false, reason: 'generation_failed', failure: parsed.reason, raw, attempts };
    }
    let goal = current;
    if (parsed.decision === 'revise') {
        if (parsed.goal === current) {
            noteMilestoneReview(dataRoot, { decision: 'retain', priorText: current, now });
            return { reviewed: true, decision: 'retain', goal: current, attempts };
        }
        const saved = updateIntention(dataRoot, { action: 'revise', text: parsed.goal, source: 'reflection', now });
        if (!saved.ok) return { reviewed: false, reason: saved.reason, raw, attempts };
        goal = activeIntentionText(readIntentions(dataRoot));
    } else if (parsed.decision === 'abandon') {
        const closed = updateIntention(dataRoot, { action: 'abandon', text: 'Closed after a private review.', source: 'reflection', now });
        if (!closed.ok) return { reviewed: false, reason: closed.reason, raw, attempts };
        if (parsed.goal && parsed.goal !== current) {
            const saved = updateIntention(dataRoot, { action: 'revise', text: parsed.goal, source: 'reflection', now });
            if (!saved.ok) {
                noteMilestoneReview(dataRoot, { decision: 'abandon', priorText: current, now });
                return { reviewed: true, decision: 'abandon', goal: '', attempts, replacementFailed: saved.reason };
            }
        }
        goal = activeIntentionText(readIntentions(dataRoot));
    }
    noteMilestoneReview(dataRoot, { decision: parsed.decision, priorText: current, now });
    return { reviewed: true, decision: parsed.decision === 'revise' && goal === current ? 'retain' : parsed.decision, goal, attempts };
}

export function syncPlanToGoal(planManager, goal) {
    if (!planManager?.enabled || !goal) return false;
    const plan = planManager.getCurrentPlan?.();
    if (plan && plan.status === 'active' && plan.objective !== goal) {
        return planManager.abandon('the current goal changed');
    }
    return false;
}

const GOAL_DECISIONS = new Set(['achieved', 'follow_up', 'revise', 'abandon']);

const INFORMATION_STEPS = new Set([
    'goToCoordinates', 'goToRememberedPlace', 'goToPlayer', 'moveAway',
    'nearbyBlocks', 'entities', 'inventory', 'savedPlaces',
]);

/** Travel and observation do not finish a goal that still depends on what was seen. */
export function observationPlanCannotFinish(plan) {
    const steps = (plan?.steps || []).filter(step => step?.status !== 'skipped');
    if (!steps.length) return false;
    return steps.every(step => INFORMATION_STEPS.has(step?.action?.name));
}

/**
 * A finished plan is not a new plan and not a finished ambition.
 * Replan only when the inhabitant asked to continue or changed the goal.
 */
export function finishedPlanNeedsReplan(plan, goal) {
    if (!goal) return false;
    if (!plan || plan.status !== 'completed') return true;
    const decision = plan.goalDecision;
    if (decision === 'follow_up' || decision === 'revise') return true;
    if (decision === 'abandon' && goal) return true;
    return false;
}

export function completedPlanLines(plan) {
    const lines = [
        `Finished plan objective: ${clip(plan?.objective, 240) || 'none'}`,
        `Plan status: ${plan?.status || 'none'}`,
    ];
    for (const step of plan?.steps || []) {
        const action = step?.action?.name || 'none';
        const params = JSON.stringify(step?.action?.params || {});
        const status = step?.lastOutcome?.status || step?.status || 'unknown';
        lines.push(`- ${step?.id || 'step'}: ${clip(step?.description, 160)} Command ${action} ${params}. Verified status: ${status}.`);
        if (step?.lastOutcome?.observation) lines.push(`  Observed: ${clip(step.lastOutcome.observation, 400)}`);
    }
    return lines.join('\n');
}

export function goalEvaluationPrompt({ name = 'yourself', ambition = '', goal = '', plan = null } = {}) {
    return [
        `You are ${name}. A plan has finished. This is a private decision, not speech and not a command.`,
        'A finished plan does not by itself finish the current goal, and it does not finish the long-term ambition.',
        'Use only the verified outcomes below. Do not invent places, materials, people, or events.',
        'A plan that only travels and looks does not finish a goal of exploring, discovering, or collecting. Choose follow_up. Do not say an object was collected unless a step verified that item.',
        ambition ? `Long-term ambition, still in force: ${clip(ambition, 240)}` : 'No long-term ambition is recorded.',
        `Current goal: ${clip(goal, 180)}`,
        completedPlanLines(plan),
        'Return only JSON: {"decision":"achieved"|"follow_up"|"revise"|"abandon","goal":null,"note":"one short sentence"}.',
        'achieved: the current goal is done. Set goal to null. The ambition stays.',
        'follow_up: the same goal needs another plan. Set goal to null.',
        'revise: change the wording of the current goal. Set goal to the new sentence.',
        'abandon: stop this goal. Set goal to a different sentence if you want another goal now, or null if you do not.',
        'Do not repeat the finished plan or its last action.',
    ].join('\n');
}

function parseGoalDecision(text) {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const decision = String(parsed.decision || '').trim();
        if (!GOAL_DECISIONS.has(decision)) return null;
        const goal = typeof parsed.goal === 'string' ? clip(parsed.goal, 180) : null;
        const note = clip(parsed.note, 160);
        return { decision, goal, note };
    } catch {
        return null;
    }
}

/**
 * Apply the inhabitant's decision. The ambition file is not written.
 * achieved closes the goal. follow_up leaves it. revise replaces its words.
 * abandon closes it, then installs a different goal only when one was given.
 */
export function applyGoalDecision(dataRoot, decision, { goal = null, note = '', now = () => new Date().toISOString() } = {}) {
    const kind = String(decision || '');
    if (!GOAL_DECISIONS.has(kind)) return { applied: false, reason: 'invalid decision' };
    const ambitionBefore = activeAmbitionText(readAmbitions(dataRoot));
    const current = activeIntentionText(readIntentions(dataRoot));
    let result = { ok: true };
    if (kind === 'achieved') {
        result = updateIntention(dataRoot, { action: 'complete', text: note, source: 'reflection', now });
    } else if (kind === 'revise') {
        if (!goal) return { applied: false, reason: 'revise needs a goal' };
        result = updateIntention(dataRoot, { action: 'revise', text: goal, source: 'reflection', now });
    } else if (kind === 'abandon') {
        result = updateIntention(dataRoot, { action: 'abandon', text: note, source: 'reflection', now });
        if (result.ok && goal && goal !== current) {
            result = updateIntention(dataRoot, { action: 'revise', text: goal, source: 'reflection', now });
        }
    }
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        decision: kind,
        goal: activeIntentionText(readIntentions(dataRoot)),
        ambitionUnchanged: ambitionBefore === activeAmbitionText(readAmbitions(dataRoot)),
    };
}

async function evaluateFinishedPlan(agent, dataRoot, goal) {
    const manager = agent?.plan_manager;
    const plan = manager?.getCurrentPlan?.();
    if (!goal || !plan || plan.status !== 'completed' || plan.goalDecision) return false;
    if (!agent?.prompter?.chat_model?.complete) return false;
    const prompt = goalEvaluationPrompt({
        name: agent.name,
        ambition: activeAmbitionText(readAmbitions(dataRoot)),
        goal,
        plan,
    });
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        let text = '';
        try {
            const response = await agent.prompter.chat_model.complete(
                prompt,
                'Decide what the finished plan means for the current goal. Return only the JSON object. Do not invent events.',
                { think: false, timeout_ms: 120000, max_predict: 512, options: { num_predict: 512 } }
            );
            text = response?.content || '';
        } catch (error) {
            console.warn(`[${agent.name}] Goal evaluation failed: ${error.message}`);
            break;
        }
        parsed = parseGoalDecision(text);
        if (!parsed) console.warn(`[${agent.name}] Goal evaluation was not usable JSON.`);
    }
    const stamp = () => {
        plan.updatedAt = new Date().toISOString();
        manager.save?.();
    };
    if (!parsed) {
        plan.goalDecision = 'unresolved';
        stamp();
        console.warn(`[${agent.name}] Finished plan left the goal unchanged because the evaluation was not usable.`);
        return true;
    }
    if (parsed.decision === 'achieved' && observationPlanCannotFinish(plan)) {
        console.log(`[${agent.name}] Travel and observation did not finish the goal. The same goal continues.`);
        parsed = { ...parsed, decision: 'follow_up', goal: null };
    }
    const applied = applyGoalDecision(dataRoot, parsed.decision, { goal: parsed.goal, note: parsed.note });
    if (!applied.applied) {
        plan.goalDecision = 'unresolved';
        stamp();
        console.warn(`[${agent.name}] Goal evaluation was not applied: ${applied.reason}`);
        return true;
    }
    plan.goalDecision = parsed.decision;
    stamp();
    const next = applied.goal ? ` Next goal: ${applied.goal}` : '';
    console.log(`[${agent.name}] Goal evaluation: ${parsed.decision}.${parsed.note ? ` ${parsed.note}` : ''}${next}`);
    return true;
}

function handsFromBot(bot) {
    if (typeof bot?.inventory?.items !== 'function') return undefined;
    const counts = {};
    try {
        for (const item of bot.inventory.items()) {
            if (!item?.name) continue;
            counts[item.name] = (counts[item.name] || 0) + (item.count || 0);
        }
    } catch {
        return undefined;
    }
    return counts;
}

function modelComplete(agent) {
    if (!agent?.prompter?.chat_model?.complete) return null;
    return (prompt) => agent.prompter.chat_model.complete(prompt, GOAL_SYSTEM, GOAL_MODEL_PARAMS);
}

/**
 * Daytime direction for one decision. Night returns paused so the sleep
 * mode, not another model call, owns the body.
 */
export async function prepareVillageTurn(agent) {
    const phase = nightPhase(agent?.bot?.time?.timeOfDay);
    if (autonomyPausedForNight(phase)) return { paused: true, phase };
    const root = settings.agent_data_root;
    if (!root) return { paused: false, ambition: '', goal: '', step: '' };
    ensureSeededAmbition(root, settings.profile?.ambition_seed);
    const complete = modelComplete(agent);
    const inventory = handsFromBot(agent?.bot);
    const wait = agent._goalNextAt || 0;
    const ready = Date.now() >= wait && complete;
    if (ready && activeIntentionText(readIntentions(root)) && !readIntentions(root).milestone_review) {
        const review = await reconsiderCurrentGoal(root, { complete, inventory });
        if (!review.reviewed) {
            if (review.reason === 'generation_failed') {
                agent._goalNextAt = Date.now() + 60000;
                console.warn(`[${agent.name}] Goal review did not return a decision. The current goal stays. This was not a choice to keep or drop it.`);
            }
        } else if (review.decision === 'retain') {
            console.log(`[${agent.name}] Kept the current goal: ${review.goal}`);
        } else if (review.decision === 'revise') {
            console.log(`[${agent.name}] Revised the current goal: ${review.goal}`);
        } else if (review.decision === 'abandon') {
            console.log(`[${agent.name}] Closed the current goal.${review.goal ? ` Next goal: ${review.goal}` : ''}`);
        }
    }
    if (ready && !activeIntentionText(readIntentions(root))) {
        const result = await chooseCurrentGoal(root, { complete, inventory });
        if (!result.chosen) {
            agent._goalNextAt = Date.now() + 60000;
            if (result.reason === 'generation_failed') {
                console.warn(`[${agent.name}] Goal selection did not return a usable goal. This was not a decline.`);
            } else if (result.reason === 'declined') {
                console.log(`[${agent.name}] Declined a current goal.`);
            }
        } else {
            console.log(`[${agent.name}] Chose a current goal: ${result.goal}`);
        }
    }
    await evaluateFinishedPlan(agent, root, activeIntentionText(readIntentions(root)));
    const ambition = activeAmbitionText(readAmbitions(root));
    const goal = activeIntentionText(readIntentions(root));
    const plan = agent.plan_manager?.getCurrentPlan?.();
    if (goal && agent.plan_manager?.enabled && finishedPlanNeedsReplan(plan, goal)) {
        syncPlanToGoal(agent.plan_manager, goal);
        try {
            await agent.plan_manager.ensurePlan();
        } catch (error) {
            console.warn(`[${agent.name}] Could not prepare a plan: ${error.message}`);
        }
    }
    const step = agent.plan_manager?.getCurrentStep?.();
    const current = agent.plan_manager?.getCurrentPlan?.();
    const planHold = Boolean(
        goal &&
        !step &&
        agent.plan_manager?.enabled &&
        Date.now() < (agent.plan_manager.nextPlanningAllowedAt || 0)
    );
    return {
        paused: false,
        phase,
        ambition,
        goal,
        step: step?.description || '',
        planFinished: current?.status === 'completed' && !step,
        planHold,
    };
}
