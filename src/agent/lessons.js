import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import settings from './settings.js';
import { agentDataDir } from './data_dir.js';

/**
 * Minimal store for lessons the agent has verified. This is deliberately not a
 * memory architecture: a small capped JSON list per agent, used only to remind
 * the reflection step of facts that are already established.
 *
 * A lesson is accepted only when its basis is one of:
 *   - "mechanics": derived by code from minecraft-data (never from model text)
 *   - "observed":  derived by code from verified action outcome evidence
 * Model-generated advice has no basis value that is accepted, so it can never
 * be persisted as knowledge.
 */
const VERSION = 1;
const MAX_LESSONS = 12;
const MAX_ACCOMPLISHMENTS = 8;
export const ACCOMPLISHMENT_TAG = 'accomplishment';
const ACCEPTED_BASES = new Set(['mechanics', 'observed']);

function lessonsFile(agent, baseDir) {
    if (settings.agent_data_root) return path.join(agentDataDir(agent.name), 'verified_lessons.json');
    return path.join(baseDir || agent.lessonsBaseDir || 'bots', agent.name, 'verified_lessons.json');
}

export function loadLessons(agent, baseDir) {
    const file = lessonsFile(agent, baseDir);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed?.version === VERSION && Array.isArray(parsed.lessons)) return parsed.lessons;
    } catch (error) {
        console.warn(`[${agent.name}] Could not load verified lessons: ${error.message}`);
    }
    return [];
}

/**
 * Returns true when a lesson was stored or reinforced, false when rejected.
 * `evidence` must be a non-empty string naming the verified observation.
 */
export function recordLesson(agent, { id, text, basis, evidence, tags = [] }, baseDir) {
    if (!id || !text || !ACCEPTED_BASES.has(basis) || !String(evidence || '').trim()) return false;
    const lessons = loadLessons(agent, baseDir);
    const now = new Date().toISOString();
    const existing = lessons.find(lesson => lesson.id === id);
    if (existing) {
        existing.count = (existing.count || 1) + 1;
        existing.lastVerifiedAt = now;
        existing.text = String(text).slice(0, 300);
        existing.evidence = String(evidence).slice(0, 300);
        existing.tags = tags;
    } else {
        lessons.push({
            id,
            text: String(text).slice(0, 300),
            basis,
            evidence: String(evidence).slice(0, 300),
            tags,
            count: 1,
            firstVerifiedAt: now,
            lastVerifiedAt: now,
        });
    }
    // Accomplishments are kept apart from reflection lessons so a new tool
    // fact cannot erase a craft the agent has already verified.
    const byTime = (a, b) => String(a.lastVerifiedAt).localeCompare(String(b.lastVerifiedAt));
    const accomplishments = lessons.filter(isAccomplishment).sort(byTime).slice(-MAX_ACCOMPLISHMENTS);
    const others = lessons.filter(lesson => !isAccomplishment(lesson)).sort(byTime).slice(-MAX_LESSONS);
    const kept = [...others, ...accomplishments].sort(byTime);
    const file = lessonsFile(agent, baseDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: VERSION, lessons: kept }, null, 2));
    renameSync(temporary, file);
    return true;
}

/** Lessons whose tags overlap the given problem tags, most recent first. */
export function relevantLessons(agent, tags = [], limit = 4, baseDir) {
    const wanted = new Set(tags);
    return loadLessons(agent, baseDir)
        .filter(lesson => wanted.size === 0 || (lesson.tags || []).some(tag => wanted.has(tag)))
        .sort((a, b) => String(b.lastVerifiedAt).localeCompare(String(a.lastVerifiedAt)))
        .slice(0, limit);
}

export function formatLessons(lessons) {
    if (!lessons.length) return '';
    return lessons
        .map(lesson => `- ${lesson.text} [${lesson.basis}; verified ${lesson.count}x]`)
        .join('\n');
}

function isAccomplishment(lesson) {
    return (lesson?.tags || []).includes(ACCOMPLISHMENT_TAG);
}

/**
 * Crafts and placements verified by an action outcome. Empty when the agent
 * has none, so the prompt does not grow a heading for nothing.
 */
export function formatKnownFacts(agent, baseDir) {
    const facts = loadLessons(agent, baseDir)
        .filter(isAccomplishment)
        .sort((a, b) => String(b.lastVerifiedAt).localeCompare(String(a.lastVerifiedAt)))
        .slice(0, MAX_ACCOMPLISHMENTS);
    if (!facts.length) return '';
    return [
        'KNOWN FACTS',
        'Verified accomplishments from your own actions. This is not a live inventory. Trust CURRENT GAME STATE for what you are holding now. A placed block listed here is still in the world at those coordinates.',
        ...facts.map(lesson => `- ${lesson.text} (verified ${lesson.count}x)`),
        '',
    ].join('\n');
}
