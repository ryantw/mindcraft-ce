import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import { villageCommands } from './village.js';
import { releaseWikiSearchBlock } from './wiki_search.js';
import { noteReflectionAction, reflectionStatus } from '../reasoning.js';
import { makeValidationOutcome, validationBehaviorKey } from '../action_outcome.js';
import settings from '../settings.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList, villageCommands);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

function quoteCommandArg(token) {
    if (/^-?\d+(?:\.\d+)?$/.test(token) || /^(?:true|false)$/i.test(token)) return token;
    if (/^"[^"]*"$/.test(token)) return token;
    if (/^[A-Za-z_][\w]*$/.test(token)) return `"${token}"`;
    return null;
}

function commandRequiresArguments(commandName) {
    const command = getCommand(commandName.startsWith('!') ? commandName : `!${commandName}`);
    if (!command?.params) return false;
    return Object.values(command.params).some(param => !param.optional);
}

/**
 * Models omit quotes and parentheses: !placeHere(cobblestone), !placeHere "cobblestone", !digDown 16.
 * Fold those into the parenthesized form before parsing. A bare !placeHere is left bare so it is rejected.
 */
export function normalizeCommandMessage(message) {
    if (typeof message !== 'string') return message;
    let text = message.replace(/!think\s+"([^"]*)"/g, '!think("$1")');
    text = text.replace(/!(\w+)\(([^)]*)\)/g, (match, name, body) => {
        if (!body.trim() || !getCommand(`!${name}`)?.params) return match;
        const quoted = body.split(',').map(part => quoteCommandArg(part.trim()));
        if (quoted.some(part => !part)) return match;
        return `!${name}(${quoted.join(', ')})`;
    });
    text = text.replace(/!([A-Za-z_]\w*)(?!\()((?:\s+(?:"[^"]*"|-?\d+(?:\.\d+)?|[A-Za-z_][\w]*))+)/g, (match, name, rest) => {
        const command = getCommand(`!${name}`);
        const specs = Object.values(command?.params || {});
        if (!commandRequiresArguments(`!${name}`)) return match;
        const available = rest.trim().split(/\s+/);
        const tokens = available.slice(0, specs.length);
        const quoted = tokens.map(quoteCommandArg);
        if (quoted.some(part => !part)) return match;
        const consumed = rest.match(new RegExp(`^(?:\\s+(?:"[^"]*"|-?\\d+(?:\\.\\d+)?|[A-Za-z_][\\w]*)){${tokens.length}}`));
        const leftover = consumed ? rest.slice(consumed[0].length) : '';
        return `!${name}(${quoted.join(', ')})${leftover}`;
    });
    return text;
}

export function containsCommand(message) {
    const commandMatch = normalizeCommandMessage(message).match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    message = normalizeCommandMessage(message);
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    const countError = argCountError(command, args.length);
    if (countError) return countError;

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    const lower = domain[2][0] === '['
                        ? `greater than or equal to ${domain[0]}`
                        : `greater than ${domain[0]}`;

                    const upper = domain[2][1] === ']'
                        ? `less than or equal to ${domain[1]}`
                        : `less than ${domain[1]}`;

                    return `Error: Invalid parameter '${paramNames[i]}'. Value must be ${lower} and ${upper}. Correct the parameter before retrying. Do not repeat the same invalid command.`;
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    message = normalizeCommandMessage(message);
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function argCountError(command, numArgs) {
    const params = commandParams(command);
    const maxArgs = params.length;
    const minArgs = params.filter(param => !param.optional).length;
    if (numArgs >= minArgs && numArgs <= maxArgs) return null;
    const expected = minArgs === maxArgs ? String(maxArgs) : `${minArgs} to ${maxArgs}`;
    const signature = formatCommandSignature(command.name);
    return `Command ${command.name} was given ${numArgs} args, but requires ${expected} args. Correct form: ${signature}.`;
}

const SIGNATURE_TYPES = {
    float: 'number',
    int: 'number',
    BlockName: 'string',
    ItemName: 'string',
    BlockOrItemName: 'string',
    boolean: 'bool',
};

/** Exact parameter list for a command, used when correcting a rejected call. */
export function formatCommandSignature(commandName) {
    const name = String(commandName || '');
    const command = getCommand(name.startsWith('!') ? name : `!${name}`);
    if (!command) return null;
    const params = Object.entries(command.params || {});
    if (params.length === 0) return `${command.name}()`;
    const body = params.map(([key, spec]) => `${key}:${SIGNATURE_TYPES[spec.type] || spec.type}`).join(', ');
    return `${command.name}(${body})`;
}

/**
 * Identity of one model command, including attempts that fail to parse.
 * `parsedOk` is false for missing arguments, bad types, and unknown commands.
 */
export function describeAttempt(message) {
    const commandName = containsCommand(message);
    const parsed = parseCommandMessage(message);
    if (typeof parsed === 'string') {
        return {
            commandName,
            parsedOk: false,
            error: parsed,
            action: commandName ? commandName.replace(/^!/, '') : 'command',
            params: {},
            behaviorHint: validationBehaviorKey(commandName || '!unknown'),
            missingArguments: /was given 0 args/.test(parsed) && commandRequiresArguments(commandName || ''),
        };
    }
    const command = getCommand(parsed.commandName);
    const names = commandParamNames(command);
    const params = Object.fromEntries(names.map((name, index) => [name, parsed.args[index]]));
    return {
        commandName: parsed.commandName,
        parsedOk: true,
        error: null,
        action: parsed.commandName.replace(/^!/, ''),
        params,
        behaviorHint: null,
        missingArguments: false,
    };
}

export function stripUnsharedCommands(message) {
    return String(message || '')
        .replace(/!think\s+"[^"]*"/g, '')
        .replace(/!think\s*\([^)]*\)/g, '')
        .replace(/!think\b/g, '')
        .replace(/!(?:restart|clearChat|stfu)\b(?:\([^)]*\))?/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([.!?])/g, '$1')
        .trim();
}

