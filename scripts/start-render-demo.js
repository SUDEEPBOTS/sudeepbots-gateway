import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../packages/db/src/migrate.js';
import { startControlCenter } from '../apps/control-center/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const RENDER_PORT = Number(process.env.PORT || 10000);
const GATEWAY_PORT = 5050;

process.env.YOUPI_MODE = 'localhost';
process.env.NODE_ENV = 'production';
process.env.COIN_WALLET_STORE_PORT = String(GATEWAY_PORT);
process.env.COIN_STORE_PORT = String(GATEWAY_PORT);
process.env.USE_SQLITE_FALLBACK = 'true';

console.log('====================================================');
console.log('🚀 Starting SudeepBots Gateway on Render');
console.log('====================================================');

// 1. Run migrations
console.log('[1/2] Running database migrations...');
const migrationResult = runMigrations();
console.log(`[✓] Database ready. Default merchant: ${migrationResult.defaultMerchant.businessName}`);

// 2. Launch Control Center & all background services (Payment API, Checkout Portal, Gmail IMAP Observer)
console.log('[2/2] Starting all gateway services & IMAP poller...');
const ccPort = Number(process.env.CONTROL_CENTER_PORT || 8090);
const cc = await startControlCenter(ccPort);
await cc.processManager.startAll();

console.log('[✓] All internal services online.');

// 3. Create public Render edge proxy on RENDER_PORT
const proxy = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', service: 'sudeepbots-gateway', timestamp: new Date().toISOString() }));
    return;
  }

  // Forward all traffic to the gateway proxy (coin-wallet-store on 5050)
  const proxyReq = http.request({
    host: '127.0.0.1',
    port: GATEWAY_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': 'https'
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Gateway starting up or temporarily unavailable: ' + err.message);
  });

  req.pipe(proxyReq);
});

proxy.listen(RENDER_PORT, '0.0.0.0', () => {
  console.log(`[✓] Public Render gateway listening on port ${RENDER_PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\nShutting down Render gateway cleanly...');
  proxy.close();
  await cc.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
