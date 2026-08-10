# Monk's Enhanced Journal — repo rules

## Releases

- **Always create an annotated git tag when a release is cut**, named exactly after the release (e.g. `14.06-test`), pointing at the commit the release zip was built from, and push the tag to origin. This makes it possible to reconstruct exactly what any published artifact contains.
- Never modify release assets in place for a release whose source branch backs an open upstream PR; cut a new release from a hotfix branch instead.
- PR #821 (upstream `ironmonk108/monks-enhanced-journal` ← `bularzik:backlog-fixes`): the upstream maintainer has requested **no further additions** — do not push new commits to `backlog-fixes`.
