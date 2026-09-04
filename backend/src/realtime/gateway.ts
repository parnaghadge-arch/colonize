import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { corsOrigins, env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../services/tokenService.js';
import { databases } from '../db/manager.js';

/**
 * Real-time gateway (§3 "Socket.IO for real-time features", §35 real-time notifications).
 *
 * Rooms
 * -----
 *   society:<id>          every connected client of a society
 *   user:<id>             one specific user (notifications, visitor approval requests)
 *   unit:<id>             everyone linked to a unit
 *   security:<id>         all guards + supervisors of a society
 *   gate:<id>             guards currently logged into a specific gate
 *   admins:<id>           society management console users
 *   platform              super-admin consoles
 *
 * The handshake authenticates with the same JWT the REST API uses, and the socket is bound to
 * the society from the token — a client can never subscribe to another society's rooms.
 */

export interface RealtimePayload {
  event: string;
  data: Record<string, unknown>;
}

let io: Server | null = null;

export function initRealtime(httpServer: HttpServer): Server {
  if (io) return io;

  const origin = corsOrigins();
  io = new Server(httpServer, {
    path: '/realtime',
    cors: { origin: origin === '*' ? true : origin, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.query?.token as string | undefined) ??
        parseBearer(socket.handshake.headers?.authorization);
      if (!token) return next(new Error('Authentication required'));

      const claims = verifyAccessToken(token);
      socket.data.principal = { userId: claims.sub, scope: claims.scope, roles: claims.rol ?? [] };
      socket.data.societyId = claims.soc ?? null;
      socket.data.sessionId = claims.sid ?? null;

      if (claims.scope === 'tenant' && claims.soc) {
        const society = await loadSocietyLite(claims.soc);
        if (!society || (society.status !== 'ACTIVE' && society.status !== 'ONBOARDING')) {
          return next(new Error('Society is not active'));
        }
        const handle = await databases.forSociety(society);
        const user = await handle.db.collection('users').findById(claims.sub);
        if (!user || user.status !== 'ACTIVE') return next(new Error('Account is not active'));
        socket.data.user = {
          id: String(user._id),
          roles: Array.isArray(user.roles) ? user.roles : [],
          unitIds: [],
          gateIds: [],
        };
        const [members, guards] = await Promise.all([
          handle.db.collection('unit_members').find({ societyId: society.id, userId: user._id, isActive: true }, { limit: 100 }),
          handle.db.collection('guard_assignments').find({ societyId: society.id, userId: user._id, isActive: true }, { limit: 50 }),
        ]);
        socket.data.user.unitIds = members.map((m) => String(m.unitId));
        socket.data.user.gateIds = guards.map((g) => String(g.gateId));
      } else if (claims.scope === 'platform') {
        const platform = await databases.platform();
        const user = await platform.collection('platform_users').findById(claims.sub);
        if (!user || user.status !== 'ACTIVE') return next(new Error('Account is not active'));
        socket.data.user = { id: String(user._id), roles: Array.isArray(user.roles) ? user.roles : [], unitIds: [], gateIds: [] };
      } else {
        return next(new Error('Invalid token scope'));
      }

      return next();
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'realtime: handshake rejected');
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const societyId = socket.data.societyId as string | null;
    const user = socket.data.user as { id: string; roles: string[]; unitIds: string[]; gateIds: string[] };

    if (societyId) {
      void socket.join(`society:${societyId}`);
      void socket.join(`user:${user.id}`);
      for (const unitId of user.unitIds) void socket.join(`unit:${societyId}:${unitId}`);

      const isSecurity = user.roles.some((r) => r === 'SECURITY_GUARD' || r === 'SECURITY_SUPERVISOR');
      const isConsole = user.roles.some((r) =>
        ['SOCIETY_ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE_MEMBER', 'FACILITY_MANAGER', 'ACCOUNTANT', 'RECEPTIONIST'].includes(r),
      );
      if (isSecurity) {
        void socket.join(`security:${societyId}`);
        for (const gateId of user.gateIds) void socket.join(`gate:${societyId}:${gateId}`);
        // A guard with no explicit assignment listens to every gate room lazily via security:*.
        void socket.join(`gate:${societyId}:*`);
      }
      if (isConsole) void socket.join(`admins:${societyId}`);
    } else {
      void socket.join('platform');
      void socket.join(`user:${user.id}`);
    }

    socket.on('gate:join', (gateId: unknown) => {
      if (!societyId || typeof gateId !== 'string') return;
      // Guards may only join gates they are assigned to (or all, when unassigned).
      const allowed = user.gateIds.length === 0 || user.gateIds.includes(gateId);
      if (allowed) void socket.join(`gate:${societyId}:${gateId}`);
    });

    socket.on('gate:leave', (gateId: unknown) => {
      if (!societyId || typeof gateId !== 'string') return;
      void socket.leave(`gate:${societyId}:${gateId}`);
    });

    socket.on('ping:app', (_payload, ack?: (res: unknown) => void) => {
      if (typeof ack === 'function') ack({ pong: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: user.id, reason }, 'realtime: disconnected');
    });
  });

  logger.info('realtime: Socket.IO gateway initialised on /realtime');
  return io;
}

