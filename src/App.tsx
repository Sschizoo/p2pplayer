import { useEffect, useRef, useState } from 'react';
import type { MediaConnection, DataConnection } from 'peerjs';
import type Peer from 'peerjs';
import './App.css';

interface SyncCommand {
  type: 'PLAY' | 'PAUSE' | 'SEEK' | 'HEARTBEAT';
  timestamp: number; // Current playback time
}

function App() {
  const [myId, setMyId] = useState<string>('');
  const [remoteId, setRemoteId] = useState<string>('');
  const [status, setStatus] = useState<string>('Initializing...');
  const [__, setIsHost] = useState<boolean>(false); // Keeping setter for potential use, but prefixing unused
  const isHostRef = useRef<boolean>(false);
  // removed logs state to prevent build failure

  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<Peer | null>(null);
  const dataConnRef = useRef<DataConnection | null>(null);
  const isRemoteOp = useRef<boolean>(false); // Flag to prevent infinite loops
  const heartbeatInterval = useRef<number | null>(null); // For Host to send heatbeats

  const addLog = (msg: string) => {
    // Keeping console.log for debugging, removed setLogs
    console.log(msg);
  };

  // Initialize PeerJS
  useEffect(() => {
    let peer: Peer | null = null;
    let cancelled = false;

    const initPeer = async () => {
      try {
        const { default: Peer } = await import('peerjs');
        if (cancelled) return;

        peer = new Peer();

        peer.on('open', (id) => {
          if (cancelled) return;
          setMyId(id);
          addLog('Ready. Share ID to connect.');
          setStatus('Ready. Share ID to connect.');
          addLog('My Peer ID: ' + id);
        });

        peer.on('connection', (conn) => {
          if (cancelled) return;
          // Host receives connection from Client
          dataConnRef.current = conn;
          setupDataConnection(conn);

          conn.on('open', () => {
            if (cancelled) return;
            setStatus(`Connected to ${conn.peer}`);
            if (videoRef.current) {
              try {
                // @ts-ignore
                const stream = videoRef.current.captureStream();
                addLog('Calling client with stream (HQ)...');
                // Force high bitrate directly here
                const call = peer!.call(conn.peer, stream, {
                  sdpTransform: (sdp: string) => {
                    let newSdp = sdp;
                    if (newSdp.indexOf('b=AS:') > -1) {
                      newSdp = newSdp.replace(/b=AS:\d+/g, 'b=AS:50000');
                    } else {
                      newSdp = newSdp.replace(/(m=video .+\r\n)/g, '$1b=AS:50000\r\n');
                    }
                    return newSdp;
                  }
                });
                setupCallEvents(call);
              } catch (e: any) {
                addLog('Error capturing stream: ' + e.message);
              }
            }
          });
        });

        peer.on('call', (call) => {
          if (cancelled) return;
          addLog('Receiving call from Host...');
          call.answer();
          setupRemoteCallEvents(call);
        });

        peer.on('error', (err) => {
          if (cancelled) return;
          addLog(`Peer error: ${err.type}`);
          setStatus(`Error: ${err.type}`);
        });

        peerRef.current = peer;
      } catch (err) {
        if (cancelled) return;
        addLog('Failed to load PeerJS library');
        setStatus('Failed to load PeerJS library');
      }
    };

    initPeer();

    return () => {
      cancelled = true;
      if (peer) peer.destroy();
    };
  }, []);

  const setupDataConnection = (conn: DataConnection) => {
    conn.on('data', (data: any) => {
      const command = data as SyncCommand;
      if (command.type !== 'HEARTBEAT') {
        addLog(`Received: ${command.type}`);
      }
      handleSyncCommand(command);
    });
    conn.on('open', () => {
      addLog(`DataConnection Open: ${conn.label}`);
      if (isHostRef.current) {
        startHeartbeat();
      }
    });
    conn.on('close', () => {
      addLog('Connection closed');
      stopHeartbeat();
    });
    conn.on('error', (err) => {
      addLog(`DataConn error: ${err}`);
      stopHeartbeat();
    });
  };

  const startHeartbeat = () => {
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    heartbeatInterval.current = window.setInterval(() => {
      if (videoRef.current && dataConnRef.current?.open) {
        dataConnRef.current.send({
          type: 'HEARTBEAT',
          timestamp: videoRef.current.currentTime
        } as SyncCommand);
      }
    }, 1000);
    addLog('Heartbeat started');
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
      addLog('Heartbeat stopped');
    }
  };

  const handleSyncCommand = (cmd: SyncCommand) => {
    const v = isHostRef.current ? videoRef.current : remoteVideoRef.current;
    if (!v) return;

    // HOST Logic: Execute command from Client (ignoring HEARTBEAT from client if any)
    if (isHostRef.current) {
      if (cmd.type === 'HEARTBEAT') return; // Host ignores client heartbeats

      isRemoteOp.current = true;
      addLog(`Exec: ${cmd.type}`);

      switch (cmd.type) {
        case 'PLAY':
          v.play().catch(console.error);
          break;
        case 'PAUSE':
          v.pause();
          break;
        case 'SEEK':
          if (Math.abs(v.currentTime - cmd.timestamp) > 0.5) {
            v.currentTime = cmd.timestamp;
          }
          break;
      }
      setTimeout(() => { isRemoteOp.current = false; }, 300);
    }
    // CLIENT Logic: Execute command from Host (including HEARTBEAT for sync)
    else {
      // NOTE: Client usually sees video via Stream, so Play/Pause/Seek might be handled by stream flow.
      // But for drift correction, we check HEARTBEAT.
      if (cmd.type === 'HEARTBEAT') {
        const drift = Math.abs(v.currentTime - cmd.timestamp);
        // Debug log for drift > 0.5s
        if (drift > 0.5) addLog(`Drift: ${drift.toFixed(2)}s`);

        if (drift > 1) { // Threshold lowered to 1 second
          addLog(`Syncing drift: ${drift.toFixed(2)}s`);
          v.currentTime = cmd.timestamp;
        }
      }
      // Assuming other commands (PLAY/PAUSE) affect the stream directly via Host, 
      // but if we wanted UI update we could listen here.
    }
  };

  const sendCommand = (type: 'PLAY' | 'PAUSE' | 'SEEK', timestamp: number) => {
    // Only send command if we have an active connection and this action wasn't triggered by a remote event
    if (dataConnRef.current && dataConnRef.current.open && !isRemoteOp.current) {
      addLog(`Sending: ${type}`);
      dataConnRef.current.send({ type, timestamp } as SyncCommand);
    } else {
      if (!dataConnRef.current) addLog("Send Fail: No Conn");
      else if (!dataConnRef.current.open) addLog("Send Fail: Conn Closed");
      else if (isRemoteOp.current) addLog("Send Skip: RemoteOp");
    }
  };

  const onPlay = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    sendCommand('PLAY', e.currentTarget.currentTime);
  };

  const onPause = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    sendCommand('PAUSE', e.currentTarget.currentTime);
  };

  const onSeeked = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    sendCommand('SEEK', e.currentTarget.currentTime);
  };

  const setupCallEvents = (call: MediaConnection) => {
    call.on('close', () => addLog('Call closed'));
    call.on('error', (err) => addLog(`Call error: ${err}`));
  };

  const setupRemoteCallEvents = (call: MediaConnection) => {
    call.on('stream', (remoteStream) => {
      addLog('Received remote stream');
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
        remoteVideoRef.current.play().catch(e => addLog('Auto-play failed: ' + e.message));
      }
    });
  };

  // Helper to force high bitrate (SDP Munging)
  const getCallOptions = () => {
    return {
      sdpTransform: (sdp: string) => {
        // Force 50000kbps (50Mbps) - effectively "Unlimited" / Blu-ray quality
        // This removes the browser's aggressive default cap (often 2Mbps)
        let newSdp = sdp;
        if (newSdp.indexOf('b=AS:') > -1) {
          newSdp = newSdp.replace(/b=AS:\d+/g, 'b=AS:50000');
        } else {
          // Insert b=AS:50000 after the m=video line
          newSdp = newSdp.replace(/(m=video .+\r\n)/g, '$1b=AS:50000\r\n');
        }
        return newSdp;
      }
    };
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Enforce MP4
      if (file.type !== 'video/mp4' && !file.name.toLowerCase().endsWith('.mp4')) {
        alert('Format not supported. Please use MP4 video files.');
        addLog('Error: Non-MP4 file selected');
        setStatus('Error: Only MP4 is supported (Browser limit).');
        return;
      }

      if (videoRef.current) {
        const url = URL.createObjectURL(file);
        videoRef.current.src = url;
        setIsHost(true);
        isHostRef.current = true; // Update Ref

        // Wait for metadata to get resolution
        videoRef.current.onloadedmetadata = () => {
          const v = videoRef.current!;
          addLog(`Video loaded: ${v.videoWidth}x${v.videoHeight}`);
          setStatus(`Video loaded (${v.videoWidth}x${v.videoHeight}). Waiting for client...`);
        };

        // If already connected, call the peer now
        if (dataConnRef.current && dataConnRef.current.open && peerRef.current) {
          addLog('Late video load: Calling existing client (HQ)...');
          try {
            // @ts-ignore
            const stream = videoRef.current.captureStream();
            // @ts-ignore
            const call = peerRef.current.call(dataConnRef.current.peer, stream, getCallOptions());
            setupCallEvents(call);
            startHeartbeat();
          } catch (e: any) {
            addLog('Error capturing stream: ' + e.message);
          }
        }
      }
    }
  };

  const connectToHost = () => {
    if (!peerRef.current || !remoteId) return;
    addLog(`Connecting to ${remoteId}...`);
    setStatus(`Connecting to ${remoteId}...`);
    const conn = peerRef.current.connect(remoteId);

    conn.on('open', () => {
      addLog('Connected to Host. Waiting for stream...');
      setStatus('Connected to Host. Waiting for stream...');
      dataConnRef.current = conn;
      setupDataConnection(conn);
    });
  };

  const [view, setView] = useState<'LANDING' | 'HOST' | 'CLIENT'>('LANDING');

  const restartStream = () => {
    if (isHostRef.current && peerRef.current && dataConnRef.current && videoRef.current) {
      addLog('Restarting stream (HQ)...');
      try {
        // @ts-ignore
        const stream = videoRef.current.captureStream();
        const tracks = stream.getVideoTracks();
        addLog(`Captured stream: ${tracks.length} video tracks`);
        if (tracks.length > 0) {
          addLog(`Track 0: ${tracks[0].label} (${tracks[0].readyState})`);
        }

        // @ts-ignore
        const call = peerRef.current.call(dataConnRef.current.peer, stream, getCallOptions());
        setupCallEvents(call);
      } catch (e: any) {
        addLog('Error restarting: ' + e.message);
      }
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('ID Copied!');
  };

  if (view === 'LANDING') {
    return (
      <div className="container">
        <h1>P2P Sync Player</h1>

        <div className="status-badge">
          Status: {status} {myId ? `(ID: ${myId})` : ''}
        </div>

        <div className="landing-grid">
          <div className="role-card" onClick={() => { setView('HOST'); setIsHost(true); isHostRef.current = true; }}>
            <h2>🍿 Host a Party</h2>
            <p>Select a high-quality local video file and stream it to a friend. You control the playback.</p>
          </div>
          <div className="role-card" onClick={() => { setView('CLIENT'); setIsHost(false); isHostRef.current = false; }}>
            <h2>👀 Join a Stream</h2>
            <p>Connect to a Host using their ID. Sit back and enjoy the synchronized show.</p>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'HOST') {
    return (
      <div className="container">
        <h1>Hosting Party</h1>
        <div className="status-badge">
          My ID: <span className="id-display" onClick={() => copyToClipboard(myId)} title="Click to copy">{myId}</span>
          <span style={{ margin: '0 10px' }}>|</span>
          Status: {status}
        </div>

        <div className="video-wrapper">
          <video
            ref={videoRef}
            controls
            className="local-video"
            onPlay={onPlay}
            onPause={onPause}
            onSeeked={onSeeked}
          />
        </div>

        <div className="control-bar">
          <input type="file" accept="video/*" onChange={handleFileChange} />
          <button className="btn-secondary" onClick={() => restartStream()}>Fix Black Screen</button>
          <button className="btn-secondary" onClick={() => setView('LANDING')}>Exit</button>
        </div>
      </div>
    );
  }

  if (view === 'CLIENT') {
    return (
      <div className="container">
        <h1>Watching Stream</h1>
        <div className="status-badge">
          My ID: <span className="id-display">{myId}</span>
          <span style={{ margin: '0 10px' }}>|</span>
          Status: {status}
        </div>

        <div className="control-bar">
          <input
            type="text"
            placeholder="Enter Host ID"
            value={remoteId}
            onChange={(e) => setRemoteId(e.target.value)}
          />
          <button className="btn-primary" onClick={connectToHost}>Connect</button>
          <button className="btn-secondary" onClick={() => setView('LANDING')}>Exit</button>
        </div>

        <div className="video-wrapper">
          <video
            ref={remoteVideoRef}
            className="remote-video"
            style={{ backgroundColor: '#000' }}
          />
        </div>

        <div className="control-bar">
          <button className="btn-primary" onClick={() => sendCommand('PLAY', 0)}>▶ Play</button>
          <button className="btn-primary" onClick={() => sendCommand('PAUSE', 0)}>⏸ Pause</button>
          <button className="btn-secondary" onClick={() => {
            if (remoteVideoRef.current) {
              if (remoteVideoRef.current.requestFullscreen) {
                remoteVideoRef.current.requestFullscreen();
              } else {
                // @ts-ignore
                if (remoteVideoRef.current.webkitEnterFullscreen) {
                  // @ts-ignore
                  remoteVideoRef.current.webkitEnterFullscreen();
                }
              }
            }
          }}>⛶ Fullscreen</button>
        </div>
      </div>
    );
  }

  return <div>Loading...</div>; // Fallback
}

export default App;
