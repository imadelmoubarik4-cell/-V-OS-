// Atlas AI voice: voice notes (record → transcribe → editable transcript) and
// live voice (WebRTC straight to the realtime voice service with a 60-second
// client secret minted by atlas-ai?action=voice-session).
//
// Nothing here stores a secret. The client secret is read from the
// voice-session response, used once for the SDP exchange and dropped. Every
// function call the voice model asks for is forwarded to
// atlas-ai?action=voice-tool with the user's own session, so live voice can
// only do what the signed-in person may already do. Proposals come back as
// approval cards; approving is always a tap, never speech.
//
// Public API (window.AtlasAIVoice):
//   supported()                         → { voiceNote: bool, liveVoice: bool }
//   createVoiceNote({ onLevel })        → { start(), stop() → {blob, mime, duration}, cancel(), elapsed() }
//   createLiveVoice({ request, sendOnExit, conversationId, onState, onTranscript,
//                     onProposal, onRecords, onTurnsSaved, onError, onConversation })
//                                       → { start({ takeover }), mute(bool), end(), exit(), state(), conversationId(), voiceSessionId() }
//
// Voice session contract (atlas-ai hardening): voice-session returns the Atlas
// voice_session_id; it is kept for the life of the call and sent with every
// voice-tool and voice-append. 409 voice_session_inactive stops all tool and
// transcript calls for that session (state 'inactive'); nothing is retried
// against it. voice-end is sent on End and on normal teardown (pagehide).
// The frontend never invents a session id.
//
// S91: while the call is connected the client sends voice-heartbeat every
// heartbeat_seconds (45 s) so the server's 2-minute lease stays alive; a page
// that dies without voice-end frees the slot within the lease. start({
// takeover: true }) is "Continue here": the server ends this person's other
// live voice session. The device that lost the call gets 409
// voice_session_replaced on its next heartbeat, tool call or append and stops
// with state 'replaced'.
(function (root) {
  'use strict';

  if (root.AtlasAIVoice) return;

  const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
  const NOTE_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  const MAX_NOTE_SECONDS = 600;
  const APPEND_BATCH = 10;
  const DEFAULT_HEARTBEAT_SECONDS = 45;

  function supported() {
    const media = Boolean(root.navigator?.mediaDevices?.getUserMedia);
    return {
      voiceNote: media && typeof root.MediaRecorder === 'function',
      liveVoice: media && typeof root.RTCPeerConnection === 'function'
    };
  }

  function pickMime() {
    const recorder = root.MediaRecorder;
    if (!recorder || typeof recorder.isTypeSupported !== 'function') return '';
    return NOTE_TYPES.find((type) => {
      try { return recorder.isTypeSupported(type); } catch { return false; }
    }) || '';
  }

  function requestId(prefix) {
    const random = root.crypto?.randomUUID ? root.crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}:${random}`.slice(0, 120);
  }

  // Level meter for the live waveform and the recording bar. Returns a
  // function giving 0..1, or null when Web Audio is unavailable.
  function levelMeter(stream) {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context || !stream) return null;
    try {
      const context = new Context();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const read = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Math.abs(data[index] - 128));
        return Math.min(1, peak / 64);
      };
      read.close = () => { try { context.close(); } catch { /* already closed */ } };
      return read;
    } catch {
      return null;
    }
  }

  function stopStream(stream) {
    try { stream?.getTracks?.().forEach((track) => track.stop()); } catch { /* already stopped */ }
  }

  // ---------- voice note ----------

  function createVoiceNote({ onLevel = null } = {}) {
    let stream = null;
    let recorder = null;
    let chunks = [];
    let startedAt = 0;
    let meter = null;
    let frame = 0;
    let mime = '';
    let finished = null;

    function loop() {
      if (!meter) return;
      onLevel?.(meter());
      frame = root.requestAnimationFrame(loop);
    }

    function cleanup() {
      if (frame) root.cancelAnimationFrame(frame);
      frame = 0;
      meter?.close?.();
      meter = null;
      stopStream(stream);
      stream = null;
    }

    async function start() {
      if (!supported().voiceNote) throw Object.assign(new Error('Voice notes are not supported in this browser.'), { code: 'unsupported' });
      stream = await root.navigator.mediaDevices.getUserMedia({ audio: true });
      mime = pickMime();
      recorder = mime ? new root.MediaRecorder(stream, { mimeType: mime }) : new root.MediaRecorder(stream);
      mime = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
      chunks = [];
      finished = new Promise((resolve) => {
        recorder.addEventListener('dataavailable', (event) => { if (event.data && event.data.size) chunks.push(event.data); });
        recorder.addEventListener('stop', () => resolve());
      });
      recorder.start(250);
      startedAt = Date.now();
      meter = onLevel ? levelMeter(stream) : null;
      if (meter) loop();
    }

    function elapsed() {
      return startedAt ? Math.min(MAX_NOTE_SECONDS, (Date.now() - startedAt) / 1000) : 0;
    }

    async function stop() {
      if (!recorder) return null;
      const duration = elapsed();
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      cleanup();
      const blob = new Blob(chunks, { type: mime });
      recorder = null;
      return { blob, mime, duration: Math.round(duration * 10) / 10 };
    }

    function cancel() {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* stopped */ }
      recorder = null;
      chunks = [];
      cleanup();
    }

    return { start, stop, cancel, elapsed, maxSeconds: MAX_NOTE_SECONDS };
  }

  // ---------- live voice ----------

  function createLiveVoice(options = {}) {
    const request = options.request;
    const emit = (name, ...args) => { try { options[name]?.(...args); } catch (error) { root.console?.error?.(error); } };
    let conversationId = options.conversationId || null;
    let sessionId = null;          // provider session id (only a fallback key)
    let voiceSessionId = null;     // Atlas voice session id from voice-session
    let inactive = false;          // 409 voice_session_inactive or voice_session_replaced seen
    let heartbeatTimer = 0;
    let heartbeatSeconds = DEFAULT_HEARTBEAT_SECONDS;
    let endSent = false;
    let pc = null;
    let channel = null;
    let micStream = null;
    let audio = null;
    let current = 'idle';
    let muted = false;
    let ended = false;
    const handledCalls = new Set();
    const pendingTurns = [];
    const transcripts = new Map();
    let flushTimer = 0;
    let expiresAt = null;
    let meters = { mic: null, remote: null };

    // The id sent with voice-tool, voice-append and voice-end.
    function sessionKey() {
      return voiceSessionId || sessionId || null;
    }

    function isInactive(error) {
      return error?.code === 'voice_session_inactive' || error?.code === 'voice_session_replaced';
    }

    // The server ended this session (idle or absolute expiry, ended
    // elsewhere, or taken over on another device): stop every tool and
    // transcript call and close the call.
    function markInactive(error = null) {
      if (inactive) return;
      inactive = true;
      pendingTurns.length = 0;
      root.clearTimeout(flushTimer);
      teardown();
      setState(error?.code === 'voice_session_replaced' ? 'replaced' : 'inactive');
    }

    // Keeps the server's idle lease alive while the call is connected. A
    // failed request is not fatal: the lease outlasts two heartbeats.
    async function heartbeat() {
      if (inactive || ended || !sessionKey()) return;
      try {
        await request('voice-heartbeat', { method: 'POST', body: { voice_session_id: sessionKey() } });
      } catch (error) {
        if (isInactive(error)) markInactive(error);
      }
    }

    function startHeartbeat() {
      root.clearInterval(heartbeatTimer);
      heartbeatTimer = root.setInterval(heartbeat, heartbeatSeconds * 1000);
    }

    function setState(next, detail = {}) {
      if (inactive && next !== 'inactive' && next !== 'replaced') return;
      if (ended && next !== 'ended' && next !== 'disconnected' && next !== 'error' && next !== 'inactive' && next !== 'replaced') return;
      current = next;
      emit('onState', next, detail);
    }

    function send(event) {
      if (!channel || channel.readyState !== 'open') return false;
      try { channel.send(JSON.stringify(event)); return true; } catch { return false; }
    }

    function queueTurn(role, text, key) {
      const value = String(text || '').trim();
      if (!value || !conversationId || inactive || !sessionKey()) return;
      pendingTurns.push({ role, text: value, client_request_id: `voice.${String(sessionKey()).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 60)}.${key}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120) });
      root.clearTimeout(flushTimer);
      flushTimer = root.setTimeout(() => flushTurns(), 400);
    }

    // Saves pending transcript turns. With `final`, the last batch carries
    // ended:true; returns whether the server recorded the end that way.
    async function flushTurns({ final = false } = {}) {
      root.clearTimeout(flushTimer);
      let endedByAppend = false;
      while (pendingTurns.length && conversationId && !inactive && sessionKey()) {
        const turns = pendingTurns.splice(0, APPEND_BATCH);
        const last = final && !pendingTurns.length;
        try {
          await request('voice-append', { method: 'POST', body: { conversation_id: conversationId, voice_session_id: sessionKey(), turns, ...(last ? { ended: true } : {}) } });
          emit('onTurnsSaved', turns);
          if (last) endedByAppend = true;
        } catch (error) {
          if (isInactive(error)) { markInactive(error); return false; }
          // Keep the turns for the next flush; the transcript is still on screen.
          pendingTurns.unshift(...turns);
          emit('onError', { code: error?.code || 'save_failed', recoverable: true, message: 'Part of the voice transcript could not be saved yet.' });
          return false;
        }
      }
      return endedByAppend;
    }

    async function sendEnd() {
      if (endSent || !sessionKey()) return;
      endSent = true;
      try {
        await request('voice-end', { method: 'POST', body: { voice_session_id: sessionKey() } });
      } catch {
        // Already ended or expired on the server: nothing else to do.
      }
    }

    async function runFunctionCall(item) {
      const callId = String(item.call_id || item.id || '');
      if (!callId || handledCalls.has(callId) || inactive || ended) return;
      handledCalls.add(callId);
      setState('thinking');
      let output;
      try {
        const result = await request('voice-tool', {
          method: 'POST',
          body: {
            conversation_id: conversationId,
            name: String(item.name || ''),
            arguments: item.arguments ?? '{}',
            call_id: callId,
            voice_session_id: sessionKey()
          }
        });
        output = typeof result?.output === 'string' ? result.output : 'Done.';
        const proposals = Array.isArray(result?.proposals) && result.proposals.length ? result.proposals : result?.proposal ? [result.proposal] : [];
        proposals.forEach((proposal) => emit('onProposal', proposal));
        if (Array.isArray(result?.records) && result.records.length) emit('onRecords', result.records, result.evidence || []);
      } catch (error) {
        if (isInactive(error)) { markInactive(error); return; }
        if (error?.code === 'rate_limited') emit('onError', { code: 'rate_limited', recoverable: true });
        output = error?.code === 'forbidden'
          ? 'That is not available for this person. Say so plainly.'
          : error?.code === 'rate_limited'
            ? 'Too many checks in a short time. Ask the person to wait a moment before the next request.'
            : 'That check is unavailable right now. Tell the person plainly and do not guess.';
      }
      if (ended || inactive) return;
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
      send({ type: 'response.create' });
    }

    function transcriptFor(key, role) {
      if (!transcripts.has(key)) transcripts.set(key, { role, text: '' });
      return transcripts.get(key);
    }

    function handleEvent(event) {
      if (!event || typeof event.type !== 'string') return;
      switch (event.type) {
        case 'session.created':
        case 'session.updated':
          if (!muted && current === 'connecting') setState('listening');
          break;
        case 'input_audio_buffer.speech_started':
          if (current === 'speaking' || current === 'thinking') {
            setState('interrupted');
            root.setTimeout(() => { if (current === 'interrupted') setState(muted ? 'muted' : 'listening'); }, 600);
          } else if (!muted) setState('listening');
          break;
        case 'input_audio_buffer.speech_stopped':
          if (!muted) setState('thinking');
          break;
        case 'conversation.item.input_audio_transcription.delta': {
          const entry = transcriptFor(`u:${event.item_id}`, 'user');
          entry.text += String(event.delta || '');
          emit('onTranscript', { id: event.item_id, role: 'user', text: entry.text, final: false });
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const entry = transcriptFor(`u:${event.item_id}`, 'user');
          entry.text = String(event.transcript ?? entry.text);
          emit('onTranscript', { id: event.item_id, role: 'user', text: entry.text, final: true });
          queueTurn('user', entry.text, `u.${event.item_id}`);
          break;
        }
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta': {
          const key = `a:${event.item_id || event.response_id}`;
          const entry = transcriptFor(key, 'assistant');
          entry.text += String(event.delta || '');
          if (current !== 'speaking' && !muted) setState('speaking');
          emit('onTranscript', { id: event.item_id || event.response_id, role: 'assistant', text: entry.text, final: false });
          break;
        }
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done': {
          const key = `a:${event.item_id || event.response_id}`;
          const entry = transcriptFor(key, 'assistant');
          entry.text = String(event.transcript ?? entry.text);
          emit('onTranscript', { id: event.item_id || event.response_id, role: 'assistant', text: entry.text, final: true });
          queueTurn('assistant', entry.text, `a.${event.item_id || event.response_id}`);
          break;
        }
        case 'output_audio_buffer.started':
          if (!muted) setState('speaking');
          break;
        case 'output_audio_buffer.stopped':
        case 'output_audio_buffer.cleared':
          if (!muted && current !== 'thinking') setState('listening');
          break;
        case 'response.output_item.done':
          if (event.item?.type === 'function_call' && (event.item.status === 'completed' || !event.item.status)) runFunctionCall(event.item);
          break;
        case 'response.function_call_arguments.done':
          if (event.call_id && event.name) runFunctionCall({ call_id: event.call_id, name: event.name, arguments: event.arguments });
          break;
        case 'error':
          root.console?.warn?.('[atlas-ai] live voice event error', event.error?.code || event.error?.type || 'error');
          break;
        default:
          break;
      }
    }

    async function start({ takeover = false } = {}) {
      if (!supported().liveVoice) throw Object.assign(new Error('Live voice is not supported in this browser.'), { code: 'unsupported' });
      ended = false;
      setState('connecting');
      let secret = null;
      try {
        const body = conversationId ? { conversation_id: conversationId } : {};
        if (takeover === true) body.takeover = true;
        const session = await request('voice-session', { method: 'POST', body });
        secret = typeof session?.client_secret === 'string' ? session.client_secret : (session?.client_secret?.value || null);
        conversationId = session?.conversation_id || conversationId;
        voiceSessionId = typeof session?.voice_session_id === 'string' && session.voice_session_id ? session.voice_session_id : null;
        sessionId = typeof session?.session_id === 'string' && session.session_id ? session.session_id : null;
        expiresAt = session?.voice_session_expires_at || null;
        const beat = Number(session?.heartbeat_seconds);
        heartbeatSeconds = Number.isFinite(beat) && beat >= 10 && beat <= 300 ? beat : DEFAULT_HEARTBEAT_SECONDS;
        if (!secret || !sessionKey()) {
          // Tools and transcripts need the server's session id; never invent one.
          throw Object.assign(new Error('Live voice could not start.'), { code: 'provider_error' });
        }
        emit('onConversation', conversationId);

        micStream = await root.navigator.mediaDevices.getUserMedia({ audio: true });
        pc = new root.RTCPeerConnection();
        audio = root.document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('aria-hidden', 'true');
        pc.ontrack = (event) => {
          audio.srcObject = event.streams[0];
          meters.remote = levelMeter(event.streams[0]);
        };
        pc.onconnectionstatechange = () => {
          const value = pc?.connectionState;
          if (!ended && !inactive && (value === 'failed' || value === 'closed')) {
            // The call is gone: save what was said and end the session.
            setState('disconnected');
            flushTurns({ final: true }).then((endedByAppend) => { if (!endedByAppend && !inactive) sendEnd(); });
          } else if (!ended && !inactive && value === 'disconnected') {
            setState('disconnected');
          }
        };
        micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));
        meters.mic = levelMeter(micStream);
        channel = pc.createDataChannel('oai-events');
        channel.addEventListener('open', () => { if (!muted) setState('listening'); });
        channel.addEventListener('message', (message) => {
          let event = null;
          try { event = JSON.parse(message.data); } catch { return; }
          handleEvent(event);
        });
        channel.addEventListener('close', () => { if (!ended && !inactive) setState('disconnected'); });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const response = await root.fetch(REALTIME_CALLS_URL, {
          method: 'POST',
          body: offer.sdp,
          headers: { 'content-type': 'application/sdp', authorization: `Bearer ${secret}` }
        });
        // The client secret is single use: forget it as soon as the offer is sent.
        secret = null;
        if (!response.ok) throw Object.assign(new Error('Live voice could not connect.'), { code: 'provider_error', status: response.status });
        const answer = await response.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        startHeartbeat();
      } catch (error) {
        secret = null;
        teardown();
        // A session the server reserved but the browser could not use is ended.
        if (sessionKey()) sendEnd();
        setState('error', { code: error?.code || (error?.name === 'NotAllowedError' ? 'microphone_blocked' : 'failed'), reason: error?.reason || null });
        throw error;
      }
    }

    function level() {
      const source = current === 'speaking' ? meters.remote : meters.mic;
      try { return source ? source() : 0; } catch { return 0; }
    }

    function mute(value = !muted) {
      muted = Boolean(value);
      micStream?.getAudioTracks?.().forEach((track) => { track.enabled = !muted; });
      setState(muted ? 'muted' : 'listening');
      return muted;
    }

    function teardown() {
      root.clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
      try { channel?.close(); } catch { /* closed */ }
      try { pc?.close(); } catch { /* closed */ }
      stopStream(micStream);
      meters.mic?.close?.();
      meters.remote?.close?.();
      meters = { mic: null, remote: null };
      if (audio) { try { audio.srcObject = null; } catch { /* detached */ } }
      channel = null;
      pc = null;
      micStream = null;
    }

    // Explicit End: close the call, save the transcript, end the session.
    async function end() {
      if (ended) return;
      ended = true;
      teardown();
      setState('ended');
      const endedByAppend = await flushTurns({ final: true });
      if (!endedByAppend && !inactive) await sendEnd();
    }

    // The page is going away (pagehide): close the call and end the session
    // with a request that survives unload.
    function exit() {
      if (endSent || !sessionKey() || inactive) { teardown(); return; }
      ended = true;
      endSent = true;
      teardown();
      try { options.sendOnExit?.('voice-end', { voice_session_id: sessionKey() }); } catch { /* best effort */ }
    }

    return {
      start,
      mute,
      end,
      level,
      exit,
      state: () => current,
      muted: () => muted,
      conversationId: () => conversationId,
      voiceSessionId: () => sessionKey(),
      expiresAt: () => expiresAt,
      // Exposed for tests and diagnostics: feeds one data-channel event, or
      // sends one heartbeat now.
      handleEvent,
      heartbeat
    };
  }

  root.AtlasAIVoice = { supported, createVoiceNote, createLiveVoice, pickMime, REALTIME_CALLS_URL };
})(typeof window === 'undefined' ? globalThis : window);
