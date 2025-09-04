// Simple in-memory store with TTL; clears itself after expiry.
// NOT for secrets at rest; only short-lived signature buffers.
const store = new Map(); // key: recordId, val: { buf: Buffer, exp: number }

const TTL_MS = 15 * 60 * 1000; // 15 minutes

export function putSig(recordId, buf) {
  const exp = Date.now() + TTL_MS;
  store.set(recordId, { buf, exp });
  setTimeout(() => {
    const v = store.get(recordId);
    if (v && v.exp <= Date.now()) store.delete(recordId);
  }, TTL_MS + 1000);
}

export function getSig(recordId) {
  const v = store.get(recordId);
  if (!v) return null;
  if (v.exp <= Date.now()) {
    store.delete(recordId);
    return null;
  }
  return v.buf;
}

export function delSig(recordId) {
  store.delete(recordId);
}
