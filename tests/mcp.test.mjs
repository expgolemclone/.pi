import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../agent/mcp.json', import.meta.url), 'utf8'));

test('Pi does not duplicate the workspace-owned MCP server configuration', () => {
  assert.deepEqual(config, { mcpServers: {} });
});
