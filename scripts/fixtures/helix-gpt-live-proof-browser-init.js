(() => {
  const proofWindow = window;
  try {
    let audioContext = null;
    let destination = null;

    const ensureAudioGraph = () => {
      if (!audioContext || !destination) {
        audioContext = new AudioContext({ sampleRate: 48000 });
        destination = audioContext.createMediaStreamDestination();
      }
      return { context: audioContext, destination };
    };

    proofWindow.__HELIX_GPT_LIVE_PROOF_AUDIO__ = {
      ready: true,
      playBase64: async (base64) => {
        const graph = ensureAudioGraph();
        await graph.context.resume();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const buffer = await graph.context.decodeAudioData(bytes.buffer.slice(0));
        const source = graph.context.createBufferSource();
        source.buffer = buffer;
        source.connect(graph.destination);
        const durationMs = Math.ceil(buffer.duration * 1000);
        await new Promise((resolve) => {
          source.onended = resolve;
          source.start();
        });
        return { duration_ms: durationMs };
      },
    };

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) throw new Error("media_devices_unavailable");
    const proofGetUserMedia = async (constraints) => {
      if (!constraints || !constraints.audio || constraints.video) {
        throw new DOMException(
          "The proof microphone supports audio-only capture.",
          "NotSupportedError",
        );
      }
      return ensureAudioGraph().destination.stream;
    };
    Object.defineProperty(proofGetUserMedia, "__helixProofMicrophone", {
      value: true,
    });
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: proofGetUserMedia,
    });
    proofWindow.__HELIX_GPT_LIVE_PROOF_INIT_FAILURE__ = null;
  } catch (error) {
    proofWindow.__HELIX_GPT_LIVE_PROOF_INIT_FAILURE__ = {
      name: error instanceof Error ? error.name.slice(0, 80) : null,
      message: error instanceof Error ? error.message.slice(0, 240) : null,
    };
  }
})();
