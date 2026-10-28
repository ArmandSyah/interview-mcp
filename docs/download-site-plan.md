# Download website plan

Status: deployment proposal.
This plan follows the Windows installation work.

## Proposed services

| Item | Location | Purpose |
| --- | --- | --- |
| Website | Cloudflare Pages Free | App description, screenshots, slow demos, and installation instructions. |
| Installer files | GitHub Releases | Versioned installers, checksums, build identity, and release notes. |
| Local practice | The user's computer | Code, whiteboard, saved work, Docker execution, and an optional local model. |

Cloudflare's price for static asset requests is USD 0.
See its [pricing documentation](https://developers.cloudflare.com/pages/functions/pricing/).
The website budget in this plan is USD 0 each month.
A custom domain is optional.

The maximum Pages file size is 25 mebibytes (MiB).
One MiB is 1,048,576 bytes.
The Free plan has 500 builds each month.
See the [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

Keep installers in GitHub Releases.
A release can contain binary files.
See the [GitHub release guide](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Use the provider's `pages.dev` address for the first site.
Build the site only after website changes or new releases.
Examine provider limits before deployment.
The first site has no Functions, checkout, account registration, or hosted AI.

## Download information

A release identifies one app version and one source commit.
An unpublished draft release can have no installers.
A download release must have at least one verified installer.
Each installer has one release, one checksum, and one byte count.
The site must show the version, source commit, platform, architecture, signing status, and installation guide.

A generated `downloads.json` file can supply those facts.
Each record must identify its GitHub release asset URL and SHA-256 checksum.
Only verified installer records can enable a download button.
A platform without a verified package must show that the package is unavailable.
Each development preview must identify its signing status.

Use the screenshots and slow demos from `docs/media`.
Show their captions.
Each download control must have keyboard access.
The page must operate in desktop and phone viewports.

## Proposed deployment sequence

Before publication, Windows installation tests and the full Desktop workflow must pass for the selected source commit.
The [public release plan](public-release-plan.md) supplies the other release conditions.
A Cloudflare account is necessary before site deployment.
Its [Git integration guide](https://developers.cloudflare.com/pages/get-started/git-integration/) gives the repository connection procedure.
A reviewer with repository write access can examine draft release assets.
See the [GitHub release API guide](https://docs.github.com/en/rest/releases/releases).

1. Prepare a draft GitHub release for the verified source commit.
2. Add the installers and checksum files.
3. Add build identity and release notes.
4. Prepare the static page in a `site` directory.
5. Generate download metadata from the release assets.
6. With repository write access, examine the draft files and page.
7. Get owner approval for publication.
8. Publish the approved release.
9. Do the public download checks below.
10. After those checks pass, publish the approved website.

If a public download check returns an error, set the release to draft.
Correct the files before new verification and publication.

The site points to versioned GitHub release assets.
GitHub Actions artifacts continue to supply temporary development downloads.
The website does not receive practice files or model credentials.
The app update verifier keeps its GitHub download allowlist.

## Verification before publication

- Download each installer without a GitHub login.
- Compare the downloaded checksum with the release metadata.
- Install the Windows download on a clean Windows machine.
- Open saved work after restart and reinstallation.
- Examine keyboard focus and phone layout.
- Examine each unavailable-platform state.
- Play each demo at its recorded speed.
- Make sure that the page and installer identify the same source commit.
- Make sure that an unavailable release cannot enable its download button.

A site rollback changes the page and selected release links.
It does not downgrade installed apps or change saved practice data.
The subscription plan contains payments and account services.
