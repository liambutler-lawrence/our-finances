import { chatGPTSignOutPath } from "../chatgpt-auth";

export default function Unauthorized() {
  return (
    <main className="signin-shell">
      <section className="signin-card">
        <div className="brand-mark" aria-hidden="true">
          OF
        </div>
        <p className="eyebrow">Private household ledger</p>
        <h1>This account has not been invited.</h1>
        <p className="signin-copy">
          Ask the owner to authorize your email, then sign in again.
        </p>
        <a className="secondary-button signin-button" href={chatGPTSignOutPath("/")}>
          Sign out
        </a>
      </section>
    </main>
  );
}
