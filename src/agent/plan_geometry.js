import Vec3 from 'vec3';
import { expandBuildRequest } from './library/construction.js';
import { normalizeMaterials } from './plan_resources.js';

const BUILD_SPECS = Object.freeze({
    placeBlockAt: { kind: 'block', coords: ['x', 'y', 'z'] },
    buildLine: { kind: 'line', coords: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'] },
    buildPlane: { kind: 'plane', coords: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'] },
});

const SHELTER_OBJECTIVE = /\b(shelter|house|hut|cabin|home|bunker|enclosure|building)\b/i;
const ROLE_PATTERNS = [
    ['opening', /\b(doors?|doorways?|entrances?|entry|exits?|openings?)\b/i],
    ['roof', /\b(roofs?|ceilings?|overhead)\b/i],
    ['floor', /\b(floors?|bases?|foundations?|platforms?)\b/i],
    ['wall', /\b(walls?|enclos\w*|barriers?|sides?)\b/i],
];

const positionKey = ({ x, y, z }) => `${x},${y},${z}`;

function roleFor(step) {
    // IDs tend to be less verbose and more precise than generated prose. This
    // also prevents a roof step whose description says "build a wall/roof"
    // from being classified as a wall.
    const id = String(step?.id || '').replace(/[_-]+/g, ' ');
    for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(id)) return role;
    const description = String(step?.description || '');
    for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(description)) return role;
    return null;
}

function bounds(positions) {
    const axis = name => positions.map(position => position[name]);
    const xs = axis('x');
    const ys = axis('y');
    const zs = axis('z');
    return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
        minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
}

function spans(component) {
    const b = bounds(component.positions);
    return { x: b.maxX - b.minX + 1, y: b.maxY - b.minY + 1, z: b.maxZ - b.minZ + 1 };
}

function unionPositions(components) {
    const map = new Map();
    for (const component of components) {
        for (const position of component.positions) map.set(positionKey(position), position);
    }
    return [...map.values()];
}

function sameSet(left, right) {
    if (left.positions.length !== right.positions.length) return false;
    const keys = new Set(left.positions.map(positionKey));
    return right.positions.every(position => keys.has(positionKey(position)));
}

function fullyContained(small, large) {
    const keys = new Set(large.positions.map(positionKey));
    return small.positions.every(position => keys.has(positionKey(position)));
}

function isFunctionallyEnclosed(components) {
    const solids = new Set(components.flatMap(component => component.positions.map(positionKey)));
    const all = unionPositions(components);
    if (!all.length) return false;
    const b = bounds(all);
    if (b.maxX === b.minX || b.maxZ === b.minZ || b.maxY - b.minY < 2) return false;

    // Search for standing space with a roof above it. Then flood-fill at feet
    // and head height. If the fill cannot escape the structure's horizontal
    // bounds, the geometry contains a usable enclosed interior. This works for
    // rectangular and irregular designs and does not prescribe a house shape.
    for (let y = b.minY; y < b.maxY; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
            for (let z = b.minZ; z <= b.maxZ; z++) {
                const open = level => !solids.has(`${x},${level},${z}`);
                if (!open(y) || !open(y + 1)) continue;
                let covered = false;
                for (let roofY = y + 2; roofY <= b.maxY; roofY++) {
                    if (solids.has(`${x},${roofY},${z}`)) { covered = true; break; }
                }
                if (!covered) continue;

                const queue = [{ x, z }];
                const visited = new Set([`${x},${z}`]);
                let escaped = false;
                while (queue.length && visited.size <= 4096) {
                    const current = queue.shift();
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const nx = current.x + dx;
                        const nz = current.z + dz;
                        if (nx < b.minX || nx > b.maxX || nz < b.minZ || nz > b.maxZ) {
                            escaped = true;
                            continue;
                        }
                        const key = `${nx},${nz}`;
                        if (visited.has(key) || solids.has(`${nx},${y},${nz}`) || solids.has(`${nx},${y + 1},${nz}`)) continue;
                        visited.add(key);
                        queue.push({ x: nx, z: nz });
                    }
                }
                if (!escaped) return true;
            }
        }
    }
    return false;
}

function worldSatisfied(agent, type, position) {
    try {
        return agent?.bot?.blockAt?.(new Vec3(position.x, position.y, position.z))?.name === type;
    } catch (_error) {
        return false;
    }
}

/**
 * Expand build commands once and use the resulting voxels for both semantic
 * validation and resource calculation. The LLM's material estimates are not
 * authoritative for construction blocks.
 */
