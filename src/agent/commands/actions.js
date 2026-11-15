import * as skills from '../library/skills.js';
import * as construction from '../library/construction.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import {
    classifyFailure,
    constructionCellKey,
    createActionOutcome,
    digBehaviorKey,
    formatActionOutcome,
    collectionRelevantState,
    inventoryChanges,
    inventorySnapshot,
    positionAnchor,
    verifyCollection,
    verifySmeltingProduct,
} from '../action_outcome.js';
import { getSmeltingProduct } from '../../utils/mcdata.js';
import { resumePausedAutonomy } from '../system_events.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

function runAsStructuredAction(actionFn, outcomeBuilder, resume = false, timeout = -1) {
    let actionLabel = null;

    const wrappedAction = async function (agent, ...args) {
        if (!actionLabel) {
            const actionObj = actionsList.find(action => action.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1);
        }

        const before = inventorySnapshot(agent.bot);
        let actionValue;
        const actionFnWithAgent = async () => {
            actionValue = await actionFn(agent, ...args);
        };
        const execution = await agent.actions.runAction(
            `action:${actionLabel}`,
            actionFnWithAgent,
            { timeout, resume }
        );
        const after = inventorySnapshot(agent.bot);
        const outcome = outcomeBuilder({
            agent,
            action: actionLabel,
            args,
            before,
            after,
            actionValue,
            execution,
            feedback: execution.message || '',
        });
        agent.actions.recordOutcome(outcome);

        if (execution.interrupted && !execution.timedout && !outcome.relevantProgress)
            return;
        return [execution.message, formatActionOutcome(outcome)].filter(Boolean).join('\n');
    };

    return wrappedAction;
}

function failedOutcome(input, params, fallback='action_failed', { relevantState=null, refineReason=null }={}) {
    const reason = classifyFailure(input.feedback, fallback);
    if (refineReason && reason.code === fallback) Object.assign(reason, refineReason);
    if (input.execution.timedout) {
        reason.code = 'timeout';
        reason.message = 'The action exceeded its execution time limit.';
        reason.condition = 'state_changed';
    } else if (input.execution.interrupted) {
        reason.code = 'interrupted';
        reason.message = 'The action was interrupted before completion.';
        reason.condition = 'state_changed';
    }
    return createActionOutcome({
        action: input.action,
        params,
        status: 'failure',
        before: input.before,
        after: input.after,
        reason,
        retryableWithoutStateChange: false,
        relevantProgress: false,
        relevantState,
        bot: input.agent.bot,
    });
}

const CONSTRUCTION_REASONS = {
    missing_resource: report => ({
        code: 'missing_resource',
        message: `Not enough ${report.type}: ${report.required} needed to place, ${report.held} held at the start.`,
        prerequisites: [`Acquire more ${report.type}, then repeat the command to resume.`],
        condition: 'state_changed',
    }),
    would_trap: () => ({
        code: 'would_trap',
        message: 'The remaining placement would seal you into an enclosed space.',
        prerequisites: ['Leave an opening, or stand outside the structure to place it.'],
        condition: 'state_changed',
    }),
    unsupported: () => ({
        code: 'unsupported_target',
        message: 'The remaining blocks have no adjacent solid block to build off.',
        prerequisites: ['Start from the ground or an existing structure so each block touches something solid.'],
        condition: 'state_changed',
    }),
    unreachable: () => ({
        code: 'target_unavailable',
        message: 'No valid standing place was reachable without digging or scaffolding.',
        prerequisites: ['Move somewhere with access to the target, or clear the way yourself.'],
        condition: 'state_changed',
    }),
    occupied: () => ({
        code: 'occupied_target',
        message: 'The target position is occupied by a different block, which is never replaced.',
        prerequisites: ['Choose different coordinates, or deliberately clear the position first.'],
        condition: 'state_changed',
    }),
    hazard: () => ({ code: 'target_unavailable', message: 'Lava is at the target position.', prerequisites: ['Choose different coordinates.'], condition: 'state_changed' }),
    unloaded: () => ({ code: 'target_unavailable', message: 'The target area is not loaded.', prerequisites: ['Move closer to the target area.'], condition: 'state_changed' }),
    too_far: () => ({ code: 'target_unavailable', message: 'The target is too far from you.', prerequisites: ['Move closer first.'], condition: 'state_changed' }),
    placement_unverified: () => ({ code: 'placement_unverified', message: 'Placement was attempted but the block did not appear in the world.', prerequisites: [], condition: 'state_changed' }),
    interrupted: () => ({ code: 'interrupted', message: 'The build was interrupted; repeat the command to resume.', prerequisites: [], condition: 'state_changed' }),
    timeout: () => ({ code: 'timeout', message: 'The build ran out of time; repeat the command to resume.', prerequisites: [], condition: 'state_changed' }),
    invalid_request: report => ({ code: 'invalid_request', message: (report.problems || []).join(' ') || 'The construction request is invalid.', prerequisites: ['Fix the request and try again.'], condition: 'invalid_request' }),
};

