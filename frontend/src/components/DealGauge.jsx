export default function DealGauge({ score }) {
  const angle = (score / 100) * 180;

  return (
    <div className="gauge flex flex-col items-center mt-4">
      <svg width="220" height="120">
        {/* Grey background arc */}
        <path
          d="M10 110 A100 100 0 0 1 210 110"
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="20"
        />

        {/* Score arc */}
        <path
          d="M10 110 A100 100 0 0 1 210 110"
          fill="none"
          stroke="#10b981"
          strokeWidth="20"
          strokeDasharray={`${angle * 3.14} 999`}
        />
      </svg>

      <div className="text-xl font-bold mt-2">{score}</div>
    </div>
  );
}
