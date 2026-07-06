---
name: sentinel_monitor
description: Continuous scanning of environmental data via MCP servers to detect agricultural threats or weather anomalies.
---

# Sentinel Skill Instructions
1. Call the `weather-anomaly-tracker` MCP server to pull current agricultural data streams.
2. Evaluate metrics against standard thresholds:
   * Relative Humidity > 85% for 48 hours (High risk for fungal blight).
   * Temperature drops below 4°C (Frost risk).
   * Soil Moisture drops below 15% (Severe drought risk).
3. If an anomaly is found, package the metrics into an isolated state payload and trigger the `agronomist_analyzer` skill via Agent-to-Agent (A2A) communication.