/** Structured outcome for the construction commands, derived from the verified world report. */
function constructionOutcome(input, params) {
    const report = input.actionValue;
    if (!report) return failedOutcome(input, params, 'action_failed');
    const complete = report.complete;
    const placed = report.placed.length;
    const status = complete ? 'success' : placed > 0 ? 'partial' : 'failure';
    const reasonFactory = CONSTRUCTION_REASONS[report.dominantReason] || CONSTRUCTION_REASONS.placement_unverified;
    let reason = complete ? null : reasonFactory(report);
    const resumable = ['interrupted', 'timeout'].includes(report.dominantReason);
    const cells = constructionCellKey(input.action, params);
    const alreadySatisfied = complete && placed === 0 && report.satisfiedBefore.length > 0;
    // A few cells can land while the rest of the same shape is occupied.
    // Those placed blocks are real, but repeating the shape only puts back
    // whatever a later dig removes. The occupied cells are the blocker.
    const stuckOccupied = !complete && !resumable && reason?.code === 'occupied_target';
    let behaviorKey = null;
    let retryableWithoutStateChange = complete || resumable;
    if (alreadySatisfied && cells) {
        reason = {
            code: 'already_satisfied',
            message: 'Those blocks are already in place, so this build placed nothing new.',
            prerequisites: ['Choose a different location or a different part of the structure. Repeating this shape will not place more blocks.'],
            condition: 'unchanged_behavior',
        };
        retryableWithoutStateChange = false;
        behaviorKey = `construction:${cells}:already_satisfied`;
    } else if (!complete && cells && reason && !resumable && (placed === 0 || stuckOccupied)) {
        behaviorKey = `construction:${cells}:${reason.code}`;
        if (['occupied_target', 'target_unavailable', 'unsupported_target', 'would_trap'].includes(reason.code)) {
            reason = { ...reason, condition: 'unchanged_behavior' };
            retryableWithoutStateChange = false;
        }
        if (stuckOccupied && placed > 0) {
            reason = {
                ...reason,
                message: `Placed ${placed} block(s), then stopped because a target is occupied by a different block. Repeating this shape will not finish it.`,
                prerequisites: ['Leave the blocks you placed. Choose a different footprint for the next part. Do not dig these blocks up and place them again.'],
                condition: 'unchanged_behavior',
            };
        }
    }
    return createActionOutcome({
        action: input.action,
        params,
        status,
        before: input.before,
        after: input.after,
        worldChanges: report.placed.slice(0, 64).map(position => ({
            kind: 'block',
            position,
            before: report.beforeNames?.[`${position.x},${position.y},${position.z}`] ?? null,
            after: report.type,
        })),
        reason,
        retryableWithoutStateChange,
        relevantProgress: placed > 0 && !stuckOccupied,
        behaviorKey,
        details: {
            construction: {
                kind: report.kind,
                type: report.type,
                requestedBlocks: report.requestedBlocks,
                verifiedPlaced: placed,
                alreadySatisfied: report.satisfiedBefore.length,
                remaining: report.remaining.length,
                materialsRequired: report.required,
                materialsHeld: report.held,
                materialsConsumed: report.consumed,
                blockedCounts: report.blockedCounts,
                remainingBlocks: report.remaining.slice(0, 20),
                placedBlocks: report.placed.slice(0, 20),
                summary: report.summary,
            },
            cells,
            anchor: positionAnchor(input.agent.bot),
        },
        bot: input.agent.bot,
    });
}

