import minecraftData from 'minecraft-data';
import settings from './settings.js';
import { getCommand, isAction } from './commands/index.js';
import { actionsList } from './commands/actions.js';
import { CONSTRUCTION_LIMITS, expandBuildRequest } from './library/construction.js';
import { analyzeConstruction } from './plan_geometry.js';

/**
 * Executability checks for proposed plans. A plan may only name commands the
 * agent can actually run, with parameters those commands accept, and may not
 * claim to construct structures when no available command can do so.
 *
 * Nothing here enables or runs generated code; !newAction is rejected unless
 * the operator has explicitly enabled allow_insecure_coding.
 */

// Commands that are conversation/meta controls, not plan actions.
const META_COMMANDS = new Set([
    'think', 'reconsiderPlan', 'endGoal', 'goal', 'startConversation', 'endConversation',
    'stop', 'restart', 'clearChat', 'stfu',
]);

/**
 * What each construction-capable command can really do. Capabilities are only
 * advertised when the command is registered and not blocked.
 *   single_block_here  - one block at the agent's own feet
 *   exact_block        - one block at explicit coordinates
 *   line               - an axis-aligned line
 *   fill_region        - axis-aligned walls, floors and roofs
 */
const CONSTRUCTION_COMMANDS = [
    { name: 'placeHere', abilities: ['single_block_here'], summary: 'places ONE block at your current position only (no coordinates, cannot make walls, floors or roofs). A flower or sapling goes on nearby empty ground and does not replace a path, flower, or other block' },
    { name: 'placeBlockAt', abilities: ['exact_block'], summary: 'places one full solid block (or a door) at exact coordinates; the spot must be empty and touch a solid block' },
    { name: 'buildLine', abilities: ['line'], summary: `builds an axis-aligned line of one block type between two coordinates (at most ${CONSTRUCTION_LIMITS.maxLineLength} blocks)` },
    { name: 'buildPlane', abilities: ['fill_region'], summary: `builds an axis-aligned wall, floor or roof of one block type between two corners (at most ${CONSTRUCTION_LIMITS.maxPlaneBlocks} blocks, ${CONSTRUCTION_LIMITS.maxPlaneSide} per side)` },
];

