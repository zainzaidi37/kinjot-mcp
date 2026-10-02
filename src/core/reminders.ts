// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/reminders.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { z } from 'zod';

export const REMINDER_ACTIVE_CAP = 200;
export const REMINDER_MAX_DAYS = 366;
export const REMINDER_OPS = ['set', 'snooze', 'snooze_hour', 'dismiss', 'cancel'] as const;
export const REMINDER_CLOSED_REASONS = ['dismissed', 'cancelled', 'note_unavailable'] as const;
export const REMINDER_REFUSALS = [
  'invalid_params',
  'invalid_schedule',
  'note_unavailable',
  'reminder_closed',
  'reminder_not_found',
  'request_id_reused',
  'not_due',
  'limit_reached',
] as const;
const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
export const ReminderDateSchema = z.string().date();
export const ReminderTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const ReminderZoneSchema = z
  .string()
  .min(1)
  .refine((zone) => zone === 'UTC' || zone.includes('/'), 'Use a named time zone');
export const ReminderScheduleSchema = z
  .object({
    date: ReminderDateSchema,
    time: ReminderTimeSchema,
    timeZone: ReminderZoneSchema,
    instant: instant.refine(
      (value) => /T\d{2}:\d{2}:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
      'Use minute precision',
    ),
  })
  .strict();
export type ReminderSchedule = z.infer<typeof ReminderScheduleSchema>;

// Reads strip future columns while retaining every column of the current SQL row.
export const ReminderSchema = z.object({
  id: uuid,
  user_id: uuid,
  note_id: uuid,
  scheduled_date: ReminderDateSchema,
  scheduled_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?$/),
  time_zone: ReminderZoneSchema,
  scheduled_at: instant,
  snoozed_until: instant.nullable(),
  effective_at: instant,
  revision: z.number().int().positive(),
  last_request_id: uuid,
  last_request_hash: z.string().regex(/^[0-9a-f]{64}$/),
  closed_reason: z.enum(REMINDER_CLOSED_REASONS).nullable(),
  created_at: instant,
  updated_at: instant,
  deleted_at: instant.nullable(),
});
export type Reminder = z.infer<typeof ReminderSchema>;
export const ReminderEntrySchema = ReminderSchema.extend({
  eligibility: z.enum(['live', 'in_trash']),
});
export type ReminderEntry = z.infer<typeof ReminderEntrySchema>;
export const RemindersListSchema = z.object({
  server_now: instant,
  items: z.array(ReminderEntrySchema).max(REMINDER_ACTIVE_CAP),
});
export type RemindersList = z.infer<typeof RemindersListSchema>;

const identity = { id: uuid, requestId: uuid };
const revision = z.number().int().positive();
export const ReminderWriteInputSchema = z
  .discriminatedUnion('op', [
    z
      .object({
        ...identity,
        op: z.literal('set'),
        noteId: uuid.nullable(),
        expectedRevision: revision.nullable(),
        schedule: ReminderScheduleSchema,
      })
      .strict(),
    z
      .object({
        ...identity,
        op: z.literal('snooze'),
        expectedRevision: revision,
        schedule: ReminderScheduleSchema,
      })
      .strict(),
    z.object({ ...identity, op: z.literal('snooze_hour'), expectedRevision: revision }).strict(),
    z.object({ ...identity, op: z.literal('dismiss'), expectedRevision: revision }).strict(),
    z.object({ ...identity, op: z.literal('cancel'), expectedRevision: revision }).strict(),
  ])
  .refine(
    (input) =>
      input.op !== 'set' ||
      (input.expectedRevision === null ? input.noteId !== null : input.noteId === null),
    'Only creation supplies a note ID',
  );
export type ReminderWriteInput = z.infer<typeof ReminderWriteInputSchema>;
export const ReminderWriteResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), reminder: ReminderSchema }),
  z.object({ status: z.literal('conflict'), reminder: ReminderSchema }),
  z.object({ status: z.literal('refused'), reason: z.enum(REMINDER_REFUSALS) }),
]);
export type ReminderWriteResult = z.infer<typeof ReminderWriteResultSchema>;
