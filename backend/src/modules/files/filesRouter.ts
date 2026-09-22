import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { authenticate, requirePlatformContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { permission } from '@colonize/shared';
import { z } from 'zod';
import { storage, validateUpload, MAX_BYTES } from '../../services/storage.js';
import { ApiError } from '../../utils/errors.js';
import { newId } from '../../db/ids.js';
import { logger } from '../../config/logger.js';

/**
 * Files (§56): the single place objects stored by `services/storage.ts` are served from.
 *
 * Two concerns:
 *
 * 1. **GET /api/files/<key>** — stream a stored object.
 *    - Public categories (society logos, amenity photos) are served unauthenticated: the
 *      resident and guard apps render society logos without a token, so a logo must not
 *      require one.
 *    - Everything else needs a **signed URL** (expires + HMAC) or a platform principal.
 *
 * 2. **POST /api/platform/uploads/logo** — society logo upload (onboarding and the Profile
 *    tab). Any aspect ratio is accepted; the server centre-crops to a square and stores the
 *    square, so every client displays the same 1:1 image regardless of what was uploaded.
 */

/** Categories that are public by design (rendered by unauthenticated mobile screens). */
const PUBLIC_KEY_PREFIXES = ['logos/'];
const isPublicKey = (key: string) => PUBLIC_KEY_PREFIXES.some((p) => key.startsWith(p));

const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const filesRouter: Router = Router();

filesRouter.get(
  '/*splat',
  asyncHandler(async (req, res) => {
    // Express 5 hands a `/*splat` match as an array of path segments ("logos", "x.png").
    const raw = req.params.splat;
    const key = (Array.isArray(raw) ? raw.join('/') : String(raw ?? '')).replace(/^\/+/, '');
    if (!key || key.includes('..')) throw ApiError.badRequest('Invalid file key');

    // Public categories (logos) need no token; anything else must be signed or platform.
    if (!isPublicKey(key)) {
      const { expires, sig } = req.query as { expires?: string; sig?: string };
      if (typeof expires === 'string' && typeof sig === 'string' && storage.verifySignedUrl(key, expires, sig)) {
        // fall through to serving
      } else {
        const auth = await authenticate({ optional: true })(req, res, () => undefined);
        void auth;
        const ctx = (req as unknown as { principal?: { isPlatformUser?: boolean } }).principal;
        if (!ctx?.isPlatformUser) throw ApiError.forbidden('This file requires a signed link');
      }
    }

    const { stream, size } = await storage.getStream(key);
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    res.setHeader('Content-Type', EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', isPublicKey(key) ? 'public, max-age=31536000, immutable' : 'private, no-store');
    stream.pipe(res);
  }),
);

/* ------------------------------- logo upload -------------------------------- */

/** Square side (px) every logo is normalised to before storage. */
export const LOGO_SIZE = 512;

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(MAX_BYTES, 5 * 1024 * 1024), files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new ApiError('Upload a JPG, PNG or WebP image', 'UPLOAD_INVALID'));
  },
});

const uploadLogoBody = z
  .object({
    filename: z.string().trim().max(200).optional(),
  })
  .partial();

export const platformUploadsRouter: Router = Router();

platformUploadsRouter.post(
  '/logo',
  authenticate(),
  requirePermission(permission('society', 'manage')),
  logoUpload.single('logo'),
  validate(uploadLogoBody, 'body'),
  asyncHandler(async (req, res) => {
    requirePlatformContext(req);
    const file = req.file;
    if (!file) throw ApiError.badRequest('A logo image is required', [], { field: 'logo' });

    const declared = String(req.headers['content-type'] ?? '');
    const { mimeType } = validateUpload(file.buffer, file.mimetype, file.originalname);
    void declared;

    // Any aspect ratio in → square out. `fit: 'cover'` centre-crops to the requested square,
    // so a wide banner, a tall screenshot and a circle all become the same 1:1 image.
    const source = sharp(file.buffer, { failOn: 'error' });
    const meta = await source.metadata();
    if (!meta.width || !meta.height) throw new ApiError('Not a readable image', 'UPLOAD_INVALID');

    const outFormat = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpeg';
    const outMime = outFormat === 'png' ? 'image/png' : outFormat === 'webp' ? 'image/webp' : 'image/jpeg';
    const outExt = outFormat === 'png' ? 'png' : outFormat === 'webp' ? 'webp' : 'jpg';

    const cropped = await sharp(file.buffer)
      .rotate() // honour EXIF orientation so phone photos aren't stored sideways
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'cover' })
      .toFormat(outFormat, { quality: 88 })
      .toBuffer();

    const key = `logos/${newId('logo')}.${outExt}`;
    const stored = await storage.put({
      societyId: 'platform',
      category: 'logos',
      filename: String(req.body?.filename ?? file.originalname ?? 'logo'),
      mimeType: outMime,
      buffer: cropped,
      key,
      isPublic: true,
    });

    logger.info(
      { key, width: LOGO_SIZE, height: LOGO_SIZE, from: `${meta.width}x${meta.height}`, original: mimeType },
      'logo: uploaded and normalised to square',
    );

    res.status(201).json({
      success: true,
      message: 'Logo stored as a square',
      data: { url: stored.url, key: stored.key, width: LOGO_SIZE, height: LOGO_SIZE, sizeBytes: stored.sizeBytes },
      meta: { requestId: (req as unknown as { id?: string }).id },
    });
  }),
);
