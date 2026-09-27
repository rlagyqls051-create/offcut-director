#!/usr/bin/env node
/* camproxy — 브라우저 CORS 우회용 카메라 프록시
 * 브라우저는 카메라 API의 CORS 헤더 부재로 직통 요청이 막힘.
 * 이 프록시는 로컬에서 받은 요청을 실제 카메라로 전달하고 CORS 헤더를 붙여 돌려줌.
 *
 * 사용:
 *   node tools/camproxy.js <카메라IP> [포트=8787]
 *   예) node tools/camproxy.js 192.168.122.1
 * 브라우저 앱에서 카메라 IP = 127.0.0.1:8787 입력 → 모든 요청이 실제 카메라로 전달됨.
 * (맥을 카메라 Wi-Fi에 직접 접속시켜야 함 — 그러면 맥 인터넷은 끊김)
 */
const http = require('http');

const target = process.argv[2];
const port = parseInt(process.argv[3] || '8787', 10);
if (!target) {
  console.log('사용법: node tools/camproxy.js <카메라IP[:포트]> [수신포트]\n예) node tools/camproxy.js 192.168.122.1');
  process.exit(1);
}
const [targetHost, targetPortStr] = target.split(':');
const targetPort = parseInt(targetPortStr || '80', 10);

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  const opts = {
    host: targetHost, port: targetPort, path: req.url, method: req.method,
    headers: { ...req.headers, host: target },
    timeout: 8000,
  };
  const proxy = http.request(opts, pr => {
    res.writeHead(pr.statusCode, { ...cors, 'Content-Type': pr.headers['content-type'] || 'application/octet-stream' });
    pr.pipe(res);
  });
  proxy.on('timeout', () => { proxy.destroy(); res.writeHead(504, cors); res.end('{"error":"camera timeout"}'); });
  proxy.on('error', e => { res.writeHead(502, cors); res.end(JSON.stringify({ error: e.message })); });
  req.pipe(proxy);
});

server.listen(port, () => {
  console.log(`camproxy → http://${target} (수신 http://127.0.0.1:${port})`);
  console.log('앱 설정에서 카메라 IP를 127.0.0.1:' + port + ' 로 입력하세요');
});
