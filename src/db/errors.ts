/**
 * Database failures as a fixed category and a Postgres code (SQLSTATE). The driver also
 * gives a message, a detail and a hint, which can quote the failing row or the query,
 * so those are dropped here and never reach a caller, a log line or `job_runs`.
 */

export type DbErrorCategory =
  /** Refused before any query, because an input failed validation. */
  | "invalid_input"
  /** No row matched. Absent and forbidden look the same on purpose. */
  | "not_found"
  /** A config version check failed: reload and try again. */
  | "stale_version"
  /** The channel was removed, or the event closed or deleted. */
  | "parent_unavailable"
  /** The task changed after the caller read it. */
  | "task_changed"
  /** The event already holds as many tasks as it may. */
  | "event_task_limit"
  /** This officer has created as many tasks as they may for now. */
  | "actor_task_limit"
  /** The step needs the budget approved first. */
  | "step_not_ready"
  /** The step already has as many people as it may. */
  | "step_assignee_limit"
  | "conflict"
  | "constraint"
  | "forbidden"
  /** The database returned a row or value this code cannot read. */
  | "bad_row"
  | "unavailable"
  | "unexpected";

export interface DbError {
  readonly category: DbErrorCategory;
  readonly code: string | null;
}

export interface DbFailure {
  readonly ok: false;
  readonly error: DbError;
}

export type DbResult<T> = { readonly ok: true; readonly value: T } | DbFailure;

const CATEGORY_BY_CODE = new Map<string, DbErrorCategory>([
  ["CF409", "stale_version"],
  ["CF410", "parent_unavailable"],
  ["CF412", "task_changed"],
  ["CF429", "event_task_limit"],
  ["CF430", "actor_task_limit"],
  ["CF428", "step_not_ready"],
  ["CF431", "step_assignee_limit"],
  ["23505", "conflict"],
  ["23502", "constraint"],
  ["23503", "constraint"],
  ["23514", "constraint"],
  ["22023", "constraint"],
  ["22P02", "constraint"],
  ["22P05", "constraint"],
  ["22007", "constraint"],
  ["22008", "constraint"],
  ["42501", "forbidden"],
  // Lost a lock or was cancelled: nothing was wrong with the request, so try later.
  ["40001", "unavailable"],
  ["40P01", "unavailable"],
  ["55P03", "unavailable"],
  ["57014", "unavailable"],
]);

export function failure(
  category: DbErrorCategory,
  code: string | null = null,
): DbFailure {
  return { ok: false, error: { category, code } };
}

export function refused(): DbFailure {
  return failure("invalid_input");
}

/** SQLSTATE classes that say the server could not do the work now, not that it was wrong. */
const UNAVAILABLE_CLASSES = new Set(["08", "53", "57", "58", "XX"]);

/** SQLSTATE classes for a refused login or role, which look like any other refusal. */
const FORBIDDEN_CLASSES = new Set(["28"]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * What node-postgres throws, with no code, when a connection is lost, cannot be made or
 * times out, rather than a query being wrong. Each is compared whole and never passed on.
 */
const CONNECTION_FAILURES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
  "timeout expired",
  "timeout exceeded when trying to connect",
  "Query read timeout",
  "The server does not support SSL connections",
  "There was an error establishing an SSL connection",
]);

/** The ones that mean an open connection died, so the statement never ran to an end. */
const DEAD_CONNECTION = new Set([
  "Connection terminated unexpectedly",
  "Client has encountered a connection error and is not queryable",
]);
/** Socket codes for the same, from Node rather than node-postgres. */
const DEAD_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE"]);

/** The driver's error under Drizzle's wrapper, whose message holds the whole query. */
function driverError(error: unknown): object | null {
  const cause =
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null
      ? error.cause
      : error;
  return typeof cause === "object" && cause !== null ? cause : null;
}

function messageOf(cause: object): unknown {
  return "message" in cause ? cause.message : undefined;
}

/**
 * Whether a query failed because its connection died under it, such as a pooled
 * connection the server closed while the function instance was frozen. Nothing came
 * back from the server, so a read can safely be sent once more.
 */
export function isDeadConnection(error: unknown): boolean {
  const cause = driverError(error);
  if (cause === null || "severity" in cause) {
    return false;
  }
  const code = "code" in cause ? cause.code : undefined;
  if (typeof code === "string") {
    return DEAD_SOCKET_CODES.has(code);
  }
  const message = messageOf(cause);
  return typeof message === "string" && DEAD_CONNECTION.has(message);
}

/**
 * Reads only the SQLSTATE from a failed query. The driver's message can quote the
 * statement, its parameters or the failing row, and Drizzle wraps the error in one whose
 * message holds the whole query, so neither is ever passed on. An error with no server
 * severity never reached the database. With a code, such as a refused connection or a
 * SQLSTATE the driver made up, it is `unavailable`. With none, it is one of the driver's
 * own connection failures, matched by its exact text, or else a fault in the code, such
 * as a TypeError, which is `unexpected` so that it is not retried as an outage.
 */
export function failureFromError(error: unknown): DbFailure {
  const cause = driverError(error);
  if (cause === null) {
    return failure("unexpected");
  }
  const fromServer = "severity" in cause && typeof cause.severity === "string";
  const code = "code" in cause ? cause.code : undefined;
  if (!fromServer) {
    if (typeof code === "string" || typeof code === "number") {
      return failure("unavailable");
    }
    const message = messageOf(cause);
    return failure(
      typeof message === "string" && CONNECTION_FAILURES.has(message)
        ? "unavailable"
        : "unexpected",
    );
  }
  if (typeof code !== "string" || !SQLSTATE.test(code)) {
    return failure("unavailable");
  }
  const codeClass = code.slice(0, 2);
  return failure(
    CATEGORY_BY_CODE.get(code) ??
      (FORBIDDEN_CLASSES.has(codeClass)
        ? "forbidden"
        : UNAVAILABLE_CLASSES.has(codeClass)
          ? "unavailable"
          : "unexpected"),
    code,
  );
}

/** The only form of an error that may be stored in `job_runs.error` or logged. */
export function errorSummary(error: {
  readonly category: string;
  readonly code: string | null;
}): string {
  return error.code === null
    ? error.category
    : `${error.category}:${error.code}`;
}
