import { useState } from "react";

interface PlayerAvatarProps {
  src: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}

/**
 * Player headshot with automatic fallback to initials on load error or missing URL.
 */
export function PlayerAvatar({ src, name, size = 48, className = "" }: PlayerAvatarProps) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };

  if (!src || failed) {
    return (
      <div
        className={`rounded-lg bg-white/5 flex items-center justify-center text-white/20 shrink-0 ${className}`}
        style={style}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="w-1/2 h-1/2 text-white/15"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
          />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      className={`rounded-lg object-cover bg-white/5 shrink-0 ${className}`}
      style={style}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
