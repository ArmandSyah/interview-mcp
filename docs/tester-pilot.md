# Interview Workbench user pilot

## Give testers one download and one task

Start with Windows x64 testers. The existing installer bundles the app, practice engine, and questions.
The public repository has a verified development download through December 6, 2026 at 19:38 UTC.
Downloaders need a GitHub login. They can practice locally without an Interview Workbench account.
The unsigned installer identifies its publisher as unknown. Testers with managed devices may need their administrator.

[Windows preview ZIP](https://github.com/ArmandSyah/interview-mcp/actions/runs/42280960140/artifacts/13534364384) · [Installer test](https://github.com/ArmandSyah/interview-mcp/actions/runs/42280960140) · [Desktop tests](https://github.com/ArmandSyah/interview-mcp/actions/runs/42280960096)

The Windows baseline is version 0.2.0 at commit `b69c5ef`. The installer contains 158,137,505 bytes.
Its SHA-256 digest is `97275173419695c8515eebdb2810167dcf20ff3c77f996349ce2801affe2d2bd`.
Extract the ZIP and follow INSTALL-WINDOWS.md. This build predates the Personal Library fix and the new welcome action.
Use the build record to identify feedback. Two builds can show the same app version.

## Choose a distribution channel

| Audience | Recommended channel | Operational tradeoff |
| --- | --- | --- |
| First testers with GitHub accounts | Send the existing workflow artifact link and the tester task below. | No new infrastructure. The download expires. |
| Invited testers without GitHub accounts | Put the verified kit under a versioned key in a private Amazon S3 bucket. Give testers short-lived presigned GET links. | Each link works for its holder until expiry or earlier credential expiry. Budget for storage, requests, and transfer. |
| Ongoing public beta | Publish a tagged GitHub prerelease with the kit, checksum, signing status, and release notes. Point the download page at that version. | Stable share link. Public release assets are available to everyone. |
| Accounts and cross-session practice | Use the existing Supabase Auth, Edge Function, and database when testing account features. | Separate account setup adds a step. The last deployment report records private signup and sandbox billing. |

The installer exceeds Supabase Free's 50 MB single-file limit. Use Supabase for account-backed practice when that is the subject of the test.
Keep desktop code execution local. The first coding and design tasks work with AI off and without Docker.
Docker is a prerequisite for running submitted code. Start a separate execution test with Docker already available.

[GitHub artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) · [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) · [S3 presigned links](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html) · [Supabase limits](https://supabase.com/docs/guides/storage/uploads/file-limits) · [Deployment record](deployments/2026-11-06-billing.md)

For an S3 pilot, upload the kit once under its commit and preserve its checksum alongside it.
Issue a download link for that exact object. Test it from a signed-out browser and compare the extracted installer digest above.
For a public beta, verify the Windows installer and Desktop workflows on the intended commit before updating the download page.
Point the page back to the previous verified build if onboarding fails. Keep the earlier build available for comparison.

## What other platforms do

These observations come from public product pages. The suggestions are hypotheses for this app.

| Platform | Observed practice flow | Workbench experiment |
| --- | --- | --- |
| Hello Interview | Candidates work through a design in stages, draw on a whiteboard, and receive feedback per stage. Its AI coding track also evaluates prompts and code review. | In Guided design, start with one requirement. Ask for a diagram and one tradeoff next. Give feedback tied to the captured checkpoint. Keep Mock self-directed. |
| LeetCode Explore | A card shows a topic outline, lets learners select chapters, and marks completed content. | Show which problem is open, what evidence the learner saved, and how to resume. Keep a draft distinct from a passed submission. |
| NeetCode | A roadmap orders topics and groups problems by pattern. Each problem offers an explanation. | Suggest one problem from the filtered catalog. After an attempt, offer a second problem with the same pattern when one exists. |

[Hello Interview guided practice](https://www.hellointerview.com/practice/overview) · [LeetCode Explore](https://support.leetcode.com/hc/en-us/articles/360013578114-How-to-use-Explore) · [NeetCode roadmap](https://neetcode.io/roadmap)

## What to change first

1. **Make the first coding action visible.** The baseline welcome screen describes three steps and directs users to the explorer.
   The candidate shows a problem title and a button that opens its brief. The explorer still opens the editor.
   The candidate prefers an easy problem among the current search results. If none is easy, it uses the first result.
2. **Test one guided design step.** Ask for a requirement, then offer one checkpoint question about the diagram.
   Observe whether users can explain which saved work the feedback refers to before adding further stages.
3. **Make code results actionable.** Test a first-failure view with the input, expected value, actual value, and a return-to-editor action.
   Offer a hint on request. Keep test results separate from AI feedback.

## Tester task and feedback

Give testers the task before showing them the controls. Use the same prompts for each build.

1. Install and open Interview Workbench. Record any warning that affects your decision to continue.
2. Find a coding problem. Explain what it asks in your own words. Enter a draft and request one hint.
3. Close and reopen the app. Locate the draft you wrote.
4. Open System design. Choose a brief. Record one requirement and draw two connected components.
5. Save a checkpoint. Explain what you expect the review to examine.

Ask each participant for the platform, build identifier, first confusing control, expected behavior, and actual behavior.
Record time from launch to finding the brief, unaided task completion, and whether the tester recovered the draft.
Capture the participant's words. Use screenshots only with their permission.
A suggested first round is five testers. If two get stuck at the same step, fix that step and repeat it with fresh testers.
