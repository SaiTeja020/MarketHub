import React from "react";
import SummaryCard from "../components/SummaryCard";
import PriceRow from "../components/PriceRow";
import SmallTrendChart from "../components/SmallTrendChart";

const sampleProducts = [
  {
    id: 1,
    title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
    store: "Amazon",
    currentPrice: "348.00",
    oldPrice: "399.00",
    img: "/assets/dashboard-hero.png",
  },
  {
    id: 2,
    title: "MacBook Air 15-inch M2 Chip",
    store: "Apple Store",
    currentPrice: "1198.71",
    oldPrice: "1199.00",
    img: "/assets/dashboard-hero.png",
  },
  {
    id: 3,
    title: "Dyson V15 Detect Vacuum",
    store: "Best Buy",
    currentPrice: "649.55",
    oldPrice: "749.99",
    img: "/assets/dashboard-hero.png",
  },
];

const trendData = [
  { date: "10/24", price: 340 },
  { date: "10/29", price: 370 },
  { date: "11/03", price: 390 },
  { date: "11/07", price: 430 },
  { date: "11/12", price: 480 },
  { date: "11/17", price: 520 },
  { date: "11/22", price: 330 },
];

export default function Home() {
  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Welcome back! Here's today's market overview.</p>
        </div>

        <div className="flex items-center gap-4">
          <input
            type="text"
            className="border rounded-lg px-4 py-2 w-80 shadow-sm"
            placeholder="Search tracked products..."
          />
          <button className="py-2 px-4 bg-blue-600 text-white rounded-lg">+ Add Product</button>
        </div>
      </div>

      {/* Top two summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <SummaryCard
          title="Tracked Products"
          value="5"
          subtitle="Active monitors"
          icon={<div className="text-sm text-gray-300">📦</div>}
        />
        <SummaryCard
          title="Price Drops"
          value="4"
          subtitle="In the last 24h"
          icon={<div className="text-sm text-gray-300">⬇️</div>}
        />
      </div>

      {/* Main section */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Recent price changes - left (span 2 columns out of 3) */}
        <div className="xl:col-span-2 bg-white rounded-2xl p-6 shadow-card">
          <h2 className="font-semibold text-lg mb-4">Recent Price Changes</h2>

          <div className="space-y-3">
            {sampleProducts.map((p) => (
              <PriceRow key={p.id} product={p} />
            ))}
          </div>
        </div>

        {/* Featured Trend - right */}
        <div className="bg-white rounded-2xl p-6 shadow-card">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-semibold">Featured Trend</h3>
              <div className="text-sm text-gray-500">Sony WH-1000XM5 Wireless Noise Canceling Headphones — 30 Day History</div>
            </div>
          </div>

          <div className="mt-4">
            <SmallTrendChart data={trendData} />
          </div>
        </div>
      </div>
    </div>
  );
}
