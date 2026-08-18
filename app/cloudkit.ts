"use client";

import { emptyFinanceData, type FinanceData } from "./finance-data";
import { normalizeFinanceData } from "./ledger";

const CLOUDKIT_SCRIPT =
  "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
const LEGACY_LEDGER_RECORD_NAME = "ledger-v1";
const LEDGER_RECORD_NAME = "ledger-v2";
const LEGACY_LEDGER_ZONE_NAME = "OurFinancesLedgerV1";
const LEDGER_ZONE_NAME = "OurFinancesLedgerV2";
const LEDGER_RECORD_TYPE = "FinanceLedger";
const LEDGER_SCHEMA_VERSION = "4.0.0";
const LEDGER_DOCUMENT_KIND = "our-finances-cloudkit-document-v1";
const LEDGER_MANIFEST_KIND = "our-finances-cloudkit-chunk-manifest-v1";
// Encrypted fields have additional server-side serialization overhead inside
// CloudKit's 1 MB record limit. Keep each payload deliberately small instead of
// trying to predict that overhead near the ceiling.
const ENCRYPTED_CHUNK_BYTES = 180_000;
const MAX_LEDGER_CHUNKS = 100;

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
  parent?: { recordName: string };
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
  chunkSlot?: LedgerChunkSlot;
  recordChangeTag?: string;
  record: CloudKitRecord;
};

type LedgerChunkSlot = "a" | "b";

type LedgerManifest = {
  kind: typeof LEDGER_MANIFEST_KIND;
  state: "preparing" | "ready";
  chunkSlot?: LedgerChunkSlot;
  chunkCount?: number;
  digest?: string;
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
    const zoneID = await withCloudKitContext(
      "Could not open a clean iCloud recovery zone",
      () => ensureOwnerZone(database),
    );
    const existing = await withCloudKitContext(
      "Could not read the recovered iCloud ledger",
      () =>
        fetchChunkedLedger(
          database,
          zoneID,
          "owner",
          "owner",
          "My finances",
        ),
    );
    if (existing) return existing;

    let recovered: Pick<StoredLedger, "data" | "title"> | null = null;
    try {
      const legacyZoneID = { zoneName: LEGACY_LEDGER_ZONE_NAME };
      const previousChunked = await fetchChunkedLedger(
        database,
        legacyZoneID,
        "owner",
        "owner-legacy-zone",
        "My finances",
      );
      recovered = previousChunked
        ? { data: previousChunked.data, title: previousChunked.title }
        : await fetchSingleRecordLedger(
            database,
            legacyZoneID,
            LEGACY_LEDGER_RECORD_NAME,
            "owner",
            "owner-legacy-zone",
            "My finances",
          );
    } catch (error) {
      // The first sharing migration wrote an encrypted value that CloudKit can
      // no longer deserialize. Never touch that zone again; the original
      // default-zone record was deliberately retained for recovery.
      if (!isEncryptedValueDeserialization(error)) throw error;
    }
    const legacy =
      recovered ??
      (await withCloudKitContext(
        "Could not read the preserved pre-migration iCloud ledger",
        () => fetchLegacyLedger(database),
      ));
    return await withCloudKitContext(
      "Could not rebuild the ledger in a clean iCloud zone",
      () =>
        rebuildRecoveredLedger(database, {
          id: "owner",
          title: legacy?.title ?? "My finances",
          access: "owner",
          zoneID,
          data: legacy?.data ?? structuredClone(emptyFinanceData),
          chunkSlot: undefined,
          recordChangeTag: undefined,
          record: emptyRecord(),
        }),
    );
  } catch (error) {
    if (error instanceof Error) throw error;
    throw contextualCloudKitError(error, "Could not recover your iCloud ledger");
  }
}

async function rebuildRecoveredLedger(
  database: CloudKitDatabase,
  recovered: StoredLedger,
): Promise<StoredLedger> {
  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await saveLedgerRecord(database, recovered);
    } catch (error) {
      if (!isConflict(error)) throw error;
      lastConflict = error;

      // A second tab or device may be rebuilding the same preserved ledger.
      // The manifest is activated only after every chunk is present, so a
      // ready document is safe to accept as the winner of that race.
      await waitForRecoveryRetry(attempt);
      const completed = await fetchChunkedLedger(
        database,
        recovered.zoneID,
        recovered.access,
        recovered.id,
        recovered.title,
      );
      if (completed) return completed;
    }
  }
  throw lastConflict ?? new Error("Could not finish rebuilding the ledger");
}

