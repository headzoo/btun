#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadRC } = require('firebase-tools/lib/rc');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const { ensure } = require('firebase-tools/lib/ensureApiEnabled');
const { firebaseStorageOrigin } = require('firebase-tools/lib/api');
const { configstore } = require('firebase-tools/lib/configstore');
const { Client } = require('firebase-tools/lib/apiv2');
const { getDefaultBucket } = require('firebase-tools/lib/gcp/storage');

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
  await ensure(projectId, firebaseStorageOrigin(), 'storage', false);

  try {
    const bucket = await getDefaultBucket(projectId);
    console.log(`Firebase Storage already configured: ${bucket}`);
    return;
  } catch (error) {
    if (!String(error.message || error).includes('has not been set up')) {
      throw error;
    }
  }

  console.log(`Creating default Storage bucket for ${projectId}…`);
  const client = new Client({
    urlPrefix: firebaseStorageOrigin(),
    apiVersion: 'v1alpha',
  });
  const response = await client.post(`/projects/${projectId}/defaultBucket`, {
    location: 'US-CENTRAL1',
  });
  const bucketName = response.body?.bucket?.name?.split('/').pop();
  if (!bucketName) {
    throw new Error('Storage provisioning succeeded but no bucket name was returned.');
  }
  console.log(`Created: ${bucketName}`);
  console.log('');
  console.log('Update apps/desktop/.env.local if needed:');
  console.log(`  VITE_FIREBASE_STORAGE_BUCKET=${bucketName}`);
}

main().catch((error) => {
  const message = error.message || String(error);
  if (message.includes('BILLING') || message.includes('Blaze')) {
    console.error(
      'Firebase Storage requires the Blaze (pay-as-you-go) plan. Upgrade the project in the Firebase console, then retry.',
    );
  } else if (message.includes('403') || message.includes('permission')) {
    console.error(
      'Could not provision Storage automatically. Enable it once in the Firebase console:',
    );
    console.error('  https://console.firebase.google.com/project/buddy-tunnel/storage');
    console.error('');
    console.error(
      'New projects need the Blaze plan for API provisioning. After Storage is enabled, run:',
    );
    console.error('  pnpm firebase:deploy:rules');
  } else {
    console.error(message);
  }
  process.exit(1);
});
