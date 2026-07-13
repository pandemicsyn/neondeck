# Changesets

Add one concise changeset for each user-facing pull request:

```sh
npm run changeset
```

Use `patch` for fixes, `minor` for features, and `major` for breaking changes.
Changesets are consumed by the release versioning step and become entries in
`CHANGELOG.md`. The private docs workspace is intentionally excluded.

Neondeck's committed `.changeset/pre.json` keeps releases on the beta channel.
Do not run `changeset pre enter` or `npm run version-packages` in feature PRs.
After changesets reach `main`, the Changesets workflow creates or updates the
version PR.

When the stable release is ready, exit prerelease mode and version the pending
changesets through a dedicated PR:

```sh
npx changeset pre exit
npm run version-packages
```