function waitForRecoveryRetry(attempt: number): Promise<void> {
  const delay = 80 * 2 ** attempt + Math.floor(Math.random() * 120);
  return new Promise((resolve) => window.setTimeout(resolve, delay));
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
      (response.zones ?? []).map(async ({ zoneID }) => {
        try {
          const id = `shared:${zoneKey(zoneID)}`;
          const chunked = await fetchChunkedLedger(
            database,
            zoneID,
            "shared",
            id,
            "Shared finances",
          );
          if (chunked) return chunked;
          return await fetchSingleRecordLedger(
            database,
            zoneID,
            LEGACY_LEDGER_RECORD_NAME,
            "shared",
            id,
            "Shared finances",
          );
        } catch (error) {
          // A collaborator cannot repair an owner's oversized legacy root.
          // Do not let that one share prevent their own ledger from opening;
          // the owner will migrate it when they next open the site.
          if (isEncryptedValueDeserialization(error)) return null;
          throw error;
        }
      }),
    );
    return results.filter((item): item is StoredLedger => item !== null);
  } catch (error) {
    // An unreadable legacy share must never prevent the owner's private ledger
    // from opening. Its owner can recover it into a fresh zone independently.
    if (isEncryptedValueDeserialization(error)) return [];
    throw contextualCloudKitError(error, "Could not load shared iCloud ledgers");
  }
}

