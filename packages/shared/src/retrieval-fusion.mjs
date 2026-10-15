export function boundedRetrievalFusion(channels, options = {}) {
    const constant = Number.isFinite(options.constant) ? Math.max(1, options.constant) : 60;
    const perChannel = Number.isFinite(options.perChannel) ? Math.max(1, Math.min(50, Math.trunc(options.perChannel))) : 50;
    const candidateLimit = Number.isFinite(options.candidateLimit) ? Math.max(1, Math.min(50, Math.trunc(options.candidateLimit))) : 50;
    const scores = new Map();
    const units = new Map();
    const lists = channels.slice(0, 16).map((channel) => {
        const seen = new Set();
        const hits = channel.hits.filter((hit) => {
            if (!hit.sourceId || seen.has(hit.sourceId))
                return false;
            seen.add(hit.sourceId);
            return true;
        }).slice(0, perChannel);
        const weight = Number.isFinite(channel.weight) ? Math.max(0, channel.weight) : 1;
        if (weight <= 0)
            return { name: channel.name, hits: [] };
        hits.forEach((hit, rank) => {
            const contribution = weight / (constant + rank + 1);
            scores.set(hit.sourceId, (scores.get(hit.sourceId) ?? 0) + contribution);
            units.set(hit.id, (units.get(hit.id) ?? 0) + contribution);
        });
        return { name: channel.name, hits };
    });
    // Reserve one already eligible, strong semantic candidate before truncation.
    // Similarity is provider evidence, not an authority or task-success assertion.
    const protectedIds = lists.filter((channel) => channel.name === "semantic")
        .flatMap((channel) => channel.hits.filter((hit) => Number.isFinite(hit.score) && hit.score >= 0.7).slice(0, 1))
        .map((hit) => hit.sourceId).slice(0, 1);
    const candidates = new Set(protectedIds);
    // Interleave distinct parents: one verbose source cannot consume a channel.
    for (let rank = 0; rank < perChannel && candidates.size < candidateLimit; rank++) {
        for (const channel of lists) {
            const hit = channel.hits[rank];
            if (hit)
                candidates.add(hit.sourceId);
            if (candidates.size >= candidateLimit)
                break;
        }
    }
    const candidateIds = [...candidates].sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left.localeCompare(right));
    return { scores, unitScores: units, candidateIds, protectedIds };
}
