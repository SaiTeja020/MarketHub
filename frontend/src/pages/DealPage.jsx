import React, { useState, useEffect } from "react";
import {
  startScrape,
  getScrapeResult,
  startAnalysis,
  getAnalysisResult,
  getDealSummary
} from "../lib/api";

export default function DealPage() {
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [taskId, setTaskId] = useState(null);
  const [scraped, setScraped] = useState(null);
  const [analysisTaskId, setAnalysisTaskId] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [deal, setDeal] = useState(null);

  // Step 1: Start scrape
  async function handleScrape() {
    const data = await startScrape(url, source);
    setTaskId(data.task_id);
  }

  // Step 2: Poll scrape results
  useEffect(() => {
    if (!taskId) return;

    const interval = setInterval(async () => {
      const res = await getScrapeResult(taskId);
      if (res.status === 200) {
        const data = await res.json();
        setScraped(data.result);
        clearInterval(interval);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [taskId]);



  // Step 3: Trigger analysis
  async function startProductAnalysis() {
    const data = await startAnalysis({
      product_id: scraped.product_id,
      title: scraped.title,
      image_url: scraped.image_url,
      current_price: scraped.current_price
    });

    setAnalysisTaskId(data.task_id);
  }

  // Step 4: Poll analysis results
  useEffect(() => {
    if (!analysisTaskId) return;

    const interval = setInterval(async () => {
      const res = await getAnalysisResult(analysisTaskId);
      if (res.status === 200) {
        const data = await res.json();
        setAnalysis(data.analysis);
        clearInterval(interval);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [analysisTaskId]);

  // Step 5: Final deal summary
  async function loadDealSummary() {
    const data = await getDealSummary(scraped.product_id);
    setDeal(data);
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold mb-4">Deal Analyzer</h1>

      {/* Input */}
      <input
        className="border p-2 rounded w-full"
        placeholder="Paste product URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="border p-2 rounded w-full mt-2"
        placeholder="Source (amazon/flipkart)"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />

      <button
        className="bg-blue-600 text-white px-4 py-2 rounded mt-3"
        onClick={handleScrape}
      >
        Scrape
      </button>

      {/* Scraped Result */}
      {scraped && (
        <div className="mt-6 border p-4 rounded bg-gray-50">
          <h2 className="text-lg font-semibold">{scraped.title}</h2>
          <p>Price: {scraped.current_price}</p>
        </div>
      )}

      {/* Analysis */}
      {analysis && (
        <div className="mt-6 border p-4 rounded bg-yellow-50">
          <button
            onClick={loadDealSummary}
            className="bg-purple-600 text-white px-4 py-2 rounded"
          >
            Get Final Deal Summary
          </button>
        </div>
      )}

      {/* Final Deal */}
      {deal && (
        <div className="mt-6 border p-4 rounded bg-green-50">
          <h2 className="text-lg font-bold">Deal Score: {deal.deal_score}</h2>

          <DealGauge score={deal.deal_score} />

          <DealSummary lines={deal.summary}/>
          
          <PriceHistoryChart data={deal.price_history}/>

          <div className="mt-4">
            {deal.summary.map((line, i) => (
              <p key={i} className="text-gray-700">
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
