import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import { encodeWAV } from './wavEncoder';

// AudioWorklet processor script
const PCM_WORKLET_URL = '/pcm-processor.js';

const CALIBRATION_TIME = 5000; // ms
const QUIET_COUNTDOWN = 12; // seconds
const minRecordingTimeMs = 300; // Minimum time to allow stop after start (ms)

function App() {
  const [calibrating, setCalibrating] = useState(true);
  const [calibrationLevel, setCalibrationLevel] = useState(0);
  const [status, setStatus] = useState('Calibrating...');
  const [recording, setRecording] = useState(false);
  const [customRecording, setCustomRecording] = useState(false);
  const [audioContext, setAudioContext] = useState(null);
  const [mediaStream, setMediaStream] = useState(null);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [audioChunks, setAudioChunks] = useState([]);
  const calibrationRef = useRef([]);
  const thresholdRef = useRef(0);
  const doubleThresholdRef = useRef(0);
  const silenceStartRef = useRef(null);
  const quietResetStartRef = useRef(null); // For robust quiet countdown reset
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const [currentRms, setCurrentRms] = useState(0);
  const [logs, setLogs] = useState([]);
  const waveformRef = useRef(null);
  const recordingStartTimeRef = useRef(null);
  const recordingStartedAtRef = useRef(null);
  const [quietSeconds, setQuietSeconds] = useState(0);
  const [duration, setDuration] = useState(0);
  const durationIntervalRef = useRef(null);
  const [manualCalibration, setManualCalibration] = useState(null);
  const [showManualCalibration, setShowManualCalibration] = useState(false);
  const [micError, setMicError] = useState(null);
  const [audioInputs, setAudioInputs] = useState([]);
  const [selectedInput, setSelectedInput] = useState('default');
  const pcmBufferRef = useRef([]);
  const customRecordingStartRef = useRef(null);
  const customSampleRateRef = useRef(44100);
  const workletNodeRef = useRef(null);
  const customRecordingRef = useRef(false);
  const [quietRms, setQuietRms] = useState(4);
  const [showQuietRmsInput, setShowQuietRmsInput] = useState(false);
  const [startSoundHoldSec, setStartSoundHoldSec] = useState(0.25); // Default 0.25s required to start
  const [showStartHoldInput, setShowStartHoldInput] = useState(false);
  const startSoundStartRef = useRef(null); // For robust recording start

  function log(msg) {
    setLogs(lgs => [...lgs.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    // Also output to console
    // eslint-disable-next-line
    console.log(msg);
  }

  useEffect(() => {
    async function getInputs() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === 'audioinput');
        setAudioInputs(inputs);
        // Auto-select preferred mic if found
        const preferredLabel = 'Microphone AUX TC (USB Audio and HID) (0573:1573)';
        const preferred = inputs.find(d => d.label === preferredLabel);
        if (preferred) {
          setSelectedInput(preferred.deviceId);
        } else if (inputs.length > 0) {
          setSelectedInput(inputs[0].deviceId);
        }
      } catch (err) {
        log('Could not enumerate audio input devices: ' + err.message);
      }
    }
    getInputs();
  }, []);

  useEffect(() => {
    async function setup() {
      try {
        const constraints = { audio: { deviceId: selectedInput === 'default' ? undefined : { exact: selectedInput } } };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setMediaStream(stream);
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        setAudioContext(ctx);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyserRef.current = analyser;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        calibrate(analyser);
        setMicError(null);
      } catch (err) {
        setMicError('Microphone access denied or unavailable. Please check your permissions and try again.');
        log('Microphone setup error: ' + err.message);
      }
    }
    if (!micError) setup();
    // Cleanup on unmount
    return () => {
      if (audioContext) audioContext.close();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line
  }, [micError, selectedInput]);

  function calibrate(analyser) {
    if (micError) return;
    setStatus('Calibrating...');
    setCalibrating(true);
    calibrationRef.current = [];
    const start = Date.now();
    function collect() {
      const arr = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(arr);
      const rms = Math.sqrt(arr.reduce((acc, v) => acc + (v - 128) ** 2, 0) / arr.length);
      calibrationRef.current.push(rms);
      setCurrentRms(rms);
      drawWaveform(arr);
      if (Date.now() - start < CALIBRATION_TIME) {
        rafRef.current = requestAnimationFrame(collect);
      } else {
        const avg = calibrationRef.current.reduce((a, b) => a + b, 0) / calibrationRef.current.length;
        setCalibrationLevel(avg);
        if (manualCalibration !== null) {
          thresholdRef.current = manualCalibration;
        } else {
          thresholdRef.current = avg * 2.5;
        }
        doubleThresholdRef.current = thresholdRef.current * 2;
        setCalibrating(false);
        setStatus('Listening for audio...');
        log(`Calibration complete. Level: ${avg.toFixed(2)}, threshold: ${thresholdRef.current.toFixed(2)}, double: ${doubleThresholdRef.current.toFixed(2)}`);
        listen(analyser);
      }
    }
    collect();
  }

  function listen(analyser) {
    if (micError) return;
    function detect() {
      if (!audioContext || !mediaStream) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }
      const arr = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(arr);
      const rms = Math.sqrt(arr.reduce((acc, v) => acc + (v - 128) ** 2, 0) / arr.length);
      setCurrentRms(rms);
      // Only log RMS every 20th frame to avoid memory issues
      if (!window.rmsLogCount) window.rmsLogCount = 0;
      window.rmsLogCount++;
      if (window.rmsLogCount % 20 === 0) {
        log(`RMS update: ${rms}`);
      }
      drawWaveform(arr);
      const threshold = manualCalibration !== null ? manualCalibration : thresholdRef.current;
      const stopThreshold = quietRms;
      if (!customRecordingRef.current) {
        if (rms > threshold) {
          if (!startSoundStartRef.current) {
            startSoundStartRef.current = Date.now();
          }
          const held = (Date.now() - startSoundStartRef.current) / 1000;
          if (held >= startSoundHoldSec) { // Use configurable value
            log('Sound detected above threshold, starting custom recording');
            startCustomRecording();
            startSoundStartRef.current = null;
          }
        } else {
          startSoundStartRef.current = null;
        }
        // If RMS ever goes above 12, start immediately
        if (rms > 12) {
          log('Sound detected above 12, starting custom recording immediately');
          startCustomRecording();
          startSoundStartRef.current = null;
        }
      }
      if (customRecordingRef.current) {
        log(`[DEBUG] Using quietRms: ${quietRms}, current RMS: ${rms}`);
        // If RMS goes above double the threshold, immediately reset quiet countdown
        if (rms >= doubleThresholdRef.current) {
          silenceStartRef.current = null;
          setQuietSeconds(0);
          log('Loudness above double threshold, quiet countdown reset');
        } else if (rms < stopThreshold) {
          // Quiet: Start or continue countdown
          if (!silenceStartRef.current) {
            silenceStartRef.current = Date.now();
            setQuietSeconds(1);
          } else {
            const elapsed = Math.floor((Date.now() - silenceStartRef.current) / 1000) + 1;
            setQuietSeconds(elapsed);
            if (elapsed >= 20) {
              log('Quiet for 20s, stopping and saving/discarding (custom)');
              setQuietSeconds(0);
              stopCustomRecording();
              return;
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(detect);
    }
    rafRef.current = requestAnimationFrame(detect);
  }

  function drawWaveform(arr) {
    const canvas = waveformRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = (i / arr.length) * canvas.width;
      const y = ((arr[i] - 128) / 128) * (canvas.height / 2) + canvas.height / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#2d3a5a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function recalibrate() {
    if (audioContext && analyserRef.current) {
      setStatus('Calibrating...');
      setCalibrating(true);
      log('Manual recalibration started');
      calibrate(analyserRef.current);
    }
  }

  async function startCustomRecording() {
    if (customRecordingRef.current) {
      log('startCustomRecording called, but customRecordingRef.current is already true. Skipping.');
      return;
    }
    customRecordingRef.current = true;
    try {
      setCustomRecording(true); // <-- Ensure state is set for UI
      if (!audioContext) {
        log('No audioContext for custom recording!');
        customRecordingRef.current = false;
        setCustomRecording(false);
        return;
      }
      if (!mediaStream) {
        log('No mediaStream for custom recording!');
        customRecordingRef.current = false;
        setCustomRecording(false);
        return;
      }
      // Load AudioWorklet processor if not loaded
      if (!audioContext.audioWorklet.modules || !audioContext.audioWorklet.modules.includes(PCM_WORKLET_URL)) {
        await audioContext.audioWorklet.addModule(PCM_WORKLET_URL);
        log('AudioWorklet module loaded');
      }
      pcmBufferRef.current = [];
      customRecordingStartRef.current = Date.now();
      customSampleRateRef.current = audioContext.sampleRate;
      const source = audioContext.createMediaStreamSource(mediaStream);
      const workletNode = new window.AudioWorkletNode(audioContext, 'pcm-processor');
      workletNode.port.onmessage = e => {
        if (e.data && e.data.length) {
          pcmBufferRef.current.push(new Float32Array(e.data));
        }
      };
      source.connect(workletNode);
      workletNode.connect(audioContext.destination);
      workletNodeRef.current = workletNode;
      log('Custom PCM recording started (AudioWorklet)');
    } catch (err) {
      log('Failed to start AudioWorkletNode: ' + err.message);
      customRecordingRef.current = false;
      setCustomRecording(false);
    }
  }

  useEffect(() => {
    if (customRecording) {
      log(`[DEBUG] customRecording state true. quietSeconds: ${quietSeconds}, currentRms: ${currentRms}`);
    }
  }, [customRecording, quietSeconds, currentRms]);

  function stopCustomRecording() {
    setCustomRecording(false);
    customRecordingRef.current = false;
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const duration = (Date.now() - (customRecordingStartRef.current || 0)) / 1000;
    // Flatten PCM buffer
    const samples = flattenPCM(pcmBufferRef.current);
    log(`PCM recording stopped. Duration: ${duration.toFixed(2)}s, samples: ${samples.length}`);
    if (duration < 11) {
      log(`Recording discarded (too short: ${duration.toFixed(1)}s)`);
      setStatus('Recording too short, discarded. Resetting...');
      setTimeout(() => {
        if (!customRecordingRef.current) {
          setStatus('Calibrating...');
          calibrate(analyserRef.current);
        }
      }, 1200);
      return;
    }
    const wavBlob = encodeWAV(samples, customSampleRateRef.current);
    log(`WAV encoded. Blob size: ${wavBlob.size}`);
    const url = window.URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `shiur-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);
    setStatus('Saved! Resetting...');
    setTimeout(() => {
      if (!customRecordingRef.current) {
        setStatus('Calibrating...');
        calibrate(analyserRef.current);
      }
    }, 1200);
  }

  function flattenPCM(chunks) {
    if (!chunks.length) return new Float32Array();
    const total = chunks.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Float32Array(total);
    let offset = 0;
    for (const arr of chunks) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  function handleManualCalibrationChange(e) {
    const val = parseFloat(e.target.value);
    setManualCalibration(val);
    thresholdRef.current = val;
    doubleThresholdRef.current = val * 2;
    log(`Manual calibration set: start threshold ${val}, stop threshold ${val * 2}`);
  }

  function toggleManualCalibration() {
    setShowManualCalibration(s => !s);
  }

  return (
    <div style={{minHeight:'100vh',background:'linear-gradient(135deg,#e0e7ff 0%,#fffbe6 100%)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-start',padding:'0 0 48px 0'}}>
      <header style={{width:'100%',background:'#2d3a5a',padding:'32px 0 18px 0',marginBottom:24,boxShadow:'0 2px 8px #cfd8dc'}}>
        <h1 style={{textAlign:'center',color:'#fff',fontSize:'2.2rem',letterSpacing:1.5,fontWeight:800,margin:0}}>TORAS CHAIM SHIUR RECORDER- BEIS MEDRASH SERVER</h1>
      </header>
      <div style={{background:'#fff',borderRadius:18,boxShadow:'0 4px 24px #cfd8dc',padding:'32px 36px 28px 36px',width:'100%',maxWidth:480,display:'flex',flexDirection:'column',alignItems:'center'}}>
        {micError && (
          <div style={{color:'#b71c1c',background:'#ffeaea',padding:12,borderRadius:8,marginBottom:12,fontWeight:600}}>
            {micError}
          </div>
        )}
        {audioInputs.length > 0 && (
          <div style={{marginBottom:12, display:'flex', justifyContent:'center'}}>
            <label htmlFor="input-select" style={{marginRight:8,fontWeight:600}}>Microphone:</label>
            <select
              id="input-select"
              value={selectedInput}
              onChange={e => setSelectedInput(e.target.value)}
              style={{padding:'4px 8px',fontSize:'1rem',borderRadius:4}}
            >
              <option value="default">Default</option>
              {audioInputs.map(input => (
                <option key={input.deviceId} value={input.deviceId}>{input.label || `Mic ${input.deviceId}`}</option>
              ))}
            </select>
          </div>
        )}
        <div className="recorder-card">
          <h1>Shiurim Recorder</h1>
          <div className="status">{status}</div>
          <div className="levels">
            Calibration Level: {calibrationLevel.toFixed(2)} | Current RMS: {currentRms.toFixed(2)}
          </div>
          <button onClick={toggleManualCalibration} style={{margin:'0 0 8px 0',padding:'4px 12px',borderRadius:6,border:'none',background:'#e0e7ff',color:'#2d3a5a',fontWeight:600,cursor:'pointer',fontSize:'0.95rem',boxShadow:'0 1px 3px #dbeafe'}}>Manual Calibration</button>
          {showManualCalibration && (
            <div style={{marginBottom:8}}>
              <input type="range" min="0.1" max="10" step="0.01" value={manualCalibration ?? calibrationLevel * 2.5} onChange={handleManualCalibrationChange} style={{width:180,marginRight:12}} />
              <input type="number" min="0.1" max="10" step="0.01" value={manualCalibration ?? calibrationLevel * 2.5} onChange={handleManualCalibrationChange} style={{width:70}} />
              <span style={{marginLeft:8}}>Threshold</span>
            </div>
          )}
          <div style={{marginBottom:8}}>
            {!customRecording && (
              <span style={{color:'#1976d2',fontWeight:600}}>
                Listening for sound...
              </span>
            )}
          </div>
          <canvas ref={waveformRef} width={320} height={60} style={{background:'#f5f7fa',borderRadius:8,marginBottom:12}} />
          {customRecording && (
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',marginBottom:8}}>
              <div className={customRecording ? 'recording-indicator better' : 'recording-indicator'} style={{marginRight:12}} />
              <span style={{fontWeight:600,color:'#ff1744',fontSize:'1.25rem'}}>Recording {Math.floor((Date.now() - (customRecordingStartRef.current || 0)) / 1000)}s</span>
            </div>
          )}
          {customRecording && quietSeconds > 0 && (
            <div style={{color:'#b08968',fontWeight:600,fontSize:'1.1rem',marginBottom:8}}>
              Quiet for {quietSeconds}s
            </div>
          )}
          <button onClick={() => setShowQuietRmsInput(v => !v)} style={{margin:'8px 0 8px 0',padding:'6px 14px',borderRadius:6,border:'1px solid #b08968',background:'#f6f8fa',color:'#795548',fontWeight:600,cursor:'pointer',fontSize:'0.98rem'}}>Set Quiet RMS</button>
          {showQuietRmsInput && (
            <div style={{marginBottom:8}}>
              <input
                type="number"
                step="0.1"
                min="0"
                value={quietRms}
                onChange={e => setQuietRms(Number(e.target.value))}
                style={{width:80,padding:'4px 6px',marginRight:8,borderRadius:4,border:'1px solid #b08968'}}
              />
              <span style={{color:'#795548',fontWeight:500}}>Quiet RMS threshold</span>
            </div>
          )}
          <button onClick={() => setShowStartHoldInput(v => !v)} style={{margin:'8px 0 8px 0',padding:'6px 14px',borderRadius:6,border:'1px solid #1976d2',background:'#f0f7ff',color:'#1976d2',fontWeight:600,cursor:'pointer',fontSize:'0.98rem'}}>Set Start Sound Hold</button>
          {showStartHoldInput && (
            <div style={{marginBottom:8}}>
              <input
                type="number"
                step="0.1"
                min="0"
                value={startSoundHoldSec}
                onChange={e => setStartSoundHoldSec(Number(e.target.value))}
                style={{width:80,padding:'4px 6px',marginRight:8,borderRadius:4,border:'1px solid #1976d2'}}
              />
              <span style={{color:'#1976d2',fontWeight:500}}>Seconds required to start</span>
            </div>
          )}
          <button onClick={recalibrate} style={{margin:'12px 0 0 0',padding:'8px 18px',borderRadius:6,border:'none',background:'#e0e7ff',color:'#2d3a5a',fontWeight:600,cursor:'pointer',fontSize:'1rem',boxShadow:'0 1px 4px #dbeafe'}}>Recalibrate</button>
          <div style={{marginTop:24,textAlign:'left',fontSize:'0.88rem',maxHeight:90,overflowY:'auto',background:'#f6f8fa',borderRadius:8,padding:8,border:'1px solid #e0e0e0'}}>Logs:<br/>{logs.slice(-8).map((l,i) => <div key={i}>{l}</div>)}</div>
        </div>
      </div>
      <footer style={{marginTop:'auto',width:'100%',display:'flex',justifyContent:'center',alignItems:'center',padding:'32px 0 0 0'}}>
        <div style={{fontSize:'1.35rem',color:'#795548',fontWeight:700,letterSpacing:1.2,background:'rgba(255,255,255,0.8)',borderRadius:8,padding:'12px 36px',boxShadow:'0 2px 8px #e0e0e0'}}>
          &copy; DEVELOPED BY AB BRACHFELD
        </div>
      </footer>
    </div>
  );
}

export default App;
