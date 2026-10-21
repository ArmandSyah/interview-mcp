# Public release plan

Status: release proposal with a private Supabase practice preview.
Public accounts and checkout are not available.
The desktop app is the first release.
The [Supabase guide](supabase-hosting.md) identifies the deployed tools and remaining work.

## App and cost limits

The app has a coding workspace and a system-design workspace.
Select **System design** to open the built-in Excalidraw whiteboard.
Select **Coding** to open the code editor.
The MCP engine can also supply practice tools to VS Code.
There is no VS Code whiteboard extension.

Local practice must continue without an account or internet connection after installation.
Docker and the installed Python runtime in Piston are also necessary for code execution.
AI stays off until the user selects a provider.
The user supplies a local model or a personal API key.
Code execution uses local Docker, not a shared public execution server.
A virtual private server (VPS) and a hosted model are not necessary for the first release.

This plan does not change saved attempts, checkpoints, or reflections.
Those records keep their content revisions and local ownership.
An account must not cause an automatic upload of practice data.

## Release sequence

| Stage | Deliverable | Condition before the next stage |
| --- | --- | --- |
| Local preview | Coding, code tests, submissions, design whiteboard, saved drafts, and unsigned installers. | Native source and packaged tests pass with Piston. |
| Public desktop release | Signed installers, release notes, checksums, license notices, and installation instructions. | Clean-machine installation and upgrade tests pass on each supported platform. |
| First paid pack | Reviewed questions, a stated price, checkout, and signed pack licenses. | A test purchase, duplicate notification, refund, and download recovery pass. |
| Optional accounts | Sign-up, sign-in, purchase recovery, and account deletion. | Identity isolation and session revocation tests pass. |
| Optional hosted practice | Supabase practice storage and MCP tools, with local code execution. | Account access, cost limits, isolation tests, and recovery procedures pass. |

The table gives release requirements, not test results.

## User sign-ups

Accounts are optional for local practice.
The first account feature is purchase recovery, not practice synchronization.
The app must keep a **Continue locally** button.
Sign-out must not erase local drafts or purchased packs.

The Python HTTP server uses database-issued bearer keys. It does not accept Supabase session tokens.
The Supabase Edge Function accepts verified Supabase account tokens.
These are different servers.
The desktop can use an operator-supplied Supabase account token.
Automatic sign-in and token refresh are not implemented.

An identity provider identifies the user and supplies a session token.
The private Edge Function uses Supabase Auth for token verification.
Desktop sign-in with that provider is a proposal.
GitHub sign-in is the proposed first method. A configured mail service is necessary for email recovery.
Before provider selection, examine supported regions, service limits, email costs, and mail delivery.

The desktop app is a public OAuth client. It must not contain an OAuth client secret.

