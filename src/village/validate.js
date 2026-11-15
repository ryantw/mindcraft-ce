import path from 'path';
import { validateNameFormat } from '../agent/connection_handler.js';
import { ScenarioError } from './errors.js';

const BASE_PROFILES = new Set(['survival', 'assistant', 'creative', 'god_mode']);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
    throw new ScenarioError(message);
}

function exactKeys(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(`${label} has unknown field '${key}'.`);
    }
    return value;
}

function requireKeys(value, keys, label) {
    for (const key of keys) {
        if (value[key] === undefined) fail(`${label} is missing '${key}'.`);
    }
}

function isInteger(value) {
    return Number.isInteger(value);
}

function coordinate(value, label) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
        fail(`${label} must be a coordinate triple [x, y, z].`);
    }
}

function plainString(value, label) {
    if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
    return value.trim();
}

export function assertInside(root, candidate, label) {
    const base = path.resolve(root);
    const resolved = path.resolve(base, candidate);
    if (path.isAbsolute(candidate)) fail(`${label} must be a relative path.`);
    if (candidate.split(/[\\/]/).includes('..')) fail(`${label} must not contain '..'.`);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) fail(`${label} escapes the scenario directory.`);
    return resolved;
}

function validateModel(model, label) {
    exactKeys(model, ['api', 'model', 'params'], label);
    requireKeys(model, ['api', 'model'], label);
    plainString(model.api, `${label}.api`);
    plainString(model.model, `${label}.model`);
    if (model.params !== undefined && (typeof model.params !== 'object' || Array.isArray(model.params) || model.params === null)) {
        fail(`${label}.params must be an object.`);
    }
}

function validateInhabitant(profile, fileLabel) {
    exactKeys(profile, ['schema_version', 'id', 'name', 'profile_version', 'backstory', 'temperament', 'interests', 'seed_relationships', 'model', 'embedding'], fileLabel);
    requireKeys(profile, ['schema_version', 'id', 'name', 'profile_version', 'backstory', 'temperament'], fileLabel);
    if (profile.schema_version !== 1) fail(`${fileLabel} schema_version must be 1.`);
    if (!ID_PATTERN.test(profile.id)) fail(`${fileLabel} id '${profile.id}' must be lowercase words separated by hyphens.`);
    const nameCheck = validateNameFormat(profile.name);
    if (!nameCheck.success) fail(`${fileLabel} Minecraft name was rejected: ${nameCheck.msg}`);
    if (!isInteger(profile.profile_version) || profile.profile_version < 1) fail(`${fileLabel} profile_version must be an integer >= 1.`);
    if (!Array.isArray(profile.backstory) || profile.backstory.length < 1) fail(`${fileLabel} backstory must list at least one fact.`);
    const factIds = new Set();
    for (const fact of profile.backstory) {
        exactKeys(fact, ['id', 'text'], `${fileLabel} backstory fact`);
        requireKeys(fact, ['id', 'text'], `${fileLabel} backstory fact`);
        plainString(fact.id, `${fileLabel} backstory id`);
        plainString(fact.text, `${fileLabel} backstory text`);
        if (factIds.has(fact.id)) fail(`${fileLabel} repeats backstory id '${fact.id}'.`);
        factIds.add(fact.id);
    }
    if (!Array.isArray(profile.temperament) || profile.temperament.length < 1 || profile.temperament.some(item => typeof item !== 'string' || !item.trim())) {
        fail(`${fileLabel} temperament must be a non-empty list of strings.`);
    }
    if (profile.interests !== undefined && (!Array.isArray(profile.interests) || profile.interests.some(item => typeof item !== 'string' || !item.trim()))) {
        fail(`${fileLabel} interests must be a list of strings.`);
    }
    if (profile.seed_relationships !== undefined && !Array.isArray(profile.seed_relationships)) {
        fail(`${fileLabel} seed_relationships must be a list.`);
    }
    if (profile.model) validateModel(profile.model, `${fileLabel} model`);
    if (profile.embedding !== undefined) plainString(profile.embedding, `${fileLabel} embedding`);
    return profile;
}

