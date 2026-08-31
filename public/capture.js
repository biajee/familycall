/** Streams the local microphone as int16 PCM chunks via an AudioWorklet. */
export class MicCapture {
  constructor(ctx, stream, targetRate, onChunk) {
    this.ctx = ctx;
    this.stream = stream;
    this.targetRate = targetRate;
    this.onChunk = onChunk;
    this.node = null;
    this.source = null;
    this.gain = null;
  }

  async start() {
    const track = this.stream.getAudioTracks()[0];
    if (!track) throw new Error('no audio track');
    if (this.ctx.state !== 'running') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: this.targetRate, chunkMs: 100 },
    });
    this.node.port.onmessage = (e) => this.onChunk(e.data);
    // Silent sink: keeps the worklet scheduled without playing the mic back to the speaker.
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.node).connect(this.gain).connect(this.ctx.destination);
  }

  stop() {
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.gain?.disconnect(); } catch { /* ignore */ }
    if (this.node) this.node.port.onmessage = null;
    this.node = this.source = this.gain = null;
  }
}
