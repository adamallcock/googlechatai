import fs from "node:fs/promises";
import { withFileStateLock, writeFileAtomically } from "../internal/file-state.js";

export const DIRECTORY_USER_READONLY_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.user.readonly";

export type DirectoryStatus =
  | "active"
  | "suspended"
  | "deleted"
  | "stale"
  | "unavailable";

export interface DirectoryUserLike {
  id?: string | null;
  primaryEmail?: string | null;
  emails?: Array<{ address?: string | null } | string>;
  aliases?: string[];
  name?: { fullName?: string | null; givenName?: string | null; familyName?: string | null };
  suspended?: boolean;
  deleted?: boolean;
}

export interface HumanIdentity {
  id: string | null;
  name: string | null;
  email: string | null;
  aliases: string[];
  displayName: string | null;
  source: "directory_cache" | "chat_payload" | "unresolved";
  directoryStatus: DirectoryStatus;
  stale: boolean;
  lastSeenAt: string | null;
  lastDirectorySyncAt: string | null;
  access: { status: "available" | "access_limited"; reason: string | null };
}

export interface IdentityCache {
  getById(id: string): Promise<HumanIdentity | null>;
  getByEmail(email: string): Promise<HumanIdentity | null>;
  list(): Promise<HumanIdentity[]>;
  putMany(records: HumanIdentity[]): Promise<void>;
}

interface SerializedIdentityCache {
  version: 1;
  records: HumanIdentity[];
}

const DIRECTORY_SYNC_TTL_MS = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function asEmailList(user: DirectoryUserLike): string[] {
  const emails = [
    user.primaryEmail,
    ...(user.aliases ?? []),
    ...(user.emails ?? []).map((email) =>
      typeof email === "string" ? email : email.address,
    ),
  ];
  return [...new Set(emails.filter((email): email is string => Boolean(email)).map((email) => email.toLowerCase()))];
}

function displayNameFor(user: DirectoryUserLike): string | null {
  if (user.name?.fullName) {
    return user.name.fullName;
  }
  const parts = [user.name?.givenName, user.name?.familyName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : user.primaryEmail ?? null;
}

function idFromRef(ref: { name?: string | null; id?: string | null }): string | null {
  if (ref.id) {
    return ref.id;
  }
  if (ref.name?.startsWith("users/")) {
    return ref.name.slice("users/".length);
  }
  return null;
}

function statusFor(user: DirectoryUserLike): DirectoryStatus {
  if (user.deleted) {
    return "deleted";
  }
  if (user.suspended) {
    return "suspended";
  }
  return "active";
}

function recordFromUser(user: DirectoryUserLike, nowMs: number): HumanIdentity | null {
  const id = user.id ?? null;
  const email = user.primaryEmail?.toLowerCase() ?? asEmailList(user)[0] ?? null;
  if (!id && !email) {
    return null;
  }
  const aliases = asEmailList(user).filter((candidate) => candidate !== email);
  const directoryStatus = statusFor(user);
  return {
    id,
    name: id ? `users/${id}` : null,
    email,
    aliases,
    displayName: displayNameFor(user),
    source: "directory_cache",
    directoryStatus,
    stale: false,
    lastSeenAt: iso(nowMs),
    lastDirectorySyncAt: iso(nowMs),
    access: { status: "available", reason: null },
  };
}

function cloneRecord(record: HumanIdentity): HumanIdentity {
  return {
    ...record,
    aliases: [...record.aliases],
    access: { ...record.access },
  };
}

export function buildDirectoryUsersListPlan(options: {
  customer?: string;
  projection?: "BASIC" | "CUSTOM" | "FULL";
  viewType?: "domain_public" | "admin_view";
  maxResults?: number;
} = {}): Record<string, unknown> {
  const url = new URL("https://admin.googleapis.com/admin/directory/v1/users");
  url.searchParams.set("customer", options.customer ?? "my_customer");
  url.searchParams.set("projection", options.projection ?? "BASIC");
  url.searchParams.set("viewType", options.viewType ?? "domain_public");
  url.searchParams.set("maxResults", String(options.maxResults ?? 500));
  return {
    kind: "directory.users.list",
    method: "GET",
    url: url.toString(),
    auth: {
      required: true,
      mode: "user",
      scopes: [DIRECTORY_USER_READONLY_SCOPE],
      notes: [
        "Uses the Admin SDK Directory API surface, but viewType=domain_public only asks for fields visible within the domain.",
        "If the signed-in user or tenant policy cannot grant this scope, identity enrichment should stay unavailable instead of failing Chat handling.",
      ],
    },
    cache: {
      recommendedTtlMs: DIRECTORY_SYNC_TTL_MS,
      neverDeleteMissingUsers: true,
    },
  };
}

export class InMemoryIdentityCache implements IdentityCache {
  readonly #records = new Map<string, HumanIdentity>();

  async getById(id: string): Promise<HumanIdentity | null> {
    const found = this.#records.get(`id:${id}`);
    return found ? cloneRecord(found) : null;
  }

  async getByEmail(email: string): Promise<HumanIdentity | null> {
    const found = this.#records.get(`email:${email.toLowerCase()}`);
    return found ? cloneRecord(found) : null;
  }

  async list(): Promise<HumanIdentity[]> {
    const unique = new Map<string, HumanIdentity>();
    for (const record of this.#records.values()) {
      const key = record.id ?? record.email;
      if (key) {
        unique.set(key, cloneRecord(record));
      }
    }
    return [...unique.values()];
  }

  async putMany(records: HumanIdentity[]): Promise<void> {
    for (const record of records) {
      this.#put(record);
    }
  }

  #put(record: HumanIdentity): void {
    const cloned = cloneRecord(record);
    if (cloned.id) {
      this.#records.set(`id:${cloned.id}`, cloned);
    }
    if (cloned.email) {
      this.#records.set(`email:${cloned.email.toLowerCase()}`, cloned);
    }
    for (const alias of cloned.aliases) {
      this.#records.set(`email:${alias.toLowerCase()}`, cloned);
    }
  }
}

