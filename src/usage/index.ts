// `usage`: call records, sinks, pricing, the spend ceiling and the usage
// config slice. Its shared types live in `../serve/types.ts` (re-exported from
// `serve`); `usageWiring` builds what serve's call seam takes.

export {
  type PostgresCallLog,
  type PostgresCallLogOptions,
  postgresCallLog,
} from "./call-log.ts";
export {
  type CallLogCounts,
  type CallLogRetentionStatus,
  callLogRetentionStatus,
  RETENTION_SLACK_DAYS,
  renderCallLogMetrics,
} from "./call-log-health.ts";
export { CALL_ERROR_CLASSES, type CallErrorClass, errorClassOf } from "./error-class.ts";
export { RootstockUsageError, type UsageErrorCode, usageErrorCode } from "./errors.ts";
export { type PrometheusToolMetrics, prometheusToolMetrics } from "./prometheus.ts";
export { type UsageSlice, type UsageSliceInput, usageSlice } from "./slice.ts";
export {
  createSpendCeiling,
  type ErrorConstructorOf,
  type PostgresSpendStoreOptions,
  postgresSpendStore,
  type SpendCeilingOptions,
  type SpendStore,
  type SpendStoreShape,
  type SpendUnit,
} from "./spend.ts";
export { type UsageWiringOptions, usageWiring } from "./wiring.ts";
