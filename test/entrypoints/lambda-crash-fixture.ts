import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import type { LambdaWorkerLauncher } from '../../src/sandbox/index.js';
import { lambdaAccountFake } from '../sandbox/lambda-service-fake.js';
import { lambdaGuestFake } from '../sandbox/lambda-guest-fake.js';
import { worldScope } from './github-world-fixture.js';

// v2 ticket 15: what the crashing controller child and its successor both compose (`lambda-crash-reconciliation.test.ts`): the PRODUCTION
// execution composition with the Lambda adapter, over the fake AWS account kept in a FILE (the account outlives the process, as the real
// one does), a fresh in-process guest per process (a guest is reached only through the channel) and a worker that never finishes.
export const tip = 'b'.repeat(40);
export const remoteUrl = 'https://github.com/acme/project.git';
const model = { provider: productionProfile.model.providerId, model: productionProfile.model.modelId };
export const effective = { models: { builder: model, standards: model, spec: model }, repositories: [{ ...worldScope, correctionLimit: 3, recoveryLimit: 3 }], dependencyRepositories: [],
  operators: ['operator-one'], concurrency: 1, sandbox: { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' } };

export async function composeCrashInstallation(input: { root: string; executable: string; accountFile: string }) {
  const github = createGitHubAccess({ root: input.root, executable: input.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fake = lambdaAccountFake({ stateFile: input.accountFile });
  const guests = lambdaGuestFake(fake);
  guests.world.origins[remoteUrl] = { commits: [tip], token: token => token.startsWith('synthetic-installation-secret-') };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const launched: string[] = [];
  /** The Builder's worker process: it reports its start and then works forever (the boot is in progress when the controller dies). */
  const workerLauncher: LambdaWorkerLauncher = async request => {
    launched.push(`${request.context.role}:${request.context.phaseId}`);
    return { started: Promise.resolve({ receipt: { workId: request.context.workId, id: randomUUID() }, invocation: { executionId: request.context.executionId, invocationId: request.context.invocationId } }),
      completed: new Promise<never>(() => {}), deliver: async () => false };
  };
  const lambda = { service: fake.service, transport: guests.transport, clock, imageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep }, workerLauncher };
  const composed = await composeProductionExecution({ root: input.root, effective, guestAssets: { directory: join(input.root, 'guest'), manifestSha256: 'a'.repeat(64) }, github, lambda });
  if (composed.status !== 'composed') throw new Error(`not composed: ${JSON.stringify(composed)}`);
  return { github, fake, guests, clock, lambda, ports: composed.ports, launched };
}
