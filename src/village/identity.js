import { createHash } from 'node:crypto';

const IDENTITY_FIELDS = ['id', 'name', 'profile_version', 'backstory', 'temperament', 'interests', 'seed_relationships'];

function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function identityMaterial(profile) {
    return {
        id: profile.id,
        name: profile.name,
        profile_version: profile.profile_version,
        backstory: profile.backstory,
        temperament: profile.temperament,
        interests: profile.interests || [],
        seed_relationships: profile.seed_relationships || [],
    };
}

/** SHA-256 of the canonical identity fields. Arrays keep file order; object keys are sorted. */
export function profileChecksum(profile) {
    const material = identityMaterial(profile);
    for (const field of IDENTITY_FIELDS) {
        if (!(field in material)) throw new Error(`Identity field ${field} is missing.`);
    }
    return createHash('sha256').update(canonicalize(material), 'utf8').digest('hex');
}
