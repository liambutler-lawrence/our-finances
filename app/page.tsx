import type { Metadata } from "next";
import { CloudKitFinance } from "./CloudKitFinance";

export const metadata: Metadata = {
  title: "Our Finances · Budget",
  description:
    "A private monthly budget, statement review queue, and reconciled account ledger.",
};

export default function Home() {
  return <CloudKitFinance />;
}
