import dotenv from "dotenv";
dotenv.config();

import { createApp, corsOriginsFromEnv } from "./app";

const app = createApp();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  if (corsOriginsFromEnv().length === 0) {
    console.warn(
      "WARNING: CORS_ORIGINS is not set — accepting requests from any origin. " +
      "Fine for local dev; set this to your deployed dashboard/field-app URLs before going live with real customer data."
    );
  }
  console.log(`Opening Intel API listening on port ${PORT}`);
});
