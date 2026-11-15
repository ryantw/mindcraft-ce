import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import settings from '../agent/settings.js';

/**
 * Day-model heartbeats live beside the dream queue, not in anyone's memory.
 * A dream waits for a short quiet period so the 8B and 14B models are not
 * swapped on every action, then starts anyway so a dream cannot be deferred
 * forever. Day calls are never queued behind a dream.
 */
export function pulsePath(scenarioRoot, inhabitantId) {
    return path.join(scenarioRoot, 'pulses', inhabitantId);
}

export function noteDayModel(scenarioRoot, inhabitantId, active, now = Date.now()) {
    if (!scenarioRoot || !inhabitantId) return;
    const file = pulsePath(scenarioRoot, inhabitantId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, active ? String(now) : '0');
}

export function dayModelsBusy(scenarioRoot, now = Date.now(), quietMs = 3000) {
    const dir = path.join(scenarioRoot, 'pulses');
    if (!existsSync(dir)) return false;
    for (const name of readdirSync(dir)) {
        const stamp = Number(readFileSync(path.join(dir, name), 'utf8'));
        if (Number.isFinite(stamp) && stamp > 0 && now - stamp < quietMs) return true;
    }
    return false;
}

export function watchDayModel(active) {
    if (settings.village_autonomy !== true || !settings.agent_data_root || !settings.village_inhabitant_id) return;
    noteDayModel(path.dirname(settings.agent_data_root), settings.village_inhabitant_id, active);
}