function validateVillage(village) {
    exactKeys(village, ['schema_version', 'id', 'spawn_dimension', 'plots', 'public', 'provisions', 'paths', 'notes', 'provision'], 'village');
    requireKeys(village, ['schema_version', 'id', 'spawn_dimension', 'plots', 'public', 'provisions', 'paths'], 'village');
    if (village.schema_version !== 1) fail('village schema_version must be 1.');
    plainString(village.id, 'village.id');
    plainString(village.spawn_dimension, 'village.spawn_dimension');
    if (!Array.isArray(village.plots) || village.plots.length < 1) fail('village.plots must list at least one plot.');
    const plotIds = new Set();
    const occupants = new Map();
    for (const plot of village.plots) {
        exactKeys(plot, ['id', 'occupant', 'home_marker', 'bed', 'chest', 'door', 'crafting_table', 'furnace', 'notes'], `plot ${plot?.id || ''}`);
        requireKeys(plot, ['id', 'occupant', 'home_marker', 'bed', 'chest', 'door', 'crafting_table', 'furnace'], `plot ${plot?.id || ''}`);
        if (!ID_PATTERN.test(plot.id)) fail(`Plot id '${plot.id}' must be lowercase words separated by hyphens.`);
        if (plotIds.has(plot.id)) fail(`Duplicate plot id '${plot.id}'.`);
        plotIds.add(plot.id);
        if (plot.occupant !== null && (typeof plot.occupant !== 'string' || !ID_PATTERN.test(plot.occupant))) {
            fail(`Plot '${plot.id}' occupant must be null or an inhabitant id.`);
        }
        if (plot.occupant) {
            if (occupants.has(plot.occupant)) fail(`Conflicting home assignment: '${plot.occupant}' is listed on more than one plot.`);
            occupants.set(plot.occupant, plot.id);
        }
        for (const point of ['home_marker', 'bed', 'chest', 'door', 'crafting_table', 'furnace']) coordinate(plot[point], `plot ${plot.id} ${point}`);
    }
    if (!Array.isArray(village.public)) fail('village.public must be a list.');
    const publicIds = new Set();
    for (const place of village.public) {
        exactKeys(place, ['id', 'marker', 'notes', 'chest'], `public place ${place?.id || ''}`);
        requireKeys(place, ['id', 'marker'], `public place ${place?.id || ''}`);
        if (!ID_PATTERN.test(place.id)) fail(`Public place id '${place.id}' is invalid.`);
        if (publicIds.has(place.id) || plotIds.has(place.id)) fail(`Duplicate place id '${place.id}'.`);
        publicIds.add(place.id);
        coordinate(place.marker, `public place ${place.id}`);
        if (place.chest !== undefined) coordinate(place.chest, `public place ${place.id} chest`);
    }
    exactKeys(village.provisions, ['per_home', 'refill', 'public_chest'], 'provisions');
    requireKeys(village.provisions, ['per_home', 'refill'], 'provisions');
    if (village.provisions.refill !== 'never') fail('provisions.refill must be "never".');
    exactKeys(village.provisions.per_home, ['food', 'tools', 'also', 'armor', 'materials', 'personal_cycle', 'vacant_chest'], 'provisions.per_home');
    requireKeys(village.provisions.per_home, ['food', 'tools', 'also'], 'provisions.per_home');
    if (!Array.isArray(village.provisions.per_home.food)) fail('provisions.per_home.food must be a list.');
    const stacks = [
        ...village.provisions.per_home.food.map(food => ['provision food', food]),
        ...(village.provisions.per_home.materials || []).map(item => ['provision material', item]),
        ...(village.provisions.per_home.vacant_chest || []).map(item => ['vacant chest stack', item]),
        ...(village.provisions.public_chest || []).map(item => ['public chest stack', item]),
    ];
    for (const [label, stack] of stacks) {
        exactKeys(stack, ['item', 'count'], label);
        requireKeys(stack, ['item', 'count'], label);
        plainString(stack.item, `${label} item`);
        if (!isInteger(stack.count) || stack.count < 1 || stack.count > 64) fail(`${label} count must be an integer from 1 to 64.`);
    }
    for (const listName of ['tools', 'also', 'armor', 'personal_cycle']) {
        const list = village.provisions.per_home[listName];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !item.trim())) {
            fail(`provisions.per_home.${listName} must be a list of strings.`);
        }
    }
    if (village.provision !== undefined) {
        exactKeys(village.provision, ['version', 'method', 'seed', 'floor_block_y', 'origin', 'verified_at'], 'provision');
        requireKeys(village.provision, ['version', 'method', 'seed', 'floor_block_y', 'origin'], 'provision');
        if (!isInteger(village.provision.version) || village.provision.version < 1) fail('provision.version must be an integer >= 1.');
        plainString(village.provision.method, 'provision.method');
        plainString(village.provision.seed, 'provision.seed');
        if (!isInteger(village.provision.floor_block_y)) fail('provision.floor_block_y must be an integer.');
        coordinate(village.provision.origin, 'provision.origin');
        if (village.provision.verified_at !== undefined) plainString(village.provision.verified_at, 'provision.verified_at');
    }
    if (!Array.isArray(village.paths)) fail('village.paths must be a list.');
    const known = new Set([...plotIds, ...publicIds]);
    for (const route of village.paths) {
        exactKeys(route, ['from', 'to', 'walkable_without_breaking'], 'path');
        requireKeys(route, ['from', 'to', 'walkable_without_breaking'], 'path');
        if (!known.has(route.from) || !known.has(route.to)) fail(`Path '${route.from}' -> '${route.to}' names an unknown place.`);
        if (route.walkable_without_breaking !== true) fail('Milestone 2 paths must be marked walkable_without_breaking: true. This file only records the claim.');
    }
    return { plotIds, occupants };
}

