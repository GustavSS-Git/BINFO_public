/**
 * Principals: who a per-user request (`analys` row) belongs to.
 *
 * A principal is either one anonymous device (cookie `binfo_enhet`, see
 * `./kontext.ts`) or a Supabase Auth account (`typ = 'konto'`). The device
 * row is created lazily — on the first expensive action (an upload), never on
 * a plain page view. On login the device principal is merged into the
 * account's principal (`sakerstallKontoPrincipal` below), which is how
 * anonymous history is claimed.
 */

import type { Kontext } from "./kontext";
import type { KontoDatabas } from "./kontoPortar";

/**
 * Insert-or-touch the anonymous principal for this device and return the
 * principal id to attribute work to (the merge target if the device has been
 * merged). Idempotent: the same device id always yields the same principal.
 */
export async function sakerstallPrincipal(db: KontoDatabas, enhetId: string): Promise<string> {
  if (enhetId.length === 0) throw new Error("sakerstallPrincipal: enhetId saknas");
  return db.sakerstallPrincipal(enhetId);
}

/**
 * The `typ = 'konto'` principal of a Supabase Auth user, created on first use.
 * With `enhetId`, that device's anonymous principal is merged into the
 * account if it has not been merged anywhere yet — once per device
 * (`sakerstall_konto_principal`; `sla_samman_principal` inside). Used by
 * `losSession` (./kontext.ts) on every authenticated request and by the
 * login/verify functions (./auth.ts).
 */
export async function sakerstallKontoPrincipal(
  db: KontoDatabas,
  authUserId: string,
  enhetId: string | null,
): Promise<{ principalId: string; sammanslagen: boolean }> {
  if (authUserId.length === 0) throw new Error("sakerstallKontoPrincipal: authUserId saknas");
  return db.sakerstallKontoPrincipal(authUserId, enhetId);
}

/**
 * Returns `kontext` with `principalId` filled in. A context that already has
 * a principal (a logged-in account, see `losKontext`) is returned unchanged;
 * otherwise the device principal is ensured. Call this right before the
 * expensive action, not at the top of every handler.
 */
export async function medPrincipal(db: KontoDatabas, kontext: Kontext): Promise<Kontext> {
  if (kontext.principalId !== null) return kontext;
  const principalId = await sakerstallPrincipal(db, kontext.enhetId);
  return { ...kontext, principalId };
}

/**
 * Merge principal `fran` (typically a device) into `till` (typically the
 * account). Only tests call this wrapper today; login merges inside SQL via
 * `sakerstall_konto_principal` (see `sakerstallKontoPrincipal`). Moves `fran`'s analys and behorighet rows
 * to `till` and re-points anything already merged into `fran`. Atomic in SQL
 * (`sla_samman_principal`).
 */
export async function slaSammanPrincipal(
  db: KontoDatabas,
  fran: string,
  till: string,
): Promise<void> {
  if (fran === till) throw new Error("slaSammanPrincipal: fran och till är samma principal");
  await db.slaSammanPrincipal(fran, till);
}
