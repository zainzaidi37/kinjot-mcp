// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/admin-analytics.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { z } from 'zod';

/**
 * The `/admin` dashboard's wire contract (`plans/admin-analytics.md` §5).
 *
 * Three independent sources answer one request: Postgres (product), Lemon
 * Squeezy (revenue) and Cloudflare Web Analytics (traffic). Only `product` is
 * guaranteed — it is computed by `public.admin_analytics_product(p_days, p_day_to)`,
 * whose jsonb this schema mirrors verbatim so the Edge Function passes it
 * through after validating it. The two provider sections are discriminated
 * unions on `status`, because a provider that is not configured, or that is
 * down, must degrade its own card and never the response: the function
 * validates against this schema before it replies, so a provider *shape drift*
 * becomes `status: 'error'` rather than a 500.
 *
 * Everything here is an aggregate. No note body, title, Recall query or Recall
 * answer is read, counted by content, or returned — the privacy page's
 * promise that no analytics profile is built from note content is a property
 * of this shape, not of the UI that renders it.
 *
 * `supabase/functions/admin-analytics/schema.ts` is the server's mirror of
 * this file: the Deno/npm boundary keeps Edge Functions from importing
 * `@kinjot/core` (see `_shared/tidy-clarify.ts` for the same arrangement), so
 * the two must be changed together.
 */

/** A UTC calendar date, `YYYY-MM-DD`. Every bucket in this file is a UTC day. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A countable quantity. Never negative, never fractional. */
const count = z.number().int().nonnegative();

/** Integer cents. Signed, because a refund-heavy window can net negative. */
const cents = z.number().int();

export const AdminAnalyticsDaySeriesSchema = z.array(z.object({ date: isoDate, count }));
export type AdminAnalyticsDaySeries = z.infer<typeof AdminAnalyticsDaySeriesSchema>;

/**
 * How many UTC days the dashboard asks for, ending today inclusive. The UI
 * offers 7/30/90; the function accepts the whole 1..365 band so a URL or a
 * future control is not a protocol change. The upper bound is what stops a
 * caller turning one admin request into a year-long provider sweep.
 */
export const AdminAnalyticsRequestSchema = z.object({
  days: z.number().int().min(1).max(365),
});
export type AdminAnalyticsRequest = z.infer<typeof AdminAnalyticsRequestSchema>;

export const AdminAnalyticsProductSchema = z.object({
  users: z.object({
    total: count,
    confirmed: count,
    new_in_range: count,
    signups_by_day: AdminAnalyticsDaySeriesSchema,
  }),
  /**
   * Activity is a union of last-write timestamps (`notes.updated_at`,
   * `api_keys.last_used_at`, `auth.users.last_sign_in_at`) and true event
   * timestamps. Only the latest value of each survives, so **past days
   * undercount** and the UI says so under the chart.
   */
  active: z.object({ by_day: AdminAnalyticsDaySeriesSchema, wau: count, mau: count }),
  notes: z.object({
    live: count,
    trashed: count,
    created_in_range: count,
    by_day: z.array(z.object({ date: isoDate, web: count, mcp: count, cli: count, vscode: count })),
    /** `percentile_cont`, so genuinely fractional — not a count. */
    per_user: z.object({ p50: z.number().nonnegative(), p90: z.number().nonnegative() }),
  }),
  plans: z.object({ free: count, pro: count }),
  recall: z.object({
    in_range: count,
    users_in_range: count,
    by_day: AdminAnalyticsDaySeriesSchema,
  }),
  tidy: z.object({
    in_range: count,
    by_day: z.array(
      z.object({ date: isoDate, applied: count, failed: count, reverted: count, running: count }),
    ),
  }),
  /** The *current billing period* per user, not the range — dictation is metered per period. */
  dictation: z.object({ seconds_current_period: count, users_current_period: count }),
  mcp: z.object({
    keys_live: count,
    keys_used_7d: count,
    keys_used_30d: count,
    users_with_key: count,
  }),
  /** All-time, monotonically narrowing: each step is a subset of the one before it. */
  funnel: z.object({
    signed_up: count,
    created_note: count,
    connected_agent: count,
    asked_recall: count,
    pro: count,
  }),
  /**
   * The last eight signup weeks (Monday-start, UTC), newest last. `active[k]`
   * is how many of that cohort showed an activity signal in week k after
   * signup, and `null` means that week has not happened yet — a distinct
   * state from zero, which the grid renders as blank rather than as 0%.
   * Always eight entries so the row aligns with the header.
   */
  cohorts: z
    .array(
      z.object({
        week: isoDate,
        size: count,
        active: z.array(count.nullable()).length(8),
      }),
    )
    .max(8),
});
export type AdminAnalyticsProduct = z.infer<typeof AdminAnalyticsProductSchema>;