function parseBearer(header?: string): string | undefined {
  if (!header) return undefined;
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
}

async function loadSocietyLite(societyId: string): Promise<{ id: string; slug: string; databaseName: string; status: string } | null> {
  const db = await databases.platform();
  const doc = await db.collection('societies').findById(societyId);
  if (!doc) return null;
  return { id: String(doc._id), slug: String(doc.slug), databaseName: String(doc.databaseName), status: String(doc.status) };
}

export type RealtimeRoom =
  | { kind: 'society'; societyId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'unit'; societyId: string; unitId: string }
  | { kind: 'security'; societyId: string }
  | { kind: 'admins'; societyId: string }
  | { kind: 'gate'; societyId: string; gateId: string }
  | { kind: 'allGates'; societyId: string }
  | { kind: 'platform' };

function roomName(room: RealtimeRoom): string {
  switch (room.kind) {
    case 'society':
      return `society:${room.societyId}`;
    case 'user':
      return `user:${room.userId}`;
    case 'unit':
      return `unit:${room.societyId}:${room.unitId}`;
    case 'security':
      return `security:${room.societyId}`;
    case 'admins':
      return `admins:${room.societyId}`;
    case 'gate':
      return `gate:${room.societyId}:${room.gateId}`;
    case 'allGates':
      return `gate:${room.societyId}:*`;
    case 'platform':
      return 'platform';
    default:
      return 'unknown';
  }
}

/** Emit to one or more rooms. No-op when realtime is disabled (e.g. in unit tests). */
export function emit(rooms: RealtimeRoom | RealtimeRoom[], payload: RealtimePayload): void {
  if (!env.REALTIME_ENABLED || !io) return;
  const list = Array.isArray(rooms) ? rooms : [rooms];
  for (const room of list) {
    try {
      io.to(roomName(room)).emit(payload.event, payload.data);
    } catch (err) {
      logger.warn({ err, room: roomName(room), event: payload.event }, 'realtime: emit failed');
    }
  }
}

export function emitToUsers(userIds: string[], payload: RealtimePayload): void {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return;
  emit(unique.map((userId) => ({ kind: 'user' as const, userId })), payload);
}

export function emitToUnits(societyId: string, unitIds: string[], payload: RealtimePayload): void {
  const unique = Array.from(new Set(unitIds.filter(Boolean)));
  emit(unique.map((unitId) => ({ kind: 'unit' as const, societyId, unitId })), payload);
}

export async function connectedClients(): Promise<number> {
  if (!io) return 0;
  const sockets = await io.fetchSockets();
  return sockets.length;
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}

export function realtimeEnabled(): boolean {
  return Boolean(io) && env.REALTIME_ENABLED;
}
