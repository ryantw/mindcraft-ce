import path from 'path';
import { admitPopulation } from './admit.js';
import { inhabitantRuntimeDir } from './admit.js';

export const DEFAULT_EMBEDDING = 'ollama/embeddinggemma';

/**
 * Settings for one village process. The survival settings object is cloned and
 * never written. init_message is cleared so the settlement essay is not inherited.
 * The dream model is carried as configuration. A client is built only when a sleep job runs.
 */
export function buildAgentSettings(bundle, profile, survivalSettings, { runtimeRoot } = {}) {
    const settings = structuredClone(survivalSettings);
    const { scenario } = bundle;
    settings.host = scenario.connection.host;
    settings.port = scenario.connection.port;
    settings.minecraft_version = scenario.connection.minecraft_version;
    settings.auth = scenario.connection.auth;
    settings.base_profile = scenario.settings.base_profile;
    settings.allow_insecure_coding = false;
    settings.load_memory = scenario.settings.load_memory !== false;
    settings.init_message = null;
    settings.village_autonomy = true;
    settings.village_permadeath = scenario.settings.permanent_death === true;
    settings.village_hearing_blocks = scenario.settings.hearing_blocks || 32;
    settings.village_remains_container = scenario.settings.remains_container || null;
    settings.village_scenario_id = scenario.id;
    settings.village_inhabitant_id = profile.id;
    settings.dream_model = structuredClone(scenario.models.dream);
    settings.agent_data_root = inhabitantRuntimeDir(runtimeRoot, scenario.id, profile.id);
    settings.profile = {
        name: profile.name,
        model: structuredClone(profile.model || scenario.models.day),
        embedding: profile.embedding || DEFAULT_EMBEDDING,
    };
    return settings;
}

/**
 * Admit every configured inhabitant, then build start settings for those who
 * are not dead. Does not spawn processes and does not modify survivalSettings.
 * People omitted from the scenario file are left on disk, still not dead.
 */
export function prepareScenario(bundle, survivalSettings, options = {}) {
    const runtimeRoot = options.runtimeRoot || path.join('runtime', 'scenarios');
    const admitted = admitPopulation(bundle, { ...options, runtimeRoot });
    const agents = admitted.launchable.map(record => buildAgentSettings(bundle, record.profile, survivalSettings, { runtimeRoot }));
    return { ...admitted, agents, runtimeRoot };
}
