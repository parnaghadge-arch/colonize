import { z } from 'zod';
import { deviceInfoSchema, emailSchema, idSchema, passwordSchema, phoneSchema } from './common.js';

/** Channel used to deliver an OTP. FCM push is the primary channel per §7. */
export const OTP_CHANNELS = ['FCM', 'SMS', 'EMAIL', 'WHATSAPP', 'CONSOLE'] as const;

export const sendOtpSchema = z.object({
  phone: phoneSchema,
  channel: z.enum(OTP_CHANNELS).default('FCM'),
  /** Purpose keeps OTPs single-use per flow (login vs password reset vs verification). */
  purpose: z.enum(['LOGIN', 'PASSWORD_RESET', 'PHONE_VERIFY', 'STEP_UP']).default('LOGIN'),
  device: deviceInfoSchema.optional(),
  /** Optional: society the user expects to sign into (helps pick the right tenant DB). */
  societySlug: z.string().trim().max(80).optional(),
});
export type SendOtpInput = z.infer<typeof sendOtpSchema>;

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  otp: z.string().trim().regex(/^\d{4,8}$/, 'Enter the 6-digit code'),
  purpose: z.enum(['LOGIN', 'PASSWORD_RESET', 'PHONE_VERIFY', 'STEP_UP']).default('LOGIN'),
  device: deviceInfoSchema.optional(),
  newPassword: passwordSchema.optional(),
});
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const loginPasswordSchema = z.object({
  identifier: z.string().trim().min(3).max(160),
  password: z.string().min(1).max(128),
  device: deviceInfoSchema.optional(),
});
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).max(4000),
  device: deviceInfoSchema.optional(),
});
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
}).refine((v) => v.phone || v.email, { message: 'Provide a mobile number or email address' });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(4000),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const selectSocietySchema = z.object({ societyId: idSchema });
export type SelectSocietyInput = z.infer<typeof selectSocietySchema>;

export const logoutSchema = z.object({
  /** When true, every active session for the user is revoked (§74 "logout from all devices"). */
  allDevices: z.boolean().default(false),
  refreshToken: z.string().max(4000).optional(),
});
export type LogoutInput = z.infer<typeof logoutSchema>;

export const appPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits'),
  enableBiometric: z.boolean().default(false),
});
export type AppPinInput = z.infer<typeof appPinSchema>;

export const verifyAppPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/),
  biometricToken: z.string().max(2000).optional(),
});
