import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the token
  adminId: integer("admin_id")
    .notNull()
    .references(() => admins.id, { onDelete: "cascade" }),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workers = pgTable(
  "workers",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    port: integer("port").notNull(),
    statsPort: integer("stats_port").notNull(),
    mode: text("mode").notNull(), // classic | secure | faketls
    tlsDomain: text("tls_domain"),
    status: text("status").notNull().default("pending"), // pending|deploying|active|stopped|failed|error|deleting
    statusMessage: text("status_message"),
    desiredState: text("desired_state").notNull().default("running"), // running | stopped
    maxConnections: integer("max_connections"),
    connLimitEnabled: boolean("conn_limit_enabled").notNull().default(false),
    downloadKbps: integer("download_kbps"),
    uploadKbps: integer("upload_kbps"),
    bwLimitEnabled: boolean("bw_limit_enabled").notNull().default(false),
    autoRestart: boolean("auto_restart").notNull().default(true),
    restartCount: integer("restart_count").notNull().default(0),
    autoRestartWindowStart: timestamp("auto_restart_window_start", { withTimezone: true }),
    autoRestartsInWindow: integer("auto_restarts_in_window").notNull().default(0),
    epollStatus: text("epoll_status").notNull().default("unknown"),
    netStatus: text("net_status"), // JSON: last NETSTATUS line from the host helper + exit code
    trafficRxBytes: bigint("traffic_rx_bytes", { mode: "number" }).notNull().default(0),
    trafficTxBytes: bigint("traffic_tx_bytes", { mode: "number" }).notNull().default(0),
    publicIp: text("public_ip"),
    configVersion: integer("config_version").notNull().default(1),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workers_port_uq").on(t.port), uniqueIndex("workers_stats_port_uq").on(t.statsPort)],
);

export const proxySecrets = pgTable("proxy_secrets", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id")
    .notNull()
    .references(() => workers.id, { onDelete: "cascade" }),
  secretEnc: text("secret_enc").notNull(), // AES-256-GCM encrypted 32-hex secret
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sponsorships = pgTable("sponsorships", {
  workerId: integer("worker_id")
    .primaryKey()
    .references(() => workers.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("none"), // none | waiting | active
  tagEnc: text("tag_enc"),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  note: text("note"),
});

export const workerConfigs = pgTable(
  "worker_configs",
  {
    id: serial("id").primaryKey(),
    workerId: integer("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull(),
    appliedOk: boolean("applied_ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("worker_configs_worker_idx").on(t.workerId)],
);

export const connectionStats = pgTable(
  "connection_stats",
  {
    id: serial("id").primaryKey(),
    workerId: integer("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    activeConnections: integer("active_connections").notNull(),
    uniqueIps: integer("unique_ips").notNull(),
    attempts: bigint("attempts", { mode: "number" }),
  },
  (t) => [index("connection_stats_worker_ts").on(t.workerId, t.ts)],
);

export const bandwidthStats = pgTable(
  "bandwidth_stats",
  {
    id: serial("id").primaryKey(),
    workerId: integer("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    rxBytes: bigint("rx_bytes", { mode: "number" }).notNull(),
    txBytes: bigint("tx_bytes", { mode: "number" }).notNull(),
    rxRate: doublePrecision("rx_rate").notNull(),
    txRate: doublePrecision("tx_rate").notNull(),
  },
  (t) => [index("bandwidth_stats_worker_ts").on(t.workerId, t.ts)],
);

export const resourceMeasurements = pgTable(
  "resource_measurements",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    scope: text("scope").notNull(), // global | worker
    workerId: integer("worker_id").references(() => workers.id, { onDelete: "cascade" }),
    cpuPercent: doublePrecision("cpu_percent"),
    memBytes: bigint("mem_bytes", { mode: "number" }),
    extra: jsonb("extra"),
  },
  (t) => [index("resource_measurements_scope_ts").on(t.scope, t.ts)],
);

export const protectionState = pgTable("protection_state", {
  id: integer("id").primaryKey(), // always 1
  stage: integer("stage").notNull().default(0),
  aboveSince: bigint("above_since", { mode: "number" }),
  belowSince: bigint("below_since", { mode: "number" }),
  lastEscalationAt: bigint("last_escalation_at", { mode: "number" }),
  lastRecoveryAt: bigint("last_recovery_at", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const protectionEvents = pgTable(
  "protection_events",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    type: text("type").notNull(), // trigger|escalate|restriction|recover|restore|error|manual
    stage: integer("stage").notNull(),
    cpuPercent: doublePrecision("cpu_percent"),
    message: text("message").notNull(),
    details: jsonb("details"),
  },
  (t) => [index("protection_events_ts").on(t.ts)],
);

export const restrictions = pgTable(
  "restrictions",
  {
    id: serial("id").primaryKey(),
    workerId: integer("worker_id").references(() => workers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // bandwidth | conn_per_ip | ip_block | cpu_quota
    stage: integer("stage").notNull(),
    target: text("target"), // IP for ip_block
    value: jsonb("value").notNull(),
    original: jsonb("original"),
    active: boolean("active").notNull().default(true),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (t) => [index("restrictions_active_idx").on(t.active)],
);

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    level: text("level").notNull().default("info"),
    details: jsonb("details"),
    ip: text("ip"),
  },
  (t) => [index("activity_logs_ts").on(t.ts)],
);

export const backups = pgTable("backups", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull().unique(),
  kind: text("kind").notNull(), // manual | scheduled | pre-restore | pre-update
  status: text("status").notNull(), // creating | ready | failed
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  error: text("error"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("queued"), // queued|running|succeeded|failed|cancelled
    progress: integer("progress").notNull().default(0),
    step: text("step"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    error: text("error"),
    result: jsonb("result"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_status_idx").on(t.status), index("jobs_idem_idx").on(t.idempotencyKey)],
);

export type Worker = typeof workers.$inferSelect;
export type Job = typeof jobs.$inferSelect;
