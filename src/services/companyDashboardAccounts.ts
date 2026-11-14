import { pool } from "../db/pool";
import { isMissingSchema } from "../middleware/auth";
import { accountKind } from "./companyDashboard";

async function alreadyLinked(providerId: string, propertyId: string): Promise<boolean> {
  const linked = await pool.query(
    `SELECT 1 FROM provider_account_sites site
     JOIN provider_accounts account ON account.id = site.account_id
     WHERE site.property_id = $1 AND account.provider_organization_id = $2`,
    [propertyId, providerId],
  );
  return linked.rows.length > 0;
}

export async function recordOwnedProviderSite(orgId: string, propertyId: string, name: string): Promise<void> {
  try {
    const org = await pool.query("SELECT org_type FROM organizations WHERE id=$1", [orgId]);
    if (org.rows[0]?.org_type !== "service_partner") return;
    if (await alreadyLinked(orgId, propertyId)) return;
    if (accountKind(true, name) === "walkin") {
      let account = await pool.query(
        "SELECT id FROM provider_accounts WHERE provider_organization_id=$1 AND kind='walkin'",
        [orgId],
      );
      let accountId = account.rows[0]?.id as string | undefined;
      if (!accountId) {
        try {
          accountId = (await pool.query(
            `INSERT INTO provider_accounts (id, provider_organization_id, kind, display_name)
             VALUES (gen_random_uuid(), $1, 'walkin', 'Walk-in') RETURNING id`,
            [orgId],
          )).rows[0].id;
        } catch (error) {
          if ((error as { code?: string }).code !== "23505") throw error;
          account = await pool.query(
            "SELECT id FROM provider_accounts WHERE provider_organization_id=$1 AND kind='walkin'",
            [orgId],
          );
          accountId = account.rows[0]?.id;
        }
      }
      if (!accountId) return;
      await pool.query(
        `INSERT INTO provider_account_sites (account_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [accountId, propertyId],
      );
      return;
    }
    const label = name.trim().slice(0, 200) || "Small account";
    await pool.query(
      `INSERT INTO provider_accounts (id, provider_organization_id, kind, display_name)
       VALUES ($1, $2, 'small', $3) ON CONFLICT (id) DO NOTHING`,
      [propertyId, orgId, label],
    );
    await pool.query(
      `INSERT INTO provider_account_sites (account_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [propertyId, propertyId],
    );
  } catch (error) {
    if (isMissingSchema(error)) return;
    throw error;
  }
}

export async function recordFacilityGrant(providerId: string, propertyId: string): Promise<void> {
  try {
    if (await alreadyLinked(providerId, propertyId)) return;
    const owner = await pool.query(
      `SELECT org.id, org.name, org.org_type
       FROM properties property
       JOIN portfolios portfolio ON portfolio.id = property.portfolio_id
       JOIN organizations org ON org.id = portfolio.organization_id
       WHERE property.id = $1`,
      [propertyId],
    );
    const customer = owner.rows[0];
    if (!customer || customer.org_type !== "customer") return;
    let account = await pool.query(
      `SELECT id FROM provider_accounts
       WHERE provider_organization_id=$1 AND kind='facility' AND customer_organization_id=$2`,
      [providerId, customer.id],
    );
    let accountId = account.rows[0]?.id as string | undefined;
    if (!accountId) {
      const label = String(customer.name || "Facility account").trim().slice(0, 200) || "Facility account";
      accountId = (await pool.query(
        `INSERT INTO provider_accounts (id, provider_organization_id, kind, customer_organization_id, display_name)
         VALUES (gen_random_uuid(), $1, 'facility', $2, $3) RETURNING id`,
        [providerId, customer.id, label],
      )).rows[0].id;
    }
    await pool.query(
      `INSERT INTO provider_account_sites (account_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [accountId, propertyId],
    );
  } catch (error) {
    if (isMissingSchema(error)) return;
    throw error;
  }
}