export async function executeCommand(agent, message, { operator = false } = {}) {
    if (!operator) agent.actions?.clearLastOutcome?.();
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string') {
        // A human operator is told the error and is not entered into the
        // autonomous retry block. An agent's own invalid command is a failed
        // decision, not a successful action.
        if (!operator && agent.actions?.recordOutcome) {
            const commandName = containsCommand(message) || '!command';
            const behaviorKey = validationBehaviorKey(commandName);
            const signature = formatCommandSignature(commandName);
            const existing = agent.actions.retryBlocks?.get(behaviorKey);
            if (existing) {
                agent.actions.recordBlockedAttempt(commandName.replace(/^!/, ''), {}, existing);
                const form = existing.signature || signature;
                return `UNCHANGED BLOCKING CONDITION: ${existing.reason} Correct form: ${form}. Choose a different action.`;
            }
            const enriched = parsed.includes('Correct form:') || !signature
                ? parsed
                : `${parsed} Correct form: ${signature}.`;
            agent.actions.recordOutcome(makeValidationOutcome({
                agent, commandName, message: enriched, signature,
            }));
            return enriched;
        }
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    }
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        if (command.operatorOnly && !operator) {
            console.warn(`[${agent.name}] Blocked autonomous ${command.name}`);
            return `Command ${command.name} is reserved for the human operator. Choose a different action.`;
        }
        if (command.villageOnly && settings.village_autonomy !== true) {
            return `Command ${command.name} is not part of this session. Choose a different action.`;
        }
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        const countError = argCountError(command, numArgs);
        if (countError) return countError;
        else {
            if (!operator) {
                const paramNames = commandParamNames(command);
                const params = Object.fromEntries(paramNames.map((name, index) => [name, parsed.args[index]]));
                const retryBlock = agent.actions?.retryBlock?.(command.name.substring(1), params);
                if (retryBlock) {
                    agent.actions.recordBlockedAttempt?.(command.name.substring(1), params, retryBlock);
                    const prerequisites = retryBlock.prerequisites?.length
                        ? ` Required change: ${retryBlock.prerequisites.join(' ')}`
                        : '';
                    // Declined repeatedly with nothing run in between: the agent is
                    // looping, so point it at deliberate reflection.
                    const streak = agent.actions.blockedStreak || 0;
                    const reflect = streak >= 2
                        ? ` You have been declined ${streak} times in a row without running anything new. If you are unsure what to do next, use !think("your question").`
                        : '';
                    const form = retryBlock.signature ? ` Correct form: ${retryBlock.signature}.` : '';
                    if (retryBlock.condition === 'construction_area') {
                        const context = retryBlock.context ? ` What is actually around you: ${retryBlock.context}` : '';
                        return `UNCHANGED BLOCKING CONDITION: ${retryBlock.reason}${prerequisites}${context} Choose an action that changes this condition.${form}${reflect}`;
                    }
                    return `UNCHANGED BLOCKING CONDITION: ${retryBlock.reason} Retrying this action is not reasonable while the blocking condition is unchanged.${prerequisites}${form} Choose a different action.${reflect}`;
                }
                // Anything that is allowed to run (including !think and queries) ends a declined streak.
                if (agent.actions) agent.actions.blockedStreak = 0;
            }
            // Failed wiki searches stay blocked across different queries until
            // the agent actually runs some other command.
            if (command.name !== '!searchWiki') {
                releaseWikiSearchBlock(agent);
            }
            if (command.name !== '!think') {
                noteReflectionAction(agent);
            }
            const result = await command.perform(agent, ...parsed.args);
            return result;
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    A command that lists parameters is invalid without them. Write !placeHere("cobblestone") or !digDown(4), not !placeHere or !digDown. Bare words inside parentheses are accepted: !placeHere(cobblestone).\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name) || command.operatorOnly) {
            continue;
        }
        if (command.villageOnly && settings.village_autonomy !== true) {
            continue;
        }
        if (command.requiresPersistentPlanning && !agent.plan_manager?.enabled) {
            continue;
        }
        if (command.name === '!think' && reflectionStatus(agent).unavailable) {
            const advice = reflectionStatus(agent).advice;
            docs += '!think: UNAVAILABLE until you take a different action. Do not call !think again yet.\n';
            if (advice) docs += `Previous reflection: ${advice}\n`;
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
