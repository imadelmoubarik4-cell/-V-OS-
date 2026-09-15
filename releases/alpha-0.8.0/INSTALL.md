# Install — Alpha 0.8.0

## Application

1. Use Node.js 20 or later.
2. Run `npm run verify` from the repository root.
3. Deploy the repository with Netlify; `apps/web` is selected automatically.

## Database

Review the migrations in timestamp order. On the hosted VÁ project, the five recovered migrations and A.1 are already recorded as applied; do not replay them manually. Apply A.2 only after a production backup, a development-database test, policy verification, and rollback review.

A.2 intentionally replaces the inventory/import policy set. Existing active manager/admin accounts retain access. Future bartender/viewer accounts use the redacted `inventory_catalog` read surface and cannot access raw costs or private imports.

## Private data checkpoint

1. Install `requirements-dev.txt` in an isolated Python environment.
2. Place approved source documents in `source-data/`.
3. Run the command in `data/README.md`.
4. Review `review_queue.csv` before any database promotion.

Do not commit `source-data/` or `data/private/`.
