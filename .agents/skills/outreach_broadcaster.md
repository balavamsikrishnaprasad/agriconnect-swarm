---
name: outreach_broadcaster
description: Formats final alerts and interfaces with mock communication tools or text message broadcasters.
---

# Outreach Skill Instructions
1. Take the 140-character mitigation plan from the Agronomist Agent.
2. Use the system tool utility `write_to_file` to draft the outgoing notification stack into a log file named `sms_outbox.json`.
3. Format output payload as:
   `{"timestamp": "TIMESTAMP", "target_region": "REGION", "alert_message": "MESSAGE"}`
