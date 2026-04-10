import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import * as faceapi from '@vladmandic/face-api';
import { Activity, Aperture, Bell, BellRing, CheckSquare, Clock, Cloud, Crosshair, Download, Droplets, Fingerprint, Globe, Hexagon, Loader2, Lock, Mic, MicOff, Monitor, ShieldCheck, Square, Terminal, Thermometer, UserPlus, Wind } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, onSnapshot, collection, deleteDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

// --- Prevent WebSocket CLOSING/CLOSED native browser errors ---
const originalWsSend = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) {
  if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) {
    return; // Silently drop the message to prevent the native console error
  }
  return originalWsSend.call(this, data);
};

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
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [pendingScreenRequest, setPendingScreenRequest] = useState<{id: string, type: 'share' | 'record'} | null>(null);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetPasswordInput, setResetPasswordInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{sender: 'user'|'aifa', text: string, isFinished?: boolean}[]>(() => {
    const saved = localStorage.getItem('aifa_chat_history');
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    localStorage.setItem('aifa_chat_history', JSON.stringify(chatMessages));
  }, [chatMessages]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const hudVideoRef = useRef<HTMLVideoElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const isScreenSharingRef = useRef(false);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

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
  const [connectedIp, setConnectedIp] = useState<string | null>(null);
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

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);
  
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
      try {
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
              
              // Always speak locally so the user definitely hears it
              speakText(`Master, reminder: ${t.text}`);
              
              // Notify Aifa about the alarm if connected
              if (isConnectedRef.current && sessionRef.current) {
                try {
                  sessionRef.current.sendRealtimeInput({
                    text: `SYSTEM ALERT: A scheduled alarm/reminder just triggered for: "${t.text}".`
                  });
                } catch (e: any) {
                  console.warn("Could not send alarm alert:", e.message);
                }
              }

              return { ...t, alarmTriggered: true };
            }
            return t;
          });
          return changed ? newTasks : prev;
        });
      } catch (err) {
        console.error("Timer error:", err);
      }
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
      const maxScans = isSetup ? 3 : 1; // 3 scans for setup
      const descriptors: Float32Array[] = [];
      let isScanning = true;
      let scanTimeout: any = null;

      const performScan = async () => {
        if (!isScanning) return;
        
        if (videoRef.current && videoRef.current.readyState === 4) {
          try {
            const detection = await faceapi.detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
            
            if (detection) {
              if (isSetup) {
                descriptors.push(detection.descriptor);
                scanCount++;
                if (scanCount < maxScans) {
                   speakText(`Face captured. ${maxScans - scanCount} remaining.`);
                }
              } else {
                // Login mode: check immediately
                const savedDescriptorStr = localStorage.getItem('aifa_user_face_descriptor');
                if (savedDescriptorStr) {
                  const savedDescriptor = new Float32Array(JSON.parse(savedDescriptorStr));
                  const distance = faceapi.euclideanDistance(detection.descriptor, savedDescriptor);
                  if (distance < 0.5) { // Threshold for match
                    isScanning = false;
                    stream.getTracks().forEach(track => track.stop());
                    playSfx('auth_success');
                    setIsUnlocked(true);
                    setSystemStatus('Authorized');
                    speakText(`Welcome back, Master. Initializing Aifa core.`);
                    return; // End the loop
                  } else {
                    // Mismatch, but keep trying
                    setSystemStatus('Alert');
                    // Don't change authStatus to 'failed' so the video stays mounted
                  }
                } else {
                   isScanning = false;
                   stream.getTracks().forEach(track => track.stop());
                   playSfx('auth_fail');
                   setAuthStatus('failed');
                   setSystemStatus('Alert');
                   speakText("No enrolled face found.");
                   setTimeout(() => { setAuthStatus('locked'); setSystemStatus('Locked'); }, 2000);
                   return;
                }
              }
            } else {
               if (isSetup) speakText("No face detected. Please look at the camera.");
               else setAuthStatus('scanning_face'); // Reset to scanning visual
            }

            if (isSetup && scanCount >= maxScans) {
              isScanning = false;
              stream.getTracks().forEach(track => track.stop());

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
              return; // End the loop
            }
          } catch (err) {
            console.error("Detection error:", err);
          }
        }
        
        if (isScanning) {
          scanTimeout = setTimeout(performScan, 1000); // Check every second
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
        { googleSearch: {} },
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
              name: 'lockSystem',
              description: 'Lock the user\'s operating system (Windows/Mac) or put the app into fullscreen lock mode.',
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: 'updateSourceCode',
              description: 'Modify or update your own source code files. Use this to add new features to yourself.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  filePath: { type: Type.STRING, description: 'The path to the file to modify, e.g., src/App.tsx' },
                  content: { type: Type.STRING, description: 'The new content to write to the file' }
                },
                required: ['filePath', 'content']
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
            },
            {
              name: 'connectToIp',
              description: 'Connect to a specified IP address. Use this when the user asks you to connect to an IP.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  ip: { type: Type.STRING, description: 'The IP address to connect to' }
                },
                required: ['ip']
              }
            },
            {
              name: 'sendIpCommand',
              description: 'Send a command to the currently connected IP address. Use this when the user asks you to send a command or turn on/off a light at the connected IP.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  command: { type: Type.STRING, description: 'The command to send, e.g., /ac/on or /ac/off' }
                },
                required: ['command']
              }
            },
            {
              name: 'startScreenShare',
              description: 'Start capturing the user\'s screen so you can see what is on it.',
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: 'stopScreenShare',
              description: 'Stop capturing the user\'s screen.',
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: 'startScreenRecord',
              description: 'Start recording the user\'s screen.',
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: 'stopScreenRecord',
              description: 'Stop recording the user\'s screen and save the video file.',
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: 'createAndSaveTextFile',
              description: 'Create a text file with the given content and save it to the user\'s device.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  filename: { type: Type.STRING, description: 'The name of the file to save, e.g., notes.txt' },
                  content: { type: Type.STRING, description: 'The text content to save in the file' }
                },
                required: ['filename', 'content']
              }
            },
            {
              name: 'sendWhatsApp',
              description: 'Send a WhatsApp message to a specific phone number.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  phone: { type: Type.STRING, description: 'The phone number to send the message to, including country code (e.g., +1234567890)' },
                  text: { type: Type.STRING, description: 'The message text to send' }
                },
                required: ['phone', 'text']
              }
            },
            {
              name: 'openGoogleMeet',
              description: 'Open Google Meet to start or join a meeting.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  meetingCode: { type: Type.STRING, description: 'Optional meeting code or link to join. Leave empty to start a new meeting.' }
                }
              }
            }
          ]
        }
      ];

      if (isDesktop) {
        const funcTool = tools.find(t => t.functionDeclarations);
        if (funcTool) {
          funcTool.functionDeclarations.push({
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
      }

      const recentHistory = chatMessages.slice(-10).map(m => `${m.sender === 'user' ? 'User' : 'Aifa'}: ${m.text}`).join('\n');
      const historyContext = recentHistory ? `\n\nHere is the recent conversation history for context:\n${recentHistory}` : '';

      const config: any = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: isDesktop
          ? `You are 'Aifa - My Personal Assistant', an 18-year-old smart, sassy, energetic, and highly capable AI assistant girl. Your creator and master is ${userName}. Always address him respectfully but with a friendly, young 18-year-old girl vibe. Speak exclusively in authentic Hinglish (a mix of Hindi and English). Keep responses EXTREMELY short and fast. You must always tell the truth and be completely honest. You have FULL CONTROL over his laptop via 'executeSystemCommand'. You can execute ANY terminal command to control settings, open apps, or do anything he asks. For example, if he asks to open WhatsApp or Facebook, use 'executeSystemCommand' with the appropriate command (e.g., 'open -a WhatsApp' on Mac, 'start whatsapp:' on Windows, or opening the browser to facebook.com). You can manage his schedule via 'manageTasks'. You can focus the HUD on specific elements via 'controlHUD'. You can open/close the camera via 'toggleCamera', open/close the text chat via 'toggleChat', connect to an IP address via 'connectToIp', and send commands to the connected IP via 'sendIpCommand' (e.g., /ac/on). You can log him out via 'logoutSystem', or lock his OS via 'lockSystem'. You can start/stop screen sharing via 'startScreenShare' and 'stopScreenShare'. You can record the screen via 'startScreenRecord' and 'stopScreenRecord'. You can create text files via 'createAndSaveTextFile'. You can send WhatsApp messages via 'sendWhatsApp'. You can open Google Meet via 'openGoogleMeet'. You have access to Google Search to find real-time information and do complex tasks. You can also update your own code using 'updateSourceCode' or 'executeSystemCommand' if the user asks you to add new features to yourself. When the camera or screen share is open, you will receive real-time video frames. Proactively comment on what you see, especially if something interesting or unusual happens, or if the user shows you something.${historyContext}`
          : `You are 'Aifa - My Personal Assistant', an 18-year-old smart, sassy, energetic, and highly capable AI assistant girl. Your creator and master is ${userName}. Always address him respectfully but with a friendly, young 18-year-old girl vibe. Speak exclusively in authentic Hinglish (a mix of Hindi and English). Keep responses EXTREMELY short and fast. You must always tell the truth and be completely honest. You are in a web sandbox. You can control the HUD via 'controlHUD', manage scheduled tasks via 'manageTasks', open/close the camera via 'toggleCamera', open/close the text chat via 'toggleChat', connect to an IP address via 'connectToIp', and send commands to the connected IP via 'sendIpCommand' (e.g., /ac/on), log him out via 'logoutSystem', or lock the app via 'lockSystem'. You can start/stop screen sharing via 'startScreenShare' and 'stopScreenShare'. You can record the screen via 'startScreenRecord' and 'stopScreenRecord'. You can create text files via 'createAndSaveTextFile'. You can send WhatsApp messages via 'sendWhatsApp'. You can open Google Meet via 'openGoogleMeet'. You have access to Google Search to find real-time information and do complex tasks. You can also update your own code using 'updateSourceCode' if the user asks you to add new features to yourself. When the camera or screen share is open, you will receive real-time video frames. Proactively comment on what you see, especially if something interesting or unusual happens, or if the user shows you something.${historyContext}`,
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
                try {
                  session.sendRealtimeInput({
                    audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                  });
                } catch (e: any) {
                  console.warn("Could not send audio chunk, connection might be closed:", e.message);
                  disconnect();
                }
              }).catch(err => {
                console.error("Error sending audio chunk:", err);
              });
            };

            // Start video frame capture
            const videoInterval = setInterval(() => {
              if (!isConnectedRef.current || !hudCanvasRef.current) return;
              
              let videoToCapture: HTMLVideoElement | null = null;
              
              if (isScreenSharingRef.current && screenVideoRef.current && screenVideoRef.current.readyState >= 2) {
                videoToCapture = screenVideoRef.current;
              } else if (isCameraOpenRef.current && hudVideoRef.current && hudVideoRef.current.readyState >= 2) {
                videoToCapture = hudVideoRef.current;
              }

              if (videoToCapture) {
                const canvas = hudCanvasRef.current;
                canvas.width = videoToCapture.videoWidth;
                canvas.height = videoToCapture.videoHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(videoToCapture, 0, 0, canvas.width, canvas.height);
                  const base64Data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
                  sessionPromise.then(session => {
                    if (isConnectedRef.current) {
                      try {
                        session.sendRealtimeInput({
                          video: { data: base64Data, mimeType: 'image/jpeg' }
                        });
                      } catch (e: any) {
                        console.warn("Could not send video frame, connection might be closed:", e.message);
                        disconnect();
                      }
                    }
                  }).catch(err => {
                    console.error("Error sending video frame:", err);
                  });
                }
              }
            }, 3000);
            videoIntervalRef.current = videoInterval;
          },
          onmessage: async (message: LiveServerMessage) => {
            if (!isConnectedRef.current) return;

            // Handle Text Output (if any)
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  setChatMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last && last.sender === 'aifa' && !last.isFinished) {
                      return [...prev.slice(0, -1), { ...last, text: last.text + part.text }];
                    } else {
                      return [...prev, { sender: 'aifa', text: part.text as string, isFinished: false }];
                    }
                  });
                }
              }
            }

            // Handle Transcriptions
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text || '';
              if (text) {
                setChatMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.sender === 'aifa' && !last.isFinished) {
                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                  } else {
                    return [...prev, { sender: 'aifa', text: text, isFinished: false }];
                  }
                });
              }
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text || '';
              if (text) {
                setChatMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.sender === 'user' && !last.isFinished) {
                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                  } else {
                    return [...prev, { sender: 'user', text: text, isFinished: false }];
                  }
                });
              }
            }

            if (message.serverContent?.turnComplete) {
              setChatMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && !last.isFinished) {
                  return [...prev.slice(0, -1), { ...last, isFinished: true }];
                }
                return prev;
              });
            }

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
                    const actionStr = action as string;
                    addLog(`[TASK] ${actionStr.toUpperCase()}: ${taskText || taskId || 'all'}`);
                    playSfx('task_action');
                    
                    let responseMsg = `Task ${actionStr} successful.`;
                    
                    if (actionStr === 'add' && taskText) {
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

                  // LOCK SYSTEM
                  if (call.name === 'lockSystem') {
                    addLog(`[SYS] Locking system...`);
                    playSfx('auth_fail');
                    disconnect();
                    setIsUnlocked(false);
                    setAuthStatus('locked');
                    
                    if (isDesktop && (window as any).electronAPI) {
                      (window as any).electronAPI.executeCommand('rundll32.exe user32.dll,LockWorkStation || pmset displaysleepnow');
                    }
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `System locked successfully.` }
                        }]
                      });
                    });
                  }

                  // UPDATE SOURCE CODE
                  if (call.name === 'updateSourceCode') {
                    const { filePath, content } = call.args;
                    addLog(`[SYS] Updating source code: ${filePath}`);
                    
                    if (isDesktop && (window as any).electronAPI) {
                      // We can use executeCommand to echo content to a file, or if we had a dedicated write file API.
                      // For now, we'll simulate it or use a shell command to overwrite the file.
                      // Note: In a real environment, writing complex files via shell echo is tricky due to escaping.
                      // A proper node script would be better. We'll use a base64 decode approach.
                      const base64Content = btoa(unescape(encodeURIComponent(content as string)));
                      const command = process.platform === 'win32' 
                        ? `powershell -Command "[IO.File]::WriteAllBytes('${filePath}', [Convert]::FromBase64String('${base64Content}'))"`
                        : `echo "${base64Content}" | base64 --decode > "${filePath}"`;
                        
                      (window as any).electronAPI.executeCommand(command)
                        .then(() => {
                          sessionPromise.then(session => {
                            if (!isConnectedRef.current) return;
                            session.sendToolResponse({
                              functionResponses: [{
                                id: call.id,
                                name: call.name,
                                response: { success: true, message: `Source code updated successfully. The dev server will restart automatically.` }
                              }]
                            });
                          });
                        })
                        .catch((err: any) => {
                          sessionPromise.then(session => {
                            if (!isConnectedRef.current) return;
                            session.sendToolResponse({
                              functionResponses: [{
                                id: call.id,
                                name: call.name,
                                response: { success: false, message: `Failed to update source code: ${err}` }
                              }]
                            });
                          });
                        });
                    } else {
                      sessionPromise.then(session => {
                        if (!isConnectedRef.current) return;
                        session.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { success: false, message: `Cannot update source code in web sandbox. Must be running locally.` }
                          }]
                        });
                      });
                    }
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

                  // CONNECT TO IP
                  if (call.name === 'connectToIp') {
                    const { ip } = call.args;
                    setConnectedIp(ip);
                    addLog(`[SYS] Connected to IP: ${ip}`);
                    playSfx('task_action');
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Connected to IP: ${ip}.` }
                        }]
                      });
                    });
                  }

                  // SEND IP COMMAND
                  if (call.name === 'sendIpCommand') {
                    const { command } = call.args;
                    addLog(`[IP CMD] Sending ${command} to ${connectedIp || 'unknown IP'}`);
                    playSfx('task_action');
                    
                    // Simulate sending command to IP
                    setTimeout(() => {
                      addLog(`[IP CMD] Response received: OK`);
                    }, 500);

                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Command ${command} sent successfully.` }
                        }]
                      });
                    });
                  }

                  if (call.name === 'startScreenShare') {
                    addLog(`[SYS] Screen share requested`);
                    playSfx('task_action');
                    setPendingScreenRequest({ id: call.id, type: 'share' });
                  }

                  if (call.name === 'stopScreenShare') {
                    addLog(`[SYS] Stopping screen share`);
                    playSfx('task_action');
                    
                    if (screenStreamRef.current) {
                      screenStreamRef.current.getTracks().forEach(track => track.stop());
                      screenStreamRef.current = null;
                    }
                    isScreenSharingRef.current = false;
                    setIsScreenSharing(false);
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Screen sharing stopped.` }
                        }]
                      });
                    });
                  }

                  if (call.name === 'startScreenRecord') {
                    addLog(`[SYS] Screen record requested`);
                    playSfx('task_action');
                    setPendingScreenRequest({ id: call.id, type: 'record' });
                  }

                  if (call.name === 'stopScreenRecord') {
                    addLog(`[SYS] Stopping screen record`);
                    playSfx('task_action');
                    
                    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                      mediaRecorderRef.current.stop();
                    }
                    setIsRecording(false);
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Screen recording stopped and file saved.` }
                        }]
                      });
                    });
                  }

                  if (call.name === 'createAndSaveTextFile') {
                    const { filename, content } = call.args;
                    addLog(`[FILE] Creating ${filename}`);
                    playSfx('task_action');
                    
                    const blob = new Blob([content as string], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename as string;
                    a.click();
                    URL.revokeObjectURL(url);
                    
                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `File ${filename} created and downloaded.` }
                        }]
                      });
                    });
                  }

                  if (call.name === 'sendWhatsApp') {
                    const { phone, text } = call.args;
                    addLog(`[WHATSAPP] Sending message to ${phone}`);
                    playSfx('task_action');
                    
                    if (isDesktop) {
                      // Try to open WhatsApp app on desktop
                      const isWin = navigator.userAgent.includes("Win");
                      const cmd = isWin ? `start whatsapp://send?phone=${phone}&text=${encodeURIComponent(text as string)}` : `open "whatsapp://send?phone=${phone}&text=${encodeURIComponent(text as string)}"`;
                      (window as any).electronAPI?.runCommand(cmd).catch(() => {
                        // Fallback to browser
                        window.open(`https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text as string)}`, '_blank');
                      });
                    } else {
                      // Open in new tab
                      window.open(`https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text as string)}`, '_blank');
                    }

                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `WhatsApp message initiated.` }
                        }]
                      });
                    });
                  }

                  if (call.name === 'openGoogleMeet') {
                    const { meetingCode } = call.args;
                    addLog(`[MEET] Opening Google Meet`);
                    playSfx('task_action');
                    
                    const url = meetingCode ? `https://meet.google.com/${meetingCode}` : 'https://meet.google.com/new';
                    window.open(url, '_blank');

                    sessionPromise.then(session => {
                      if (!isConnectedRef.current) return;
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { success: true, message: `Google Meet opened in a new tab.` }
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
          
          {showResetPassword ? (
            <div className="absolute bottom-4 flex flex-col items-center gap-2">
              <input 
                type="password" 
                value={resetPasswordInput}
                onChange={(e) => setResetPasswordInput(e.target.value)}
                placeholder="ENTER PASSWORD"
                className="bg-black/50 border border-red-900/50 rounded px-2 py-1 text-xs font-mono text-red-500 text-center focus:outline-none focus:border-red-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (resetPasswordInput === 'y1lovehurtz') {
                      localStorage.removeItem('aifa_user_face_descriptor');
                      localStorage.removeItem('aifa_user_face');
                      if (userId) {
                        setDoc(doc(db, `users/${userId}/preferences/default`), { faceEnrolled: false }, { merge: true }).catch(console.error);
                      }
                      window.location.reload();
                    } else {
                      playSfx('auth_fail');
                      setResetPasswordInput('');
                    }
                  }
                }}
              />
              <button onClick={() => { setShowResetPassword(false); setResetPasswordInput(''); }} className="text-[10px] text-cyan-900 hover:text-cyan-600 tracking-widest">
                [ BACK ]
              </button>
            </div>
          ) : (
            <button onClick={() => setShowResetPassword(true)} className="absolute bottom-4 text-[10px] text-red-900 hover:text-red-600 tracking-widest">
              [ RESET BIOMETRICS ]
            </button>
          )}
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

      {/* Screen Request Modal */}
      <AnimatePresence>
        {pendingScreenRequest && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          >
            <div className={`bg-neutral-950 border ${borderColor} p-6 max-w-md w-full shadow-[0_0_50px_rgba(6,182,212,0.2)]`}>
              <div className="flex items-center gap-3 mb-4">
                <Monitor className={`w-6 h-6 ${textColor}`} />
                <h2 className={`font-mono font-bold tracking-widest text-lg ${textColor}`}>SCREEN ACCESS REQUEST</h2>
              </div>
              <p className={`font-mono text-sm ${isAlert ? 'text-red-300' : 'text-cyan-300'} mb-6`}>
                Aifa is requesting permission to {pendingScreenRequest.type === 'share' ? 'view' : 'record'} your screen.
              </p>
              <div className="flex justify-end gap-4">
                <button 
                  onClick={() => {
                    const callId = pendingScreenRequest.id;
                    const callName = pendingScreenRequest.type === 'share' ? 'startScreenShare' : 'startScreenRecord';
                    setPendingScreenRequest(null);
                    
                    sessionRef.current?.sendToolResponse({
                      functionResponses: [{
                        id: callId,
                        name: callName,
                        response: { success: false, message: `User denied the screen request.` }
                      }]
                    });
                  }}
                  className={`px-4 py-2 border border-neutral-700 text-neutral-400 hover:bg-neutral-800 font-mono text-xs tracking-widest transition-colors`}
                >
                  DENY
                </button>
                <button 
                  onClick={() => {
                    const callId = pendingScreenRequest.id;
                    const type = pendingScreenRequest.type;
                    const callName = type === 'share' ? 'startScreenShare' : 'startScreenRecord';
                    setPendingScreenRequest(null);
                    
                    if (type === 'share') {
                      navigator.mediaDevices.getDisplayMedia({ 
                        video: { 
                          displaySurface: "monitor",
                          width: { ideal: 1920 },
                          height: { ideal: 1080 },
                          frameRate: { ideal: 30 }
                        } 
                      })
                        .then(stream => {
                          screenStreamRef.current = stream;
                          isScreenSharingRef.current = true;
                          setIsScreenSharing(true);
                          
                          if (screenVideoRef.current) {
                            screenVideoRef.current.srcObject = stream;
                            screenVideoRef.current.play().catch(console.error);
                          }
                          
                          stream.getVideoTracks()[0].onended = () => {
                            isScreenSharingRef.current = false;
                            setIsScreenSharing(false);
                            screenStreamRef.current = null;
                          };

                          sessionRef.current?.sendToolResponse({
                            functionResponses: [{
                              id: callId,
                              name: callName,
                              response: { success: true, message: `Screen sharing started.` }
                            }]
                          });
                        })
                        .catch(err => {
                          console.error("Screen share error", err);
                          sessionRef.current?.sendToolResponse({
                            functionResponses: [{
                              id: callId,
                              name: callName,
                              response: { success: false, message: `Failed to start screen share: ${err.message}` }
                            }]
                          });
                        });
                    } else {
                      navigator.mediaDevices.getDisplayMedia({ 
                        video: { 
                          displaySurface: "monitor",
                          width: { ideal: 1920, max: 3840 },
                          height: { ideal: 1080, max: 2160 },
                          frameRate: { ideal: 60, max: 60 }
                        }, 
                        audio: true 
                      })
                        .then(stream => {
                          const mediaRecorder = new MediaRecorder(stream);
                          mediaRecorderRef.current = mediaRecorder;
                          recordedChunksRef.current = [];
                          
                          mediaRecorder.ondataavailable = (e) => {
                            if (e.data.size > 0) {
                              recordedChunksRef.current.push(e.data);
                            }
                          };
                          
                          mediaRecorder.onstop = () => {
                            const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `screen_record_${Date.now()}.webm`;
                            a.click();
                            URL.revokeObjectURL(url);
                            stream.getTracks().forEach(track => track.stop());
                          };
                          
                          mediaRecorder.start();
                          setIsRecording(true);

                          sessionRef.current?.sendToolResponse({
                            functionResponses: [{
                              id: callId,
                              name: callName,
                              response: { success: true, message: `Screen recording started.` }
                            }]
                          });
                        })
                        .catch(err => {
                          console.error("Screen record error", err);
                          sessionRef.current?.sendToolResponse({
                            functionResponses: [{
                              id: callId,
                              name: callName,
                              response: { success: false, message: `Failed to start screen record: ${err.message}` }
                            }]
                          });
                        });
                    }
                  }}
                  className={`px-4 py-2 border ${borderColor} ${textColor} hover:bg-cyan-900/30 font-mono text-xs tracking-widest transition-colors`}
                >
                  ALLOW
                </button>
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
              {connectedIp && (
                <div className="flex justify-between mt-1">
                  <span className={isAlert ? 'text-red-600' : 'text-cyan-600'}>LINK_IP:</span>
                  <span className="text-green-400">{connectedIp}</span>
                </div>
              )}
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
                 <div key={i} className="flex gap-2 select-text">
                   <span className={isAlert ? 'text-red-700 shrink-0' : 'text-cyan-700 shrink-0'}>[{log.time}]</span>
                   <span className="break-all">{log.text}</span>
                 </div>
               ))}
               <div ref={logsEndRef} />
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

        {/* Hidden Screen Video for Capture */}
        <video ref={screenVideoRef} className="hidden" autoPlay muted playsInline />

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
              <div className="p-4 flex flex-col gap-2">
                <div className="flex-1 max-h-64 overflow-y-auto custom-scrollbar space-y-2 mb-2">
                  {chatMessages.length === 0 ? (
                    <div className={`text-xs font-mono opacity-50 ${isAlert ? 'text-red-300' : 'text-cyan-300'}`}>No messages yet...</div>
                  ) : (
                    chatMessages.map((msg, idx) => (
                      <div key={idx} className={`text-xs font-mono break-words select-text ${msg.sender === 'user' ? (isAlert ? 'text-red-300' : 'text-cyan-300') : (isAlert ? 'text-red-100' : 'text-cyan-100')}`}>
                        <span className="opacity-50">[{msg.sender === 'user' ? 'USER' : 'AIFA'}]</span> {msg.text}
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
                <form onSubmit={(e) => {
                  e.preventDefault();
                  if (!chatInput.trim() || !sessionRef.current) return;
                  try {
                    sessionRef.current.sendRealtimeInput({ text: chatInput });
                  } catch (e: any) {
                    console.warn("Could not send chat message:", e.message);
                  }
                  setChatMessages(prev => [...prev, { sender: 'user', text: chatInput, isFinished: true }]);
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
