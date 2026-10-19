import { isAbsolute, relative, resolve, sep } from "node:path";

/** Whether `path` is the root itself or a descendant of `root`. */
export function isPathWithin(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

/** Same containment check while requiring an actual descendant. */
export function isDescendantPath(root: string, path: string): boolean {
  return resolve(root) !== resolve(path) && isPathWithin(root, path);
}
