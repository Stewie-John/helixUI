import { promises as fs } from 'node:fs';
import path from 'node:path';

// 项目名 / 会话 ID 只能命名单个目录项，绝不能是一段路径。
// 必须在 path.join 之前拦截：Express 会解码 %2F，`..%2F..%2Fhome` 一旦拼接
// 就会逃出它本应受限的根目录。
export function isSafePathSegment(segment) {
  return typeof segment === 'string'
    && segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('\0')
    && !segment.includes('/')
    && !segment.includes('\\')
    && path.basename(segment) === segment;
}

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
