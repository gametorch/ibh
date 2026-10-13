// Static server for the plain-html example (Node builtins only).
// Run: node examples/plain-html/server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 4174;
const IBH_BUNDLE = path.join(__dirname, '..', '..', 'packages', 'ibh', 'dist', 'index.global.js');

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/ibh.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return fs.createReadStream(IBH_BUNDLE).pipe(res);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  })
  .listen(PORT, () => console.log(`plain-html example: http://localhost:${PORT}`));