export class FileIdentityCache implements IdentityCache {
  readonly #filePath: string;

  constructor(options: { filePath: string }) {
    if (!options.filePath) {
      throw new TypeError("FileIdentityCache requires filePath.");
    }
    this.#filePath = options.filePath;
  }

  async getById(id: string): Promise<HumanIdentity | null> {
    return (await this.#load()).getById(id);
  }

  async getByEmail(email: string): Promise<HumanIdentity | null> {
    return (await this.#load()).getByEmail(email);
  }

  async list(): Promise<HumanIdentity[]> {
    return (await this.#load()).list();
  }

  async putMany(records: HumanIdentity[]): Promise<void> {
    await withFileStateLock(this.#filePath, async () => {
      const cache = await this.#load();
      await cache.putMany(records);
      const payload: SerializedIdentityCache = {
        version: 1,
        records: await cache.list(),
      };
      await writeFileAtomically(
        this.#filePath,
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    });
  }

  async #load(): Promise<InMemoryIdentityCache> {
    const cache = new InMemoryIdentityCache();
    try {
      const payload = JSON.parse(await fs.readFile(this.#filePath, "utf8")) as
        | SerializedIdentityCache
        | undefined;
      await cache.putMany(payload?.records ?? []);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    return cache;
  }
}

export async function syncDirectoryUsersToCache(
  users: DirectoryUserLike[],
  options: {
    cache: IdentityCache;
    nowMs?: number;
    markMissingStale?: boolean;
  },
): Promise<{ synced: number; stale: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const incoming = users
    .map((user) => recordFromUser(user, nowMs))
    .filter((record): record is HumanIdentity => record !== null);
  const incomingKeys = new Set(
    incoming.map((record) => record.id ?? record.email).filter(Boolean),
  );
  let stale = 0;

  if (options.markMissingStale) {
    const existing = await options.cache.list();
    for (const record of existing) {
      const key = record.id ?? record.email;
      if (key && !incomingKeys.has(key) && record.directoryStatus !== "stale") {
        incoming.push({
          ...record,
          directoryStatus: "stale",
          stale: true,
          access: {
            status: "available",
            reason: "directory_user_missing_from_latest_sync",
          },
        });
        stale += 1;
      }
    }
  }

  await options.cache.putMany(incoming);
  return { synced: incoming.length - stale, stale };
}

export async function resolveHumanIdentity(
  ref: {
    name?: string | null;
    id?: string | null;
    email?: string | null;
    displayName?: string | null;
  },
  options: { cache: IdentityCache },
): Promise<HumanIdentity> {
  const id = idFromRef(ref);
  if (id) {
    const found = await options.cache.getById(id);
    if (found) {
      return found;
    }
  }
  if (ref.email) {
    const found = await options.cache.getByEmail(ref.email);
    if (found) {
      return found;
    }
  }
  if (ref.displayName || ref.email) {
    return {
      id,
      name: ref.name ?? (id ? `users/${id}` : null),
      email: ref.email ?? null,
      aliases: [],
      displayName: ref.displayName ?? ref.email ?? null,
      source: "chat_payload",
      directoryStatus: "unavailable",
      stale: false,
      lastSeenAt: null,
      lastDirectorySyncAt: null,
      access: { status: "available", reason: null },
    };
  }
  return {
    id,
    name: ref.name ?? (id ? `users/${id}` : null),
    email: null,
    aliases: [],
    displayName: null,
    source: "unresolved",
    directoryStatus: "unavailable",
    stale: false,
    lastSeenAt: null,
    lastDirectorySyncAt: null,
    access: { status: "access_limited", reason: "identity_not_in_cache" },
  };
}

export function renderIdentitySystemNote(
  identity: HumanIdentity,
  options: { role?: string } = {},
): string {
  const role = options.role ?? "user";
  if (identity.access.status === "access_limited") {
    return `System Note: The ${role} identity ${
      identity.name ?? identity.email ?? "unknown"
    } could not be resolved to a human-readable directory user.`;
  }
  const stale = identity.stale
    ? " This directory record is stale and may be out of date."
    : "";
  const email = identity.email ? ` <${identity.email}>` : "";
  return `System Note: The ${role} is ${identity.displayName ?? "Unknown"}${email}.${stale}`;
}
