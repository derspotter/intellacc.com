# Email account identity

For `gmail.com`, `name+tag@gmail.com` and `name@gmail.com` identify one account. The stored address retains its tag for delivery. Registration, password login, password reset and email-based passkey discovery use the same SQL function. Other domains and Gmail dots are unchanged.

Migration `20260917_add_email_identity_key.sql` creates the function and a unique index for active accounts in one transaction. Existing collisions abort the migration without modifying accounts. Do not merge or delete accounts automatically to resolve a collision.

Deploy the migration before starting the updated backend. The normal container entrypoint applies migrations before starting the server. Do not hot-load the controllers before the function exists. This change does not reset passwords or change approval status.

Targeted verification (inside an isolated backend test container):

```sh
npx jest test/email_identity_sql.test.js test/email_identity_accounts.test.js test/password_reset.test.js test/registration_approval.test.js test/webauthn_prf.test.js --runInBand
```

Use a disposable database and `NODE_ENV=test`; never run the integration tests against production.