export function analyzeConstruction(agent, proposal) {
    const steps = Array.isArray(proposal?.steps) ? proposal.steps : [];
    const problems = [];
    const components = [];
    const stepRequirements = new Map();
    const buildTypes = new Set();

    steps.forEach((step, index) => {
        const name = String(step?.action?.name || '').replace(/^!/, '');
        const spec = BUILD_SPECS[name];
        if (!spec) return;
        const params = step?.action?.params || {};
        const coords = spec.coords.map(coordinate => params[coordinate]);
        if (typeof params.type !== 'string' || coords.some(value => typeof value !== 'number' || !Number.isFinite(value))) return;
        const expanded = expandBuildRequest(spec.kind, params.type, coords);
        if (!expanded.ok) return; // The feasibility layer reports command errors.
        buildTypes.add(params.type);
        components.push({
            index,
            id: String(step?.id || index + 1),
            name,
            type: params.type,
            role: roleFor(step),
            positions: expanded.positions,
        });
    });

    const floor = unionPositions(components.filter(component => component.role === 'floor'));
    if (floor.length) {
        const span = spans({ positions: floor });
        if (span.y !== 1 || span.x < 2 || span.z < 2)
            problems.push('Floor/base geometry must form a horizontal area spanning both x and z; a point or one-block-wide line is not a functional floor.');
    }
    const roof = unionPositions(components.filter(component => component.role === 'roof'));
    if (roof.length) {
        const span = spans({ positions: roof });
        if (span.y !== 1 || span.x < 2 || span.z < 2)
            problems.push('Roof geometry must form a horizontal overhead area spanning both x and z; a point or line is not a functional roof.');
    }
    const walls = unionPositions(components.filter(component => component.role === 'wall'));
    if (walls.length) {
        const span = spans({ positions: walls });
        if (span.y < 2 || (span.x < 2 && span.z < 2))
            problems.push('Wall geometry must form a vertical area with both height and horizontal extent; a point or horizontal line is not a functional wall.');
    }
    for (const component of components.filter(component => component.role === 'opening')) {
        if (component.name === 'placeBlockAt' && !/_door$/.test(component.type))
            problems.push(`step ${component.id} describes a door/opening but places solid ${component.type}; an opening must remain passable or place an actual door block.`);
    }

    for (let i = 0; i < components.length; i++) {
        for (let j = i + 1; j < components.length; j++) {
            const left = components[i];
            const right = components[j];
            const leftKeys = new Set(left.positions.map(positionKey));
            const overlap = right.positions.filter(position => leftKeys.has(positionKey(position)));
            if (!overlap.length) continue;
            if (left.type !== right.type) {
                problems.push(`steps ${left.id} and ${right.id} request different blocks at the same coordinate.`);
                continue;
            }
            // Shared wall corners and roof/wall edge lines are useful. A
            // one-block component cannot masquerade as another role, and a
            // floor and roof cannot occupy the same complete geometry.
            const pointContained = Math.min(left.positions.length, right.positions.length) === 1 &&
                (fullyContained(left, right) || fullyContained(right, left));
            const floorAndRoof = new Set([left.role, right.role]);
            const incompatibleDuplicate = sameSet(left, right) &&
                (left.positions.length === 1 || (floorAndRoof.has('floor') && floorAndRoof.has('roof')));
            if (left.role && right.role && left.role !== right.role && (incompatibleDuplicate || pointContained)) {
                problems.push(`steps ${left.id} (${left.role}) and ${right.id} (${right.role}) reuse the same geometry instead of providing distinct structural components.`);
            }
        }
    }

    if (SHELTER_OBJECTIVE.test(String(proposal?.objective || '')) && components.length && !isFunctionallyEnclosed(components)) {
        problems.push('The proposed blocks do not form a functional shelter with enclosed standing space and overhead cover. Successful commands alone cannot satisfy a shelter objective.');
    }

    const claimed = new Map();
    const materialCounts = new Map();
    for (const component of components) {
        let remainingForStep = 0;
        for (const position of component.positions) {
            const key = positionKey(position);
            const previousType = claimed.get(key);
            if (previousType) continue; // overlaps are counted once globally
            claimed.set(key, component.type);
            if (worldSatisfied(agent, component.type, position)) continue;
            remainingForStep++;
            materialCounts.set(component.type, (materialCounts.get(component.type) || 0) + 1);
        }
        stepRequirements.set(component.index, remainingForStep > 0
            ? [{ item: component.type, count: remainingForStep }]
            : []);
    }

    return {
        problems,
        components,
        buildTypes,
        stepRequirements,
        materials: [...materialCounts].map(([item, count]) => ({ item, count })),
    };
}

/** Replace model-estimated construction totals with observed voxel deficits. */
export function effectivePlanMaterials(agent, proposal, analysis=analyzeConstruction(agent, proposal)) {
    const nonConstruction = normalizeMaterials(proposal?.materials)
        .filter(entry => !analysis.buildTypes.has(entry.item));
    return normalizeMaterials([...nonConstruction, ...analysis.materials]);
}

