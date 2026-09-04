import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/errors.js';
import { newId } from '../db/ids.js';

/**
 * File storage abstraction (§56).
 *
 *   StorageService.put(bytes, {societyId, category, filename, mimeType})
 *     → { key, url, size, checksum }
 *
 * Two providers behind one interface:
 *   `local` → `LOCAL_STORAGE_DIR/<societyId>/<category>/<yyyymm>/<id>.<ext>`
 *             served through an authenticated stream endpoint (never a public path)
 *   `s3`    → any S3-compatible object store (AWS S3, MinIO, DigitalOcean Spaces, Wasabi).
 *             The SDK is imported lazily so a local-only install does not need it.
 *
 * Large files are never stored inside the database — the record keeps a `storageKey` plus a
 * SHA-256 checksum used to detect tampering.
 */

export interface PutObjectInput {
  societyId: string;
  category: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  /** Optional explicit key (used for deterministic paths such as society logos). */
  key?: string;
  /** Public objects are served without an auth check (society logo, amenity photo). */
  isPublic?: boolean;
}

export interface StoredObject {
  key: string;
  url: string;
  sizeBytes: number;
  mimeType: string;
  checksum: string;
  storageProvider: 'local' | 's3';
  fileName: string;
  isPublic: boolean;
}

const ALLOWED_MIME = new Set(env.ALLOWED_UPLOAD_MIME.split(',').map((m) => m.trim().toLowerCase()));
const MAX_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;

/** Extension whitelist derived from the MIME allow-list (defence in depth vs MIME sniffing). */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** Reject content whose bytes do not match the claimed MIME type (magic-number check). */
function detectMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  const head = buffer.subarray(0, 12);
  const hex = head.toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (hex.startsWith('000000') && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (hex.startsWith('504b0304')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return null;
}

export function validateUpload(buffer: Buffer, declaredMime: string, filename: string): { mimeType: string; ext: string } {
  if (!buffer || buffer.length === 0) throw ApiError.badRequest('The uploaded file is empty', [], { field: 'file' });
  if (buffer.length > MAX_BYTES) {
    throw new ApiError(`File exceeds the ${env.MAX_UPLOAD_MB} MB limit`, 'UPLOAD_TOO_LARGE');
  }

  const declared = String(declaredMime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (!ALLOWED_MIME.has(declared)) {
    throw new ApiError(`File type "${declared || 'unknown'}" is not allowed`, 'UPLOAD_INVALID');
  }

  const sniffed = detectMime(buffer);
  const textish = new Set(['text/csv', 'application/vnd.ms-excel']);
  // ZIP-based (xlsx) and text (csv) formats have no reliable magic prefix we can assert here,
  // so for those we accept the declared type; for binary formats the bytes must agree.
  if (sniffed && sniffed !== declared) {
    throw new ApiError('File content does not match its declared type', 'UPLOAD_INVALID');
  }
  if (!sniffed && !textish.has(declared) && declared !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    throw new ApiError('Unrecognised file content. Upload a valid image, video, PDF or spreadsheet.', 'UPLOAD_INVALID');
  }

  // Reject filenames that try to escape the storage root or hide an executable.
  const base = path.basename(String(filename ?? 'upload')).replace(/[^\w.\-() ]/g, '_');
  const dangerous = /\.(php|phtml|js|mjs|cjs|sh|exe|bat|cmd|jsp|asp|aspx|svg|html|htm)$/i;
  if (dangerous.test(base)) throw new ApiError('This file type cannot be uploaded', 'UPLOAD_INVALID');

  const ext = EXT_BY_MIME[declared] ?? (declared.startsWith('image/') ? 'img' : 'bin');
  return { mimeType: declared, ext };
}

class LocalStorageProvider {
  readonly kind = 'local' as const;

  private root(): string {
    return env.LOCAL_STORAGE_DIR;
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root(), key);
    // Path traversal guard: the resolved path must stay inside the storage root.
    if (!full.startsWith(path.resolve(this.root()))) {
      throw ApiError.badRequest('Invalid storage key');
    }
    return full;
  }

  async put(input: PutObjectInput, ext: string): Promise<StoredObject> {
    const key = input.key ?? buildKey(input, ext);
    const full = this.resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, input.buffer);
    return {
      key,
      url: `/api/files/${key}`,
      sizeBytes: input.buffer.length,
      mimeType: input.mimeType,
      checksum: crypto.createHash('sha256').update(input.buffer).digest('hex'),
      storageProvider: 'local',
      fileName: path.basename(input.filename),
      isPublic: Boolean(input.isPublic),
    };
  }

  async getStream(key: string): Promise<{ stream: NodeJS.ReadableStream; size: number }> {
    const full = this.resolve(key);
    if (!fs.existsSync(full)) throw ApiError.notFound('File');
    const stat = await fsp.stat(full);
    return { stream: fs.createReadStream(full), size: stat.size };
  }

  async read(key: string): Promise<Buffer> {
    const full = this.resolve(key);
    if (!fs.existsSync(full)) throw ApiError.notFound('File');
    return fsp.readFile(full);
  }

  async remove(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async signedUrl(key: string, ttlSeconds = 300): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    const signature = crypto
      .createHmac('sha256', env.QR_SIGNING_SECRET)
      .update(`${key}:${expires}`)
      .digest('base64url');
    return `/api/files/${key}?expires=${expires}&sig=${signature}`;
  }

  verifySignedUrl(key: string, expires: string, signature: string): boolean {
    const expiry = Number(expires);
    if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
    const expected = crypto.createHmac('sha256', env.QR_SIGNING_SECRET).update(`${key}:${expires}`).digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}

class S3StorageProvider {
  readonly kind = 's3' as const;
  private clientPromise: Promise<any> | null = null;

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          const mod = await import('@aws-sdk/client-s3');
          return new mod.S3Client({
            region: env.S3_REGION,
            endpoint: env.S3_ENDPOINT || undefined,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
            credentials: { accessKeyId: env.S3_ACCESS_KEY ?? '', secretAccessKey: env.S3_SECRET_KEY ?? '' },
          });
        } catch (err) {
          throw new ApiError(
            'Object storage is not available: install @aws-sdk/client-s3 to use STORAGE_PROVIDER=s3',
            'DEPENDENCY_FAILED',
            { cause: err },
          );
        }
      })();
    }
    return this.clientPromise;
  }

  async put(input: PutObjectInput, ext: string): Promise<StoredObject> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    const key = input.key ?? buildKey(input, ext);
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: input.buffer,
        ContentType: input.mimeType,
        ServerSideEncryption: 'AES256',
        Metadata: { society: input.societyId, category: input.category },
      }),
    );
    const checksum = crypto.createHash('sha256').update(input.buffer).digest('hex');
    return {
      key,
      url: env.S3_PUBLIC_URL ? `${env.S3_PUBLIC_URL.replace(/\/$/, '')}/${key}` : `s3://${env.S3_BUCKET}/${key}`,
      sizeBytes: input.buffer.length,
      mimeType: input.mimeType,
      checksum,
      storageProvider: 's3',
      fileName: path.basename(input.filename),
      isPublic: Boolean(input.isPublic),
    };
  }

  async getStream(key: string): Promise<{ stream: NodeJS.ReadableStream; size: number }> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    const res = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return { stream: res.Body as NodeJS.ReadableStream, size: Number(res.ContentLength ?? 0) };
  }

  async read(key: string): Promise<Buffer> {
    const { stream } = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async remove(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }

  async signedUrl(key: string, ttlSeconds = 300): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.client();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: ttlSeconds });
  }

  verifySignedUrl(): boolean {
    // S3 presigned URLs are validated by S3 itself.
    return true;
  }
}

