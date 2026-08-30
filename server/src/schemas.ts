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
    properties: { accountId: mailAccountId, folder: { type: 'string', enum: ['inbox', 'sent'] } },
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
    properties: { accountId: mailAccountId, messageId: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' } },
  },
  querystring: { type: 'object', additionalProperties: false, properties: { folder: { type: 'string', enum: ['inbox', 'sent'] } } },
} as const;

export const mailAttachmentParamsSchema = {
  headers: authenticatedHeaders,
  params: {
    type: 'object', additionalProperties: false, required: ['accountId', 'messageId', 'attachmentId'],
    properties: {
      accountId: mailAccountId,
      messageId: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' },
      attachmentId: { type: 'string', minLength: 1, maxLength: 3, pattern: '^[1-9][0-9]{0,2}$' },
    },
  },
  querystring: { type: 'object', additionalProperties: false, properties: { folder: { type: 'string', enum: ['inbox', 'sent'] } } },
} as const;

const oauthProvider = { type: 'string', enum: ['gmail', 'outlook'] } as const;

export const startMailOAuthSchema = {
  headers: authenticatedHeaders,
  body: { type: 'object', additionalProperties: false, required: ['provider'], properties: { provider: oauthProvider } },
} as const;

export const mailOAuthStatusSchema = {
  headers: authenticatedHeaders,
  params: { type: 'object', additionalProperties: false, required: ['flowId'], properties: { flowId: mailAccountId } },
} as const;

export const mailOAuthCallbackSchema = {
  params: { type: 'object', additionalProperties: false, required: ['provider'], properties: { provider: oauthProvider } },
  querystring: {
    type: 'object', additionalProperties: false,
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 4096 },
      state: { type: 'string', minLength: 40, maxLength: 256, pattern: '^[A-Za-z0-9._-]+$' },
      error: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._-]+$' },
      error_description: { type: 'string', maxLength: 500 },
      error_uri: { type: 'string', maxLength: 2048 },
      scope: { type: 'string', maxLength: 4096 },
      authuser: { type: 'string', maxLength: 3, pattern: '^[0-9]+$' },
      prompt: { type: 'string', maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' },
      hd: { type: 'string', maxLength: 253 },
      session_state: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9._-]+$' },
      client_info: { type: 'string', maxLength: 2048, pattern: '^[A-Za-z0-9._-]+$' },
    },
  },
} as const;

const attachmentToken = { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' } as const;
const recipientArray = { type: 'array', maxItems: 25, uniqueItems: true, items: { type: 'string', format: 'email', maxLength: 320 } } as const;

export const uploadMailAttachmentSchema = {
  headers: authenticatedHeaders,
  body: {
    type: 'object', additionalProperties: false, required: ['name', 'mimeType', 'data'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\x00-\x1F\x7F]+$' },
      mimeType: { type: 'string', minLength: 3, maxLength: 255, pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' },
      data: { type: 'string', minLength: 4, maxLength: 2_796_208, pattern: '^[A-Za-z0-9+/]+={0,2}$' },
    },
  },
} as const;

export const discardMailAttachmentsSchema = {
  headers: authenticatedHeaders,
  body: { type: 'object', additionalProperties: false, required: ['tokens'], properties: { tokens: { type: 'array', maxItems: 10, uniqueItems: true, items: attachmentToken } } },
} as const;

export const sendMailSchema = {
  headers: authenticatedHeaders,
  body: {
    type: 'object', additionalProperties: false,
    required: ['accountId', 'to', 'cc', 'bcc', 'subject', 'body', 'attachmentTokens'],
    properties: {
      accountId: mailAccountId, to: { ...recipientArray, minItems: 1 }, cc: recipientArray, bcc: recipientArray,
      subject: { type: 'string', maxLength: 500, pattern: '^[^\\x00-\\x1F\\x7F]*$' },
      body: { type: 'string', maxLength: 200_000, pattern: '^[^\\x00]*$' },
      attachmentTokens: { type: 'array', maxItems: 10, uniqueItems: true, items: attachmentToken },
    },
  },
} as const;
