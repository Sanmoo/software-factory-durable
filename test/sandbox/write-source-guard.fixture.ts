// This trusted parser ONLY ast.parse's the captured guest SOURCE. It never
// imports, compiles, evals or executes the guest body or simulates kernel FDs.
export const parser = `import ast, sys
source = sys.stdin.read()
tree = ast.parse(source)
assert not any(isinstance(n, ast.Attribute) and n.attr in ("O_TRUNC", "rename", "replace", "unlink", "chmod", "fchmod") for n in ast.walk(tree))
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
if len(sys.argv) > 1 and sys.argv[1] == "stream":
    assert not any(isinstance(n, ast.Attribute) and n.attr in ("ftruncate", "mkdir") for n in ast.walk(tree))
    writable = [n for n in opens if any(isinstance(a, ast.Attribute) and a.attr == "O_WRONLY" for a in ast.walk(n))]
    assert writable == [create]
    assert "O_NONBLOCK" in attrs
    assert 'parent = os.open(parts[1], flags, dir_fd=base)' in source
    assert source.count('child = os.open(leaf, flags, dir_fd=parent)') == 1
    assert 'target = os.readlink("/proc/self/fd/" + str(fd))' in source
    assert 'stat.S_ISREG(os.fstat(fd).st_mode) if regular else stat.S_ISDIR(os.fstat(fd).st_mode)' in source
    assert 'target.endswith(" (deleted)")' in source
    assert 'len(parts) != 3 or parts[1] != "artifacts"' in source
    assert 'target in ("/artifacts",)' in source
    assert 'target.startswith("/artifacts/")' in source
    assert 'parts[1] not in ("artifacts",)' in source
    assert source.index('authorize(parent)\\n        leaf = parts[-1]') < source.index('fd = os.open(leaf, os.O_WRONLY | os.O_CREAT')
    assert 'fds.append(fd)\\n        authorize(fd, regular=True)\\n        authorize(parent)\\n        count = 0' in source
    assert source.index('authorize(fd, regular=True)') < source.index('os.read(0, 65536)') < source.index('os.write(fd, data)')
    assert 'written = os.write(fd, data)\\n                if written <= 0:' in source
    assert 'digest.update(data[:written])' in source
    assert 'data = data[written:]' in source
    assert 'count > 9007199254740991' in source
    print("static AST guards passed; guest BODY NOT executed")
    sys.exit(0)
# Existing target is opened without create/truncate; only ENOENT can create.
existing = [n for n in opens if any(isinstance(a, ast.Attribute) and a.attr == "O_WRONLY" for a in ast.walk(n)) and n is not create]
assert len(existing) == 1
assert {"O_WRONLY", "O_NONBLOCK", "O_NOFOLLOW", "O_CLOEXEC"} == {n.attr for n in ast.walk(existing[0]) if isinstance(n, ast.Attribute) and n.attr.startswith("O_")}
assert any(k.arg == "dir_fd" and isinstance(k.value, ast.Name) and k.value.id == "parent" for k in existing[0].keywords)
branch = next(n for n in main[-1].body if isinstance(n, ast.Try))
assert len(branch.handlers) == 1 and isinstance(branch.handlers[0].type, ast.Name) and branch.handlers[0].type.id == "FileNotFoundError"
assert create in list(ast.walk(branch.handlers[0]))
assert len(branch.body) == 1 and existing[0] in list(ast.walk(branch.body[0]))
assert not branch.orelse and not branch.finalbody
assert len(branch.handlers[0].body) == 2
assert ast.unparse(branch.handlers[0].body[0]) == 'authorize(parent)'
assert create in list(ast.walk(branch.handlers[0].body[1]))
assert not any(isinstance(n, (ast.Try, ast.While, ast.For)) for n in ast.walk(branch.handlers[0]))
assert 'stat.S_ISREG(os.fstat(fd).st_mode) if regular else stat.S_ISDIR(os.fstat(fd).st_mode)' in source
assert 'not regular and target in ("/workspace", "/artifacts")' in source
assert 'target = os.readlink("/proc/self/fd/" + str(fd))' in source
assert 'target.endswith(" (deleted)")' in source
assert 'fds.append(fd)\\n        authorize(fd, regular=True)\\n        authorize(parent)\\n        os.ftruncate(fd, 0)\\n        while True:' in source
assert source.count('os.ftruncate(') == 1
assert source.index('os.ftruncate(fd, 0)') < source.index('os.read(0, 65536)') < source.index('os.write(fd, data)')
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
