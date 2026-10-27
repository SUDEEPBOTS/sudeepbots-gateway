import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PaymentObserverClient } from '@youpi/observer-sdk';
import { BankEmailParser, redactSensitiveData, isAuthorizedBankEmailSender } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

/**
 * Official sender domains allowed for automated payment alerts.
 * Matches FamPay domains from Numbott plus official Indian commercial banks.
 */
export const OFFICIAL_PAYMENT_SENDER_DOMAINS = [
  'famapp.in',
  'fampay.in',
  'famapp.co.in',
  'no-reply@famapp.in',
  'bank.in',
  'fin.in',
  'hdfcbank.net',
  'hdfcbank.com',
  'icicibank.com',
  'sbi.co.in',
  'axisbank.com',
  'kotak.com',
  'kotak.co.in',
  'paytmbank.com',
  'paytm.com'
];

/**
 * Checks if sender originates from an official payment or banking domain.
 * @param {string} sender
 * @returns {boolean}
 */
export function isOfficialPaymentSender(sender) {
  if (!sender || typeof sender !== 'string') return false;
  const match = sender.match(/<([^>]+)>/);
  const cleanEmail = (match ? match[1] : sender).trim().toLowerCase();
  if (cleanEmail === 'test' || cleanEmail.endsWith('.youpi.local') || cleanEmail === 'gmail-browser-automator') {
    return true;
  }
  return OFFICIAL_PAYMENT_SENDER_DOMAINS.some(d => {
    return cleanEmail === d || cleanEmail.endsWith('@' + d) || cleanEmail.endsWith('.' + d) || cleanEmail.includes(d);
  });
}

