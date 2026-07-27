import { redirect } from "next/navigation";
import { ensureSchema, getD1, rows } from "../db/runtime";
import {
  chatGPTSignInPath,
  getChatGPTUser,
  type ChatGPTUser,
} from "./chatgpt-auth";

export type AppUser = ChatGPTUser & { role: "owner" | "member" };

const devUser: ChatGPTUser = {
  displayName: "Local preview",
  email: "local-preview@our-finances.invalid",
  fullName: "Local preview",
};

async function currentIdentity(): Promise<ChatGPTUser | null> {
  const user = await getChatGPTUser();
  if (user) return user;
  return process.env.NODE_ENV === "development" ? devUser : null;
}

export async function getOptionalIdentity(): Promise<ChatGPTUser | null> {
  return currentIdentity();
}

export async function requireAppUser(returnTo = "/"): Promise<AppUser> {
  const identity = await currentIdentity();
  if (!identity) redirect(chatGPTSignInPath(returnTo));
  await ensureSchema();
  const db = getD1();
  const existing = await rows<{ email: string; role: "owner" | "member" }>(
    db.prepare("SELECT email, role FROM users WHERE email = ?").bind(identity.email),
  );
  if (existing[0]) return { ...identity, role: existing[0].role };

  const count = await db.prepare("SELECT COUNT(*) AS count FROM users").first<{
    count: number;
  }>();
  if (Number(count?.count ?? 0) === 0) {
    await db
      .prepare(
        "INSERT INTO users (email, display_name, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .bind(identity.email, identity.displayName, new Date().toISOString())
      .run();
    return { ...identity, role: "owner" };
  }
  redirect("/unauthorized");
}

export async function requireApiUser(): Promise<AppUser | null> {
  const identity = await currentIdentity();
  if (!identity) return null;
  await ensureSchema();
  const db = getD1();
  const existing = await rows<{ role: "owner" | "member" }>(
    db.prepare("SELECT role FROM users WHERE email = ?").bind(identity.email),
  );
  if (existing[0]) return { ...identity, role: existing[0].role };
  const count = await db.prepare("SELECT COUNT(*) AS count FROM users").first<{
    count: number;
  }>();
  if (Number(count?.count ?? 0) !== 0) return null;
  await db
    .prepare(
      "INSERT INTO users (email, display_name, role, created_at) VALUES (?, ?, 'owner', ?)",
    )
    .bind(identity.email, identity.displayName, new Date().toISOString())
    .run();
  return { ...identity, role: "owner" };
}
