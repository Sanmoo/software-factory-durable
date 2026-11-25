// The agent process of the real Investigation Environment scenarios: it runs inside the attempt's unit, outside the confinement, and
// executes each command it receives on its socket through the port's shell (one JSON line in, one JSON line out per connection).
import { createServer } from 'node:net';
import { createInvestigationEnvironment } from '../../src/sandbox/index.js';

const [root, factoryRoot, attempt, socket] = process.argv.slice(2) as [string, string, string, string];
const shell = await createInvestigationEnvironment({ root, factoryRoot }).shell(attempt);

createServer(connection => {
  let request = '';
  connection.setEncoding('utf8');
  connection.on('data', chunk => {
    request += chunk;
    if (!request.endsWith('\n')) return;
    void shell.exec(JSON.parse(request) as { command: string; cwd?: string }).then(result => connection.end(`${JSON.stringify(result)}\n`));
  });
}).listen(socket);
