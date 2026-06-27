

import crypto from 'node:crypto';
import { logHelpers } from '../monitoring/logger.mjs';
import { getRedisClient, isRedisConnected, ensureRedisConnected } from '../scalability/redis.mjs';
import { sendWhatsAppText } from '../services/whatsapp.mjs';
import { recordOutboundMessage } from '../services/messages.mjs';

let Queue = null;
let Worker = null;
let QueueEvents = null;
let queue = null;
let dlq = null;

async function loadBullMq() {
  if (Queue) return true;
  try {
    const mod = await import('bullmq');
    Queue = mod.Queue;
    Worker = mod.Worker;
    QueueEvents = mod.QueueEvents;
    return true;
  } catch (e) {
    logHelpers.logBusinessEvent('queue_disabled', { reason: 'bullmq_missing' });
    return false;
  }
}

export async function initOutboundQueue() {
  // Idempotent: never create a second queue/worker for the same process.
  if (queue) return true;
  // Give Redis a chance to connect when it is explicitly enabled but the
  // (lazy) connection has not finished yet, e.g. during startup.
  if (!isRedisConnected() && String(process.env.REDIS_ENABLED || '').toLowerCase() === 'true') {
    try { await ensureRedisConnected(3000); } catch {}
  }
  if (!isRedisConnected()) {
    logHelpers.logBusinessEvent('queue_disabled', { reason: 'redis_not_connected' });
    return false;
  }
  const ok = await loadBullMq();
  if (!ok) return false;
  if (queue) return true;

  // Dedicated BullMQ connections — do NOT reuse getRedisClient() options wholesale.
  // The cache client sets commandTimeout: 5000, but Worker/QueueEvents use blocking
  // reads that wait indefinitely when idle; with a timeout ioredis throws
  // "Command timed out" every few seconds even though Redis is healthy.
  const connection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    maxRetriesPerRequest: null,
    ...(String(process.env.REDIS_TLS || '').toLowerCase() === 'true' ? { tls: {} } : {}),
  };
  queue = new Queue('outbound_messages', { connection });
  dlq = new Queue('outbound_messages_dlq', { connection });
  const concurrency = Number(process.env.QUEUE_CONCURRENCY || 5);
  const attempts = Number(process.env.QUEUE_ATTEMPTS || 5);
  const backoff = { type: 'exponential', delay: 1000 };

  const worker = new Worker('outbound_messages', async (job) => {
    const { userId, cfg, to, message, replyToMessageId } = job.data;
    try {
      const res = await sendWhatsAppText(to, message, cfg, replyToMessageId || null);
      const outboundId = res?.messages?.[0]?.id;
      if (outboundId) {
        await recordOutboundMessage({ messageId: outboundId, userId, cfg, to, type: 'text', text: message, raw: { to, text: message } });
      }
      return { outboundId };
    } catch (e) {
      throw e;
    }
  }, { connection, concurrency });

  worker.on('failed', async (job, err) => {
    try {
      await dlq.add('dead', job.data, { attempts: 1, removeOnComplete: true });
    } catch {}
    logHelpers.logError(err, { component: 'queue', operation: 'job_failed', jobId: job?.id });
  });

  worker.on('completed', (job, result) => {
    logHelpers.logBusinessEvent('queue_job_completed', { jobId: job?.id, result });
  });

  new QueueEvents('outbound_messages', { connection });
  logHelpers.logBusinessEvent('queue_initialized', { concurrency, attempts });
  return true;
}

export async function enqueueOutboundMessage(data) {
  if (!queue) {
    const ok = await initOutboundQueue();
    if (!ok) return false;
  }
  try {
    const attempts = Number(process.env.QUEUE_ATTEMPTS || 5);
    const idempotencyKey = data.idempotencyKey || data.replyToMessageId || data.messageId || crypto.randomUUID();
    const jobId = createDeterministicId(idempotencyKey);
    const job = await queue.add('send', data, {
      attempts,
      backoff: { type: 'exponential', delay: 1000 },
      jobId,
      removeOnComplete: true,
      removeOnFail: false
    });
    logHelpers.logBusinessEvent('queue_job_enqueued', { jobId: job.id });
    return job.id;
  } catch (e) {
    logHelpers.logError(e, { component: 'queue', operation: 'enqueue' });
    return false;
  }
}

function createDeterministicId(key) {
  return crypto.createHash('sha256').update(String(key || 'queue')).digest('hex');
}

export default {
  initOutboundQueue,
  enqueueOutboundMessage
};

