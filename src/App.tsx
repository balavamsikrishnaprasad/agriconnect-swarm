import React, { useState, useRef, useEffect } from 'react';
import { 
  Send, Phone, PhoneOff, Settings, AlertTriangle, CloudRain,
  Thermometer, Droplets, MapPin, Sprout
} from 'lucide-react';

type Message = {
  role: 'user' | 'agent' | 'sms' | 'system';
  content: string;
  agentName?: string;
};

type Scenario = 'random' | 'blight' | 'frost' | 'drought';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'system',
      content: 'AgriConnect initialized. Please describe the region and crop to monitor, or use the settings panel.'
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [region, setRegion] = useState('Nairobi');
  const [crop, setCrop] = useState('Maize');
  const [scenario, setScenario] = useState<Scenario>('random');
  const [outbox, setOutbox] = useState<{timestamp: string, message: string}[]>([]);
  const [isCalling, setIsCalling] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // WebRTC/Audio references for live call feature
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const outAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    return () => {
      endCall();
    };
  }, []);

  const pcmToBase64 = (pcmData: Float32Array) => {
    const buffer = new ArrayBuffer(pcmData.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < pcmData.length; i++) {
      let s = Math.max(-1, Math.min(1, pcmData[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const playAudioChunk = (audioCtx: AudioContext, base64Audio: string) => {
    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    const audioBuffer = audioCtx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);
    
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    
    const currentTime = audioCtx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
  };

  const startCall = async () => {
    try {
      setIsCalling(true);
      
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/live?region=${encodeURIComponent(region)}&crop=${encodeURIComponent(crop)}&scenario=${encodeURIComponent(scenario)}`);
      wsRef.current = ws;

      const inputAudioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = inputAudioCtx;

      const outputAudioCtx = new AudioContext({ sampleRate: 24000 });
      outAudioCtxRef.current = outputAudioCtx;
      nextStartTimeRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const source = inputAudioCtx.createMediaStreamSource(stream);
      const processor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(inputAudioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
          ws.send(JSON.stringify({ audio: base64 }));
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.audio && outAudioCtxRef.current) {
          playAudioChunk(outAudioCtxRef.current, msg.audio);
        }
        if (msg.interrupted) {
          nextStartTimeRef.current = outAudioCtxRef.current?.currentTime || 0;
        }
      };

      ws.onclose = () => endCall();
    } catch (e) {
      console.error(e);
      endCall();
    }
  };

  const endCall = () => {
    setIsCalling(false);
    wsRef.current?.close();
    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    try { audioCtxRef.current?.close(); } catch (e) {}
    try { outAudioCtxRef.current?.close(); } catch (e) {}
    wsRef.current = null;
    processorRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    outAudioCtxRef.current = null;
  };

  const handleSend = async () => {
    if (!inputValue.trim() || isProcessing) return;

    const userText = inputValue;
    setInputValue('');
    setIsProcessing(true);

    const newMessages: Message[] = [
      ...messages,
      { role: 'user', content: userText }
    ];
    setMessages(newMessages);
    
    const addMessage = (msg: Message) => setMessages(prev => [...prev, msg]);

    try {
      addMessage({ role: 'system', content: 'Analyzing request and checking environment...' });

      const response = await fetch('/api/swarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userText,
          region,
          crop,
          scenario
        })
      });

      const data = await response.json();

      // Check for Invalid target
      if (data.sentinel_trace?.includes("INVALID TARGET")) {
        addMessage({
          role: 'agent',
          agentName: 'Sentinel Agent',
          content: data.sentinel_trace,
        });
        setIsProcessing(false);
        return;
      }

      if (data.environment_context) {
        const ctx = data.environment_context;
        addMessage({
          role: 'system',
          content: `Environment Context\nRegion: ${ctx.region}\nCrop: ${ctx.crop}\nScenario: ${ctx.scenario}\nWeather Source: ${ctx.weather_source}\nTemperature: ${ctx.temperature}°C\nHumidity: ${ctx.humidity}%\nRainfall: ${ctx.rainfall} mm\nWind Speed: ${ctx.wind_speed} km/h\nDescription: ${ctx.description}`
        });
      }

      if (data.sentinel_trace) {
        addMessage({
          role: 'agent',
          agentName: 'Sentinel Agent',
          content: `${data.sentinel_trace}\n\nRisk Level: ${data.risk_level}`,
        });
      }

      if (data.agronomist_trace) {
        addMessage({
          role: 'agent',
          agentName: 'Agronomist Agent',
          content: data.agronomist_trace,
        });
      }

      if (data.outreach_sms) {
        addMessage({
          role: 'agent',
          agentName: 'Outreach Agent',
          content: 'Drafting SMS for farmer...',
        });
        
        addMessage({
          role: 'sms',
          content: data.outreach_sms,
        });
        
        setOutbox(prev => [{
          timestamp: new Date().toLocaleTimeString(),
          message: data.outreach_sms
        }, ...prev]);
      }
      
      if (data.summary) {
        addMessage({
          role: 'system',
          content: `Summary\n\nRegion: ${data.summary.region}\nCrop: ${data.summary.crop}\nScenario: ${data.summary.scenario}\nRisk Level: ${data.summary.risk_level}\nRecommendation: ${data.summary.recommendation}`
        });
      }

    } catch (err) {
      console.error(err);
      addMessage({
        role: 'system',
        content: 'Error communicating with the swarm.'
      });
    }

    setIsProcessing(false);
  };

  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900">
      
      {/* Sidebar / Settings */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col shadow-sm z-10">
        <div className="p-6 border-b border-gray-100 flex items-center gap-3">
          <div className="bg-green-100 text-green-700 p-2 rounded-lg">
            <Sprout className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-gray-900">AgriConnect</h1>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Swarm Intelligence</p>
          </div>
        </div>
        
        <div className="p-6 flex-1 overflow-y-auto">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-6 flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Environment Context
          </h2>
          
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-gray-400" /> Default Region
              </label>
              <input 
                type="text" 
                value={region} 
                onChange={e => setRegion(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
              />
              <p className="mt-1 text-xs text-gray-500">Fallback if region is not mentioned in prompt.</p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                <Sprout className="w-4 h-4 text-gray-400" /> Default Crop
              </label>
              <input 
                type="text" 
                value={crop} 
                onChange={e => setCrop(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-gray-400" /> Data Source / Scenario
              </label>
              <select 
                value={scenario}
                onChange={e => setScenario(e.target.value as Scenario)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
              >
                <option value="random">Live Real-Time Weather (Open-Meteo)</option>
                <option value="drought">Simulate Drought</option>
                <option value="blight">Simulate Blight Risk (High Humidity)</option>
                <option value="frost">Simulate Frost Risk</option>
              </select>
            </div>
          </div>
          
          {outbox.length > 0 && (
            <div className="mt-8">
               <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">SMS Outbox</h2>
               <div className="space-y-3">
                 {outbox.map((msg, i) => (
                   <div key={i} className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
                     <span className="text-xs text-gray-500 block mb-1">{msg.timestamp}</span>
                     <p className="text-gray-700">{msg.message}</p>
                   </div>
                 ))}
               </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-white">
        <div className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.map((msg, idx) => {
              if (msg.role === 'system') {
                if (msg.content.includes('\n')) {
                  return (
                    <div key={idx} className="flex justify-center my-6">
                      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm max-w-[80%] w-full">
                        <pre className="font-sans text-sm text-gray-600 whitespace-pre-wrap">
                          {msg.content}
                        </pre>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={idx} className="flex justify-center my-4">
                    <span className="text-sm text-gray-400 bg-gray-50 px-4 py-1.5 rounded-full border border-gray-100 whitespace-pre-wrap text-center">
                      {msg.content}
                    </span>
                  </div>
                );
              }
              
              if (msg.role === 'user') {
                return (
                  <div key={idx} className="flex justify-end">
                    <div className="bg-green-600 text-white px-5 py-3 rounded-2xl rounded-tr-sm max-w-[80%] shadow-sm">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              if (msg.role === 'agent') {
                return (
                  <div key={idx} className="flex justify-start">
                    <div className="flex flex-col space-y-1 max-w-[80%]">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">
                        {msg.agentName}
                      </span>
                      <div className="bg-gray-100 border border-gray-200 text-gray-800 px-5 py-3 rounded-2xl rounded-tl-sm shadow-sm font-mono text-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  </div>
                );
              }

              if (msg.role === 'sms') {
                return (
                  <div key={idx} className="flex justify-start">
                    <div className="flex flex-col space-y-1 max-w-[80%]">
                      <span className="text-xs font-semibold text-blue-500 uppercase tracking-wider ml-1">
                        📱 Outbound SMS
                      </span>
                      <div className="bg-blue-50 border border-blue-100 text-blue-900 px-5 py-3 rounded-2xl rounded-tl-sm shadow-sm text-sm">
                        {msg.content}
                      </div>
                    </div>
                  </div>
                );
              }
              
              return null;
            })}
            
            {isProcessing && (
              <div className="flex justify-start">
                 <div className="bg-gray-100 border border-gray-200 text-gray-500 px-5 py-3 rounded-2xl rounded-tl-sm shadow-sm text-sm animate-pulse flex gap-1 items-center">
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></span>
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-75"></span>
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-150"></span>
                 </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Box */}
        <div className="p-6 bg-white border-t border-gray-100">
          <div className="max-w-3xl mx-auto flex gap-3">
            <div className="flex-1 relative">
              <input 
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSend();
                }}
                placeholder="Ask about a farm, region, or crop condition..."
                className="w-full px-5 py-4 bg-gray-50 border border-gray-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-green-500/20 focus:border-green-500 transition-all text-gray-900 shadow-sm"
                disabled={isProcessing}
              />
            </div>
            
            <button 
              onClick={handleSend}
              disabled={isProcessing || !inputValue.trim()}
              className="px-5 py-4 bg-green-600 text-white rounded-2xl hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              <Send className="w-5 h-5" />
            </button>

            <button 
              onClick={isCalling ? endCall : startCall}
              className={`px-5 py-4 rounded-2xl transition-colors shadow-sm flex items-center justify-center ${
                isCalling 
                  ? 'bg-red-100 text-red-600 hover:bg-red-200' 
                  : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
              }`}
            >
              {isCalling ? <PhoneOff className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

