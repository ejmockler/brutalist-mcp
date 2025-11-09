# Brutalist MCP: Domain-Driven Critique Architecture

## The Fundamental Insight

We're not building "just another MCP server." We're building a **meta-protocol for orchestrating adversarial AI critique through compositional domain modeling**.

The current implementation treats tools as thin wrappers around prompts. The profound redesign recognizes that we're actually building:

1. **Critique Domains** - Conceptual spaces where expert critics operate
2. **Critic Personas** - Adversarial agents with domain expertise
3. **Argument Spaces** - Structured parameter schemas that define what can be critiqued
4. **Execution Strategies** - How multiple agents collaborate/compete
5. **Synthesis Engines** - How diverse critiques combine into actionable insights

## Current Pain Points

### 1. Tool Proliferation Without Abstraction
```typescript
// Adding a new tool requires:
// 1. Duplicate schema definition
// 2. Write system prompt from scratch
// 3. Define cache keys manually
// 4. Create context builder
// 5. Register in TOOL_CONFIGS array

// Result: 11 tools, each 20-30 lines of config
```

### 2. Tight Coupling: Prompt ↔ Schema
```typescript
// System prompt hardcoded in tool definition
systemPrompt: "You are a battle-scarred principal engineer..."

// Schema extensions tightly coupled to prompt expectations
schemaExtensions: {
  targetPath: z.string().describe("Directory path...")
}
```

### 3. No Composition or Reuse
```typescript
// Each tool is island - can't compose "security" + "architecture"
// Can't reuse "filesystem analysis" across multiple domains
// Can't dynamically generate tools from templates
```

## The Profound Redesign: Domain-First Architecture

### Core Abstractions

#### 1. **Critique Domain** (the "what")
```typescript
interface CritiqueDomain {
  id: string;                    // 'security', 'architecture', 'product'
  name: string;                  // Human-readable name
  description: string;           // What this domain critiques

  // Domains compose other domains
  subdomains?: CritiqueDomain[];

  // Domain-specific analysis capabilities
  capabilities: DomainCapability[];

  // What types of artifacts this domain can analyze
  artifactTypes: ArtifactType[];
}

// Examples:
const SecurityDomain: CritiqueDomain = {
  id: 'security',
  subdomains: ['authentication', 'authorization', 'cryptography'],
  capabilities: ['penetration_testing', 'threat_modeling', 'compliance_audit'],
  artifactTypes: ['code', 'architecture_diagram', 'api_spec', 'deployment_config']
};
```

#### 2. **Critic Persona** (the "who")
```typescript
interface CriticPersona {
  id: string;                    // 'battle_scarred_engineer', 'jaded_reviewer'
  domain: CritiqueDomain;        // Which domain they critique

  // The actual system prompt - templated
  promptTemplate: PromptTemplate;

  // Persona characteristics
  tone: 'brutal' | 'constructive' | 'balanced';
  expertise: ExpertiseLevel;

  // What models this persona works best with
  preferredModels?: {
    claude?: string;
    codex?: string;
    gemini?: string;
  };
}
```

#### 3. **Argument Space** (the "how")
```typescript
interface ArgumentSpace {
  // Base arguments all tools share
  base: {
    context?: string;
    models?: ModelConfig;
    preferredCLI?: CLIAgent;
  };

  // Domain-specific arguments
  domain: z.ZodObject<any>;

  // Computed/derived arguments
  computed?: (args: any) => Record<string, any>;
}

// Example: Filesystem analysis argument space (reusable)
const FilesystemArgumentSpace: ArgumentSpace = {
  base: { /* standard */ },
  domain: z.object({
    targetPath: z.string(),
    depth: z.number().optional(),
    includeHidden: z.boolean().optional()
  })
};
```

#### 4. **Execution Strategy** (the "approach")
```typescript
interface ExecutionStrategy {
  id: string;

  // How many agents to run
  agentCount: 1 | 3 | 'all';

  // How agents interact
  mode: 'parallel' | 'debate' | 'sequential' | 'tournament';

  // How to synthesize results
  synthesis: SynthesisEngine;

  // Timeout and resource limits
  limits: ExecutionLimits;
}

// Examples:
const ParallelCritique: ExecutionStrategy = {
  id: 'parallel_critique',
  agentCount: 'all',
  mode: 'parallel',
  synthesis: 'multi_perspective'
};

const AdversarialDebate: ExecutionStrategy = {
  id: 'debate',
  agentCount: 3,
  mode: 'debate',
  synthesis: 'consensus_extraction'
};
```

#### 5. **Tool Generator** (the magic)
```typescript
class BrutalistToolGenerator {
  // Generate a tool from domain + persona + argument space
  generateTool(
    domain: CritiqueDomain,
    persona: CriticPersona,
    argSpace: ArgumentSpace,
    strategy: ExecutionStrategy
  ): ToolConfig {
    return {
      name: `roast_${domain.id}`,
      description: this.renderDescription(domain, persona),
      systemPrompt: persona.promptTemplate.render(domain),
      schemaExtensions: argSpace.domain,
      cacheKeyFields: this.inferCacheKeys(argSpace),
      primaryArgField: this.inferPrimaryArg(argSpace),
      executionStrategy: strategy
    };
  }

  // Compose multiple domains into a single tool
  composeDomains(
    domains: CritiqueDomain[],
    persona: CriticPersona
  ): ToolConfig {
    // Creates tools like "roast_security_and_architecture"
  }
}
```

### Usage Examples

