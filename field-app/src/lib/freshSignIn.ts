import { requeueAfterFreshSignIn, saveAuth } from "./db";
import { flushOutbox } from "./sync";

export interface SignedInAccount { token: string; userId: string; organizationId: string; role: string }

// Called after every successful sign-in (never when a stored session is merely reloaded). Each call
// is a new sign-in event: operations this same account left stopped only because the account on
// this device changed are resumed once, then the normal upload pass starts.
export async function recordFreshSignIn(account: SignedInAccount, startSync = true): Promise<string[]> {
  const signInEventId = crypto.randomUUID();
  await saveAuth({ ...account, signInEventId });
  let resumed: string[] = [];
  try { resumed = await requeueAfterFreshSignIn({ userId: account.userId, organizationId: account.organizationId, signInEventId }); }
  catch { /* the Synchronization review page still offers a manual retry */ }
  if (startSync && resumed.length) void flushOutbox();
  return resumed;
}
