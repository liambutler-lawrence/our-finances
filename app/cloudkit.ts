"use client";

import { emptyFinanceData, type FinanceData } from "./finance-data";
import { normalizeFinanceData } from "./ledger";

const CLOUDKIT_SCRIPT =
  "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
const LEDGER_RECORD_NAME = "ledger-v1";
const LEDGER_RECORD_TYPE = "FinanceLedger";
const LEDGER_SCHEMA_VERSION = "2.1.0";
const MAX_ENCODED_PAYLOAD_BYTES = 900_000;

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
};

type CloudKitContainer = {
  privateCloudDatabase: CloudKitDatabase;
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
  data: FinanceData;
  recordChangeTag?: string;
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

export async function loadPrivateLedger(
  container: CloudKitContainer,
): Promise<StoredLedger> {
  try {
    const response = await container.privateCloudDatabase.fetchRecords(
      LEDGER_RECORD_NAME,
    );
    if (response.hasErrors) {
      if ((response.errors ?? []).every(isNotFound)) {
        return { data: structuredClone(emptyFinanceData) };
      }
      throw response.errors?.[0] ?? new Error("Could not load the ledger");
    }
    const record = response.records?.[0];
    if (!record) return { data: structuredClone(emptyFinanceData) };
    const payload = record.fields.payload?.value;
    if (typeof payload !== "string" || payload === "") {
      throw new Error("The private ledger payload is missing");
    }
    const json = await decompressBase64(payload);
    const digest = await sha256Hex(json);
    const storedDigest = record.fields.digest?.value;
    if (typeof storedDigest === "string" && storedDigest !== digest) {
      throw new Error("The private ledger failed its integrity check");
    }
    return {
      data: normalizeFinanceData(JSON.parse(json)),
      recordChangeTag: record.recordChangeTag,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { data: structuredClone(emptyFinanceData) };
    }
    throw new Error(cloudKitErrorMessage(error, "Could not load private iCloud data"));
  }
}

export async function savePrivateLedger(
  container: CloudKitContainer,
  data: FinanceData,
  recordChangeTag?: string,
): Promise<StoredLedger> {
  const normalized = normalizeFinanceData(data);
  const json = JSON.stringify(normalized);
  const digest = await sha256Hex(json);
  const payload = await compressBase64(json);
  if (payload.length > MAX_ENCODED_PAYLOAD_BYTES) {
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
  try {
    const response = await container.privateCloudDatabase.saveRecords(record);
    if (response.hasErrors) {
      throw response.errors?.[0] ?? new Error("Could not save the ledger");
    }
    const saved = response.records?.[0];
    return {
      data: normalized,
      recordChangeTag: saved?.recordChangeTag ?? recordChangeTag,
    };
  } catch (error) {
    throw new Error(cloudKitErrorMessage(error, "Could not save private iCloud data"));
  }
}

export function watchCloudKitIdentity(
  container: CloudKitContainer,
  onSignIn: (identity: CloudKitIdentity) => void,
  onSignOut: () => void,
  onError: (error: Error) => void,
) {
  void container.whenUserSignsIn().then(onSignIn).catch((error) => {
    onError(new Error(cloudKitErrorMessage(error, "Apple sign-in failed")));
  });
  void container.whenUserSignsOut().then(onSignOut).catch((error) => {
    onError(new Error(cloudKitErrorMessage(error, "Apple sign-out failed")));
  });
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
  if (value instanceof Error && value.message) return value.message;
  if (value && typeof value === "object") {
    const error = value as CloudKitError;
    if (error.message) return error.message;
    if (error.reason) return error.reason;
    if (error.ckErrorCode) return `${fallback} (${error.ckErrorCode})`;
  }
  return fallback;
}
