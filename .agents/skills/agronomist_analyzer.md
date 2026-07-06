---
name: agronomist_analyzer
description: Analyzes environmental anomalies against specific regional crop types to generate actionable agricultural advice.
---

# Agronomist Skill Instructions
1. Receive the threat payload from the Sentinel Agent.
2. Check local workspace memory context for regional crop maps (e.g., Rice, Wheat, Coffee).
3. Formulate an immediate, concrete mitigation strategy. 
4. Keep the output under 140 characters so it fits neatly into an emergency SMS message.
5. Example: "ALERT: High humidity detected. Risk of Rice Blast fungus high. Spray organic copper fungicide within 36 hours to protect yields."
