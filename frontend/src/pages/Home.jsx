export default function Home() {
  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Dashboard</h1>

        <input
          type="text"
          placeholder="Search for products..."
          className="p-2 border rounded-lg w-80 shadow-sm"
        />
      </div>

      {/* Grid of Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">

        {/* Tracked Products */}
        <div className="p-6 bg-white rounded-xl shadow">
          <h2 className="text-lg font-semibold mb-4">Tracked Products</h2>
          <p className="text-gray-600">You are tracking 0 products.</p>
        </div>

        {/* Price Drops */}
        <div className="p-6 bg-white rounded-xl shadow">
          <h2 className="text-lg font-semibold mb-4">Price Drops</h2>
          <p className="text-gray-600">No price drops available.</p>
        </div>

        {/* Best Deals */}
        <div className="p-6 bg-white rounded-xl shadow">
          <h2 className="text-lg font-semibold mb-4">Best Deals</h2>
          <p className="text-gray-600">Loading best deals...</p>
        </div>

        {/* Recent Changes */}
        <div className="p-6 bg-white rounded-xl shadow">
          <h2 className="text-lg font-semibold mb-4">Recent Price Changes</h2>
          <p className="text-gray-600">No recent changes.</p>
        </div>

        {/* Price Trend (Simple placeholder) */}
        <div className="p-6 bg-white rounded-xl shadow col-span-1 xl:col-span-2">
          <h2 className="text-lg font-semibold mb-4">Market Price Trends</h2>
          <div className="h-40 bg-gray-100 rounded-lg flex items-center justify-center text-gray-500">
            Graph Placeholder
          </div>
        </div>

      </div>

    </div>
  );
}
