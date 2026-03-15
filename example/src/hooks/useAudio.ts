import { useEffect, useRef } from 'react';
import { WebAudioPcmPlayer } from '@fourscore/sdr';

export function useAudio() {
  const playerRef = useRef<WebAudioPcmPlayer | null>(null);

  if (!playerRef.current) playerRef.current = new WebAudioPcmPlayer();

  useEffect(() => {
    const player = playerRef.current;
    return () => {
      player?.stop();
    };
  }, []);

  return playerRef.current;
}