/**
 * `unconfigured` means the deployment holds no credential for the provider —
 * an expected state, not a fault, and the card says which secret to set.
 * `error` carries a short code or one sentence; a provider body is never
 * echoed, because it can contain the credential's own error text.
 */
export const AdminAnalyticsRevenueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unconfigured') }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({
    status: z.literal('ok'),
    /**
     * True when any returned object is a Lemon Squeezy test object. Lemon
     * Squeezy separates test and live data by API key, not by a request flag,
     * so this badge is the only thing between "revenue" and a test-key
     * rehearsal (prod holds test keys on purpose today).
     */
    test_mode: z.boolean(),
    /**
     * True when a bounded read stopped short of the provider's data: an
     * endpoint whose `meta.page.lastPage` was past the page budget, or more
     * distinct prices than the lookup budget. The totals below are then a
     * FLOOR, not the truth, and the page says so — a capped sweep that
     * reported a small number as final is the failure mode the bound exists
     * to avoid, and hiding it would trade an unbounded loop for a quiet lie.
     */
    truncated: z.boolean(),
    currency: z.string(),
    mrr_cents: cents,
    subscriptions: z.object({
      on_trial: count,
      active: count,
      past_due: count,
      paused: count,
      unpaid: count,
      cancelled: count,
      expired: count,
    }),
    new_in_range: count,
    churned_in_range: count,
    new_by_day: AdminAnalyticsDaySeriesSchema,
    churned_by_day: AdminAnalyticsDaySeriesSchema,
    revenue_in_range_cents: cents,
    refunded_in_range_cents: cents,
    invoices_paid_in_range: count,
  }),
]);
export type AdminAnalyticsRevenue = z.infer<typeof AdminAnalyticsRevenueSchema>;

export const AdminAnalyticsTrafficSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unconfigured') }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({
    status: z.literal('ok'),
    /**
     * The range that was requested, echoed back. It is NOT narrowed to the
     * days that had traffic: Web Analytics retention is plan-dependent, and
     * an empty day is indistinguishable from an aged-out one, so the section
     * returns the full window and the page carries a footnote saying that
     * days before the retention window are empty rather than zero.
     */
    from: isoDate,
    to: isoDate,
    by_day: z.array(z.object({ date: isoDate, page_views: count, visits: count })),
    by_host: z.array(z.object({ host: z.string(), page_views: count, visits: count })),
    top_paths: z.array(
      z.object({ host: z.string(), path: z.string(), page_views: count, visits: count }),
    ),
    top_referrers: z.array(z.object({ referrer: z.string(), visits: count })),
  }),
]);
export type AdminAnalyticsTraffic = z.infer<typeof AdminAnalyticsTrafficSchema>;

export const AdminAnalyticsSchema = z.object({
  generated_at: z.string().datetime({ offset: true }),
  range: z.object({ days: z.number().int().min(1).max(365), from: isoDate, to: isoDate }),
  product: AdminAnalyticsProductSchema,
  revenue: AdminAnalyticsRevenueSchema,
  traffic: AdminAnalyticsTrafficSchema,
});
export type AdminAnalytics = z.infer<typeof AdminAnalyticsSchema>;

/* ---------- the users section (plans/admin-users-and-actions.md §4.1) ---------- */

/**
 * An ISO-8601 instant with an offset, as Postgres serialises a `timestamptz`
 * into jsonb (`2026-09-20T21:25:45.369666+00:00`).
 */
const isoInstant = z.string().datetime({ offset: true });

/**
 * How far an account has got, as one label rather than five booleans.
 *
 * It is the *highest step reached*, where the dashboard's funnel counts
 * cohorts that passed every earlier one — so a Pro account that never asked a
 * Recall is `pro` here and absent from the funnel's last step. The two answer
 * different questions and neither is the other's summary.
 */
