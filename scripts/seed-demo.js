// Seeds a realistic demo portfolio: one org, one property, two buildings,
// ~28 openings with varied hardware, service history, and inspection
// results — including a few overdue/failed ones on purpose, since "here's
// what needs attention" is the whole point of the dashboard demo.
//
// Reuses the REAL health score logic from dist/services/healthScore.js
// (run `npm run build` first) rather than reimplementing it here, so the
// demo behaves identically to production instead of just looking similar.
//
// Idempotent: re-running with the same DEMO_EMAIL prints the existing
// login instead of creating a duplicate org.

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { randomBytes } = require("node:crypto");
require("dotenv").config();

let computeHealthScore;
try {
  ({ computeHealthScore } = require("../dist/services/healthScore"));
} catch {
  console.error("Couldn't find dist/services/healthScore.js — run `npm run build` first.");
  process.exit(1);
}

const DEMO_ORG_NAME = process.env.DEMO_ORG_NAME || "Sunset Ridge Property Group (Demo)";
const DEMO_EMAIL = process.env.DEMO_EMAIL || "demo@openingintel.com";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "demopass123";
const DEMO_NAME = process.env.DEMO_NAME || "Demo Admin";

const MANUFACTURERS = ["Cal-Royal", "Allegion", "ASSA ABLOY", "dormakaba", "Hager"];
const LOCKSET_MODELS = ["ND80BD", "CL3355", "9K37", "AU5407"];
const CLOSER_MODELS = ["4040XP", "DC6210", "TS93"];

