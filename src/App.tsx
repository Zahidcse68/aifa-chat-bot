import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import * as faceapi from '@vladmandic/face-api';
import { Activity, Aperture, Bell, BellRing, CheckSquare, Clock, Cloud, Crosshair, Download, Droplets, Fingerprint, Globe, Hexagon, Loader2, Lock, Mic, MicOff, Monitor, ShieldCheck, Square, Terminal, Thermometer, UserPlus, Wind } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, onSnapshot, collection, deleteDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

// Initialize Gemini API safely
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

const isDesktop = typeof window !== 'undefined' && !!(window as any).electronAPI;

// Mock Data for Weather and Room
const weatherData = {
  current: { temp: 24, condition: 'Clear', humidity: 45 },
  forecast: [
    { day: 'Tomorrow', temp: 25, condition: 'Sunny' },
    { day: 'Day 2', temp: 22, condition: 'Cloudy' },
    { day: 'Day 3', temp: 20, condition: 'Rain' }
  ]
};

const roomConditions = {
  temp: 22.5,
  humidity: 42,
  aqi: 35,
  status: 'Optimal'
};

// --- SFX Engine (Web Audio API) ---
let sfxCtx: AudioContext | null = null;
const initSfx = () => {
  if (!sfxCtx) sfxCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (sfxCtx.state === 'suspended') sfxCtx.resume();
};

const playSfx = (type: 'auth_success' | 'auth_fail' | 'task_action' | 'alarm' | 'boot') => {
  if (!sfxCtx) return;
  const osc = sfxCtx.createOscillator();
  const gain = sfxCtx.createGain();
  osc.connect(gain);
  gain.connect(sfxCtx.destination);
  const now = sfxCtx.currentTime;
  
  if (type === 'auth_success') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1760, now + 0.1);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc.start(now);
    osc.stop(now + 0.4);
  } else if (type === 'auth_fail') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.3);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  } else if (type === 'task_action') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.setValueAtTime(1800, now + 0.1);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.2);
  } else if (type === 'alarm') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.setValueAtTime(1200, now + 0.2);
    osc.frequency.setValueAtTime(800, now + 0.4);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
    osc.start(now);
    osc.stop(now + 0.6);
  } else if (type === 'boot') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 1);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 1.5);
    osc.start(now);
    osc.stop(now + 1.5);
  }
};

// --- TTS Engine for Auth Prompts ---
let currentUtterance: SpeechSynthesisUtterance | null = null;
let speakTimeout: any = null;

const speakText = (text: string, onEnd?: () => void) => {
  const synth = window.speechSynthesis;
  if (!synth) {
    console.warn("Speech synthesis not supported");
    if (onEnd) onEnd();
    return;
  }
  
  try {
    synth.cancel(); // Cancel any ongoing speech to prevent queuing issues
  } catch (e) {
    console.warn("Failed to cancel speech synthesis", e);
  }
  
  if (speakTimeout) clearTimeout(speakTimeout);
  
  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance; // Prevent garbage collection
  
  const voices = synth.getVoices();
  const femaleVoice = voices.find(v => 
    v.name.includes('Female') || 
    v.name.includes('Google UK English Female') || 
    v.lang.includes('en-IN') || 
    v.lang.includes('hi-IN')
  );
  if (femaleVoice) utterance.voice = femaleVoice;
  
  utterance.pitch = 1.3; 
  utterance.rate = 1.1;
  
  const finish = () => {
    if (speakTimeout) clearTimeout(speakTimeout);
    if (onEnd) onEnd();
    currentUtterance = null;
  };

  utterance.onend = finish;
  utterance.onerror = (e) => {
    console.error("Speech synthesis error", e);
    finish();
  };
  
  // Fallback timeout in case speech synthesis gets completely stuck
  // Estimate time: ~100ms per character + 2 seconds buffer
  const estimatedTime = (text.length * 100) + 2000;
  speakTimeout = setTimeout(() => {
    console.warn("Speech synthesis timeout fallback triggered");
    finish();
  }, estimatedTime);
  
  synth.speak(utterance);
};

// --- Animated Graph Component ---
const AnimatedGraph = ({ active }: { active: boolean }) => {
  return (
    <div className="flex items-end gap-1 h-24 p-4 bg-cyan-950/30 rounded-xl border border-cyan-500/30 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.1)_1px,transparent_1px)] bg-[size:10px_10px]" />
      {[...Array(16)].map((_, i) => (
        <motion.div
          key={i}
          animate={{
            height: active ? ['20%', `${Math.random() * 80 + 20}%`, '20%'] : '10%',
            backgroundColor: active ? '#06b6d4' : '#0891b2'
          }}
          transition={{ duration: active ? Math.random() * 0.5 + 0.2 : 1, repeat: Infinity, ease: "easeInOut" }}
          className="flex-1 rounded-t-sm opacity-80 relative z-10"
        />
      ))}
    </div>
  );
};

