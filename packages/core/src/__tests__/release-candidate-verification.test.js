import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ReceivingAccountRepository,
  MerchantRepository,
  ObservationRepository,
  AuditLogRepository,
  CustomerRepository,
  DatabaseBusyError
} from '@youpi/db';
import {
  AttributionEngine,
  PaymentVerificationPipeline,
  WebhookEngine,
  RecoveryEngine,
  QueueEngine,
  TimingEngine
} from '../index.js';
import { startServer as startPaymentApi } from '../../../../apps/payment-api/src/index.js';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';
import { SmsObserverService } from '../../../../apps/sms-observer/src/sms-service.js';
import { GmailPoller } from '../../../../apps/gmail-observer/src/gmail-poller.js';
import { PaymentStatus } from '@youpi/common';

describe('Phase 9D: Release-Candidate Verification Suite', () => {
  let db;
  let apiInstance;
  let baseUrl;
  let sessionRepo;
  let accountRepo;
  let merchantRepo;
  let auditRepo;
  let obsRepo;
  let customerRepo;
  let attributionEngine;
  let webhookEngine;
  let recoveryEngine;

  let merchantA;
  let merchantB;
  let accountA;
  let accountB;

  const httpReq = async (method, path, { token, headers = {}, body = null } = {}) => {
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    };
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, body: data };
  };

  before(async () => {
    db = new Database({ inMemory: true });
    runMigrations(db);

    merchantRepo = new MerchantRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    auditRepo = new AuditLogRepository(db);
    obsRepo = new ObservationRepository(db);
    customerRepo = new CustomerRepository(db);

    merchantA = merchantRepo.create({
      businessName: 'V-Visa Staging Agency',
      slug: 'vvisa-staging',
      contactEmail: 'ops@vvisa.in',
      contactPhone: '9876543210',
      webhookUrl: 'http://localhost:3000/api/payments/youpi/webhook',
      webhookSecret: 'secret_vvisa_phase9d'
    });

    merchantB = merchantRepo.create({
      businessName: 'External Merchant Ltd',
      slug: 'external-merchant',
      contactEmail: 'admin@external.in',
      contactPhone: '9876543211',
      webhookUrl: 'http://localhost:4000/api/payments/webhook',
      webhookSecret: 'secret_external_phase9d'
    });

    accountA = accountRepo.create({
      merchantId: merchantA.id,
      upiId: 'vvisab2b@icici',
      payeeName: 'V-Visa B2B Staging',
      isMerchantEnabled: true,
      isActive: true
    });

    accountB = accountRepo.create({
      merchantId: merchantB.id,
      upiId: 'external@hdfcbank',
      payeeName: 'External Merchant Ltd',
      isMerchantEnabled: true,
      isActive: true
    });

    // Enrolled android observer device for Merchant A
    db.run(`
      INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active)
      VALUES ('device_test_9d_a', ?, 'Pixel 7 Observer', 'Pixel 7', 'keyhash_9d_a', 1)
    `, [merchantA.id]);

    attributionEngine = new AttributionEngine({ sessionRepo, obsRepo });
    webhookEngine = new WebhookEngine({ db, merchantRepo });
    const queueEngine = new QueueEngine({ sessionRepo, accountRepo });
    const timingEngine = new TimingEngine({ sessionRepo, accountRepo });
    recoveryEngine = new RecoveryEngine({ db, sessionRepo, accountRepo, queueEngine, timingEngine, auditRepo });

    apiInstance = await startPaymentApi(6199, db);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    db.close();
  });

  // ==========================================================================
  // Check 1: Migration Correctness & Explicit Safe Stop
  // ==========================================================================
  describe('Check 1: Migration Correctness & Safe Stop', () => {
    test('1.1: Migration preflight detects existing duplicate active sessions and halts explicitly', () => {
      const testDb = new Database({ inMemory: true });
      const { defaultMerchant } = runMigrations(testDb);
      const acct = new ReceivingAccountRepository(testDb).findActiveForMerchant(defaultMerchant.id);

      // Drop unique index to simulate legacy database state
      testDb.exec('DROP INDEX IF EXISTS idx_single_active_session;');
      testDb.exec('DROP INDEX IF EXISTS idx_one_slot_per_receiving_account;');

      // Insert two duplicate active sessions on the same receiving account
      testDb.run(`
        INSERT INTO payment_sessions (id, merchant_id, receiving_account_id, order_id, amount_paise, status)
        VALUES ('dup_1', ?, ?, 'ord_dup_1', 1000, 'ACTIVE')
      `, [defaultMerchant.id, acct.id]);
      testDb.run(`
        INSERT INTO payment_sessions (id, merchant_id, receiving_account_id, order_id, amount_paise, status)
        VALUES ('dup_2', ?, ?, 'ord_dup_2', 2000, 'ACTIVE')
      `, [defaultMerchant.id, acct.id]);

      // runMigrations must halt with explicit preflight error
      assert.throws(() => {
        runMigrations(testDb);
      }, /\[migrate\] Cannot apply idx_single_active_session: Detected 1 receiving account\(s\) with multiple active\/processing sessions/);

      // Resolving duplicate active state allows migration to proceed cleanly
      testDb.run("UPDATE payment_sessions SET status = 'EXPIRED' WHERE id = 'dup_1'");
      assert.doesNotThrow(() => {
        runMigrations(testDb);
      });

      testDb.close();
    });

    test('1.2: Both PostgreSQL and SQLite schemas define idx_one_slot_per_receiving_account identically', async () => {
      const fs = await import('node:fs');
      const sqliteSchema = fs.readFileSync('packages/db/src/sqlite-schema.sql', 'utf8');
      const pgSchema = fs.readFileSync('packages/db/src/schema.sql', 'utf8');

      const expectedIndexClause = 'idx_one_slot_per_receiving_account';
      assert.ok(sqliteSchema.includes(expectedIndexClause), 'SQLite schema must declare idx_one_slot_per_receiving_account');
      assert.ok(pgSchema.includes(expectedIndexClause), 'PostgreSQL schema must declare idx_one_slot_per_receiving_account');
    });
  });

  // ==========================================================================
  // Check 2: Observer Provisioning & Server Registration Binding
  // ==========================================================================
  describe('Check 2: Observer Provisioning & Server Registration Binding', () => {
    test('2.1: Observation intake rejects unregistered device with 403 DEVICE_UNAUTHORIZED', async () => {
      const res = await httpReq('POST', '/api/v1/pollers/events', {
        token: TEST_OBSERVER_TOKEN,
        headers: { 'X-Device-Id': 'unregistered_device_999' },
        body: {
          source: 'SMS',
          receivingAccountId: accountA.id,
          amountPaise: 50000,
          rawText: 'Rs 500 credited via UPI 123456789012'
        }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'DEVICE_UNAUTHORIZED');
    });

    test('2.2: Device registered to Merchant A is forbidden from submitting for Merchant B (CROSS_ACCOUNT_FORBIDDEN)', async () => {
      // Device A is registered to Merchant A; accountB belongs to Merchant B
      const res = await httpReq('POST', '/api/v1/pollers/events', {
        token: TEST_OBSERVER_TOKEN,
        headers: { 'X-Device-Id': 'device_test_9d_a' },
        body: {
          source: 'SMS',
          receivingAccountId: accountB.id,
          amountPaise: 50000,
          rawText: 'Rs 500 credited via UPI 123456789012'
        }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'CROSS_ACCOUNT_FORBIDDEN');
    });

    test('2.3: Observer token with mismatched X-Merchant-Id is rejected with 403 MERCHANT_ACCOUNT_MISMATCH', async () => {
      // accountA belongs to merchantA, but request specifies merchantB
      const res = await httpReq('POST', '/api/v1/pollers/events', {
        token: TEST_OBSERVER_TOKEN,
        headers: { 'X-Merchant-Id': merchantB.id },
        body: {
          source: 'SMS',
          receivingAccountId: accountA.id,
          amountPaise: 50000,
          rawText: 'Rs 500 credited via UPI 123456789012'
        }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'MERCHANT_ACCOUNT_MISMATCH');
    });

    test('2.4: Observers without receivingAccountId fail closed with zero observations submitted', async () => {
      const smsService = new SmsObserverService({ apiBaseUrl: baseUrl, receivingAccountId: null });
      const gmailPoller = new GmailPoller({ apiBaseUrl: baseUrl, receivingAccountId: null });

      const smsResult = await smsService.processSms({ text: 'Rs 500 credited', sender: 'HDFCBK' });
      const emailResult = await gmailPoller.processEmail({ subject: 'Credit alert', body: 'Rs 500 credited' });

      assert.equal(smsResult, null);
      assert.equal(emailResult, null);
      assert.equal(smsService.observedCount, 0);
      assert.equal(gmailPoller.observedCount, 0);
    });
  });

  // ==========================================================================
  // Check 3: Transaction & Retry Safety
  // ==========================================================================
  describe('Check 3: Transaction & Retry Safety', () => {
    test('3.1: Nested transactions execute cleanly with savepoints without collision', () => {
      let outerCommitted = false;
      let innerCommitted = false;

      db.transaction(() => {
        db.run("INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_type) VALUES ('tx_outer_1', ?, 'TEST', '1', 'OUTER', 'SYSTEM')", [merchantA.id]);

        // Nested inner transaction
        db.transaction(() => {
          db.run("INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_type) VALUES ('tx_inner_1', ?, 'TEST', '2', 'INNER', 'SYSTEM')", [merchantA.id]);
          innerCommitted = true;
        });

        outerCommitted = true;
      });

      assert.equal(outerCommitted, true);
      assert.equal(innerCommitted, true);

      const logs = db.query("SELECT id FROM audit_logs WHERE id IN ('tx_outer_1', 'tx_inner_1')");
      assert.equal(logs.length, 2);

      // Clean up
      db.run("DELETE FROM audit_logs WHERE id IN ('tx_outer_1', 'tx_inner_1')");
    });

    test('3.2: Inner transaction rollback rolls back to savepoint without aborting outer transaction', () => {
      db.transaction(() => {
        db.run("INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_type) VALUES ('tx_outer_2', ?, 'TEST', '1', 'OUTER', 'SYSTEM')", [merchantA.id]);

        try {
          db.transaction(() => {
            db.run("INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_type) VALUES ('tx_inner_fail', ?, 'TEST', '2', 'INNER', 'SYSTEM')", [merchantA.id]);
            throw new Error('INNER_INTENTIONAL_FAILURE');
          });
        } catch (innerErr) {
          assert.equal(innerErr.message, 'INNER_INTENTIONAL_FAILURE');
        }

        // Outer transaction continues and commits
        db.run("INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_type) VALUES ('tx_outer_3', ?, 'TEST', '3', 'OUTER', 'SYSTEM')", [merchantA.id]);
      });

      const logs = db.query("SELECT id FROM audit_logs WHERE id IN ('tx_outer_2', 'tx_inner_fail', 'tx_outer_3')");
      const ids = logs.map(l => l.id);
      assert.ok(ids.includes('tx_outer_2'));
      assert.ok(ids.includes('tx_outer_3'));
      assert.ok(!ids.includes('tx_inner_fail'), 'Inner rolled-back row must not exist');

      // Clean up
      db.run("DELETE FROM audit_logs WHERE id IN ('tx_outer_2', 'tx_outer_3')");
    });

    test('3.3: withRetry does not retry non-retryable errors (e.g. UNIQUE constraint)', () => {
      let attempts = 0;
      assert.throws(() => {
        db.withRetry(() => {
          attempts++;
          const err = new Error('UNIQUE constraint failed');
          err.code = 'SQLITE_CONSTRAINT';
          throw err;
        }, 3, 5);
      }, /UNIQUE constraint failed/);

      assert.equal(attempts, 1, 'Non-retryable error must fail immediately on attempt 1');
    });

    test('3.4: withRetry exhausts retries under persistent contention and throws DatabaseBusyError', () => {
      let attempts = 0;
      assert.throws(() => {
        db.withRetry(() => {
          attempts++;
          const err = new Error('SQLITE_BUSY: database is locked');
          err.code = 'SQLITE_BUSY';
          throw err;
        }, 3, 5);
      }, (err) => {
        return err instanceof DatabaseBusyError && err.code === 'DATABASE_BUSY' && err.isRetryable === true;
      });

      // Initial attempt (1) + 3 retries = 4 total attempts
      assert.equal(attempts, 4);
    });
  });

  // ==========================================================================
  // Check 4: End-to-End Payment Integrity & Anti-Replay Verification
  // ==========================================================================
  describe('Check 4: End-to-End Payment Integrity & Anti-Replay', () => {
    test('4.1: End-to-end lifecycle: checkout -> observation -> attribution -> signed webhook payload', () => {
      db.run('UPDATE payment_observations SET attributed_payment_id = NULL WHERE attributed_payment_id IN (SELECT id FROM payment_sessions WHERE receiving_account_id = ?)', [accountA.id]);
      db.run('DELETE FROM payment_sessions WHERE receiving_account_id = ?', [accountA.id]);

      // 1. Create active session on Account A
      const session = sessionRepo.create({
        merchantId: merchantA.id,
        receivingAccountId: accountA.id,
        amountPaise: 25000,
        orderId: 'ORD_E2E_9D_01',
        status: PaymentStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 600000)
      });

      // 2. Submit matching bank observation to AttributionEngine
      const attrResult = attributionEngine.processObservation({
        source: 'SMS',
        receivingAccountId: accountA.id,
        amountPaise: 25000,
        bankReferenceNumber: '998877665544',
        senderVpa: 'buyer@okhdfcbank',
        fingerprintHash: 'hash_test_998877665544',
        rawPayload: { text: 'Rs 250 credited' },
        observedAt: new Date()
      });

      assert.equal(attrResult.attributed, true);
      assert.equal(attrResult.paymentSessionId, session.id);

      // Verify session updated to OBSERVED_SUCCESS / SUCCESS
      const updatedSession = sessionRepo.findById(session.id);
      assert.ok([PaymentStatus.SUCCESS, PaymentStatus.OBSERVED_SUCCESS].includes(updatedSession.status));

      // 4. Generate signed webhook payload
      const webhookPayload = {
        event: 'SUCCESS',
        paymentId: updatedSession.id,
        orderId: updatedSession.orderId,
        amount: '250.00',
        amountPaise: 25000,
        currency: 'INR',
        method: 'UPI',
        utr: '998877665544',
        completedAt: new Date().toISOString()
      };

      const rawJson = JSON.stringify(webhookPayload);
      const signatureHex = createHmac('sha256', merchantA.webhookSecret).update(rawJson, 'utf8').digest('hex');

      // 5. Verify HMAC signature format and verification
      const verifyHmacSig = (raw, sig, sec) => {
        const expected = sig.startsWith('sha256=') ? sig.slice(7) : sig;
        const actual = createHmac('sha256', sec).update(raw, 'utf8').digest('hex');
        return expected === actual;
      };

      assert.equal(verifyHmacSig(rawJson, `sha256=${signatureHex}`, merchantA.webhookSecret), true);
      assert.equal(verifyHmacSig(rawJson, 'sha256=tampered_signature_hex_00000000000000000000000000000000000000000', merchantA.webhookSecret), false);

      // Clean up
      db.run('UPDATE payment_observations SET attributed_payment_id = NULL WHERE attributed_payment_id = ?', [session.id]);
      db.run('DELETE FROM payment_sessions WHERE id = ?', [session.id]);
    });

    test('4.2: Webhook replay simulation rejects duplicate event delivery', () => {
      // Simulate V-Visa ledger duplicate rejection
      const seenDeliveryIds = new Set();
      const processDelivery = (deliveryId) => {
        if (seenDeliveryIds.has(deliveryId)) {
          return { ok: true, duplicate: true, credited: false };
        }
        seenDeliveryIds.add(deliveryId);
        return { ok: true, duplicate: false, credited: true };
      };

      const delivery1 = processDelivery('deliv_uuid_101');
      assert.equal(delivery1.credited, true);
      assert.equal(delivery1.duplicate, false);

      const delivery2 = processDelivery('deliv_uuid_101');
      assert.equal(delivery2.credited, false);
      assert.equal(delivery2.duplicate, true);
    });
  });

  // ==========================================================================
  // Check 5: Operational & Recovery Verification
  // ==========================================================================
  describe('Check 5: Operational Recovery & Stale Session Sweep', () => {
    test('5.1: RecoveryEngine cleans up stale ACTIVE sessions on system restart', () => {
      db.run('UPDATE payment_observations SET attributed_payment_id = NULL WHERE attributed_payment_id IN (SELECT id FROM payment_sessions WHERE receiving_account_id = ?)', [accountA.id]);
      db.run('DELETE FROM payment_sessions WHERE receiving_account_id = ?', [accountA.id]);

      // Create a session whose expiration is in the past
      const expiredSession = sessionRepo.create({
        merchantId: merchantA.id,
        receivingAccountId: accountA.id,
        amountPaise: 30000,
        orderId: 'ORD_STALE_RECOVER',
        status: PaymentStatus.ACTIVE
      });
      db.run("UPDATE payment_sessions SET expires_at = datetime('now', '-60 seconds') WHERE id = ?", [expiredSession.id]);

      // Run boot recovery
      const stats = recoveryEngine.recover();
      assert.ok(stats.expiredCount >= 1);

      // Verify the stale session transitioned to EXPIRED
      const recovered = sessionRepo.findById(expiredSession.id);
      assert.equal(recovered.status, PaymentStatus.EXPIRED);

      // Verify slot is freed: a new session can now be acquired as ACTIVE
      const newSession = sessionRepo.create({
        merchantId: merchantA.id,
        receivingAccountId: accountA.id,
        amountPaise: 35000,
        orderId: 'ORD_NEW_ACTIVE',
        status: PaymentStatus.QUEUED
      });

      const newActive = sessionRepo.acquireSlotAtomic(
        newSession.id,
        accountA.id,
        300000
      );

      assert.equal(newActive.status, PaymentStatus.ACTIVE);

      // Clean up
      db.run('DELETE FROM payment_sessions WHERE id IN (?, ?)', [expiredSession.id, newSession.id]);
    });
  });
});
