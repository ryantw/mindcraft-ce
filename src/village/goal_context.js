import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { activeAmbitionText, readAmbitions } from './ambitions.js';
import { readEpisodes } from './episodes.js';
import { readKnowledge } from './knowledge.js';
import { readRelationships } from './relationships.js';
import { readIntentions } from './intentions.js';

/**
 * Notes for one inhabitant's goal choice. Reads only `dataRoot`.
 * A marker is quoted as a marker. Another person's life file is not opened.
 */

function clip(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function coordText(value) {
    if (!Array.isArray(value) || value.length < 3) return '';
    return `${value[0]}, ${value[1]}, ${value[2]}`;
}

function keyOf(x, y, z) {
    return `${x},${y},${z}`;
}

function knownPlaces(knowledge) {
    const places = [];
    const home = knowledge?.home;
    const homeBits = [
        ['marker', home?.home_marker],
        ['bed', home?.bed],
        ['chest', home?.chest],
        ['door', home?.door],
        ['crafting table', home?.crafting_table],
        ['furnace', home?.furnace],
    ];
    for (const [label, value] of homeBits) {
        if (Array.isArray(value)) places.push({ id: label, kind: 'home', coord: value, text: coordText(value) });
    }
    for (const place of knowledge?.public_places || []) {
        if (place?.id && Array.isArray(place.marker)) {
            places.push({ id: place.id, kind: 'public', coord: place.marker, text: coordText(place.marker) });
        }
    }
    return places;
}

function distance(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.hypot(dx, dy, dz);
}

function wordsOf(text) {
    return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(word => word.length > 2));
}

function similar(left, right) {
    const a = wordsOf(left);
    const b = wordsOf(right);
    if (!a.size || !b.size) return false;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    return shared / (a.size + b.size - shared) >= 0.45;
}

function identityOf(dataRoot) {
    const file = path.join(dataRoot, 'identity.json');
    if (!existsSync(file)) return {};
    return readJson(file);
}

function actionObservations(dataRoot) {
    const dir = path.join(dataRoot, 'histories');
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
    const found = [];
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path.join(dir, file.name), 'utf8'));
        } catch {
            continue;
        }
        if (!Array.isArray(parsed)) continue;
        for (const message of parsed) {
            if (message?.role !== 'system') continue;
            const content = String(message.content || '');
            if (!content.includes('ACTION RESULT')) continue;
            found.push(content);
        }
    }
    return found;
}

function chestFromObservation(content) {
    const at = content.match(/reached at (-?\d+), (-?\d+), (-?\d+)/);
    const start = content.indexOf('The chest contains:');
    if (start < 0) return null;
    const items = [];
    for (const line of content.slice(start).split('\n').slice(1)) {
        const match = line.trim().match(/^(\d+)\s+([a-z0-9_]+)$/i);
        if (!match) break;
        items.push(`${match[1]} ${match[2].replace(/_/g, ' ')}`);
    }
    if (!items.length) return null;
    return {
        at: at ? [Number(at[1]), Number(at[2]), Number(at[3])] : null,
        items,
    };
}

function inventoryDelta(content) {
    const match = content.match(/Inventory before -> after: ([^.\n]+)/);
    if (!match || /no changes/i.test(match[1])) return '';
    return match[1].trim();
}

function collectVisits(episodes) {
    const exact = [];
    const found = [];
    const water = [];
    for (const episode of episodes) {
        const text = String(episode?.text || '');
        for (const match of text.matchAll(/Found ([a-z0-9_]+) at \((-?\d+), (-?\d+), (-?\d+)\)/gi)) {
            found.push({ type: match[1], at: [Number(match[2]), Number(match[3]), Number(match[4])] });
        }
        for (const match of text.matchAll(/reached at (-?\d+), (-?\d+), (-?\d+)/gi)) {
            exact.push([Number(match[1]), Number(match[2]), Number(match[3])]);
        }
        for (const match of text.matchAll(/water at (-?\d+), (-?\d+), (-?\d+)/gi)) {
            water.push([Number(match[1]), Number(match[2]), Number(match[3])]);
        }
    }
    return { exact, found, water };
}

function uniqueCoords(list, limit) {
    const seen = new Set();
    const kept = [];
    for (const item of list) {
        const key = Array.isArray(item) ? keyOf(...item) : keyOf(...item.at);
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(item);
        if (kept.length >= limit) break;
    }
    return kept;
}

