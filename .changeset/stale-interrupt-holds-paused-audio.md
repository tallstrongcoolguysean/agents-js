---
'@livekit/agents': patch
---

Stop an interruption from carrying into the next reply's audio. Pausing that reply for a possible false interruption dropped its remaining audio and reported it as fully played, so its whole transcript was shown and committed.
