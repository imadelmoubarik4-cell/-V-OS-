# A2 — pre-migration backup evidence (22 Oct 2026)

**A2 status: ✅ COMPLETE (23 Oct 2026).** The owner chose closing option (a). The
logical export is verified restorable (11/11 checksums). The owner has confirmed
download, decryption with their own GPG key, matching SHA-256 for both the `.gpg` and
the `.tar`, and readable contents. **Documented limitation:** the complete Supabase
physical backup has **not** been restore-tested. PITR is disabled, and the latest
daily backup is `2044351775`, completed 2026-10-23 04:25 UTC.

Scope: backup only. No production data, settings, schema, functions, flags or secrets
were changed. Every database access was a read-only query
(`transaction_read_only = on`) through the Supabase Management API.

## 1. Supabase backups / PITR (Management API, `GET /v1/projects/{ref}/database/backups`)

| Item | Value |
|---|---|
| Project | `dnefgcmjcgxlynycxkts` (`vabar-inventory`), status ACTIVE_HEALTHY |
| Region | **eu-west-1** (Ireland) |
| Postgres | 17.6 |
| PITR | **disabled** (`pitr_enabled: false`); WAL-G enabled |
| Latest physical backup | id `2034882394`, **COMPLETED**, `2026-10-22T04:46:12Z` |
| Next daily backup | id `2044351775`, **COMPLETED**, `2026-10-23T04:25:05Z` (checked 2026-10-23 06:45 UTC) |
| Earlier daily backups | COMPLETED on 21, 20, 19, 18, 17, 16 (×2) and 15 Oct |
| Restore test of the physical backup | **Not performed.** It requires restoring to a new project (billable) or to production (destructive). Neither is approved. |

Without PITR, a full-database restore (rollback tier 3) can return only to a daily
backup. Writes made after it would be lost. At export time that window was about
17 hours (04:46 → 21:43 UTC).

## 2. Logical export of the designated booking tables

Taken `2026-10-22 21:43 UTC` (database TimeZone UTC). Production ledger at
`20261022090000` (S105). Each table was read in one statement with its own
server-side checksum: md5 over the `row_to_json` text of every row, in `md5(row)`
order.

| Table | Rows | Production md5 |
|---|---|---|
| booking_settings | 1 | `1a01dba50234cbb76476a55980b01c62` |
| booking_areas | 4 | `b6ae62e0768f10786e6e4db611240db2` |
| booking_tables | 16 | `467206476e3eb9b273a4f234f5838044` |
| booking_table_combinations | 0 | `d41d8cd98f00b204e9800998ecf8427e` (empty) |
| reservations | 0 | empty |
| reservation_tables | 0 | empty |
| reservation_status_history | 0 | empty |
| booking_holds | 0 | empty |
| booking_events | 0 | empty |
| settings_business_hours | 7 | `4d0bd8c3cd29809f9a26c4aeb838ee61` |
| push_notification_queue | 24 | `3862bd49a0c067ffb23646592f58b62b` |

Production holds **no reservations**, so the export contains no guest booking data.
The 24 web-push queue rows are staff notifications.

## 3. Pre-migration schema

`pg_dump` was **not possible**: the session has a Management API token but no
database password, and its local `pg_dump` is v16 against a v17 server. Instead, the
full catalog of `public` and `atlas_private` was exported as JSON:

- 207 relations with column types, defaults, NOT NULL, RLS and grants;
- 601 indexes, 16 views, 5 sequences, 1 type, 7 extensions, and schema grants;
- the structural snapshot (`scripts/release/kanel_bookings_snapshot.sql`): 655
  functions with full definitions, 190 triggers, 1313 constraints, 267 policies,
  191 tables.

This is a complete record of the definitions. It is **not** a replayable dump script.
The repo migrations (replayed in CI) plus the tested rollback are what rebuild S105.

## 4. Verification

