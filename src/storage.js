const crypto = require('crypto');
const path = require('path');
const admin = require('firebase-admin');
const biz = require('./business');

let bucket;
let signature = '';

function value(dbKey, envKey) {
  const stored = biz.setting(dbKey, '');
  return stored || process.env[envKey] || '';
}

function currentConfig() {
  return {
    bucket: value('firebase_bucket', 'FIREBASE_STORAGE_BUCKET'),
    projectId: value('firebase_project_id', 'FIREBASE_PROJECT_ID'),
    clientEmail: value('firebase_client_email', 'FIREBASE_CLIENT_EMAIL'),
    privateKey: value('firebase_private_key', 'FIREBASE_PRIVATE_KEY'),
    serviceAccount: value('firebase_service_account', 'FIREBASE_SERVICE_ACCOUNT'),
  };
}

function configured() {
  const config = currentConfig();
  return Boolean(config.bucket && (config.serviceAccount || (config.projectId && config.clientEmail && config.privateKey)));
}

function publicStatus() {
  const config = currentConfig();
  return {
    configured: configured(),
    bucket: config.bucket,
    projectId: config.projectId,
    clientEmail: config.clientEmail,
    hasPrivateKey: Boolean(config.privateKey || config.serviceAccount),
  };
}

function storageBucket() {
  const config = currentConfig();
  if (!configured()) {
    const error = new Error('Firebase Storage is not configured. Open Firebase in the desk and save the bucket and service account.');
    error.status = 503;
    throw error;
  }
  const next = JSON.stringify(config);
  if (bucket && signature === next) return bucket;
  const credential = config.serviceAccount
    ? admin.credential.cert(JSON.parse(config.serviceAccount))
    : admin.credential.cert({
      projectId: config.projectId,
      clientEmail: config.clientEmail,
      privateKey: String(config.privateKey).replace(/\\n/g, '\n'),
    });
  const app = admin.initializeApp({
    credential,
    storageBucket: config.bucket,
  }, `goldstore-${Date.now()}`);
  bucket = app.storage().bucket();
  signature = next;
  return bucket;
}

async function uploadObject({ buffer, contentType, originalName, folder }) {
  const store = storageBucket();
  const ext = path.extname(originalName || '').toLowerCase();
  const objectPath = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
  const file = store.file(objectPath);
  const downloadToken = crypto.randomUUID();
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: contentType || 'application/octet-stream',
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });
  return {
    url: `https://firebasestorage.googleapis.com/v0/b/${store.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`,
    storagePath: objectPath,
  };
}

async function readObject(storagePath) {
  const [buffer] = await storageBucket().file(storagePath).download();
  const [metadata] = await storageBucket().file(storagePath).getMetadata();
  return { buffer, contentType: metadata.contentType || 'application/octet-stream' };
}

async function deleteObject(storagePath) {
  if (!storagePath || !configured()) return;
  await storageBucket().file(storagePath).delete({ ignoreNotFound: true });
}

module.exports = { configured, publicStatus, uploadObject, readObject, deleteObject };
