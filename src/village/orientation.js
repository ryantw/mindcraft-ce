import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { createModel } from '../models/_model_map.js';
import { readEpisodes } from './episodes.js';
import { readIntentions, updateIntention } from './intentions.js';
import { readKnowledge } from './knowledge.js';

function orientationPath(dataRoot) {
    return path.join(dataRoot, 'orientation.json');
}

function writeAtomic(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, file);
}

function clip(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * First morning, before any lived episode. The day model may choose one
 * intention from identity and the home. This is not a dream and writes no journal.
 */
export function orientationPrompt(dataRoot, { surroundings = '' } = {}) {
    const identity = JSON.parse(readFileSync(path.join(dataRoot, 'identity.json'), 'utf8'));
    const knowledge = readKnowledge(dataRoot);
    const lines = [
        `You are ${identity.name}, on your first day in this place. You have not slept here. You have no journal of lived events. Do not invent memories of things that have not happened.`,
        `Who you already are: ${(identity.backstory || []).map(fact => fact.text).join(' ')}`,
        `Temperament: ${(identity.temperament || []).join(' ')}`,
        `Interests: ${(identity.interests || []).join(', ')}`,
    ];
    if (knowledge?.home) lines.push(`Your home is here, with a bed at ${knowledge.home.bed?.join(', ')} and a chest at ${knowledge.home.chest?.join(', ')}.`);
    if (surroundings) lines.push(`Around you now: ${clip(surroundings, 400)}`);
    lines.push('Choose at most one personal intention for today, from who you are and this place. It is not a job, not a quota, and not a task someone assigned. You may choose none. A quiet ordinary choice is enough: look around, visit a place, rest, or tend your home. Do not choose to build a settlement or gather a quota.');
    lines.push('Return only JSON: {"intention":null} or {"intention":"one sentence"}.');
    return lines.join('\n');
}

export async function orientFirstDay(dataRoot, { model = null, complete = null, surroundings = '', now = () => new Date().toISOString() } = {}) {
    if (!existsSync(path.join(dataRoot, 'identity.json'))) return { skipped: true, reason: 'no identity' };
    if (existsSync(orientationPath(dataRoot))) return { skipped: true, reason: 'already attempted' };
    if ((readEpisodes(dataRoot).episodes || []).length > 0) {
        writeAtomic(orientationPath(dataRoot), { schema_version: 1, at: now(), attempted: true, skipped: 'has episodes' });
        return { skipped: true, reason: 'has episodes' };
    }
    if (readIntentions(dataRoot).active) {
        writeAtomic(orientationPath(dataRoot), { schema_version: 1, at: now(), attempted: true, skipped: 'has intention' });
        return { skipped: true, reason: 'has intention' };
    }
    const prompt = orientationPrompt(dataRoot, { surroundings });
    let text = '';
    try {
        if (complete) {
            text = await complete(prompt);
        } else if (model) {
            const client = createModel(structuredClone(model));
            const response = await client.complete(prompt, 'Return only the JSON object. Do not invent a past.', {
                think: false,
                timeout_ms: 45000,
                max_predict: 128,
                options: { num_predict: 128 },
            });
            text = response?.content || '';
        }
    } catch (error) {
        writeAtomic(orientationPath(dataRoot), { schema_version: 1, at: now(), attempted: true, error: error.message });
        return { skipped: true, reason: error.message };
    }
    let intention = null;
    try {
        const start = String(text).indexOf('{');
        const end = String(text).lastIndexOf('}');
        const parsed = JSON.parse(String(text).slice(start, end + 1));
        intention = typeof parsed.intention === 'string' ? parsed.intention : null;
    } catch {
        intention = null;
    }
    const clean = intention ? intention.replace(/!\w+/g, '').replace(/\s+/g, ' ').trim().slice(0, 180) : '';
    if (clean) updateIntention(dataRoot, { action: 'revise', text: clean, source: 'orientation', now });
    writeAtomic(orientationPath(dataRoot), {
        schema_version: 1,
        at: now(),
        attempted: true,
        intention: clean || null,
    });
    const journal = path.join(dataRoot, 'journal.json');
    return { skipped: false, intention: clean || null, journal: existsSync(journal) };
}