Use the system browser, not an embedded login page.
Use the authorization code flow with Proof Key for Code Exchange (PKCE).
PKCE connects a returned authorization code to the app that started the request.
The design must obey [OAuth for native apps](https://www.rfc-editor.org/rfc/rfc8252).
Before provider selection, do a native PKCE prototype with registered callback URLs on each target platform.

Proposed sign-in procedure:

1. Create a random state value and a PKCE verifier in the Electron main process.
2. Start a temporary callback listener on `127.0.0.1`.
3. Open the configured authorization URL in the system browser.
4. Accept only the configured callback path and the initial state value.
5. Exchange the code with the verifier.
6. Close the listener after success, cancellation, or timeout.
7. Keep the refresh token in OS secure storage.
8. Keep the access token in memory in the Electron main process.

If secure storage is unavailable, the account session must end when the app exits.
The renderer must not receive tokens. The Python practice engine must not receive account credentials.
Concurrent sign-in requests must not share state or verifiers.
Expired codes, incorrect state values, and token exchange failures must not create sessions.
The [Supabase PKCE guide](https://supabase.com/docs/guides/auth/sessions/pkce-flow) gives instructions for code exchange and verifier handling.

### Account records and ownership

These are proposed records. They are not records in the installed SQLite schema.

An account identifies one registered user. A purchase records one payment order.
An account session gives access after sign-in. It is not a practice session.
An entitlement is a record that gives access to a purchased pack.

- An account has one permanent ID and zero or more purchases. The ID must not contain personal information.
- Each purchase belongs to one account after claim verification. An unclaimed purchase can have no account.
- An account can have zero or more sessions. Each session belongs to one account.
- Each purchase has one provider order ID. The service must reject duplicate order creation.
- A purchase can give one or more entitlements. Each entitlement belongs to one purchase.
- Each entitlement identifies one pack and its licensed version range.
- A payment notification identifies a provider event. Duplicate notifications must not create duplicate entitlements.
- New local workspaces have no account association. An account can have more than one local workspace.

An email address is contact information, not an account ID or proof of purchase ownership.
The service must validate a purchase claim with the payment provider or a single-use claim token.
The service must not merge accounts only because their email addresses are the same.

Account deletion removes hosted identity and recovery records according to the stated retention policy.
The deletion operation must identify financial records that the service cannot immediately remove.
Local practice and offline licenses stay on the user's computer until the user removes them.
User consent, a conflict policy, and a deletion contract are necessary before practice synchronization.

## Revenue model

The proposed first paid item is a question pack, not a subscription to basic practice.
The app keeps its Apache 2.0 license. A paid pack has a license for its content.

The free app keeps the editor, whiteboard, saved drafts, curated sample hints, and local execution.
Paid packs add independently reviewed questions and explanations.
Do not include copied LeetCode questions or content without publication rights.
Do not offer unlimited hosted AI or code execution.

A proposed price experiment is USD 19 to USD 29 for one pack.
These are proposed prices, not a published price or evidence of demand.
First record the count of users that complete the free examples and request more questions.
Then record purchases, refunds, support time, and the count of users with more than one practice session.
Select a price after you collect this data. Collect usage data only with user consent.

The pack format gives continued offline access to purchased releases.
Its date limit controls new pack releases, not use of installed content.
The format cannot immediately cancel an offline license after a refund.
The refund policy must give that information. A different license contract is necessary for a subscription.

### Checkout and fulfillment

Lemon Squeezy is the proposed hosted checkout provider.
It is the merchant of record for its transactions.
Provider approval and supported seller countries are prerequisites.

Its published base fee is 5% plus USD 0.50 for each sale. The provider can add other fees.
See the [pricing page](https://www.lemonsqueezy.com/pricing) and [fee terms](https://docs.lemonsqueezy.com/help/getting-started/fees).
Examine these terms again before launch. This plan is not tax advice.

For a USD 29 sale, the base fee alone is USD 1.95.
The remaining USD 27.05 does not include taxes, other fees, refunds, support, or content costs.
This example is not a revenue forecast.

The first preview can use manual fulfillment after payment verification.
The owner signs a license in a different directory and supplies the pack and license files.
The app validates signatures locally. A license server is not necessary during practice.

Automatic fulfillment adds a small HTTPS service, not a public Piston server.
A webhook is a payment notification that the checkout provider sends to that service.

The service must validate the webhook signature before it changes purchase records.
It must process duplicates, retries, and refunds. Notifications can have a different time sequence from payments.
The service must reconcile order status before it issues a license.
The service must not accept a checkout success page as payment verification.
Do not put signing keys or payment API secrets in the app or source repository.

## Deployment without a practice server

The first public release consists of installer downloads and documentation.
Use GitHub Releases for installer assets. See [GitHub release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
The update verifier accepts assets from this repository's GitHub Releases only.
A verifier change and new tests are necessary before the app can use a different download host.

Local SQLite is the practice database.
No central database is necessary for the free desktop release.
An always-on license service is not necessary for manual pack fulfillment.
Thus, a VPS is not a prerequisite for the first users.

If automatic fulfillment becomes necessary, compare a small managed function with a small server.
Before you configure a service, set a monthly cost limit.
Store only identity, purchase, entitlement, and notification records in the hosted database.
Keep user code and diagram images out of the payment service.
Use a durable queue for license requests and retry failed deliveries.
Before paid transactions, do a backup and restore test of purchase records.

An optional hosted practice service has different design requirements.
Piston must operate on isolated execution workers, not on a server with payment credentials or an account database.
The local privileged-container setup is not a public multi-user isolation boundary.
Per-user limits, abuse controls, monitoring, and recovery procedures are necessary for the hosted service.
Do not make port 2000 available to internet clients.

## Packaging and public release

PyInstaller bundles the Python MCP engine.
Electron Builder packages that engine with the desktop UI and public examples.
Node.js, uv, and Python are not necessary to start a packaged app.
Docker is optional until the user requests code execution.

The package targets are Linux AppImage, Linux Debian package, Windows installer, and macOS disk image.
The CI workflow has Linux and Windows jobs. It does not have a macOS job.
A configured target does not show that a platform release passed its tests.
Local Linux artifacts are unsigned previews.

Before a public release:

1. Set one version for the app, engine, and release manifest.
2. Do the backend, desktop, Docker integration, and native UI tests.
3. Prepare each supported package on its target operating system.
4. Do packaged tests in a different directory from the source checkout.
5. Do installation, upgrade, backup, and uninstall tests on clean machines.
6. Examine the dependency and font license inventory.
7. Add platform signatures and macOS notarization where applicable.
8. Configure public verification keys without adding private keys to the repository.
9. Sign a manifest that contains each installer's hash, byte count, platform, and architecture.
10. Prepare release notes, checksums, support instructions, and limits.
11. Create a draft release for the owner's inspection.
12. Get owner approval before publication.

OS signatures identify the installer publisher. The signed update manifest authenticates the download metadata.
These mechanisms are different. Release tests are necessary for the two mechanisms.

The app and engine must use the same release version.
Older installers must not open a newer incompatible database.
Recovery uses the pre-upgrade backup, not an unsupported database downgrade.

The release must keep practice records when the user uninstalls or upgrades the app.
Data removal must be a different user-requested operation.
An installer must not start Docker, download a model, or send practice data without the user's request.

## Work that is not part of this plan

This document does not provision accounts, buy a domain, select a paid plan, or publish an installer.
Owner approval is mandatory for provider costs, pack terms, production keys, and the public release.
Implementation of accounts and checkout is a subsequent task.
