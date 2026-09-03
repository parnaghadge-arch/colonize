/**
 * Domain enumerations shared by the API, both web consoles and both mobile apps.
 * Kept in one place so a status change never has to be made twice.
 */

export const SOCIETY_STATUS = ['DRAFT', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type SocietyStatus = (typeof SOCIETY_STATUS)[number];

export const SOCIETY_TYPES = [
  'RESIDENTIAL_SOCIETY',
  'APARTMENT_COMPLEX',
  'GATED_COMMUNITY',
  'HOUSING_SOCIETY',
  'COMMERCIAL_COMMUNITY',
  'MIXED_USE',
] as const;
export type SocietyType = (typeof SOCIETY_TYPES)[number];

export const UNIT_STATUS = ['VACANT', 'OCCUPIED', 'LOCKED', 'UNDER_MAINTENANCE'] as const;
export type UnitStatus = (typeof UNIT_STATUS)[number];

export const UNIT_TYPES = [
  'FLAT',
  'APARTMENT',
  'VILLA',
  'BUNGALOW',
  'PENTHOUSE',
  'STUDIO',
  'SHOP',
  'OFFICE',
  'WAREHOUSE',
  'PARKING_UNIT',
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const OCCUPANCY_TYPES = ['OWNER', 'TENANT', 'OWNER_AND_TENANT', 'VACANT', 'COMPANY'] as const;
export type OccupancyType = (typeof OCCUPANCY_TYPES)[number];

/* ------------------------------- Visitors ------------------------------- */

export const VISITOR_TYPES = [
  'GUEST',
  'RELATIVE',
  'FRIEND',
  'CAB',
  'PRIVATE_DRIVER',
  'DELIVERY',
  'COURIER',
  'FOOD_DELIVERY',
  'GROCERY',
  'ECOMMERCE',
  'AMAZON',
  'SERVICES',
  'TECHNICIAN',
  'DAILY_HELP',
  'PET',
  'VENDOR',
  'OTHER',
] as const;
export type VisitorType = (typeof VISITOR_TYPES)[number];

export const VISITOR_STATUS = [
  'PRE_APPROVED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'IGNORED',
  'EXPIRED',
  'CANCELLED',
  'INSIDE',
  'EXITED',
  'MARKED_EXITED',
] as const;
export type VisitorStatus = (typeof VISITOR_STATUS)[number];

export const ENTRY_TYPES = [
  'PRE_APPROVED',
  'AT_GATE',
  'DELIVERY',
  'CAB',
  'STAFF',
  'VENDOR',
  'EMERGENCY',
  'VEHICLE',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const VISITOR_PASS_STATUS = ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED'] as const;
export type VisitorPassStatus = (typeof VISITOR_PASS_STATUS)[number];

export const DELIVERY_COMPANIES = [
  'AMAZON',
  'FLIPKART',
  'SWIGGY',
  'ZOMATO',
  'BLINKIT',
  'ZEPTO',
  'BIGBASKET',
  'DUNZO',
  'DELHIVERY',
  'BLUEDART',
  'DTDC',
  'INDIA_POST',
  'OTHER',
] as const;
export type DeliveryCompany = (typeof DELIVERY_COMPANIES)[number];

export const DELIVERY_TYPES = [
  'ECOMMERCE',
  'FOOD',
  'GROCERY',
  'COURIER',
  'PHARMACY',
  'LAUNDRY',
  'PACKAGE',
  'OTHER',
] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const CAB_TYPES = ['CAB', 'AUTO', 'TAXI', 'PRIVATE_DRIVER', 'PICKUP', 'DROP'] as const;
export type CabType = (typeof CAB_TYPES)[number];

/* -------------------------------- Staff --------------------------------- */

export const STAFF_TYPES = [
  'MAID',
  'COOK',
  'DRIVER',
  'BABYSITTER',
  'GARDENER',
  'CLEANER',
  'TECHNICIAN',
  'SECURITY',
  'MAINTENANCE',
  'HOUSEKEEPING',
  'ELECTRICIAN',
  'PLUMBER',
  'RECEPTIONIST',
  'MANAGER',
  'OTHER',
] as const;
export type StaffType = (typeof STAFF_TYPES)[number];

export const STAFF_EMPLOYMENT = ['SOCIETY', 'PRIVATE', 'VENDOR', 'CONTRACT'] as const;
export type StaffEmployment = (typeof STAFF_EMPLOYMENT)[number];

export const ATTENDANCE_STATUS = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE', 'HALF_DAY'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUS)[number];

export const STAFF_STATUS = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type StaffStatus = (typeof STAFF_STATUS)[number];

/* ------------------------------- Vehicles ------------------------------- */

export const VEHICLE_TYPES = [
  'CAR',
  'BIKE',
  'SCOOTER',
  'EV_CAR',
  'EV_BIKE',
  'COMMERCIAL',
  'AUTO',
  'CYCLE',
  'OTHER',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const PARKING_SLOT_TYPES = [
  'RESERVED',
  'VISITOR',
  'EV',
  'STAFF',
  'TWO_WHEELER',
  'DISABLED',
  'COMMON',
] as const;
export type ParkingSlotType = (typeof PARKING_SLOT_TYPES)[number];

export const PARKING_SLOT_STATUS = [
  'AVAILABLE',
  'OCCUPIED',
  'RESERVED',
  'VISITOR',
  'MAINTENANCE',
  'BLOCKED',
] as const;
export type ParkingSlotStatus = (typeof PARKING_SLOT_STATUS)[number];

/* ------------------------------ Complaints ------------------------------ */

export const COMPLAINT_CATEGORIES = [
  'PLUMBING',
  'ELECTRICAL',
  'LIFT',
  'SECURITY',
  'CLEANING',
  'PARKING',
  'WATER',
  'GARBAGE',
  'MAINTENANCE',
  'COMMON_AREA',
  'PEST_CONTROL',
  'GARDEN',
  'NOISE',
  'NETWORK',
  'OTHER',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_STATUS = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'RESOLVED',
  'CLOSED',
  'REJECTED',
  'REOPENED',
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUS)[number];

export const COMPLAINT_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITY)[number];

export const COMPLAINT_SOURCE = ['RESIDENT', 'SECURITY', 'ADMIN', 'STAFF', 'SYSTEM'] as const;
export type ComplaintSource = (typeof COMPLAINT_SOURCE)[number];

export const SERVICE_REQUEST_TYPES = [
  'ELECTRICIAN',
  'PLUMBER',
  'CARPENTER',
  'CLEANING',
  'PEST_CONTROL',
  'AC_SERVICE',
  'APPLIANCE_REPAIR',
  'PAINTING',
  'MOVING',
  'OTHER',
] as const;
export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPES)[number];

/* ------------------------------ Work orders ----------------------------- */

export const WORK_ORDER_STATUS = [
  'REQUESTED',
  'CREATED',
  'ASSIGNED',
  'STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
  'ON_HOLD',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUS)[number];

/* ------------------------------- Amenities ------------------------------ */

export const AMENITY_TYPES = [
  'CLUBHOUSE',
  'SWIMMING_POOL',
  'GYM',
  'PARTY_HALL',
  'GARDEN',
  'SPORTS_COURT',
  'COMMUNITY_HALL',
  'MEETING_ROOM',
  'LIBRARY',
  'INDOOR_GAMES',
  'YOGA_DECK',
  'PLAYGROUND',
  'BBQ_AREA',
  'AMPHITHEATRE',
  'OTHER',
] as const;
export type AmenityType = (typeof AMENITY_TYPES)[number];

export const BOOKING_STATUS = [
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'REJECTED',
  'COMPLETED',
  'NO_SHOW',
  'REFUNDED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUS)[number];

/* --------------------------- Notices & events --------------------------- */

export const NOTICE_TYPES = [
  'GENERAL',
  'MAINTENANCE',
  'EMERGENCY',
  'EVENT',
  'WATER_SHUTDOWN',
  'ELECTRICITY_SHUTDOWN',
  'SECURITY_ALERT',
  'MEETING',
  'IMPORTANT',
  'RULES',
  'FINANCIAL',
] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

export const AUDIENCE_TYPES = [
  'ALL',
  'BUILDING',
  'WING',
  'FLOOR',
  'UNIT',
  'ROLE',
  'OWNERS_ONLY',
  'TENANTS_ONLY',
  'STAFF',
  'COMMITTEE',
] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export const EVENT_STATUS = ['DRAFT', 'PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUS)[number];

export const RSVP_STATUS = ['ATTENDING', 'NOT_ATTENDING', 'MAYBE'] as const;
export type RsvpStatus = (typeof RSVP_STATUS)[number];

export const POLL_STATUS = ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] as const;
export type PollStatus = (typeof POLL_STATUS)[number];

/* -------------------------------- Finance ------------------------------- */

export const BILL_STATUS = [
  'DRAFT',
  'GENERATED',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'WAIVED',
  'CANCELLED',
  'DISPUTED',
] as const;
export type BillStatus = (typeof BILL_STATUS)[number];

export const BILL_ITEM_TYPES = [
  'MAINTENANCE',
  'FIXED_CHARGE',
  'VARIABLE_CHARGE',
  'WATER',
  'PARKING',
  'CLUBHOUSE',
  'SINKING_FUND',
  'REPAIR_FUND',
  'PENALTY',
  'LATE_FEE',
  'SERVICE_CHARGE',
  'EVENT_FEE',
  'AMENITY_FEE',
  'ARREARS',
  'OTHER',
] as const;
export type BillItemType = (typeof BILL_ITEM_TYPES)[number];

export const PAYMENT_STATUS = [
  'INITIATED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'CANCELLED',
  'ABANDONED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const PAYMENT_PURPOSES = [
  'MAINTENANCE',
  'AMENITY_BOOKING',
  'PARKING',
  'SERVICE_CHARGE',
  'EVENT_FEE',
  'FINE',
  'DONATION',
  'SUBSCRIPTION',
  'OTHER',
] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_MODES = [
  'ONLINE',
  'UPI',
  'CARD',
  'NETBANKING',
  'CASH',
  'CHEQUE',
  'DD',
  'BANK_TRANSFER',
  'WALLET',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const TRANSACTION_TYPE = ['DEBIT', 'CREDIT'] as const;
export type TransactionType = (typeof TRANSACTION_TYPE)[number];

export const LEDGER_TYPES = [
  'MAINTENANCE_INCOME',
  'WATER_INCOME',
  'PARKING_INCOME',
  'AMENITY_INCOME',
  'EVENT_INCOME',
  'INTEREST_INCOME',
  'OTHER_INCOME',
  'VENDOR_EXPENSE',
  'ELECTRICITY_EXPENSE',
  'SECURITY_EXPENSE',
  'HOUSEKEEPING_EXPENSE',
  'REPAIR_EXPENSE',
  'ADMINISTRATIVE_EXPENSE',
  'SALARY_EXPENSE',
  'OTHER_EXPENSE',
  'ASSET',
  'LIABILITY',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const LEDGER_GROUP = ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'] as const;
export type LedgerGroup = (typeof LEDGER_GROUP)[number];

export const TAX_TYPES = ['CGST', 'SGST', 'IGST', 'CESS', 'NONE'] as const;
export type TaxType = (typeof TAX_TYPES)[number];

/* ------------------------------ Emergency ------------------------------- */

export const EMERGENCY_CATEGORIES = [
  'MEDICAL',
  'FIRE',
  'SECURITY',
  'ACCIDENT',
  'GAS_LEAK',
  'WATER_LEAKAGE',
  'ELECTRIC_SHOCK',
  'LIFT_STUCK',
  'THEFT',
  'OTHER',
] as const;
export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number];

export const EMERGENCY_STATUS = ['ACTIVE', 'ACKNOWLEDGED', 'RESPONDING', 'RESOLVED', 'FALSE_ALARM'] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUS)[number];

/* ----------------------------- Documents -------------------------------- */

export const DOCUMENT_CATEGORIES = [
  'REGISTRATION',
  'BYE_LAWS',
  'RULES',
  'MEETING_MINUTES',
  'NOTICE',
  'BILL',
  'RECEIPT',
  'VENDOR_AGREEMENT',
  'CERTIFICATE',
  'AUDIT_REPORT',
  'INSURANCE',
  'ID_PROOF',
  'OWNERSHIP_PROOF',
  'RENT_AGREEMENT',
  'PHOTO',
  'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_VISIBILITY = [
  'PUBLIC',
  'RESIDENTS',
  'OWNERS_ONLY',
  'COMMITTEE',
  'STAFF',
  'PRIVATE',
] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITY)[number];

/* --------------------------- Notifications ------------------------------ */

export const NOTIFICATION_CHANNELS = ['PUSH', 'IN_APP', 'SMS', 'EMAIL', 'WHATSAPP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENTS = [
  'VISITOR_ARRIVED',
  'VISITOR_APPROVED',
  'VISITOR_REJECTED',
  'VISITOR_EXITED',
  'VISITOR_PRE_APPROVED',
  'DELIVERY_ARRIVED',
  'DELIVERY_APPROVED',
  'DELIVERY_REJECTED',
  'CAB_ARRIVED',
  'STAFF_ARRIVED',
  'STAFF_ATTENDANCE',
  'COMPLAINT_CREATED',
  'COMPLAINT_ASSIGNED',
  'COMPLAINT_UPDATED',
  'COMPLAINT_RESOLVED',
  'COMPLAINT_CLOSED',
  'WORK_ORDER_ASSIGNED',
  'WORK_ORDER_UPDATED',
  'SERVICE_REQUEST_CREATED',
  'SERVICE_REQUEST_UPDATED',
  'BILL_GENERATED',
  'BILL_REMINDER',
  'BILL_OVERDUE',
  'PAYMENT_RECEIVED',
  'PAYMENT_FAILED',
  'PAYMENT_REFUNDED',
  'NOTICE_PUBLISHED',
  'ANNOUNCEMENT_PUBLISHED',
  'POLL_CREATED',
  'POLL_CLOSING',
  'POLL_CLOSED',
  'EVENT_CREATED',
  'EVENT_REMINDER',
  'EVENT_RSVP',
  'AMENITY_BOOKED',
  'AMENITY_BOOKING_APPROVED',
  'AMENITY_BOOKING_REJECTED',
  'AMENITY_BOOKING_CANCELLED',
  'AMENITY_REMINDER',
  'EMERGENCY_ALERT',
  'EMERGENCY_RESOLVED',
  'DOCUMENT_UPLOADED',
  'ACKNOWLEDGEMENT_REMINDER',
  'SUBSCRIPTION_EXPIRING',
  'SUBSCRIPTION_EXPIRED',
  'ACCOUNT_CREATED',
  'PASSWORD_CHANGED',
  'DEVICE_LOGIN',
  'GENERIC',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_PRIORITY = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITY)[number];

export const NOTIFICATION_STATUS = ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'READ', 'SKIPPED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUS)[number];

/* ---------------------------- Subscriptions ----------------------------- */

export const PLAN_TIERS = ['FREE', 'BASIC', 'STANDARD', 'PREMIUM', 'ENTERPRISE'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const BILLING_CYCLES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const SUBSCRIPTION_STATUS = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
  'SUSPENDED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

/* ------------------------------ Support --------------------------------- */

export const TICKET_STATUS = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUS)[number];

export const TICKET_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITY)[number];

/* ------------------------------- Gates ---------------------------------- */

export const GATE_TYPES = ['MAIN', 'SECONDARY', 'SERVICE', 'PARKING', 'PEDESTRIAN', 'EMERGENCY'] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const SHIFT_TYPES = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL', 'WEEK_OFF'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

/* ------------------------------- Audit ---------------------------------- */

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'SOFT_DELETE',
  'RESTORE',
  'LOGIN',
  'LOGOUT',
  'LOGIN_FAILED',
  'OTP_SENT',
  'OTP_VERIFIED',
  'TOKEN_REFRESHED',
  'TOKEN_REVOKED',
  'PASSWORD_CHANGED',
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'ROLE_CHANGED',
  'APPROVE',
  'REJECT',
  'ASSIGN',
  'PUBLISH',
  'PAYMENT_INITIATED',
  'PAYMENT_SUCCESS',
  'PAYMENT_FAILED',
  'PAYMENT_REFUNDED',
  'BILL_GENERATED',
  'LEDGER_POSTED',
  'EXPORT',
  'IMPORT',
  'SETTINGS_CHANGED',
  'SOCIETY_CREATED',
  'SOCIETY_ACTIVATED',
  'DB_PROVISIONED',
  'EMERGENCY_RAISED',
  'DOCUMENT_ACKNOWLEDGED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* ---------------------------- Sync / offline ---------------------------- */

export const SYNC_STATUS = ['PENDING', 'SYNCED', 'FAILED', 'CONFLICT'] as const;
export type SyncStatus = (typeof SYNC_STATUS)[number];
