class DeepgramProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer ~50ms of audio at 16kHz (800 samples) before sending
    // This prevents tiny 128-sample packets from being dropped
    this._buffer = new Int16Array(800);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const channelData = input[0];

    // Convert Float32 [-1,1] → Int16 PCM and accumulate into buffer
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      // Flush when buffer is full
      if (this._offset >= this._buffer.length) {
        const copy = this._buffer.slice(0);
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('deepgram-processor', DeepgramProcessor);
