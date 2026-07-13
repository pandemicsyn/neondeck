# Changesets

Add one concise changeset for each user-facing pull request:

```sh
npm run changeset
```

Use `patch` for fixes, `minor` for features, and `major` for breaking changes.
Changesets are consumed by the release versioning step and become entries in
`CHANGELOG.md`. The private docs workspace is intentionally excluded.

While Neondeck is on the beta channel, enter Changesets prerelease mode before
versioning a release:

```sh
npx changeset pre enter beta
npm run version-packages
```

When the stable release is ready, exit prerelease mode and version the pending
changesets again:

```sh
npx changeset pre exit
npm run version-packages
```
