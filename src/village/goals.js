import { readFileSync, existsSync } from 'fs';
import path from 'path';
import settings from '../agent/settings.js';
import { activeAmbitionText, ensureSeededAmbition, readAmbitions } from './ambitions.js';
import { activeIntentionText, readIntentions, updateIntention } from './intentions.js';
import { readEpisodes } from './episodes.js';
import { readKnowledge } from './knowledge.js';
import { readRelationships } from './relationships.js';
import { autonomyPausedForNight, nightPhase } from './night.js';

function clip(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A private chance to choose today's goal. No command catalog.
 * The model may decline. The engine does not invent the goal.
 */
export function goalSelectionPrompt(dataRoot) {
    const identity = existsSync(path.join(dataRoot, 'identity.json'))
        ? JSON.parse(readFileSync(path.join(dataRoot, 'identity.json'), 'utf8'))
        : {};
    const ambition = activeAmbitionText(readAmbitions(dataRoot));
    const knowledge = readKnowledge(dataRoot);
    const episodes = (readEpisodes(dataRoot).episodes || []).slice(-4);
    const people = Object.keys(readRelationships(dataRoot).relationships || {}).slice(0, 6);
    const lines = [
        `You are ${identity.name || 'yourself'}. Choose one concrete goal for the current stretch of the day, or none.`,
        'The goal should follow your ambition and what you actually know. Do not invent a place, a material, a person, or an event that is not in these notes.',
        'A goal is one achievable aim, not a schedule and not a list of commands.',
    ];
    if (identity.temperament?.length) lines.push(`Temperament: ${clip(identity.temperament.join(' '), 240)}`);
    if (identity.interests?.length) lines.push(`Interests: ${clip(identity.interests.join(', '), 200)}`);
    if (ambition) lines.push(`Long-term ambition: ${clip(ambition, 240)}`);
    const places = [];
    if (knowledge?.home) places.push('home');
    for (const place of knowledge?.public_places || []) {
        if (place?.id) places.push(place.id);
    }
    if (places.length) lines.push(`Places you already know: ${places.join(', ')}.`);
    if (people.length) lines.push(`People in your own notes: ${people.join(', ')}.`);
    for (const episode of episodes) {
        if (episode?.text) lines.push(`Recent: ${clip(episode.text, 160)}`);
    }
    lines.push('Return only JSON: {"goal":null} or {"goal":"one sentence"}.');
    return lines.join('\n');
}

export async function chooseCurrentGoal(dataRoot, { complete, now = () => new Date().toISOString() } = {}) {
    if (!dataRoot || activeIntentionText(readIntentions(dataRoot))) return { chosen: false, reason: 'has goal' };
    if (typeof complete !== 'function') return { chosen: false, reason: 'no model' };
    let text = '';
    try {
        text = await complete(goalSelectionPrompt(dataRoot));
    } catch (error) {
        return { chosen: false, reason: error.message };
    }
    let goal = null;
    try {
        const start = String(text).indexOf('{');
        const end = String(text).lastIndexOf('}');
        const parsed = JSON.parse(String(text).slice(start, end + 1));
        goal = typeof parsed.goal === 'string' ? clip(parsed.goal, 180) : null;
    } catch {
        goal = null;
    }
    if (!goal) return { chosen: false, reason: 'declined', raw: text };
    const saved = updateIntention(dataRoot, { action: 'revise', text: goal, source: 'reflection', now });
    return saved.ok ? { chosen: true, goal, intentions: saved.intentions } : { chosen: false, reason: saved.reason };
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
    }
    return lines.join('\n');
}

export function goalEvaluationPrompt({ name = 'yourself', ambition = '', goal = '', plan = null } = {}) {
    return [
        `You are ${name}. A plan has finished. This is a private decision, not speech and not a command.`,
        'A finished plan does not by itself finish the current goal, and it does not finish the long-term ambition.',
        'Use only the verified outcomes below. Do not invent places, materials, people, or events.',
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
    if (!activeIntentionText(readIntentions(root))) {
        const wait = agent._goalNextAt || 0;
        if (Date.now() >= wait && agent.prompter?.chat_model?.complete) {
            const result = await chooseCurrentGoal(root, {
                complete: (prompt) => agent.prompter.chat_model.complete(
                    prompt,
                    'Choose a goal from the notes. Return only the JSON object. Do not invent events.',
                    { think: true, timeout_ms: 180000, max_predict: 1024, options: { num_predict: 1024 } }
                ).then(response => response?.content || ''),
            });
            if (!result.chosen) agent._goalNextAt = Date.now() + 60000;
            else console.log(`[${agent.name}] Chose a current goal: ${result.goal}`);
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
    return {
        paused: false,
        phase,
        ambition,
        goal,
        step: step?.description || '',
        planFinished: current?.status === 'completed' && !step,
    };
}
