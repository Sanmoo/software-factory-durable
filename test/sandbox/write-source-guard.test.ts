import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { nativeOwner } from './native-owner.fixture.js';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';

// This trusted parser ONLY ast.parse's the captured guest SOURCE. It never
// imports, compiles, evals or executes the guest body or simulates kernel FDs.
const parser = `import ast, sys
source = sys.stdin.read()
tree = ast.parse(source)
assert not any(isinstance(n, ast.Attribute) and n.attr in ("O_TRUNC", "rename", "replace", "unlink") for n in ast.walk(tree))
opens = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "open"]
creates = [n for n in opens if any(isinstance(a, ast.Attribute) and a.attr == "O_CREAT" for a in ast.walk(n))]
assert len(creates) == 1
create = creates[0]
attrs = {n.attr for n in ast.walk(create) if isinstance(n, ast.Attribute)}
assert {"O_CREAT", "O_EXCL", "O_NOFOLLOW", "O_CLOEXEC"} <= attrs
assert any(k.arg == "dir_fd" and isinstance(k.value, ast.Name) and k.value.id == "parent" for k in create.keywords)
assert isinstance(create.args[0], ast.Name) and create.args[0].id == "leaf"
flags = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "flags" for t in n.targets))
assert {"O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"} <= {n.attr for n in ast.walk(flags) if isinstance(n, ast.Attribute)}
main = tree.body[2].body
assert any(isinstance(n, ast.FunctionDef) and n.name == "authorize" for n in main)
# Directory root open must use the same nofollow flags, not a followed root.
assert 'parent = os.open(parts[1], flags, dir_fd=base)' in source
assert source.count('child = os.open(leaf, flags, dir_fd=parent)') == 2
assert 'authorize(parent)\\n    directories' in source
assert 'authorize(parent)\\n            os.mkdir(leaf, mode=0o700, dir_fd=parent)' in source
assert 'authorize(parent)\\n        leaf = parts[-1]' in source
assert 'leaf in ("", ".", "..") or "/" in leaf' in source
assert 'target in ("/workspace", "/artifacts")' in source
assert 'target.startswith(("/workspace/", "/artifacts/"))' in source
assert 'os.read(0, 65536)' in source
print("static AST guards passed; guest BODY NOT executed")
`;
const context: ToolContext = { workId: 'guard-work', executionId: 'guard-exec', invocationId: 'guard-invocation',
  role: 'builder', environmentRef: 'guard-env', bootRef: 'guard-boot', phaseId: 'guard-phase' };

test('guest write SOURCE statically guards authorized nofollow roots/parents before effects and exclusive final create', async t => {
  let source = '';
  const f = await nativeOwner(context, { exec(argv) {
    source = argv[4]!;
    return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
  } }); t.after(() => f.close());
  const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  assert.equal((await sandbox.executeTool(context, { name: 'write', operation: 'create', path: '/workspace/new', content: '', callId: 'source' })).status, 'success');
  const check = (candidate: string) => spawnSync('/usr/bin/python3', ['-I', '-S', '-c', parser], { input: candidate, encoding: 'utf8', timeout: 5000 });
  const valid = check(source);
  assert.equal(valid.status, 0, valid.stderr); assert.match(valid.stdout, /guest BODY NOT executed/);
  for (const adversarial of [source.replace('os.O_EXCL', 'os.O_TRUNC'), source.replace('parts[1], flags', 'parts[1], os.O_RDONLY'),
    source.replace('authorize(parent)\n            os.mkdir', 'os.mkdir'), source.replace('dir_fd=parent)', 'dir_fd=base)')]) {
    assert.notEqual(check(adversarial).status, 0, 'static guard must reject authorization/NO_TRUNC regression');
  }
});
