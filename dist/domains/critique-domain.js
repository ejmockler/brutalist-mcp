/**
 * Core abstraction: CritiqueDomain
 *
 * Defines a conceptual space where expert critics operate.
 * Domains are composable - security + architecture = holistic review.
 */
/**
 * Helper to check if a domain can analyze a given artifact type
 */
export function canAnalyzeArtifact(domain, artifactType) {
    return domain.artifactTypes.includes(artifactType);
}
/**
 * Helper to compose multiple domains into a composite domain
 */
export function composeDomains(domains, compositeId, compositeName) {
    const allCapabilities = new Set();
    const allArtifactTypes = new Set();
    const allKeywords = new Set();
    for (const domain of domains) {
        domain.capabilities.forEach(cap => allCapabilities.add(cap));
        domain.artifactTypes.forEach(type => allArtifactTypes.add(type));
        domain.keywords.forEach(kw => allKeywords.add(kw));
    }
    // Composite domains inherit characteristics from first domain as default
    const firstDomain = domains[0];
    return {
        id: compositeId,
        name: compositeName,
        description: `Composite critique combining: ${domains.map(d => d.name).join(', ')}`,
        capabilities: Array.from(allCapabilities),
        artifactTypes: Array.from(allArtifactTypes),
        subdomains: domains,
        config: {
            composite: true,
            componentDomains: domains.map(d => d.id)
        },
        // Tool generation fields - inherit from first domain
        inputType: firstDomain.inputType,
        requiredFields: firstDomain.requiredFields,
        optionalFields: firstDomain.optionalFields,
        argumentSpaceId: firstDomain.argumentSpaceId,
        promptType: compositeId,
        keywords: Array.from(allKeywords)
    };
}
//# sourceMappingURL=critique-domain.js.map