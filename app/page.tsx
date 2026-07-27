import type { Metadata } from "next";
import { chatGPTSignInPath, chatGPTSignOutPath } from "./chatgpt-auth";
import { FinanceApp } from "./FinanceApp";
import { loadFinanceData } from "./finance-data";
import { getOptionalIdentity, requireAppUser } from "./session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Our Finances · Budget",
  description:
    "A private monthly budget, statement review queue, and reconciled account ledger.",
};

export default async function Home() {
  const identity = await getOptionalIdentity();
  if (!identity) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">
            OF
          </div>
          <p className="eyebrow">Private household ledger</p>
          <h1>Your budget, without the spreadsheet ritual.</h1>
          <p className="signin-copy">
            Statements become reviewable transactions. Balances, totals, and
            trends are calculated from one protected source of truth.
          </p>
          <a className="primary-button signin-button" href={chatGPTSignInPath("/")}>
            Sign in to Our Finances
          </a>
          <p className="privacy-note">
            Financial data is never shipped with the public source code.
          </p>
        </section>
      </main>
    );
  }

  const user = await requireAppUser("/");
  const data = await loadFinanceData();
  return (
    <FinanceApp
      initialData={data}
      user={{ displayName: user.displayName, role: user.role }}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