function buildKey(input: PutObjectInput, ext: string): string {
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const category = input.category.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'general';
  const society = input.societyId.replace(/[^a-z0-9_-]/gi, '') || 'platform';
  return `${society}/${category}/${yyyymm}/${newId('documents')}.${ext}`;
}

type Provider = LocalStorageProvider | S3StorageProvider;

class StorageService {
  private provider: Provider;

  constructor() {
    this.provider = env.STORAGE_PROVIDER === 's3' ? new S3StorageProvider() : new LocalStorageProvider();
  }

  get kind(): 'local' | 's3' {
    return this.provider.kind;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const { mimeType, ext } = validateUpload(input.buffer, input.mimeType, input.filename);
    const stored = await this.provider.put({ ...input, mimeType }, ext);
    logger.debug({ key: stored.key, size: stored.sizeBytes, provider: stored.storageProvider }, 'storage: object written');
    return stored;
  }

  getStream(key: string) {
    return this.provider.getStream(key);
  }

  read(key: string) {
    return this.provider.read(key);
  }

  remove(key: string) {
    return this.provider.remove(key);
  }

  signedUrl(key: string, ttlSeconds = 300) {
    return this.provider.signedUrl(key, ttlSeconds);
  }

  verifySignedUrl(key: string, expires: string, signature: string) {
    return this.provider.verifySignedUrl(key, expires, signature);
  }

  async ensureLocalRoot(): Promise<void> {
    if (this.provider.kind !== 'local') return;
    await fsp.mkdir(env.LOCAL_STORAGE_DIR, { recursive: true });
  }
}

export const storage = new StorageService();
export { LocalStorageProvider, S3StorageProvider, ALLOWED_MIME, MAX_BYTES };
