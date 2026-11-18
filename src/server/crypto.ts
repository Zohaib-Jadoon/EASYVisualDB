import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const KEY_PATH = path.join(DATA_DIR, '.vds-master.key');

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const envKey = process.env.VDS_MASTER_KEY;
  if (envKey && envKey.length >= 32) {
    cachedKey = crypto.createHash('sha256').update(envKey).digest();
    return cachedKey;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_PATH)) {
    const raw = fs.readFileSync(KEY_PATH, 'utf8').trim();
    cachedKey = Buffer.from(raw, 'hex');
    if (cachedKey.length === 32) return cachedKey;
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, generated.toString('hex'), { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted credential payload.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(/(password|pwd|secret|token|apikey|api_key)\s*[:=]\s*[^\s;,&"']+/gi, '$1=[REDACTED]')
    .replace(/Server=[^;]+;.*?Password=[^;]+;/gi, '[REDACTED_CONNECTION_STRING]');
}
