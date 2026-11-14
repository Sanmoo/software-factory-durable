import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Ticket 14 static gate (spec §2/§9.1, Q7): the Builder publishes DIRECTLY in its guest; the controller has no push gateway/publisher, and
// there is no Git/gh wrapper, shell parser, effect-registration tool or special journal for push/PR creation.
async function sources(directory = 'src'): Promise<{ path: string; text: string }[]> {
  const result: { path: string; text: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (entry.name.endsWith('.ts')) result.push({ path, text: await readFile(path, 'utf8') });
  }
  return result;
}

test('AC1/AC5: no controller push/PR-creation path, no Git/gh wrapper or shell parser for publication', async () => {
  const files = await sources();
  // Host git runs only to prepare/inspect the checkout, never to push.
  for (const file of files.filter(item => item.text.includes("'/usr/bin/git'"))) {
    assert.ok(['src/sandbox/checkout.ts', 'src/sandbox/checkout-inspection.ts'].includes(file.path), file.path);
    assert.doesNotMatch(file.text, /['"]push['"]|--force-with-lease/, `${file.path}: host git never pushes`);
  }
  // The controller's GitHub client has exactly one write (the Question comment); no pulls/refs/contents writes.
  const github = files.find(item => item.path === 'src/platform/github/index.ts')!.text;
  assert.equal((github.match(/JSON\.stringify\(\{ body \}\)/g) ?? []).length, 1, 'the only POST body is the issue comment');
  assert.doesNotMatch(github, /\/pulls['`]|\/git\/refs|PATCH|PUT/, 'no PR creation/update or ref write by the controller');
  // The CodeRepository contract stays read-only for the implementation publication.
  const repository = files.find(item => item.path === 'src/code-repository/index.ts')!.text;
  const contract = /export interface CodeRepository \{([\s\S]*?)\n\}/.exec(repository)![1]!;
  assert.deepEqual([...contract.matchAll(/^\s+(\w+)\(/gm)].map(match => match[1]), ['checkAccess', 'findPublication']);
  // No shell parsing of Builder commands or effect-registration tool for push/PR (Q7): the Workers and Sandbox never look for them.
  for (const file of files.filter(item => /^src\/(workers|sandbox|platform)\//.test(item.path))) {
    assert.doesNotMatch(file.text, /registrar_efeito|register_effect|git push|gh pr create|pr create/, file.path);
  }
});
