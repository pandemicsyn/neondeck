# Configure repository workflows

These controls are implemented in the repository-workflow stack. Synthetic
verification is complete; the operator flow still requires live acceptance.

## Configure and test

1. Open Factory setup and its Repository workflows section. Select the registered
   repository. Optional factory onboarding also exposes workflow configuration.
2. Ask Neon to suggest a workflow, or create a named profile yourself. Suggestions
   remain unsaved drafts; review the cited repository files and commit.
3. Enter ordered setup and validation commands. Each command has its own working
   directory relative to the repository. Use `.` for the root and a path such as
   `packages/extension` for a nested package. Repository-required checks still run.
4. Set phase time limits and any Node/package-manager version requirements. These
   requirements check the installed tools; they do not install a toolchain.
5. Enter environment variable names where needed. Keep their values in the private
   runtime environment, not in command text, workflow snapshots or this repository.
6. Choose a default profile, or require explicit selection per task, then save.
7. Select **Test setup and validation**. This explicitly runs the saved profile
   in a disposable checkout. Inspect phase, command output and cleanup status.
   Cancellation stops the owned test, not other factory work.
   Refreshing the page restores an owned test's progress and cancellation
   controls. If its outcome is uncertain, use **Refresh test status** to retry
   inspection and recovery; do not start another test while it is retained.

For example, an npm project with a committed lockfile might use `npm ci` for
setup and `npm run check` for validation. That is an example, not a default for
every repository: use the package manager and commands actually supported by
the selected repository or package.

## Approve a task

During shaping, Neon can propose a saved workflow for the task. Review the chosen
workflow, including setup commands, required checks, directories, runtime and
environment references, before approving the plan. That resolved configuration
is captured with the release. Editing repository settings does not silently
update an existing run; review and approve the changed workflow deliberately.

After coding, validation prepares its own candidate checkout and runs setup before
checks. A setup failure should show the specific command and output. Correct the
environment and use the offered retry when the approved workflow is unchanged.
Changing commands or runtime requirements requires renewed approval.

Setup failures do not request a coding-agent repair. Successful validation
continues to independent review. Publishing a draft PR remains a separate human
decision after review succeeds.

## Live acceptance still required

- Test a real saved profile in a disposable checkout and inspect its logs/cleanup.
- Approve a task with that profile; confirm setup runs before validation.
- Verify a missing dependency or environment reference yields a clear setup error
  and an appropriate retry, with no code-repair dispatch.
- Verify configured checks and independent review finish before PR approval.
- Investigate the separately observed omitted judge-diff evidence before declaring
  the complete live factory lifecycle accepted.
