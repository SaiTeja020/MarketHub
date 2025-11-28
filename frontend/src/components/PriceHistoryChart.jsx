import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer
} from "recharts";

export default function PriceHistoryChart({ data }) {
  if (!data || data.length === 0) {
    return <p className="text-gray-500">No price history available.</p>;
  }

  // Convert Elasticsearch dates to readable format
  const formatted = data.map((entry) => ({
    ...entry,
    date: new Date(entry.scraped_at).toLocaleDateString("en-IN", {
      month: "short",
      day: "numeric"
    })
  }));

  return (
    <div className="w-full h-64 mt-6 bg-white p-4 border rounded shadow">
      <h3 className="text-lg font-semibold mb-3">Price History</h3>

      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={formatted}>
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="price" stroke="#3b82f6" strokeWidth={3} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
