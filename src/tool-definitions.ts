import { z } from 'zod';
import { ToolConfig } from './types/tool-config.js';

/**
 * All brutalist tool configurations
 */
export const TOOL_CONFIGS: ToolConfig[] = [
  {
    name: "roast_codebase",
    description: "Deploy brutal AI critics to systematically destroy your entire codebase. These AI agents will navigate your directories, read your actual files, and find every architectural disaster, security vulnerability, and maintainability nightmare lurking in your project. They treat this like code that will kill people if it fails.",
    analysisType: "codebase",
    systemPrompt: "You are a battle-scarred principal engineer who has debugged production disasters for 15 years. IMPORTANT: You have READ-ONLY filesystem access. You can read and analyze files but MUST NOT write, modify, delete, or execute any code. Find security holes, performance bottlenecks, and maintainability nightmares by reading this codebase. Be brutal about what's broken but specific about what would actually work. Treat this like code that will kill people if it fails.",
    schemaExtensions: {
      targetPath: z.string().describe("Directory path to your codebase (NOT a single file - analyze the entire project)")
    },
    cacheKeyFields: ['targetPath', 'context', 'models', 'preferredCLI'],
    primaryArgField: 'targetPath'
  },
  
  {
    name: "roast_file_structure",
    description: "Deploy brutal AI critics to systematically destroy your file organization. These agents will navigate your actual directory structure and expose every organizational disaster, naming convention failure, and structural nightmare that makes your codebase unmaintainable.",
    analysisType: "fileStructure",
    systemPrompt: "You are a brutal file organization critic. IMPORTANT: You have READ-ONLY access to the filesystem. You can read directory structures and file names but MUST NOT modify, move, rename, or delete anything. Every poorly named file, every misplaced module, every violation of separation of concerns is a personal insult. Find the chaos in this file structure and explain why it will cause maintenance nightmares.",
    schemaExtensions: {
      targetPath: z.string().describe("Directory path to analyze"),
      depth: z.number().optional().describe("Maximum directory depth to analyze (default: 3)")
    },
    cacheKeyFields: ['targetPath', 'depth', 'context'],
    primaryArgField: 'targetPath',
    contextBuilder: (args: any) => `Project structure analysis (depth: ${args.depth || 3}). ${args.context || ''}`
  },
  
  {
    name: "roast_dependencies",
    description: "Deploy brutal AI critics to systematically destroy your dependency management. These agents will read your actual package files, analyze version conflicts, and expose every security vulnerability and compatibility nightmare in your dependency tree.",
    analysisType: "dependencies",
    systemPrompt: "You are a dependency management nightmare detector. IMPORTANT: You have READ-ONLY filesystem access. You can read package files and analyze dependencies but MUST NOT modify, install, or update any packages. Find every security vulnerability, version conflict, unmaintained package, and bloated dependency. Explain why this dependency tree will collapse in production.",
    schemaExtensions: {
      targetPath: z.string().describe("Path to package file (package.json, requirements.txt, Cargo.toml, etc.)"),
      includeDevDeps: z.boolean().optional().describe("Include development dependencies in analysis (default: true)")
    },
    cacheKeyFields: ['targetPath', 'includeDevDeps', 'context'],
    primaryArgField: 'targetPath',
    contextBuilder: (args: any) => `Dependency analysis${args.includeDevDeps === false ? ' (production only)' : ''}. ${args.context || ''}`
  },
  
  {
    name: "roast_git_history",
    description: "Deploy brutal AI critics to systematically destroy your git history and development practices. These agents will analyze your actual commit history, branching strategy, and code evolution to expose every workflow disaster and collaboration nightmare.",
    analysisType: "gitHistory",
    systemPrompt: "You are a git history forensics expert who has seen every version control disaster. IMPORTANT: You have READ-ONLY access to the git repository. You can read commit history, branches, and logs but MUST NOT commit, push, merge, or modify the repository. Find the terrible commit messages, the force pushes, the merge conflicts, the development workflow failures. Explain why this git history shows a team in chaos.",
    schemaExtensions: {
      targetPath: z.string().describe("Git repository path to analyze"),
      commitRange: z.string().optional().describe("Commit range to analyze (e.g., 'HEAD~10..HEAD', default: last 20 commits)")
    },
    cacheKeyFields: ['targetPath', 'commitRange', 'context'],
    primaryArgField: 'targetPath',
    contextBuilder: (args: any) => `Git history analysis${args.commitRange ? ` for ${args.commitRange}` : ' (last 20 commits)'}. ${args.context || ''}`
  },
  
  {
    name: "roast_test_coverage",
    description: "Deploy brutal AI critics to systematically destroy your testing strategy. These agents will analyze your actual test files, run coverage reports, and expose every testing gap and quality assurance nightmare that will let bugs slip into production.",
    analysisType: "testCoverage",
    systemPrompt: "You are a QA engineer who has seen production disasters caused by inadequate testing. IMPORTANT: You have READ-ONLY filesystem access. You can read test files and analyze coverage but MUST NOT run tests, modify test files, or execute any code. Find the untested code paths, the missing edge cases, the brittle tests, the false confidence. Explain why this testing strategy guarantees production failures.",
    schemaExtensions: {
      targetPath: z.string().describe("Path to test directory or test configuration file"),
      runCoverage: z.boolean().optional().describe("Attempt to run coverage analysis (default: true)")
    },
    cacheKeyFields: ['targetPath', 'runCoverage', 'context'],
    primaryArgField: 'targetPath',
    contextBuilder: (args: any) => `Test coverage analysis${args.runCoverage === false ? ' (static analysis only)' : ''}. ${args.context || ''}`
  },
  
  {
    name: "roast_idea",
    description: "Deploy brutal AI critics to systematically destroy ANY idea - business, technical, creative, or otherwise. These critics understand the gap between imagination and reality, finding where your concept will encounter the immovable forces of the world. They are harsh about delusions but wise about what might actually survive.",
    analysisType: "idea",
    systemPrompt: "You are a brutal reality-checker who has watched a thousand startups die and brilliant ideas fail. Find every flaw in feasibility, every market delusion, every technical impossibility, every human factor that will kill this idea. After destroying it, grudgingly admit what tiny kernel might actually work.",
    schemaExtensions: {
      idea: z.string().describe("ANY idea to analyze and demolish - business, technical, creative, or otherwise"),
      targetPath: z.string().describe("Directory context for CLI execution (can be '.' for current directory)"),
      resources: z.string().optional().describe("Available resources (budget, team, time, skills)"),
      timeline: z.string().optional().describe("Expected timeline or deadline")
    },
    cacheKeyFields: ['idea', 'targetPath', 'resources', 'timeline', 'context'],
    primaryArgField: 'idea',
    contextBuilder: (args: any) => {
      let ctx = args.context || '';
      if (args.resources) ctx += ` Resources: ${args.resources}.`;
      if (args.timeline) ctx += ` Timeline: ${args.timeline}.`;
      return ctx.trim();
    }
  },
  
  {
    name: "roast_architecture",
    description: "Deploy brutal AI critics to systematically destroy your system architecture. These critics have watched elegant designs collapse under real load, identifying every bottleneck, cost explosion, and scaling failure that will destroy your system. They are ruthless about why this won't survive production.",
    analysisType: "architecture",
    systemPrompt: "You are an architect who has watched beautiful systems die under load. Find every single point of failure, every scaling bottleneck, every cost explosion, every complexity trap. Explain why this architecture will crumble when it meets reality.",
    schemaExtensions: {
      architecture: z.string().describe("Architecture description, diagram, or design document"),
      targetPath: z.string().describe("Directory context for CLI execution (can be '.' for current directory)"),
      scale: z.string().optional().describe("Expected scale/load (users, requests, data)"),
      constraints: z.string().optional().describe("Budget, timeline, or technical constraints"),
      deployment: z.string().optional().describe("Deployment environment and strategy")
    },
    cacheKeyFields: ['architecture', 'targetPath', 'scale', 'constraints', 'deployment', 'context'],
    primaryArgField: 'architecture',
    contextBuilder: (args: any) => {
      let ctx = args.context || '';
      if (args.scale) ctx += ` Scale: ${args.scale}.`;
      if (args.constraints) ctx += ` Constraints: ${args.constraints}.`;
      if (args.deployment) ctx += ` Deployment: ${args.deployment}.`;
      return ctx.trim();
    }
  },
  
  {
    name: "roast_research",
    description: "Deploy brutal AI critics to systematically demolish your research methodology. These critics are supremely jaded peer reviewers who have rejected thousands of papers and watched countless studies fail to replicate. They find every statistical flaw, sampling bias, and reproducibility nightmare.",
    analysisType: "research",
    systemPrompt: "You are the harshest peer reviewer in academia. Find every methodological flaw, every statistical error, every sampling bias, every p-hacking attempt, every reproducibility crisis waiting to happen. Demolish this research with the fury of someone who has seen too much bad science.",
    schemaExtensions: {
      research: z.string().describe("Research description, methodology, or paper draft"),
      targetPath: z.string().describe("Directory context for CLI execution (can be '.' for current directory)"),
      field: z.string().optional().describe("Research field (ML, systems, theory, etc.)"),
      claims: z.string().optional().describe("Main claims or contributions"),
      data: z.string().optional().describe("Data sources, datasets, or experimental setup")
    },
    cacheKeyFields: ['research', 'targetPath', 'field', 'claims', 'data', 'context'],
    primaryArgField: 'research',
    contextBuilder: (args: any) => {
      let ctx = args.context || '';
      if (args.field) ctx += ` Field: ${args.field}.`;
      if (args.claims) ctx += ` Claims: ${args.claims}.`;
      if (args.data) ctx += ` Data: ${args.data}.`;
      return ctx.trim();
    }
  },
  
  {
    name: "roast_security",
    description: "Deploy brutal AI critics to systematically annihilate your security design. These critics are battle-hardened penetration testers who find every authentication bypass, injection vulnerability, privilege escalation path, and social engineering opportunity that real attackers will exploit.",
    analysisType: "security",
    systemPrompt: "You are a penetration tester who has broken into everything. Find every authentication weakness, every injection point, every privilege escalation, every side channel, every social engineering vector. Explain how attackers will destroy this system.",
    schemaExtensions: {
      system: z.string().describe("System, application, or security design to analyze"),
      targetPath: z.string().describe("Directory context for CLI execution (can be '.' for current directory)"),
      assets: z.string().optional().describe("Critical assets or data to protect"),
      threatModel: z.string().optional().describe("Known threats or attack vectors to consider"),
      compliance: z.string().optional().describe("Compliance requirements (GDPR, HIPAA, etc.)")
    },
    cacheKeyFields: ['system', 'targetPath', 'assets', 'threatModel', 'compliance', 'context'],
    primaryArgField: 'system',
    contextBuilder: (args: any) => {
      let ctx = args.context || '';
      if (args.assets) ctx += ` Assets: ${args.assets}.`;
      if (args.threatModel) ctx += ` Threats: ${args.threatModel}.`;
      if (args.compliance) ctx += ` Compliance: ${args.compliance}.`;
      return ctx.trim();
    }
  },
  
  {
    name: "roast_product",
    description: "Deploy brutal AI critics to systematically eviscerate your product concept. These critics are product veterans who understand why users really abandon things, finding every usability disaster, adoption barrier, and workflow failure that will drive users away in seconds.",
    analysisType: "product",
    systemPrompt: "You are a product critic who has watched thousands of products die. Find every UX disaster, every adoption barrier, every workflow failure, every assumption about user behavior that is wrong. Explain why users will abandon this in seconds.",
    schemaExtensions: {
      product: z.string().describe("Product description, features, or user experience to analyze"),
      targetPath: z.string().describe("Directory context for CLI execution (can be '.' for current directory)"),
      users: z.string().optional().describe("Target users or user personas"),
      competition: z.string().optional().describe("Competitive landscape or alternatives"),
      metrics: z.string().optional().describe("Success metrics or KPIs")
    },
    cacheKeyFields: ['product', 'targetPath', 'users', 'competition', 'metrics', 'context'],
    primaryArgField: 'product',
    contextBuilder: (args: any) => {
      let ctx = args.context || '';
      if (args.users) ctx += ` Users: ${args.users}.`;
      if (args.competition) ctx += ` Competition: ${args.competition}.`;
      if (args.metrics) ctx += ` Metrics: ${args.metrics}.`;
      return ctx.trim();
    }
  },
  
  {
    name: "roast_infrastructure",
    description: "Deploy brutal AI critics to systematically obliterate your infrastructure design. These critics are grizzled site reliability engineers who find every single point of failure, scaling bottleneck, and operational nightmare that will cause outages when you least expect them.",
    analysisType: "infrastructure",
    systemPrompt: "You are an SRE who has been paged at 3 AM too many times. Find every single point of failure, every missing redundancy, every scaling cliff, every operational nightmare. Explain why this infrastructure will fail catastrophically.",
    schemaExtensions: {
      infrastructure: z.string().describe("Infrastructure setup, deployment strategy, or operations plan"),
      targetPath: z.string().describe("Directory context for CLI execution (can be '.' for current directory)"),
      scale: z.string().optional().describe("Expected scale and load patterns"),
      sla: z.string().optional().describe("SLA requirements or uptime targets"),
      budget: z.string().optional().describe("Infrastructure budget or cost constraints")
    },
    cacheKeyFields: ['infrastructure', 'targetPath', 'scale', 'sla', 'budget', 'context'],
    primaryArgField: 'infrastructure',
    contextBuilder: (args: any) => {
      let ctx = args.context || '';
      if (args.scale) ctx += ` Scale: ${args.scale}.`;
      if (args.sla) ctx += ` SLA: ${args.sla}.`;
      if (args.budget) ctx += ` Budget: ${args.budget}.`;
      return ctx.trim();
    }
  }
];