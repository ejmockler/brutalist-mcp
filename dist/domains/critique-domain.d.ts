/**
 * Core abstraction: CritiqueDomain
 *
 * Defines a conceptual space where expert critics operate.
 * Domains are composable - security + architecture = holistic review.
 */
export type ArtifactType = 'code' | 'architecture_diagram' | 'api_spec' | 'deployment_config' | 'test_suite' | 'documentation' | 'git_history' | 'package_manifest' | 'directory_structure' | 'text_description';
export type DomainCapability = 'static_analysis' | 'dynamic_analysis' | 'penetration_testing' | 'threat_modeling' | 'compliance_audit' | 'scalability_analysis' | 'cost_estimation' | 'usability_review' | 'performance_profiling' | 'security_scanning';
export interface CritiqueDomain {
    /** Unique identifier for this domain */
    id: string;
    /** Human-readable name */
    name: string;
    /** What this domain critiques */
    description: string;
    /** Domain-specific analysis capabilities */
    capabilities: DomainCapability[];
    /** What types of artifacts this domain can analyze */
    artifactTypes: ArtifactType[];
    /** Optional: This domain composes other domains */
    subdomains?: CritiqueDomain[];
    /** Optional: Domain-specific configuration */
    config?: Record<string, any>;
    /** Input type: 'filesystem' for path-based tools, 'content' for text-based tools */
    inputType: 'filesystem' | 'content';
    /** Required schema fields beyond the base (e.g., 'targetPath' or 'content') */
    requiredFields: string[];
    /** Optional domain-specific schema fields (e.g., 'depth', 'scale', 'timeline') */
    optionalFields: string[];
    /** Argument space ID from ARGUMENT_SPACES registry */
    argumentSpaceId: string;
    /** Maps to BrutalistPromptType for backwards compatibility */
    promptType: string;
    /** Keywords for intent-based filtering */
    keywords: string[];
}
/**
 * Helper to check if a domain can analyze a given artifact type
 */
export declare function canAnalyzeArtifact(domain: CritiqueDomain, artifactType: ArtifactType): boolean;
/**
 * Helper to compose multiple domains into a composite domain
 */
export declare function composeDomains(domains: CritiqueDomain[], compositeId: string, compositeName: string): CritiqueDomain;
//# sourceMappingURL=critique-domain.d.ts.map