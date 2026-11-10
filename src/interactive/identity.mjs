import {createHash} from 'node:crypto';

export function sha256Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected immutable program byte snapshot');
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export function assertSha256(hash) {
  if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError('Invalid SHA-256 identity');
  }
  return hash;
}
