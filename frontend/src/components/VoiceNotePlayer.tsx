import { useEffect, useRef, useState } from 'preact/hooks';
import { Play, Pause } from 'lucide-preact';
import { chatAttachmentObjectUrl, revokeChatAttachmentObjectUrl } from '../api';

interface VoiceNotePlayerProps {
  attachmentId: string;
  attachmentName: string;
}

export function VoiceNotePlayer({ attachmentId, attachmentName }: VoiceNotePlayerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    chatAttachmentObjectUrl(attachmentId)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => {});
    return () => {
      alive = false;
      revokeChatAttachmentObjectUrl(attachmentId);
    };
  }, [attachmentId]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const seek = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const time = parseFloat(input.value);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.5, 2];
    const nextIndex = (speeds.indexOf(speed) + 1) % speeds.length;
    setSpeed(speeds[nextIndex]);
  };

  if (!url) return <div class="vn-player-loading" title={attachmentName}>Loading audio...</div>;

  const progressPct = (currentTime / duration) * 100 || 0;

  return (
    <div class="vn-player">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        style="display:none"
      />
      
      <button class="vn-play-btn" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'} aria-pressed={isPlaying}>
        {isPlaying ? <Pause width={16} height={16} /> : <Play width={16} height={16} />}
      </button>

      <div class="vn-progress-container">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={seek}
          class="vn-progress-bar"
          aria-label="Seek"
        />
        <div class="vn-progress-fill" style={`width: ${progressPct}%`}></div>
      </div>

      <div class="vn-time">
        <span>{fmtTime(currentTime)}</span>
        <span class="dim"> / {fmtTime(duration)}</span>
      </div>

      <button class="vn-speed-btn" onClick={cycleSpeed} title="Playback Speed" aria-label={`Playback speed. Current: ${speed}x`}>
        {speed}x
      </button>
    </div>
  );
}

function fmtTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
