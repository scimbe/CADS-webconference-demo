// Injected into every E2E page before the app loads: page.addInitScript(probe, opts),
// opts = { tone: <Hz>, blockIce: <bool> }. Serialized by Playwright -- self-contained.
//
// 1. Synthetic camera/microphone: getUserMedia returns a canvas stream that
//    cycles through a known colour palette (every switch is timestamped in
//    window.__e2e.sent) plus a pure sine tone -- so the receiving side can
//    check that what arrives is THIS peer's media, and measure its latency.
// 2. ICE blocking (blockIce): every remote candidate -- trickled or inside the
//    SDP -- is rewritten to 192.0.2.1 (TEST-NET-1, never routed); the harness's
//    ice-config points STUN/TURN at the same address. Connectivity checks go
//    nowhere: ICE sits in 'checking' and no candidate pair is ever nominated,
//    the picture a UDP-blocking firewall or a symmetric NAT without a reachable
//    TURN relay gives.
// 3. Probes: ICE/connection state transitions with timestamps.
export function probe(opts) {
  const PALETTE = [[230, 30, 30], [30, 200, 40], [30, 60, 230], [240, 220, 20], [220, 30, 220], [20, 220, 220]];
  const SWITCH_MS = 800;
  const e2e = { sent: [], ice: [], conn: [], t0: Date.now(), palette: PALETTE, switchMs: SWITCH_MS };
  window.__e2e = e2e;

  async function synthetic() {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    let idx = 0;
    const paint = () => {
      const [r, gg, b] = PALETTE[idx % PALETTE.length];
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(0, 0, c.width, c.height);
    };
    paint();
    e2e.sent.push({ idx: 0, t: Date.now() });
    setInterval(() => { idx++; paint(); e2e.sent.push({ idx: idx % PALETTE.length, t: Date.now() }); }, SWITCH_MS);
    setInterval(paint, 33); // keep frames flowing between colour switches
    const stream = c.captureStream(30);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = opts.tone;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    return stream;
  }
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = () => synthetic();
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'synthetic', label: 'synthetic' }];
  }

  const Native = window.RTCPeerConnection;
  const rewrite = (cand) => cand.replace(/^((?:a=)?candidate:\S+ \d+ \S+ \d+ )(\S+)( \d+)/, '$1192.0.2.1$3');
  function Wrapped(...args) {
    const pc = new Native(...args);
    e2e.pc = pc;
    pc.addEventListener('iceconnectionstatechange', () => e2e.ice.push({ s: pc.iceConnectionState, t: Date.now() }));
    pc.addEventListener('connectionstatechange', () => e2e.conn.push({ s: pc.connectionState, t: Date.now() }));
    if (opts.blockIce) {
      const add = pc.addIceCandidate.bind(pc);
      pc.addIceCandidate = (c) => (c && c.candidate ? add({ ...c, candidate: rewrite(c.candidate) }) : add(c));
      const setRemote = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = (d) => setRemote(d && d.sdp
        ? { type: d.type, sdp: d.sdp.split('\r\n').map((l) => (l.startsWith('a=candidate:') ? rewrite(l) : l)).join('\r\n') }
        : d);
    }
    return pc;
  }
  Wrapped.prototype = Native.prototype;
  window.RTCPeerConnection = Wrapped;

  // Receiver side: sample the remote <video> (colour) and its audio (dominant frequency).
  e2e.startSampling = () => {
    if (e2e.sampling) return;
    e2e.sampling = true;
    e2e.seen = [];
    e2e.peaks = [];
    const v = document.getElementById('remote-video');
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true });
    let last = -1;
    setInterval(() => {
      if (!v.videoWidth) return;
      g.drawImage(v, 0, 0, 16, 16);
      const d = g.getImageData(4, 4, 8, 8).data;
      let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4; r /= n; gg /= n; b /= n;
      let best = -1, bestD = 1e9;
      PALETTE.forEach(([pr, pg, pb], i) => { const dd = (pr - r) ** 2 + (pg - gg) ** 2 + (pb - b) ** 2; if (dd < bestD) { bestD = dd; best = i; } });
      if (bestD < 70 ** 2 && best !== last) { last = best; e2e.seen.push({ idx: best, t: Date.now() }); }
    }, 15);
    let ac = null, an = null, src = null, cap = null, capFor = null;
    setInterval(() => {
      // WebRTC: the remote MediaStream itself. Direct channel (MediaSource in
      // src): captureStream() of the element -- once per source, it mints new
      // tracks on every call.
      let s = v.srcObject;
      if (!s && v.currentSrc) {
        if (capFor !== v.currentSrc) { cap = v.captureStream(); capFor = v.currentSrc; }
        s = cap;
      }
      if (!s || !s.getAudioTracks().length) return;
      const id = s.getAudioTracks()[0].id;
      if (id !== src) {
        src = id;
        ac = ac || new AudioContext();
        an = ac.createAnalyser();
        an.fftSize = 4096;
        ac.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(an);
      }
      const f = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(f);
      let bi = 1;
      for (let i = 2; i < f.length; i++) if (f[i] > f[bi]) bi = i;
      if (f[bi] > -60) e2e.peaks.push({ hz: Math.round((bi * ac.sampleRate) / an.fftSize), db: Math.round(f[bi]), t: Date.now() });
    }, 250);
  };
}
