// Stand-in for llama-server in the container smoke test: the endpoints the backend calls, no weights.
import http from 'node:http';

const NOTE = 'A relaxed few days with time to enjoy each place, and room to slow down when you want to.';

http.createServer((req, res) => {
  const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
  if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'stub', object: 'model' }] });
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    req.resume();
    req.on('end', () => send(200, { choices: [{ index: 0, message: { role: 'assistant', content: NOTE }, finish_reason: 'stop' }] }));
    return;
  }
  send(404, { error: 'not found' });
}).listen(8081, '0.0.0.0', () => console.log('stub model on :8081'));
