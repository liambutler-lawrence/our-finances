"use client";

import { emptyFinanceData, type FinanceData } from "./finance-data";
import { normalizeFinanceData } from "./ledger";

const CLOUDKIT_SCRIPT =
  "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
const LEDGER_RECORD_NAME = "ledger-v1";
const LEDGER_ZONE_NAME = "OurFinancesLedgerV1";
const LEDGER_RECORD_TYPE = "FinanceLedger";
const LEDGER_SCHEMA_VERSION = "3.0.0";
const LEDGER_DOCUMENT_KIND = "our-finances-cloudkit-document-v1";
// CloudKit limits non-asset record data to 1 MB. The web-services BYTES value
// is base64 in transit, so its string length is roughly 4/3 of the bytes that
// CloudKit stores. Keep 50 kB of headroom for encryption and record metadata.
const MAX_COMPRESSED_PAYLOAD_BYTES = 950_000;

export type CloudKitIdentity = {
  userRecordName: string;
  nameComponents?: {
    givenName?: string;
    familyName?: string;
  };
};

type CloudKitError = {
  ckErrorCode?: string;
  code?: string;
  reason?: string;
  message?: string;
  serverErrorCode?: string;
};

type CloudKitField = {
  value: unknown;
  type?: string;
  isEncrypted?: boolean;
};

type CloudKitZoneID = {
  zoneName: string;
  ownerRecordName?: string;
};

type CloudKitRecordZone = {
  zoneID: CloudKitZoneID;
};

type CloudKitRecord = {
  recordName: string;
  recordType: string;
  recordChangeTag?: string;
  fields: Record<string, CloudKitField>;
};

type CloudKitResponse = {
  hasErrors?: boolean;
  errors?: CloudKitError[];
  records?: CloudKitRecord[];
  zones?: CloudKitRecordZone[];
};

type CloudKitDatabase = {
  fetchRecords(
    records: string | string[],
    options?: Record<string, unknown>,
  ): Promise<CloudKitResponse>;
  saveRecords(
    records: CloudKitRecord | CloudKitRecord[],
    options?: Record<string, unknown>,
  ): Promise<CloudKitResponse>;
  saveRecordZones(
    zones: string | string[] | CloudKitZoneID | CloudKitZoneID[],
  ): Promise<CloudKitResponse>;
  fetchRecordZones(
    zones: string | string[] | CloudKitZoneID | CloudKitZoneID[],
  ): Promise<CloudKitResponse>;
  fetchAllRecordZones(): Promise<CloudKitResponse>;
  shareWithUI(options: {
    record: CloudKitRecord;
    zoneID: string | CloudKitZoneID;
    shareTitle: string;
    shareType: string;
    supportedAccess: Array<"PRIVATE">;
    supportedPermissions: Array<"READ_WRITE">;
  }): Promise<unknown>;
};

type CloudKitContainer = {
  privateCloudDatabase: CloudKitDatabase;
  sharedCloudDatabase: CloudKitDatabase;
  setUpAuth(): Promise<CloudKitIdentity | null>;
  whenUserSignsIn(): Promise<CloudKitIdentity>;
  whenUserSignsOut(): Promise<void>;
};

type CloudKitNamespace = {
  DEVELOPMENT_ENVIRONMENT: string;
  PRODUCTION_ENVIRONMENT: string;
  configure(config: Record<string, unknown>): void;
  getDefaultContainer(): CloudKitContainer;
};

declare global {
  interface Window {
    CloudKit?: CloudKitNamespace;
  }
}

export type StoredLedger = {
  id: string;
  title: string;
  access: "owner" | "shared";
  zoneID: CloudKitZoneID;
  data: FinanceData;
  recordChangeTag?: string;
  record: CloudKitRecord;
};

let configuredContainer: CloudKitContainer | null = null;
let scriptPromise: Promise<void> | null = null;

