import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './setup.js';
import { doctor } from './doctor.js';

const usage = 'factory <setup|doctor> [--root <installation>] [--json]';

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  const command = args[0];
  let root = resolve('.');
  let json = false;
  let rootSeen = false;
  let valid = command === 'setup' || command === 'doctor';
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--json' && !json) json = true;
    else if (args[index] === '--root' && !rootSeen && args[index + 1] && !args[index + 1]?.startsWith('-')) {
      root = resolve(args[++index]!);
      rootSeen = true;
    } else { valid = false; break; }
  }
  if (!valid) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: usage }));
    return 2;
  }
  try {
    if (command === 'doctor') {
      const report = await doctor(root);
      const errors = !report.configuration.valid ? report.configuration.errors.map(error => `${error.code}: ${error.path}`).join('\n') + '\n' : '';
      console.log(json ? JSON.stringify(report) :
        `${report.code} (${report.scope})\nRoot: ${report.paths.root}\nNode: ${report.versions.node}\n${errors}` +
        report.checks.map(check => `${check.id}: ${check.status} — ${check.message} Next: ${check.nextStep}`).join('\n'));
      return report.configuration.valid ? (report.code === 'PREREQUISITES_MISSING' ? 3 : 0) : 2;
    }
    const prepared = await setup(root);
    const result = { code: 'SETUP_PREPARED', ...prepared, diagnostics: await doctor(prepared.root) };
    console.log(json ? JSON.stringify(result) :
      `Prepared ${result.root}; created: ${result.created.join(', ') || 'none'}.\n${result.diagnostics.code}: preparation is not runtime qualification. Run doctor --json for details.`);
    return 0;
  } catch {
    console.error(JSON.stringify({ code: 'LOCAL_IO_FAILED', message: 'Check installation paths, types and permissions; no automatic repair.' }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
