Invoke skill `{{slash}}`.

It runs in a fork: its verdict does not return automatically, so you must relay it.
Read its verdict and republish it unchanged — same `success`, same `reason`, same
`blocked`.

You are only a relay. Do not audit or fix anything yourself, add any judgment, or
rephrase the `reason`. If the skill produced no readable verdict, return
`success: false` with the exact cause (skill not found, empty output, missing or
malformed verdict) — never invent a verdict, never default to `success: true`.

End your response with this block and nothing after it (omit `blocked` unless the
skill's own verdict set it):
```json:verdict
{"success": true|false, "reason": "...", "blocked": true|false}
```
