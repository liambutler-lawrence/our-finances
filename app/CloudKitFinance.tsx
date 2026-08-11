"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  initializeCloudKit,
  loadLedgerDocuments,
  saveLedgerDocument,
  shareLedgerDocument,
  watchCloudKitIdentity,
  type CloudKitIdentity,
  type StoredLedger,
} from "./cloudkit";
import { emptyFinanceData, type TransactionRow } from "./finance-data";
import {
  addManualTransaction,
  editManualTransaction,
  exportTransactionsCsv,
  importFinanceBundle,
  removeManualTransaction,
  reviewTransaction,
  type ManualTransactionInput,
} from "./ledger";
import { FinanceApp } from "./FinanceApp";

type CloudKitContainer = Awaited<ReturnType<typeof initializeCloudKit>>;

export function CloudKitFinance() {
  const [identity, setIdentity] = useState<CloudKitIdentity | null>();
  const [documents, setDocuments] = useState<StoredLedger[]>();
  const [activeDocumentId, setActiveDocumentId] = useState("");
  const [sharingStatus, setSharingStatus] = useState("");
  const [sharingBusy, setSharingBusy] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef<CloudKitContainer>();
  const ledgerRef = useRef<StoredLedger>();
  const documentsRef = useRef(new Map<string, StoredLedger>());
  const activeDocumentIdRef = useRef("");
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const openingRef = useRef<{
    userRecordName: string;
    promise: Promise<void>;
  }>();

  const installDocuments = useCallback(
    (next: StoredLedger[], requestedId?: string) => {
      const byId = new Map(next.map((document) => [document.id, document]));
      const selected =
        byId.get(requestedId ?? activeDocumentIdRef.current) ?? next[0];
      documentsRef.current = byId;
      ledgerRef.current = selected;
      activeDocumentIdRef.current = selected?.id ?? "";
      setDocuments(next);
      setActiveDocumentId(selected?.id ?? "");
    },
    [],
  );

  const openLedger = useCallback(
    (container: CloudKitContainer, nextIdentity: CloudKitIdentity) => {
      const opening = openingRef.current;
      if (opening?.userRecordName === nextIdentity.userRecordName) {
        return opening.promise;
      }
      const promise = (async () => {
        setError("");
        setIdentity(nextIdentity);
        setDocuments(undefined);
        try {
          const loaded = await loadLedgerDocuments(container);
          installDocuments(loaded);
        } catch (caught) {
          setError(message(caught, "Could not load your iCloud ledgers"));
        }
      })();
      openingRef.current = {
        userRecordName: nextIdentity.userRecordName,
        promise,
      };
      void promise.finally(() => {
        if (openingRef.current?.promise === promise) {
          openingRef.current = undefined;
        }
      });
      return promise;
    },
    [installDocuments],
  );

  useEffect(() => {
    let active = true;
    let stopWatching = () => undefined;
    void (async () => {
      try {
        const container = await initializeCloudKit();
        if (!active) return;
        containerRef.current = container;
        stopWatching = watchCloudKitIdentity(
          container,
          (nextIdentity) => {
            if (active) void openLedger(container, nextIdentity);
          },
          () => {
            if (!active) return;
            ledgerRef.current = undefined;
            documentsRef.current.clear();
            activeDocumentIdRef.current = "";
            openingRef.current = undefined;
            setDocuments(undefined);
            setActiveDocumentId("");
            setIdentity(null);
            setError("");
            setSharingStatus("");
          },
          (caught) => {
            if (active) setError(caught.message);
          },
        );
        const currentIdentity = await container.setUpAuth();
        if (!active) return;
        if (currentIdentity) {
          await openLedger(container, currentIdentity);
        } else {
          setIdentity(null);
        }
      } catch (caught) {
        if (active) {
          setIdentity(null);
          setError(message(caught, "Could not initialize Apple sign-in"));
        }
      }
    })();
    return () => {
      active = false;
      stopWatching();
    };
  }, [openLedger]);

  useEffect(() => {
    if (identity === undefined || !containerRef.current) return;
    const timer = window.setTimeout(() => {
      void containerRef.current?.setUpAuth().catch((caught) => {
        setError(message(caught, "Could not update Apple sign-in"));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [identity, documents]);

  const refreshDocuments = useCallback(
    async (silent = false) => {
      const container = containerRef.current;
      if (!container || !identity) return;
      if (!silent) {
        setSharingBusy(true);
        setSharingStatus("Refreshing iCloud sharing…");
      }
      try {
        await saveQueueRef.current.catch(() => undefined);
        const loaded = await loadLedgerDocuments(container);
        installDocuments(loaded, activeDocumentIdRef.current);
        if (!silent) {
          const sharedCount = loaded.filter(
            (document) => document.access === "shared",
          ).length;
          setSharingStatus(
            sharedCount
              ? `${sharedCount} shared ledger${sharedCount === 1 ? "" : "s"} available`
              : "No accepted shared ledgers yet",
          );
        }
      } catch (caught) {
        const text = message(caught, "Could not refresh shared ledgers");
        setSharingStatus(text);
        if (silent) setError(text);
      } finally {
        if (!silent) setSharingBusy(false);
      }
    },
    [identity, installDocuments],
  );

  useEffect(() => {
    if (!identity || !documents) return;
    const refreshOnFocus = () => void refreshDocuments(true);
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [documents, identity, refreshDocuments]);

  function selectDocument(id: string) {
    const selected = documentsRef.current.get(id);
    if (!selected) return;
    activeDocumentIdRef.current = id;
    ledgerRef.current = selected;
    setActiveDocumentId(id);
    setSharingStatus("");
  }

  function installSavedDocument(saved: StoredLedger) {
    documentsRef.current.set(saved.id, saved);
    ledgerRef.current =
      activeDocumentIdRef.current === saved.id ? saved : ledgerRef.current;
    setDocuments((current) =>
      current?.map((document) =>
        document.id === saved.id ? saved : document,
      ),
    );
  }

  async function updateLedger<T>(
    change: (
      current: StoredLedger,
    ) => Promise<{
      data: StoredLedger["data"];
      title?: string;
      result: T;
    }>,
  ): Promise<T> {
    let output!: T;
    let failure: unknown;
    const targetId = ledgerRef.current?.id;
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const container = containerRef.current;
        const current = targetId
          ? documentsRef.current.get(targetId)
          : undefined;
        if (!container || !identity) {
          throw new Error("Sign in with Apple before changing this ledger");
        }
        if (!current) throw new Error("Open a ledger before changing it");
        const changed = await change(current);
        const saved = await saveLedgerDocument(
          container,
          current,
          changed.data,
          changed.title ?? current.title,
        );
        installSavedDocument(saved);
        output = changed.result;
      })
      .catch((caught) => {
        failure = caught;
      });
    await saveQueueRef.current;
    if (failure) throw failure;
    return output;
  }

  async function importBundle(payload: unknown) {
    return updateLedger(async (current) => {
      const imported = await importFinanceBundle(current.data, payload);
      return { data: imported.data, result: imported.imported };
    });
  }

  async function categorizeTransaction(
    transaction: TransactionRow,
    categoryId: string,
  ) {
    return updateLedger(async (current) => ({
      data: reviewTransaction(current.data, transaction.id, categoryId),
      result: undefined,
    }));
  }

  async function createManualEntry(input: ManualTransactionInput) {
    return updateLedger(async (current) => {
      const changed = addManualTransaction(current.data, input);
      return { data: changed.data, result: changed.transaction };
    });
  }

  async function updateManualEntry(
    transaction: TransactionRow,
    input: ManualTransactionInput,
  ) {
    return updateLedger(async (current) => {
      const changed = editManualTransaction(
        current.data,
        transaction.id,
        input,
      );
      return { data: changed.data, result: changed.transaction };
    });
  }

  async function deleteManualEntry(transaction: TransactionRow) {
    return updateLedger(async (current) => ({
      data: removeManualTransaction(current.data, transaction.id),
      result: undefined,
    }));
  }

  async function renameDocument(title: string) {
    await updateLedger(async (current) => ({
      data: current.data,
      title,
      result: undefined,
    }));
    setSharingStatus("Ledger name saved to its encrypted payload");
  }

  async function manageSharing() {
    const container = containerRef.current;
    const current = ledgerRef.current;
    if (!container || !current) return;
    setSharingBusy(true);
    setSharingStatus("Opening Apple’s private sharing controls…");
    try {
      await shareLedgerDocument(container, current);
      setSharingStatus(
        "Sharing updated. Invitees can open this site after accepting in iCloud.",
      );
      await refreshDocuments(true);
    } catch (caught) {
      setSharingStatus(message(caught, "Could not manage sharing"));
    } finally {
      setSharingBusy(false);
    }
  }

  function exportCsv() {
    const csv = exportTransactionsCsv(
      ledgerRef.current?.data ?? emptyFinanceData,
    );
    downloadFile(
      "our-finances-transactions.csv",
      csv,
      "text/csv;charset=utf-8",
    );
  }

  function exportLedger() {
    downloadFile(
      "our-finances-ledger.json",
      JSON.stringify(ledgerRef.current?.data ?? emptyFinanceData, null, 2),
      "application/json;charset=utf-8",
    );
  }

  async function copyLedger() {
    await navigator.clipboard.writeText(
      JSON.stringify(ledgerRef.current?.data ?? emptyFinanceData),
    );
  }

  function readLedger() {
    return JSON.stringify(ledgerRef.current?.data ?? emptyFinanceData);
  }

  if (identity === undefined) {
    return (
      <AuthCard
        title="Opening your private ledger…"
        copy="Connecting directly to your iCloud account."
        error={error}
        loading
      />
    );
  }

  if (!identity) {
    return (
      <AuthCard
        title="Your budget, without the spreadsheet ritual."
        copy="Sign in with Apple to open a ledger stored in your own private iCloud database."
        error={error}
      />
    );
  }

  const ledger = documents?.find(
    (document) => document.id === activeDocumentId,
  );

  if (!ledger) {
    return (
      <AuthCard
        title="Loading your iCloud ledgers…"
        copy="Your encrypted financial data and accepted shares are being read directly from iCloud."
        error={error}
        loading={!error}
      />
    );
  }

  const givenName = identity.nameComponents?.givenName?.trim();
  return (
    <>
      <div id="apple-sign-in-button" className="apple-signin-hidden" />
      <FinanceApp
        data={ledger.data}
        documents={(documents ?? []).map((document) => ({
          id: document.id,
          title: document.title,
          access: document.access,
        }))}
        activeDocumentId={ledger.id}
        activeDocumentAccess={ledger.access}
        onSelectDocument={selectDocument}
        onManageSharing={manageSharing}
        onRefreshDocuments={() => refreshDocuments(false)}
        onRenameDocument={renameDocument}
        sharingStatus={sharingStatus}
        sharingBusy={sharingBusy}
        user={{
          displayName: givenName || "iCloud account",
          role: ledger.access === "owner" ? "Ledger owner" : "Collaborator",
        }}
        onImportBundle={importBundle}
        onReviewTransaction={categorizeTransaction}
        onCreateManualTransaction={createManualEntry}
        onUpdateManualTransaction={updateManualEntry}
        onDeleteManualTransaction={deleteManualEntry}
        onExportTransactions={exportCsv}
        onExportLedger={exportLedger}
        onCopyLedger={copyLedger}
        onReadLedger={readLedger}
      />
    </>
  );
}

function AuthCard({
  title,
  copy,
  error,
  loading = false,
}: {
  title: string;
  copy: string;
  error: string;
  loading?: boolean;
}) {
  return (
    <main className="signin-shell">
      <section className="signin-card">
        <div className="brand-mark" aria-hidden="true">
          OF
        </div>
        <p className="eyebrow">Private household ledger</p>
        <h1>{title}</h1>
        <p className="signin-copy">{copy}</p>
        <div
          id="apple-sign-in-button"
          className={loading ? "apple-auth-slot loading" : "apple-auth-slot"}
        />
        <div id="apple-sign-out-button" className="apple-signout-hidden" />
        {error ? <p className="cloudkit-error">{error}</p> : null}
        <p className="privacy-note">
          The site server never receives your financial data.
        </p>
      </section>
    </main>
  );
}

function message(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback;
}

function downloadFile(name: string, contents: string, type: string) {
  const href = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}
