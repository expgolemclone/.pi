import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../agent/mcp.json', import.meta.url), 'utf8'));

test('kintone uses native Node and the installed shared bootstrap without Codex or credentials', () => {
  assert.deepEqual(Object.keys(config), ['mcpServers']);
  assert.deepEqual(Object.keys(config.mcpServers), ['kintone']);
  const server = config.mcpServers.kintone;
  assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'cwd', 'timeout']);
  assert.match(server.command, /^[A-Z]:\/.*\/node\.exe$/);
  assert.equal(server.args.length, 3);
  assert.match(server.args[0], /^~\/AppData\/Local\/envx\/runtimes\/node\/node_modules\/@expgolemclone\/envx-runtime\/cli\.mjs$/);
  assert.equal(server.args[1], 'run');
  assert.equal(server.args[2], `${server.cwd}/kintone-workspace/dist/server/main.js`);
  assert.ok(Number.isSafeInteger(server.timeout) && server.timeout > 0);
  assert.doesNotMatch(JSON.stringify(config), /\.codex|authorization|api[_-]?token|password/i);
});