// Build commands and the coordinate parameters that define their region.
const BUILD_COMMANDS = {
    placeBlockAt: { kind: 'block', coords: ['x', 'y', 'z'] },
    buildLine: { kind: 'line', coords: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'] },
    buildPlane: { kind: 'plane', coords: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'] },
};

const STRUCTURE_NOUNS = '(?:shelters?|houses?|huts?|cabins?|homes?|walls?|roofs?|floors?|enclosures?|fort(?:ress)?|towers?|buildings?|structures?|foundations?|barns?|bunkers?)';
const BUILD_CLAIM = new RegExp(`\\b(?:build|builds|building|construct|constructing|erect|raise|enclose|wall\\s+in|set\\s*up|finish|complete)\\b[^.;]{0,50}\\b${STRUCTURE_NOUNS}\\b`, 'i');
const STRUCTURE_WORD = new RegExp(`\\b${STRUCTURE_NOUNS}\\b`, 'i');
const HOUSE_LANDMARK = /\b(?:beside|near|next to|by|outside|in front of|behind|at)\s+(?:my\s+|the\s+)?(?:house|home)\b/i;
const NON_HOUSE_STRUCTURE = /\b(?:shelters?|huts?|cabins?|walls?|roofs?|floors?|enclosures?|fort(?:ress)?|towers?|buildings?|structures?|foundations?|barns?|bunkers?)\b/i;

/** placeHere may name an existing house as a location. That is not a request to build the house. */
function placeHereBuildsStructure(description) {
    const text = String(description || '');
    if (BUILD_CLAIM.test(text)) return true;
    if (!STRUCTURE_WORD.test(text)) return false;
    if (HOUSE_LANDMARK.test(text) && !NON_HOUSE_STRUCTURE.test(text)) return false;
    return true;
}

function isBlocked(agent, name) {
    return Array.isArray(agent?.blocked_actions) && agent.blocked_actions.includes(`!${name}`);
}

function commandUsable(agent, name) {
    if (!getCommand(`!${name}`) || isBlocked(agent, name)) return false;
    if (name === 'newAction' && !settings.allow_insecure_coding) return false;
    return true;
}

export function constructionCapabilities(agent) {
    const available = CONSTRUCTION_COMMANDS.filter(entry => commandUsable(agent, entry.name));
    const abilities = new Set(available.flatMap(entry => entry.abilities));
    return {
        available,
        abilities,
        canBuildStructures: abilities.has('fill_region'),
    };
}

/** Compact, honest text for the planner prompt. */
export function describeConstruction(agent) {
    const capabilities = constructionCapabilities(agent);
    const lines = ['CONSTRUCTION CAPABILITIES (exact; plan only within these):'];
    for (const entry of capabilities.available) lines.push(`- !${entry.name}: ${entry.summary}`);
    if (!capabilities.available.length) lines.push('- none');
    if (!capabilities.canBuildStructures) {
        lines.push('You CANNOT currently construct walls, floors, roofs, shelters or houses. Do not choose an objective or step that requires building a structure. Single placeable items (crafting table, furnace, chest, torch, bed) are fine.');
    } else {
        lines.push(
            'You choose what to build, its dimensions, materials and location. Every build step needs exact integer world coordinates and its block type; ' +
            'construction material totals are derived from unique requested coordinates and actual blocks already present, not from your estimate; add a step only for a real shortfall. ' +
            'Build commands use only blocks you hold, reuse blocks already in place, never break or replace existing blocks, and refuse a placement that would seal you inside, so leave a doorway (or place a door with !placeBlockAt). ' +
            'Build off solid ground or existing blocks. Floors and roofs must cover horizontal areas; walls must be vertical; structural components may share edges but cannot all reuse the same geometry. A shelter must contain enclosed standing space with overhead cover. A large structure takes several steps (for example one !buildPlane per wall). Completion is verified from the actual blocks placed.'
        );
    }
    return lines.join('\n');
}

const TYPE_LABEL = {
    int: 'number', float: 'number', boolean: 'bool',
    BlockName: 'string', ItemName: 'string', BlockOrItemName: 'string',
};

/** One-line signatures of the commands usable as plan actions. */
export function describeAvailableActions(agent) {
    const lines = [];
    for (const name of actionsList.map(action => action.name.replace(/^!/, ''))) {
        if (META_COMMANDS.has(name) || !commandUsable(agent, name) || !isAction(`!${name}`)) continue;
        const command = getCommand(`!${name}`);
        if (command.operatorOnly || command.requiresPersistentPlanning) continue;
        const params = Object.entries(command.params || {})
            .map(([key, spec]) => `${key}:${TYPE_LABEL[spec.type] || spec.type}`)
            .join(', ');
        lines.push(`!${name}(${params})`);
    }
    return lines;
}

let registryCache = null;
function registry() {
    if (!registryCache) {
        const version = settings.minecraft_version && settings.minecraft_version !== 'auto'
            ? settings.minecraft_version
            : '1.21.6';
        registryCache = minecraftData(version);
    }
    return registryCache;
}

function paramProblems(commandName, command, params) {
    const problems = [];
    const spec = command.params || {};
    const mc = registry();
    for (const key of Object.keys(params)) {
        if (!(key in spec)) {
            problems.push(`!${commandName} has no parameter "${key}" (valid: ${Object.keys(spec).join(', ') || 'none'}).`);
        }
    }
    for (const [key, definition] of Object.entries(spec)) {
        if (!(key in params)) {
            problems.push(`!${commandName} requires parameter "${key}".`);
            continue;
        }
        const value = params[key];
        if (definition.type === 'int' || definition.type === 'float') {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                problems.push(`!${commandName} parameter "${key}" must be a number.`);
            }
        } else if (definition.type === 'boolean') {
            if (typeof value !== 'boolean') problems.push(`!${commandName} parameter "${key}" must be true or false.`);
        } else if (['BlockName', 'ItemName', 'BlockOrItemName'].includes(definition.type)) {
            const name = typeof value === 'string' ? value : '';
            const valid = definition.type === 'BlockName' ? mc.blocksByName[name]
                : definition.type === 'ItemName' ? mc.itemsByName[name]
                    : (mc.itemsByName[name] || mc.blocksByName[name]);
            if (!valid) problems.push(`!${commandName} parameter "${key}" ("${name}") is not a valid ${definition.type === 'BlockName' ? 'block' : definition.type === 'ItemName' ? 'item' : 'block or item'} name.`);
        } else if (typeof value !== 'string') {
            problems.push(`!${commandName} parameter "${key}" must be a string.`);
        }
    }
    return problems;
}

/**
 * @param {object} proposal planner output (objective, steps[{description, action}])
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkProposalFeasibility(agent, proposal) {
    const problems = [];
    const capabilities = constructionCapabilities(agent);
    const steps = Array.isArray(proposal?.steps) ? proposal.steps : [];
    const objective = String(proposal?.objective || '');

    const stepName = step => String(step?.action?.name || '').replace(/^!/, '');
    const buildSteps = steps.filter(step => BUILD_COMMANDS[stepName(step)]);
    const describesStructure = step => BUILD_CLAIM.test(String(step?.description || ''));

    if (!capabilities.canBuildStructures) {
        const reasons = [];
        if (BUILD_CLAIM.test(objective)) reasons.push(`the objective "${objective.slice(0, 120)}"`);
        steps.forEach((step, index) => {
            const description = String(step?.description || '');
            const name = stepName(step);
            const placing = ['placeHere', 'placeBlockAt', 'useOn'].includes(name) || /\b(place|put|lay|stack|set)\b/i.test(description);
            if (BUILD_CLAIM.test(description) || (placing && STRUCTURE_WORD.test(description))) {
                reasons.push(`step ${step?.id || index + 1} ("${description.slice(0, 100)}")`);
            }
        });
        if (reasons.length) {
            problems.push(
                `${reasons.slice(0, 3).join('; ')} requires constructing a structure, but no available command can build walls, floors, roofs or shelters. ` +
                `${describeConstruction(agent).split('\n').slice(1, -1).join(' ')} ` +
                'Choose an objective that the listed commands can complete, or limit it to gathering/crafting/placing single items.'
            );
        }
    } else {
        // Building is possible, so a structure objective must actually contain
        // concrete build steps; claiming to build is not a plan.
        const claims = BUILD_CLAIM.test(objective) || steps.some(step => describesStructure(step) && !BUILD_COMMANDS[stepName(step)]);
        if (claims && buildSteps.length === 0) {
            problems.push(
                `The plan claims to build a structure ("${objective.slice(0, 100)}") but no step uses a construction command. ` +
                'Specify the structure as concrete steps with !buildPlane, !buildLine or !placeBlockAt, giving exact coordinates and block types.'
            );
        }
        steps.forEach((step, index) => {
            if (stepName(step) === 'placeHere' && placeHereBuildsStructure(step?.description)) {
                problems.push(`step ${step?.id || index + 1} uses !placeHere for part of a structure; !placeHere places a single block at your feet. Use !buildPlane, !buildLine or !placeBlockAt.`);
            }
        });

        buildSteps.forEach((step, index) => {
            const name = stepName(step);
            const spec = BUILD_COMMANDS[name];
            const params = step.action?.params || {};
            const coords = spec.coords.map(coordinate => params[coordinate]);
            if (typeof params.type !== 'string' || coords.some(value => typeof value !== 'number' || !Number.isFinite(value))) return; // reported by parameter checks
            const expanded = expandBuildRequest(spec.kind, params.type, coords);
            if (!expanded.ok) {
                problems.push(`step ${step?.id || index + 1}: ${expanded.problems.join(' ')}`);
            }
        });
        problems.push(...analyzeConstruction(agent, proposal).problems);
    }

    steps.forEach((step, index) => {
        const label = `step ${step?.id || index + 1}`;
        const name = String(step?.action?.name || '').replace(/^!/, '');
        if (!name) {
            problems.push(`${label} names no command; every step needs an executable action command.`);
            return;
        }
        const command = getCommand(`!${name}`);
        if (!command) {
            problems.push(`${label} uses unknown command !${name}.`);
            return;
        }
        if (name === 'newAction' && !settings.allow_insecure_coding) {
            problems.push(`${label} uses !newAction, which is disabled.`);
            return;
        }
        if (isBlocked(agent, name) || command.operatorOnly) {
            problems.push(`${label} uses !${name}, which is not available to you.`);
            return;
        }
        if (META_COMMANDS.has(name) || !isAction(`!${name}`)) {
            problems.push(`${label} uses !${name}, which is not a world-changing action usable as a plan step.`);
            return;
        }
        for (const problem of paramProblems(name, command, step.action?.params || {})) {
            problems.push(`${label}: ${problem}`);
        }
    });

    return { ok: problems.length === 0, problems };
}
