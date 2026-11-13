// Adapter-only preload; existing standalone Workers fixtures retain their scope.
import { guardFixtureNetwork } from '../adapter-fixture-network-guard.js';
import { resolve } from 'node:path';
guardFixtureNetwork(resolve(process.env.TMPDIR!, '../../../..'), true);
await import('../../workers/fixtures/write-provider-preload.js');
