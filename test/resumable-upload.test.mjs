import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createResumableUploadHandler } from '../server/resumable-upload.js';

const encodeMetadata = (metadata) => Object.entries(metadata)
  .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
  .join(',');

test('resumable uploads preserve offsets and enforce account ownership', async () => {
  const artifactRoot = path.resolve(
    'trash',
    'test-artifacts',
    `resumable-${Date.now()}-${process.pid}`,
  );
  await mkdir(artifactRoot, { recursive: true });

  let finishCount = 0;
  const handler = await createResumableUploadHandler({
    endpoint: '/files',
    storageDirectory: artifactRoot,
    maxSizeBytes: 4 * 1024 * 1024,
    validateUpload: async ({ metadata, ownerId }) => ({ ...metadata, ownerId }),
    finishUpload: async (upload) => {
      finishCount += 1;
      return { path: upload.storage.path, skipped: false };
    },
  });

  const server = http.createServer(async (req, res) => {
    const internalAuthorization = `HelixOwner ${req.headers.authorization || ''}`;
    req.headers.authorization = internalAuthorization;
    const authorizationIndex = req.rawHeaders.findIndex(
      (header) => header.toLowerCase() === 'authorization',
    );
    if (authorizationIndex >= 0) {
      req.rawHeaders[authorizationIndex + 1] = internalAuthorization;
    } else {
      req.rawHeaders.push('Authorization', internalAuthorization);
    }
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const commonHeaders = {
    Authorization: 'account-a',
    'Tus-Resumable': '1.0.0',
  };

  try {
    const createResponse = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Upload-Length': String(2 * 1024 * 1024),
        'Upload-Metadata': encodeMetadata({ filename: 'large.bin' }),
      },
    });
    assert.equal(createResponse.status, 201);
    const uploadUrl = new URL(createResponse.headers.get('location'), baseUrl);

    const firstChunk = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
      },
      body: Buffer.alloc(1024 * 1024, 1),
      duplex: 'half',
    });
    assert.equal(firstChunk.status, 204);
    assert.equal(firstChunk.headers.get('upload-offset'), String(1024 * 1024));
    assert.equal(finishCount, 0);

    const resumedHead = await fetch(uploadUrl, {
      method: 'HEAD',
      headers: commonHeaders,
    });
    assert.equal(resumedHead.status, 200);
    assert.equal(resumedHead.headers.get('upload-offset'), String(1024 * 1024));

    const foreignHead = await fetch(uploadUrl, {
      method: 'HEAD',
      headers: { ...commonHeaders, Authorization: 'account-b' },
    });
    assert.equal(foreignHead.status, 403);

    const secondChunk = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(1024 * 1024),
      },
      body: Buffer.alloc(1024 * 1024, 2),
      duplex: 'half',
    });
    assert.equal(secondChunk.status, 204);
    assert.equal(secondChunk.headers.get('upload-offset'), String(2 * 1024 * 1024));
    assert.equal(finishCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
