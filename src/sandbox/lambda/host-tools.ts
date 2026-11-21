import { execFile } from 'node:child_process';

/** The host executables the Lambda channel runs besides `aws` (`ssh-transport.ts`): the OpenSSH client and its WebSocket `ProxyCommand`. */
export const lambdaHostTools = ['ssh', 'websocat'] as const;
export type LambdaHostTool = typeof lambdaHostTools[number];

/** Whether a host tool can be run at all from the PATH the process has. Injectable: tests never depend on the real host. */
export type HostToolProbe = (executable: LambdaHostTool) => Promise<boolean>;

/** The argument that makes each tool print its version and exit, touching nothing. */
const versionArgument: Record<LambdaHostTool, string> = { ssh: '-V', websocat: '--version' };

/**
 * Runs the tool's version command (no shell) with the environment the channel itself would use. Any exit means it can be run; what could
 * not be spawned (absent from the PATH, not executable) cannot, exactly as `createAwsCliRunner` reads `unavailable`.
 */
export function createHostToolProbe({ environment = process.env }: { environment?: NodeJS.ProcessEnv } = {}): HostToolProbe {
  return executable => new Promise(resolve => {
    execFile(executable, [versionArgument[executable]], { env: environment, encoding: 'utf8' }, error => resolve(!error || typeof error.code === 'number'));
  });
}
