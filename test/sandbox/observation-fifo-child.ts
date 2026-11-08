// Ordinary local regression subprocess: no VM, service or signal target is created here.
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';
const root = process.argv[2]!;
const environment = process.argv[3]! as EnvironmentRef;
console.log(JSON.stringify(await createSandbox({ root }).observe({ environment })));
