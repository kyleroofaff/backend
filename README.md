# Backend (Local Dev)

## Run locally

- Install dependencies: `npm install`
- Copy env template: `cp .env.example .env` (or create `.env` manually on Windows)
- Start API in watch mode: `npm run dev`
- API base URL: `http://localhost:4000`

## Local test accounts

Use these accounts for quick smoke testing in local/dev seed mode.

- **Admin**: `admin@example.com` / `change_me_admin`
- **Seller**: `nina@example.com` / `demo123`
- **Buyer**: `alex@example.com` / `demo123`
- **Bar**: `bar@example.com` / `demo123`

## Notes

- CORS allows frontend origins from `CLIENT_ORIGIN` in `.env`.
- Disallowed origins return `403 CORS origin denied`.
- Legacy plaintext password verification is enabled by default in non-production only.
- Set `ALLOW_LEGACY_PLAINTEXT_PASSWORDS=false` to force hashed-password-only auth.
- For launch/staging/prod, replace local credentials and set environment-specific secrets.
