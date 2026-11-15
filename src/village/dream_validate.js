const JOURNAL_MAX = 900;
const BRIEF_MAX = 800;
const BRIEF_LINES = 10;
const STANCE_MAX = 240;
const INTENTION_MAX = 180;
const MEMORY_MAX = 200;
const NOTE_MAX = 240;
const MAX_INTENTIONS = 3;
const MAX_MEMORIES = 8;
const MAX_RELATIONSHIPS = 6;

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEATH_CAUSE = /\b(killed by|was killed|died of|died from|death by|skeleton|zombie|creeper|drowned|burned to|in lava|fell from|shot by)\b/i;
const MOTIVE = /\b(knew i|knew that i|to comfort|to cheer|because (?:he|she|they) wanted|on purpose to|felt sorry for me)\b/i;
const RECIPE_CLAIM = /\b(recipe|crafted from|made from)\b/i;
const COMMAND = /!\w+/;
const TOMORROW_DESIRE = /\b(?:maybe tomorrow|tomorrow) I(?:'ll| will| want| should| hope| might| could)\b|\bI(?:'d| would) like to\b|\bI want to (?:see|visit|help|talk|go|return|rest|stay|sit|walk)\b/i;

export function journalOffersTomorrow(journal) {
    return TOMORROW_DESIRE.test(String(journal || ''));
}

function clip(value, max) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length <= max ? text : text.slice(0, max);
}

function clipLines(value, max) {
    const text = String(value ?? '').replace(/\r/g, '').trim();
    return text.length <= max ? text : text.slice(0, max);
}

