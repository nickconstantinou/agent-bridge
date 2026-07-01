import Database, { type Database as BetterDB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Customer,
  InfrastructureStatus,
  Subscription,
  SubscriptionStatus,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceInfrastructure,
  WorkspaceRecord,
  WorkspaceStatus,
} from "./types.js";

type DbRow = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return JSON.parse(value) as Record<string, unknown>;
}

function parseTags(value: unknown): Record<string, string> {
  if (typeof value !== "string" || value.length === 0) return {};
  return JSON.parse(value) as Record<string, string>;
}

function workspaceFromRow(row: DbRow): WorkspaceRecord {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    status: row.status as WorkspaceStatus,
    region: String(row.region),
    flavor: String(row.flavor),
    billingStatus: String(row.billing_status),
    applianceId: row.appliance_id == null ? null : String(row.appliance_id),
    lastHeartbeatAt: row.last_heartbeat_at == null ? null : String(row.last_heartbeat_at),
    latestHealth: parseJsonObject(row.latest_health_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function infraFromRow(row: DbRow): WorkspaceInfrastructure {
  return {
    workspaceId: String(row.workspace_id),
    provider: "mock",
    status: row.status as InfrastructureStatus,
    region: String(row.region),
    flavor: String(row.flavor),
    serverId: String(row.server_id),
    elasticIpId: String(row.elastic_ip_id),
    securityGroupId: String(row.security_group_id),
    bootVolumeId: String(row.boot_volume_id),
    keyPairId: String(row.key_pair_id),
    ipAddress: row.ip_address == null ? null : String(row.ip_address),
    tags: parseTags(row.tags_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class ControlPlaneStore {
  private db: BetterDB;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        status TEXT NOT NULL,
        billing_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        status TEXT NOT NULL,
        region TEXT NOT NULL,
        flavor TEXT NOT NULL,
        billing_status TEXT NOT NULL,
        appliance_id TEXT,
        last_heartbeat_at TEXT,
        latest_health_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );
      CREATE TABLE IF NOT EXISTS workspace_infrastructure (
        workspace_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        region TEXT NOT NULL,
        flavor TEXT NOT NULL,
        server_id TEXT NOT NULL,
        elastic_ip_id TEXT NOT NULL,
        security_group_id TEXT NOT NULL,
        boot_volume_id TEXT NOT NULL,
        key_pair_id TEXT NOT NULL,
        ip_address TEXT,
        tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE IF NOT EXISTS workspace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
        UNIQUE(workspace_id, seq)
      );
      CREATE TABLE IF NOT EXISTS bootstrap_tokens (
        token TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );
    `);
    try {
      this.db.exec("ALTER TABLE workspace_infrastructure ADD COLUMN ip_address TEXT");
    } catch {
      // Existing databases already have the column.
    }
  }

  createCustomer(input: { id: string; email: string }): Customer {
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO customers (id, email, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(input.id, input.email, at, at);
    return { id: input.id, email: input.email, createdAt: at, updatedAt: at };
  }

  createSubscription(input: {
    id: string;
    customerId: string;
    status: SubscriptionStatus;
    billingStatus?: string;
  }): Subscription {
    const at = nowIso();
    const billingStatus = input.billingStatus || input.status;
    this.db.prepare(`
      INSERT INTO subscriptions (id, customer_id, status, billing_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.customerId, input.status, billingStatus, at, at);
    return { id: input.id, customerId: input.customerId, status: input.status, billingStatus, createdAt: at, updatedAt: at };
  }

  hasActiveSubscription(customerId: string): boolean {
    const row = this.db.prepare(`
      SELECT id FROM subscriptions
      WHERE customer_id = ? AND status = 'active'
      LIMIT 1
    `).get(customerId);
    return !!row;
  }

  findCustomerWorkspace(customerId: string): WorkspaceRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspaces
      WHERE customer_id = ? AND status != 'destroyed'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(customerId) as DbRow | undefined;
    return row ? workspaceFromRow(row) : null;
  }

  createWorkspace(input: {
    id: string;
    customerId: string;
    status: WorkspaceStatus;
    region: string;
    flavor: string;
    billingStatus?: string;
  }): WorkspaceRecord {
    const at = nowIso();
    const billingStatus = input.billingStatus || "placeholder_active";
    this.db.prepare(`
      INSERT INTO workspaces
        (id, customer_id, status, region, flavor, billing_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.customerId, input.status, input.region, input.flavor, billingStatus, at, at);
    return {
      id: input.id,
      customerId: input.customerId,
      status: input.status,
      region: input.region,
      flavor: input.flavor,
      billingStatus,
      applianceId: null,
      lastHeartbeatAt: null,
      latestHealth: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as DbRow | undefined;
    return row ? workspaceFromRow(row) : null;
  }

  updateWorkspaceStatus(workspaceId: string, status: WorkspaceStatus): WorkspaceRecord {
    const at = nowIso();
    this.db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?").run(status, at, workspaceId);
    return this.requireWorkspace(workspaceId);
  }

  setApplianceRegistered(workspaceId: string, applianceId: string): WorkspaceRecord {
    const at = nowIso();
    this.db.prepare(`
      UPDATE workspaces SET status = 'appliance_registered', appliance_id = ?, updated_at = ?
      WHERE id = ?
    `).run(applianceId, at, workspaceId);
    return this.requireWorkspace(workspaceId);
  }

  updateHeartbeat(workspaceId: string, health: Record<string, unknown>): WorkspaceRecord {
    const at = nowIso();
    this.db.prepare(`
      UPDATE workspaces
      SET status = 'ready', last_heartbeat_at = ?, latest_health_json = ?, updated_at = ?
      WHERE id = ?
    `).run(at, JSON.stringify(health), at, workspaceId);
    return this.requireWorkspace(workspaceId);
  }

  createInfrastructure(input: Omit<WorkspaceInfrastructure, "createdAt" | "updatedAt">): WorkspaceInfrastructure {
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO workspace_infrastructure
        (workspace_id, provider, status, region, flavor, server_id, elastic_ip_id,
         security_group_id, boot_volume_id, key_pair_id, ip_address, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceId,
      input.provider,
      input.status,
      input.region,
      input.flavor,
      input.serverId,
      input.elasticIpId,
      input.securityGroupId,
      input.bootVolumeId,
      input.keyPairId,
      input.ipAddress,
      JSON.stringify(input.tags),
      at,
      at,
    );
    return { ...input, createdAt: at, updatedAt: at };
  }

  getInfrastructure(workspaceId: string): WorkspaceInfrastructure | null {
    const row = this.db.prepare("SELECT * FROM workspace_infrastructure WHERE workspace_id = ?").get(workspaceId) as DbRow | undefined;
    return row ? infraFromRow(row) : null;
  }

  updateInfrastructureStatus(workspaceId: string, status: InfrastructureStatus): void {
    this.db.prepare("UPDATE workspace_infrastructure SET status = ?, updated_at = ? WHERE workspace_id = ?")
      .run(status, nowIso(), workspaceId);
  }

  markInfrastructureUnknown(workspaceId: string): void {
    this.updateInfrastructureStatus(workspaceId, "unknown");
  }

  createBootstrapToken(input: { token: string; workspaceId: string; expiresAt: string }): void {
    this.db.prepare(`
      INSERT INTO bootstrap_tokens (token, workspace_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.token, input.workspaceId, input.expiresAt, nowIso());
  }

  consumeBootstrapToken(token: string): { workspaceId: string } | null {
    const row = this.db.prepare(`
      SELECT token, workspace_id, expires_at, used_at FROM bootstrap_tokens WHERE token = ?
    `).get(token) as DbRow | undefined;
    if (!row || row.used_at || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
    this.db.prepare("UPDATE bootstrap_tokens SET used_at = ? WHERE token = ?").run(nowIso(), token);
    return { workspaceId: String(row.workspace_id) };
  }

  addWorkspaceEvent(workspaceId: string, type: WorkspaceEventType, payload: Record<string, unknown> = {}): WorkspaceEvent {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workspace_events WHERE workspace_id = ?")
      .get(workspaceId) as { seq: number };
    const seq = Number(row.seq);
    const at = nowIso();
    const result = this.db.prepare(`
      INSERT INTO workspace_events (workspace_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workspaceId, seq, type, JSON.stringify(payload), at);
    return { id: Number(result.lastInsertRowid), workspaceId, seq, type, payload, createdAt: at };
  }

  listWorkspaceEvents(workspaceId: string): WorkspaceEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY seq ASC
    `).all(workspaceId) as DbRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      workspaceId: String(row.workspace_id),
      seq: Number(row.seq),
      type: row.type as WorkspaceEventType,
      payload: parseJsonObject(row.payload_json) || {},
      createdAt: String(row.created_at),
    }));
  }

  requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    return workspace;
  }
}
