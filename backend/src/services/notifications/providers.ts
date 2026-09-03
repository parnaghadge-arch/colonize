import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/errors.js';

/**
 * Channel providers (§35).
 *
 * Every channel is an abstraction with a `console` implementation (used in development — it
 * logs exactly what would have been sent, and the API surfaces OTPs in `meta.devOtp` so flows
 * remain testable) plus real HTTP implementations that are used as soon as the matching
 * credentials are configured.
 *
 * Nothing here fabricates success: a provider that is not configured throws, and the
 * notification engine records the failure against the delivery attempt.
 */

export interface SendResult {
  provider: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  providerMessageId?: string;
  error?: string;
  sentAt: Date;
}

async function postJson(url: string, init: RequestInit & { json?: unknown }): Promise<{ ok: boolean; status: number; body: any }> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(headers as Record<string, string> | undefined) },
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { ok: res.ok, status: res.status, body };
}

function ok(provider: string, id?: string): SendResult {
  return { provider, status: 'SENT', providerMessageId: id, sentAt: new Date() };
}

function failed(provider: string, error: string): SendResult {
  return { provider, status: 'FAILED', error, sentAt: new Date() };
}

/* ---------------------------------- SMS ---------------------------------- */

export interface SmsInput {
  to: string;
  message: string;
  templateId?: string;
}

export const SmsProvider = {
  async send(input: SmsInput): Promise<SendResult> {
    const provider = env.SMS_PROVIDER;
    const to = input.to.startsWith('+') ? input.to : `+${input.to.replace(/^\D+/, '')}`;

    if (provider === 'console') {
      logger.info({ channel: 'sms', to, message: input.message }, 'sms(console): would send');
      return ok('console');
    }

    if (!env.SMS_API_KEY) return failed(provider, 'SMS_API_KEY is not configured');

    if (provider === 'twilio') {
      const accountSid = env.SMS_SENDER_ID;
      const res = await postJson(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${env.SMS_API_KEY}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: env.SMTP_FROM.includes('@') ? '' : env.SMS_SENDER_ID, Body: input.message }).toString(),
        },
      );
      return res.ok
        ? ok('twilio', (res.body as any)?.sid)
        : failed('twilio', `Twilio responded ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    }

    if (provider === 'msg91') {
      const res = await postJson('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: env.SMS_API_KEY },
        json: { flow_id: input.templateId ?? env.SMS_SENDER_ID, mobiles: to.replace('+', ''), OTP: input.message },
      });
      return res.ok ? ok('msg91') : failed('msg91', `MSG91 responded ${res.status}`);
    }

    if (provider === 'gupshup') {
      const res = await postJson('https://api.gupshup.io/sm/api/v1/msg', {
        method: 'POST',
        json: {
          msg: input.message,
          msg_type: 'text',
          sender: env.SMS_SENDER_ID,
          phone: to.replace('+', ''),
          api_key: env.SMS_API_KEY,
        },
      });
      return res.ok ? ok('gupshup') : failed('gupshup', `Gupshup responded ${res.status}`);
    }

    if (provider === 'textlocal') {
      const res = await postJson('https://api.textlocal.in/send/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          apikey: env.SMS_API_KEY,
          numbers: to.replace('+', ''),
          sender: env.SMS_SENDER_ID,
          message: input.message,
        }).toString(),
      });
      return res.ok ? ok('textlocal') : failed('textlocal', `Textlocal responded ${res.status}`);
    }

    return failed(provider, `SMS provider "${provider}" has no adapter implemented`);
  },
};

/* ---------------------------------- Email -------------------------------- */

export interface EmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export const EmailProvider = {
  async send(input: EmailInput): Promise<SendResult> {
    const provider = env.EMAIL_PROVIDER;

    if (provider === 'console') {
      logger.info({ channel: 'email', to: input.to, subject: input.subject }, 'email(console): would send');
      return ok('console');
    }

    if (provider === 'sendgrid') {
      if (!env.SMS_API_KEY) return failed('sendgrid', 'SENDGRID_API_KEY (SMS_API_KEY slot) is not configured');
      const res = await postJson('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SMS_API_KEY}` },
        json: {
          personalizations: [{ to: [{ email: input.to }] }],
          from: { email: (input.from ?? env.SMTP_FROM).replace(/^.*<|>$/g, '') },
          subject: input.subject,
          content: [
            { type: 'text/plain', value: input.text },
            ...(input.html ? [{ type: 'text/html', value: input.html }] : []),
          ],
        },
      });
      return res.ok || res.status === 202 ? ok('sendgrid') : failed('sendgrid', `SendGrid responded ${res.status}`);
    }

    if (provider === 'smtp') {
      try {
        const nodemailer = await import('nodemailer');
        const transport = nodemailer.default.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT ?? 587,
          secure: env.SMTP_PORT === 465,
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        });
        const info = await transport.sendMail({
          from: input.from ?? env.SMTP_FROM,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        return ok('smtp', info.messageId);
      } catch (err) {
        return failed('smtp', (err as Error).message);
      }
    }

    if (provider === 'ses') {
      return failed('ses', 'SES adapter requires @aws-sdk/client-sesv2; configure it and enable this provider');
    }

    return failed(provider, `Email provider "${provider}" has no adapter implemented`);
  },
};