function parseJsonObject(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function corpus(parts) {
    return parts.filter(Boolean).join(' ').toLowerCase();
}

function unsupportedDeath(text, known) {
    if (!DEATH_CAUSE.test(text)) return null;
    const causes = text.toLowerCase().match(/\b(skeleton|zombie|creeper|drowned|burned|lava|fell|shot)\b/g) || [];
    if (causes.length === 0) {
        if (!DEATH_CAUSE.test(known)) return 'unwitnessed death';
        return null;
    }
    for (const cause of causes) {
        if (!known.includes(cause)) return `unwitnessed death (${cause})`;
    }
    return null;
}

function contradictsRecipe(text, facts) {
    if (!RECIPE_CLAIM.test(text)) return null;
    const claim = text.match(/(?:recipe(?:\s+is|\s+for)?|crafted from|made from)\s+(.{0,80})/i);
    if (!claim) return 'ungrounded recipe';
    const words = (claim[1].toLowerCase().match(/[a-z_]{3,}/g) || [])
        .filter(word => !['the', 'and', 'from', 'with', 'recipe', 'item', 'that', 'this'].includes(word));
    if (words.length === 0) return null;
    const known = corpus(facts);
    if (!known.trim()) return 'ungrounded recipe';
    const missing = words.filter(word => !known.includes(word));
    return missing.length ? `recipe contradicts verified facts (${missing.join(', ')})` : null;
}

function significantOverlap(text, known) {
    const words = (text.toLowerCase().match(/[a-z_]{4,}/g) || [])
        .filter(word => !['that', 'this', 'with', 'from', 'have', 'were', 'been', 'about', 'when', 'then'].includes(word));
    if (words.length === 0) return true;
    const hit = words.filter(word => known.includes(word)).length;
    return hit / words.length >= 0.5;
}

/**
 * Model output is untrusted. Extra fields are ignored. A cleaned value is
 * safe to commit. A failure keeps the previous morning, journal, and bank.
 */
export function validateDreamOutput(raw, {
    episodes = [],
    verifiedFacts = [],
    ledgerText = [],
    identityName = '',
} = {}) {
    const parsed = typeof raw === 'string' ? parseJsonObject(raw) : raw;
    if (!parsed) return { ok: false, reason: 'Dream output was not a JSON object.' };
    const byId = new Map(episodes.map(episode => [episode.id, episode]));
    const episodeText = corpus(episodes.map(episode => `${episode.text} ${(episode.refs || []).join(' ')}`));
    const factText = corpus([...verifiedFacts, ...ledgerText, episodeText]);

    let journal = clipLines(parsed.journal, JOURNAL_MAX + 1);
    if (!journal) return { ok: false, reason: 'A dream needs a private journal entry.' };
    if (journal.length > JOURNAL_MAX) return { ok: false, reason: 'Journal entry is too long.' };
    if (COMMAND.test(journal)) return { ok: false, reason: 'Journal entry contains command syntax.' };
    const journalDeath = unsupportedDeath(journal, episodeText);
    if (journalDeath) return { ok: false, reason: `Journal ${journalDeath}.` };
    const journalRecipe = contradictsRecipe(journal, factText);
    if (journalRecipe) return { ok: false, reason: `Journal ${journalRecipe}.` };
    if (identityName && new RegExp(`my name is (?!${escapeRegExp(identityName)}\\b)`, 'i').test(journal)) {
        return { ok: false, reason: 'Journal rewrites the admitted name.' };
    }

    const briefSource = clipLines(parsed.brief, BRIEF_MAX + 1);
    if (!briefSource) return { ok: false, reason: 'A dream needs a morning brief.' };
    const briefLines = briefSource.split(/\n/).map(line => line.trim()).filter(Boolean);
    if (briefSource.length > BRIEF_MAX || briefLines.length > BRIEF_LINES) {
        return { ok: false, reason: 'Morning brief is over the cap.' };
    }
    const brief = briefLines.join('\n');
    if (COMMAND.test(brief) || unsupportedDeath(brief, episodeText) || contradictsRecipe(brief, factText)) {
        return { ok: false, reason: 'Morning brief crosses a factual boundary.' };
    }

    let stance = clip(parsed.stance, STANCE_MAX);
    if (stance && (COMMAND.test(stance) || unsupportedDeath(stance, episodeText))) stance = '';

    const intentions = [];
    const proposed = Array.isArray(parsed.intentions) ? parsed.intentions : [];
    for (const item of proposed) {
        if (intentions.length >= MAX_INTENTIONS) break;
        const text = clip(typeof item === 'string' ? item : item?.text, INTENTION_MAX);
        if (!text || COMMAND.test(text)) continue;
        intentions.push(text);
    }
    let ambition = clip(parsed.ambition, 240);
    if (ambition && (COMMAND.test(ambition) || unsupportedDeath(ambition, episodeText))) ambition = '';

    const memories = [];
    const dropped = [];
    const rows = Array.isArray(parsed.memories) ? parsed.memories : [];
    for (const row of rows.slice(0, MAX_MEMORIES)) {
        if (!row || typeof row !== 'object') continue;
        const op = row.op === 'forget' ? 'forget' : 'upsert';
        const ids = [...new Set((row.source_episode_ids || []).map(String))].slice(0, 8);
        if (ids.length === 0 || ids.some(id => !byId.has(id))) {
            dropped.push({ reason: 'missing episode', text: clip(row.text, 80) });
            continue;
        }
        const cited = corpus(ids.map(id => `${byId.get(id).text} ${(byId.get(id).refs || []).join(' ')}`));
        const text = clip(row.text, MEMORY_MAX);
        if (!text || COMMAND.test(text)) {
            dropped.push({ reason: 'empty or command', text });
            continue;
        }
        const death = unsupportedDeath(text, cited);
        const recipe = contradictsRecipe(text, corpus([cited, ...verifiedFacts, ...ledgerText]));
        if (death || recipe) {
            dropped.push({ reason: death || recipe, text });
            continue;
        }
        let kind = row.kind === 'fact' ? 'fact' : 'interpretation';
        if (kind === 'fact' && (MOTIVE.test(text) || !significantOverlap(text, cited))) {
            dropped.push({ reason: 'unsupported fact', text });
            continue;
        }
        const priority = Math.max(1, Math.min(5, Math.round(Number(row.priority) || 3)));
        const id = /^mem-[a-z0-9-]{1,40}$/.test(row.id) ? row.id : null;
        memories.push({ op, id, kind, text, priority, source_episode_ids: ids });
    }

    const relationships = [];
    const relationRows = Array.isArray(parsed.relationships) ? parsed.relationships : [];
    for (const row of relationRows.slice(0, MAX_RELATIONSHIPS)) {
        const otherId = clip(row?.other_id, 40);
        const ids = [...new Set((row?.source_episode_ids || []).map(String))].slice(0, 8);
        if (!otherId || ids.length === 0 || ids.some(id => !byId.has(id))) continue;
        const cited = corpus(ids.map(id => `${byId.get(id).text} ${(byId.get(id).refs || []).join(' ')}`));
        if (!cited.includes(otherId.toLowerCase())) continue;
        const stanceText = clip(row.stance, 80);
        const note = clip(row.note, NOTE_MAX);
        if (!stanceText || !note || COMMAND.test(note) || unsupportedDeath(note, cited)) continue;
        relationships.push({
            other_id: otherId,
            stance: stanceText,
            note,
            source_episode_ids: ids,
        });
    }

    return {
        ok: true,
        value: { journal, brief, stance, intentions, memories, relationships, ambition },
        dropped,
        ignoredFields: Object.keys(parsed).filter(key => !['journal', 'brief', 'stance', 'intentions', 'memories', 'relationships', 'ambition'].includes(key)),
    };
}
