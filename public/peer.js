/**
 * One RTCPeerConnection using the "perfect negotiation" pattern
 * (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example), so both sides can add
 * tracks / renegotiate at any time without offer collisions.
 */
export class Call {
  constructor({ polite, iceServers, localStream, sendSignal, onRemoteStream, onConnectionState, maxVideoKbps = 700 }) {
    this.polite = polite;
    this.sendSignal = sendSignal;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.maxVideoKbps = maxVideoKbps;
    this.disconnectTimer = null;
    this.remoteStream = new MediaStream();

    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });
    this.pc = pc;

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      onRemoteStream(this.remoteStream);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ candidate });
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignal({ description: pc.localDescription });
      } catch (err) {
        console.error('negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      clearTimeout(this.disconnectTimer);
      if (pc.iceConnectionState === 'failed') {
        pc.restartIce();
      } else if (pc.iceConnectionState === 'disconnected') {
        // Give the network a few seconds to recover before forcing an ICE restart.
        this.disconnectTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') pc.restartIce();
        }, 4000);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this._applyBitrate();
      onConnectionState(pc.connectionState);
    };
  }

  async handleSignal({ description, candidate }) {
    const pc = this.pc;
    try {
      if (description) {
        const readyForOffer = !this.makingOffer
          && (pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
        const offerCollision = description.type === 'offer' && !readyForOffer;
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        this.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description); // implicit rollback on the polite side
        this.isSettingRemoteAnswerPending = false;
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.sendSignal({ description: pc.localDescription });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('signal handling failed', err);
    }
  }

  async _applyBitrate() {
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = this.maxVideoKbps * 1000;
        await sender.setParameters(params);
      } catch (err) {
        console.warn('setParameters failed', err);
      }
    }
  }

  async replaceVideoTrack(track) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }

  get connectionState() {
    return this.pc.connectionState;
  }

  close() {
    clearTimeout(this.disconnectTimer);
    this.pc.ontrack = this.pc.onicecandidate = this.pc.onnegotiationneeded = null;
    this.pc.oniceconnectionstatechange = this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
