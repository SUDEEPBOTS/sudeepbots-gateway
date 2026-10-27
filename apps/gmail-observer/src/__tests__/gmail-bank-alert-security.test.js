import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { BankEmailParser, redactSensitiveData, isAuthorizedBankEmailSender } from '../parser.js';
import { PaymentStatus } from '@youpi/common';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

describe('Gmail Bank Alert Security & Verification Suite', () => {
  let apiInstance;
  let gmailInstance;
  let testDb;
  let testStoragePath;

  before(async () => {
    testDb = new Database({ inMemory: true });
    testStoragePath = path.join(process.cwd(), 'data', `test_gmail_ids_${Date.now()}.json`);
    apiInstance = await startPaymentApi(6199, testDb);
    gmailInstance = await startGmailObserver(6098, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      storagePath: testStoragePath
    });
  });

  beforeEach(() => {
    // Reset slot availability and terminate any prior test sessions so every test runs in clean isolation
    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL");
  });

  after(async () => {
    await gmailInstance.close();
    await apiInstance.close();
    testDb.close();
    try {
      if (fs.existsSync(testStoragePath)) fs.unlinkSync(testStoragePath);
    } catch {}
  });

  describe('1. Log Redaction & Untrusted Input Safety', () => {
    test('redactSensitiveData masks UTRs, account numbers, emails, and phone numbers', () => {
      const input = 'Credit of Rs 100 to A/c XX4274 with UTR 086704470482 by vinoth@vvisa.in (Mobile 8610648309)';
      const redacted = redactSensitiveData(input);
      assert.ok(!redacted.includes('086704470482'), 'Raw UTR must be redacted');
      assert.ok(redacted.includes('0867****0482'), 'Redacted UTR must preserve prefix/suffix');
      assert.ok(!redacted.includes('XX4274'), 'Bank account must be masked');
      assert.ok(!redacted.includes('vinoth@vvisa.in'), 'Email must be masked');
      assert.ok(redacted.includes('v***@vvisa.in'), 'Masked email format verified');
      assert.ok(!redacted.includes('8610648309'), 'Phone number must be masked');
    });

    test('isAuthorizedBankEmailSender accepts official bank domains and rejects spoofed personal emails', () => {
      assert.equal(isAuthorizedBankEmailSender('alerts@hdfcbank.net'), true);
      assert.equal(isAuthorizedBankEmailSender('Credit Alerts <alerts@hdfc.bank.in>'), true);
      assert.equal(isAuthorizedBankEmailSender('notify@icicibank.com'), true);
      assert.equal(isAuthorizedBankEmailSender('alerts@sbi.co.in'), true);
      assert.equal(isAuthorizedBankEmailSender('alerts@axisbank.com'), true);
      assert.equal(isAuthorizedBankEmailSender('alerts@kotak.com'), true);
      assert.equal(isAuthorizedBankEmailSender('TEST'), true);

      // Untrusted spoofing attempts:
      assert.equal(isAuthorizedBankEmailSender('attacker@gmail.com'), false);
      assert.equal(isAuthorizedBankEmailSender('fake-hdfc@yahoo.com'), false);
      assert.equal(isAuthorizedBankEmailSender('scammer@phishing-bank.org'), false);
      assert.equal(isAuthorizedBankEmailSender(''), false);
    });
  });

  describe('2. Bank Alert Verification & Attribution Invariants', () => {
    test('Valid bank alert successfully attributes to active session', async () => {
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-TEST-ORDER-101',
        amountPaise: 10000n // ₹100.00
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      const result = await gmailInstance.poller.processEmail({
        id: 'msg_valid_101',
        subject: 'Credit Alert: Account credited with Rs 100.00',
        body: 'Dear Customer, Rs 100.00 credited to your HDFC account. UPI Ref: 111122223333 from buyer@okaxis.',
        from: 'alerts@hdfcbank.net',
        date: new Date()
      });

      assert.ok(result);
      assert.equal(result.accepted, true);
      const attributedId = result.attribution?.attributedSessionId || result.attribution?.paymentSessionId;
      assert.equal(attributedId, session.id);

      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.ok([PaymentStatus.SUCCESS, PaymentStatus.OBSERVED_SUCCESS].includes(updated.status));
      assert.ok(updated.verificationSources.includes('GMAIL'));
    });

    test('Sender mismatch / spoofed email domain is rejected without crediting', async () => {
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-TEST-ORDER-SPOOF',
        amountPaise: 50000n // ₹500.00
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      const result = await gmailInstance.poller.processEmail({
        id: 'msg_spoof_999',
        subject: 'Credit Alert: Rs 500 credited',
        body: 'Your account was credited Rs 500. Ref: 999988887777',
        from: 'impostor@gmail.com', // Spoofed personal email
        date: new Date()
      });

      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'UNAUTHORIZED_SENDER_DOMAIN');

      // Verify session was NOT credited
      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.notEqual(updated.status, PaymentStatus.SUCCESS);
    });

    test('Malformed or non-credit email is rejected', async () => {
      const result = await gmailInstance.poller.processEmail({
        id: 'msg_malformed_1',
        subject: 'Monthly Account Statement',
        body: 'Here is your monthly statement with no transaction alert.',
        from: 'alerts@hdfcbank.net'
      });

      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'MALFORMED_OR_NON_CREDIT');
    });

    test('Duplicate email ID is skipped immediately', async () => {
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-TEST-DUP-MSG',
        amountPaise: 15000n
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      const email = {
        id: 'msg_unique_dup_check',
        subject: 'Credit Alert: Rs 150.00 credited',
        body: 'Your account credited with Rs 150.00. UPI Ref: 333344445555',
        from: 'alerts@icicibank.com',
        date: new Date()
      };

      const first = await gmailInstance.poller.processEmail(email);
      assert.equal(first.accepted, true);

      // Second attempt with exact same message ID
      const second = await gmailInstance.poller.processEmail(email);
      assert.equal(second.accepted, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.reason, 'MESSAGE_ALREADY_PROCESSED');
    });

    test('Duplicate UTR is rejected and cannot settle a second session', async () => {
      // Session 1 consumed UTR 444455556666
      const session1 = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-UTR-ORDER-1',
        amountPaise: 25000n
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session1.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session1.id);

      await gmailInstance.poller.processEmail({
        id: 'msg_utr_first',
        subject: 'Credit Alert: Rs 250.00 credited',
        body: 'Rs 250.00 credited. UPI Ref: 444455556666',
        from: 'alerts@sbi.co.in',
        date: new Date()
      });

      const updated1 = apiInstance.app.context.sessionRepo.findById(session1.id);
      assert.ok([PaymentStatus.SUCCESS, PaymentStatus.OBSERVED_SUCCESS].includes(updated1.status));

      // Reset slot for Session 2
      testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL");

      // Session 2 created for same amount
      const session2 = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-UTR-ORDER-2',
        amountPaise: 25000n
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session2.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session2.id);

      // Attempt replay of the same UTR with new message ID
      let failed = false;
      try {
        await gmailInstance.poller.processEmail({
          id: 'msg_utr_replay_attempt',
          subject: 'Credit Alert: Rs 250.00 credited',
          body: 'Rs 250.00 credited. UPI Ref: 444455556666', // Same UTR
          from: 'alerts@sbi.co.in',
          date: new Date()
        });
      } catch (err) {
        failed = true;
      }
      assert.equal(failed, true, 'Duplicate UTR replay must fail submission');

      // Verify Session 2 was NOT credited
      const updated2 = apiInstance.app.context.sessionRepo.findById(session2.id);
      assert.notEqual(updated2.status, PaymentStatus.SUCCESS);
    });

    test('Wrong amount is rejected by fail-closed attribution engine', async () => {
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-TEST-ORDER-WRONG-AMT',
        amountPaise: 30000n // Expected: ₹300.00
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      let rejected = false;
      try {
        await gmailInstance.poller.processEmail({
          id: 'msg_wrong_amount',
          subject: 'Credit Alert: Rs 150.00 credited', // Partial payment attempt
          body: 'Your account received Rs 150.00. UPI Ref: 777788889999',
          from: 'alerts@hdfcbank.net',
          date: new Date()
        });
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, 'Amount mismatch must be rejected');

      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.notEqual(updated.status, PaymentStatus.SUCCESS);
    });
  });

  describe('3. Strict Verification Policy & Manual Reconciliation Workflow', () => {
    test('Strict dual-channel policy keeps email-only payment in PROCESSING (Pending Verification)', async () => {
      // Configure attributionEngine with strict dual-channel verification policy
      apiInstance.app.context.attributionEngine.verificationPolicy = 'REQUIRE_DUAL_CHANNEL';

      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-DUAL-POLICY-ORDER',
        amountPaise: 40000n // ₹400.00
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // Email arrives alone
      const result = await gmailInstance.poller.processEmail({
        id: 'msg_dual_policy_1',
        subject: 'Credit Alert: Rs 400.00 credited',
        body: 'Rs 400.00 credited to account. UPI Ref: 987654321098',
        from: 'alerts@kotak.com',
        date: new Date()
      });

      assert.ok(result);
      assert.equal(result.accepted, true);

      // Session MUST be in PROCESSING with verificationLevel 1, NOT terminal SUCCESS
      const inProgress = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(inProgress.status, PaymentStatus.PROCESSING);
      assert.equal(inProgress.verificationLevel, 1);
      assert.ok(inProgress.verificationSources.includes('GMAIL'));

      // Reconciliation Workflow: Authorized admin confirms receipt via admin API
      const confirmRes = await fetch(`http://localhost:${apiInstance.port}/api/v1/admin/payments/${session.id}/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_ADMIN_TOKEN}`
        },
        body: JSON.stringify({ operatorId: 'audit-reconciler', notes: 'Verified bank statement' })
      });

      assert.equal(confirmRes.status, 200);
      const confirmData = await confirmRes.json();
      assert.equal(confirmData.confirmed, true);

      // Now finalized to SUCCESS with audit trace
      const finalized = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(finalized.status, PaymentStatus.SUCCESS);

      // Restore standard policy
      apiInstance.app.context.attributionEngine.verificationPolicy = 'STANDARD';
    });
  });
});
