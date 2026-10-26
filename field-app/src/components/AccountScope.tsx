import { Fragment } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../lib/AuthContext";

/** Retain drafts during checks; discard rendered account data on a confirmed principal change. */
export function AccountScope({ children }: { children: ReactNode }) {
  const { auth } = useAuth();
  if (!auth) return null;
  return <Fragment key={`${auth.organizationId}/${auth.userId}`}>{children}</Fragment>;
}