export async function initializeCloudKit(): Promise<CloudKitContainer> {
  if (configuredContainer) return configuredContainer;
  await loadCloudKitScript();
  const CloudKit = window.CloudKit;
  if (!CloudKit) throw new Error("Apple CloudKit could not be loaded");

  const containerIdentifier =
    process.env.NEXT_PUBLIC_CLOUDKIT_CONTAINER_IDENTIFIER;
  const apiToken = process.env.NEXT_PUBLIC_CLOUDKIT_API_TOKEN;
  const environmentName =
    process.env.NEXT_PUBLIC_CLOUDKIT_ENVIRONMENT ?? "production";
  if (!containerIdentifier || !apiToken) {
    throw new Error("CloudKit configuration is unavailable");
  }

  CloudKit.configure({
    containers: [
      {
        containerIdentifier,
        environment:
          environmentName === "production"
            ? CloudKit.PRODUCTION_ENVIRONMENT
            : CloudKit.DEVELOPMENT_ENVIRONMENT,
        apiTokenAuth: {
          apiToken,
          persist: true,
          signInButton: {
            id: "apple-sign-in-button",
            theme: "black",
          },
          signOutButton: {
            id: "apple-sign-out-button",
            theme: "white-with-outline",
          },
        },
      },
    ],
  });
  configuredContainer = CloudKit.getDefaultContainer();
  return configuredContainer;
}

export async function loadLedgerDocuments(
  container: CloudKitContainer,
): Promise<StoredLedger[]> {
  const owner = await loadOwnerLedger(container);
  const shared = await loadSharedLedgers(container);
  return [owner, ...shared];
}

async function loadOwnerLedger(
  container: CloudKitContainer,
): Promise<StoredLedger> {
  const database = container.privateCloudDatabase;
  try {
    const zoneID = await ensureOwnerZone(database);
    const existing = await fetchLedger(
      database,
      zoneID,
      "owner",
      "owner",
      "My finances",
    );
    if (existing) return existing;

    const legacy = await fetchLegacyLedger(database);
    return saveLedgerRecord(database, {
      id: "owner",
      title: legacy?.title ?? "My finances",
      access: "owner",
      zoneID,
      data: legacy?.data ?? structuredClone(emptyFinanceData),
      recordChangeTag: undefined,
      record: emptyRecord(),
    });
  } catch (error) {
    throw new Error(
      cloudKitErrorMessage(error, "Could not load your iCloud ledger"),
    );
  }
}

async function ensureOwnerZone(
  database: CloudKitDatabase,
): Promise<CloudKitZoneID> {
  const existing = await database.fetchRecordZones(LEDGER_ZONE_NAME);
  if (!existing.hasErrors && existing.zones?.[0]?.zoneID) {
    return existing.zones[0].zoneID;
  }
  if (existing.hasErrors && !(existing.errors ?? []).every(isNotFound)) {
    throw existing.errors?.[0] ?? new Error("Could not inspect the ledger zone");
  }
  const created = await database.saveRecordZones(LEDGER_ZONE_NAME);
  if (created.hasErrors) {
    throw created.errors?.[0] ?? new Error("Could not create the ledger zone");
  }
  return created.zones?.[0]?.zoneID ?? { zoneName: LEDGER_ZONE_NAME };
}

async function loadSharedLedgers(
  container: CloudKitContainer,
): Promise<StoredLedger[]> {
  const database = container.sharedCloudDatabase;
  try {
    const response = await database.fetchAllRecordZones();
    if (response.hasErrors) {
      throw response.errors?.[0] ?? new Error("Could not list shared ledgers");
    }
    const results = await Promise.all(
      (response.zones ?? []).map(async ({ zoneID }) =>
        fetchLedger(
          database,
          zoneID,
          "shared",
          `shared:${zoneKey(zoneID)}`,
          "Shared finances",
        ),
      ),
    );
    return results.filter((item): item is StoredLedger => item !== null);
  } catch (error) {
    throw new Error(
      cloudKitErrorMessage(error, "Could not load shared iCloud ledgers"),
    );
  }
}

