# Manera Backend

Node.js API for the Gold Store web and React Native app. Login uses JWT. Business data is stored in MySQL through the Prisma schema. Photos and documents are stored in Firebase Storage.

## Setup

1. Create a MySQL database named `manera`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `JWT_SECRET`, and the Firebase values.
3. Install and create the tables:

```bash
npm install
npm run db:push
npm start
```

The API listens on port 4000. The first start seeds demo users when the `users` table is empty.

Demo passwords: `sadmin` / `admin123`, `admin` / `admin123`, `cashier` / `cashier123`, `call` / `call123`, `history` / `history123`, `account` / `account123`.

## JWT

`POST /api/auth/login` returns a Bearer token signed with `JWT_SECRET`. Tokens expire after 12 hours. Send `Authorization: Bearer <token>` on every other route.

## MySQL and Prisma

`prisma/schema.prisma` is the table definition. `npm run db:push` creates or updates the MySQL tables. The API reads and writes with SQL against those tables.

## Firebase

Set one of these in `.env`:

- `FIREBASE_STORAGE_BUCKET` and `FIREBASE_SERVICE_ACCOUNT` (the service-account JSON on one line), or
- `FIREBASE_STORAGE_BUCKET`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`

Job photos go to `clients/{docNo}/images`. Documents (PDF, Word, images) go to `clients/{docNo}/documents`. Uploads return 503 until Firebase is configured.