function placeLines(knowledge, episodes) {
    const places = knownPlaces(knowledge);
    const visits = collectVisits(episodes);
    const lines = [];
    if (places.length) {
        lines.push('Places on record, with coordinates. A coordinate is a place you know about. It is not a claim that you have already explored it.');
        const home = places.filter(place => place.kind === 'home');
        const plot = knowledge?.home?.plot_id ? `, ${knowledge.home.plot_id}` : '';
        if (home.length) lines.push(`Home${plot}: ${home.map(place => `${place.id} ${place.text}`).join('; ')}.`);
        const publicPlaces = places.filter(place => place.kind === 'public');
        if (publicPlaces.length) lines.push(`Public places: ${publicPlaces.map(place => `${place.id} ${place.text}`).join('; ')}.`);
    }
    const named = [];
    const namedKeys = new Set();
    for (const place of places) {
        const hit = visits.exact.some(at => at[0] === place.coord[0] && at[1] === place.coord[1] && at[2] === place.coord[2]);
        if (!hit) continue;
        named.push(place.kind === 'home' ? `your ${place.id}` : place.id);
        namedKeys.add(keyOf(...place.coord));
    }
    const discoveries = [];
    for (const item of uniqueCoords(visits.found, 8)) {
        const key = keyOf(...item.at);
        if (namedKeys.has(key)) continue;
        discoveries.push(`${item.type.replace(/_/g, ' ')} at ${item.at.join(', ')}`);
    }
    const waterClusters = [];
    for (const at of uniqueCoords(visits.water, 12)) {
        const nearby = places
            .filter(place => place.kind === 'public' && distance(place.coord, at) <= 8)
            .map(place => place.id);
        const cluster = waterClusters.find(item => distance(item.at, at) <= 4 && item.nearby.join() === nearby.join());
        if (cluster) {
            cluster.count += 1;
            continue;
        }
        waterClusters.push({ at, nearby, count: 1 });
    }
    const waterNotes = waterClusters.slice(0, 4).map(item => {
        const where = item.nearby.length ? `, near ${item.nearby.join(' and ')}` : '';
        const again = item.count > 1 ? `, ${item.count} times nearby` : '';
        return `water at ${item.at.join(', ')}${where}${again}`;
    });
    if (named.length || discoveries.length || waterNotes.length) {
        lines.push(`Places and materials you have physically reached: ${[...named, ...discoveries, ...waterNotes].join('; ')}.`);
    }
    const unvisited = places
        .filter(place => !visits.exact.some(at => at[0] === place.coord[0] && at[1] === place.coord[1] && at[2] === place.coord[2]))
        .map(place => place.kind === 'home' ? `your ${place.id}` : place.id);
    if (unvisited.length) lines.push(`No recorded arrival at: ${unvisited.join(', ')}.`);
    return lines;
}

function resourceLines(dataRoot, episodes, inventory, knowledge) {
    const lines = ['Resources you have actually seen:'];
    let chest = null;
    const hands = [];
    for (const observation of actionObservations(dataRoot)) {
        const found = chestFromObservation(observation);
        if (found) chest = found;
        const delta = inventoryDelta(observation);
        if (delta) hands.push(delta);
    }
    const chestEpisode = [...episodes].reverse().find(episode => /chest contains/i.test(episode?.text || ''));
    if (chest) {
        const where = chest.at ? ` at ${chest.at.join(', ')}` : '';
        const homeChest = Array.isArray(knowledge?.home?.chest) ? knowledge.home.chest : null;
        const own = homeChest && chest.at
            && chest.at[0] === homeChest[0] && chest.at[1] === homeChest[1] && chest.at[2] === homeChest[2];
        lines.push(`Last full look inside ${own ? 'your home chest' : 'a chest'}${where}: ${chest.items.join(', ')}. This is a later inspection, not a live inventory.`);
    } else if (chestEpisode?.text) {
        lines.push(`A chest inspection is recorded, and the stored note is incomplete: ${clip(chestEpisode.text, 220)}`);
    } else {
        const knowledge = readKnowledge(dataRoot);
        const admitted = (knowledge?.supplies_at_admission || [])
            .map(stack => `${stack.count} ${String(stack.item || '').replace(/_/g, ' ')}`)
            .filter(Boolean);
        if (admitted.length) {
            lines.push(`At admission the chest held ${admitted.join(', ')}. ${knowledge?.supplies_note || 'That list is a memory of admission, not a live inventory.'}`);
        }
    }
    const takes = [];
    for (const episode of episodes) {
        if (chestEpisode && String(episode.at || '') <= String(chestEpisode.at || '')) continue;
        const match = String(episode.text || '').match(/Successfully took (\d+) ([a-z0-9_]+)/i);
        if (match) takes.push(`${match[1]} ${match[2].replace(/_/g, ' ')}`);
    }
    if (takes.length) lines.push(`Verified removals from a chest after that look: ${takes.join('; ')}.`);
    for (const episode of episodes) {
        const delta = inventoryDelta(episode?.text || '');
        if (!delta) continue;
        if (hands.some(item => item === delta || item.includes(delta) || delta.includes(item))) continue;
        hands.push(delta);
    }
    if (hands.length) {
        lines.push(`Latest recorded hand counts, from older action results, not a complete inventory: ${hands.slice(-3).join(' | ')}.`);
    }
    if (inventory && typeof inventory === 'object') {
        const holding = Object.entries(inventory)
            .filter(([, count]) => Number(count) > 0)
            .map(([name, count]) => `${count} ${name.replace(/_/g, ' ')}`);
        lines.push(`Currently holding, counted just now: ${holding.length ? holding.join(', ') : 'nothing'}. This count is the live inventory. The older hand notes are history.`);
    }
    if (lines.length === 1) lines.push('No container inspection or hand count is recorded.');
    return lines;
}

