# Execute AgriConnect Swarm System
Trigger this workflow using the command: `/run_swarm`

## Steps
1. **Initialize Sentinel**: Call `sentinel_monitor` to poll the environmental data streams.
2. **Evaluate Condition**: Check if any agricultural thresholds are breached.
3. **Analyze**: If a threat exists, dynamically route the payload to `agronomist_analyzer` to generate the custom crop solution.
4. **Broadcast**: Pass the final message to `outreach_broadcaster` to update `sms_outbox.json`.
5. **Report**: Output a visual summary of the swarm run to the Antigravity IDE console chat window for the user to review.
