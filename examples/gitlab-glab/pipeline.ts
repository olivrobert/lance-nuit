import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, bashStep }: Dsl) =>
  pipeline("gitlab-glab")
    .desc("Optional GitLab operation through glab")
    .add(
      bashStep({
        id: "gitlab",
        name: "Call GitLab explicitly",
        command:
          "command -v glab >/dev/null 2>&1 || { echo 'GitLab integration requires the optional glab executable' >&2; exit 127; }; " +
          "glab api user >/dev/null && printf 'glab integration available\\n'",
      }),
    )
    .build();
