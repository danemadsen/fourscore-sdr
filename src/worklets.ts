export function getOpenWebRXAudioProcessorUrl(): string {
  return new URL('./openwebrx-audio-processor.js', import.meta.url).href;
}
