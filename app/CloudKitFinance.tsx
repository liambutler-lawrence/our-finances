"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  initializeCloudKit,
  loadPrivateLedger,
  savePrivateLedger,
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
  const [ledger, setLedger] = useState<StoredLedger>();
  const [error, setError] = useState("");
  const containerRef = useRef<CloudKitContainer>();
  const ledgerRef = useRef<StoredLedger>();
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const openLedger = useCallback(
    async (container: CloudKitContainer, nextIdentity: CloudKitIdentity) => {
      setError("");
      setIdentity(nextIdentity);
      setLedger(undefined);
      try {
        const stored = await loadPrivateLedger(container);
        ledgerRef.current = stored;
        setLedger(stored);
      } catch (caught) {
        setError(message(caught, "Could not load your private iCloud ledger"));
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const container = await initializeCloudKit();
        if (!active) return;
        containerRef.current = container;
        watchCloudKitIdentity(
          container,
          (nextIdentity) => {
            if (active) void openLedger(container, nextIdentity);
          },
          () => {
            if (!active) return;
            ledgerRef.current = undefined;
            setLedger(undefined);
            setIdentity(null);
            setError("");
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
  }, [identity, ledger]);

  async function updateLedger<T>(
    change: (
      current: StoredLedger,
    ) => Promise<{ data: StoredLedger["data"]; result: T }>,
  ): Promise<T> {
    let output!: T;
    let failure: unknown;
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const container = containerRef.current;
        const current =
          ledgerRef.current ?? { data: structuredClone(emptyFinanceData) };
        if (!container || !identity) {
          throw new Error("Sign in with Apple before changing this ledger");
        }
        const changed = await change(current);
        const saved = await savePrivateLedger(
          container,
          changed.data,
          current.recordChangeTag,
        );
        ledgerRef.current = saved;
        setLedger(saved);
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

  if (!ledger) {
    return (
      <AuthCard
        title="Loading your private ledger…"
        copy="Your encrypted financial data is being read directly from your iCloud account."
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
        user={{
          displayName: givenName || "iCloud account",
          role: "Private iCloud",
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
