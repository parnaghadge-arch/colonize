/**
 * Module-local schema surface.
 *
 * Schemas are authored once in `@colonize/shared/validation` so the web and mobile clients
 * validate with exactly the same rules the API enforces. This file re-exports the subset the
 * auth module needs, which keeps router imports short and makes the module's contract
 * explicit and greppable.
 */
export { z } from 'zod';
export {
  sendOtpSchema,
  verifyOtpSchema,
  loginPasswordSchema,
  refreshTokenSchema,
  selectSocietySchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  logoutSchema,
  appPinSchema,
  verifyAppPinSchema,
  deviceInfoSchema,
} from '@colonize/shared/validation';
