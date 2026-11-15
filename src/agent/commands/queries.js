import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { searchMinecraftWiki } from './wiki_search.js';
import { reflect } from '../reasoning.js';
import { inventoryCapabilities } from '../mechanics.js';

const pad = (str) => {
    return '\n' + str + '\n';
}

const NORMAL_STORAGE_SLOTS = 36;

function equipmentSlot(bot, destination, fallback) {
    try {
        return bot.getEquipmentDestSlot?.(destination) ?? fallback;
    } catch {
        return fallback;
    }
}

function durability(item) {
    const maximum = Number(item?.maxDurability);
    const used = Number(item?.durabilityUsed);
    if (!Number.isFinite(maximum) || maximum <= 0 || !Number.isFinite(used)) return '';
    const remaining = Math.max(0, maximum - used);
    return ` (${remaining}/${maximum} durability remaining)`;
}

function normalStorage(bot) {
    const slots = bot?.inventory?.slots || [];
    const configuredStart = Number(bot?.inventory?.inventoryStart);
    const start = Number.isInteger(configuredStart) ? configuredStart : 9;
    const end = Math.min(start + NORMAL_STORAGE_SLOTS, slots.length);
    let occupied = 0;
    for (let index = start; index < end; index++) {
        if (slots[index]) occupied++;
    }
    return {
        occupied,
        free: Math.max(0, NORMAL_STORAGE_SLOTS - occupied),
        start,
        end,
    };
}

function formatInventory(agent) {
    const bot = agent.bot;
    const inventory = world.getInventoryCounts(bot);
    let res = 'CURRENT INVENTORY (live)';
    const entries = Object.entries(inventory).filter(([, count]) => count > 0);
    if (entries.length === 0) {
        res += '\n- Item totals: Nothing';
    } else {
        res += '\nITEM TOTALS';
        for (const [item, count] of entries) res += `\n- ${item}: ${count}`;
    }
    if (entries.length > 0 && bot.game?.gameMode === 'creative') {
        res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
    }

    const storage = normalStorage(bot);
    const status = storage.free === 0 ? 'FULL' : storage.free <= 2 ? 'NEARLY FULL' : 'AVAILABLE';
    res += `\nSTORAGE: ${storage.occupied}/${NORMAL_STORAGE_SLOTS} normal slots occupied; ${storage.free} free (${status}).`;

    const slots = bot.inventory.slots || [];
    const equipment = {
        Held: bot.heldItem || null,
        Offhand: slots[equipmentSlot(bot, 'off-hand', 45)] || null,
        Head: slots[equipmentSlot(bot, 'head', 5)] || null,
        Torso: slots[equipmentSlot(bot, 'torso', 6)] || null,
        Legs: slots[equipmentSlot(bot, 'legs', 7)] || null,
        Feet: slots[equipmentSlot(bot, 'feet', 8)] || null,
    };
    res += '\nEQUIPMENT';
    for (const [label, item] of Object.entries(equipment)) {
        res += `\n- ${label}: ${item ? item.name + durability(item) : 'Nothing'}`;
    }

    const equippedSlots = new Set([
        bot.heldItem?.slot,
        equipmentSlot(bot, 'off-hand', 45),
        equipmentSlot(bot, 'head', 5),
        equipmentSlot(bot, 'torso', 6),
        equipmentSlot(bot, 'legs', 7),
        equipmentSlot(bot, 'feet', 8),
    ].filter(Number.isInteger));
    const durableItems = [];
    for (let index = storage.start; index < storage.end; index++) {
        const item = slots[index];
        if (!item || equippedSlots.has(index) || !durability(item)) continue;
        durableItems.push(`${item.name}${durability(item)}`);
    }
    if (durableItems.length > 0) {
        res += '\nOTHER DURABLE TOOLS/EQUIPMENT';
        for (const item of durableItems.slice(0, 8)) res += `\n- ${item}`;
    }

    if (storage.free <= 2) {
        res += '\nInventory is nearly full; consider using or storing existing resources before acquiring more.';
    }

    const capabilities = inventoryCapabilities(bot, inventory, 4);
    if (capabilities.length > 0) {
        res += '\nVERIFIED CURRENT CAPABILITIES';
        for (const capability of capabilities) res += `\n- ${capability}`;
    }
    return pad(res);
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\n- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get live item totals, normal storage capacity, held/offhand equipment, armor, durability, and a short verified capability summary.",
        perform: function (agent) {
            return formatInventory(agent);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides an inventory-aware crafting plan for a specified item, including quantities, valid ingredient alternatives, missing ingredients, and required workstations.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Look up a short, specific Minecraft topic on the Minecraft Wiki. Names such as "oak planks", "wooden pickaxe", or "river" work best. Returns a brief summary of the closest articles, not a full page. Long questions and invented topics match poorly or not at all.',
        params: {
            'query': { type: 'string', description: 'A short Minecraft topic, item, or block name. Examples: oak_planks, wooden_pickaxe, river.' }
        },
        perform: async function (agent, query) {
            return searchMinecraftWiki(agent, query);
        }
    },
    {
        name: '!think',
        description: `Reflect on a problem using your reasoning abilities.
Use this when you are stuck, an action has failed,
you are unsure what to do next, or you need help
understanding Minecraft mechanics.

Provide your current problem as a question.
You will receive advice based on your current
situation, inventory, and recent experiences.

After receiving advice, take an appropriate action.
Do not repeatedly think about the same problem
without acting.

Examples: !think   or   !think("I cannot reach the acacia logs. What should I do?")
Both forms use parentheses when a question is included. Do not write !think "question".`,
        params: {
            'question': { type: 'string', description: 'Optional. The problem to investigate. Omit it to reflect on your current situation.', optional: true }
        },
        perform: async function (agent, question) {
            // The agent chose this command, with or without a question.
            return reflect(agent, question, { source: 'voluntary' });
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
