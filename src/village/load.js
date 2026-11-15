import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { ScenarioError } from './errors.js';
import { assertInside, validateScenario } from './validate.js';

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new ScenarioError(`Could not read ${file}: ${error.message}`);
    }
}

export function resolveScenarioDirectory(input, cwd = process.cwd()) {
    const raw = String(input || '').trim();
    if (!raw) throw new ScenarioError('A scenario id or path is required.');
    const direct = path.resolve(cwd, raw);
    if (existsSync(path.join(direct, 'scenario.json'))) return direct;
    const nested = path.resolve(cwd, 'scenarios', raw);
    if (existsSync(path.join(nested, 'scenario.json'))) return nested;
    throw new ScenarioError(`No scenario.json at '${raw}'.`);
}

export function knownRuntimeIds(runtimeRoot, scenarioId) {
    const dir = path.join(runtimeRoot, scenarioId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

/**
 * Load and validate a scenario directory. Does not write runtime files and does not
 * mutate the survival settings object passed in for reserved names.
 */
export function loadScenario(directory, { reservedNames = [], runtimeRoot = path.join('runtime', 'scenarios'), forLaunch = false } = {}) {
    const resolved = path.resolve(directory);
    const scenarioPath = path.join(resolved, 'scenario.json');
    if (!existsSync(scenarioPath)) throw new ScenarioError(`Missing ${scenarioPath}.`);
    const scenario = readJson(scenarioPath);
    if (typeof scenario?.village !== 'string') throw new ScenarioError('scenario.village must be a relative path.');
    const villagePath = assertInside(resolved, scenario.village, 'village path');
    if (!existsSync(villagePath)) throw new ScenarioError(`Missing village file '${scenario.village}'.`);
    const village = readJson(villagePath);
    const inhabitants = [];
    if (Array.isArray(scenario.inhabitants)) {
        for (const relative of scenario.inhabitants) {
            if (typeof relative !== 'string') {
                inhabitants.push(relative);
                continue;
            }
            const file = assertInside(resolved, relative, `inhabitant path '${relative}'`);
            if (!existsSync(file)) throw new ScenarioError(`Missing inhabitant file '${relative}'.`);
            inhabitants.push(readJson(file));
        }
    }
    const bundle = { directory: resolved, scenario, village, inhabitants };
    const runtimeIds = scenario?.id ? knownRuntimeIds(runtimeRoot, scenario.id) : [];
    return validateScenario(bundle, { reservedNames, knownRuntimeIds: runtimeIds, forLaunch });
}
