# Package releases

Update the package version and lockfile in a pull request. After that pull request passes review and merges into `main`, the repository CI runs its existing checks and publishes new versions to npm. Versions already present in the registry are skipped; retries never overwrite or blindly resend an upload. Workspace packages are published in dependency order. Stable versions use `latest`; prereleases use `next`.

npm access uses Trusted Publishing with GitHub owner `LO-ink`, this repository, workflow `ci.yml`, environment `npm`, and permission to run `npm publish`. No npm token is required. The `npm` environment permits only `main`. Pull requests cannot run the publishing job. The shared publishing action is pinned to a reviewed commit of `LO-ink/lo-developer-tools`.

To retry after an infrastructure failure, rerun the failed job in GitHub Actions or run the CI workflow on `main`. Each new uploaded archive is checked against the public registry integrity before the job succeeds. A registry error fails the job rather than being treated as a missing version.

## Python packages

Update the version in the package `pyproject.toml`. `publish-python.yml` runs after successful main-branch CI, checks which versions are absent from PyPI, tests source, wheel and sdist consumers, and publishes only the missing projects. A partial release can be retried without resending the successful project. If only one distribution of a project was uploaded, rerun its original failed publishing job: it retains the checked artifacts and sends only missing files after comparing existing registry hashes. A new run reports an incomplete version as an error instead of treating it as a completed release. Run this workflow on `main` for an explicit retry. The existing Trusted Publishers use environments `pypi` and `pypi-emulator`; no PyPI token is required.
