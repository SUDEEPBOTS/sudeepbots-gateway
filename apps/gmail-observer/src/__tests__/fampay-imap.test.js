import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { BankEmailParser, isAuthorizedBankEmailSender } from '../parser.js';
import { isOfficialPaymentSender } from '../imap-poller.js';

describe('FamPay Automated IMAP Verification Suite', () => {
  let apiInstance;
  let gmailInstance;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6196, testDb);
    gmailInstance = await startGmailObserver(6096, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });
  });

  after(async () => {
    await gmailInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  beforeEach(() => {
    if (gmailInstance?.poller?.processedMessageIds) {
      gmailInstance.poller.processedMessageIds.clear();
    }
  });

  describe('FamPay Sender & Parser Validation', () => {
    test('authorizes official FamPay sender domains and rejects fake senders', () => {
      assert.equal(isAuthorizedBankEmailSender('no-reply@famapp.in'), true);
      assert.equal(isAuthorizedBankEmailSender('FamPay <alerts@fampay.in>'), true);
      assert.equal(isAuthorizedBankEmailSender('support@famapp.co.in'), true);
      assert.equal(isOfficialPaymentSender('no-reply@famapp.in'), true);
      assert.equal(isOfficialPaymentSender('FamPay Updates <noreply@fampay.in>'), true);

      // Rejects spoofed senders
      assert.equal(isAuthorizedBankEmailSender('fampay-support@gmail.com'), false);
      assert.equal(isAuthorizedBankEmailSender('hacker@tempmail.com'), false);
      assert.equal(isOfficialPaymentSender('fampay@gmail.com'), false);
    });

    test('correctly parses FamPay credit notification with UTR and Transaction ID', () => {
      const email = {
        subject: 'You received ₹75.00 from Aryan Sharma',
        body: 'You received ₹75.00 from Aryan Sharma on your FamPay account merchant@fam.\nTransaction ID: FAM9876543210\nUTR: 428192837192\nDate: 27-Oct-2026',
        from: 'no-reply@famapp.in',
        date: new Date()
      };

      const parsed = BankEmailParser.parse(email);
      assert.ok(parsed, 'Email should be parsed successfully');
      assert.equal(parsed.amountPaise, 7500n);
      assert.equal(parsed.amount, '75.00');
      assert.equal(parsed.bankReferenceNumber, '428192837192');
      assert.equal(parsed.isBankDomain, true);
    });

    test('correctly parses FamPay notification with only Transaction ID', () => {
      const email = {
        subject: 'Payment of ₹150 received',
        body: 'You received ₹150 from Rohan Verma. Transaction ID: FAM1234567890.',
        from: 'no-reply@famapp.in',
        date: new Date()
      };

      const parsed = BankEmailParser.parse(email);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 15000n);
      assert.equal(parsed.amount, '150');
      assert.equal(parsed.bankReferenceNumber, 'FAM1234567890');
    });
  });

  describe('End-to-End Automatic Checkout Verification (No APK, No Customer UTR Input)', () => {
    test('Automatically settles active checkout session when FamPay credit email arrives', async () => {
      const uniqueMsgId = `fampay_e2e_${Date.now()}`;
      const uniqueUtr = `${Math.floor(100000000000 + Math.random() * 900000000000)}`;

      // 1. Customer initiates an order on checkout portal
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: `FAMPAY-ORD-${Date.now()}`,
        amountPaise: 7500n // ₹75.00
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // Session is in ACTIVE or PROCESSING status waiting for payment
      const initialSession = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.ok([PaymentStatus.ACTIVE, PaymentStatus.PROCESSING].includes(initialSession.status));

      // 2. Customer pays on FamPay UPI -> FamPay sends confirmation email to merchant Gmail
      // The IMAP Poller ingests the email automatically (no manual customer UTR input needed!)
      const result = await gmailInstance.poller.processEmail({
        id: uniqueMsgId,
        messageId: uniqueMsgId,
        subject: 'You received ₹75.00 from Aryan Sharma',
        body: `You received ₹75.00 from Aryan Sharma on your FamPay account. UTR: ${uniqueUtr} Transaction ID: FAM987654321`,
        from: 'no-reply@famapp.in',
        date: new Date()
      });

      // 3. Automated reconciliation verifies payment & attributes to session
      assert.ok(result);
      assert.equal(result.accepted, true);
      assert.equal(result.attribution.attributed, true);
      assert.equal(result.attribution.paymentSessionId, session.id);

      // 4. Session in database is marked as successfully completed!
      const updatedSession = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(updatedSession.status, PaymentStatus.OBSERVED_SUCCESS);
    });

    test('Duplicate Protection: Same FamPay email or UTR cannot settle a second session', async () => {
      const fixedMsgId = `fampay_dup_${Date.now()}`;
      const fixedUtr = `${Math.floor(100000000000 + Math.random() * 900000000000)}`;

      // 1. First session
      const session1 = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: `FAMPAY-ORD-1-${Date.now()}`,
        amountPaise: 5000n
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session1.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session1.id);

      // Settle session 1
      const res1 = await gmailInstance.poller.processEmail({
        id: fixedMsgId,
        messageId: fixedMsgId,
        subject: 'You received ₹50.00 from Rohit',
        body: `You received ₹50.00 from Rohit. UTR: ${fixedUtr}`,
        from: 'no-reply@famapp.in',
        date: new Date()
      });
      assert.equal(res1.accepted, true);

      // 2. Second session created later
      const session2 = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: `FAMPAY-ORD-2-${Date.now()}`,
        amountPaise: 5000n
      });
      apiInstance.app.context.queueEngine.enqueueOrActivate(session2.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session2.id);

      // Replaying identical message ID is dropped at poller layer
      const dupMsgResult = await gmailInstance.poller.processEmail({
        id: fixedMsgId,
        messageId: fixedMsgId,
        subject: 'You received ₹50.00 from Rohit',
        body: `You received ₹50.00 from Rohit. UTR: ${fixedUtr}`,
        from: 'no-reply@famapp.in',
        date: new Date()
      });
      assert.equal(dupMsgResult.accepted, false);
      assert.equal(dupMsgResult.duplicate, true);

      // Replaying the same UTR with a different message ID is rejected at pipeline layer
      try {
        await gmailInstance.poller.processEmail({
          id: `new_msg_${Date.now()}`,
          messageId: `new_msg_${Date.now()}`,
          subject: 'You received ₹50.00 from Rohit',
          body: `You received ₹50.00 from Rohit. UTR: ${fixedUtr}`,
          from: 'no-reply@famapp.in',
          date: new Date()
        });
        assert.fail('Should have thrown error on reused UTR');
      } catch (err) {
        assert.ok(
          err.message.includes('REFERENCE_ALREADY_USED') ||
          err.message.includes('DUPLICATE_OBSERVATION') ||
          err.message.includes('REJECTED')
        );
      }

      // Verify second session was NOT completed
      const session2State = apiInstance.app.context.sessionRepo.findById(session2.id);
      assert.notEqual(session2State.status, PaymentStatus.OBSERVED_SUCCESS);
    });
  });
});
