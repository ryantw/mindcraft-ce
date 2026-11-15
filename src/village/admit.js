import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { assertOutsideSurvivalBots } from '../agent/data_dir.js';
import { ScenarioError } from './errors.js';
import { profileChecksum } from './identity.js';
import { createAdmittedLife, readLife, writeLife } from './life.js';

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    writeFileSync(file, JSON.stringify(value, null, 2));
}

export function inhabitantRuntimeDir(runtimeRoot, scenarioId, inhabitantId) {
    const dir = path.resolve(runtimeRoot, scenarioId, inhabitantId);
    assertOutsideSurvivalBots(dir);
    return dir;
}

function plotFor(village, inhabitantId) {
    return village.plots.find(plot => plot.occupant === inhabitantId) || null;
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function sameHome(left, right) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.snapshot_home_plot_id === right.snapshot_home_plot_id
        && left.current_home_plot_id === right.current_home_plot_id;
}

function relationshipsFrom(profile, admittedAt) {
    const relationships = {};
    for (const seed of profile.seed_relationships || []) {
        relationships[seed.other_id] = {
            stance: seed.stance,
            note: seed.note,
            updated_at: admittedAt,
            source_episode_ids: [],
        };
    }
    return { schema_version: 1, relationships };
}

function snapshotFrom(scenario, profile, admittedAt) {
    const plot = plotFor(scenario.village, profile.id);
    return {
        schema_version: 1,
        inhabitant_id: profile.id,
        name: profile.name,
        profile_version: profile.profile_version,
        profile_checksum: profileChecksum(profile),
        admitted_at: admittedAt,
        scenario_id: scenario.scenario.id,
        backstory: profile.backstory,
        temperament: profile.temperament,
        interests: profile.interests || [],
        seed_relationships: profile.seed_relationships || [],
        home_plot_id: plot ? plot.id : null,
    };
}

function homeMismatch(snapshot, village, detectedAt) {
    const currentPlot = plotFor(village, snapshot.inhabitant_id);
    const currentId = currentPlot ? currentPlot.id : null;
    const original = snapshot.home_plot_id
        ? village.plots.find(plot => plot.id === snapshot.home_plot_id)
        : null;
    const moved = currentId !== snapshot.home_plot_id
        || (snapshot.home_plot_id && (!original || original.occupant !== snapshot.inhabitant_id));
    if (!moved) return null;
    return {
        detected_at: detectedAt,
        snapshot_home_plot_id: snapshot.home_plot_id,
        current_home_plot_id: currentId,
    };
}

/**
 * Create a life the first time. Later calls never rewrite identity.json or
 * relationships.json. Profile edits are recorded on the life file only.
 * Removing someone from the scenario list is not this function's job and does
 * not delete the directory.
 */
export function admitInhabitant(bundle, profile, { runtimeRoot, now = () => new Date().toISOString() } = {}) {
    if (!runtimeRoot) throw new ScenarioError('runtimeRoot is required.');
    const admittedAt = now();
    const dir = inhabitantRuntimeDir(runtimeRoot, bundle.scenario.id, profile.id);
    const identityFile = path.join(dir, 'identity.json');
    const relationshipFile = path.join(dir, 'relationships.json');
    mkdirSync(path.dirname(dir), { recursive: true });

    if (!existsSync(identityFile)) {
        if (existsSync(lifePathSafe(dir))) {
            throw new ScenarioError(`Life exists for '${profile.id}' without an identity snapshot.`);
        }
        mkdirSync(dir, { recursive: true });
        const snapshot = snapshotFrom(bundle, profile, admittedAt);
        writeJson(identityFile, snapshot);
        writeJson(relationshipFile, relationshipsFrom(profile, admittedAt));
        writeLife(dir, createAdmittedLife(admittedAt));
        remember(runtimeRoot, bundle.scenario.id, profile.id);
        return { id: profile.id, directory: dir, created: true, profile };
    }

    if (!existsSync(relationshipFile) || !readLife(dir)) {
        throw new ScenarioError(`Incomplete life for '${profile.id}'. Refusing to recreate identity or relationships.`);
    }
    const snapshot = readJson(identityFile);
    const life = readLife(dir);
    const checksum = profileChecksum(profile);
    const next = { ...life };
    let changed = false;
    if (checksum === snapshot.profile_checksum) {
        if (life.identity_mismatch) {
            next.identity_mismatch = null;
            changed = true;
        }
    } else {
        const mismatch = {
            detected_at: life.identity_mismatch?.detected_at || admittedAt,
            snapshot_checksum: snapshot.profile_checksum,
            file_checksum: checksum,
            snapshot_profile_version: snapshot.profile_version,
            file_profile_version: profile.profile_version,
        };
        if (!sameJson(life.identity_mismatch, mismatch)) {
            next.identity_mismatch = mismatch;
            changed = true;
        }
    }
    const homes = homeMismatch(snapshot, bundle.village, life.home_mismatch?.detected_at || admittedAt);
    if (!sameHome(life.home_mismatch, homes)) {
        next.home_mismatch = homes;
        changed = true;
    }
    if (changed) {
        next.updated_at = admittedAt;
        writeLife(dir, next);
    }
    remember(runtimeRoot, bundle.scenario.id, profile.id);
    return { id: profile.id, directory: dir, created: false, profile, life: changed ? next : life };
}

function lifePathSafe(dir) {
    return path.join(dir, 'life.json');
}

function remember(runtimeRoot, scenarioId, inhabitantId) {
    const file = path.join(runtimeRoot, scenarioId, 'registry.json');
    let registry = { schema_version: 1, scenario_id: scenarioId, inhabitants: [] };
    if (existsSync(file)) registry = readJson(file);
    if (registry.inhabitants.includes(inhabitantId)) return;
    registry.inhabitants.push(inhabitantId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, registry);
}

export function admitPopulation(bundle, options = {}) {
    const records = bundle.inhabitants.map(profile => admitInhabitant(bundle, profile, options));
    const launchable = [];
    const refused = [];
    for (const record of records) {
        const life = readLife(record.directory);
        if (life?.lifecycle === 'dead') refused.push({ ...record, reason: 'dead' });
        else launchable.push(record);
    }
    return { records, launchable, refused };
}
