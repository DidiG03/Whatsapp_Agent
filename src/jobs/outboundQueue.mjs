/**
 * Outbound message queue using BullMQ with DLQ.
 * Always enabled; falls back to direct send only if queue bootstrap fails.
 */

import crypto from 'node:crypto';
import { logHelpers } from '../monitoring/logger.mjs';
import { getRedisClient, isRedisConnected } from '../scalability/redis.mjs';
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
  if (!isRedisConnected()) {
    logHelpers.logBusinessEvent('queue_disabled', { reason: 'redis_not_connected' });
    return false;
  }
  const ok = await loadBullMq();
  if (!ok) return false;

  const connection = getRedisClient()?.options || {};
  queue = new Queue('outbound_messages', { connection });
  dlq = new Queue('outbound_messages_dlq', { connection });

  // Worker
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


