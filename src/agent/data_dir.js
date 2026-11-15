import path from 'path';
import settings from './settings.js';

/**
 * Directory that holds one agent's durable files (memory, plans, lessons, logs).
 * Survival agents stay in bots/<name>. A village life sets settings.agent_data_root
 * to its scenario runtime directory and must never resolve inside bots/.
 */
export function agentDataDir(name) {
    if (settings.agent_data_root) {
        const root = path.resolve(String(settings.agent_data_root));
        assertOutsideSurvivalBots(root);
        return root;
    }
    if (!name) throw new Error('Agent name is required for the survival data directory.');
    return path.join('bots', name);
}

export function assertOutsideSurvivalBots(resolvedPath) {
    const bots = path.resolve('bots');
    const resolved = path.resolve(resolvedPath);
    if (resolved === bots || resolved.startsWith(bots + path.sep)) {
        throw new Error(`Refusing agent data directory inside the survival runtime: ${resolved}`);
    }
}
