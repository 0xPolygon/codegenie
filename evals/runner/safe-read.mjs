import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

// Verify that the file opened is the regular file that was inspected.
export function readCheckedFile(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = fstatSync(fd), expected = lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink() || !actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('file changed while opening');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
