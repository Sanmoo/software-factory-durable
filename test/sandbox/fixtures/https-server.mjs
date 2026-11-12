// Guest-container fixture asset only; never launched by the local test suite.
import https from 'node:https';
import { readFileSync } from 'node:fs';

https.createServer({
  key: readFileSync('/fixture/tls/server-key.pem'),
  cert: readFileSync('/fixture/tls/server.pem'),
}, (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('factory06 verified TLS\n');
}).listen(8443, '0.0.0.0', () => console.log('06 HTTPS ready'));