// Matches src/routes/hardware.ts's generateTrackerId() exactly — the seed
// script inserts hardware directly via SQL rather than through the API, so
// it has to generate this itself now that tracker_id is NOT NULL (migration
// 006). Missed updating this when that migration shipped, which is exactly
// the kind of thing this demo script exists to catch before a real user hits it.
function generateTrackerId() {
  return `TRK-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const SERVICE_DESCRIPTIONS = [
  "Adjusted door closer spring tension",
  "Replaced worn weatherstripping",
  "Lubricated hinges and latch mechanism",
  "Realigned door in frame — was binding on strike side",
  "Replaced cylinder core (rekey)",
  "Repaired damaged panic bar",
  "Tightened loose hinge screws",
  "Replaced exit device touchpad",
];

const FAILED_INSPECTION_NOTES = [
  "Gap between door and frame exceeds 1/8 inch — needs adjustment",
  "Self-closing mechanism not fully latching",
  "Door label illegible / missing",
  "Undercut exceeds allowed clearance",
  "Auxiliary hardware (kick-down stop) blocking self-close",
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Idempotency check — don't create a second demo org on re-run.
  const existing = await pool.query("SELECT id, organization_id FROM users WHERE email = $1", [DEMO_EMAIL]);
  if (existing.rows.length > 0) {
    console.log("Demo org already exists — reusing it instead of creating a duplicate.\n");
    console.log(`  Login email:    ${DEMO_EMAIL}`);
    console.log(`  Login password: ${DEMO_PASSWORD}`);
    await pool.end();
    return;
  }

  console.log(`Seeding demo org "${DEMO_ORG_NAME}"...`);

  const orgRes = await pool.query(
    "INSERT INTO organizations (name, org_type) VALUES ($1, 'customer') RETURNING id",
    [DEMO_ORG_NAME]
  );
  const orgId = orgRes.rows[0].id;

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const userRes = await pool.query(
    `INSERT INTO users (organization_id, email, full_name, role, password_hash)
     VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
    [orgId, DEMO_EMAIL, DEMO_NAME, passwordHash]
  );
  const userId = userRes.rows[0].id;

  const portfolioRes = await pool.query(
    "INSERT INTO portfolios (organization_id, name) VALUES ($1, 'Main Portfolio') RETURNING id",
    [orgId]
  );
  const portfolioId = portfolioRes.rows[0].id;

  const propertyRes = await pool.query(
    `INSERT INTO properties (portfolio_id, name, address_line1, city, state, postal_code, property_type)
     VALUES ($1, 'Sunset Ridge Apartments', '4200 Sunset Ridge Dr', 'Phoenix', 'AZ', '85040', 'multifamily')
     RETURNING id`,
    [portfolioId]
  );
  const propertyId = propertyRes.rows[0].id;

  const buildingNames = ["Building A — Clubhouse & Leasing", "Building B — Residential"];
  const buildingIds = [];
  for (const name of buildingNames) {
    const res = await pool.query(
      "INSERT INTO buildings (property_id, name) VALUES ($1, $2) RETURNING id",
      [propertyId, name]
    );
    buildingIds.push(res.rows[0].id);
  }

  let openingCounter = 1;
  let totalHardware = 0;
  let totalServiceEvents = 0;
  let totalInspections = 0;

  for (const buildingId of buildingIds) {
    const openingsInBuilding = randomInt(12, 16);

    for (let i = 0; i < openingsInBuilding; i++) {
      const floor = randomInt(1, 3);
      const openingType = Math.random() < 0.85 ? "door" : randomFrom(["overhead_door", "gate", "access_control_point"]);
      const fireRated = openingType === "door" && Math.random() < 0.3;
      const lifeSafety = fireRated || Math.random() < 0.1;

      const code = `AZ-PHX-${buildingId.slice(0, 4).toUpperCase()}-F0${floor}-${String(openingCounter).padStart(4, "0")}`;
      // Deliberately give a handful of openings a rough history, so the
      // "needs attention" filter on the dashboard has real hits to show.
      // Two distinct failure narratives, so the demo tells two different
      // stories rather than one generic "bad" bucket:
      const isTroubled = i < 3; // first few in each building are the "problem" ones
      const isNeglected = isTroubled && i % 2 === 0; // long gap since last service
      const isChronic = isTroubled && !isNeglected; // frequent recent service, still failing

      let serviceEventCount, failedInspectionCount, lastServiceDaysAgo, serviceEventsLast12Months, installDaysAgo;

      if (isNeglected) {
        installDaysAgo = randomInt(4000, 5500); // 11-15 years old
        serviceEventCount = randomInt(1, 2);
        lastServiceDaysAgo = randomInt(900, 1500); // 2.5-4 years since anyone touched it
        serviceEventsLast12Months = 0;
        failedInspectionCount = 2;
      } else if (isChronic) {
        installDaysAgo = randomInt(4000, 5500);
        serviceEventCount = randomInt(3, 5);
        lastServiceDaysAgo = randomInt(10, 45); // serviced recently...
        serviceEventsLast12Months = serviceEventCount; // ...repeatedly, which is itself the red flag
        failedInspectionCount = 2;
      } else {
        installDaysAgo = randomInt(180, 5500);
        serviceEventCount = randomInt(0, 2);
        lastServiceDaysAgo = serviceEventCount > 0 ? randomInt(10, 400) : null;
        serviceEventsLast12Months = serviceEventCount > 0 ? randomInt(0, serviceEventCount) : 0;
        failedInspectionCount = Math.random() < 0.08 ? 1 : 0;
      }
      const installDate = daysAgo(installDaysAgo);

      const openingRes = await pool.query(
        `INSERT INTO openings
          (opening_code, building_id, floor_label, location_description, opening_type,
           fire_rated, life_safety_critical, install_date, last_service_date, qr_token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
         RETURNING id`,
        [
          code, buildingId, `F0${floor}`,
          openingType === "door" ? `${randomFrom(["East", "West", "North", "South"])} stairwell door` : `${openingType.replace(/_/g, " ")}`,
          openingType, fireRated, lifeSafety, installDate,
          lastServiceDaysAgo ? daysAgo(lastServiceDaysAgo) : null,
          require("crypto").randomUUID(),
        ]
      );
      const openingId = openingRes.rows[0].id;
      openingCounter++;

      // Hardware
      if (openingType === "door") {
        const components = [
          { type: "lockset", model: randomFrom(LOCKSET_MODELS) },
          { type: "closer", model: randomFrom(CLOSER_MODELS) },
        ];
        if (fireRated) components.push({ type: "exit_device", model: "ED5657" });

        for (const c of components) {
          await pool.query(
            `INSERT INTO hardware_components (opening_id, component_type, manufacturer, model_number, install_date, tracker_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [openingId, c.type, randomFrom(MANUFACTURERS), c.model, installDate, generateTrackerId()]
          );
          totalHardware++;
        }
      }

      // Service events
      for (let s = 0; s < serviceEventCount; s++) {
        const eventDaysAgo = isNeglected
          ? randomInt(900, 1600)
          : isChronic
          ? randomInt(10, 350)
          : randomInt(10, 700);
        await pool.query(
          `INSERT INTO service_events (opening_id, event_date, work_performed)
           VALUES ($1, $2, $3)`,
          [openingId, daysAgo(eventDaysAgo), randomFrom(SERVICE_DESCRIPTIONS)]
        );
        totalServiceEvents++;
      }

      // Inspections — mostly passing, with the "troubled" subset carrying real failures
      const inspectionCount = randomInt(1, 2);
      for (let ins = 0; ins < inspectionCount; ins++) {
        const failed = ins < failedInspectionCount;
        await pool.query(
          `INSERT INTO inspection_events (opening_id, event_date, inspection_type, passed, notes)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            openingId,
            daysAgo(randomInt(20, 600)),
            fireRated ? "fire_door_nfpa80" : "general",
            failed ? false : true,
            failed ? randomFrom(FAILED_INSPECTION_NOTES) : null,
          ]
        );
        totalInspections++;
      }

      // Compute and store the real health score using the actual production logic
      const { score, factors } = computeHealthScore({
        installDate: new Date(installDate),
        lastServiceDate: lastServiceDaysAgo ? new Date(daysAgo(lastServiceDaysAgo)) : null,
        serviceEventsLast12Months,
        failedInspectionsLast24Months: failedInspectionCount,
        openComplianceIssues: failedInspectionCount > 0 ? 1 : 0,
        fireRated,
      });

      await pool.query("UPDATE openings SET health_score = $1 WHERE id = $2", [score, openingId]);
      await pool.query(
        "INSERT INTO health_score_history (opening_id, score, factors) VALUES ($1, $2, $3)",
        [openingId, score, factors]
      );
    }
  }

  console.log(`\nDone. Seeded:`);
  console.log(`  ${openingCounter - 1} openings across 2 buildings`);
  console.log(`  ${totalHardware} hardware components`);
  console.log(`  ${totalServiceEvents} service events`);
  console.log(`  ${totalInspections} inspection events (some intentionally failed, for the demo)\n`);
  console.log("Log into the dashboard with:");
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
