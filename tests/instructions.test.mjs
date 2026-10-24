import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sdk } from './support/pi-runtime.mjs';

test('instructions are a regular file managed directly by the Pi repository', () => {
  const path = fileURLToPath(new URL('../agent/AGENTS.md', import.meta.url));
  assert.ok(lstatSync(path).isFile());
  assert.ok(readFileSync(path, 'utf8').trim());
});

function fixture(t) {
  const directory = mkdtempSync('C:/dev/tmp/pi-native-instructions-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  const cwd = join(directory, 'project');
  for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
  const path = join(agentDir, 'AGENTS.md');
  writeFileSync(path, '# Native instructions\n');
  return { agentDir, cwd, path };
}

test('Pi discovers global instructions before project context without an extension', t => {
  const f = fixture(t);
  const projectPath = join(f.cwd, 'AGENTS.md');
  writeFileSync(projectPath, '# Project instructions\n');
  const files = sdk.loadProjectContextFiles(f);
  const globalIndex = files.findIndex(file => file.path === f.path);
  const projectIndex = files.findIndex(file => file.path === projectPath);
  assert.ok(globalIndex >= 0 && projectIndex > globalIndex);
  assert.equal(files[globalIndex].content, '# Native instructions\n');
  assert.equal(files.filter(file => file.path === f.path).length, 1);
});

test('native reload refreshes instructions without input or prompt-injection handlers', async t => {
  const f = fixture(t);
  const loader = new sdk.DefaultResourceLoader({
    cwd: f.cwd, agentDir: f.agentDir,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    settingsManager: sdk.SettingsManager.inMemory({ defaultProjectTrust: 'never' }),
  });
  await loader.reload();
  const instructions = () => loader.getAgentsFiles().agentsFiles.find(file => file.path === f.path);
  assert.equal(instructions().content, '# Native instructions\n');
  writeFileSync(f.path, '# Updated native instructions\n');
  await loader.reload();
  assert.equal(instructions().content, '# Updated native instructions\n');
  assert.deepEqual(loader.getExtensions().extensions, []);
});