/* ---------------------------------- Push --------------------------------- */

export interface PushInput {
  token: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android channel id / iOS interruption level. */
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  sound?: string;
  badge?: number;
}

export const PushProvider = {
  async send(input: PushInput): Promise<SendResult> {
    const provider = env.PUSH_PROVIDER;

    if (provider === 'console') {
      logger.info(
        { channel: 'push', token: `${input.token.slice(0, 8)}…`, title: input.title, body: input.body },
        'push(console): would send',
      );
      return ok('console');
    }

    if (provider === 'expo') {
      const res = await postJson('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        json: {
          to: input.token,
          title: input.title,
          body: input.body,
          data: input.data ?? {},
          sound: input.sound ?? 'default',
          badge: input.badge,
          priority: input.priority === 'CRITICAL' || input.priority === 'HIGH' ? 'high' : 'default',
          channelId: input.priority === 'CRITICAL' ? 'emergency' : 'default',
        },
      });
      const ticket = Array.isArray((res.body as any)?.data) ? (res.body as any).data[0] : undefined;
      return res.ok && ticket?.status === 'ok'
        ? ok('expo', ticket?.id)
        : failed('expo', `Expo push responded ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    }

    if (provider === 'fcm') {
      if (!env.FCM_SERVER_KEY) return failed('fcm', 'FCM_SERVER_KEY is not configured');
      const res = await postJson('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: { Authorization: `key=${env.FCM_SERVER_KEY}` },
        json: {
          to: input.token,
          priority: input.priority === 'HIGH' || input.priority === 'CRITICAL' ? 'high' : 'normal',
          notification: { title: input.title, body: input.body, sound: input.sound ?? 'default' },
          data: Object.fromEntries(Object.entries(input.data ?? {}).map(([k, v]) => [k, String(v)])),
        },
      });
      return res.ok
        ? ok('fcm', String((res.body as any)?.results?.[0]?.message_id ?? ''))
        : failed('fcm', `FCM responded ${res.status}`);
    }

    return failed(provider, `Push provider "${provider}" has no adapter implemented`);
  },

  /** Send to many tokens in one call (Expo supports batches of 100). */
  async sendMany(inputs: PushInput[]): Promise<SendResult[]> {
    if (env.PUSH_PROVIDER === 'expo' && inputs.length > 0) {
      const chunks: PushInput[][] = [];
      for (let i = 0; i < inputs.length; i += 100) chunks.push(inputs.slice(i, i + 100));
      const results: SendResult[] = [];
      for (const chunk of chunks) {
        const res = await postJson('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          json: chunk.map((i) => ({
            to: i.token,
            title: i.title,
            body: i.body,
            data: i.data ?? {},
            sound: i.sound ?? 'default',
            priority: i.priority === 'HIGH' || i.priority === 'CRITICAL' ? 'high' : 'default',
          })),
        });
        results.push(res.ok ? ok('expo') : failed('expo', `Expo push responded ${res.status}`));
      }
      return results;
    }
    return Promise.all(inputs.map((i) => PushProvider.send(i)));
  },
};

/* -------------------------------- WhatsApp ------------------------------- */

export interface WhatsAppInput {
  to: string;
  message: string;
  templateName?: string;
  templateParams?: string[];
}

/** WhatsApp is integration-ready (§35): configure WHATSAPP_PROVIDER to switch it on. */
export const WhatsAppProvider = {
  async send(input: WhatsAppInput): Promise<SendResult> {
    const provider = env.WHATSAPP_PROVIDER;
    if (provider === 'disabled') return { provider: 'disabled', status: 'SKIPPED', sentAt: new Date() };
    if (provider === 'console') {
      logger.info({ channel: 'whatsapp', to: input.to, message: input.message }, 'whatsapp(console): would send');
      return ok('console');
    }
    const to = input.to.replace(/[^\d]/g, '');

    if (provider === 'meta_cloud') {
      if (!env.FCM_SERVER_KEY) return failed('meta_cloud', 'META_WHATSAPP_TOKEN (FCM_SERVER_KEY slot) is not configured');
      const phoneId = env.FCM_PROJECT_ID;
      const res = await postJson(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.FCM_SERVER_KEY}` },
        json: input.templateName
          ? {
              messaging_product: 'whatsapp',
              to,
              type: 'template',
              template: {
                name: input.templateName,
                language: { code: 'en' },
                components: input.templateParams?.length
                  ? [{ type: 'body', parameters: input.templateParams.map((t) => ({ type: 'text', text: t })) }]
                  : undefined,
              },
            }
          : { messaging_product: 'whatsapp', to, type: 'text', text: { body: input.message } },
      });
      return res.ok ? ok('meta_cloud', String((res.body as any)?.messages?.[0]?.id ?? '')) : failed('meta_cloud', `Meta responded ${res.status}`);
    }

    if (provider === 'twilio') {
      const accountSid = env.SMS_SENDER_ID;
      if (!env.SMS_API_KEY) return failed('twilio', 'TWILIO_AUTH_TOKEN (SMS_API_KEY slot) is not configured');
      const res = await postJson(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${env.SMS_API_KEY}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: `whatsapp:${to}`, From: 'whatsapp:+14155238886', Body: input.message }).toString(),
      });
      return res.ok ? ok('twilio', (res.body as any)?.sid) : failed('twilio', `Twilio responded ${res.status}`);
    }

    if (provider === 'gupshup') {
      if (!env.SMS_API_KEY) return failed('gupshup', 'GUPSHUP_API_KEY (SMS_API_KEY slot) is not configured');
      const res = await postJson('https://api.gupshup.io/wa/api/v1/sendMessage', {
        method: 'POST',
        headers: { apikey: env.SMS_API_KEY },
        json: { source: env.SMS_SENDER_ID, destination: to, message: { type: 'text', text: input.message } },
      });
      return res.ok ? ok('gupshup') : failed('gupshup', `Gupshup responded ${res.status}`);
    }

    return failed(provider, `WhatsApp provider "${provider}" has no adapter implemented`);
  },
};

/** Fail loudly when a caller expects a configured provider that is not wired up. */
export function assertProviderConfigured(channel: 'sms' | 'email' | 'push' | 'whatsapp'): void {
  const provider = {
    sms: env.SMS_PROVIDER,
    email: env.EMAIL_PROVIDER,
    push: env.PUSH_PROVIDER,
    whatsapp: env.WHATSAPP_PROVIDER,
  }[channel];
  if (provider === 'console' && env.NODE_ENV === 'production') {
    throw new ApiError(
      `${channel.toUpperCase()} delivery is not configured for production. Set the ${channel.toUpperCase()}_PROVIDER environment variable.`,
      'DEPENDENCY_FAILED',
    );
  }
}
