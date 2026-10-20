---
'@livekit/agents': patch
---

Tell running jobs when their worker starts draining, through `JobContext.onDraining()` and `JobContext.isDraining`, so a job can hand its session off before the process is killed.