| Check | Result |
|---|---|
| Drift check (`compare_kanel_expected.py --mode drift`) on the production snapshot | **PASS**: 2 functions and 2 constraints match S105; the 15 release functions and 1 trigger are absent |
| Column definitions of the 11 tables vs the repo's S105 schema | **identical, 11/11** |
| Restore of the export into a disposable local S105 database, recomputed checksums | **11/11 tables match** production counts and md5 |
| Encrypted archive → decrypt → byte-compare with the original tar | **identical** |
| `SHA256SUMS` inside the decrypted archive | **all 22 files OK** |
| Restore from the **decrypted** archive into a fresh database | **11/11 tables match** |
| Local rehearsal on the restored production data: apply bundles 1–4, then rollback | apply OK (settings 4 / 15, public off); rollback OK (S105, 30 / 0) |

## 5. Storage

| Item | Value |
|---|---|
| Archive | `KANEL_A2_pre_s106_backup_20261022.tar.gpg` (396,709 bytes) |
| Encryption | GnuPG symmetric, AES-256, S2K SHA-512 with 65,011,712 iterations; random 264-bit passphrase |
| SHA-256 (tar) | `494df88530955f84ee214ac10b2990bba5d732531172b483198ecbec1cc33363` |
| SHA-256 (.gpg) | `77f01145d74ee1cbfbee269a2058997beb7bfbb23c8353056f5b44d220273bd0` |
| Location | Session scratchpad (`…/scratchpad/a2/`, mode 0600); passphrase in a separate file (mode 0600). **Not committed to git.** |
| Plaintext | All plaintext exports, the tar, the verification copies and the local restore databases were shredded or dropped after verification. |

## Owner decision (23 Oct 2026)

The owner chose **option (a)**: the verified logical export, matching checksums,
local restore tests and the successful rollback rehearsal are accepted as sufficient
backup preparation for this release. No paid staging project and no PITR upgrade.
**The limitation stands:** the complete Supabase physical backup has not been
restore-tested.

A2 is completed only when the owner confirms (1) they hold the archive and its
SHA-256 matches, and (2) they have a working way to decrypt it, using a key
delivered to an owner-controlled age/GPG public key.

## Key transfer (23 Oct 2026)

The archive was re-encrypted to the owner's GPG public key. The plaintext went
through a pipe and was never written to disk. The owner holds the private key in
Kleopatra; it was never in this session.

| Item | Value |
|---|---|
| Recipient | `KANEL  private <kanel@kanel.is>`; primary key fingerprint `4E1B 6BE0 5AA8 D574 BBDB 4463 A198 A517 34A2 DA58`; encryption subkey `694D296FF25C1EB4` (cv25519) |
| File | `KANEL_A2_pre_s106_backup_20261022_for_KANEL_private.tar.gpg` (2,776,420 bytes; AES-256; single recipient) |
| SHA-256 (.gpg) | `d40ae31dc2136c5b6bda7631072e8d4b9eb5a548f2eb0341231cc676d619f15b` |
| SHA-256 of the decrypted `.tar` (must match) | `494df88530955f84ee214ac10b2990bba5d732531172b483198ecbec1cc33363` |
| Delivered | to the owner as a file download, 23 Oct 2026 |

**Owner confirmation (23 Oct 2026):** downloaded; the `.gpg` SHA-256 matched;
decrypted in Kleopatra with the owner's own private key; the `.tar` SHA-256 matched;
contents readable.

**Session clean-up (23 Oct 2026):** the passphrase-protected original archive, its
passphrase file and the temporary keyring holding the owner's public key were
shredded. The gpg agent was stopped. No private key was ever in this session. The
only copy left in the session is the file encrypted to the owner's key, which only
the owner can open.

## Status of the earlier open items

1. Off-container storage: **resolved.** The owner holds the archive, encrypted to
   their own GPG key.
2. Physical backup restore not verified: **accepted (option a)** for this release.
   No paid staging project and no PITR upgrade were approved. The limitation stays
   documented.
3. Timing: still recommended. Run A3 soon after a daily backup, together with the
   mandatory A2.9 fresh preflight. Refresh the export if booking data changed.
