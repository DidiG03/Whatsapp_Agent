#!/usr/bin/env node

/**
 * MongoDB migration/cleanup script
 * - Merges legacy pluralized collections into their canonical versions
 * - Moves user_settings.dashboard_preferences into settings_multi
 *
 * Safe to run multiple times (idempotent).
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_agent';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'whatsapp_agent';

function log(msg, ctx = {}) {
  const meta = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : '';
  console.log(`[migrate] ${msg}${meta}`);
}

async function mergeCollections(db, sourceName, targetName, keyFn) {
  const source = db.collection(sourceName);
  const target = db.collection(targetName);
  const exists = await source.countDocuments();
  if (!exists) {
    log(`skip ${sourceName} -> ${targetName} (no docs)`);
    return { upserts: 0 };
  }
  log(`migrating ${sourceName} -> ${targetName}`, { count: exists });
  const cursor = source.find({});
  let upserts = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const filter = keyFn(doc);
    const { _id, ...rest } = doc;
    const res = await target.updateOne(filter, { $set: rest, $setOnInsert: { createdAt: doc.createdAt || new Date() } }, { upsert: true });
    if (res.upsertedCount || res.modifiedCount) upserts += 1;
  }
  log(`migrated ${sourceName} -> ${targetName}`, { upserts });
  return { upserts };
}

async function migratePreferences(db) {
  const legacy = db.collection('user_settings');
  const cnt = await legacy.countDocuments();
  if (!cnt) {
    log('skip user_settings -> settings_multi (no docs)');
    return { moved: 0 };
  }
  log('migrating user_settings -> settings_multi', { count: cnt });
  const cursor = legacy.find({});
  let moved = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const userId = String(doc.user_id);
    const prefs = doc.dashboard_preferences || null;
    await db.collection('settings_multi').updateOne(
      { user_id: userId },
      { $set: { user_id: userId, dashboard_preferences: prefs } },
      { upsert: true }
    );
    moved += 1;
  }
  log('migrated user_settings -> settings_multi', { moved });
  return { moved };
}

async function main() {
  const dropOld = process.argv.includes('--drop-old') || process.env.DROP_OLD_COLLECTIONS === '1';
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB_NAME);

  log('connected', { db: MONGODB_DB_NAME, dropOld });

  // 1) Merge pluralized legacy collections
  const merges = [
    ['handoffs', 'handoff', (d) => ({ user_id: String(d.user_id), contact_id: String(d.contact_id) })],
    ['contact_states', 'contact_state', (d) => ({ user_id: String(d.user_id), contact_id: String(d.contact_id) })],
    ['onboarding_states', 'onboarding_state', (d) => ({ user_id: String(d.user_id) })],
  ];
  for (const [src, dst, key] of merges) {
    await mergeCollections(db, src, dst, key);
    if (dropOld) {
      try {
        const exists = await db.listCollections({ name: src }).hasNext();
        if (exists) {
          await db.collection(src).drop();
          log('dropped legacy collection', { name: src });
        }
      } catch (err) {
        console.warn(`[migrate] failed to drop ${src}: ${err?.message || err}`);
      }
    }
  }

  // 2) Move dashboard preferences into settings_multi
  await migratePreferences(db);
  if (dropOld) {
    try {
      const exists = await db.listCollections({ name: 'user_settings' }).hasNext();
      if (exists) {
        await db.collection('user_settings').drop();
        log('dropped legacy collection', { name: 'user_settings' });
      }
    } catch (err) {
      console.warn(`[migrate] failed to drop user_settings: ${err?.message || err}`);
    }
  }

  log('done');
  await client.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[migrate] failed', err);
    process.exit(1);
  });
}

export default main;