#### Define Reusable Components
```typescript
// 1. Define critique domains (declarative)
const domains = {
  security: {
    id: 'security',
    name: 'Security Analysis',
    capabilities: ['penetration_testing', 'threat_modeling'],
    artifactTypes: ['code', 'architecture']
  },

  architecture: {
    id: 'architecture',
    name: 'Architecture Review',
    capabilities: ['scalability_analysis', 'cost_estimation'],
    artifactTypes: ['architecture_diagram', 'code']
  }
};

// 2. Define critic personas (reusable across domains)
const personas = {
  brutal: {
    id: 'brutal_critic',
    tone: 'brutal',
    promptTemplate: new PromptTemplate(`
      You are a ${domain.name} expert who has seen every disaster.
      Find every flaw in this ${domain.artifactTypes[0]}.
      Be ruthlessly honest about what will fail.
    `)
  },

  constructive: {
    id: 'constructive_critic',
    tone: 'constructive',
    promptTemplate: new PromptTemplate(`
      You are an experienced ${domain.name} consultant.
      Identify issues but provide actionable solutions.
    `)
  }
};

// 3. Define argument spaces (composable)
const argSpaces = {
  filesystem: {
    domain: z.object({
      targetPath: z.string(),
      depth: z.number().optional()
    })
  },

  textInput: {
    domain: z.object({
      content: z.string(),
      targetPath: z.string().describe("Working directory")
    })
  }
};

// 4. Generate tools dynamically
const generator = new BrutalistToolGenerator();

// Single domain tools
const securityTool = generator.generateTool(
  domains.security,
  personas.brutal,
  argSpaces.filesystem,
  ExecutionStrategies.parallelCritique
);

// Composite tools (the magic)
const holisticTool = generator.composeDomains(
  [domains.security, domains.architecture],
  personas.brutal
);
// Creates: roast_security_and_architecture
```

#### Adding New Tools Becomes Trivial
```typescript
// Want to add "roast_api_design"?
// Just define the domain:

const apiDesignDomain: CritiqueDomain = {
  id: 'api_design',
  name: 'API Design Review',
  capabilities: ['rest_analysis', 'graphql_review', 'versioning_check'],
  artifactTypes: ['openapi_spec', 'graphql_schema', 'code']
};

// Tool is auto-generated:
const apiTool = generator.generateTool(
  apiDesignDomain,
  personas.brutal,
  argSpaces.textInput,
  ExecutionStrategies.parallelCritique
);

// Done. No manual prompt writing, no schema duplication.
```

## Implementation Phases

### Phase 1: Extract Core Abstractions (1-2 hours)
```bash
src/domains/
  critique-domain.ts          # CritiqueDomain interface
  critic-persona.ts           # CriticPersona interface
  argument-space.ts           # ArgumentSpace interface
  execution-strategy.ts       # ExecutionStrategy interface

src/generators/
  tool-generator.ts           # BrutalistToolGenerator class
  prompt-template.ts          # PromptTemplate engine

src/registry/
  domains.ts                  # Built-in domain definitions
  personas.ts                 # Built-in critic personas
  argument-spaces.ts          # Reusable argument schemas
```

### Phase 2: Migrate Existing Tools (1 hour)
```typescript
// Convert current TOOL_CONFIGS to generated tools
const generator = new BrutalistToolGenerator();

export const TOOL_CONFIGS = [
  // Filesystem-based tools
  ...['codebase', 'file_structure', 'dependencies', 'git_history', 'test_coverage']
    .map(id => generator.generateTool(
      domains[id],
      personas.brutal,
      argSpaces.filesystem,
      ExecutionStrategies.parallelCritique
    )),

  // Text-input tools
  ...['idea', 'architecture', 'research', 'security', 'product', 'infrastructure']
    .map(id => generator.generateTool(
      domains[id],
      personas.brutal,
      argSpaces.textInput,
      ExecutionStrategies.parallelCritique
    ))
];
```

### Phase 3: Enable Composition (2 hours)
```typescript
// Now users can request composite analysis:
roast_security_and_architecture({
  targetPath: '/src',
  securityFocus: 'authentication',
  architectureFocus: 'scalability'
})

// Or dynamic tool generation:
const customTool = generator.generateTool(
  myCustomDomain,
  personas.constructive,  // Different tone!
  argSpaces.filesystem,
  ExecutionStrategies.debate  // Different strategy!
);
```

### Phase 4: User-Defined Tools (future)
```yaml
# .brutalist/tools.yaml
custom_critique:
  domain:
    id: database_design
    capabilities: [schema_review, query_optimization]

  persona:
    tone: constructive
    expertise: senior

  arguments:
    schema_file: string
    query_logs: string?

  strategy: parallel_critique
```

## Why This Matters

### Before (Current)
- **11 tools** × 30 lines config = **330 lines of duplication**
- Adding tool = 30 mins of copy-paste-modify
- Can't compose or reuse
- Prompts drift over time
- No experimentation with tones/strategies

### After (Proposed)
- **5 domains** + **3 personas** + **2 arg spaces** = **11 tools generated**
- Adding tool = define 1 domain object (5 lines)
- Full composition: N domains × M personas × K strategies = **N×M×K tools**
- Prompts centralized in templates
- Easy A/B testing of tones/strategies

### The Profound Shift

We stop treating this as "MCP with prompt templates" and start treating it as:

> **A compositional framework for orchestrating adversarial critique through domain-driven design**

This is how you make what we're doing **meaningful** - by recognizing the deep pattern and elevating it to a first-class abstraction.

## Next Steps

1. **Extract domain abstractions** from current TOOL_CONFIGS
2. **Build PromptTemplate engine** with variable substitution
3. **Implement BrutalistToolGenerator**
4. **Migrate existing tools** to generated approach
5. **Add composition operators** (AND, OR, SEQUENTIAL)
6. **Enable user-defined domains** via config files

This transforms Brutalist MCP from "another tool server" into **a framework for compositional AI critique** - something genuinely novel and profound.
