import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 3000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function getRealWeather(regionName: string) {
  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(regionName)}&count=1&language=en&format=json`);
    const geoData = await geoRes.json();
    if (geoData.results && geoData.results.length > 0) {
      const { latitude, longitude, name, country } = geoData.results[0];
      const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&timezone=auto`);
      const weatherData = await weatherRes.json();
      
      const current = weatherData.current;
      // Synthesize soil moisture based on precipitation and humidity
      let soilMoisture = 30; 
      if (current.precipitation > 0) soilMoisture += 40;
      else if (current.relative_humidity_2m > 80) soilMoisture += 20;
      else if (current.temperature_2m > 30) soilMoisture -= 15;
      
      const weatherCodeMap: Record<number, string> = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
        61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
        80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
        95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
      };
      
      return {
         humidity: current.relative_humidity_2m,
         temperature: current.temperature_2m,
         rainfall: current.precipitation || 0,
         wind_speed: current.wind_speed_10m || 0,
         description: weatherCodeMap[current.weather_code] || 'Unknown',
         soil_moisture: Math.max(0, Math.min(100, soilMoisture)),
         realLocation: `${name}, ${country}`
      };
    }
  } catch(e) {
    console.error("Weather API error:", e);
  }
  return null;
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  
  // API Route for the Chat / Swarm
  app.post('/api/swarm', async (req, res) => {
    try {
      const { prompt, region: fallbackRegion, crop: fallbackCrop, scenario } = req.body;
      
      const extractionPrompt = `You are an AI assistant for AgriConnect. Analyze this user message: "${prompt}"
Determine the geographic region and the crop they are asking about.
- If the user message does NOT mention a specific region, use "${fallbackRegion}".
- If the user message does NOT mention a specific crop, use "${fallbackCrop}".
- If the user message mentions a place that is clearly not an agricultural zone (e.g., "Pacific Ocean", "Moon"), set isValidFarm to false and provide a reason. Otherwise set it to true.

Return ONLY a JSON object with this structure:
{
  "region": "region name to use",
  "crop": "crop name to use",
  "isValidFarm": boolean,
  "reason": "explanation if invalid, else null"
}`;

      const extractionResponse = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: extractionPrompt,
        config: { responseMimeType: "application/json" }
      });

      let extracted: any = {};
      try {
        extracted = JSON.parse(extractionResponse.text || "{}");
      } catch (e) {
        console.error("Extraction parse error:", e);
      }

      if (extracted.isValidFarm === false) {
        return res.json({
          sentinel_trace: `INVALID TARGET: ${extracted.reason}`,
          has_anomaly: false,
          agronomist_trace: null,
          outreach_sms: null
        });
      }

      const activeRegion = extracted.region || fallbackRegion || 'Unknown';
      const activeCrop = extracted.crop || fallbackCrop || 'Unknown';

      // 1. TOOL: Weather Anomaly Tracker
      let weatherData = null;
      if (scenario === 'random' || scenario === 'dynamic') {
         weatherData = await getRealWeather(activeRegion);
      }
      
      if (!weatherData) {
        // Fallback or forced scenario
        let humidity = 50, temp = 25, soil_moisture = 40, rainfall = 0, wind_speed = 10, description = 'Clear sky';
        if (scenario === 'blight') {
          humidity = 88; temp = 22; soil_moisture = 45; rainfall = 5; description = 'Rain showers';
        } else if (scenario === 'frost') {
          humidity = 40; temp = 2; soil_moisture = 30; rainfall = 0; description = 'Clear sky';
        } else if (scenario === 'drought') {
          humidity = 30; temp = 35; soil_moisture = 10; rainfall = 0; description = 'Clear sky';
        } else {
          humidity = Math.floor(Math.random() * 40) + 40; // 40-80
          temp = Math.floor(Math.random() * 20) + 15; // 15-35
          soil_moisture = Math.floor(Math.random() * 40) + 30; // 30-70
          rainfall = Math.floor(Math.random() * 10);
          wind_speed = Math.floor(Math.random() * 20);
          description = 'Partly cloudy';
        }
        weatherData = { region: activeRegion, humidity, temperature: temp, soil_moisture, rainfall, wind_speed, description, realLocation: activeRegion };
      }
      
      const weatherSource = (scenario === 'random' || scenario === 'dynamic') ? 'Open-Meteo API' : 'Simulation';

      const sharedContext = `[SHARED ENVIRONMENT CONTEXT]
Region: ${weatherData.realLocation}
Crop: ${activeCrop}
Scenario: ${scenario === 'random' || scenario === 'dynamic' ? 'Live Weather' : scenario}
Weather Source: ${weatherSource}
Weather Data:
- Temperature: ${weatherData.temperature}°C
- Humidity: ${weatherData.humidity}%
- Rainfall: ${weatherData.rainfall} mm
- Wind Speed: ${weatherData.wind_speed} km/h
- Description: ${weatherData.description}
- Soil Moisture: ${weatherData.soil_moisture}%
[/SHARED ENVIRONMENT CONTEXT]`;

      // 2. SENTINEL AGENT
      const sentinelPrompt = `${sharedContext}

You are the Sentinel Agent. Analyze the Weather Data in the shared context.
Provide an assessment explaining why an anomaly was or was not detected.
Include a Risk Level (Low, Medium, High).

Rules:
- Humidity > 85% indicates fungal blight risk (High Risk).
- Temperature < 4°C indicates frost risk (High Risk).
- Soil Moisture < 15% indicates drought risk (High Risk).
- Otherwise, the risk is typically Low or Medium based on the metrics.

Return ONLY a JSON object with this structure:
{
  "assessment": "Detailed explanation of the weather metrics and why there is or isn't a critical anomaly.",
  "risk_level": "Low" | "Medium" | "High",
  "has_anomaly": boolean
}`;

      const sentinelResponse = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: sentinelPrompt,
        config: { responseMimeType: "application/json" }
      });
      
      let sentinelData: any = {};
      try {
        sentinelData = JSON.parse(sentinelResponse.text || "{}");
      } catch (e) {
        sentinelData = { assessment: "Error parsing sentinel.", risk_level: "Medium", has_anomaly: true };
      }

      // 3. AGRONOMIST AGENT
      const agronomistPrompt = `${sharedContext}
Sentinel Agent Risk Level: ${sentinelData.risk_level}
Sentinel Assessment: "${sentinelData.assessment}"

You are the Agronomist Agent.
If there is an anomaly (High/Medium risk), formulate an immediate, concrete mitigation strategy specifically for ${activeCrop} in ${weatherData.realLocation}.
If there is no anomaly (Low risk), provide preventive recommendations (e.g., continue regular irrigation, inspect weekly).

Return ONLY a JSON object with this structure:
{
  "detailed_recommendation": "The full recommendation text.",
  "short_summary": "A 1-sentence summary (e.g. 'Continue routine monitoring.')"
}`;

      const agronomistResponse = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: agronomistPrompt,
        config: { responseMimeType: "application/json" }
      });

      let agronomistData: any = {};
      try {
        agronomistData = JSON.parse(agronomistResponse.text || "{}");
      } catch(e) {
        agronomistData = { detailed_recommendation: "Please monitor the crops.", short_summary: "Monitor crops." };
      }

      // 4. OUTREACH AGENT
      const outreachPrompt = `${sharedContext}
Agronomist Agent Recommendation: "${agronomistData.detailed_recommendation}"
Risk Level: ${sentinelData.risk_level}

You are the Outreach Agent.
Take the Agronomist Agent's recommendation and format it into a friendly, clear SMS message for a farmer growing ${activeCrop} in ${weatherData.realLocation}.
If the risk is High/Medium, make it an emergency alert.
If the risk is Low, make it a positive farmer advisory.

CRITICAL RULES:
- Use ONLY the provided recommendations.
- Do NOT invent other locations, crops, or hazards.
- Output ONLY the final SMS text (max 160 characters, NO JSON).`;

      const outreachResponse = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: outreachPrompt
      });
      const outreachOutput = outreachResponse.text?.trim() || "Stay alert.";

      res.json({
        environment_context: {
          region: weatherData.realLocation,
          crop: activeCrop,
          scenario: scenario === 'random' || scenario === 'dynamic' ? 'Live Weather' : scenario,
          weather_source: weatherSource,
          temperature: weatherData.temperature,
          humidity: weatherData.humidity,
          rainfall: weatherData.rainfall,
          wind_speed: weatherData.wind_speed,
          description: weatherData.description,
          soil_moisture: weatherData.soil_moisture
        },
        sentinel_trace: sentinelData.assessment,
        risk_level: sentinelData.risk_level,
        has_anomaly: sentinelData.has_anomaly,
        agronomist_trace: agronomistData.detailed_recommendation,
        outreach_sms: outreachOutput,
        summary: {
          region: weatherData.realLocation,
          crop: activeCrop,
          scenario: scenario === 'random' || scenario === 'dynamic' ? 'Live Weather' : scenario,
          risk_level: sentinelData.risk_level,
          recommendation: agronomistData.short_summary
        }
      });

    } catch (err) {
      console.error("Swarm API Error:", err);
      res.status(500).json({ error: "Failed to execute swarm" });
    }
  });

  // Websocket server for Gemini Live API
  const wss = new WebSocketServer({ server: httpServer, path: '/live' });

  wss.on('connection', async (clientWs, req) => {
    console.log("Client connected to /live websocket");
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const region = url.searchParams.get('region') || 'Unknown';
      const crop = url.searchParams.get('crop') || 'Unknown';
      const scenario = url.searchParams.get('scenario') || 'random';
      
      let weatherContext = '';
      if (scenario === 'random' || scenario === 'dynamic') {
         const weatherData = await getRealWeather(region);
         if (weatherData) {
            weatherContext = `Real-time weather in ${weatherData.realLocation}: ${weatherData.temperature}°C, ${weatherData.humidity}% humidity.`;
         }
      }

      const session = await ai.live.connect({
        model: 'gemini-3.5-flash',
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
                clientWs.send(JSON.stringify({ audio }));
            }
            if (message.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [{
              text: `You are the AgriConnect Voice Assistant answering a live phone call from a farmer.
Current Context:
- Farmer's Region: ${region}
- Farmer's Crop: ${crop}
- Current Weather Scenario: ${scenario}
${weatherContext}

Be very friendly, empathetic, and practical. Keep your answers brief and conversational, as if speaking on the phone. Answer their questions about the weather and their crops.`
            }]
          },
        },
      });

      clientWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            session.sendRealtimeInput([{
              mimeType: "audio/pcm;rate=16000",
              data: msg.audio
            }]);
          }
        } catch (e) {
          console.error("Error processing message:", e);
        }
      });
      
      clientWs.on('close', () => {
         console.log("Client disconnected from /live websocket");
      });
      
    } catch (err) {
      console.error("Failed to connect to Gemini Live:", err);
      clientWs.send(JSON.stringify({ error: "Failed to connect to AI" }));
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
