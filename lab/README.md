# Firelab local Firebase lab

This lab runs the official Authentication, Firestore, Realtime Database and Storage emulators. It issues emulator ID and refresh tokens for three users and seeds synthetic documents and files. It requires no cloud Firebase project, billing account or production credentials.

## Start

Use Node 22+, Java 21+ and Python 3 in WSL/Linux:

```sh
cd /mnt/c/users/random/firelab/lab
npm install
python3 start.py
```

Open **http://localhost:4300/?lab=1** and click **Load / renew lab tokens**. This initializes the local SDK, fills Token A with Alice and Token B with Bob, and loads the known test paths. It does not start a scan or approve writes. Emulator downloads may take a few minutes on the first start. Ctrl+C stops the runner and its emulators.

Keep the lab on localhost. A fixed `demo-firelab-lab` project and loopback ports are used. The normal Firelab tab remains a separate cloud workspace. The local lab blocks other project IDs and unconfigured cloud requests. SDK modules still load from Google's CDN.

## Accounts and tokens

| Account | Role |
| --- | --- |
| alice@firelab.test | Owner of Alice's profile and notes |
| bob@firelab.test | Different user, owner of Bob's data |
| admin@firelab.test | User with `admin: true` custom claim |

All three use the deliberately local test password `Firelab-lab-only-2026!`. Authentication → Email/password → Sign in lets you test the current SDK identity. For REST comparisons, choose Alice/Bob/Admin in the lab panel and load fresh tokens. Loading again disconnects the old SDK identity and clears previous scan results.

The token values are available locally in `lab/.runtime/session.json`. The lab does not serve this file over HTTP and it is excluded from Git/ZIP. Use Load / renew when tokens expire. Tokens are unsigned, as required by the Firebase Auth emulator; Firelab's production signature verifier intentionally rejects them. They cannot authenticate to a production Firebase project.

## Exercise the tool

1. Load the lab, then open AutoPwn. The supplied custom scope compares No token, Token A and Token B.
2. Enable temporary write checks, open advanced settings and set the canary limit to 100 to cover all 33 collection/identity combinations. Review and approve the listed canary paths. Existing application documents are not used for canary writes.
3. Review the permission matrix and findings, then open Graph explorer. Switch identities using the graph data-source selector.
4. Export JSON, Markdown or JSONL. Reports identify `local-emulator` and exclude raw tokens.
5. Change Token B to Admin and load again to examine custom-claim access. Use Authentication for SDK operations; pasting a token does not sign in the SDK.
6. Use Firestore, Storage and Realtime Database screens to run individual requests against the supplied fixtures.

| Fixture | Expected behavior |
| --- | --- |
| `public` | Public reads; writes denied |
| `open_write` | Public read/create/update/delete |
| `blind_write` | Reads denied; public create/update/delete |
| `signed_in` | Authentication required for reads/writes |
| `users/{uid}` | Owner get/update; other users denied |
| `users/{uid}/notes` | Owner-only reads/writes |
| `admin_only` | Admin custom claim required |
| `locked` | All requests denied |
| `update_only/example` | Public update on existing fixture; create denied |
| `delete_only/example` | Public delete on existing fixture; create denied |
| `validated` | Requires the application schema and the caller's owner UID |

The final three fixtures expose a scanner limitation: a denied synthetic create does **not** establish update/delete denial or rejection of a valid application payload. AutoPwn reports those operations as not tested. The integration check separately confirms the permitted operations on disposable seeded fixtures. It does not silently promote those observations into AutoPwn findings.

Storage contains `public/readme.txt`, `open_write/example.txt`, `users/{aliceUid}/private.txt` and `locked/example.txt`. Realtime Database has public, open_write, users/{uid} and locked branches. Replace `{aliceUid}` with the UID in the local session file or Auth result.

## Repeatable validation

With the lab running and Playwright/Chromium installed:

```sh
python3 smoke.py
```

The smoke check reseeds this local lab, runs AutoPwn through the UI, checks graph samples and UI authentication, tests SDK/REST operations against the actual emulators, and rejects unexpected cloud service requests. It reseeds fixtures after success. Results go to `lab/.runtime/report.json`; raw credentials are not included. To restore fixtures after an interrupted run:

```sh
python3 server.py --seed
```

This is not an exhaustive security certification. Cloud Functions, IAM, App Check, production signatures, revocation semantics and production service behavior are outside this lab. Emulator differences and the canary payload limitation remain relevant.