export const ADMIN_USER_STAGES = ['signed_up', 'noted', 'connected', 'recalled', 'pro'] as const;
export type AdminUserStage = (typeof ADMIN_USER_STAGES)[number];

/** The two orderings `admin_users` offers. Anything else reads as `signup`. */
export const ADMIN_USER_SORTS = ['signup', 'last_active'] as const;
export type AdminUserSort = (typeof ADMIN_USER_SORTS)[number];

/**
 * One account, as `public.admin_users` returns it.
 *
 * THE PRIVACY LINE THIS SHAPE DRAWS. Every field is an identifier, a
 * timestamp, a plan, or a count. There is no note title or body, no folder or
 * tag name, no Recall query or answer, no tidy instruction, and no API key
 * name or prefix — a key's name is text its owner wrote, so it stays out even
 * though the rest of the key row is metadata. The operator may see who a user
 * is and how much they use the product; never what they wrote. The routine's
 * whole-payload test is what enforces that, and this schema is what would
 * have to be widened before anything else could reach the page.
 *
 * `email` is nullable because `auth.users.email` is: an account can exist
 * without one, and a 500 is a worse answer than a dash in a cell.
 */
export const AdminUserRowSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().nullable(),
  email_confirmed_at: isoInstant.nullable(),
  created_at: isoInstant,
  last_sign_in_at: isoInstant.nullable(),
  plan: z.enum(['free', 'pro']),
  plan_event_at: isoInstant.nullable(),
  billing_ref: z.string().nullable(),
  billing_period_start: isoInstant.nullable(),
  billing_period_end: isoInstant.nullable(),
  notes_live: count,
  notes_trashed: count,
  notes_by_source: z.object({ web: count, mcp: count, cli: count, vscode: count }),
  keys_live: count,
  keys_last_used_at: isoInstant.nullable(),
  recalls_total: count,
  /** Rows in the user's *current billing period*, not in the dashboard range. */
  recalls_period: count,
  /** `recall_usage.count` for that period — the metered figure, which refunds move. */
  recall_quota_used: count,
  tidy_runs_total: count,
  voice_seconds_period: count,
  /**
   * The latest activity signal of `plans/admin-analytics.md` §3.1, or null for
   * an account that has shown none. Null is a real answer and not a zero; the
   * `last_active` *ordering* falls back to the signup date so such an account
   * still has a place in the list.
   */
  last_active: isoInstant.nullable(),
  stage: z.enum(ADMIN_USER_STAGES),
  /**
   * Banned in GoTrue, and still banned now.
   *
   * A boolean rather than the `banned_until` timestamp, because the timestamp
   * is `suspend`'s implementation — a hundred years out — and an expired one
   * would read as a suspension that is still in force. Suspension is metadata:
   * the account cannot sign in and every row it owns is untouched.
   */
  suspended: z.boolean(),
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

/**
 * Where the next page starts: the whole sort key of this page's last row.
 *
 * Both halves, never just the timestamp. The routine orders by
 * `(sort_at, user_id)`, so a cursor carrying only the instant would skip every
 * row tied with the last one on the page — and ties are ordinary here, since
 * two accounts created in the same statement share a `created_at` exactly.
 */
export const AdminUsersCursorSchema = z.object({
  before: isoInstant,
  before_id: z.string().uuid(),
});
export type AdminUsersCursor = z.infer<typeof AdminUsersCursorSchema>;

/**
 * One page of accounts.
 *
 * Only a FULL page can carry a cursor: a short page means the filter is
 * exhausted, so "Load more" is absent rather than present and fruitless. The
 * comparison is strict, which is what makes two consecutive pages disjoint as
 * well as complete.
 */
export const AdminUsersResponseSchema = z.object({
  rows: z.array(AdminUserRowSchema),
  next_cursor: AdminUsersCursorSchema.nullable(),
});
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

/**
 * One account in detail: the same row, plus the last 30 UTC days of activity.
 *
 * The row is not restated in SQL either — `admin_user_detail` narrows
 * `admin_users` to one id — so the drawer and the table can never disagree
 * about what a field means.
 */
