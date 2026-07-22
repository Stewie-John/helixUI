import { promises as fs } from 'node:fs';
import path from 'node:path';

export function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveAllowingMissingPath(requestedPath) {
  let existingAncestor = requestedPath;
  const missingSegments = [];

  while (true) {
    try {
      const realAncestor = await fs.realpath(existingAncestor);
      return path.join(realAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

export async function resolvePathWithinRoot(rootPath, targetPath, { allowMissing = true } = {}) {
  const realRoot = await fs.realpath(path.resolve(rootPath));
  const requestedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(realRoot, targetPath);
  const resolvedPath = allowMissing
    ? await resolveAllowingMissingPath(requestedPath)
    : await fs.realpath(requestedPath);

  if (!isPathWithin(realRoot, resolvedPath)) {
    const error = new Error('Path is outside the allowed root');
    error.code = 'PATH_OUTSIDE_ROOT';
    throw error;
  }

  return { root: realRoot, path: resolvedPath };
}
