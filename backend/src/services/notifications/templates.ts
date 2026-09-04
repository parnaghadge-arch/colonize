import type { NotificationChannel, NotificationEvent, NotificationPriority } from '@colonize/shared';

/**
 * Built-in notification templates (§55 "notification templates must be configurable").
 *
 * These are the *fallbacks*. Resolution order at send time:
 *   society override (`notification_templates` in the tenant DB)
 *     → platform default (`notification_templates` in the platform DB)
 *       → this file
 *
 * Variables use `{{camelCase}}` and are substituted from the `data` payload. A missing
 * variable renders as an empty string rather than the literal placeholder.
 */

export interface NotificationTemplate {
  title: string;
  body: string;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  deepLink?: string;
}

export const BUILT_IN_TEMPLATES: Partial<Record<NotificationEvent, NotificationTemplate>> = {
  VISITOR_ARRIVED: {
    title: 'Visitor at the gate',
    body: '{{visitorName}} is at {{gateName}} to meet you. Purpose: {{purpose}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://visitors/{{visitorId}}',
  },
  VISITOR_AT_GATE: {
    title: 'Visitor waiting at the gate',
    body: '{{visitorName}} is at the gate for {{unit}}. Purpose: {{purpose}}. Respond within {{autoExpireMinutes}} minutes or the request expires.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://visitors/{{visitorId}}/approve',
  },
  VISITOR_APPROVED: {
    title: 'Visitor approved',
    body: '{{residentName}} approved {{visitorName}} at {{gateName}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://visitors/{{visitorId}}',
  },
  VISITOR_REJECTED: {
    title: 'Visitor denied entry',
    body: '{{residentName}} denied entry to {{visitorName}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://visitors/{{visitorId}}',
  },
  VISITOR_ENTERED: {
    title: 'Visitor entered',
    body: '{{visitorName}} entered the premises through {{gate}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  VISITOR_EXITED: {
    title: 'Visitor exited',
    body: '{{visitorName}} left the premises at {{exitTime}}.',
    channels: ['IN_APP'],
    priority: 'LOW',
  },
  VISITOR_PRE_APPROVED: {
    title: 'Visitor pass ready',
    body: 'Your pass for {{visitorName}} on {{visitDate}} is ready. Share the QR code with them.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://visitors/{{visitorId}}/pass',
  },
  DELIVERY_ARRIVED: {
    title: 'Delivery at the gate',
    body: '{{company}} delivery for you is at {{gateName}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://deliveries/{{deliveryId}}',
  },
  DELIVERY_APPROVED: {
    title: 'Delivery approved',
    body: 'A {{company}} delivery has been allowed to {{unitLabel}}.',
    channels: ['IN_APP'],
    priority: 'NORMAL',
  },
  DELIVERY_REJECTED: {
    title: 'Delivery denied',
    body: 'The {{company}} delivery for {{unitLabel}} was denied entry.',
    channels: ['IN_APP'],
    priority: 'NORMAL',
  },
  CAB_ARRIVED: {
    title: 'Cab at the gate',
    body: '{{cabType}} {{vehicleNumber}} has arrived for {{unitLabel}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
  },
  STAFF_ARRIVED: {
    title: 'Staff arrived',
    body: '{{staffName}} ({{staffType}}) has entered the premises.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  STAFF_ATTENDANCE: {
    title: 'Staff attendance marked',
    body: '{{staffName}} was marked {{status}} for {{date}}.',
    channels: ['IN_APP'],
    priority: 'LOW',
  },
  COMPLAINT_CREATED: {
    title: 'New complaint {{referenceNumber}}',
    body: '{{category}} — {{title}} raised for {{unitLabel}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://complaints/{{complaintId}}',
  },
  COMPLAINT_ASSIGNED: {
    title: 'Complaint assigned',
    body: '{{referenceNumber}} has been assigned to {{assigneeName}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://complaints/{{complaintId}}',
  },
  COMPLAINT_UPDATED: {
    title: 'Complaint update',
    body: '{{referenceNumber}} is now {{status}}. {{note}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://complaints/{{complaintId}}',
  },
  COMPLAINT_COMMENT: {
    title: 'New comment on {{referenceNumber}}',
    body: '{{authorName}}: {{body}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://complaints/{{complaintId}}',
  },
  COMPLAINT_REOPENED: {
    title: 'Complaint reopened',
    body: '{{referenceNumber}} — {{title}} was reopened and needs attention again.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://complaints/{{complaintId}}',
  },
  COMPLAINT_ESCALATED: {
    title: 'Complaint escalated',
    body: '{{referenceNumber}} — {{title}} ({{category}}) has stayed unresolved for {{hours}} hours.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'HIGH',
    deepLink: 'colonize://complaints/{{complaintId}}',
  },
  COMPLAINT_RESOLVED: {
    title: 'Complaint resolved',
    body: '{{referenceNumber}} has been resolved. Please verify and share your feedback.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://complaints/{{complaintId}}/verify',
  },
  COMPLAINT_CLOSED: {
    title: 'Complaint closed',
    body: '{{referenceNumber}} has been closed. Thank you for your feedback.',
    channels: ['IN_APP'],
    priority: 'LOW',
  },
  WORK_ORDER_ASSIGNED: {
    title: 'Work order assigned',
    body: '{{referenceNumber}} — {{title}} has been assigned to you.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://work-orders/{{workOrderId}}',
  },
  WORK_ORDER_UPDATED: {
    title: 'Work order update',
    body: '{{referenceNumber}} is now {{status}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  SERVICE_REQUEST_CREATED: {
    title: 'New service request',
    body: '{{serviceType}} requested by {{unitLabel}} for {{preferredDate}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  SERVICE_REQUEST_UPDATED: {
    title: 'Service request update',
    body: 'Your {{serviceType}} request is now {{status}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  BILL_GENERATED: {
    title: 'Maintenance bill for {{period}}',
    body: '₹{{amount}} is due by {{dueDate}} for {{unitLabel}}.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'HIGH',
    deepLink: 'colonize://bills/{{billId}}',
  },
  BILL_REMINDER: {
    title: 'Payment reminder',
    body: '₹{{amount}} for {{period}} is due in {{daysLeft}} day(s).',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://bills/{{billId}}',
  },
  BILL_OVERDUE: {
    title: 'Bill overdue',
    body: '₹{{amount}} for {{period}} is overdue. A late fee may apply.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'CRITICAL',
    deepLink: 'colonize://bills/{{billId}}',
  },
  BILL_WAIVED: {
    title: 'Bill waived',
    body: '₹{{waivedAmount}} was waived on {{invoiceNumber}}. Remaining due: ₹{{dueAmount}}.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'NORMAL',
    deepLink: 'colonize://bills/{{billId}}',
  },
  BILL_DISPUTED: {
    title: 'Bill disputed',
    body: '{{invoiceNumber}} has been disputed by the resident. Reason: {{reason}}',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'HIGH',
    deepLink: 'colonize://bills/{{billId}}',
  },
  PAYMENT_RECEIVED: {
    title: 'Payment received',
    body: 'We received ₹{{amount}} for {{purpose}}. Receipt {{receiptNumber}}.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'NORMAL',
    deepLink: 'colonize://payments/{{paymentId}}',
  },
  PAYMENT_SUCCESS: {
    title: 'Payment successful',
    body: 'We received ₹{{amount}}. Receipt {{receiptNumber}}.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'NORMAL',
  },
  PAYMENT_FAILED: {
    title: 'Payment failed',
    body: 'Your payment of ₹{{amount}} could not be completed. No amount has been deducted.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://bills/{{billId}}',
  },
  PAYMENT_REFUNDED: {
    title: 'Refund initiated',
    body: '₹{{amount}} has been refunded. It usually reaches your account in 3-5 working days.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'NORMAL',
  },
  NOTICE_PUBLISHED: {
    title: '{{noticeType}}: {{title}}',
    body: '{{excerpt}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://notices/{{noticeId}}',
  },
  ANNOUNCEMENT_PUBLISHED: {
    title: '{{title}}',
    body: '{{excerpt}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://community/{{noticeId}}',
  },
  POLL_CREATED: {
    title: 'New poll: {{question}}',
    body: 'Voting closes on {{endDate}}. Your vote matters.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://polls/{{pollId}}',
  },
  POLL_CLOSING: {
    title: 'Poll closing soon',
    body: '"{{question}}" closes in {{hoursLeft}} hour(s).',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://polls/{{pollId}}',
  },
  POLL_CLOSED: {
    title: 'Poll closed',
    body: 'Results for "{{question}}" are now available.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://polls/{{pollId}}',
  },
  EVENT_CREATED: {
    title: '{{eventName}}',
    body: '{{eventDate}} at {{location}}. {{rsvpPrompt}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://events/{{eventId}}',
  },
  EVENT_REMINDER: {
    title: '{{eventName}} starts soon',
    body: '{{eventDate}} at {{location}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://events/{{eventId}}',
  },
  EVENT_RSVP: {
    title: 'New RSVP for {{eventName}}',
    body: '{{unitLabel}} is {{status}}{{guestNote}}.',
    channels: ['IN_APP'],
    priority: 'LOW',
  },
  AMENITY_BOOKED: {
    title: 'Booking confirmed',
    body: '{{amenityName}} on {{date}}, {{startTime}}–{{endTime}}. Show the QR at the entrance.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://amenities/bookings/{{bookingId}}',
  },
  AMENITY_BOOKING_PENDING: {
    title: 'Booking needs approval',
    body: '{{amenity}} on {{date}} at {{startTime}}, requested by {{unit}} ({{referenceNumber}}).',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://amenities/bookings/{{bookingId}}',
  },
  AMENITY_BOOKING_CONFIRMED: {
    title: 'Booking confirmed',
    body: 'Your {{amenity}} booking on {{date}}, {{startTime}}–{{endTime}} is confirmed. ₹{{amount}} paid. Carry the QR to the entrance.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://amenities/bookings/{{bookingId}}',
  },
  AMENITY_BOOKING_APPROVED: {
    title: 'Booking approved',
    body: 'Your {{amenityName}} booking on {{date}} has been approved.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://amenities/bookings/{{bookingId}}',
  },
  AMENITY_BOOKING_REJECTED: {
    title: 'Booking declined',
    body: 'Your {{amenityName}} booking on {{date}} was declined. {{reason}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  AMENITY_BOOKING_CANCELLED: {
    title: 'Booking cancelled',
    body: 'The {{amenityName}} booking on {{date}} was cancelled. {{refundNote}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
  },
  AMENITY_REMINDER: {
    title: '{{amenityName}} booking today',
    body: '{{startTime}}–{{endTime}}. Please carry your booking QR.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://amenities/bookings/{{bookingId}}',
  },
  EMERGENCY_ALERT: {
    title: 'EMERGENCY: {{category}}',
    body: '{{description}} {{locationNote}}',
    channels: ['PUSH', 'IN_APP', 'SMS'],
    priority: 'CRITICAL',
    deepLink: 'colonize://emergency/{{emergencyId}}',
  },
  EMERGENCY_RESOLVED: {
    title: 'Emergency resolved',
    body: 'The {{category}} alert has been marked resolved.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
  },
  DOCUMENT_UPLOADED: {
    title: 'New document: {{title}}',
    body: '{{category}} document shared by the society.{{ackPrompt}}',
    channels: ['PUSH', 'IN_APP'],
    priority: 'NORMAL',
    deepLink: 'colonize://documents/{{documentId}}',
  },
  ACKNOWLEDGEMENT_REMINDER: {
    title: 'Acknowledgement pending',
    body: 'Please read and acknowledge "{{title}}" by {{acknowledgeBy}}.',
    channels: ['PUSH', 'IN_APP'],
    priority: 'HIGH',
    deepLink: 'colonize://documents/{{documentId}}',
  },
  SUBSCRIPTION_EXPIRING: {
    title: 'Subscription expiring',
    body: 'The {{planCode}} plan for {{societyName}} expires on {{endDate}}.',
    channels: ['IN_APP', 'EMAIL'],
    priority: 'HIGH',
  },
  SUBSCRIPTION_EXPIRED: {
    title: 'Subscription expired',
    body: 'The {{planCode}} plan for {{societyName}} expired on {{endDate}}. Modules are now limited.',
    channels: ['IN_APP', 'EMAIL'],
    priority: 'CRITICAL',
  },
  ACCOUNT_CREATED: {
    title: 'Welcome to {{societyName}}',
    body: 'Your account is ready. Sign in with your registered mobile number.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'NORMAL',
  },
  PASSWORD_CHANGED: {
    title: 'Password changed',
    body: 'Your password was changed on {{device}}. If this was not you, contact support immediately.',
    channels: ['PUSH', 'IN_APP', 'EMAIL'],
    priority: 'CRITICAL',
  },
  DEVICE_LOGIN: {
    title: 'New sign-in',
    body: 'A sign-in happened from {{platform}} at {{time}}.',
    channels: ['IN_APP'],
    priority: 'NORMAL',
  },
  GENERIC: {
    title: '{{title}}',
    body: '{{message}}',
    channels: ['IN_APP'],
    priority: 'NORMAL',
  },
};

/** Interpolate `{{var}}` placeholders. Unknown variables become empty strings. */
export function interpolate(template: string, data: Record<string, unknown> = {}): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[part];
    }, data);
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  });
}

/** Variables referenced by a template — surfaced in the admin template editor. */
export function templateVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) found.add(match[1] as string);
  return Array.from(found);
}
