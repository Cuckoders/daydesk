const identifier = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const isoDate = { type: 'string', minLength: 20, maxLength: 35 } as const;

export const registerDeviceSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['setupCode', 'name'],
    properties: {
      setupCode: { type: 'string', minLength: 12, maxLength: 256 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
    },
  },
} as const;

const taskPayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'completed', 'dueAt', 'priority', 'category', 'reminderEnabled', 'remindBeforeMinutes', 'recurrence', 'updatedAt', 'syncVersion'],
  properties: {
    id: identifier,
    title: { type: 'string', minLength: 1, maxLength: 500 },
    completed: { type: 'boolean' },
    dueAt: isoDate,
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    category: { type: 'string', minLength: 1, maxLength: 100 },
    reminderEnabled: { type: 'boolean' },
    remindBeforeMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
    recurrence: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'] },
    desktopRecurrence: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'days', 'seriesId'],
      properties: {
        mode: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'custom'] },
        days: { type: 'array', maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 6 } },
        seriesId: identifier,
      },
    },
    snoozedUntil: isoDate,
    updatedAt: isoDate,
    syncVersion: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
} as const;

const eventPayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'startsAt', 'endsAt', 'type', 'remindBeforeMinutes', 'reminderEnabled', 'updatedAt', 'syncVersion'],
  properties: {
    id: identifier,
    title: { type: 'string', minLength: 1, maxLength: 300 },
    startsAt: isoDate,
    endsAt: isoDate,
    type: { type: 'string', enum: ['meeting', 'meal', 'focus', 'personal'] },
    location: { type: 'string', maxLength: 500 },
    remindBeforeMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
    reminderEnabled: { type: 'boolean' },
    allDay: { type: 'boolean' },
    allDayStartDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    allDayEndDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    updatedAt: isoDate,
    syncVersion: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
} as const;

const routinePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'time', 'days', 'kind', 'remindBeforeMinutes', 'enabled', 'updatedAt', 'syncVersion'],
  properties: {
    id: identifier,
    title: { type: 'string', minLength: 1, maxLength: 100 },
    time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
    days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 6 } },
    kind: { type: 'string', enum: ['water', 'meal', 'break', 'focus', 'custom'] },
    remindBeforeMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
    enabled: { type: 'boolean' },
    updatedAt: isoDate,
    syncVersion: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
} as const;

const commonChangeProperties = {
  id: identifier,
  entity: { type: 'string', enum: ['task', 'event', 'routine'] },
  entityId: identifier,
  updatedAt: isoDate,
} as const;

export const syncSchema = {
  headers: {
    type: 'object',
    properties: {
      authorization: { type: 'string', minLength: 39, maxLength: 263 },
      'x-device-id': identifier,
    },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['cursor', 'changes'],
    properties: {
      cursor: { type: 'integer', minimum: 0 },
      changes: {
        type: 'array',
        maxItems: 500,
        items: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'entity', 'entityId', 'operation', 'updatedAt', 'payload'],
              properties: { ...commonChangeProperties, entity: { const: 'task' }, operation: { const: 'upsert' }, payload: taskPayload },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'entity', 'entityId', 'operation', 'updatedAt', 'payload'],
              properties: { ...commonChangeProperties, entity: { const: 'event' }, operation: { const: 'upsert' }, payload: eventPayload },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'entity', 'entityId', 'operation', 'updatedAt', 'payload'],
              properties: { ...commonChangeProperties, entity: { const: 'routine' }, operation: { const: 'upsert' }, payload: routinePayload },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'entity', 'entityId', 'operation', 'updatedAt'],
              properties: { ...commonChangeProperties, operation: { const: 'delete' } },
            },
          ],
        },
      },
    },
  },
} as const;

const authenticatedHeaders = syncSchema.headers;
const mailAccountId = { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f-]+$' } as const;
const mailHost = { type: 'string', minLength: 1, maxLength: 253, pattern: '^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$' } as const;

export const connectImapSchema = {
  headers: authenticatedHeaders,
  body: {
    type: 'object', additionalProperties: false,
    required: ['label', 'address', 'host', 'port', 'username', 'password'],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\x00-\\x1F\\x7F]+$' },
      address: { type: 'string', format: 'email', maxLength: 320 },
      host: mailHost,
      port: { const: 993 },
      username: { type: 'string', minLength: 1, maxLength: 320, pattern: '^[^\\x00-\\x1F\\x7F]+$' },
      password: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^[^\\x00]+$' },
    },
  },
} as const;

export const mailAccountListSchema = { headers: authenticatedHeaders } as const;

export const mailSyncSchema = {
  headers: authenticatedHeaders,
  body: {
    type: 'object', additionalProperties: false,
    properties: { accountId: mailAccountId },
  },
} as const;

export const mailAccountParamsSchema = {
  headers: authenticatedHeaders,
  params: { type: 'object', additionalProperties: false, required: ['accountId'], properties: { accountId: mailAccountId } },
} as const;

export const mailMessageParamsSchema = {
  headers: authenticatedHeaders,
  params: {
    type: 'object', additionalProperties: false, required: ['accountId', 'messageId'],
    properties: { accountId: mailAccountId, messageId: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' } },
  },
} as const;