const HEARD_NOISE = /from other bot|auto-generated|you have restarted|picking up item|fighting zombie|fighting skeleton|i'?m stuck|i am stuck|i'?m free|see you there|hello world/i;

function invitationOf(said) {
    const text = said.toLowerCase();
    if (/bread|seed|chest|furnace|nell|log|water|sleep|die|help|food|apple|beef/.test(text)) return '';
    if (/\bsquare\b/.test(text)) return 'square';
    if (/\bgarden\b/.test(text)) return 'garden';
    if (/\bwell\b/.test(text)) return 'well';
    return '';
}

function heardScore(said) {
    const text = said.toLowerCase();
    let score = 0;
    if (/bread|seed|chest|furnace|nell|log|water|sleep|die|help|food|apple|beef/.test(text)) score += 2;
    if (/\bsquare\b|\bgarden\b|\bwell\b|\bhome\b/.test(text)) score += 1;
    if (said.length > 80) score += 1;
    return score;
}

function heardLines(episodes, name) {
    const candidates = [];
    const seen = [];
    episodes.forEach((episode, index) => {
        if (episode?.kind !== 'conversation') return;
        const match = String(episode.text || '').match(/^(.*?)\s+said:\s*(.*)$/s);
        if (!match) return;
        const speaker = match[1].replace(/^\(to [^)]+\)\s*/i, '').trim();
        const said = clip(match[2], 180);
        if (!speaker || said.length < 24) return;
        if (speaker.toLowerCase() === String(name || '').toLowerCase()) return;
        if (speaker.toUpperCase() === 'ADMIN') return;
        if (HEARD_NOISE.test(said)) return;
        const invitation = invitationOf(said);
        if (invitation && seen.some(prior => prior.speaker === speaker && prior.invitation === invitation)) return;
        if (seen.some(prior => prior.speaker === speaker && similar(prior.said, said))) return;
        const line = { speaker, said, index, invitation };
        seen.push(line);
        candidates.push(line);
    });
    const bySpeaker = new Map();
    for (const line of candidates) {
        const bucket = bySpeaker.get(line.speaker) || [];
        bucket.push(line);
        bySpeaker.set(line.speaker, bucket);
    }
    const kept = [];
    for (const lines of bySpeaker.values()) {
        const ranked = [...lines].sort((a, b) => heardScore(b.said) - heardScore(a.said) || a.index - b.index).slice(0, 3);
        ranked.sort((a, b) => a.index - b.index);
        kept.push(...ranked);
    }
    kept.sort((a, b) => a.index - b.index);
    return kept.slice(0, 8);
}

function markerLines(episodes) {
    const names = [];
    const seen = new Set();
    for (const episode of episodes) {
        const quoted = String(episode?.text || '').match(/marker reading "([^"]+)"/i);
        const fromRefs = (episode?.refs || []).find(ref => ref && ref !== 'remains');
        const label = quoted?.[1] || (episode?.refs || []).includes('remains') && fromRefs || '';
        if (!label || seen.has(label)) continue;
        seen.add(label);
        names.push(label);
    }
    if (!names.length) return [];
    return [`You saw a marker reading ${names.map(label => `"${label}"`).join(' and ')}. Only the words on the marker are recorded.`];
}

