// TEST ONLY: reference comparisons, never invoke private Node APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { syncBuiltinESMExports } from 'node:module';

export function observeSdkGlobals() {
  assert.equal(typeof Module.registerHooks, 'function');
  const originalRegister = Module.registerHooks;
  let calls = 0;
  // Installed AFTER the guard's own explicit registration. No SDK registration
  // may dispatch, even if an unexpected SDK effect is attempted.
  Module.registerHooks = (() => {
    calls++;
    throw new Error('SDK_GLOBAL_HOOK_REGISTRATION_FORBIDDEN');
  }) as typeof Module.registerHooks;
  syncBuiltinESMExports();
  const slots: [object, string][] = [
    [Module, 'registerHooks'],
    [Module, '_stat'],
    [process, 'cwd'],
    [process, 'chdir'],
    ...[
      'read',
      'readSync',
      'readFile',
      'readFileSync',
      'readlink',
      'readlinkSync',
      'realpath',
      'realpathSync',
      'lstat',
      'lstatSync',
      'stat',
      'statSync',
      'readdir',
      'readdirSync',
      'existsSync',
      'watch',
      'watchFile',
      'unwatchFile',
    ].map(name => [fs, name] as [object, string]),
    ...['readFile', 'readlink', 'realpath', 'stat', 'readdir', 'lstat', 'watch'].map(name => [fs.promises, name] as [object, string]),
    [fs.realpathSync, 'native'],
  ];
  const refs = slots.map(([object, name]) => Object.getOwnPropertyDescriptor(object, name));
  function assertUnchanged() {
    assert.equal(calls, 0, 'unexpected SDK Module.registerHooks calls');
    slots.forEach(([object, name], index) => assert.deepEqual(Object.getOwnPropertyDescriptor(object, name), refs[index], `SDK_GLOBAL_PATCH ${name}`));
  }
  return {
    assertUnchanged,
    get calls() {
      return calls;
    },
    restore() {
      assertUnchanged();
      Module.registerHooks = originalRegister;
      syncBuiltinESMExports();
    },
  };
}
