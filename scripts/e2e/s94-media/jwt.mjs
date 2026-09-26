// Minimal HS256 JWT helpers for the local S94 Media stack (never used against
// a hosted project). `node jwt.mjs anon|service_role` prints a key.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function sign(payload, secret = process.env.E2E_JWT_SECRET) {
  if (!secret) throw new Error('E2E_JWT_SECRET is not set');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const mac = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${mac}`;
}

export function verify(token, secret = process.env.E2E_JWT_SECRET) {
  const [head, body, mac] = String(token || '').split('.');
  if (!head || !body || !mac) return null;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

const LONG = 4102444800; // 2100-01-01
export const anonKey = (secret) => sign({ role: 'anon', iss: 'supabase-e2e', iat: 1700000000, exp: LONG }, secret);
export const serviceKey = (secret) => sign({ role: 'service_role', iss: 'supabase-e2e', iat: 1700000000, exp: LONG }, secret);

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const role = process.argv[2];
  process.stdout.write(role === 'service_role' ? serviceKey() : anonKey());
}