async function fetchLegacyLedger(
  database: CloudKitDatabase,
): Promise<Pick<StoredLedger, "data" | "title"> | null> {
  try {
    const response = await database.fetchRecords(LEGACY_LEDGER_RECORD_NAME);
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

async function fetchSingleRecordLedger(
  database: CloudKitDatabase,
  zoneID: CloudKitZoneID,
  recordName: string,
  access: StoredLedger["access"],
  id: string,
  fallbackTitle: string,
): Promise<StoredLedger | null> {
  try {
    const response = await database.fetchRecords(recordName, { zoneID });
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
      chunkSlot: undefined,
      recordChangeTag: record.recordChangeTag,
      record,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function fetchChunkedLedger(
  database: CloudKitDatabase,
  zoneID: CloudKitZoneID,
  access: StoredLedger["access"],
  id: string,
  fallbackTitle: string,
): Promise<StoredLedger | null> {
  const response = await database.fetchRecords(LEDGER_RECORD_NAME, { zoneID });
  if (response.hasErrors) {
    if ((response.errors ?? []).every(isNotFound)) return null;
    throw response.errors?.[0] ?? new Error("Could not load the ledger index");
  }
  const record = response.records?.[0];
  if (!record) return null;
  const manifest = await decodeLedgerManifest(record);
  if (manifest.state !== "ready") return null;
  const { chunkSlot, chunkCount, digest } = manifest;
  if (
    !chunkSlot ||
    !Number.isSafeInteger(chunkCount) ||
    !chunkCount ||
    chunkCount < 1 ||
    chunkCount > MAX_LEDGER_CHUNKS ||
    typeof digest !== "string" ||
    digest === ""
  ) {
    throw new Error("The encrypted ledger index is invalid");
  }
  const names = Array.from({ length: chunkCount }, (_, index) =>
    chunkRecordName(chunkSlot, index),
  );
  const chunksResponse = await database.fetchRecords(names, { zoneID });
  if (chunksResponse.hasErrors) {
    throw chunksResponse.errors?.[0] ?? new Error("Could not load ledger data");
  }
  const recordsByName = new Map(
    (chunksResponse.records ?? []).map((chunk) => [chunk.recordName, chunk]),
  );
  const chunks = names.map((name) => {
    const payload = recordsByName.get(name)?.fields.payload?.value;
    if (typeof payload !== "string" || payload === "") {
      throw new Error("An encrypted ledger chunk is missing");
    }
    return base64ToBytes(payload);
  });
  const json = await decompressBytes(concatenateBytes(chunks));
  if ((await sha256Hex(json)) !== digest) {
    throw new Error("The ledger failed its integrity check");
  }
  const decoded = decodeLedgerJson(json, fallbackTitle);
  return {
    id,
    title: decoded.title,
    access,
    zoneID,
    data: decoded.data,
    chunkSlot,
    recordChangeTag: record.recordChangeTag,
    record,
  };
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
    throw contextualCloudKitError(error, "Could not save iCloud data");
  }
}

async function saveLedgerRecord(
  database: CloudKitDatabase,
  current: StoredLedger,
): Promise<StoredLedger> {
  const { data, title, zoneID } = current;
  const normalized = normalizeFinanceData(data);
  const json = JSON.stringify({
    kind: LEDGER_DOCUMENT_KIND,
    title: cleanTitle(title),
    data: normalized,
  });
  const digest = await sha256Hex(json);
  const compressed = await compressBytes(json);
  const chunks = splitBytes(compressed, ENCRYPTED_CHUNK_BYTES);
  if (chunks.length > MAX_LEDGER_CHUNKS) {
    throw new Error(
      "This ledger is too large for its encrypted iCloud document. Export it before importing more data.",
    );
  }
  let manifestRecord = current.record;
  const initializing =
    manifestRecord.recordName !== LEDGER_RECORD_NAME ||
    !manifestRecord.recordChangeTag;
  if (initializing) {
    const preparing = await encodeLedgerManifest({
      kind: LEDGER_MANIFEST_KIND,
      state: "preparing",
    });
    const createResponse = await database.saveRecords(
      ledgerManifestRecord(preparing),
      { zoneID },
    );
    if (createResponse.hasErrors) {
      const conflict = (createResponse.errors ?? []).find(isConflict);
      if (!conflict) {
        throw (
          createResponse.errors?.[0] ??
          new Error("Could not create the ledger index")
        );
      }
    }

    // CloudKit does not consistently include the new change tag in a create
    // response. Fetch the authoritative record before updating the manifest.
    // This also makes a concurrent, partially completed rebuild resumable.
    manifestRecord = await fetchRequiredRecord(
      database,
      LEDGER_RECORD_NAME,
      zoneID,
      "Could not read the ledger index after creating it",
    );
    if ((await decodeLedgerManifest(manifestRecord)).state === "ready") {
      throw recoveryConflict();
    }
  }

  const chunkSlot: LedgerChunkSlot = current.chunkSlot === "a" ? "b" : "a";
  const chunkNames = chunks.map((_, index) =>
    chunkRecordName(chunkSlot, index),
  );
  const existingChunks = await fetchOptionalRecords(
    database,
    chunkNames,
    zoneID,
  );
  const chunkRecords: CloudKitRecord[] = chunks.map((chunk, index) => {
    const existing = existingChunks.get(chunkNames[index]);
    return {
      recordName: chunkNames[index],
      recordType: LEDGER_RECORD_TYPE,
      ...(existing?.recordChangeTag
        ? { recordChangeTag: existing.recordChangeTag }
        : {}),
      parent: { recordName: LEDGER_RECORD_NAME },
      fields: {
        payload: {
          value: bytesToBase64(chunk),
          type: "BYTES",
          isEncrypted: true,
        },
        schemaVersion: {
          value: `${LEDGER_SCHEMA_VERSION}-chunk`,
          type: "STRING",
        },
        updatedAt: {
          value: Date.now(),
          type: "TIMESTAMP",
        },
      },
    };
  });
  const chunksResponse = await database.saveRecords(chunkRecords, { zoneID });
  if (chunksResponse.hasErrors) {
    throw chunksResponse.errors?.[0] ?? new Error("Could not save ledger data");
  }

  if (initializing) {
    // Re-read only during recovery. Normal edits must keep their original
    // change tag so optimistic concurrency continues to protect user changes.
    manifestRecord = await fetchRequiredRecord(
      database,
      LEDGER_RECORD_NAME,
      zoneID,
      "Could not refresh the ledger index during recovery",
    );
    if ((await decodeLedgerManifest(manifestRecord)).state === "ready") {
      throw recoveryConflict();
    }
  }

  const manifest = await encodeLedgerManifest({
    kind: LEDGER_MANIFEST_KIND,
    state: "ready",
    chunkSlot,
    chunkCount: chunks.length,
    digest,
  });
  const record: CloudKitRecord = {
    recordName: LEDGER_RECORD_NAME,
    recordType: LEDGER_RECORD_TYPE,
    ...(manifestRecord.recordChangeTag
      ? { recordChangeTag: manifestRecord.recordChangeTag }
      : {}),
    fields: {
      payload: {
        value: manifest,
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
    chunkSlot,
    recordChangeTag: saved.recordChangeTag ?? manifestRecord.recordChangeTag,
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
      current.record.recordName,
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
    throw contextualCloudKitError(error, "Could not open iCloud sharing");
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
  return decodeLedgerJson(json, fallbackTitle);
}

function decodeLedgerJson(
  json: string,
  fallbackTitle: string,
): Pick<StoredLedger, "data" | "title"> {
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

async function encodeLedgerManifest(manifest: LedgerManifest): Promise<string> {
  return bytesToBase64(await compressBytes(JSON.stringify(manifest)));
}

async function decodeLedgerManifest(
  record: CloudKitRecord,
): Promise<LedgerManifest> {
  const payload = record.fields.payload?.value;
  if (typeof payload !== "string" || payload === "") {
    throw new Error("The encrypted ledger index is missing");
  }
  const parsed = JSON.parse(
    await decompressBytes(base64ToBytes(payload)),
  ) as Partial<LedgerManifest>;
  if (parsed.kind !== LEDGER_MANIFEST_KIND) {
    throw new Error("The encrypted ledger index has an unknown format");
  }
  return parsed as LedgerManifest;
}

function ledgerManifestRecord(payload: string): CloudKitRecord {
  return {
    recordName: LEDGER_RECORD_NAME,
    recordType: LEDGER_RECORD_TYPE,
    fields: {
      payload: { value: payload, type: "BYTES", isEncrypted: true },
      schemaVersion: { value: LEDGER_SCHEMA_VERSION, type: "STRING" },
      updatedAt: { value: Date.now(), type: "TIMESTAMP" },
    },
  };
}

async function fetchOptionalRecords(
  database: CloudKitDatabase,
  names: string[],
  zoneID: CloudKitZoneID,
): Promise<Map<string, CloudKitRecord>> {
  if (names.length === 0) return new Map();
  const response = await database.fetchRecords(names, { zoneID });
  const fatal = (response.errors ?? []).find((error) => !isNotFound(error));
  if (fatal) throw fatal;
  return new Map(
    (response.records ?? []).map((record) => [record.recordName, record]),
  );
}

async function fetchRequiredRecord(
  database: CloudKitDatabase,
  name: string,
  zoneID: CloudKitZoneID,
  message: string,
): Promise<CloudKitRecord> {
  const response = await database.fetchRecords(name, { zoneID });
  if (response.hasErrors) {
    throw response.errors?.[0] ?? new Error(message);
  }
  const record = response.records?.[0];
  if (!record?.recordChangeTag) throw new Error(message);
  return record;
}

function recoveryConflict(): Error & CloudKitError {
  const error = new Error(
    "Another browser is already rebuilding this ledger",
  ) as Error & CloudKitError;
  error.ckErrorCode = "CONFLICT";
  return error;
}

function chunkRecordName(slot: LedgerChunkSlot, index: number): string {
  return `${LEDGER_RECORD_NAME}-chunk-${slot}-${String(index).padStart(3, "0")}`;
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

async function decompressBase64(value: string): Promise<string> {
  return decompressBytes(base64ToBytes(value));
}

async function compressBytes(value: string): Promise<Uint8Array> {
  const input = new Blob([new TextEncoder().encode(value)]);
  const stream = input.stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressBytes(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const input = new Blob([bytes.buffer]);
  const stream = input.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function splitBytes(value: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length ? chunks : [new Uint8Array()];
}

function concatenateBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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

function isEncryptedValueDeserialization(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as CloudKitError;
  return [
    error.ckErrorCode,
    error.code,
    error.reason,
    error.message,
    error.serverErrorCode,
  ].some((item) =>
    String(item ?? "")
      .toLowerCase()
      .includes("deserializing encrypted value"),
  );
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

function contextualCloudKitError(value: unknown, context: string): Error {
  const detail = cloudKitErrorMessage(value, context);
  return new Error(detail === context ? context : `${context}: ${detail}`);
}

async function withCloudKitContext<T>(
  context: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw contextualCloudKitError(error, context);
  }
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
