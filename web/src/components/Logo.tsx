import { useId } from 'react';

export function Logo({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <defs>
        <linearGradient id={id} x1="8" y1="6" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4F8CFF" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill="#0B0D14" stroke={`url(#${id})`} strokeOpacity=".55" strokeWidth="3" />
      <path d="M18 20h28M32 22v24" stroke={`url(#${id})`} strokeWidth="7" strokeLinecap="round" fill="none" />
      <circle cx="46" cy="45" r="4" fill="#8B5CF6" />
    </svg>
  );
}
