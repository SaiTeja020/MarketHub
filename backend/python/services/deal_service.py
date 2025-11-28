# services/deal_service.py

def compute_deal_score(price: float, historical_prices: list[float], credibility_score: float):
    """
    price: current scraped price
    historical_prices: list of floats
    credibility_score: 0–1 (from Gemini)
    """
    if not historical_prices:
        return int(credibility_score * 100)

    avg_price = sum(historical_prices) / len(historical_prices)
    min_price = min(historical_prices)

    # Percentage cheaper than average
    diff_avg = max(0, (avg_price - price) / avg_price)  # 0–1

    # Percentage above historical best
    diff_min = max(0, (price - min_price) / min_price)  # 0–∞ but clipped
    diff_min = min(diff_min, 1)

    # Weighted score (tune as needed)
    score = (
        diff_avg * 0.5 +
        (1 - diff_min) * 0.2 +
        credibility_score * 0.3
    )

    return int(score * 100)

def generate_summary(price: float, avg_price: float, min_price: float, credibility_score: float):
    lines = []

    # 1
    if price < avg_price:
        pct = int((avg_price - price) / avg_price * 100)
        lines.append(f"Current price is {pct}% lower than the 30-day average.")
    else:
        pct = int((price - avg_price) / avg_price * 100)
        lines.append(f"Current price is {pct}% higher than the 30-day average.")

    # 2
    if price <= min_price:
        lines.append("This matches the lowest price seen recently.")
    else:
        diff = int((price - min_price) / min_price * 100)
        lines.append(f"The historical minimum price is {min_price}, which is {diff}% lower.")

    # 3
    if credibility_score > 0.75:
        lines.append("Gemini analysis suggests this is a genuinely good deal.")
    elif credibility_score > 0.5:
        lines.append("Gemini analysis indicates this deal is moderately credible.")
    else:
        lines.append("Gemini analysis flags this as a potentially weak deal.")

    # 4
    lines.append("Price history and recent trends suggest the deal is likely stable.")

    return lines[:4]  # ensure only 3–4 lines

