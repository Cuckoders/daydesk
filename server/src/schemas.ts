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

const commonChangeProperties = {
  id: identifier,
  entity: { type: 'string', enum: ['task'] },
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
              properties: { ...commonChangeProperties, operation: { const: 'upsert' }, payload: taskPayload },
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
