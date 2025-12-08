# backend/python/services/deal_service.py

from typing import List, Optional
import math

def _safe_avg(nums: List[float]) -> Optional[float]:
    if not nums:
        return None
    return sum(nums) / len(nums)

def _pct_of(a: float, b: float) -> Optional[float]:
    """Return percentage (a / b) as fraction (0.0-1.0). Return None if b is falsy."""
    try:
        if b == 0 or b is None:
            return None
        return a / b
    except Exception:
        return None

def compute_deal_score(price: Optional[float], historical_prices: List[float], credibility_score: float) -> int:
    """
    Return integer 0-100 where higher means better deal.
    Logic:
      - If we have history: reward being below average and above historical minimum.
      - If no history: base score on credibility only (scaled).
    """
    try:
        # normalize inputs
        price = float(price) if price is not None else None
        credibility_score = float(credibility_score or 0.5)
    except Exception:
        price = None
        credibility_score = 0.5

    if not historical_prices:
        # No history: use credibility as main signal (scale to 0-100)
        return int(max(0, min(100, credibility_score * 100)))

    # derived stats
    avg_price = _safe_avg(historical_prices)
    min_price = min(historical_prices) if historical_prices else None

    # if any critical values missing, fall back to credibility
    if price is None or avg_price is None or min_price is None:
        return int(max(0, min(100, credibility_score * 100)))

    # % cheaper than average (0..1). If price > avg -> 0
    pct_cheaper_than_avg = max(0.0, (avg_price - price) / avg_price)

    # closeness to historical min: 0 when price == min (best), up to 1 when price >= 2x min (worse)
    if min_price <= 0:
        closeness_to_min = 1.0
    else:
        closeness_to_min = (price - min_price) / max(min_price, 1e-9)
        # convert to 0..1 range where 0 is best (on min) and 1 is far away (>= min*1)
        closeness_to_min = max(0.0, min(closeness_to_min, 1.0))

    # Weighted score (tune weights as desired)
    # - being cheaper than average: positive
    # - being close to min: positive (we invert closeness_to_min)
    score_continuous = (
        pct_cheaper_than_avg * 0.55
        + (1.0 - closeness_to_min) * 0.25
        + credibility_score * 0.20
    )

    score = int(max(0, min(100, round(score_continuous * 100))))
    return score


def generate_summary(price: Optional[float], avg_price: Optional[float], min_price: Optional[float], credibility_score: float) -> List[str]:
    """
    Return a short list of up to 3 short text lines describing:
      - relative position vs average,
      - relation to historical min,
      - quick credibility hint.

    This function is defensive: it handles None / zero values and uses human-friendly phrasing.
    """
    lines = []

    # normalize
    try:
        price = float(price) if price is not None else None
    except Exception:
        price = None

    try:
        avg_price = float(avg_price) if (avg_price is not None) else None
    except Exception:
        avg_price = None

    try:
        min_price = float(min_price) if (min_price is not None) else None
    except Exception:
        min_price = None

    # 1) Compare vs average
    if price is None or avg_price is None or avg_price == 0:
        lines.append("Insufficient historical data to compare with average.")
    else:
        # percent difference with rounding and friendly words
        diff = avg_price - price
        pct = (diff / avg_price) * 100
        abs_pct = abs(pct)
        if abs_pct < 1:
            lines.append("Price is about the same as the 30-day average.")
        elif pct > 0:
            # price lower than average
            lines.append(f"Current price is about {round(abs_pct, 1)}% lower than the 30-day average.")
        else:
            lines.append(f"Current price is about {round(abs_pct, 1)}% higher than the 30-day average.")

    # 2) Compare vs historical minimum
    if price is None or min_price is None:
        lines.append("No reliable historical minimum available.")
    else:
        if math.isclose(price, min_price, rel_tol=1e-9):
            lines.append("This matches the lowest price seen recently.")
        elif price < min_price:
            lines.append("This is a new lowest price compared to recent history.")
        else:
            # how much higher than min
            diff_min_pct = ((price - min_price) / min_price) * 100 if min_price else None
            if diff_min_pct is None:
                lines.append("Historical minimum present but unable to compare.")
            elif diff_min_pct < 5:
                lines.append("Price is very close to the recent minimum.")
            else:
                lines.append(f"Historical minimum is ₹{min_price:.2f}, about {round(diff_min_pct,1)}% lower.")

    # 3) Credibility hint
    cs = float(credibility_score or 0)
    if cs >= 0.8:
        lines.append("Automated analysis indicates high credibility for this data.")
    elif cs >= 0.6:
        lines.append("Automated analysis indicates moderate credibility.")
    else:
        lines.append("Automated analysis suggests low credibility for this data — treat with caution.")

    # Return only top 3 lines (1–3)
    return lines[:3]
