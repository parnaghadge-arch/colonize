/**
 * Ambient declarations for *optional* runtime dependencies.
 *
 * These packages are only needed when the corresponding provider is selected via env
 * (STORAGE_PROVIDER=s3, EMAIL_PROVIDER=smtp). They are loaded with a dynamic import and a
 * clear error is raised when missing, so a default local install stays small.
 */
declare module 'nodemailer';
declare module '@aws-sdk/client-s3';
declare module '@aws-sdk/s3-request-presigner';
