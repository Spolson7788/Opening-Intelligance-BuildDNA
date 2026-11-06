# SEC-1 ops notes

Branch `sec1/offsite-backup` from production commit `662c035`.

- Do **not** enable the nightly cron until approval gate A6.
- Do **not** run backup against any project other than `bekaxmatcvxqpjixwsqn`.
- Restore tests use a throwaway Postgres service in GitHub Actions — never staging or production as the restore target.
- See `scripts/offsite-backup/README.md` for secret names.