function closedGoalLines(history) {
    const clusters = [];
    for (const item of history || []) {
        const text = clip(item?.text, 160);
        if (!text || text.length < 12 || /^note$/i.test(text)) continue;
        if (!['completed', 'abandoned', 'revised'].includes(item.status)) continue;
        const cluster = clusters.find(entry => similar(entry.text, text));
        if (cluster) {
            cluster.count += 1;
            if (item.status === 'completed') cluster.status = 'completed';
            continue;
        }
        clusters.push({ text, status: item.status, count: 1 });
    }
    return clusters.slice(-6).map(entry => {
        const times = entry.count > 1 ? `, closed ${entry.count} times` : '';
        return `${entry.status}${times}: ${entry.text}`;
    });
}

const SETBACK_NOISE = /no intention to close|noted that for yourself|vision is disabled|newaction|stayed for|not an assigned goal/i;

function setbackLines(episodes) {
    const kept = [];
    const seen = new Set();
    for (const episode of [...episodes].reverse()) {
        const text = String(episode?.text || '');
        if (!/attempt failed/i.test(text)) continue;
        if (SETBACK_NOISE.test(text)) continue;
        const body = text
            .replace(/^A meaningful attempt failed\.\s*/i, '')
            .replace(/^Action output:\s*/i, '')
            .replace(/\s*Verified outcome:.*$/i, '')
            .replace(/\s*Retrying this action is not reasonable.*$/i, '')
            .replace(/\s*Valid\s+\S*$/i, '')
            .trim();
        if (body.length < 28) continue;
        const key = body.toLowerCase().replace(/\d+/g, '#').slice(0, 100);
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(clip(body, 160));
        if (kept.length >= 3) break;
    }
    return kept.reverse();
}

/**
 * Shared factual notes. The caller adds the choice or the review question.
 * `inventory` is an optional live count. Omitted, the notes use stored observations only.
 */
export function milestoneNotes(dataRoot, { inventory } = {}) {
    const identity = identityOf(dataRoot);
    const episodes = existsSync(path.join(dataRoot, 'episodes.json'))
        ? (readEpisodes(dataRoot).episodes || [])
        : [];
    const knowledge = existsSync(path.join(dataRoot, 'knowledge.json')) ? readKnowledge(dataRoot) : null;
    const relationships = existsSync(path.join(dataRoot, 'relationships.json'))
        ? (readRelationships(dataRoot).relationships || {})
        : {};
    const history = existsSync(path.join(dataRoot, 'intentions.json'))
        ? (readIntentions(dataRoot).history || [])
        : [];
    const name = identity.name || 'yourself';
    const lines = [`You are ${name}.`];
    if (identity.temperament?.length) lines.push(`Temperament: ${clip(identity.temperament.join(' '), 400)}`);
    if (identity.interests?.length) lines.push(`Interests: ${clip(identity.interests.join(', '), 240)}`);
    const backstory = (identity.backstory || []).map(item => item?.text || item).filter(Boolean).join(' ');
    if (backstory) lines.push(`Who you are: ${clip(backstory, 1800)}`);
    if (existsSync(path.join(dataRoot, 'ambitions.json'))) {
        const ambition = activeAmbitionText(readAmbitions(dataRoot));
        if (ambition) lines.push(`Long-term ambition: ${clip(ambition, 400)}`);
    }
    lines.push(...placeLines(knowledge, episodes));
    lines.push(...resourceLines(dataRoot, episodes, inventory, knowledge));
    const people = [];
    for (const [id, relation] of Object.entries(relationships).slice(0, 6)) {
        const stance = relation?.stance ? `stance ${relation.stance}. ` : '';
        const note = relation?.note ? `"${clip(relation.note, 180)}"` : '';
        people.push(`Your own note on ${id}: ${stance}${note}`.trim());
    }
    const heard = heardLines(episodes, name);
    if (people.length || heard.length) {
        lines.push('People:');
        lines.push(...people);
        for (const line of heard) lines.push(`${line.speaker} said: ${line.said}`);
    }
    lines.push(...markerLines(episodes));
    const closed = closedGoalLines(history);
    if (closed.length) {
        lines.push('Goals you have already closed:');
        for (const line of closed) lines.push(line);
    }
    const setbacks = setbackLines(episodes);
    if (setbacks.length) {
        lines.push('Setbacks already on record:');
        for (const line of setbacks) lines.push(line);
    }
    lines.push('Repeated announcements of your own, duplicate invitations, and repeated failed attempts are omitted here. Their history is unchanged.');
    return lines.join('\n');
}
