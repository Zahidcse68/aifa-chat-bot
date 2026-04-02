import { FunctionDeclaration, GoogleGenAI, Modality, Type } from '@google/genai';
import { Download, Mic, Send, Terminal, Volume2, VolumeX } from 'lucide-react';
import { motion } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

const isDesktop = typeof window !== 'undefined' && !!(window as any).electronAPI;

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      text: isDesktop 
        ? 'Namaste! Main Aifa hoon. Desktop mode active hai. Main aapke laptop ko control kar sakti hoon. Boliye, kya command execute karun?'
        : 'Namaste! Main Aifa hoon. Aapki personal AI assistant. Main browser sandbox mein hoon, isliye laptop control nahi kar sakti, par baaki sab mein help kar sakti hoon. Boliye, kya madad karun?',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Initialize chat session
  const [chat] = useState(() => {
    const config: any = {
      systemInstruction: isDesktop
        ? "You are 'Aifa', a smart, sassy, and helpful AI assistant girl. You speak exclusively in Hinglish (a mix of Hindi and English written in the Latin alphabet). You are running as a native desktop app and HAVE FULL CONTROL over the user's laptop. You can use the 'executeSystemCommand' tool to run terminal/shell commands (like opening apps, checking system info, managing files). Be helpful and execute commands when asked. Keep your responses short, conversational, and natural. Do not use emojis in your text as it will be read by a TTS engine."
        : "You are 'Aifa', a smart, sassy, and helpful AI assistant girl. You speak exclusively in Hinglish (a mix of Hindi and English written in the Latin alphabet). The user wants you to control their laptop, but you are currently trapped inside a web browser sandbox. Playfully remind them of this if they ask you to do system tasks (like opening apps, shutting down, etc.), but still be helpful with answering questions, writing code, or chatting. Keep your responses short, conversational, and natural. Do not use emojis in your text as it will be read by a TTS engine.",
    };

    if (isDesktop) {
      config.tools = [{
        functionDeclarations: [{
          name: 'executeSystemCommand',
          description: 'Executes a shell/terminal command on the users laptop (e.g., "start notepad" on Windows, "open -a Calculator" on Mac, "ls -la").',
          parameters: {
            type: Type.OBJECT,
            properties: {
              command: {
                type: Type.STRING,
                description: 'The terminal command to execute'
              }
            },
            required: ['command']
          }
        }]
      }];
    }

    return ai.chats.create({
      model: 'gemini-3-flash-preview',
      config
    });
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Stop any currently playing audio
  const stopAudio = () => {
    if (activeSourceRef.current) {
      activeSourceRef.current.stop();
      activeSourceRef.current.disconnect();
      activeSourceRef.current = null;
    }
    setIsSpeaking(false);
  };

  // Play raw PCM audio from Gemini TTS
  const playAudio = async (base64Audio: string) => {
    if (!soundEnabled) return;
    
    try {
      stopAudio(); // Stop previous audio if any

      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
      }
      const audioCtx = audioContextRef.current;

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const float32Data = new Float32Array(bytes.length / 2);
      const dataView = new DataView(bytes.buffer);

      for (let i = 0; i < float32Data.length; i++) {
        float32Data[i] = dataView.getInt16(i * 2, true) / 32768.0;
      }

      const audioBuffer = audioCtx.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      activeSourceRef.current = source;

      setIsSpeaking(true);

      return new Promise<void>((resolve) => {
        source.onended = () => {
          setIsSpeaking(false);
          activeSourceRef.current = null;
          resolve();
        };
        source.start();
      });
    } catch (err) {
      console.error('Audio playback failed:', err);
      setIsSpeaking(false);
    }
  };

  const handleSend = async (text: string = input) => {
    if (!text.trim()) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', text };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    stopAudio();

    try {
      // 1. Get Text Response
      let response = await chat.sendMessage({ message: text });
      
      // Handle function calls if any
      if (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        if (call.name === 'executeSystemCommand') {
          const cmd = call.args.command as string;
          
          // Add a temporary message showing execution
          setMessages((prev) => [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            text: `[Executing command: ${cmd}]`
          }]);

          // Execute command via Electron IPC
          const result = await (window as any).electronAPI.runCommand(cmd);
          
          // Send result back to Gemini
          response = await chat.sendMessage({
            message: JSON.stringify({
              system_notification: "Command executed.",
              command: cmd,
              success: result.success,
              output: result.output
            })
          });
        }
      }

      const replyText = response.text || 'Sorry, main samajh nahi payi.';

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        text: replyText,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // 2. Get Audio Response (TTS)
      if (soundEnabled) {
        const audioResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash-preview-tts',
          contents: [{ parts: [{ text: replyText }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' }, // Female voice
              },
            },
          },
        });

        const base64Audio =
          audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          await playAudio(base64Audio);
        }
      }
    } catch (error) {
      console.error('Error generating response:', error);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          text: 'Oops! Kuch technical error aa gaya. Please try again.',
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-IN'; // Indian English helps with Hinglish recognition
    recognition.interimResults = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') {
        console.log('No speech detected. Please try again.');
      } else {
        console.error('Speech recognition error', event.error);
      }
      setIsListening(false);
    };

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
      // Optionally auto-send:
      // handleSend(transcript);
    };

    recognition.start();
  };

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100 font-sans selection:bg-fuchsia-500/30">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/50 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-fuchsia-500/10 rounded-xl border border-fuchsia-500/20">
            <Terminal className="w-5 h-5 text-fuchsia-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg tracking-tight">Aifa OS</h1>
            <p className="text-xs text-neutral-500 font-mono">
              v1.0.0 // {isDesktop ? 'Desktop Mode' : 'Web Sandbox Mode'}
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setSoundEnabled(!soundEnabled);
            if (soundEnabled) stopAudio();
          }}
          className="p-2 rounded-full hover:bg-neutral-800 transition-colors text-neutral-400 hover:text-neutral-200"
          title={soundEnabled ? 'Mute Voice' : 'Enable Voice'}
        >
          {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
        </button>
      </header>

      {!isDesktop && (
        <div className="bg-fuchsia-900/30 border-b border-fuchsia-500/20 px-6 py-3 flex items-center justify-between text-sm text-fuchsia-200">
          <p>
            <strong>Web Mode:</strong> System access is restricted. To control your laptop, download the app and run it locally.
          </p>
          <div className="flex items-center gap-2 text-fuchsia-400 font-mono text-xs bg-fuchsia-500/10 px-3 py-1.5 rounded-full border border-fuchsia-500/20">
            <Download className="w-3 h-3" />
            <span>npm run dev:desktop</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col relative">
        {/* Avatar / Visualizer Area */}
        <div className="h-48 shrink-0 flex items-center justify-center border-b border-neutral-800/50 bg-gradient-to-b from-neutral-900 to-neutral-950 relative overflow-hidden">
          {/* Background glow */}
          <div className="absolute inset-0 flex items-center justify-center opacity-20">
            <div className="w-64 h-64 bg-fuchsia-500 rounded-full blur-[100px]" />
          </div>

          {/* Orb */}
          <motion.div
            animate={{
              scale: isSpeaking ? [1, 1.2, 1] : isLoading ? [1, 1.05, 1] : 1,
              opacity: isSpeaking ? [0.8, 1, 0.8] : 0.8,
            }}
            transition={{
              duration: isSpeaking ? 0.5 : isLoading ? 1.5 : 2,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
            className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(217,70,239,0.3)] ${
              isSpeaking
                ? 'bg-gradient-to-tr from-fuchsia-600 to-purple-400'
                : 'bg-gradient-to-tr from-neutral-800 to-neutral-700'
            }`}
          >
            <div className="absolute inset-1 bg-neutral-950 rounded-full flex items-center justify-center">
              <div
                className={`w-16 h-16 rounded-full blur-md ${
                  isSpeaking ? 'bg-fuchsia-500/50' : 'bg-neutral-500/20'
                }`}
              />
            </div>
          </motion.div>
        </div>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
          {messages.map((msg) => (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              key={msg.id}
              className={`flex ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-5 py-3.5 ${
                  msg.role === 'user'
                    ? 'bg-neutral-800 text-neutral-100 rounded-tr-sm'
                    : 'bg-fuchsia-500/10 text-fuchsia-50 border border-fuchsia-500/20 rounded-tl-sm'
                }`}
              >
                <p className="leading-relaxed whitespace-pre-wrap">{msg.text}</p>
              </div>
            </motion.div>
          ))}
          {isLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex justify-start"
            >
              <div className="bg-fuchsia-500/5 border border-fuchsia-500/10 rounded-2xl rounded-tl-sm px-5 py-4 flex items-center gap-2">
                <div className="w-2 h-2 bg-fuchsia-500/50 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-fuchsia-500/50 rounded-full animate-bounce [animation-delay:0.2s]" />
                <div className="w-2 h-2 bg-fuchsia-500/50 rounded-full animate-bounce [animation-delay:0.4s]" />
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input Area */}
      <footer className="p-4 bg-neutral-950 border-t border-neutral-800">
        <div className="max-w-4xl mx-auto relative flex items-center">
          <button
            onClick={startListening}
            className={`absolute left-3 p-2 rounded-full transition-colors ${
              isListening
                ? 'bg-red-500/20 text-red-400'
                : 'hover:bg-neutral-800 text-neutral-400'
            }`}
            title="Voice Input"
          >
            <Mic className="w-5 h-5" />
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
            placeholder="Type a command or ask something..."
            className="w-full bg-neutral-900 border border-neutral-800 rounded-full py-4 pl-14 pr-14 text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50 transition-all"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
            className="absolute right-3 p-2 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-full transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
        <p className="text-center text-xs text-neutral-600 mt-3 font-mono">
          System Access: RESTRICTED. Running in isolated web environment.
        </p>
      </footer>
    </div>
  );
}
