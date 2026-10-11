const path = require('path');
const admin = require('firebase-admin');

let bucket;

function configured() {
  return Boolean(
    process.env.FIREBASE_STORAGE_BUCKET
    && (process.env.FIREBASE_SERVICE_ACCOUNT || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY))
  );
}

function storageBucket() {
  if (!configured()) {
    const error = new Error('Firebase Storage is not configured. Set FIREBASE_STORAGE_BUCKET and the service account in the API environment.');
    error.status = 503;
    throw error;
  }
  if (!bucket) {
    const credential = process.env.FIREBASE_SERVICE_ACCOUNT
      ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      : admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      });
    admin.initializeApp({
      credential,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    bucket = admin.storage().bucket();
  }
  return bucket;
}

async function uploadObject({ buffer, contentType, originalName, folder }) {
  const store = storageBucket();
  const ext = path.extname(originalName || '').toLowerCase();
  const objectPath = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
  const file = store.file(objectPath);
  await file.save(buffer, {
    resumable: false,
    metadata: { contentType: contentType || 'application/octet-stream' },
  });
  try {
    await file.makePublic();
    return {
      url: `https://storage.googleapis.com/${store.name}/${encodeURI(objectPath)}`,
      storagePath: objectPath,
    };
  } catch {
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10,
    });
    return { url, storagePath: objectPath };
  }
}

async function deleteObject(storagePath) {
  if (!storagePath || !configured()) return;
  await storageBucket().file(storagePath).delete({ ignoreNotFound: true });
}

module.exports = { configured, uploadObject, deleteObject };
