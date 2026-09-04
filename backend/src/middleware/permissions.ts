import type { NextFunction, Request, Response } from 'express';
import type { ModuleKey } from '@colonize/shared';
import { ApiError } from '../utils/errors.js';
import { hasPermission } from './context.js';
import { requireContext } from './authenticate.js';

/**
 * Authorisation guards (§6, §42, §51).
 *
 * Every protected route composes these in this order:
 *   authenticate()  →  requirePermission('visitor:create')  →  requireModule('visitorManagement')
 *
 * Each guard re-checks against the *resolved* context, never against client-supplied values.
 */

/** Caller must hold at least one of the given permissions. */
export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = requireContext(req);
      const allowed = permissions.some((p) => hasPermission(ctx, p));
      if (!allowed) {
        throw ApiError.forbidden(
          `You do not have permission to perform this action (requires: ${permissions.join(' or ')}).`,
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Caller must hold *all* of the given permissions. */
export function requireAllPermissions(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = requireContext(req);
      const missing = permissions.filter((p) => !hasPermission(ctx, p));
      if (missing.length > 0) {
        throw ApiError.forbidden(`Missing permission(s): ${missing.join(', ')}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Caller must hold one of the given roles. */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = requireContext(req);
      if (!roles.some((r) => ctx.principal.roles.includes(r))) {
        throw ApiError.forbidden(`This action requires one of the following roles: ${roles.join(', ')}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Platform-console routes only (super admin panel). */
export function requirePlatform(req: Request, _res: Response, next: NextFunction): void {
  try {
    const ctx = requireContext(req);
    if (!ctx.principal.isPlatformUser) throw ApiError.forbidden('Platform administrator access required');
    next();
  } catch (err) {
    next(err);
  }
}

/** Society-console routes only. */
export function requireTenant(req: Request, _res: Response, next: NextFunction): void {
  try {
    const ctx = requireContext(req);
    if (ctx.principal.isPlatformUser) throw ApiError.forbidden('Use the platform console for this action');
    if (!ctx.society) throw ApiError.forbidden('No society context', 'TENANT_MISMATCH');
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Subscription/module gating (§42, §81.21).
 * A module that is not part of the society's plan returns a clear 403 — the UI hides it too,
 * so the two stay consistent.
 */
export function requireModule(moduleKey: ModuleKey | string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = requireContext(req);
      if (ctx.principal.isPlatformUser) return next();
      if (ctx.enabledModules.size === 0) {
        // No subscription record yet (society still onboarding) — allow, the society service
        // blocks real usage until activation.
        return next();
      }
      if (!ctx.enabledModules.has(moduleKey)) throw ApiError.moduleDisabled(String(moduleKey));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Family members only get what their member record allows (§9). */
export function requireFamilyPermission(key: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = requireContext(req);
      if (!ctx.principal.roles.includes('FAMILY_MEMBER')) return next();
      const allowed = ctx.membership.familyPermissions?.[key];
      if (!allowed) {
        throw ApiError.forbidden(
          'Your access in this household does not include this action. Ask the primary member to enable it.',
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Guards must be assigned to the gate they are operating (empty assignment = all gates). */
export function requireGateAccess(resolveGateId: (req: Request) => string | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = requireContext(req);
      if (!ctx.principal.isSecurityScope) return next();
      const gateId = resolveGateId(req);
      if (!gateId) return next();
      if (ctx.membership.gateIds.length === 0) return next();
      if (!ctx.membership.gateIds.includes(gateId)) {
        throw ApiError.forbidden('You are not assigned to this gate');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
