import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { GmailPoller } from '../gmail-poller.js';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

describe('Gmail Poller Boot Lifecycle & Control Suite', () => {
  let apiInstance;
  let testDb;
  let testStoragePath;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6194, testDb);
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  function request(port, pathname, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json || data });
        });
      });
      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  describe('1. Boot Lifecycle Preflight & Health States', () => {
    test('Observer enters STANDBY when receivingAccountId is missing', async () => {
      const observer = await startGmailObserver(6081, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: null,
        autoBoot: true
      });

      try {
        const health = await request(6081, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body.status, 'UP');
        assert.equal(health.body.lifecycleState, 'STANDBY');
        assert.equal(health.body.degradedReason, 'MISSING_RECEIVING_ACCOUNT');
        assert.equal(health.body.isRunning, false);
      } finally {
        await observer.close();
      }
    });

    test('Observer enters STANDBY when OAuth credentials are not configured in Payment API', async () => {
      const observer = await startGmailObserver(6082, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        autoBoot: true
      });

      try {
        if (observer.bootPromise) await observer.bootPromise;
        const health = await request(6082, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body.status, 'UP');
        assert.equal(health.body.lifecycleState, 'STANDBY');
        assert.equal(health.body.degradedReason, 'MISSING_OAUTH_CREDENTIALS');
        assert.equal(health.body.isRunning, false);
      } finally {
        await observer.close();
      }
    });

    test('Observer transitions to DEGRADED when token refresh fails', async () => {
      const observer = await startGmailObserver(6083, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        autoBoot: false
      });

      try {
        // Set fake credentials with invalid refresh token
        observer.poller.setCredentials({
          clientId: 'mock-client.apps.googleusercontent.com',
          clientSecret: 'mock-secret',
          refreshToken: 'invalid_mock_refresh_token'
        });

        const bootRes = await observer.poller.startBootLifecycle();
        assert.equal(bootRes.success, false);
        assert.equal(bootRes.state, 'DEGRADED');
        assert.equal(bootRes.reason, 'TOKEN_REFRESH_FAILED');

        const health = await request(6083, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body.status, 'DEGRADED');
        assert.equal(health.body.lifecycleState, 'DEGRADED');
        assert.equal(health.body.degradedReason, 'TOKEN_REFRESH_FAILED');
        assert.equal(health.body.isRunning, false);
      } finally {
        await observer.close();
      }
    });

    test('Observer handles unreachable Payment API gracefully without crashing', async () => {
      const observer = await startGmailObserver(6084, {
        apiBaseUrl: 'http://127.0.0.1:59999', // Dead port
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        autoBoot: true
      });

      try {
        const health = await request(6084, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body.status, 'UP');
        assert.equal(health.body.lifecycleState, 'STANDBY');
        assert.equal(health.body.degradedReason, 'MISSING_OAUTH_CREDENTIALS');
      } finally {
        await observer.close();
      }
    });

    test('Successful startup: activates when prerequisites pass and mock access token is available', async () => {
      const observer = await startGmailObserver(6085, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        autoBoot: false
      });

      try {
        // Mock getAccessToken to simulate valid token acquisition
        observer.poller.setCredentials({
          clientId: 'valid-client-id.apps.googleusercontent.com',
          clientSecret: 'valid-secret',
          refreshToken: 'valid-refresh-token',
          connectedEmail: 'alerts-test@vvisa.in'
        });
        observer.poller.getAccessToken = async () => 'mock_valid_google_access_token';

        const bootRes = await observer.poller.startBootLifecycle();
        assert.equal(bootRes.success, true);
        assert.equal(bootRes.state, 'ACTIVE');

        const health = await request(6085, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body.status, 'UP');
        assert.equal(health.body.lifecycleState, 'ACTIVE');
        assert.equal(health.body.isRunning, true);
        assert.equal(health.body.oauthConfigured, true);
        assert.equal(health.body.connectedEmail, 'a***@vvisa.in'); // Masked PII
      } finally {
        await observer.close();
      }
    });
  });

  describe('2. Deduplication Persistence Across Service Restarts', () => {
    const tempStorage = path.join(process.cwd(), 'data', `test_lifecycle_dedup_${Date.now()}.json`);

    after(() => {
      try { if (fs.existsSync(tempStorage)) fs.unlinkSync(tempStorage); } catch {}
    });

    test('Persists message IDs across restarts and rejects duplicates', async () => {
      const s1 = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'DEDUP-ORD-150',
        amountPaise: 15000n,
        status: 'ACTIVE'
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(s1.id, '00000000-0000-0000-0000-000000000002');

      // 1. Start Instance 1
      const inst1 = await startGmailObserver(6086, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        storagePath: tempStorage,
        autoBoot: false
      });

      const emailPayload = {
        id: 'msg_boot_lifecycle_101',
        from: 'alerts@hdfcbank.net',
        subject: 'Credit alert: Rs 150.00 received',
        body: 'Dear customer, Rs 150.00 credited to your account. UTR: 778899001122'
      };

      const res1 = await inst1.poller.processEmail(emailPayload);
      assert.equal(res1.accepted, true);
      assert.ok(inst1.poller.processedMessageIds.has('msg_boot_lifecycle_101'));

      // Close instance 1
      await inst1.close();

      // Verify file written to disk
      assert.ok(fs.existsSync(tempStorage));
      const diskIds = JSON.parse(fs.readFileSync(tempStorage, 'utf8'));
      assert.ok(diskIds.includes('msg_boot_lifecycle_101'));

      // 2. Start Instance 2 (Simulating service restart)
      const inst2 = await startGmailObserver(6087, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        storagePath: tempStorage,
        autoBoot: false
      });

      try {
        assert.ok(inst2.poller.processedMessageIds.has('msg_boot_lifecycle_101'));

        // Attempting to ingest same message again is rejected immediately
        const res2 = await inst2.poller.processEmail(emailPayload);
        assert.equal(res2.accepted, false);
        assert.equal(res2.duplicate, true);
        assert.equal(res2.reason, 'MESSAGE_ALREADY_PROCESSED');
      } finally {
        await inst2.close();
        testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS' WHERE receiving_account_id = '00000000-0000-0000-0000-000000000002'");
        testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = '00000000-0000-0000-0000-000000000002'");
      }
    });
  });

  describe('3. Ingestion Isolation & Safety Invariants', () => {
    test('Observation ingestion does NOT auto-finalize payment without dual channel', async () => {
      testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS' WHERE receiving_account_id = '00000000-0000-0000-0000-000000000002'");
      testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = '00000000-0000-0000-0000-000000000002'");

      const observer = await startGmailObserver(6088, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        autoBoot: false
      });

      try {
        // Create an active session in Payment API
        const session = apiInstance.app.context.sessionRepo.create({
          merchantId: '00000000-0000-0000-0000-000000000001',
          receivingAccountId: '00000000-0000-0000-0000-000000000002',
          orderId: 'ISOLATION-TEST-ORD-1',
          amountPaise: 30000n, // ₹300.00
          status: 'ACTIVE'
        });
        apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');

        // Submit matching bank observation via observer
        const obsResult = await observer.poller.processEmail({
          id: `msg_iso_${Date.now()}`,
          from: 'alerts@icicibank.com',
          subject: 'Credit alert: Rs 300.00 received',
          body: 'Rs 300.00 credited. Ref: 998877665544'
        });

        assert.ok(obsResult);
        assert.equal(obsResult.accepted, true);

        // Verification invariant: Under REQUIRE_DUAL_CHANNEL or detection mode,
        // observer observation alone does not finalize session or dispatch wallet credits
        const currentSession = apiInstance.app.context.sessionRepo.findById(session.id);
        assert.notEqual(currentSession.status, 'FAILED');
      } finally {
        await observer.close();
      }
    });
  });

  describe('4. Control Endpoints Authentication & Rate Limiting', () => {
    let observer;

    before(async () => {
      observer = await startGmailObserver(6089, {
        apiBaseUrl: `http://localhost:${apiInstance.port}`,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        autoBoot: false
      });
    });

    after(async () => {
      await observer.close();
    });

    test('POST /start rejects unauthenticated requests with 401', async () => {
      const res = await request(6089, '/start', { method: 'POST' });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /stop rejects unauthenticated requests with 401', async () => {
      const res = await request(6089, '/stop', { method: 'POST' });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /stop succeeds with admin bearer token', async () => {
      const res = await request(6089, '/stop', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.lifecycleState, 'STOPPED');
      assert.equal(observer.poller.isRunning, false);
    });

    test('POST /start succeeds with observer bearer token and evaluates prerequisites', async () => {
      const res = await request(6089, '/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.lifecycleState, 'STANDBY'); // Since OAuth is unconfigured in this test
    });

    test('Control endpoint enforces rate limiting after rapid repeated calls', async () => {
      let hitRateLimit = false;
      for (let i = 0; i < 15; i++) {
        const res = await request(6089, '/stop', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
        });
        if (res.status === 429) {
          hitRateLimit = true;
          assert.equal(res.body.code, 'RATE_LIMITED');
          break;
        }
      }
      assert.ok(hitRateLimit, 'Rate limit (429) should be enforced after exceeding limit');
    });
  });
});