async function fetchLegacyLedger(
  database: CloudKitDatabase,
): Promise<Pick<StoredLedger, "data" | "title"> | null> {
  try {
    const response = await database.fetchRecords(LEDGER_RECORD_NAME);
    if (response.hasErrors) {
      if ((response.errors ?? []).every(isNotFound)) return null;
      throw response.errors?.[0] ?? new Error("Could not load the previous ledger");
    }
    const record = response.records?.[0];
    return record ? decodeLedgerRecord(record, "My finances") : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function fetchLedger(
  database: CloudKitDatabase,
  zoneID: CloudKitZoneID,
  access: StoredLedger["access"],
  id: string,
  fallbackTitle: string,
): Promise<StoredLedger | null> {
  try {
    const response = await database.fetchRecords(LEDGER_RECORD_NAME, { zoneID });
    if (response.hasErrors) {
      if ((response.errors ?? []).every(isNotFound)) return null;
      throw response.errors?.[0] ?? new Error("Could not load the ledger");
    }
    const record = response.records?.[0];
    if (!record) return null;
    const decoded = await decodeLedgerRecord(record, fallbackTitle);
    return {
      id,
      title: decoded.title,
      access,
      zoneID,
      data: decoded.data,
      recordChangeTag: record.recordChangeTag,
      record,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function saveLedgerDocument(
  container: CloudKitContainer,
  current: StoredLedger,
  data: FinanceData,
  title = current.title,
): Promise<StoredLedger> {
  const database =
    current.access === "owner"
      ? container.privateCloudDatabase
      : container.sharedCloudDatabase;
  try {
    return await saveLedgerRecord(database, {
      ...current,
      title: cleanTitle(title),
      data,
    });
  } catch (error) {
    throw new Error(cloudKitErrorMessage(error, "Could not save iCloud data"));
  }
}

async function saveLedgerRecord(
  database: CloudKitDatabase,
  current: StoredLedger,
): Promise<StoredLedger> {
  const { data, title, recordChangeTag, zoneID } = current;
  const normalized = normalizeFinanceData(data);
  const json = JSON.stringify({
    kind: LEDGER_DOCUMENT_KIND,
    title: cleanTitle(title),
    data: normalized,
  });
  const digest = await sha256Hex(json);
  const payload = await compressBase64(json);
  if (base64ToBytes(payload).byteLength > MAX_COMPRESSED_PAYLOAD_BYTES) {
    throw new Error(
      "This ledger has outgrown the encrypted record limit. Export it before importing more data.",
    );
  }
  const record: CloudKitRecord = {
    recordName: LEDGER_RECORD_NAME,
    recordType: LEDGER_RECORD_TYPE,
    ...(recordChangeTag ? { recordChangeTag } : {}),
    fields: {
      payload: {
        value: payload,
        type: "BYTES",
        isEncrypted: true,
      },
      schemaVersion: {
        value: LEDGER_SCHEMA_VERSION,
        type: "STRING",
      },
      digest: {
        value: digest,
        type: "STRING",
      },
      updatedAt: {
        value: Date.now(),
        type: "TIMESTAMP",
      },
    },
  };
  const response = await database.saveRecords(record, { zoneID });
  if (response.hasErrors) {
    throw response.errors?.[0] ?? new Error("Could not save the ledger");
  }
  const saved = response.records?.[0] ?? record;
  return {
    ...current,
    title: cleanTitle(title),
    data: normalized,
    recordChangeTag: saved.recordChangeTag ?? recordChangeTag,
    record: saved,
  };
}

export async function shareLedgerDocument(
  container: CloudKitContainer,
  current: StoredLedger,
): Promise<void> {
  if (current.access !== "owner") {
    throw new Error("Only the ledger owner can manage its sharing");
  }
  try {
    const response = await container.privateCloudDatabase.fetchRecords(
      LEDGER_RECORD_NAME,
      { zoneID: current.zoneID },
    );
    if (response.hasErrors) {
      throw response.errors?.[0] ?? new Error("Could not prepare this ledger");
    }
    const record = response.records?.[0];
    if (!record) throw new Error("The ledger record is missing");
    await container.privateCloudDatabase.shareWithUI({
      record,
      zoneID: current.zoneID,
      shareTitle: "Our Finances ledger",
      shareType: "com.liambutlerlawrence.OurFinances.ledger",
      supportedAccess: ["PRIVATE"],
      supportedPermissions: ["READ_WRITE"],
    });
  } catch (error) {
    throw new Error(cloudKitErrorMessage(error, "Could not open iCloud sharing"));
  }
}

async function decodeLedgerRecord(
  record: CloudKitRecord,
  fallbackTitle: string,
): Promise<Pick<StoredLedger, "data" | "title">> {
  const payload = record.fields.payload?.value;
  if (typeof payload !== "string" || payload === "") {
    throw new Error("The encrypted ledger payload is missing");
  }
  const json = await decompressBase64(payload);
  const digest = await sha256Hex(json);
  const storedDigest = record.fields.digest?.value;
  if (typeof storedDigest === "string" && storedDigest !== digest) {
    throw new Error("The ledger failed its integrity check");
  }
  const parsed = JSON.parse(json) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "kind" in parsed &&
    parsed.kind === LEDGER_DOCUMENT_KIND &&
    "data" in parsed
  ) {
    const envelope = parsed as { data: unknown; title?: unknown };
    return {
      data: normalizeFinanceData(envelope.data),
      title:
        typeof envelope.title === "string"
          ? cleanTitle(envelope.title)
          : fallbackTitle,
    };
  }
  return { data: normalizeFinanceData(parsed), title: fallbackTitle };
}

function emptyRecord(): CloudKitRecord {
  return {
    recordName: LEDGER_RECORD_NAME,
    recordType: LEDGER_RECORD_TYPE,
    fields: {},
  };
}

function zoneKey(zoneID: CloudKitZoneID): string {
  return `${zoneID.ownerRecordName ?? "current-user"}:${zoneID.zoneName}`;
}

function cleanTitle(value: string): string {
  return value.trim().slice(0, 80) || "My finances";
}

export function watchCloudKitIdentity(
  container: CloudKitContainer,
  onSignIn: (identity: CloudKitIdentity) => void,
  onSignOut: () => void,
  onError: (error: Error) => void,
) {
  let active = true;
  void (async () => {
    while (active) {
      try {
        const identity = await container.whenUserSignsIn();
        if (active) onSignIn(identity);
      } catch (error) {
        if (active) {
          onError(new Error(cloudKitErrorMessage(error, "Apple sign-in failed")));
        }
        return;
      }
    }
  })();
  void (async () => {
    while (active) {
      try {
        await container.whenUserSignsOut();
        if (active) onSignOut();
      } catch (error) {
        if (active) {
          onError(new Error(cloudKitErrorMessage(error, "Apple sign-out failed")));
        }
        return;
      }
    }
  })();
  return () => {
    active = false;
  };
}

function loadCloudKitScript(): Promise<void> {
  if (window.CloudKit) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CLOUDKIT_SCRIPT}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Apple CloudKit could not be loaded")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = CLOUDKIT_SCRIPT;
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Apple CloudKit could not be loaded")),
      { once: true },
    );
    document.head.append(script);
  });
  return scriptPromise;
}

