// src/types/serverTypes.ts
export enum AnalysisStatus {
    GOOD_DEAL = "Good Deal",
    NORMAL_PRICE = "Normal Price",
    BAD_DEAL = "Bad Deal",
    FAKE_DEAL = "Fake Deal"
  }
  
  export interface AnalysisResponse {
    score: number;
    summary: string;
    status: AnalysisStatus | string;
    reasoning: string;
  }
  