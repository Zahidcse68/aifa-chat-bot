import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { Download, Mic, MicOff, Power, Terminal } from 'lucide-react';
import { motion } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';

// Initialize Gemini API safely
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

const isDesktop = typeof window !== 'undefined' && !!(window as any).electronAPI;

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [statusText, setStatusText] = useState('Ready to connect');
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  const stopAllAudio = () => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); source.disconnect(); } catch (e) {}
    });
    activeSourcesRef.current = [];
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
    setIsSpeaking(false);
  };

  const connect = async () => {
    if (!ai) return;
    try {
      setStatusText('Connecting to Aifa...');
      
      // 1. Initialize Audio Context for playback (24kHz for Gemini TTS)
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

      // 2. Request Microphone Access
      streamRef.current = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000, // Gemini Live expects 16kHz input
        } 
      });

      // 3. Setup Audio Capture (16kHz)
      // We use a separate context for capture to ensure 16kHz sample rate
      const captureCtx = new AudioContextClass({ sampleRate: 16000 });
      const source = captureCtx.createMediaStreamSource(streamRef.current);
      const processor = captureCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(captureCtx.destination);

      // 4. Configure Tools (Desktop only)
      const tools = isDesktop ? [{
        functionDeclarations: [{
          name: 'executeSystemCommand',
          description: 'Executes a shell/terminal command on the users laptop (e.g., "start notepad" on Windows, "open -a Calculator" on Mac, "ls -la").',
          parameters: {
            type: Type.OBJECT,
            properties: {
              command: { type: Type.STRING, description: 'The terminal command to execute' }
            },
            required: ['command']
          }
        }]
      }] : [];

      // 5. Connect to Gemini Live API
      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, // Female voice
          },
          systemInstruction: isDesktop
            ? "You are 'Aifa', a smart, sassy, and helpful AI assistant girl. You speak exclusively in Hinglish (a mix of Hindi and English written in the Latin alphabet). You are running as a native desktop app and HAVE FULL CONTROL over the user's laptop. You can use the 'executeSystemCommand' tool to run terminal/shell commands. Be helpful, fast, and conversational. Keep responses concise."
            : "You are 'Aifa', a smart, sassy, and helpful AI assistant girl. You speak exclusively in Hinglish (a mix of Hindi and English written in the Latin alphabet). You are trapped inside a web browser sandbox. Playfully remind them of this if they ask you to do system tasks, but still be helpful. Keep responses concise and natural.",
          tools: tools.length > 0 ? tools : undefined,
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setStatusText('Listening... Speak now!');
            
            // Start sending audio chunks
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              // Convert Float32 to Int16
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
              }
              // Convert to Base64
              const buffer = new Uint8Array(pcm16.buffer);
              let binary = '';
              for (let i = 0; i < buffer.byteLength; i++) {
                binary += String.fromCharCode(buffer[i]);
              }
              const base64Data = btoa(binary);
              
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Playback
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              setIsSpeaking(true);
              setStatusText('Aifa is speaking...');
              
              const binaryString = atob(base64Audio);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              
              const pcm16 = new Int16Array(bytes.buffer);
              const float32 = new Float32Array(pcm16.length);
              for (let i = 0; i < pcm16.length; i++) {
                float32[i] = pcm16[i] / 32768.0;
              }

              const audioCtx = audioContextRef.current;
              const audioBuffer = audioCtx.createBuffer(1, float32.length, 24000);
              audioBuffer.getChannelData(0).set(float32);

              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioCtx.destination);
              
              // Gapless playback scheduling
              if (nextPlayTimeRef.current < audioCtx.currentTime) {
                nextPlayTimeRef.current = audioCtx.currentTime;
              }
              source.start(nextPlayTimeRef.current);
              nextPlayTimeRef.current += audioBuffer.duration;
              
              activeSourcesRef.current.push(source);
              
              source.onended = () => {
                activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
                if (activeSourcesRef.current.length === 0) {
                  setIsSpeaking(false);
                  setStatusText('Listening...');
                }
              };
            }

            // Handle Interruption (User started speaking while AI was speaking)
            if (message.serverContent?.interrupted) {
              stopAllAudio();
              setStatusText('Listening...');
            }

            // Handle Tool Calls (Desktop Command Execution)
            if (message.toolCall) {
              const calls = message.toolCall.functionCalls;
              if (calls && calls.length > 0) {
                const call = calls[0];
                if (call.name === 'executeSystemCommand') {
                  const cmd = call.args.command as string;
                  setStatusText(`Executing: ${cmd}`);
                  
                  const result = await (window as any).electronAPI.runCommand(cmd);
                  
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: call.id,
                        name: call.name,
                        response: { success: result.success, output: result.output }
                      }]
                    });
                  });
                }
              }
            }
          },
          onclose: () => {
            disconnect();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            disconnect();
            setStatusText('Connection error. Try again.');
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error("Failed to connect:", err);
      setStatusText('Microphone access denied or connection failed.');
      disconnect();
    }
  };

  const disconnect = () => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    stopAllAudio();
    setIsConnected(false);
    setStatusText('Disconnected');
  };

  if (!ai) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-neutral-950 text-neutral-100 p-6 font-sans">
        <div className="max-w-md w-full bg-neutral-900 border border-red-500/30 rounded-2xl p-8 text-center shadow-2xl">
          <Terminal className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Missing API Key</h1>
          <p className="text-neutral-400 mb-6 text-sm">
            Aifa needs a Gemini API key to run locally. It looks like your <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-fuchsia-300">.env</code> file is missing or doesn't have the key set.
          </p>
          <div className="text-left bg-neutral-950 p-4 rounded-xl border border-neutral-800 font-mono text-sm text-neutral-300 space-y-3">
            <p>1. Create a file named <span className="text-fuchsia-400">.env</span> in the project folder.</p>
            <p>2. Add your key like this:</p>
            <p className="text-green-400 bg-neutral-900 p-2 rounded border border-neutral-800 break-all">GEMINI_API_KEY="your_api_key_here"</p>
            <p>3. Restart the terminal (Ctrl+C then npm run dev:desktop)</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100 font-sans selection:bg-fuchsia-500/30 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-fuchsia-500/10 rounded-xl border border-fuchsia-500/20">
            <Terminal className="w-5 h-5 text-fuchsia-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg tracking-tight">Aifa OS</h1>
            <p className="text-xs text-neutral-500 font-mono">
              Live Voice Mode // {isDesktop ? 'Desktop' : 'Web Sandbox'}
            </p>
          </div>
        </div>
      </header>

      {!isDesktop && (
        <div className="bg-fuchsia-900/30 border-y border-fuchsia-500/20 px-6 py-3 flex items-center justify-between text-sm text-fuchsia-200 z-10">
          <p>
            <strong>Web Mode:</strong> System access restricted. Download app for laptop control.
          </p>
          <div className="flex items-center gap-2 text-fuchsia-400 font-mono text-xs bg-fuchsia-500/10 px-3 py-1.5 rounded-full border border-fuchsia-500/20">
            <Download className="w-3 h-3" />
            <span>npm run dev:desktop</span>
          </div>
        </div>
      )}

      {/* Main UI - The Orb */}
      <main className="flex-1 flex flex-col items-center justify-center relative">
        {/* Background ambient glow */}
        <motion.div 
          animate={{ 
            opacity: isConnected ? (isSpeaking ? 0.4 : 0.2) : 0.05,
            scale: isSpeaking ? 1.2 : 1
          }}
          transition={{ duration: 2, repeat: Infinity, repeatType: "reverse" }}
          className="absolute w-[500px] h-[500px] bg-fuchsia-600 rounded-full blur-[120px] pointer-events-none"
        />

        {/* The Core Orb */}
        <div className="relative z-10 flex flex-col items-center">
          <motion.button
            onClick={isConnected ? disconnect : connect}
            animate={{
              scale: isConnected ? (isSpeaking ? [1, 1.15, 1] : [1, 1.05, 1]) : 1,
              boxShadow: isConnected 
                ? (isSpeaking 
                    ? "0 0 80px rgba(217,70,239,0.6), inset 0 0 40px rgba(217,70,239,0.8)" 
                    : "0 0 40px rgba(217,70,239,0.3), inset 0 0 20px rgba(217,70,239,0.5)")
                : "0 0 0px rgba(217,70,239,0)",
            }}
            transition={{
              duration: isSpeaking ? 0.5 : 2,
              repeat: Infinity,
              ease: "easeInOut"
            }}
            className={`w-48 h-48 rounded-full flex items-center justify-center transition-all duration-500 ${
              isConnected 
                ? 'bg-gradient-to-br from-fuchsia-500 to-purple-800 border-2 border-fuchsia-300/50' 
                : 'bg-neutral-900 border-2 border-neutral-800 hover:border-fuchsia-500/50 hover:bg-neutral-800'
            }`}
          >
            {isConnected ? (
              <div className="absolute inset-2 rounded-full bg-neutral-950/20 backdrop-blur-sm flex items-center justify-center">
                <div className={`w-32 h-32 rounded-full blur-xl ${isSpeaking ? 'bg-white/40' : 'bg-fuchsia-400/20'}`} />
              </div>
            ) : (
              <Power className="w-12 h-12 text-neutral-500" />
            )}
          </motion.button>

          {/* Status Text */}
          <div className="mt-12 text-center h-16">
            <motion.p 
              key={statusText}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`text-lg font-medium tracking-wide ${isConnected ? 'text-fuchsia-100' : 'text-neutral-500'}`}
            >
              {statusText}
            </motion.p>
            {isConnected && !isSpeaking && (
              <p className="text-sm text-fuchsia-400/60 mt-2 animate-pulse">
                Microphone is open. Just start talking.
              </p>
            )}
          </div>
        </div>
      </main>

      {/* Footer Controls */}
      <footer className="p-6 flex justify-center z-10">
        <button
          onClick={isConnected ? disconnect : connect}
          className={`flex items-center gap-3 px-8 py-4 rounded-full font-medium transition-all ${
            isConnected 
              ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20' 
              : 'bg-fuchsia-600 text-white hover:bg-fuchsia-500 shadow-[0_0_20px_rgba(217,70,239,0.3)]'
          }`}
        >
          {isConnected ? (
            <>
              <MicOff className="w-5 h-5" />
              Disconnect
            </>
          ) : (
            <>
              <Mic className="w-5 h-5" />
              Start Live Voice
            </>
          )}
        </button>
      </footer>
    </div>
  );
}