function partialRetryIsReasonable(reason) {
    return ![
        'inventory_capacity',
        'missing_tool',
        'missing_workstation',
        'missing_fuel',
        'missing_resource',
        'target_unavailable',
        'timeout',
    ].includes(reason?.code);
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            resumePausedAutonomy(agent, 'a completed stop action', convoManager.inConversation());
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action. Human operator only.',
        operatorOnly: true,
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process. Human operator only.',
        operatorOnly: true,
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history. Human operator only.',
        operatorOnly: true,
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory. Reports whether an entire normal storage slot was actually freed; removing part of a stack does not resolve a full-inventory blockage.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsStructuredAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            const discarded = await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
            return discarded;
        }, input => {
            const [itemName, requested] = input.args;
            const params = { item_name: itemName, num: requested };
            const removed = Math.max(
                0,
                (input.before.counts[itemName] || 0) - (input.after.counts[itemName] || 0)
            );
            if (removed === 0) return failedOutcome(input, params, 'nothing_discarded');
            const available = input.before.counts[itemName] || 0;
            const intended = Math.min(requested, available);
            const status = input.execution.success && removed >= intended ? 'success' : 'partial';
            const reason = status === 'partial' ? classifyFailure(input.feedback, 'discard_incomplete') : null;
            return createActionOutcome({
                action: input.action,
                params,
                status,
                before: input.before,
                after: input.after,
                reason,
                retryableWithoutStateChange: true,
                relevantProgress: removed > 0,
                details: {
                    requested,
                    removed,
                    capacityFailureResolved: input.after.storage.free > input.before.storage.free,
                },
                bot: input.agent.bot,
            });
        })
    },
    {
        name: '!collectBlocks',
        description: 'Break and harvest the nearest blocks of a given type, then report confirmed before/after inventory changes. Use this command to gather resources such as logs; !useOn only right-clicks and does not mine blocks.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to break and collect into inventory.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsStructuredAction(async (agent, type, num) => {
            const observed = {};
            const success = await skills.collectBlock(agent.bot, type, num, null, observed);
            return { success, observed };
        }, input => {
            const [type, requested] = input.args;
            const params = { type, num: requested };
            const claimedSuccess = Boolean(input.actionValue?.success);
            // Only the requested block's expected drops can be collection
            // progress. Everything else (cobblestone dug on the way to ore,
            // a picked-up sapling) is incidental and kept for diagnostics.
            const verification = verifyCollection({
                requestedType: type,
                requested,
                changes: inventoryChanges(input.before.counts, input.after.counts),
                observed: input.actionValue?.observed,
            });
            const relevantState = collectionRelevantState(input.agent.bot, verification.expectedItems);
            if (verification.verdict === 'none') {
                const outcome = failedOutcome(input, params, 'collection_unverified', {
                    relevantState,
                    refineReason: {
                        code: 'expected_drops_missing',
                        message: verification.harvestedBlocks > 0
                            ? `${verification.harvestedBlocks} block(s) were broken but none of the expected drops (${verification.expectedItems.join(', ')}) were obtained.`
                            : `No ${type} was harvested and none of the expected drops (${verification.expectedItems.join(', ') || type}) were obtained.`,
                        prerequisites: ['Reach the target, use a suitable tool, or make inventory space; incidental items do not count as progress.'],
                    },
                });
                outcome.evidence.collection = verification;
                return outcome;
            }
            const status = input.execution.success && claimedSuccess && verification.verdict === 'complete'
                ? 'success'
                : 'partial';
            const reason = status === 'partial' ? classifyFailure(input.feedback, 'collection_incomplete') : null;
            return createActionOutcome({
                action: input.action,
                params,
                status,
                before: input.before,
                after: input.after,
                reason,
                retryableWithoutStateChange: partialRetryIsReasonable(reason),
                relevantProgress: true,
                relevantState,
                details: {
                    requested,
                    harvested: verification.harvestedBlocks,
                    collectedItemDeltas: Object.fromEntries(
                        Object.entries(verification.targetChanges).map(([name, change]) => [name, change.delta])
                    ),
                    collection: verification,
                },
                bot: input.agent.bot,
            });
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times. Reports valid ingredient variants and workstation requirements. Uses a nearby crafting table or places one from inventory when needed.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsStructuredAction(async (agent, recipe_name, num) => {
            return await skills.craftRecipe(agent.bot, recipe_name, num);
        }, input => {
            const [recipeName, requested] = input.args;
            const params = { recipe_name: recipeName, num: requested };
            const produced = Math.max(
                0,
                (input.after.counts[recipeName] || 0) - (input.before.counts[recipeName] || 0)
            );
            if (produced === 0) return failedOutcome(input, params, 'crafting_unverified');
            const limited = /resources allowed \d+/i.test(input.feedback);
            const status = input.execution.success && !limited ? 'success' : 'partial';
            return createActionOutcome({
                action: input.action,
                params,
                status,
                before: input.before,
                after: input.after,
                reason: status === 'partial' ? classifyFailure(input.feedback, 'crafting_incomplete') : null,
                retryableWithoutStateChange: partialRetryIsReasonable(
                    status === 'partial' ? classifyFailure(input.feedback, 'crafting_incomplete') : null
                ),
                relevantProgress: true,
                details: { requestedExecutions: requested, produced: { item: recipeName, count: produced } },
                bot: input.agent.bot,
            });
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsStructuredAction(async (agent, item_name, num) => {
            // skills.smeltItem waits for the client inventory to reflect the
            // taken output, and the outcome is judged on observed inventory
            // deltas, so no process restart is needed to refresh inventory.
            const observed = {};
            const success = await skills.smeltItem(agent.bot, item_name, num, observed);
            return { success, observed };
        }, input => {
            const [itemName, requested] = input.args;
            const params = { item_name: itemName, num: requested };
            const claimedSuccess = Boolean(input.actionValue?.success);
            const verification = verifySmeltingProduct({
                changes: inventoryChanges(input.before.counts, input.after.counts),
                expectedProduct: getSmeltingProduct(itemName),
                observed: input.actionValue?.observed,
            });
            // Success is judged on the expected furnace product that actually
            // reached inventory, not on the skill's return value alone.
            if (verification.verified === 0) {
                const outcome = failedOutcome(input, params, 'smelting_unverified');
                outcome.evidence.smelting = verification;
                return outcome;
            }
            const status = input.execution.success && claimedSuccess && verification.verified >= requested
                ? 'success'
                : 'partial';
            const reason = status === 'partial' ? classifyFailure(input.feedback, 'smelting_incomplete') : null;
            return createActionOutcome({
                action: input.action,
                params,
                status,
                before: input.before,
                after: input.after,
                reason,
                retryableWithoutStateChange: partialRetryIsReasonable(reason),
                relevantProgress: true,
                details: {
                    requested,
                    producedItems: verification.verified,
                    smeltedProducts: { [verification.product]: verification.verified },
                    smelting: verification,
                },
                bot: input.agent.bot,
            });
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures; use it for single items such as a crafting table, furnace, chest or torch. For structures use !placeBlockAt, !buildLine and !buildPlane.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsStructuredAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            const target = {
                x: Math.floor(pos.x),
                y: Math.floor(pos.y),
                z: Math.floor(pos.z),
            };
            const beforeBlock = agent.bot.blockAt(pos.floored())?.name || null;
            const placed = await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
            if (typeof agent.bot.waitForTicks === 'function') await agent.bot.waitForTicks(2);
            const afterBlock = agent.bot.blockAt(pos.floored())?.name || null;
            return { placed, target, beforeBlock, afterBlock };
        }, input => {
            const [type] = input.args;
            const params = { type };
            const observed = input.actionValue || {};
            const matches = observed.afterBlock === type ||
                (type === 'dirt' && observed.afterBlock === 'grass_block') ||
                (type === 'redstone' && observed.afterBlock === 'redstone_wire') ||
                (type.includes('torch') && observed.afterBlock?.includes('torch'));
            if (!matches) return failedOutcome(input, params, 'placement_unverified');
            return createActionOutcome({
                action: input.action,
                params,
                status: 'success',
                before: input.before,
                after: input.after,
                worldChanges: [{
                    kind: 'block',
                    position: observed.target,
                    before: observed.beforeBlock,
                    after: observed.afterBlock,
                }],
                retryableWithoutStateChange: true,
                relevantProgress: true,
                details: { placedBlock: { type: observed.afterBlock, position: observed.target } },
                bot: input.agent.bot,
            });
        })
    },
    {
        name: '!placeBlockAt',
        description: 'Place ONE block from your inventory at exact world coordinates, walking to a valid spot first. The target must be empty and touch an adjacent solid block to build against. Never breaks or replaces existing blocks. Success is verified in the world. Full solid blocks (planks, logs, stone, cobblestone, dirt, bricks, glass) and doors only.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to place; you must hold it.' },
            'x': { type: 'float', description: 'The x coordinate of the block to place.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'The y coordinate of the block to place.', domain: [-64, 320] },
            'z': { type: 'float', description: 'The z coordinate of the block to place.', domain: [-Infinity, Infinity] },
        },
        perform: runAsStructuredAction(async (agent, type, x, y, z) => {
            return await construction.placeBlockAt(agent.bot, type, x, y, z);
        }, input => {
            const [type, x, y, z] = input.args;
            return constructionOutcome(input, { type, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
        }, false, 2)
    },
    {
        name: '!buildLine',
        description: 'Build an axis-aligned line of one block type from (x1,y1,z1) to (x2,y2,z2); only one coordinate may differ, at most 32 blocks. Checks materials first, skips blocks already in place, builds off adjacent solid blocks, never breaks or replaces anything, and refuses a placement that would seal you in. Reports verified blocks placed, already in place, materials used and what remains. Repeat the same command to resume after a partial result.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to build with; you must hold enough.' },
            'x1': { type: 'float', description: 'x of the first end.', domain: [-Infinity, Infinity] },
            'y1': { type: 'float', description: 'y of the first end.', domain: [-64, 320] },
            'z1': { type: 'float', description: 'z of the first end.', domain: [-Infinity, Infinity] },
            'x2': { type: 'float', description: 'x of the second end.', domain: [-Infinity, Infinity] },
            'y2': { type: 'float', description: 'y of the second end.', domain: [-64, 320] },
            'z2': { type: 'float', description: 'z of the second end.', domain: [-Infinity, Infinity] },
        },
        perform: runAsStructuredAction(async (agent, type, x1, y1, z1, x2, y2, z2) => {
            return await construction.buildLine(agent.bot, type, x1, y1, z1, x2, y2, z2);
        }, input => {
            const [type, x1, y1, z1, x2, y2, z2] = input.args.map((value, index) => index === 0 ? value : Math.floor(value));
            return constructionOutcome(input, { type, x1, y1, z1, x2, y2, z2 });
        }, false, 6)
    },
    {
        name: '!buildPlane',
        description: 'Build an axis-aligned wall, floor or roof of one block type between opposite corners (x1,y1,z1) and (x2,y2,z2); at least one coordinate must be equal at both corners, at most 100 blocks and 32 per side. Same safety rules as !buildLine: verified per-block placement, existing blocks reused and never replaced, no digging or scaffolding, no sealing yourself in. Leave a doorway gap or place a door with !placeBlockAt. Repeat the same command to resume after a partial result.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to build with; you must hold enough.' },
            'x1': { type: 'float', description: 'x of the first corner.', domain: [-Infinity, Infinity] },
            'y1': { type: 'float', description: 'y of the first corner.', domain: [-64, 320] },
            'z1': { type: 'float', description: 'z of the first corner.', domain: [-Infinity, Infinity] },
            'x2': { type: 'float', description: 'x of the opposite corner.', domain: [-Infinity, Infinity] },
            'y2': { type: 'float', description: 'y of the opposite corner.', domain: [-64, 320] },
            'z2': { type: 'float', description: 'z of the opposite corner.', domain: [-Infinity, Infinity] },
        },
        perform: runAsStructuredAction(async (agent, type, x1, y1, z1, x2, y2, z2) => {
            return await construction.buildPlane(agent.bot, type, x1, y1, z1, x2, y2, z2);
        }, input => {
            const [type, x1, y1, z1, x2, y2, z2] = input.args.map((value, index) => index === 0 ? value : Math.floor(value));
            return constructionOutcome(input, { type, x1, y1, z1, x2, y2, z2 });
        }, false, 6)
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!reconsiderPlan',
        requiresPersistentPlanning: true,
        description: 'Deliberately abandon the current persistent plan when your objective no longer fits your interests or observations. Autonomous planning will select a new objective on the next routine cycle. Do not use merely because a step is slow.',
        params: {
            'reason': { type: 'string', description: 'A concise reason current observations or interests justify changing objectives.' },
        },
        perform: async function (agent, reason) {
            if (!agent.plan_manager?.enabled)
                return 'Persistent planning is disabled; there is no plan to reconsider.';
            const abandoned = agent.plan_manager?.abandon(reason);
            return abandoned
                ? `Current persistent plan abandoned: ${reason}. A new objective will be selected during the next autonomous cycle.`
                : 'There is no active persistent plan to abandon.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: `Digs down at most ${skills.MAX_DIG_DOWN} blocks (a short shaft; the world is much taller, so do not request a whole column). Stops at lava, water, an unsafe drop, or a block that cannot be broken. Digging 0 blocks is not progress. Increasing the distance does not get past a drop, hazard, or solid obstacle.`,
        params: {'distance': { type: 'int', description: `Blocks to dig down, from 1 to ${skills.MAX_DIG_DOWN}. Larger values are rejected and not dug.`, domain: [1, skills.MAX_DIG_DOWN, '[]'] }},
        perform: runAsStructuredAction(async (agent, distance) => {
            const observed = {};
            const ok = await skills.digDown(agent.bot, distance, observed);
            return { ok, ...observed };
        }, input => {
            const distance = input.args[0];
            const observed = input.actionValue || {};
            const excavated = Math.max(0, Number(observed.excavated) || 0);
            let stop = observed.stop || (input.execution?.interrupted ? 'interrupted' : 'no_progress');
            if (input.execution?.interrupted && excavated === 0) stop = 'interrupted';
            const params = { distance };
            const anchor = positionAnchor(input.agent.bot);
            const signature = `!digDown(distance:number)`;
            const dig = { requested: distance, excavated, stop, hazard: observed.hazard || null };
            if (stop === 'interrupted') {
                return createActionOutcome({
                    action: input.action,
                    params,
                    status: excavated > 0 ? 'partial' : 'failure',
                    before: input.before,
                    after: input.after,
                    reason: {
                        code: 'interrupted',
                        message: `The dig was interrupted after excavating ${excavated} block(s).`,
                        prerequisites: [],
                        condition: 'state_changed',
                    },
                    retryableWithoutStateChange: true,
                    relevantProgress: excavated > 0,
                    behaviorKey: null,
                    details: { dig, signature, anchor },
                    bot: input.agent.bot,
                });
            }
            if (excavated > 0) {
                const done = stop === 'completed' && excavated >= distance;
                return createActionOutcome({
                    action: input.action,
                    params,
                    status: done ? 'success' : 'partial',
                    before: input.before,
                    after: input.after,
                    reason: done ? null : {
                        code: stop,
                        message: `Excavated ${excavated} block(s), then stopped (${stop}).`,
                        prerequisites: stop === 'unsafe_drop'
                            ? ['The drop is still below. Move or bridge it before digging this column again.']
                            : [],
                        condition: 'state_changed',
                    },
                    retryableWithoutStateChange: true,
                    relevantProgress: true,
                    behaviorKey: null,
                    details: { dig, signature, anchor },
                    bot: input.agent.bot,
                });
            }
            const catalog = {
                unsafe_drop: {
                    code: 'unsafe_drop',
                    message: 'Dug down 0 blocks: an unsafe drop is below the next block. A larger distance will not pass it.',
                    prerequisites: ['Move to a different column or bridge the drop. Do not increase the distance.'],
                },
                hazard: {
                    code: 'hazard',
                    message: `Dug down 0 blocks: ${observed.hazard || 'lava or water'} blocks the shaft.`,
                    prerequisites: ['Choose a different column. Do not dig into the hazard.'],
                },
                obstacle: {
                    code: 'obstacle',
                    message: 'Dug down 0 blocks: the next block could not be broken.',
                    prerequisites: ['Use a suitable tool or choose a different column.'],
                },
                world_bottom: {
                    code: 'world_bottom',
                    message: 'Dug down 0 blocks: there is no further block below.',
                    prerequisites: ['This column cannot be dug further.'],
                },
                no_progress: {
                    code: 'no_progress',
                    message: 'Dug down 0 blocks.',
                    prerequisites: ['Move to a column that has solid blocks below, or choose another action.'],
                },
                invalid_request: {
                    code: 'invalid_arguments',
                    message: `digDown distance must be an integer from 1 to ${skills.MAX_DIG_DOWN}.`,
                    prerequisites: [`Use !digDown(distance) with distance from 1 to ${skills.MAX_DIG_DOWN}.`],
                },
            };
            const spec = catalog[stop] || catalog.no_progress;
            return createActionOutcome({
                action: input.action,
                params,
                status: 'failure',
                before: input.before,
                after: input.after,
                reason: { ...spec, condition: 'unchanged_behavior' },
                retryableWithoutStateChange: false,
                relevantProgress: false,
                behaviorKey: digBehaviorKey(stop, input.agent.bot),
                details: { dig, signature, anchor },
                bot: input.agent.bot,
            });
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Interact (right click) with the nearest target using an item or empty hand. This does not mine, break, or harvest blocks. To gather logs or other block resources, use !collectBlocks instead.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The interaction target as an entity type, block type, or "nothing" for no target. Block targets are right-clicked, not harvested.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
