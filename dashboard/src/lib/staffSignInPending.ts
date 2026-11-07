export const STAFF_SIGN_IN_PENDING_KEY = "oi_staff_sign_in_code";

export interface PendingStaffSignIn {
  mfaToken: string;
  email: string;
  sentAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function savePendingStaffSignIn(value: PendingStaffSignIn, store: Store): void {
  store.setItem(STAFF_SIGN_IN_PENDING_KEY, JSON.stringify(value));
}

export function clearPendingStaffSignIn(store: Store): void {
  store.removeItem(STAFF_SIGN_IN_PENDING_KEY);
}

function tokenStillValid(token: string, now: number): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" && payload.exp * 1000 > now;
  } catch {
    return false;
  }
}

/** Restores the code screen after a reload. Does not send a new email. */
export function readPendingStaffSignIn(store: Store | null, now = Date.now()): PendingStaffSignIn | null {
  if (!store) return null;
  const raw = store.getItem(STAFF_SIGN_IN_PENDING_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingStaffSignIn;
    if (!value?.mfaToken || !value.email || typeof value.sentAt !== "number" || !tokenStillValid(value.mfaToken, now)) {
      store.removeItem(STAFF_SIGN_IN_PENDING_KEY);
      return null;
    }
    return value;
  } catch {
    store.removeItem(STAFF_SIGN_IN_PENDING_KEY);
    return null;
  }
}
