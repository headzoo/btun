#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadRC } = require('firebase-tools/lib/rc');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const { ensure } = require('firebase-tools/lib/ensureApiEnabled');
const { rtdbManagementOrigin } = require('firebase-tools/lib/api');
const { configstore } = require('firebase-tools/lib/configstore');
const {
  createInstance,
  getDatabaseInstanceDetails,
  DatabaseLocation,
  DatabaseInstanceType,
} = require('firebase-tools/lib/management/database');
const { getDefaultDatabaseInstance } = require('firebase-tools/lib/getDefaultDatabaseInstance');

const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const rc = loadRC({ cwd: repoRoot });
  const projectId = rc.resolveAlias(process.argv[2] || 'default');
  const options = {
    cwd: repoRoot,
    rc,
    projectId,
    project: projectId,
    user: configstore.get('user'),
    tokens: configstore.get('tokens'),
  };

  await requireAuth(options);

  await ensure(projectId, rtdbManagementOrigin(), 'database', false);

  const existing = await getDefaultDatabaseInstance(projectId);
  if (existing) {
    const details = await getDatabaseInstanceDetails(projectId, existing);
    console.log(`Realtime Database already exists: ${details.databaseUrl}`);
    return;
  }

  const instanceName = `${projectId}-default-rtdb`;
  console.log(`Creating default Realtime Database (${instanceName}) in us-central1…`);
  const created = await createInstance(
    projectId,
    instanceName,
    DatabaseLocation.US_CENTRAL1,
    DatabaseInstanceType.DEFAULT_DATABASE,
  );
  console.log(`Created: ${created.databaseUrl}`);
  console.log('');
  console.log('Update apps/desktop/.env.local if needed:');
  console.log(`  VITE_FIREBASE_DATABASE_URL=${created.databaseUrl}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