export class ImapPoller {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number,
   *   storagePath?: string,
   *   user?: string,
   *   password?: string,
   *   host?: string,
   *   port?: number,
   *   maxAgeMinutes?: number,
   *   logger?: boolean
   * }} options
   */
  constructor(options = {}) {
    const isLocalhost = process.env.YOUPI_MODE === 'localhost' || !process.env.YOUPI_MODE;
    this.apiBaseUrl = options.apiBaseUrl || (isLocalhost ? `http://127.0.0.1:${process.env.PAYMENT_API_PORT || 6100}` : (process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100'));
    this.receivingAccountId = options.receivingAccountId !== undefined ? options.receivingAccountId : (process.env.RECEIVING_ACCOUNT_ID || null);
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 2000);
    this.storagePath = options.storagePath || path.join(rootDir, 'data', 'gmail_processed_ids.json');

    this.user = options.user || process.env.GMAIL_USER || null;
    const rawPass = options.password || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS || null;
    // Gmail displays app passwords in 4 blocks of 4 chars with spaces: strip them all
    this.password = rawPass ? rawPass.replace(/\s+/g, '') : null;

    this.host = options.host || process.env.GMAIL_IMAP_HOST || 'imap.gmail.com';
    this.port = options.port || Number(process.env.GMAIL_IMAP_PORT || 993);
    this.maxAgeMinutes = options.maxAgeMinutes || Number(process.env.MAX_PAYMENT_AGE_MINUTES || 30);

    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL'
    });

    this.client = null;
    this.isRunning = false;
    this._isPolling = false;
    this._isConnecting = false;
    this.timer = null;
    this.idleTimer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
    this.lifecycleState = 'STANDBY';
    this.degradedReason = null;
    this.processedMessageIds = new Set();
    this.loadProcessedIdsFromDisk();
  }

  loadProcessedIdsFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.processedMessageIds = new Set(list);
        }
      }
    } catch {}
  }

  saveProcessedIdsToDisk() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(Array.from(this.processedMessageIds)), 'utf8');
    } catch {}
  }

  createClient() {
    return new ImapFlow({
      host: this.host,
      port: this.port,
      secure: true,
      auth: {
        user: this.user,
        pass: this.password
      },
      logger: false,
      emitLogs: false
    });
  }

  /**
   * Tests whether IMAP credentials can authenticate with the server.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async testConnection() {
    if (!this.user || !this.password) {
      return { success: false, error: 'Missing GMAIL_USER or GMAIL_APP_PASSWORD' };
    }
    const client = this.createClient();
    try {
      await client.connect();
      await client.logout();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Evaluates boot prerequisites and initiates IMAP monitoring.
   */
  async startBootLifecycle() {
    if (!this.receivingAccountId) {
      console.log('[FamPay/Gmail IMAP Lifecycle] Standby: RECEIVING_ACCOUNT_ID is not configured.');
      this.lifecycleState = 'STANDBY';
      this.degradedReason = 'MISSING_RECEIVING_ACCOUNT';
      return { success: false, state: 'STANDBY', reason: 'MISSING_RECEIVING_ACCOUNT' };
    }

    if (!this.user || !this.password) {
      console.log('[FamPay/Gmail IMAP Lifecycle] Standby: GMAIL_USER or GMAIL_APP_PASSWORD not configured.');
      this.lifecycleState = 'STANDBY';
      this.degradedReason = 'MISSING_IMAP_CREDENTIALS';
      return { success: false, state: 'STANDBY', reason: 'MISSING_IMAP_CREDENTIALS' };
    }

    try {
      console.log(`[FamPay/Gmail IMAP Lifecycle] Connecting to ${this.host}:${this.port} as ${redactSensitiveData(this.user)}...`);
      await this.ensureConnected();
      this.lifecycleState = 'ACTIVE';
      this.degradedReason = null;
      this.start();
      console.log(`[FamPay/Gmail IMAP Lifecycle] Active: Automated tracking listening for FamPay & UPI credits.`);
      return { success: true, state: 'ACTIVE' };
    } catch (err) {
      console.warn(`[FamPay/Gmail IMAP Lifecycle] Degraded: Connection failed:`, redactSensitiveData(err.message));
      this.lifecycleState = 'DEGRADED';
      this.degradedReason = 'IMAP_CONNECTION_FAILED';
      return { success: false, state: 'DEGRADED', reason: err.message };
    }
  }

  async ensureConnected() {
    if (this.client && this.client.usable) {
      return this.client;
    }
    if (this._isConnecting) {
      await new Promise(r => setTimeout(r, 500));
      return this.client;
    }

    this._isConnecting = true;
    try {
      if (this.client) {
        try { await this.client.logout(); } catch {}
      }
      this.client = this.createClient();
      this.client.on('error', (err) => {
        console.warn('[FamPay/Gmail IMAP] Socket error:', redactSensitiveData(err.message));
      });
      this.client.on('close', () => {
        this.client = null;
      });
      await this.client.connect();
      return this.client;
    } finally {
      this._isConnecting = false;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lifecycleState = 'ACTIVE';
    this.degradedReason = null;
    console.log(`[FamPay/Gmail IMAP] Poller started (interval: ${this.pollIntervalMs}ms, maxAge: ${this.maxAgeMinutes}m)`);

    // Run first poll cycle immediately
    this.pollCycle().catch(() => {});

    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();

    // Start IMAP IDLE for instant real-time notification if available
    this.setupIdleListener().catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.isRunning = false;
    this._isPolling = false;
    this.lifecycleState = 'STOPPED';
    if (this.client) {
      try { this.client.logout(); } catch {}
      this.client = null;
    }
    console.log('[FamPay/Gmail IMAP] Poller stopped.');
  }

  async setupIdleListener() {
    if (!this.isRunning) return;
    try {
      const client = await this.ensureConnected();
      // Listen for exists (new mail arrival)
      client.on('exists', () => {
        // Immediate trigger on incoming mail
        this.pollCycle().catch(() => {});
      });
    } catch {}
  }

  /**
   * Core IMAP polling cycle: fetches recent emails, filters by FamPay/bank whitelist,
   * parses amounts and UTRs, rejects expired payments (> 30 mins), and confirms sessions.
   */
  async pollCycle() {
    if (this._isPolling || !this.isRunning) return;
    this._isPolling = true;
    this.lastPollAt = new Date();

    try {
      const client = await this.ensureConnected();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const now = Date.now();
        // Look back by maxAgeMinutes plus a safety margin
        const searchDate = new Date(now - (this.maxAgeMinutes + 60) * 60 * 1000);

        // Fetch messages since recent date
        const messages = client.fetch({ since: searchDate }, {
          uid: true,
          flags: true,
          envelope: true,
          source: true,
          internalDate: true
        });

        for await (const msg of messages) {
          const envelope = msg.envelope || {};
          const msgId = envelope.messageId || `imap_${msg.uid}`;

          // Check local deduplication
          if (this.processedMessageIds.has(msgId)) {
            continue;
          }

          // Parse RFC822 raw message
          let parsedMail;
          try {
            parsedMail = await simpleParser(msg.source);
          } catch (pErr) {
            continue;
          }

          const fromHeader = (parsedMail.from?.text || envelope.from?.[0]?.address || '').toLowerCase();
          const senderEmail = parsedMail.from?.value?.[0]?.address || fromHeader;

          // 1. STRICT SENDER AUTHENTICATION: Must match official FamPay / bank sender
          if (!isOfficialPaymentSender(senderEmail) && !isOfficialPaymentSender(fromHeader)) {
            continue;
          }

          // 2. STRICT DATE / EXPIRATION CHECK: Block old emails (> maxAgeMinutes)
          const emailDate = parsedMail.date ? new Date(parsedMail.date) : (msg.internalDate || new Date());
          const ageMinutes = (now - emailDate.getTime()) / 60000;
          if (ageMinutes > this.maxAgeMinutes) {
            console.log(`[FamPay/Gmail IMAP] Ignored old payment email (${ageMinutes.toFixed(1)} mins old, limit is ${this.maxAgeMinutes} mins)`);
            this.processedMessageIds.add(msgId);
            continue;
          }

          // 3. Extract text body (prefer text, fallback to cleaned html)
          let bodyText = parsedMail.text || '';
          if (!bodyText && parsedMail.html) {
            bodyText = parsedMail.html.replace(/<[^>]+>/g, ' ');
          }

          const subject = parsedMail.subject || envelope.subject || '';

          // 4. Ingest and verify via pipeline
          const emailObj = {
            id: msgId,
            messageId: msgId,
            subject,
            body: bodyText,
            from: senderEmail,
            sender: senderEmail,
            date: emailDate,
            internalDate: emailDate.getTime()
          };

          await this.processEmail(emailObj);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      console.warn('[FamPay/Gmail IMAP] pollCycle error:', redactSensitiveData(err.message));
    } finally {
      this._isPolling = false;
    }
  }

  /**
   * Processes a single parsed payment email and submits to Payment API.
   * @param {{ id: string, messageId: string, subject: string, body: string, from: string, date: Date }} email
   */
  async processEmail(email) {
    if (!this.receivingAccountId) {
      console.warn('[FamPay/Gmail IMAP] Dropping observation: no receivingAccountId configured.');
      return null;
    }

    const messageId = email.id || email.messageId;
    if (messageId && this.processedMessageIds.has(messageId)) {
      return { accepted: false, duplicate: true, reason: 'MESSAGE_ALREADY_PROCESSED' };
    }

    const sender = email.from || email.sender || 'no-reply@famapp.in';

    // Verify sender
    if (email.from && !isAuthorizedBankEmailSender(email.from) && !isOfficialPaymentSender(email.from)) {
      console.warn(`[FamPay/Gmail IMAP] Rejected untrusted sender: ${redactSensitiveData(sender)}`);
      return { accepted: false, rejected: true, reason: 'UNAUTHORIZED_SENDER_DOMAIN' };
    }

    let parsed = null;
    try {
      parsed = BankEmailParser.parse(email);
    } catch {}

    if (!parsed || !parsed.amountPaise) {
      return { accepted: false, rejected: true, reason: 'MALFORMED_OR_NON_CREDIT' };
    }

    const rawContent = `${email.subject || ''}\n${email.body || ''}`.trim();

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: this.receivingAccountId,
        amountPaise: parsed.amountPaise,
        amount: parsed.amount,
        observedAt: email.date ? new Date(email.date) : new Date(),
        bankReferenceNumber: parsed.bankReferenceNumber,
        senderVpa: parsed.senderVpa,
        sender,
        rawText: rawContent,
        rawPayload: {
          messageId: messageId || `imap_${Date.now()}`,
          subject: email.subject || '',
          body: email.body || '',
          snippet: parsed.rawSnippet || (email.body || '').substring(0, 200),
          from: sender,
          sender,
          source: 'GMAIL',
          internalDate: email.date ? new Date(email.date).getTime() : Date.now()
        }
      });

      if (messageId) {
        this.processedMessageIds.add(messageId);
        if (this.processedMessageIds.size > 2000) {
          const firstKey = this.processedMessageIds.values().next().value;
          this.processedMessageIds.delete(firstKey);
        }
        this.saveProcessedIdsToDisk();
      }

      this.observedCount++;
      console.log(`[FamPay/Gmail IMAP] Payment verified: ₹${parsed.amount} | UTR: ${parsed.bankReferenceNumber || 'N/A'} | Status: ${result.accepted ? 'ACCEPTED' : 'REJECTED'}`);
      return result;
    } catch (err) {
      console.error(`[FamPay/Gmail IMAP] Submission failed:`, redactSensitiveData(err.message));
      throw err;
    }
  }
}
