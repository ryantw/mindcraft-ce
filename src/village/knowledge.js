import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import settings from '../agent/settings.js';
import { chestStacks } from './blueprint.js';

const SUPPLIES_NOTE = 'These items were placed in your chest at admission. They are a memory of that moment, not a live inventory. Inspect the chest before treating any of them as still present.';

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Home fixtures, public places, and the admission-time supply list.
 * Built from the scenario manifest. It does not read a live chest.
 */
export function buildKnowledge(village, inhabitantId, { plotId = null } = {}) {
    const plots = village?.plots || [];
    const plot = plots.find(item => item.id === plotId)
        || plots.find(item => item.occupant === inhabitantId)
        || null;
    const index = plot ? plots.findIndex(item => item.id === plot.id) : -1;
    const home = plot ? {
        plot_id: plot.id,
        home_marker: plot.home_marker,
        bed: plot.bed,
        chest: plot.chest,
        door: plot.door,
        crafting_table: plot.crafting_table,
        furnace: plot.furnace,
    } : null;
    const supplies = plot
        ? chestStacks({ ...plot, occupant: inhabitantId }, village.provisions, index)
        : [];
    const publicPlaces = (village?.public || []).map(place => ({
        id: place.id,
        marker: place.marker,
    }));
    return {
        schema_version: 1,
        home,
        public_places: publicPlaces,
        supplies_at_admission: supplies.map(stack => ({ item: stack.item, count: stack.count })),
        supplies_note: plot
            ? SUPPLIES_NOTE
            : 'No private chest was assigned. What you are carrying was given once. Beds and chests you find are shared.',
    };
}

export function knowledgePath(dataRoot) {
    return path.join(dataRoot, 'knowledge.json');
}

export function readKnowledge(dataRoot) {
    const file = knowledgePath(dataRoot);
    if (!existsSync(file)) return null;
    return readJson(file);
}

/** Write once. A later restart must not refresh the remembered supply list. */
export function ensureStartingKnowledge(dataRoot, village, inhabitantId, plotId = null) {
    const file = knowledgePath(dataRoot);
    if (existsSync(file)) return readJson(file);
    const knowledge = buildKnowledge(village, inhabitantId, { plotId });
    writeFileSync(file, JSON.stringify(knowledge, null, 2));
    return knowledge;
}

export function loadVillagePlaces(memoryBank) {
    if (settings.village_autonomy !== true || !settings.agent_data_root || !memoryBank?.bindPlaceFile) return;
    const knowledge = readKnowledge(settings.agent_data_root);
    memoryBank.bindPlaceFile(
        path.join(settings.agent_data_root, 'places.json'),
        placesFromKnowledge(knowledge),
    );
}

export function placesFromKnowledge(knowledge) {
    const places = {};
    const home = knowledge?.home;
    if (home) {
        places.home = home.home_marker;
        places.bed = home.bed;
        places.chest = home.chest;
        places.entrance = home.door;
        places.crafting_table = home.crafting_table;
        places.furnace = home.furnace;
    }
    for (const place of knowledge?.public_places || []) {
        if (place?.id && Array.isArray(place.marker)) places[place.id] = place.marker;
    }
    return places;
}

/**
 * Latest container inspection overrides the admission list in the prompt.
 * The admission list stays in the file either way.
 */
export function suppliesGuidance(knowledge, episodes = [], liveChest = undefined) {
    const remembered = (knowledge?.supplies_at_admission || [])
        .map(stack => `${stack.item} x${stack.count}`)
        .join(', ') || 'nothing recorded';
    const historical = `At admission your chest held ${remembered}. ${knowledge?.supplies_note || SUPPLIES_NOTE}`;
    if (liveChest) {
        const now = liveChest.length
            ? liveChest.map(stack => `${stack.item} x${stack.count}`).join(', ')
            : 'nothing';
        return `${historical} You have since looked inside. The chest contained ${now}. Trust that inspection, and a newer look, over the admission list.`;
    }
    const inspection = [...(episodes || [])].reverse().find(episode => episode.refs?.includes('container'));
    if (inspection) {
        return `${historical} A later inspection is recorded: ${inspection.text} Trust the inspection over the admission list.`;
    }
    return historical;
}
