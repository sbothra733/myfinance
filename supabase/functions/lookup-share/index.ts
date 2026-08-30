// Supabase Edge Function: lookup-share
//
// Proxies stock price + dividend lookups to Finnhub (finnhub.io), keeping the API key
// server-side instead of exposing it in the browser bundle. Deploy with:
//   supabase functions deploy lookup-share
//   supabase secrets set FINNHUB_API_KEY=your_key_here
//
// Finnhub's free tier (60 req/min, US-listed stocks) covers /quote reliably. Dividend data is
// less certain on the free tier, so this tries two sources in order:
//   1. /stock/dividend2 — actual payment history, most accurate when available.
//   2. /stock/metric (basic financials, definitely free-tier) — falls back to the trailing
//      annual dividend-per-share figure divided by 4, if the first source returns nothing.
// If both come up empty, quarterlyDividendPerShare is 0 and `dividendNote` explains why —
// check that note if dividends keep showing as 0 for stocks you know pay one.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { symbol } = await req.json();
    const cleanSymbol = String(symbol || "").trim().toUpperCase();
    if (!cleanSymbol) {
      return new Response(JSON.stringify({ found: false, error: "No ticker provided" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("FINNHUB_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ found: false, error: "FINNHUB_API_KEY is not configured on the server" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const quoteRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${cleanSymbol}&token=${apiKey}`);
    const quote = await quoteRes.json();

    // Finnhub returns c: 0 (and everything else 0) for an unrecognized symbol rather than an error status.
    if (!quoteRes.ok || !quote || quote.c === 0) {
      return new Response(JSON.stringify({ found: false, error: "Ticker not found" }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    let quarterlyDividendPerShare = 0;
    let dividendNote = "";

    // Source 1: actual dividend payment history.
    try {
      const to = new Date();
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      const divRes = await fetch(
        `https://finnhub.io/api/v1/stock/dividend2?symbol=${cleanSymbol}&from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}&token=${apiKey}`
      );
      if (divRes.ok) {
        const divData = await divRes.json();
        const payments = Array.isArray(divData) ? divData : divData?.data || [];
        if (payments.length > 0) {
          const latest = payments[0];
          const amt = Number(latest.amount ?? latest.dividend ?? 0) || 0;
          if (amt > 0) {
            quarterlyDividendPerShare = amt;
            dividendNote = "from payment history";
          }
        }
      } else if (divRes.status === 403) {
        dividendNote = "payment history endpoint requires a paid Finnhub plan; tried basic financials instead";
      }
    } catch (_e) {
      // fall through to source 2
    }

    // Source 2: basic financials (trailing annual dividend / 4), definitely available on the free tier.
    if (quarterlyDividendPerShare === 0) {
      try {
        const metricRes = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${cleanSymbol}&metric=all&token=${apiKey}`);
        if (metricRes.ok) {
          const metricData = await metricRes.json();
          const annualDividend =
            Number(metricData?.metric?.dividendPerShareAnnual) ||
            Number(metricData?.metric?.["dividendPerShareTTM"]) ||
            0;
          if (annualDividend > 0) {
            quarterlyDividendPerShare = annualDividend / 4;
            dividendNote = "estimated from trailing annual dividend (basic financials)";
          } else if (!dividendNote) {
            dividendNote = "no dividend data found for this ticker";
          }
        }
      } catch (_e) {
        if (!dividendNote) dividendNote = "dividend lookup failed";
      }
    }

    return new Response(
      JSON.stringify({
        found: true,
        price: quote.c,
        quarterlyDividendPerShare,
        dividendNote,
        asOf: new Date().toLocaleDateString(),
        source: "Finnhub",
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ found: false, error: String(err?.message || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
