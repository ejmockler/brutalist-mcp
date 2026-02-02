#!/usr/bin/env node
/**
 * Intent-Based Tool Discovery Examples
 *
 * Demonstrates how to use brutalist_discover to find relevant tools
 * based on natural language intent.
 */

// Example intents and their expected top matches
const examples = [
  {
    intent: "review security of my authentication system",
    expected: ["roast_security", "roast_codebase", "roast_architecture"]
  },
  {
    intent: "check code quality and maintainability",
    expected: ["roast_codebase", "roast_test_coverage", "roast_file_structure"]
  },
  {
    intent: "analyze npm dependencies for vulnerabilities",
    expected: ["roast_dependencies", "roast_security", "roast_codebase"]
  },
  {
    intent: "review testing strategy and coverage",
    expected: ["roast_test_coverage", "roast_codebase", "roast_dependencies"]
  },
  {
    intent: "evaluate system architecture and scalability",
    expected: ["roast_architecture", "roast_infrastructure", "roast_security"]
  },
  {
    intent: "check devops setup and cloud infrastructure",
    expected: ["roast_infrastructure", "roast_architecture", "roast_security"]
  },
  {
    intent: "validate startup idea feasibility",
    expected: ["roast_idea", "roast_product", "roast_research"]
  },
  {
    intent: "review git workflow and commit history",
    expected: ["roast_git_history", "roast_codebase", "roast_file_structure"]
  },
  {
    intent: "analyze file and directory organization",
    expected: ["roast_file_structure", "roast_codebase", "roast_architecture"]
  },
  {
    intent: "critique ux design and user experience",
    expected: ["roast_product", "roast_idea", "roast_architecture"]
  },
  {
    intent: "review academic research methodology",
    expected: ["roast_research", "roast_idea", "roast_product"]
  }
];

/**
 * Simulates calling brutalist_discover and shows results
 */
async function demonstrateDiscovery(intent, expectedTools) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Intent: "${intent}"`);
  console.log(`${'='.repeat(80)}`);

  // In a real MCP client, you would call:
  // const result = await client.callTool('brutalist_discover', { intent });

  console.log(`\n✅ Expected top matches:`);
  expectedTools.forEach((tool, index) => {
    console.log(`   ${index + 1}. ${tool}`);
  });

  console.log(`\n💡 How to use the recommended tool:`);
  const topTool = expectedTools[0];
  const domainId = topTool.replace('roast_', '');

  console.log(`\n   Option 1: Use specific tool`);
  console.log(`   ${topTool}({ targetPath: "/path/to/analyze" })`);

  console.log(`\n   Option 2: Use unified roast tool`);
  console.log(`   roast({ domain: "${domainId}", target: "/path/to/analyze" })`);
}

/**
 * Main demonstration
 */
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                                                                            ║
║              BRUTALIST MCP: INTENT-BASED TOOL DISCOVERY                    ║
║                                                                            ║
║  Find the perfect tool for your analysis using natural language            ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝
`);

  for (const example of examples) {
    await demonstrateDiscovery(example.intent, example.expected);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`\n📚 Key Insights:`);
  console.log(`
   1. Use natural, conversational language for best results
   2. More specific intents yield more targeted recommendations
   3. The tool router returns top 3 most relevant tools
   4. Keywords like "security", "code", "test", "architecture" are weighted
   5. If no matches found, all tools are returned as fallback
`);

  console.log(`\n🔍 How the Scoring Works:`);
  console.log(`
   • Strong Match (+2 points): Intent keyword matches domain keyword list
   • Weak Match (+1 point): Intent keyword found in domain name/description
   • Top 3 highest-scoring domains are returned
   • Ties are broken by domain registration order
`);

  console.log(`\n📖 Domain Keywords Reference:`);
  console.log(`
   • codebase        → code, codebase, review, audit, quality
   • file_structure  → files, structure, organization, directory
   • dependencies    → dependencies, packages, npm, security, versions
   • git_history     → git, commits, history, workflow
   • test_coverage   → tests, coverage, testing, quality
   • idea            → idea, startup, concept, feasibility
   • architecture    → architecture, design, system, scale
   • research        → research, methodology, academic, statistics
   • security        → security, vulnerability, threat, pentest
   • product         → product, ux, user, market
   • infrastructure  → infrastructure, devops, cloud, operations
`);

  console.log(`\n🚀 Try It Yourself:`);
  console.log(`
   # Using Claude Code or another MCP client:
   brutalist_discover({ intent: "your analysis goal here" })

   # Or with the CLI:
   echo '{"intent": "review my API security"}' | npx @brutalist/mcp brutalist_discover
`);

  console.log(`\n${'='.repeat(80)}\n`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { examples, demonstrateDiscovery };
