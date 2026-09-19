import dotenv from "dotenv";
import { pool } from "../db/pool";
import { processPhotoDeletionJobs } from "../routes/photos";

dotenv.config();

export async function runPhotoDeletionRetryWorker() {
  return processPhotoDeletionJobs({ limit: 25 });
}

if (require.main === module) {
  runPhotoDeletionRetryWorker()
    .then((result) => {
      console.log(JSON.stringify(result));
      return pool.end();
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : "photo_deletion_worker_failed");
      await pool.end();
      process.exitCode = 1;
    });
}