/**
 * Validate an already-loaded scenario bundle.
 * `reservedNames` are survival Minecraft names and ids that a village must not reuse.
 * `knownRuntimeIds` are inhabitant ids that already have a runtime directory, so a
 * removed person can remain a plot occupant. Reassignment of a house is not rejected
 * here; admission records a home mismatch and keeps the original snapshot.
 */
export function validateScenario(bundle, { reservedNames = [], knownRuntimeIds = [], forLaunch = false } = {}) {
    const { directory, scenario, village, inhabitants } = bundle;
    exactKeys(scenario, ['schema_version', 'id', 'title', 'connection', 'models', 'inhabitants', 'village', 'settings'], 'scenario');
    requireKeys(scenario, ['schema_version', 'id', 'title', 'connection', 'models', 'inhabitants', 'village', 'settings'], 'scenario');
    if (scenario.schema_version !== 1) fail('scenario schema_version must be 1.');
    if (!ID_PATTERN.test(scenario.id)) fail(`Scenario id '${scenario.id}' must be lowercase words separated by hyphens.`);
    if (path.basename(directory) !== scenario.id) fail(`Scenario id '${scenario.id}' does not match directory '${path.basename(directory)}'.`);
    plainString(scenario.title, 'scenario.title');

    exactKeys(scenario.connection, ['host', 'port', 'minecraft_version', 'auth'], 'connection');
    requireKeys(scenario.connection, ['host', 'port', 'minecraft_version', 'auth'], 'connection');
    plainString(scenario.connection.host, 'connection.host');
    if (!isInteger(scenario.connection.port) || scenario.connection.port < 1 || scenario.connection.port > 65535) {
        fail('connection.port must be an explicit TCP port from 1 to 65535. Port -1 is the survival scanner and is not a scenario target.');
    }
    plainString(scenario.connection.minecraft_version, 'connection.minecraft_version');
    plainString(scenario.connection.auth, 'connection.auth');

    exactKeys(scenario.models, ['day', 'dream'], 'models');
    requireKeys(scenario.models, ['day', 'dream'], 'models');
    validateModel(scenario.models.day, 'models.day');
    validateModel(scenario.models.dream, 'models.dream');

    if (!Array.isArray(scenario.inhabitants) || scenario.inhabitants.some(item => typeof item !== 'string')) {
        fail('scenario.inhabitants must be a list of relative paths.');
    }
    if (forLaunch && scenario.inhabitants.length < 1) fail('A launched scenario needs at least one inhabitant.');
    const seenPaths = new Set();
    for (const relative of scenario.inhabitants) {
        assertInside(directory, relative, `inhabitant path '${relative}'`);
        if (seenPaths.has(relative)) fail(`Duplicate inhabitant path '${relative}'.`);
        seenPaths.add(relative);
    }
    assertInside(directory, scenario.village, 'village path');

    exactKeys(scenario.settings, ['base_profile', 'allow_insecure_coding', 'load_memory', 'permanent_death', 'hearing_blocks'], 'scenario.settings');
    requireKeys(scenario.settings, ['base_profile', 'allow_insecure_coding'], 'scenario.settings');
    if (!BASE_PROFILES.has(scenario.settings.base_profile)) fail(`base_profile '${scenario.settings.base_profile}' is not a shared Mindcraft baseline.`);
    if (scenario.settings.allow_insecure_coding !== false) fail('Insecure village configuration: allow_insecure_coding must be false.');
    if (scenario.settings.load_memory !== undefined && typeof scenario.settings.load_memory !== 'boolean') {
        fail('scenario.settings.load_memory must be a boolean.');
    }
    if (scenario.settings.permanent_death !== undefined && typeof scenario.settings.permanent_death !== 'boolean') {
        fail('scenario.settings.permanent_death must be a boolean.');
    }
    if (scenario.settings.hearing_blocks !== undefined) {
        if (!isInteger(scenario.settings.hearing_blocks) || scenario.settings.hearing_blocks < 8 || scenario.settings.hearing_blocks > 128) {
            fail('scenario.settings.hearing_blocks must be an integer from 8 to 128.');
        }
    }

    const { occupants } = validateVillage(village);
    const reserved = new Set(reservedNames.map(name => String(name).toLowerCase()));
    const ids = new Set();
    const names = new Set();
    for (const profile of inhabitants) {
        validateInhabitant(profile, `inhabitant '${profile?.id || profile?.name || 'unknown'}'`);
        if (ids.has(profile.id)) fail(`Duplicate inhabitant id '${profile.id}'.`);
        ids.add(profile.id);
        const nameKey = profile.name.toLowerCase();
        if (names.has(nameKey)) fail(`Duplicate Minecraft username '${profile.name}'.`);
        names.add(nameKey);
        if (reserved.has(profile.id.toLowerCase()) || reserved.has(nameKey)) {
            fail(`Inhabitant '${profile.name}' collides with a survival-experiment identity.`);
        }
    }
    for (const profile of inhabitants) {
        for (const seed of profile.seed_relationships || []) {
            exactKeys(seed, ['other_id', 'stance', 'note'], `${profile.id} seed relationship`);
            requireKeys(seed, ['other_id', 'stance', 'note'], `${profile.id} seed relationship`);
            if (!ID_PATTERN.test(seed.other_id)) fail(`${profile.id} has an invalid relationship id '${seed.other_id}'.`);
            if (seed.other_id === profile.id) fail(`${profile.id} cannot seed a relationship with themselves.`);
            if (!ids.has(seed.other_id)) fail(`${profile.id} seeds a relationship with unknown inhabitant '${seed.other_id}'.`);
            plainString(seed.stance, `${profile.id} relationship stance`);
            plainString(seed.note, `${profile.id} relationship note`);
        }
    }
    const known = new Set([...ids, ...knownRuntimeIds]);
    for (const [occupant, plotId] of occupants) {
        if (!known.has(occupant)) fail(`Plot '${plotId}' names unknown inhabitant '${occupant}'.`);
    }
    return bundle;
}
