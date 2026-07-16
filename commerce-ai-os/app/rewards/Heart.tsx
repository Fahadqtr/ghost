// A single loyalty "heart" slot. Empty = dashed pink outline (like the printed
// card); filled = solid pink with a soft pop-in when it's freshly earned.
export function Heart({ filled, index }: { filled: boolean; index: number }) {
  return (
    <svg
      viewBox="0 0 32 29"
      className="h-12 w-12 sm:h-14 sm:w-14"
      style={filled ? { animation: `heartPop 0.45s ease-out ${index * 0.06}s both` } : undefined}
      aria-hidden
    >
      <path
        d="M16 28C16 28 2 19.5 2 9.8 2 5.2 5.6 2 9.6 2c2.6 0 4.9 1.4 6.4 3.6C17.5 3.4 19.8 2 22.4 2 26.4 2 30 5.2 30 9.8 30 19.5 16 28 16 28Z"
        fill={filled ? "#e59aad" : "none"}
        stroke={filled ? "#d98299" : "#e8b7c2"}
        strokeWidth="1.4"
        strokeDasharray={filled ? undefined : "2.5 2.5"}
      />
    </svg>
  );
}
