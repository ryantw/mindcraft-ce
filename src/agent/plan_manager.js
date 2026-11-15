import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'fs';
import path from 'path';
import Vec3 from 'vec3';
import * as world from './library/world.js';
import settings from './settings.js';
import { checkProposalFeasibility, describeAvailableActions, describeConstruction } from './plan_feasibility.js';
import { analyzeConstruction, effectivePlanMaterials } from './plan_geometry.js';
import { describeLedger, materialLedger, normalizeMaterials, redundantStepReason, rightsizeResourceStep, stepProduces } from './plan_resources.js';

const PLAN_VERSION = 1;
const STEP_STATUSES = new Set(['pending', 'active', 'completed', 'blocked', 'failed', 'skipped']);
const DEFAULT_PLANNING_RETRY_MS = 5 * 60 * 1000;
const EVIDENCE_TYPES = new Set([
    'verified_action',
    'inventory_min',
    'inventory_delta',
    'block_at',
    'block_nearby',
    'position_near',
]);

function now() {
    return new Date().toISOString();
}

function cleanText(value, limit=500) {
    return String(value || '').trim().slice(0, limit);
}

function cleanParams(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (['string', 'number', 'boolean'].includes(typeof entry)) result[key] = entry;
    }
    return result;
}

function paramsMatch(expected={}, actual={}) {
    return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function inferredEvidence(action) {
    return {
        type: 'verified_action',
        action: action.name,
        params: action.params,
        description: 'The structured action outcome must verify success from observed game-state changes.',
    };
}

function normalizeEvidence(raw, action) {
    if (action?.name === 'goToCoordinates') {
        const params = action.params || {};
        if (['x', 'y', 'z'].every(key => Number.isFinite(Number(params[key])))) {
            return {
                type: 'position_near',
                position: {
                    x: Number(params.x),
                    y: Number(params.y),
                    z: Number(params.z),
                },
                radius: Math.max(0.5, Math.min(32, Number(params.closeness) || 1)),
                description: 'The agent position must be within the requested closeness of the destination.',
            };
        }
    }
    const evidence = raw && typeof raw === 'object' ? { ...raw } : {};
    if (!EVIDENCE_TYPES.has(evidence.type)) return inferredEvidence(action);
    if (evidence.type === 'inventory_min' || evidence.type === 'inventory_delta') {
        if (typeof evidence.item !== 'string' || !Number.isFinite(Number(evidence.count)))
            return inferredEvidence(action);
        return {
            type: evidence.type,
            item: evidence.item,
            count: Math.max(1, Math.floor(Number(evidence.count))),
            description: cleanText(evidence.description, 240),
        };
    }
    if (evidence.type === 'block_at') {
        const position = evidence.position;
        if (typeof evidence.block !== 'string' || !position ||
            !['x', 'y', 'z'].every(key => Number.isFinite(Number(position[key]))))
            return inferredEvidence(action);
        return {
            type: evidence.type,
            block: evidence.block,
            position: {
                x: Math.floor(Number(position.x)),
                y: Math.floor(Number(position.y)),
                z: Math.floor(Number(position.z)),
            },
            description: cleanText(evidence.description, 240),
        };
    }
    if (evidence.type === 'block_nearby') {
        if (typeof evidence.block !== 'string') return inferredEvidence(action);
        return {
            type: evidence.type,
            block: evidence.block,
            radius: Math.max(1, Math.min(32, Math.floor(Number(evidence.radius) || 8))),
            description: cleanText(evidence.description, 240),
        };
    }
    if (evidence.type === 'position_near') {
        const position = evidence.position;
        if (!position || !['x', 'y', 'z'].every(key => Number.isFinite(Number(position[key]))))
            return inferredEvidence(action);
        return {
            type: evidence.type,
            position: { x: Number(position.x), y: Number(position.y), z: Number(position.z) },
            radius: Math.max(0.5, Math.min(32, Number(evidence.radius) || 1)),
            description: cleanText(evidence.description, 240),
        };
    }
    return inferredEvidence({
        name: cleanText(evidence.action || action.name, 80),
        params: cleanParams(evidence.params || action.params),
    });
}

export class PlanManager {
    constructor(agent, baseDir='bots') {
        this.agent = agent;
        this.dir = path.join(baseDir, agent.name);
        this.file = path.join(this.dir, 'plan.json');
        this.state = { version: PLAN_VERSION, current: null, archive: [] };
        this.planningPromise = null;
        this.nextPlanningAllowedAt = 0;
        this.planningRejectionStreak = 0;
        this.lastPlanningProblems = [];
        this.loadedPlanNeedsValidation = false;
        // Persistent planning is opt-in. While disabled, no plan file is read
        // or written, no planning requests are made, and nothing is prompted.
        if (this.enabled) this.load();
    }

    /**
     * Planning is opt-in per agent. A boolean `persistent_planning` in the
     * agent's own profile wins (so one agent can plan while the others stay
     * autonomous); otherwise the global setting applies.
     */
    get enabled() {
        const override = this.agent?.prompter?.profile?.persistent_planning;
        if (typeof override === 'boolean') return override;
        return settings.persistent_planning === true;
    }

    _inventoryCounts() {
        try {
            return world.getInventoryCounts(this.agent.bot);
        } catch (_error) {
            return {};
        }
    }

    _ledger(materials) {
        return materialLedger(materials || [], this._inventoryCounts());
    }

    _planMaterials(plan) {
        return plan ? effectivePlanMaterials(this.agent, plan) : [];
    }

    /** Live have/need/missing view of the current plan's material needs. */
    materialStatus() {
        const plan = this.getCurrentPlan();
        return plan ? this._ledger(this._planMaterials(plan)) : [];
    }

    load() {
        if (!existsSync(this.file)) return null;
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            if (parsed?.version === PLAN_VERSION && Array.isArray(parsed.archive)) {
                this.state = parsed;
                this.loadedPlanNeedsValidation = Boolean(parsed.current);
                return this.state.current;
            }
        } catch (error) {
            console.warn(`[${this.agent.name}] Could not load persistent plan: ${error.message}`);
        }
        return null;
    }

    save() {
        mkdirSync(this.dir, { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(this.state, null, 2));
        renameSync(temporary, this.file);
    }

    getCurrentPlan() {
        if (!this.enabled) return null;
        return this.state.current;
    }

    getCurrentStep() {
        const plan = this.getCurrentPlan();
        if (!plan?.currentStepId) return null;
        return plan.steps.find(step => step.id === plan.currentStepId) || null;
    }

    planningReason() {
        const plan = this.getCurrentPlan();
        if (!plan) return 'no_active_plan';
        if (plan.status === 'completed') return 'objective_completed';
        if (plan.status === 'abandoned') return 'objective_changed';
        if (plan.status === 'invalidated') return 'objective_invalidated';
        const step = this.getCurrentStep();
        if (!step) return 'no_active_step';
        if (step.status === 'blocked' || step.status === 'failed') return `step_${step.status}`;
        return null;
    }

    async ensurePlan() {
        if (!this.enabled) return null;
        this._revalidateLoadedPlan();
        this.reconcileObservedEvidence();
        const reason = this.planningReason();
        if (!reason) return this.getCurrentPlan();
        if (this.planningPromise) return this.planningPromise;
        // After a failed or rejected planning attempt, wait before spending
        // more model calls; the agent keeps acting autonomously meanwhile.
        if (Date.now() < this.nextPlanningAllowedAt) return this.getCurrentPlan();
        this.planningPromise = this._requestPlan(reason).finally(() => {
            this.planningPromise = null;
        });
        return this.planningPromise;
    }

    /**
     * Fire-and-forget planning for moments when the self-prompt loop is not
     * running (for example during a long peer conversation). It never blocks
     * or throws into the caller, and shares ensurePlan's single in-flight
     * request and failure backoff, so it cannot create a replanning loop.
     * Returns the in-flight promise, or null when nothing was started.
     */
    ensurePlanInBackground() {
        if (!this.enabled || this.planningPromise) return null;
        if (!this.planningReason()) return null;
        if (Date.now() < this.nextPlanningAllowedAt) return null;
        const pending = this.ensurePlan();
        pending?.catch?.(error => {
            this._planningFailed(`Background planning failed: ${error?.message || error}`);
        });
        return pending;
    }

    _retryDelay() {
        const configured = Number(settings.planning_retry_ms);
        const base = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_PLANNING_RETRY_MS;
        if (base === 0) return 0;
        const streak = Math.max(1, this.planningRejectionStreak || 1);
        const cap = 30 * 60 * 1000;
        return Math.min(base * (2 ** (streak - 1)), Math.max(base, cap));
    }

    _planningFailed(message) {
        console.warn(`[${this.agent.name}] ${message}`);
        this.planningRejectionStreak = (this.planningRejectionStreak || 0) + 1;
        this.nextPlanningAllowedAt = Date.now() + this._retryDelay();
    }

    /** A blocked step keeps its completed work and does not replan immediately. */
    _deferReplanning() {
        const until = Date.now() + this._retryDelay();
        if (until > this.nextPlanningAllowedAt) this.nextPlanningAllowedAt = until;
    }

    /**
     * Problems that would make the proposal impossible or pointless to run:
     * unusable commands/parameters, structure claims without a construction
     * command, or steps that only gather materials already held.
     */
    validateProposal(proposal) {
        const problems = [...checkProposalFeasibility(this.agent, proposal).problems];
        const analysis = analyzeConstruction(this.agent, proposal);
        const ledger = this._ledger(effectivePlanMaterials(this.agent, proposal, analysis));
        const steps = Array.isArray(proposal?.steps) ? proposal.steps : [];
        // A material the agent does not hold must be obtained by some step;
        // otherwise the steps that need it cannot succeed.
        const normalizedSteps = steps.map(step => ({
            action: { name: String(step?.action?.name || '').replace(/^!/, ''), params: cleanParams(step?.action?.params) },
        }));
        for (const entry of ledger) {
            if (entry.status === 'available') continue;
            if (!normalizedSteps.some(step => stepProduces(step, entry.item))) {
                problems.push(
                    `"materials" needs ${entry.need} ${entry.item} but you hold ${entry.have}${entry.status === 'craftable' ? ' (craftable from your inventory)' : ''} and no step obtains the ${entry.missing} you are short. ` +
                    `Add a step (collectBlocks, craftRecipe, smeltItem...) that produces ${entry.item}, or lower the requirement.`
                );
            }
        }
        const redundant = steps.filter(step => redundantStepReason({
            action: { name: String(step?.action?.name || '').replace(/^!/, ''), params: cleanParams(step?.action?.params) },
        }, ledger));
        if (steps.length && redundant.length === steps.length) {
            problems.push('Every step only gathers or crafts materials your inventory already satisfies, so none makes progress on the objective. Use the MATERIAL LEDGER: skip sufficient materials and plan steps that advance the objective itself.');
        }
        return problems;
    }

    async _requestPlan(reason) {
        const previous = this.getCurrentPlan();
        console.log(`[${this.agent.name}] Requesting persistent plan (${reason}).`);
        let feedback = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            let proposal;
            try {
                proposal = await this.agent.prompter.promptPlanning(reason, previous, feedback);
            } catch (error) {
                this._planningFailed(`Planning request failed: ${error.message}`);
                return previous;
            }
            if (!proposal) {
                this._planningFailed('Planning request returned no usable plan.');
                return previous;
            }
            const problems = this.validateProposal(proposal);
            if (problems.length === 0) {
                this.lastPlanningProblems = [];
                this.planningRejectionStreak = 0;
                this.nextPlanningAllowedAt = 0;
                try {
                    return this.applyProposal(proposal, reason);
                } catch (error) {
                    this._planningFailed(`Proposed plan could not be applied: ${error.message}`);
                    return previous;
                }
            }
            this.lastPlanningProblems = problems;
            console.warn(`[${this.agent.name}] Plan proposal rejected as not executable (attempt ${attempt + 1}): ${problems.join(' | ')}`);
            feedback = problems;
        }
        this._planningFailed('Plan proposal rejected twice as not executable; continuing autonomously.');
        return previous;
    }

    _positionLine() {
        const position = this.agent.bot?.entity?.position;
        if (!position) return '';
        return `YOUR POSITION: ${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)} (integer world block coordinates; coordinates in build steps are absolute world coordinates).`;
    }

    /**
     * Live context for the planner: available actions with exact signatures,
     * honest construction capabilities, and the inventory-vs-need ledger
     * guidance. Built in code so it always reflects the real command set.
     */
    planningContext(feedback=null) {
        const lines = [
            this._positionLine(),
            'AVAILABLE ACTION COMMANDS (plan steps may use only these; use these exact parameter names):',
            describeAvailableActions(this.agent).join('\n'),
            '',
            describeConstruction(this.agent),
            '',
            'RESOURCE SUFFICIENCY: construction requirements are calculated deterministically from the unique coordinates in build commands and blocks already present in the world; do not estimate or pad their totals. "materials" may list other objective resources. Materials you already hold (or can craft from what you hold) need NO gathering step. Add gathering/crafting only for the live shortfall. Navigation completion is verified from the agent position, never from a nearby block.',
        ];
        if (feedback?.length) {
            lines.push('', 'YOUR PREVIOUS PROPOSAL WAS REJECTED because it could not be executed:');
            for (const problem of feedback.slice(0, 6)) lines.push(`- ${problem}`);
            lines.push('Propose a different plan that fixes these problems.');
        }
        return lines.join('\n');
    }

    applyProposal(proposal, reason='agent_choice') {
        if (!this.enabled) throw new Error('Persistent planning is disabled.');
        if (!proposal || typeof proposal.objective !== 'string' || !Array.isArray(proposal.steps) || proposal.steps.length === 0)
            throw new Error('A plan requires an objective and at least one step.');
        const validationProblems = this.validateProposal(proposal);
        if (validationProblems.length)
            throw new Error(`Plan is not executable: ${validationProblems.join(' | ')}`);

        const previous = this.getCurrentPlan();
        if (previous) {
            this.state.archive.push({
                objective: previous.objective,
                status: previous.status,
                endedAt: now(),
                reason,
            });
            this.state.archive = this.state.archive.slice(-10);
        }

        const revision = (previous?.revision || 0) + 1;
        const analysis = analyzeConstruction(this.agent, proposal);
        const materials = effectivePlanMaterials(this.agent, proposal, analysis);
        const ledger = this._ledger(materials);
        const usedIds = new Set();
        const steps = proposal.steps.slice(0, 8).map((raw, index) => {
            const suggested = cleanText(raw?.id, 80);
            let id = /^[a-z0-9_-]+$/i.test(suggested) && !usedIds.has(suggested)
                ? suggested
                : `step_${revision}_${index + 1}`;
            usedIds.add(id);
            const action = {
                name: cleanText(raw?.action?.name, 80).replace(/^!/, ''),
                params: cleanParams(raw?.action?.params),
            };
            return {
                id,
                description: cleanText(raw?.description, 300) || `Advance ${cleanText(proposal.objective, 120)}`,
                status: 'pending',
                action,
                evidence: normalizeEvidence(raw?.evidence, action),
                requires: analysis.stepRequirements.has(index)
                    ? analysis.stepRequirements.get(index)
                    : normalizeMaterials(raw?.requires, 6),
                requiredResources: Array.isArray(raw?.requiredResources)
                    ? raw.requiredResources.map(value => cleanText(value, 120)).filter(Boolean).slice(0, 8)
                    : [],
                prerequisites: Array.isArray(raw?.prerequisites)
                    ? raw.prerequisites.map(value => cleanText(value, 160)).filter(Boolean).slice(0, 8)
                    : [],
                attempts: 0,
                baseline: null,
                lastOutcome: null,
            };
        });

        // Steps that only gather/craft what the ledger says is already on hand
        // are kept for transparency but skipped.
        for (const step of steps) {
            rightsizeResourceStep(step, ledger);
            const skipReason = redundantStepReason(step, ledger);
            if (skipReason) {
                step.status = 'skipped';
                step.skipReason = skipReason;
                console.log(`[${this.agent.name}] Plan step ${step.id} skipped: ${skipReason}.`);
            }
        }
        const first = steps.find(step => step.status === 'pending');
        if (!first) throw new Error('Every step in the plan is redundant with current resources.');
        first.status = 'active';

        const created = now();
        this.state.current = {
            id: `plan_${Date.now()}`,
            objective: cleanText(proposal.objective, 500),
            rationale: cleanText(proposal.rationale, 500),
            status: 'active',
            revision,
            createdAt: created,
            updatedAt: created,
            currentStepId: first.id,
            materials,
            steps,
        };
        this._captureBaseline(first);
        this.save();
        console.log(`[${this.agent.name}] Persistent plan selected: ${this.state.current.objective}`);
        return this.state.current;
    }

    _revalidateLoadedPlan() {
        if (!this.loadedPlanNeedsValidation) return;
        this.loadedPlanNeedsValidation = false;
        const plan = this.getCurrentPlan();
        if (!plan) return;
        const problems = this.validateProposal(plan);
        if (problems.length) {
            const reason = `Loaded plan failed current semantic validation: ${problems.slice(0, 3).join(' ')}`;
            if (plan.status === 'active') {
                this.abandon(reason);
            } else {
                // Preserve the plan and its outcomes, but do not retain a false
                // completion label under the stronger shared baseline.
                plan.status = 'invalidated';
                plan.updatedAt = now();
                plan.invalidationReason = cleanText(reason, 500);
                this.save();
            }
            return;
        }
        const analysis = analyzeConstruction(this.agent, plan);
        plan.materials = effectivePlanMaterials(this.agent, plan, analysis);
        plan.steps.forEach((step, index) => {
            step.evidence = normalizeEvidence(step.evidence, step.action);
            if (analysis.stepRequirements.has(index)) step.requires = analysis.stepRequirements.get(index);
        });
        plan.updatedAt = now();
        this.save();
    }

    _captureBaseline(step) {
        if (!step || step.evidence.type !== 'inventory_delta') return;
        const counts = world.getInventoryCounts(this.agent.bot);
        step.baseline = { inventory: { [step.evidence.item]: counts[step.evidence.item] || 0 } };
    }

    _evidenceSatisfied(step, outcome) {
        const evidence = step.evidence;
        const counts = world.getInventoryCounts(this.agent.bot);
        if (evidence.type === 'verified_action') {
            return outcome?.status === 'success' &&
                evidence.action === outcome.action &&
                paramsMatch(evidence.params, outcome.params);
        }
        if (evidence.type === 'inventory_min') {
            return (counts[evidence.item] || 0) >= evidence.count;
        }
        if (evidence.type === 'inventory_delta') {
            const baseline = step.baseline?.inventory?.[evidence.item] || 0;
            return (counts[evidence.item] || 0) - baseline >= evidence.count;
        }
        if (evidence.type === 'block_at') {
            const block = this.agent.bot.blockAt(new Vec3(
                evidence.position.x,
                evidence.position.y,
                evidence.position.z
            ));
            return block?.name === evidence.block;
        }
        if (evidence.type === 'block_nearby') {
            return Boolean(world.getNearestBlock(this.agent.bot, evidence.block, evidence.radius));
        }
        if (evidence.type === 'position_near') {
            const position = this.agent.bot?.entity?.position;
            if (!position) return false;
            const dx = position.x - evidence.position.x;
            const dy = position.y - evidence.position.y;
            const dz = position.z - evidence.position.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) <= evidence.radius;
        }
        return false;
    }

    reconcileObservedEvidence() {
        if (!this.enabled) return false;
        const plan = this.getCurrentPlan();
        if (!plan || plan.status !== 'active') return false;
        let changed = false;
        const ledger = this._ledger(this._planMaterials(plan));
        while (true) {
            const step = this.getCurrentStep();
            if (!step) break;
            if (rightsizeResourceStep(step, ledger)) changed = true;
            const redundant = redundantStepReason(step, ledger);
            if (redundant) {
                step.status = 'skipped';
                step.skipReason = redundant;
            } else if (step.evidence.type !== 'verified_action' && this._evidenceSatisfied(step, null)) {
                step.status = 'completed';
            } else {
                break;
            }
            const next = plan.steps.find(candidate => candidate.status === 'pending');
            if (!next) {
                plan.status = 'completed';
                plan.currentStepId = null;
                changed = true;
                break;
            }
            next.status = 'active';
            plan.currentStepId = next.id;
            this._captureBaseline(next);
            changed = true;
        }
        if (changed) {
            plan.updatedAt = now();
            this.save();
            console.log(`[${this.agent.name}] Persistent plan reconciled with authoritative current observations.`);
        }
        return changed;
    }

    abandon(reason='agent deliberately chose a different objective') {
        if (!this.enabled) return false;
        const plan = this.getCurrentPlan();
        if (!plan || plan.status !== 'active') return false;
        plan.status = 'abandoned';
        plan.updatedAt = now();
        plan.abandonReason = cleanText(reason, 300);
        this.save();
        console.log(`[${this.agent.name}] Persistent plan abandoned by agent choice: ${plan.abandonReason}`);
        return true;
    }

    observeOutcome(outcome) {
        if (!this.enabled) return { advanced: false };
        const plan = this.getCurrentPlan();
        const step = this.getCurrentStep();
        if (!plan || plan.status !== 'active' || !step || !outcome) return { advanced: false };
        if (step.action.name && step.action.name !== outcome.action) return { advanced: false };
        if (!paramsMatch(step.action.params, outcome.params)) return { advanced: false };

        step.attempts++;
        step.lastOutcome = {
            status: outcome.status,
            reason: outcome.reason,
            relevantProgress: outcome.relevantProgress,
            observedAt: outcome.observedAt,
        };
        plan.updatedAt = now();

        if (this._evidenceSatisfied(step, outcome)) {
            step.status = 'completed';
            const next = plan.steps.find(candidate => candidate.status === 'pending');
            if (next) {
                next.status = 'active';
                plan.currentStepId = next.id;
                this._captureBaseline(next);
                this.save();
                console.log(`[${this.agent.name}] Plan step ${step.id} completed from verified evidence; advancing to ${next.id}.`);
                return { advanced: true, completed: false, next };
            }
            plan.status = 'completed';
            plan.currentStepId = null;
            this.save();
            console.log(`[${this.agent.name}] Plan objective completed from verified evidence: ${plan.objective}`);
            return { advanced: true, completed: true, next: null };
        }

        if (outcome.status === 'failure' && outcome.retry?.reasonableWithoutStateChange === false) {
            step.status = 'blocked';
        } else if (outcome.status === 'failure' && step.attempts >= 3) {
            step.status = 'blocked';
        } else if (!STEP_STATUSES.has(step.status)) {
            step.status = 'active';
        }
        if (step.status === 'blocked') this._deferReplanning();
        this.save();
        return { advanced: false, blocked: step.status === 'blocked' };
    }

    formatForPrompt() {
        if (!this.enabled) return '';
        const plan = this.getCurrentPlan();
        if (!plan) return 'PERSISTENT PLAN\nNo plan has been selected yet.';
        const lines = [
            'PERSISTENT PLAN',
            `Objective chosen by you: ${plan.objective}`,
            `Plan status: ${plan.status}`,
        ];
        if (plan.rationale) lines.push(`Why it interests you: ${plan.rationale}`);
        if (plan.materials?.length) {
            lines.push('MATERIAL LEDGER (live inventory vs. what the objective needs):');
            lines.push(...describeLedger(this._ledger(this._planMaterials(plan))));
        }
        for (const step of plan.steps) {
            const marker = step.status === 'completed' ? '[x]'
                : step.status === 'active' ? '>>>'
                    : step.status === 'blocked' ? '[blocked]'
                        : step.status === 'failed' ? '[failed]'
                            : step.status === 'skipped' ? '[skipped]'
                                : '[ ]';
            lines.push(`${marker} ${step.id}: ${step.description}${step.status === 'skipped' && step.skipReason ? ` (not needed: ${step.skipReason})` : ''}`);
            if (step.status === 'active') {
                if (step.action.name)
                    lines.push(`Suggested command: !${step.action.name}(${Object.values(step.action.params).map(value => typeof value === 'string' ? JSON.stringify(value) : value).join(', ')})`);
                lines.push(`Completion evidence: ${JSON.stringify(step.evidence)}`);
                if (step.requires?.length)
                    lines.push('Materials for this step:', ...describeLedger(this._ledger(step.requires)));
                if (step.requiredResources.length)
                    lines.push(`Required resources: ${step.requiredResources.join(', ')}`);
                if (step.prerequisites.length)
                    lines.push(`Prerequisites: ${step.prerequisites.join(', ')}`);
            }
            if (step.status === 'blocked' && step.lastOutcome?.reason)
                lines.push(`Blocked because: ${step.lastOutcome.reason.message}`);
        }
        lines.push('Follow the active step when practical. Current survival, safety, and social interaction may temporarily take priority. Never claim a step complete; advancement occurs only from observed evidence.');
        return lines.join('\n');
    }
}
