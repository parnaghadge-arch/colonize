/**
 * @colonize/shared
 *
 * Single source of truth for the domain vocabulary of the Colonize platform:
 * roles & permissions, enums, API contract types, Zod validation schemas and pure utils.
 * Consumed by the Express API, both React web consoles and both Expo mobile apps so a
 * status string, permission key or validation rule is never defined twice.
 */
export * as constants from './constants/index.js';
export * as types from './types/index.js';
export * as validation from './validation/index.js';
export * as utils from './utils/index.js';

export * from './constants/index.js';
export * from './types/index.js';
export * from './utils/index.js';
