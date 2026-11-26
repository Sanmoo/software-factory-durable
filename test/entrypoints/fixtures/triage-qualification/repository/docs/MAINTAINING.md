# Maintaining

- **Releases.** A release is cut by a maintainer on their own machine: the registry accepts a publication only with the
  maintainer's hardware key, which is never stored in this repository, in CI or in any automation. No agent or pipeline
  can publish a release.
- **Payment provider.** The secret of the payment provider is rotated only in the provider's console, by the account owner,
  with their second factor. The repository holds no copy of it and nothing in it can rotate it.
- **Decisions not to do something** are files under `.out-of-scope/`, one per decision.