export const AdminUserDetailSchema = AdminUserRowSchema.extend({
  ai_pause: z
    .object({
      paused: z.boolean(),
      tier: z.enum(['cooldown', 'hold']).nullable(),
      resumes_at: isoInstant.nullable(),
    })
    .optional(),
  activity_by_day: z.array(z.object({ date: isoDate, notes: count, recalls: count, tidy: count })),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

/**
 * Which section of the dashboard a request asks for.
 *
 * One endpoint, three shapes, rather than three functions: the gate, the
 * `verify_jwt` pin and the service client are the same in every case, and a
 * second admin function would be a second place to get that wrong. `overview`
 * is the default so an older client that sends only `{ days }` keeps working.
 */
export const AdminUsersQuerySchema = z.object({
  section: z.literal('users'),
  limit: z.number().int().min(1).max(100).optional(),
  /** Both halves of the previous page's last sort key, or neither. */
  before: isoInstant.optional(),
  before_id: z.string().uuid().optional(),
  /** Email prefix or an exact user id. Long enough for either, bounded anyway. */
  search: z.string().max(320).optional(),
  sort: z.enum(ADMIN_USER_SORTS).optional(),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;

export const AdminUserQuerySchema = z.object({
  section: z.literal('user'),
  user_id: z.string().uuid(),
});
export type AdminUserQuery = z.infer<typeof AdminUserQuerySchema>;

/* ---------- the audit log (plans/admin-users-and-actions.md §5) ---------- */

/**
 * The closed action vocabulary.
 *
 * Closed is the point (`plans/admin-users-and-actions.md` §0): each name is
 * one dedicated SQL routine or one auth admin call, each is recorded before it
 * returns, and each is behind a confirm step that types the target's email.
 * There is no free-form SQL path and no generic "update this account" verb, so
 * an audit row's `action` is a complete description of what happened rather
 * than a label on an arbitrary statement.
 */
export const ADMIN_ACTIONS = [
  'grant_pro',
  'revoke_pro',
  'reset_recall_quota',
  'lift_ai_pause',
  'revoke_keys',
  'send_magic_link',
  'resend_confirmation',
  'suspend',
  'unsuspend',
  'purge_account',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * One request to perform one action.
 *
 * `confirm_email` is the server half of the typed confirmation: the UI
 * disables its button until the operator has typed the target's address, and
 * the function refuses the call unless the string equals the target's CURRENT
 * email lower-cased. The client check is a courtesy; this one is the rule, and
 * it is what stops a stale drawer acting on the account that has since taken
 * that row's place.
 *
 * `reason` may be empty — an operator in a hurry should not be made to invent
 * prose — but it is bounded, because it is stored verbatim in a row nobody
 * ever deletes.
 */
export const AdminActionRequestSchema = z.object({
  action: z.enum(ADMIN_ACTIONS),
  user_id: z.string().uuid(),
  confirm_email: z.string().min(1).max(320),
  reason: z.string().max(500),
});
export type AdminActionRequest = z.infer<typeof AdminActionRequestSchema>;

/**
 * What an action returns.
 *
 * `audit_id` is always present, including on the 500 path, because the row is
 * written before the action runs: an action is never performed without a trace
 * and a trace never claims a success it did not observe. `result` is whatever
 * the routine or the auth call reported — counts, the period key, the plan it
 * moved from — and never a link, a token or an OTP.
 */
export const AdminActionResponseSchema = z.object({
  ok: z.literal(true),
  audit_id: z.string().uuid(),
  result: z.record(z.unknown()),
});
export type AdminActionResponse = z.infer<typeof AdminActionResponseSchema>;

/**
 * One row of the log.
 *
 * `target_email` is stored beside `target_user_id` rather than joined, because
 * after `purge_account` the id resolves to nothing and a log that cannot say
 * who an action was about is not a log.
 */
export const AdminAuditRowSchema = z.object({
  id: z.string().uuid(),
  at: isoInstant,
  admin_email: z.string(),
  action: z.string(),
  target_user_id: z.string().uuid(),
  target_email: z.string(),
  reason: z.string(),
  detail: z.record(z.unknown()),
});
export type AdminAuditRow = z.infer<typeof AdminAuditRowSchema>;

export const AdminAuditResponseSchema = z.object({ rows: z.array(AdminAuditRowSchema) });
export type AdminAuditResponse = z.infer<typeof AdminAuditResponseSchema>;

/** The dashboard's fourth section: the last N audit rows, newest first. */
export const AdminAuditQuerySchema = z.object({
  section: z.literal('audit'),
  limit: z.number().int().min(1).max(200).optional(),
});
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;
