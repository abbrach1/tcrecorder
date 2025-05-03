class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === 'reset') {
        this._reset();
      }
    };
  }
  _reset() {
    // No-op for now, but could reset state if needed
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      // Send PCM samples to main thread
      this.port.postMessage(input[0]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
