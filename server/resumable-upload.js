import { Server as TusServer } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { promises as fs } from 'node:fs';

const uploadError = (status, message) => ({
    status_code: status,
    body: message,
});

const getOwnerId = (request) => {
    const authorization = request.headers.get('authorization') || '';
    return authorization.startsWith('HelixOwner ')
        ? authorization.slice('HelixOwner '.length)
        : '';
};

export async function createResumableUploadHandler({
    endpoint,
    storageDirectory,
    maxSizeBytes,
    validateUpload,
    finishUpload,
}) {
    await fs.mkdir(storageDirectory, { recursive: true });
    const datastore = new FileStore({ directory: storageDirectory });

    const server = new TusServer({
        path: endpoint,
        datastore,
        maxSize: maxSizeBytes,
        relativeLocation: true,
        disableTerminationForFinishedUploads: true,
        async onIncomingRequest(request, uploadId) {
            const ownerId = getOwnerId(request);
            if (!ownerId) {
                throw uploadError(401, 'Authentication required');
            }

            if (uploadId && request.method !== 'POST') {
                const existing = await datastore.getUpload(uploadId);
                if (existing.metadata?.ownerId !== ownerId) {
                    throw uploadError(403, 'This upload belongs to another account');
                }
            }
        },
        async onUploadCreate(request, upload) {
            const ownerId = getOwnerId(request);
            if (!ownerId) {
                throw uploadError(401, 'Authentication required');
            }

            const metadata = await validateUpload({
                metadata: upload.metadata || {},
                ownerId,
                size: upload.size,
            });
            return { metadata: { ...metadata, ownerId } };
        },
        async onUploadFinish(_request, upload) {
            const result = await finishUpload(upload);
            return {
                headers: {
                    'X-Helix-Upload-Path': encodeURIComponent(result.path || ''),
                    'X-Helix-Upload-Skipped': result.skipped ? '1' : '0',
                },
            };
        },
    });

    return async (req, res) => {
        req.setTimeout(0);
        await server.handle(req, res);
    };
}
