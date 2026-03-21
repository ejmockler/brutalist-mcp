import Sequencer from '@jest/test-sequencer';

/**
 * Custom test sequencer that runs tests spawning external CLI processes last.
 *
 * External CLI tools (claude, codex, gemini) throw uncaught "Not connected"
 * errors when their stdio pipe closes during test teardown. Jest counts these
 * as child process exceptions and after 4 of them, refuses to run more tests
 * in that worker. By running these tests last, we prevent them from blocking
 * other test suites.
 */
export default class CustomSequencer extends Sequencer {
  sort(tests) {
    // Tests that spawn external CLI processes should run last
    const externalProcessTests = [
      'cli.integration.test',
      'mcp-client-validation.test',
      'transport.integration.test'
    ];

    return [...tests].sort((a, b) => {
      const aIsExternal = externalProcessTests.some(t => a.path.includes(t));
      const bIsExternal = externalProcessTests.some(t => b.path.includes(t));

      if (aIsExternal && !bIsExternal) return 1;
      if (!aIsExternal && bIsExternal) return -1;
      return a.path.localeCompare(b.path);
    });
  }
}
