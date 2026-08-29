/* Live microphone meter. Kept small and dependency-free: the analyser reads
   the same MediaStream MediaRecorder owns; it never feeds audio anywhere. */

export const WAVEFORM_BAR_COUNT = 31;

/** Mirror the speech-frequency bins around the centre. The floor leaves a
 *  visible hairline in silence; subtracting the analyser noise floor stops an
 *  idle microphone from looking busy. */
export function waveformLevels(frequencies, count = WAVEFORM_BAR_COUNT) {
  if (count <= 0) return [];
  const middle = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    const distance = Math.round(Math.abs(index - middle));
    const sample = frequencies[Math.min(distance + 1, frequencies.length - 1)] ?? 0;
    return Math.max(0.08, Math.min(1, (sample / 255 - 0.035) * 1.65));
  });
}

export function connectWaveform(stream, bars) {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContext) return () => {};

  let context;
  let source;
  let frame;
  try {
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256; // bins 1–16 cover the useful speech range at 48 kHz
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const paint = () => {
      analyser.getByteFrequencyData(frequencies);
      const levels = waveformLevels(frequencies, bars.length);
      bars.forEach((bar, index) => bar.style.setProperty("--level", levels[index].toFixed(3)));
      frame = requestAnimationFrame(paint);
    };
    paint();
  } catch {
    void context?.close().catch(() => {});
    return () => {};
  }

  return () => {
    cancelAnimationFrame(frame);
    source?.disconnect();
    void context?.close().catch(() => {});
  };
}
