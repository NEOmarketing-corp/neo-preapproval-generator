# NEO Pre-Approval Letter Generator

An internal Cloudflare Worker that:

1. Collects borrower, loan, and Mortgage Advisor details.
2. Uploads the Mortgage Advisor headshot to Canva.
3. Autofills the NEO Home Loans Canva Brand Template.
4. Exports the completed design as a PDF.
5. Downloads the PDF directly in the Mortgage Advisor's browser.

The configured Canva Brand Template is:

- **Template:** Pre-Approval Letter from NEO Home Loans
- **Template ID:** `EAHQyRFm6tM`

## Important privacy notes

- Do not commit borrower information, Canva credentials, access tokens, or refresh tokens.
- The application does not intentionally store form submissions.
- Each submission creates a new design in the connected Canva account.
- Uploaded headshots are added to the connected Canva account's asset library.
- Protect the application with Cloudflare Access before allowing Mortgage Advisors to use it.
- Confirm the final letter, disclosures, and retention process with NEO Marketing and the authorized compliance team.

## Step 1: Deploy the form from GitHub

1. Sign in to Cloudflare.
2. Open **Workers & Pages**.
3. Select **Create application** or **Create Worker**.
4. Choose **Import a repository**.
5. Connect GitHub if prompted.
6. Select `NEOmarketing-corp/neo-preapproval-generator`.
7. Use the production branch `main`.
8. Leave the build command blank.
9. Use this deploy command:

   ```text
   npx wrangler deploy
   ```

10. Deploy the Worker.
11. Copy the new `workers.dev` URL. It will look similar to:

    ```text
    https://neo-preapproval-generator.YOUR-SUBDOMAIN.workers.dev
    ```

The form will load after this first deployment, but Canva generation will remain disabled until the following setup is complete.

## Step 2: Create the Canva integration

1. Open the [Canva Developer Portal](https://www.canva.com/developers/).
2. Create an integration named `NEO Pre-Approval Generator`.
3. Add this OAuth redirect URL, using the Worker URL from Step 1:

   ```text
   https://YOUR-WORKER-URL/oauth/callback
   ```

4. Enable these Canva scopes:

   - `asset:read`
   - `asset:write`
   - `brandtemplate:content:read`
   - `brandtemplate:meta:read`
   - `design:content:read`
   - `design:content:write`
   - `design:meta:read`

5. Save the Canva Client ID.
6. Generate and securely save the Canva Client Secret.

Do not add either value to this repository.

## Step 3: Add the Cloudflare KV binding

1. In Cloudflare, open **Storage & Databases** → **KV**.
2. Create a namespace named:

   ```text
   neo-preapproval-canva-tokens
   ```

3. Open the deployed Worker.
4. Go to **Settings** → **Bindings**.
5. Add a **KV namespace** binding.
6. Set the variable name to:

   ```text
   CANVA_TOKENS
   ```

7. Select the namespace created above.
8. Save the binding.

KV stores the rotating Canva authorization token and the short-lived OAuth verification state. It must never be exposed to the browser.

## Step 4: Add Cloudflare variables and secrets

In the Worker's **Settings** → **Variables and Secrets**, add:

| Name | Type | Value |
|---|---|---|
| `CANVA_CLIENT_ID` | Secret | Canva Client ID |
| `CANVA_CLIENT_SECRET` | Secret | Canva Client Secret |
| `CANVA_REDIRECT_URI` | Variable | `https://YOUR-WORKER-URL/oauth/callback` |
| `CANVA_TEMPLATE_ID` | Variable | `EAHQyRFm6tM` |

After adding the binding and variables, redeploy the Worker.

## Step 5: Protect the application

Borrower and loan information must not be submitted through a public form.

1. Open the Worker in Cloudflare.
2. Go to **Settings** → **Domains & Routes**.
3. Locate the `workers.dev` URL.
4. Select **Enable Cloudflare Access**.
5. Create an Allow policy for approved NEO users.
6. Use an approved company email domain or an explicit list of authorized email addresses.
7. Confirm that an unauthorized browser cannot open the form.

The `/oauth/connect` route should be limited to the NEO administrator responsible for the connected Canva Enterprise account.

## Step 6: Connect Canva once

After Cloudflare Access is enabled and the Worker has been redeployed:

1. Sign in through Cloudflare Access as the authorized NEO administrator.
2. Open:

   ```text
   https://YOUR-WORKER-URL/oauth/connect
   ```

3. Sign in to the NEO Enterprise Canva account.
4. Review and approve the requested scopes.
5. Confirm that the page says **Canva is connected**.
6. Return to the form. The header status should show **Canva connected**.

## Step 7: Test safely

Use test data only for the first run.

1. Complete every form field.
2. Upload a test headshot smaller than 10 MB.
3. Select **Generate PDF**.
4. Confirm that:

   - A new Canva design was created.
   - Every mapped field appears once and in the correct location.
   - The headshot is correct.
   - The complete PDF downloads.
   - Fine print and approved disclaimer wording remain legible.
   - The generated design appears in the intended Canva account.

Do not begin production use until NEO Marketing and the authorized compliance team approve the final workflow and retention process.

## Local development

Install dependencies:

```bash
npm install
```

Create a local `.dev.vars` file:

```text
CANVA_CLIENT_ID="..."
CANVA_CLIENT_SECRET="..."
CANVA_REDIRECT_URI="http://127.0.0.1:8787/oauth/callback"
```

Create a local or remote KV binding for `CANVA_TOKENS`, then run:

```bash
npm run dev
```

Never commit `.dev.vars`.

## Canva field mapping

| Form field | Canva autofill field |
|---|---|
| Sales price | `Sales Price Amount` |
| Headshot | `Your photo or headshot` |
| Base loan amount | `Base loan amount` |
| NMLS | `NMLS#` |
| Phone | `Your phone number` |
| Final approval details | `Final approval review details.` |
| Regarding | `Regarding` |
| Job title | `Your job title` |
| Mortgage Advisor name | `Your name` |
| Date | `Date` |
| Property | `Property` |
| Email | `Your email address` |
| Recipient/client name | `Recipient/client name` |
| Loan-to-value | `Loan to value amount` |
| Loan type/product | `Loan Type or Product` |

## Commands

```bash
npm run check
npm run dev
npm run deploy
```
