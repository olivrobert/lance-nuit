# GitLab via `glab` (optional)

This example opts into GitLab explicitly. Install and authenticate `glab`, then:

```sh
lancenuit run delivery-42 --pipeline ./examples/gitlab-glab/pipeline.ts
```

The generic engine and generic shell example never invoke `glab`. The repository
test suite prepends a fake executable to `PATH`, so this example is verified
without contacting GitLab.