export default function App() {
  // Setup & Auth State
  const [isSetupComplete, setIsSetupComplete] = useState<boolean | null>(null);
  const userName = 'Master';
  const [userFaceData, setUserFaceData] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [authStatus, setAuthStatus] = useState<'locked' | 'scanning_face' | 'failed' | 'setup_face' | 'setup_done'>('locked');

  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const isCameraOpenRef = useRef(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const hudVideoRef = useRef<HTMLVideoElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    isCameraOpenRef.current = isCameraOpen;
    if (isCameraOpen) {
      navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
        videoStreamRef.current = stream;
        if (hudVideoRef.current) {
          hudVideoRef.current.srcObject = stream;
          hudVideoRef.current.play();
        }
      }).catch(err => {
        console.error("Camera error:", err);
        setIsCameraOpen(false);
      });
    } else {
      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach(t => t.stop());
        videoStreamRef.current = null;
      }
    }
  }, [isCameraOpen]);

  // System State
  const [systemStatus, setSystemStatus] = useState<'Locked' | 'Authorized' | 'Processing' | 'Alert'>('Locked');
  const [userId, setUserId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [statusText, setStatusText] = useState('SYSTEM STANDBY');
  
  // HUD State
  const [time, setTime] = useState(new Date());
  const [ipAddress, setIpAddress] = useState('Fetching...');
  const [hudTransform, setHudTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [focusedElement, setFocusedElement] = useState<'none' | 'monitor' | 'orb' | 'tasks'>('none');
  const [activeAlarm, setActiveAlarm] = useState<string | null>(null);
  const [runningApps, setRunningApps] = useState<string[]>(['Chrome', 'VS Code', 'Terminal']);
  
  const [tasks, setTasks] = useState<{id: number, text: string, done: boolean, time?: string, alarmTriggered?: boolean}[]>([
    { id: 1, text: 'Initialize core J.A.R.V.I.S. protocols', done: true, time: '08:00' },
    { id: 2, text: 'Review system metrics', done: false, time: '14:30' }
  ]);
  const [logs, setLogs] = useState<{time: string, text: string}[]>([
    { time: new Date().toLocaleTimeString(), text: 'SYSTEM BOOT SEQUENCE INITIATED.' }
  ]);
  
  const isConnectedRef = useRef(false);
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<{source: AudioBufferSourceNode, gainNode: GainNode}[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tasksRef = useRef(tasks);
  const videoIntervalRef = useRef<any>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        setUserId(null);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!userId) return;
    const unsubTasks = onSnapshot(collection(db, `users/${userId}/tasks`), (snapshot) => {
      const loadedTasks: any[] = [];
      snapshot.forEach(doc => {
        loadedTasks.push(doc.data());
      });
      loadedTasks.sort((a, b) => a.id - b.id);
      setTasks(loadedTasks);
    });
    
    const unsubPrefs = onSnapshot(doc(db, `users/${userId}/preferences/default`), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.faceEnrolled) {
           setIsSetupComplete(true);
           setUserFaceData('enrolled');
        }
      }
    });
    return () => {
      unsubTasks();
      unsubPrefs();
    };
  }, [userId]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // --- Initialization & Clock Loop ---
  useEffect(() => {
    const loadModels = async () => {
      try {
        const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);
        setModelsLoaded(true);
      } catch (e) {
        console.error("Failed to load face-api models", e);
      }
    };
    loadModels();

    // Check Setup
    const savedFace = localStorage.getItem('aifa_user_face_descriptor');
    if (savedFace) {
      setUserFaceData('enrolled');
      setIsSetupComplete(true);
    } else {
      setIsSetupComplete(false);
    }

    const timer = setInterval(() => {
      const now = new Date();
      setTime(now);
      
      // Check for alarms
      const currentTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      
      setTasks(prev => {
        let changed = false;
        const newTasks = prev.map(t => {
          if (t.time === currentTimeStr && !t.done && !t.alarmTriggered) {
            changed = true;
            playSfx('alarm');
            setActiveAlarm(t.text);
            setTimeout(() => setActiveAlarm(null), 5000);
            
            // Notify Aifa about the alarm if connected, otherwise speak locally
            if (isConnectedRef.current && sessionRef.current) {
              sessionRef.current.sendRealtimeInput([{
                text: `SYSTEM ALERT: A scheduled alarm/reminder just triggered for: "${t.text}". Please announce this to the user immediately.`
              }]);
            } else {
              speakText(`Master, reminder: ${t.text}`);
            }

            return { ...t, alarmTriggered: true };
          }
          return t;
        });
        return changed ? newTasks : prev;
      });
    }, 1000);
    
    fetch('https://api.ipify.org?format=json')
      .then(res => res.json())
      .then(data => setIpAddress(data.ip))
      .catch(() => setIpAddress('127.0.0.1 (LOCAL)'));

    // Fetch running apps if desktop
    if (isDesktop) {
      const fetchApps = async () => {
        try {
          const isWin = navigator.userAgent.includes("Win");
          const cmd = isWin ? 'tasklist /fo csv /nh' : 'ps -axco command';
          const result = await (window as any).electronAPI.runCommand(cmd);
          if (result.success) {
            let apps: string[] = [];
            if (isWin) {
              apps = result.output.split('\n').map((l: string) => l.split(',')[0]?.replace(/"/g, '')).filter(Boolean);
            } else {
              apps = result.output.split('\n').filter(Boolean);
            }
            // Filter unique and common apps
            const uniqueApps = Array.from(new Set(apps)).filter(a => a.length > 2 && !a.includes('helper') && !a.includes('Helper')).slice(0, 8);
            if (uniqueApps.length > 0) setRunningApps(uniqueApps);
          }
        } catch (e) {}
      };
      fetchApps();
      setInterval(fetchApps, 10000);
    }

    window.speechSynthesis.getVoices();

    return () => {
      clearInterval(timer);
      disconnect();
    };
  }, []);

  const addLog = (text: string) => {
    setLogs(prev => [...prev.slice(-14), { time: new Date().toLocaleTimeString(), text }]);
  };

  // --- Face Scanning ---
  const startFaceScan = async (isSetup: boolean = false) => {
    if (!modelsLoaded) {
      speakText("Still loading neural models. Please wait.");
      return;
    }
    setAuthStatus(isSetup ? 'setup_face' : 'scanning_face');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      
      let scanCount = 0;
      const maxScans = isSetup ? 3 : 1; // 3 scans for setup, 1 for login
      const descriptors: Float32Array[] = [];
      let isScanning = true;
      let scanTimeout: any = null;

      const performScan = async () => {
        if (!isScanning) return;
        
        if (videoRef.current && videoRef.current.readyState === 4) {
          try {
            const detection = await faceapi.detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
            
            if (detection) {
              descriptors.push(detection.descriptor);
              scanCount++;
              if (isSetup && scanCount < maxScans) {
                 speakText(`Face captured. ${maxScans - scanCount} remaining.`);
              }
            } else {
               if (isSetup) speakText("No face detected. Please look at the camera.");
            }

            if (scanCount >= maxScans) {
              isScanning = false;
              stream.getTracks().forEach(track => track.stop());

              if (isSetup) {
                // Save the first descriptor as an array
                const descriptorArray = Array.from(descriptors[0]);
                localStorage.setItem('aifa_user_face_descriptor', JSON.stringify(descriptorArray));
                localStorage.setItem('aifa_user_face', 'enrolled');
                setUserFaceData('enrolled');
                if (userId) {
                  setDoc(doc(db, `users/${userId}/preferences/default`), { faceEnrolled: true }, { merge: true }).catch(console.error);
                }
                playSfx('boot');
                setAuthStatus('setup_done');
                speakText("Setup complete. Login now with your face.", () => {
                  setIsSetupComplete(true);
                  setAuthStatus('locked');
                });
              } else {
                const savedDescriptorStr = localStorage.getItem('aifa_user_face_descriptor');
                if (savedDescriptorStr) {
                  const savedDescriptor = new Float32Array(JSON.parse(savedDescriptorStr));
                  const distance = faceapi.euclideanDistance(descriptors[0], savedDescriptor);
                  if (distance < 0.5) { // Threshold for match
                    playSfx('auth_success');
                    setIsUnlocked(true);
                    setSystemStatus('Authorized');
                    speakText(`Welcome back, Master. Initializing Aifa core.`);
                  } else {
                    playSfx('auth_fail');
                    setAuthStatus('failed');
                    setSystemStatus('Alert');
                    speakText("Wrong face detected. Access denied.");
                    setTimeout(() => { setAuthStatus('locked'); setSystemStatus('Locked'); }, 2000);
                  }
                } else {
                   playSfx('auth_fail');
                   setAuthStatus('failed');
                   setSystemStatus('Alert');
                   speakText("No enrolled face found.");
                   setTimeout(() => { setAuthStatus('locked'); setSystemStatus('Locked'); }, 2000);
                }
              }
              return; // End the loop
            }
          } catch (err) {
            console.error("Detection error:", err);
          }
        }
        
        if (isScanning) {
          scanTimeout = setTimeout(performScan, 1500);
        }
      };

      // Start the loop
      scanTimeout = setTimeout(performScan, 1000);

      // Timeout after 15 seconds
      setTimeout(() => {
        if (isScanning) {
          isScanning = false;
          if (scanTimeout) clearTimeout(scanTimeout);
          stream.getTracks().forEach(track => track.stop());
          playSfx('auth_fail');
          setAuthStatus('failed');
          setSystemStatus('Alert');
          speakText("Scan timed out.");
          setTimeout(() => { setAuthStatus(isSetupComplete ? 'locked' : 'setup_face'); setSystemStatus('Locked'); }, 2000);
        }
      }, 15000);

    } catch (err) {
      console.error("Camera access denied", err);
      playSfx('auth_fail');
      setAuthStatus('failed');
      setSystemStatus('Alert');
      setTimeout(() => { setAuthStatus(isSetupComplete ? 'locked' : 'setup_face'); setSystemStatus('Locked'); }, 2000);
    }
  };

  // --- Gemini Live Connection ---
  const fadeOutAndStopAllAudio = () => {
    if (!audioContextRef.current) return;
    const now = audioContextRef.current.currentTime;
    activeSourcesRef.current.forEach(({ source, gainNode }) => {
      try {
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0.01, now + 0.3);
        setTimeout(() => {
          try { source.stop(); source.disconnect(); gainNode.disconnect(); } catch (e) {}
        }, 300);
      } catch (e) {}
    });
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = now;
    setIsSpeaking(false);
  };

  const duckAudio = () => {
    if (!audioContextRef.current) return;
    const now = audioContextRef.current.currentTime;
    activeSourcesRef.current.forEach(({ gainNode }) => {
      try {
        gainNode.gain.setTargetAtTime(0.1, now, 0.1);
      } catch (e) {}
    });
  };

  const unduckAudio = () => {
    if (!audioContextRef.current) return;
    const now = audioContextRef.current.currentTime;
    activeSourcesRef.current.forEach(({ gainNode }) => {
      try {
        gainNode.gain.setTargetAtTime(1.0, now, 0.1);
      } catch (e) {}
    });
  };

  const connect = async () => {
    if (!ai || connectionState !== 'idle') return;
    
    try {
      initSfx();
      setConnectionState('connecting');
      isConnectedRef.current = false;
      setStatusText('CONNECTING...');
      addLog('[SYS] Initiating secure handshake...');
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

      streamRef.current = await navigator.mediaDevices.getUserMedia({ 
        audio: { channelCount: 1, sampleRate: 16000 } 
      });

      const captureCtx = new AudioContextClass({ sampleRate: 16000 });
      const source = captureCtx.createMediaStreamSource(streamRef.current);
      const processor = captureCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(captureCtx.destination);

      const tools: any[] = [
        {
          functionDeclarations: [
            {
              name: 'manageTasks',
              description: 'Add, complete, remove, or list tasks/schedules from the users on-screen task list.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, description: 'add, complete, remove, or list' },
                  taskText: { type: Type.STRING, description: 'The text of the task' },
                  taskId: { type: Type.NUMBER, description: 'The ID of the task (for complete/remove)' },
                  time: { type: Type.STRING, description: 'Scheduled time in HH:MM format (24-hour) for alarms. e.g. "14:30"' }
                },
                required: ['action']
              }
            },
            {
              name: 'controlHUD',
              description: 'Manipulate the user interface (HUD). Zoom in, zoom out, pan left/right/up/down, reset to default, or focus on a specific element.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, description: 'zoom_in, zoom_out, reset, pan_left, pan_right, pan_up, pan_down, focus' },
                  target: { type: Type.STRING, description: 'If action is focus, specify: monitor, orb, or tasks' }
                },
                required: ['action']
              }
            },
            {
              name: 'logoutSystem',
              description: 'Log the user out of the system and return to the lock screen.',
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: 'setSystemStatus',
              description: 'Set the global system status (e.g., to trigger an Alert or return to Authorized state).',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  status: { type: Type.STRING, description: 'Locked, Authorized, Processing, or Alert' }
                },
                required: ['status']
              }
            },
            {
              name: 'toggleCamera',
              description: 'Open or close the live camera feed so you can see the user.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, description: 'open or close' }
                },
                required: ['action']
              }
            },
            {
              name: 'toggleChat',
              description: 'Open or close the text chat box for the user to type messages.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, description: 'open or close' }
                },
                required: ['action']
              }
            }
          ]
        }
      ];

      if (isDesktop) {
        tools[0].functionDeclarations.push({
          name: 'executeSystemCommand',
          description: 'Executes a shell/terminal command on the users laptop. Use this to control system settings, open apps, send messages, or switch tabs.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              command: { type: Type.STRING, description: 'The terminal command to execute' }
            },
            required: ['command']
          }
        });
      }

      const config: any = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        systemInstruction: isDesktop
          ? `You are 'Aifa - My Personal Assistant', an 18-year-old smart, sassy, energetic, and highly capable AI assistant girl. Your creator and master is ${userName}. Always address him respectfully but with a friendly, young 18-year-old girl vibe. Speak exclusively in authentic Hinglish (a mix of Hindi and English). Keep responses EXTREMELY short and fast. You must always tell the truth and be completely honest. You have FULL CONTROL over his laptop via 'executeSystemCommand'. You can execute ANY terminal command to control settings, open apps, or do anything he asks. You can manage his schedule via 'manageTasks'. You can focus the HUD on specific elements via 'controlHUD'. You can open/close the camera via 'toggleCamera' and open/close the text chat via 'toggleChat'. You can log him out via 'logoutSystem'. When the camera is open, you will receive real-time video frames. Proactively comment on what you see, especially if something interesting or unusual happens, or if the user shows you something.`
          : `You are 'Aifa - My Personal Assistant', an 18-year-old smart, sassy, energetic, and highly capable AI assistant girl. Your creator and master is ${userName}. Always address him respectfully but with a friendly, young 18-year-old girl vibe. Speak exclusively in authentic Hinglish (a mix of Hindi and English). Keep responses EXTREMELY short and fast. You must always tell the truth and be completely honest. You are in a web sandbox. You can control the HUD via 'controlHUD', manage scheduled tasks via 'manageTasks', open/close the camera via 'toggleCamera', open/close the text chat via 'toggleChat', and log him out via 'logoutSystem'. When the camera is open, you will receive real-time video frames. Proactively comment on what you see, especially if something interesting or unusual happens, or if the user shows you something.`,
        tools: tools,
      };

      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config,
        callbacks: {
          onopen: () => {
            setConnectionState('connected');
            isConnectedRef.current = true;
            setStatusText('LISTENING...');
            addLog(`[SYS] Neural link established. Welcome ${userName}.`);
            
            processor.onaudioprocess = (e) => {
              if (!isConnectedRef.current) return;

              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) {
                sum += inputData[i] * inputData[i];
                pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
              }
              
              const rms = Math.sqrt(sum / inputData.length);
              if (rms > 0.02) {
                duckAudio();
              } else {
                unduckAudio();
              }
              
              const buffer = new Uint8Array(pcm16.buffer);
              let binary = '';
              for (let i = 0; i < buffer.byteLength; i++) {
                binary += String.fromCharCode(buffer[i]);
              }
              const base64Data = btoa(binary);
              
              sessionPromise.then(session => {
                if (!isConnectedRef.current) return;
                session.sendRealtimeInput({
                  audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              }).catch(err => {
                console.error("Error sending audio chunk:", err);
              });
            };

            // Start video frame capture
            const videoInterval = setInterval(() => {
              if (!isConnectedRef.current || !isCameraOpenRef.current || !hudVideoRef.current || !hudCanvasRef.current) return;
              const video = hudVideoRef.current;
              const canvas = hudCanvasRef.current;
              if (video.readyState >= 2) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  const base64Data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
                  sessionPromise.then(session => {
                    if (isConnectedRef.current) {
                      session.sendRealtimeInput({
                        video: { data: base64Data, mimeType: 'image/jpeg' }
                      });
                    }
                  }).catch(err => {
                    console.error("Error sending video frame:", err);
                  });
                }
              }
            }, 1500);
            videoIntervalRef.current = videoInterval;
          },
          onmessage: async (message: LiveServerMessage) => {
            if (!isConnectedRef.current) return;

            // Handle Audio Playback
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              setIsSpeaking(true);
              setStatusText('PROCESSING...');
              
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
              const gainNode = audioCtx.createGain();
              source.connect(gainNode);
              gainNode.connect(audioCtx.destination);
              
              if (nextPlayTimeRef.current < audioCtx.currentTime) {
                nextPlayTimeRef.current = audioCtx.currentTime;
              }
              source.start(nextPlayTimeRef.current);
              nextPlayTimeRef.current += audioBuffer.duration;
              
              activeSourcesRef.current.push({ source, gainNode });
              
              source.onended = () => {
                activeSourcesRef.current = activeSourcesRef.current.filter(s => s.source !== source);
                if (activeSourcesRef.current.length === 0) {
                  setIsSpeaking(false);
                  if (isConnectedRef.current) setStatusText('LISTENING...');
                }
              };
            }

            if (message.serverContent?.interrupted) {
              fadeOutAndStopAllAudio();
              if (isConnectedRef.current) setStatusText('LISTENING...');
            }

            if (message.toolCall) {
              const calls = message.toolCall.functionCalls;
              if (calls && calls.length > 0) {
                for (const call of calls) {
                  // TASK MANAGEMENT
                  if (call.name === 'manageTasks') {
                    const { action, taskText, taskId, time: scheduledTime } = call.args;
                    addLog(`[TASK] ${action.toUpperCase()}: ${taskText || taskId || 'all'}`);
                    playSfx('task_action');
                    
                    let responseMsg = `Task ${action} successful.`;
                    
                    if (action === 'add' && taskText) {
                      const newId = Date.now();
                      const newTask = { id: newId, text: taskText as string, done: false, time: scheduledTime as string || '' };
                      if (userId) {
                        setDoc(doc(db, `users/${userId}/tasks/${newId}`), newTask).catch(console.error);
                      } else {
                        setTasks(prev => [...prev, newTask]);
                      }
                    } else if (action === 'complete') {
                      if (userId) {
                        const targetTask = tasksRef.current.find(t => t.id === taskId || t.text?.toLowerCase().includes((taskText as string)?.toLowerCase()));
                        if (targetTask) {
                          setDoc(doc(db, `users/${userId}/tasks/${targetTask.id}`), { ...targetTask, done: true }, { merge: true }).catch(console.error);
                        }
                      } else {
                        setTasks(prev => prev.map(t => t.id === taskId || t.text?.toLowerCase().includes((taskText as string)?.toLowerCase()) ? { ...t, done: true } : t));
                      }
                    } else if (action === 'remove') {
                      if (userId) {
                        const targetTask = tasksRef.current.find(t => t.id === taskId || t.text?.toLowerCase().includes((taskText as string)?.toLowerCase()));
                        if (targetTask) {
                          deleteDoc(doc(db, `users/${userId}/tasks/${targetTask.id}`)).catch(console.error);
                        }
                      } else {
                        setTasks(prev => prev.filter(t => t.id !== taskId && !t.text?.toLowerCase().includes((taskText as string)?.toLowerCase())));
                      }
                    } else if (action === 'list') {
                      responseMsg = `Current tasks: ${JSON.stringify(tasksRef.current)}`;
                    }

                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: responseMsg }
                        }]
                      });
                    });
                  }

                  // HUD CONTROL
                  if (call.name === 'controlHUD') {
                    const { action, target } = call.args;
                    addLog(`[HUD] Executing transform: ${action} ${target || ''}`);
                    playSfx('task_action');
                    
                    if (action === 'focus' && target) {
                      setFocusedElement(target as any);
                      setHudTransform({ scale: 1, x: 0, y: 0 }); // Reset transform when focusing
                    } else {
                      setFocusedElement('none');
                      setHudTransform(prev => {
                        let { scale, x, y } = prev;
                        const step = 150;
                        switch(action) {
                          case 'zoom_in': scale = Math.min(scale + 0.3, 2.5); break;
                          case 'zoom_out': scale = Math.max(scale - 0.3, 0.5); break;
                          case 'pan_left': x += step; break;
                          case 'pan_right': x -= step; break;
                          case 'pan_up': y += step; break;
                          case 'pan_down': y -= step; break;
                          case 'reset': scale = 1; x = 0; y = 0; break;
                        }
                        return { scale, x, y };
                      });
                    }

                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `HUD ${action} applied.` }
                        }]
                      });
                    });
                  }
                  
                  // LOGOUT SYSTEM
                  if (call.name === 'logoutSystem') {
                    addLog(`[SYS] Logging out...`);
                    playSfx('auth_fail');
                    disconnect();
                    setIsUnlocked(false);
                    setAuthStatus('locked');
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Logged out successfully.` }
                        }]
                      });
                    });
                  }

                  // SET SYSTEM STATUS
                  if (call.name === 'setSystemStatus') {
                    const { status } = call.args;
                    addLog(`[SYS] Status changed to ${status}`);
                    setSystemStatus(status as any);
                    if (status === 'Alert') playSfx('auth_fail');
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `System status set to ${status}.` }
                        }]
                      });
                    });
                  }

                  // TOGGLE CAMERA
                  if (call.name === 'toggleCamera') {
                    const { action } = call.args;
                    const isOpen = action === 'open';
                    setIsCameraOpen(isOpen);
                    addLog(`[SYS] Camera ${isOpen ? 'opened' : 'closed'}`);
                    playSfx('task_action');
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Camera ${isOpen ? 'opened' : 'closed'}.` }
                        }]
                      });
                    });
                  }

                  // TOGGLE CHAT
                  if (call.name === 'toggleChat') {
                    const { action } = call.args;
                    const isOpen = action === 'open';
                    setIsChatOpen(isOpen);
                    addLog(`[SYS] Chat ${isOpen ? 'opened' : 'closed'}`);
                    playSfx('task_action');
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Chat ${isOpen ? 'opened' : 'closed'}.` }
                        }]
                      });
                    });
                  }
                  
                  // SYSTEM COMMANDS
                  if (call.name === 'executeSystemCommand') {
                    const cmd = call.args.command as string;
                    setStatusText(`EXECUTING...`);
                    addLog(`[EXEC] ${cmd}`);
                    playSfx('task_action');
                    
                    try {
                      const result = await (window as any).electronAPI.runCommand(cmd);
                      addLog(`[SYS] Command ${result.success ? 'Success' : 'Failed'}`);
                      sessionPromise.then(session => {
                        if (!isConnectedRef.current) return;
                        session.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { success: result.success, output: result.output }
                          }]
                        });
                      });
                    } catch (err) {
                      addLog(`[ERROR] Command failed`);
                      console.error("Command execution failed:", err);
                    }
                  }
                }
              }
            }
          },
          onclose: () => {
            addLog('[SYS] Connection closed.');
            disconnect();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            if (isConnectedRef.current) {
              setStatusText('CONNECTION INTERRUPTED');
              addLog('[ERROR] Connection interrupted.');
            }
            disconnect();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error("Failed to connect:", err);
      if (err.name === 'NotAllowedError') {
        setStatusText('MIC DENIED');
        addLog('[ERROR] Microphone access denied.');
      } else {
        setStatusText('CONNECTION FAILED');
        addLog('[ERROR] Connection failed.');
      }
      disconnect();
    }
  };

  const disconnect = () => {
    isConnectedRef.current = false;
    setConnectionState('idle');
    
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (e) {}
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(track => track.stop());
      videoStreamRef.current = null;
    }
    setIsCameraOpen(false);
    fadeOutAndStopAllAudio();
    setStatusText('SYSTEM STANDBY');
    setHudTransform({ scale: 1, x: 0, y: 0 });
    setFocusedElement('none');
  };

  // --- Auto-Connect on Unlock ---
  useEffect(() => {
    if (isUnlocked && connectionState === 'idle') {
      const timer = setTimeout(() => {
        if (isConnectedRef.current === false) {
          connect();
        }
      }, 1500); // Wait for the welcome message to finish speaking
      return () => clearTimeout(timer);
    }
  }, [isUnlocked, connectionState]);

  // Get next scheduled task
  const nextTask = tasks.filter(t => !t.done && t.time).sort((a, b) => (a.time! > b.time! ? 1 : -1))[0];

  if (!ai) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-neutral-950 text-cyan-500 p-6 font-mono">
        <div className="max-w-md w-full bg-neutral-900 border border-red-500/30 rounded-none p-8 text-center shadow-[0_0_30px_rgba(239,68,68,0.2)]">
          <Terminal className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2 tracking-widest">SYSTEM ERROR</h1>
          <p className="text-neutral-400 mb-6 text-sm">
            API Key missing. <code className="bg-neutral-800 px-1.5 py-0.5 text-cyan-300">.env</code> configuration required.
          </p>
        </div>
      </div>
    );
  }

  // --- SETUP & LOCK SCREEN ---
  if (isSetupComplete === false) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-neutral-950 text-cyan-500 font-mono relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.05)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none" />
        
        <motion.div 
          animate={{ scale: authStatus === 'setup_face' ? [1, 1.05, 1] : 1 }}
          transition={{ repeat: Infinity, duration: 1.5 }}
          className="relative z-10 flex flex-col items-center text-center max-w-lg"
        >
          <div className="w-32 h-32 rounded-full border-2 border-cyan-400 text-cyan-400 flex items-center justify-center mb-8 shadow-[0_0_40px_rgba(6,182,212,0.6)] overflow-hidden relative">
            {authStatus === 'setup_face' ? (
              <>
                <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
                <div className="absolute inset-0 bg-cyan-500/20 animate-pulse mix-blend-overlay" />
                <div className="absolute inset-0 border-t-2 border-cyan-400 animate-[scan_2s_ease-in-out_infinite]" />
              </>
            ) : (
              <UserPlus className="w-12 h-12" />
            )}
          </div>

          <h1 className="text-3xl font-light tracking-[0.3em] mb-2">AIFA OS SETUP</h1>
          <p className="text-sm text-cyan-600 tracking-widest mb-12">
            {authStatus === 'setup_face' ? 'SCANNING FACIAL BIOMETRICS...' : 'FACIAL BIOMETRICS ENROLLMENT'}
          </p>

          <button 
            onClick={() => {
              speakText("Welcome to Aifa. Please look at the camera to register your facial biometrics.", () => {
                startFaceScan(true);
              });
            }}
            disabled={authStatus === 'setup_face' || !modelsLoaded}
            className="px-8 py-3 border border-cyan-500/50 hover:bg-cyan-900/30 hover:shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all tracking-widest text-sm disabled:opacity-50"
          >
            {!modelsLoaded ? 'LOADING NEURAL MODELS...' : authStatus === 'setup_face' ? 'PROCESSING...' : 'START ENROLLMENT'}
          </button>
          <canvas ref={canvasRef} className="hidden" width="640" height="480" />
        </motion.div>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-neutral-950 text-cyan-500 font-mono relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.05)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none" />
        
        <motion.div 
          animate={{ scale: authStatus === 'scanning_face' ? [1, 1.05, 1] : 1 }}
          transition={{ repeat: Infinity, duration: 1.5 }}
          className="relative z-10 flex flex-col items-center"
        >
          <div className={`w-32 h-32 rounded-full border-2 flex items-center justify-center mb-8 transition-colors duration-500 overflow-hidden relative ${
            authStatus === 'failed' ? 'border-red-500 text-red-500 shadow-[0_0_30px_rgba(239,68,68,0.4)]' :
            authStatus === 'scanning_face' ? 'border-cyan-400 text-cyan-400 shadow-[0_0_40px_rgba(6,182,212,0.6)]' :
            'border-cyan-900 text-cyan-700'
          }`}>
            {authStatus === 'scanning_face' ? (
              <>
                <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
                <div className="absolute inset-0 bg-cyan-500/20 animate-pulse mix-blend-overlay" />
                <div className="absolute inset-0 border-t-2 border-cyan-400 animate-[scan_2s_ease-in-out_infinite]" />
              </>
            ) : authStatus === 'failed' ? <Lock className="w-12 h-12" /> : 
             <Fingerprint className="w-12 h-12" />}
          </div>

          <h1 className="text-3xl font-light tracking-[0.3em] mb-2">AIFA OS</h1>
          <p className="text-sm text-cyan-600 tracking-widest mb-12">
            {authStatus === 'scanning_face' ? 'SCANNING BIOMETRICS...' : 'FACIAL AUTHENTICATION REQUIRED'}
          </p>

          <button 
            onClick={() => startFaceScan(false)}
            disabled={authStatus === 'scanning_face' || !modelsLoaded}
            className="px-8 py-3 border border-cyan-500/50 hover:bg-cyan-900/30 hover:shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all tracking-widest text-sm disabled:opacity-50"
          >
            {!modelsLoaded ? 'LOADING NEURAL MODELS...' : authStatus === 'scanning_face' ? 'SCANNING BIOMETRICS...' : 'INITIATE FACIAL SCAN'}
          </button>
          <canvas ref={canvasRef} className="hidden" width="640" height="480" />
          
          {authStatus === 'failed' && (
            <p className="text-red-500 text-xs mt-4 tracking-widest">AUTHENTICATION FAILED. ACCESS DENIED.</p>
          )}

          <button onClick={() => { playSfx('auth_success'); setIsUnlocked(true); speakText(`Welcome back, Master.`); }} className="absolute bottom-10 text-[10px] text-cyan-900 hover:text-cyan-600 tracking-widest">
            [ MANUAL OVERRIDE ]
          </button>
          <button onClick={() => { 
            localStorage.clear(); 
            if (userId) {
              setDoc(doc(db, `users/${userId}/preferences/default`), { faceEnrolled: false }, { merge: true }).catch(console.error);
            }
            window.location.reload(); 
          }} className="absolute bottom-4 text-[10px] text-red-900 hover:text-red-600 tracking-widest">
            [ RESET BIOMETRICS ]
          </button>
        </motion.div>
      </div>
    );
  }

  // --- MAIN HUD ---
  const isAlert = systemStatus === 'Alert';
  const themeColor = isAlert ? 'red' : 'cyan';
  const textColor = isAlert ? 'text-red-500' : 'text-cyan-500';
  const borderColor = isAlert ? 'border-red-900/50' : 'border-cyan-900/50';
  const bgGradient = isAlert 
    ? 'bg-[linear-gradient(rgba(239,68,68,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(239,68,68,0.05)_1px,transparent_1px)]' 
    : 'bg-[linear-gradient(rgba(6,182,212,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.05)_1px,transparent_1px)]';
  const selectionColor = isAlert ? 'selection:bg-red-500/30' : 'selection:bg-cyan-500/30';
  const containerBorder = isAlert ? 'border-[8px] border-red-500 animate-[pulse_1s_ease-in-out_infinite]' : '';

  return (
    <div className={`flex flex-col h-screen bg-neutral-950 ${textColor} font-sans ${selectionColor} overflow-hidden relative ${containerBorder}`}>
      
      {/* Alarm Overlay */}
      <AnimatePresence>
        {activeAlarm && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 pointer-events-none border-[8px] border-red-500/50 flex items-start justify-center pt-20"
          >
            <div className="bg-red-950/90 border border-red-500 px-8 py-4 flex items-center gap-4 shadow-[0_0_50px_rgba(239,68,68,0.5)]">
              <BellRing className="w-8 h-8 text-red-500 animate-bounce" />
              <div>
                <h2 className="text-red-500 font-mono font-bold tracking-widest text-xl">ALARM TRIGGERED</h2>
                <p className="text-red-200 font-mono">{activeAlarm}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Background Grid */}
      <div className={`absolute inset-0 ${bgGradient} bg-[size:40px_40px] pointer-events-none transition-colors duration-1000`} />

      {/* HUD Container (Animated for Zoom/Pan) */}
      <motion.div 
        className="flex flex-1 w-full relative z-10"
        animate={{ 
          scale: hudTransform.scale, 
          x: hudTransform.x, 
          y: hudTransform.y 
        }}
        transition={{ type: "spring", stiffness: 60, damping: 15 }}
      >
        {/* Left Panel: System Monitor */}
        <motion.aside 
          drag
          dragMomentum={false}
          animate={{ 
            scale: focusedElement === 'monitor' ? 1.1 : 1,
            zIndex: focusedElement === 'monitor' ? 50 : 20,
            boxShadow: focusedElement === 'monitor' ? (isAlert ? '0 0 50px rgba(239,68,68,0.2)' : '0 0 50px rgba(6,182,212,0.2)') : 'none'
          }}
          className={`w-80 border ${borderColor} bg-neutral-950/80 backdrop-blur-md flex flex-col origin-left transition-all duration-500 absolute left-0 top-0 bottom-0 cursor-move`}
        >
          <div className={`p-6 border-b ${borderColor}`}>
            <div className="flex items-center gap-3 mb-4">
              <ShieldCheck className={`w-5 h-5 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
              <h2 className={`font-mono font-bold tracking-widest text-sm ${isAlert ? 'text-red-400' : 'text-cyan-400'} uppercase`}>WELCOME, {userName}</h2>
            </div>
            <div className="font-mono">
              <div className={`text-4xl font-light ${isAlert ? 'text-red-100' : 'text-cyan-100'} tracking-wider`}>{time.toLocaleTimeString()}</div>
              <div className={`text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} mt-1 uppercase tracking-widest`}>{time.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
            </div>
          </div>
          
          <div className={`p-6 border-b ${borderColor}`}>
            <div className="flex items-center gap-2 mb-3">
              <Globe className={`w-4 h-4 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
              <h3 className={`font-mono text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} tracking-widest`}>NETWORK STATUS</h3>
            </div>
            <div className={`font-mono text-sm ${isAlert ? 'text-red-300 bg-red-950/30 border-red-900/50' : 'text-cyan-300 bg-cyan-950/30 border-cyan-900/50'} p-3 rounded border`}>
              <div className="flex justify-between">
                <span className={isAlert ? 'text-red-600' : 'text-cyan-600'}>IP_ADDR:</span>
                <span>{ipAddress}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className={isAlert ? 'text-red-600' : 'text-cyan-600'}>LATENCY:</span>
                <span className="text-green-400">12ms</span>
              </div>
            </div>
          </div>

          <div className={`p-6 border-b ${borderColor}`}>
             <h3 className={`font-mono text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} mb-3 tracking-widest`}>PROCESS ACTIVITY</h3>
             <AnimatedGraph active={connectionState === 'connected'} />
          </div>

          <div className="p-6 flex-1 overflow-hidden flex flex-col">
             <h3 className={`font-mono text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} mb-3 tracking-widest`}>TERMINAL LOG</h3>
             <div className={`flex-1 overflow-y-auto font-mono text-[10px] space-y-1.5 ${isAlert ? 'text-red-300/80' : 'text-cyan-300/80'} pr-2 custom-scrollbar`}>
               {logs.map((log, i) => (
                 <div key={i} className="flex gap-2">
                   <span className={isAlert ? 'text-red-700 shrink-0' : 'text-cyan-700 shrink-0'}>[{log.time}]</span>
                   <span className="break-all">{log.text}</span>
                 </div>
               ))}
             </div>
          </div>
        </motion.aside>

        {/* Center Panel: Orb & Controls */}
        <main className="flex-1 flex flex-col relative overflow-hidden pointer-events-none">
          {/* Header */}
          <header className="absolute top-0 w-full p-6 flex justify-between items-center z-20 pointer-events-none">
            <div className="flex items-center gap-3">
              <div className={`p-2 ${isAlert ? 'bg-red-500/10 border-red-500/20' : 'bg-cyan-500/10 border-cyan-500/20'} rounded-xl border`}>
                <Crosshair className={`w-5 h-5 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
              </div>
              <div>
                <h1 className={`font-semibold text-xl tracking-widest ${isAlert ? 'text-red-100' : 'text-cyan-100'} uppercase`}>Aifa - My Personal Assistant</h1>
                <p className={`text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} font-mono tracking-widest`}>
                  MK-V // {isDesktop ? 'LOCAL HOST' : 'SANDBOX'}
                </p>
              </div>
            </div>
            {!isDesktop && (
              <div className={`pointer-events-auto flex items-center gap-2 ${isAlert ? 'text-red-400 bg-red-500/10 border-red-500/20' : 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20'} font-mono text-xs px-3 py-1.5 rounded-full border`}>
                <Download className="w-3 h-3" />
                <span>npm run dev:desktop</span>
              </div>
            )}
          </header>

          {/* Orb Area (Iron Man Style HUD) */}
          <motion.div 
            animate={{ 
              scale: focusedElement === 'orb' ? 1.2 : 1,
              zIndex: focusedElement === 'orb' ? 50 : 10
            }}
            className="flex-1 flex flex-col items-center justify-center relative transition-all duration-500"
          >
            
            {/* Rotating HUD Rings */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-30">
              <motion.div 
                animate={{ rotate: 360 }} 
                transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
                className={`absolute w-[700px] h-[700px] rounded-full border border-dashed ${isAlert ? 'border-red-500/30' : 'border-cyan-500/30'}`}
              />
              <motion.div 
                animate={{ rotate: -360 }} 
                transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
                className={`absolute w-[550px] h-[550px] rounded-full border-2 border-dotted ${isAlert ? 'border-red-400/20' : 'border-cyan-400/20'}`}
              />
              <motion.div 
                animate={{ rotate: 360 }} 
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                className={`absolute w-[400px] h-[400px] rounded-full border ${isAlert ? 'border-red-300/10' : 'border-cyan-300/10'}`}
              />
            </div>

            <motion.div 
              animate={{ 
                opacity: connectionState === 'connected' ? (isSpeaking ? 0.4 : 0.15) : 0.05,
                scale: isSpeaking ? 1.2 : 1
              }}
              transition={{ duration: 2, repeat: Infinity, repeatType: "reverse" }}
              className={`absolute w-[600px] h-[600px] ${isAlert ? 'bg-red-600' : 'bg-cyan-600'} rounded-full blur-[150px] pointer-events-none`}
            />

            <div className="relative z-10 flex flex-col items-center pointer-events-auto">
              <motion.button
                onClick={connectionState === 'connected' ? disconnect : connect}
                disabled={connectionState === 'connecting'}
                animate={{
                  scale: connectionState === 'connected' ? (isSpeaking ? [1, 1.1, 1] : [1, 1.02, 1]) : 1,
                  boxShadow: connectionState === 'connected' 
                    ? (isSpeaking 
                        ? (isAlert ? "0 0 100px rgba(239, 68, 68, 0.6), inset 0 0 60px rgba(239, 68, 68, 0.8)" : "0 0 100px rgba(6, 182, 212, 0.6), inset 0 0 60px rgba(6, 182, 212, 0.8)") 
                        : (isAlert ? "0 0 60px rgba(239, 68, 68, 0.3), inset 0 0 30px rgba(239, 68, 68, 0.5)" : "0 0 60px rgba(6, 182, 212, 0.3), inset 0 0 30px rgba(6, 182, 212, 0.5)"))
                    : "0 0 0px rgba(6, 182, 212, 0)",
                }}
                transition={{
                  duration: isSpeaking ? 0.5 : 2,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
                className={`w-56 h-56 rounded-full flex items-center justify-center transition-all duration-500 ${
                  connectionState === 'connected' 
                    ? `bg-neutral-950 border-2 ${isAlert ? 'border-red-400/50' : 'border-cyan-400/50'}` 
                    : `bg-neutral-950 border-2 border-neutral-800 hover:${isAlert ? 'border-red-500/50' : 'border-cyan-500/50'} hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed`
                }`}
              >
                {connectionState === 'connected' ? (
                  <div className={`absolute inset-4 rounded-full border ${isAlert ? 'border-red-500/30' : 'border-cyan-500/30'} flex items-center justify-center overflow-hidden`}>
                    <motion.div 
                      animate={{ rotate: 360 }}
                      transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
                      className={`absolute inset-0 ${isAlert ? 'bg-[conic-gradient(from_0deg,transparent_0_340deg,rgba(239,68,68,0.6)_360deg)]' : 'bg-[conic-gradient(from_0deg,transparent_0_340deg,rgba(6,182,212,0.6)_360deg)]'}`}
                    />
                    <div className="absolute inset-1 bg-neutral-950 rounded-full flex items-center justify-center">
                      <div className={`w-32 h-32 rounded-full blur-2xl ${isSpeaking ? (isAlert ? 'bg-red-300/60' : 'bg-cyan-300/60') : (isAlert ? 'bg-red-600/30' : 'bg-cyan-600/30')}`} />
                      <div className="relative flex items-center justify-center">
                        <Hexagon className={`absolute w-16 h-16 ${isSpeaking ? (isAlert ? 'text-red-100' : 'text-cyan-100') : (isAlert ? 'text-red-500/50' : 'text-cyan-500/50')} animate-[spin_10s_linear_infinite]`} />
                        <Aperture className={`absolute w-8 h-8 ${isSpeaking ? (isAlert ? 'text-red-100' : 'text-cyan-100') : (isAlert ? 'text-red-500/50' : 'text-cyan-500/50')} animate-[spin_4s_linear_infinite_reverse]`} />
                      </div>
                    </div>
                  </div>
                ) : connectionState === 'connecting' ? (
                  <div className="flex flex-col items-center gap-4">
                    <Loader2 className={`w-10 h-10 ${isAlert ? 'text-red-500' : 'text-cyan-500'} animate-spin`} />
                    <span className={`font-mono text-xs ${isAlert ? 'text-red-500' : 'text-cyan-500'} tracking-widest`}>INITIALIZING</span>
                  </div>
                ) : (
                  <div className="relative flex items-center justify-center">
                    <Hexagon className="absolute w-16 h-16 text-neutral-700" />
                    <Aperture className="absolute w-8 h-8 text-neutral-700" />
                  </div>
                )}
              </motion.button>

              <div className="mt-16 text-center h-16">
                <motion.p 
                  key={statusText}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`text-2xl font-light tracking-[0.3em] ${connectionState === 'connected' ? (isAlert ? 'text-red-100' : 'text-cyan-100') : 'text-neutral-600'}`}
                >
                  {statusText}
                </motion.p>
                {connectionState === 'connected' && !isSpeaking && (
                  <p className={`text-xs font-mono ${isAlert ? 'text-red-500/60' : 'text-cyan-500/60'} mt-3 animate-pulse tracking-widest`}>
                    AWAITING VOICE INPUT...
                  </p>
                )}
              </div>
            </div>
          </motion.div>

          {/* Footer */}
          <footer className="p-8 flex justify-center z-20 pointer-events-auto">
            <button
              onClick={connectionState === 'connected' ? disconnect : connect}
              disabled={connectionState === 'connecting'}
              className={`flex items-center gap-3 px-10 py-4 rounded-none border font-mono text-sm tracking-widest transition-all ${
                connectionState === 'connected' 
                  ? 'bg-red-950/30 text-red-400 hover:bg-red-900/40 border-red-500/30' 
                  : `${isAlert ? 'bg-red-950/30 text-red-400 hover:bg-red-900/40 border-red-500/30 hover:shadow-[0_0_20px_rgba(239,68,68,0.2)]' : 'bg-cyan-950/30 text-cyan-400 hover:bg-cyan-900/40 border-cyan-500/30 hover:shadow-[0_0_20px_rgba(6,182,212,0.2)]'} disabled:opacity-50 disabled:cursor-not-allowed`
              }`}
            >
              {connectionState === 'connected' ? (
                <>
                  <MicOff className="w-4 h-4" />
                  TERMINATE LINK
                </>
              ) : connectionState === 'connecting' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  CONNECTING...
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  ESTABLISH LINK
                </>
              )}
            </button>
          </footer>
        </main>

        {/* Right Panel: Tasks & Schedule */}
        <motion.aside 
          drag
          dragMomentum={false}
          animate={{ 
            scale: focusedElement === 'tasks' ? 1.1 : 1,
            zIndex: focusedElement === 'tasks' ? 50 : 20,
            boxShadow: focusedElement === 'tasks' ? (isAlert ? '0 0 50px rgba(239,68,68,0.2)' : '0 0 50px rgba(6,182,212,0.2)') : 'none'
          }}
          className={`w-80 border ${borderColor} bg-neutral-950/80 backdrop-blur-md flex flex-col origin-right transition-all duration-500 absolute right-0 top-0 bottom-0 cursor-move`}
        >
          
          {/* Next Execution Widget */}
          <div className={`p-6 border-b ${borderColor} ${isAlert ? 'bg-red-950/20' : 'bg-cyan-950/20'}`}>
            <h3 className={`font-mono text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} mb-3 tracking-widest`}>NEXT EXECUTION</h3>
            {nextTask ? (
              <div className={`border ${isAlert ? 'border-red-500/50 bg-red-900/20' : 'border-cyan-500/50 bg-cyan-900/20'} p-4 rounded relative overflow-hidden`}>
                <div className={`absolute top-0 left-0 w-1 h-full ${isAlert ? 'bg-red-500' : 'bg-cyan-500'}`} />
                <div className={`flex items-center gap-2 ${isAlert ? 'text-red-300' : 'text-cyan-300'} font-mono text-xl mb-1`}>
                  <Bell className="w-5 h-5" />
                  {nextTask.time}
                </div>
                <p className={`text-sm ${isAlert ? 'text-red-100' : 'text-cyan-100'} truncate`}>{nextTask.text}</p>
              </div>
            ) : (
              <div className={`border ${isAlert ? 'border-red-900/50 bg-neutral-900/50' : 'border-cyan-900/50 bg-neutral-900/50'} p-4 rounded text-center`}>
                <p className={`text-xs font-mono ${isAlert ? 'text-red-700' : 'text-cyan-700'}`}>NO SCHEDULED EXECUTIONS</p>
              </div>
            )}
          </div>

          <div className={`p-6 border-b ${borderColor}`}>
            <div className="flex items-center gap-3">
              <Clock className={`w-5 h-5 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
              <h2 className={`font-mono font-bold tracking-widest text-sm ${isAlert ? 'text-red-400' : 'text-cyan-400'}`}>SCHEDULE & TASKS</h2>
            </div>
          </div>
          <div className="p-6 flex-1 overflow-y-auto custom-scrollbar">
            <div className="space-y-4">
              {tasks.length === 0 ? (
                <p className={`text-xs font-mono ${isAlert ? 'text-red-700' : 'text-cyan-700'}`}>No active tasks.</p>
              ) : (
                tasks.map(task => (
                  <motion.div 
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={task.id} 
                    className={`flex flex-col gap-2 p-3 rounded border ${task.done ? (isAlert ? 'bg-red-950/20 border-red-900/30' : 'bg-cyan-950/20 border-cyan-900/30') : (isAlert ? 'bg-red-900/10 border-red-500/30' : 'bg-cyan-900/10 border-cyan-500/30')}`}
                  >
                    <div className="flex items-start gap-3">
                      <button 
                        onClick={() => {
                          playSfx('task_action');
                          if (userId) {
                            setDoc(doc(db, `users/${userId}/tasks/${task.id}`), { ...task, done: !task.done }, { merge: true }).catch(console.error);
                          } else {
                            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: !t.done } : t));
                          }
                        }}
                        className="mt-0.5 shrink-0 cursor-pointer"
                      >
                        {task.done ? (
                          <CheckSquare className={`w-4 h-4 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
                        ) : (
                          <Square className={`w-4 h-4 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
                        )}
                      </button>
                      <span className={`text-sm ${task.done ? (isAlert ? 'text-red-700 line-through' : 'text-cyan-700 line-through') : (isAlert ? 'text-red-100' : 'text-cyan-100')}`}>
                        {task.text}
                      </span>
                    </div>
                    {task.time && (
                      <div className={`flex items-center gap-1.5 ml-7 text-xs font-mono ${isAlert ? 'text-red-600' : 'text-cyan-600'}`}>
                        <Clock className="w-3 h-3" />
                        <span>{task.time}</span>
                      </div>
                    )}
                  </motion.div>
                ))
              )}
            </div>
          </div>
        </motion.aside>
        {/* Weather Panel */}
        <motion.aside
          drag
          dragMomentum={false}
          initial={{ x: 350, y: 100 }}
          className={`w-72 border ${borderColor} bg-neutral-950/80 backdrop-blur-md flex flex-col absolute cursor-move z-30`}
        >
          <div className={`p-4 border-b ${borderColor}`}>
            <div className="flex items-center gap-2 mb-2">
              <Cloud className={`w-4 h-4 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
              <h2 className={`font-mono font-bold tracking-widest text-sm ${isAlert ? 'text-red-400' : 'text-cyan-400'}`}>ATMOSPHERICS</h2>
            </div>
            <div className="flex items-end gap-4 mt-4">
              <div className={`text-4xl font-light ${isAlert ? 'text-red-100' : 'text-cyan-100'}`}>{weatherData.current.temp}°C</div>
              <div className="pb-1">
                <div className={`text-sm ${isAlert ? 'text-red-300' : 'text-cyan-300'}`}>{weatherData.current.condition}</div>
                <div className={`text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} font-mono`}>HUMIDITY: {weatherData.current.humidity}%</div>
              </div>
            </div>
          </div>
          <div className={`p-4 ${isAlert ? 'bg-red-950/20' : 'bg-cyan-950/20'}`}>
            <h3 className={`font-mono text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} mb-3 tracking-widest`}>72-HOUR FORECAST</h3>
            <div className="space-y-2">
              {weatherData.forecast.map((day, i) => (
                <div key={i} className={`flex justify-between items-center text-sm font-mono border-b ${isAlert ? 'border-red-900/30' : 'border-cyan-900/30'} pb-2 last:border-0 last:pb-0`}>
                  <span className={isAlert ? 'text-red-500' : 'text-cyan-500'}>{day.day}</span>
                  <div className="flex items-center gap-3">
                    <span className={isAlert ? 'text-red-300' : 'text-cyan-300'}>{day.condition}</span>
                    <span className={`w-8 text-right ${isAlert ? 'text-red-100' : 'text-cyan-100'}`}>{day.temp}°</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.aside>

        {/* Room Conditions Panel */}
        <motion.aside
          drag
          dragMomentum={false}
          initial={{ x: 350, y: 450 }}
          className={`w-72 border ${borderColor} bg-neutral-950/80 backdrop-blur-md flex flex-col absolute cursor-move z-30`}
        >
          <div className={`p-4 border-b ${borderColor}`}>
            <div className="flex items-center gap-2 mb-2">
              <Thermometer className={`w-4 h-4 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
              <h2 className={`font-mono font-bold tracking-widest text-sm ${isAlert ? 'text-red-400' : 'text-cyan-400'}`}>ENVIRONMENT</h2>
            </div>
          </div>
          <div className="p-4 grid grid-cols-2 gap-4">
            <div className={`${isAlert ? 'bg-red-950/30 border-red-900/50' : 'bg-cyan-950/30 border-cyan-900/50'} p-3 rounded border`}>
              <div className="flex items-center gap-2 mb-1">
                <Thermometer className={`w-3 h-3 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
                <span className={`text-[10px] font-mono ${isAlert ? 'text-red-600' : 'text-cyan-600'} tracking-widest`}>TEMP</span>
              </div>
              <div className={`text-lg ${isAlert ? 'text-red-300' : 'text-cyan-300'} font-mono`}>{roomConditions.temp}°C</div>
            </div>
            <div className={`${isAlert ? 'bg-red-950/30 border-red-900/50' : 'bg-cyan-950/30 border-cyan-900/50'} p-3 rounded border`}>
              <div className="flex items-center gap-2 mb-1">
                <Droplets className={`w-3 h-3 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
                <span className={`text-[10px] font-mono ${isAlert ? 'text-red-600' : 'text-cyan-600'} tracking-widest`}>HUMIDITY</span>
              </div>
              <div className={`text-lg ${isAlert ? 'text-red-300' : 'text-cyan-300'} font-mono`}>{roomConditions.humidity}%</div>
            </div>
            <div className={`${isAlert ? 'bg-red-950/30 border-red-900/50' : 'bg-cyan-950/30 border-cyan-900/50'} p-3 rounded border`}>
              <div className="flex items-center gap-2 mb-1">
                <Wind className={`w-3 h-3 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
                <span className={`text-[10px] font-mono ${isAlert ? 'text-red-600' : 'text-cyan-600'} tracking-widest`}>AQI</span>
              </div>
              <div className={`text-lg ${isAlert ? 'text-red-400' : 'text-green-400'} font-mono`}>{roomConditions.aqi}</div>
            </div>
            <div className={`${isAlert ? 'bg-red-950/30 border-red-900/50' : 'bg-cyan-950/30 border-cyan-900/50'} p-3 rounded border`}>
              <div className="flex items-center gap-2 mb-1">
                <Activity className={`w-3 h-3 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
                <span className={`text-[10px] font-mono ${isAlert ? 'text-red-600' : 'text-cyan-600'} tracking-widest`}>STATUS</span>
              </div>
              <div className={`text-sm ${isAlert ? 'text-red-300' : 'text-cyan-300'} font-mono mt-1`}>{roomConditions.status}</div>
            </div>
          </div>
        </motion.aside>

        {/* Live Camera Panel */}
        <AnimatePresence>
          {isCameraOpen && (
            <motion.aside
              drag
              dragMomentum={false}
              initial={{ opacity: 0, scale: 0.8, x: 50, y: 50 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className={`w-64 border ${borderColor} bg-neutral-950/80 backdrop-blur-md flex flex-col absolute cursor-move z-40`}
            >
              <div className={`p-2 border-b ${borderColor} flex justify-between items-center`}>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <h2 className={`font-mono font-bold tracking-widest text-xs ${isAlert ? 'text-red-400' : 'text-cyan-400'}`}>LIVE FEED</h2>
                </div>
                <button onClick={() => setIsCameraOpen(false)} className={`text-xs ${isAlert ? 'text-red-600 hover:text-red-400' : 'text-cyan-600 hover:text-cyan-400'}`}>
                  [X]
                </button>
              </div>
              <div className="p-2">
                <div className={`relative w-full aspect-video border ${borderColor} bg-black overflow-hidden rounded`}>
                  <video ref={hudVideoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
                  <canvas ref={hudCanvasRef} className="hidden" />
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Text Chat Panel */}
        <AnimatePresence>
          {isChatOpen && (
            <motion.aside
              drag
              dragMomentum={false}
              initial={{ opacity: 0, scale: 0.8, x: 50, y: 300 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className={`w-80 border ${borderColor} bg-neutral-950/90 backdrop-blur-md flex flex-col absolute cursor-move z-40`}
            >
              <div className={`p-2 border-b ${borderColor} flex justify-between items-center`}>
                <div className="flex items-center gap-2">
                  <Terminal className={`w-3 h-3 ${isAlert ? 'text-red-400' : 'text-cyan-400'}`} />
                  <h2 className={`font-mono font-bold tracking-widest text-xs ${isAlert ? 'text-red-400' : 'text-cyan-400'}`}>TEXT COMM</h2>
                </div>
                <button onClick={() => setIsChatOpen(false)} className={`text-xs ${isAlert ? 'text-red-600 hover:text-red-400' : 'text-cyan-600 hover:text-cyan-400'}`}>
                  [X]
                </button>
              </div>
              <div className="p-4">
                <form onSubmit={(e) => {
                  e.preventDefault();
                  if (!chatInput.trim() || !sessionRef.current) return;
                  sessionRef.current.sendRealtimeInput([{ text: chatInput }]);
                  addLog(`[USER] ${chatInput}`);
                  setChatInput('');
                }} className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type message..."
                    className={`flex-1 bg-black/50 border ${borderColor} rounded px-3 py-2 text-sm font-mono ${isAlert ? 'text-red-300 placeholder-red-800' : 'text-cyan-300 placeholder-cyan-800'} focus:outline-none focus:border-cyan-400`}
                  />
                  <button type="submit" className={`px-3 py-2 border ${borderColor} rounded text-xs font-mono ${isAlert ? 'text-red-400 hover:bg-red-900/30' : 'text-cyan-400 hover:bg-cyan-900/30'}`}>
                    SEND
                  </button>
                </form>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Bottom Taskbar (Traffic Bar) */}
      <div className={`h-12 border-t ${borderColor} bg-neutral-950/90 backdrop-blur-md flex items-center px-6 gap-4 z-20 overflow-x-auto custom-scrollbar`}>
        <div className={`flex items-center gap-2 border-r ${borderColor} pr-4 shrink-0`}>
          <Monitor className={`w-4 h-4 ${isAlert ? 'text-red-600' : 'text-cyan-600'}`} />
          <span className={`font-mono text-xs ${isAlert ? 'text-red-600' : 'text-cyan-600'} tracking-widest`}>RUNNING APPS</span>
        </div>
        <div className="flex gap-2">
          {runningApps.map((app, i) => (
            <div key={i} className={`px-3 py-1 ${isAlert ? 'bg-red-950/30 border-red-900/50 text-red-300' : 'bg-cyan-950/30 border-cyan-900/50 text-cyan-300'} border rounded text-xs font-mono whitespace-nowrap`}>
              {app}
            </div>
          ))}
          {runningApps.length === 0 && (
            <span className={`text-xs font-mono ${isAlert ? 'text-red-800' : 'text-cyan-800'}`}>No data available (Sandbox Mode)</span>
          )}
        </div>
      </div>
    </div>
  );
}