async function compressBase64(value: string): Promise<string> {
  const input = new Blob([new TextEncoder().encode(value)]);
  const stream = input.stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64(bytes);
}

async function decompressBase64(value: string): Promise<string> {
  const input = new Blob([base64ToBytes(value)]);
  const stream = input.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isNotFound(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as CloudKitError;
  return [
    error.ckErrorCode,
    error.code,
    error.reason,
    error.serverErrorCode,
  ].some((item) => String(item ?? "").toUpperCase().includes("NOT_FOUND"));
}

function cloudKitErrorMessage(value: unknown, fallback: string): string {
  if (isConflict(value)) {
    return "This ledger changed in iCloud before your edit could be saved. Refresh shared ledgers, review the newer data, and try again.";
  }
  if (value instanceof Error && value.message) return value.message;
  if (value && typeof value === "object") {
    const error = value as CloudKitError;
    if (error.message) return error.message;
    if (error.reason) return error.reason;
    if (error.ckErrorCode) return `${fallback} (${error.ckErrorCode})`;
  }
  return fallback;
}

function isConflict(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as CloudKitError;
  return [
    error.ckErrorCode,
    error.code,
    error.reason,
    error.serverErrorCode,
  ].some((item) => String(item ?? "").toUpperCase().includes("CONFLICT"));
}
