// Supabase Edge Function: lookup-share
//
// Proxies stock price + dividend lookups to Finnhub (finnhub.io), keeping the API key
// server-side instead of exposing it in the browser bundle. Deploy with:
//   supabase functions deploy lookup-share
//   supabase secrets set FINNHUB_API_KEY=your_key_here
//
// Finnhub's free tier (60 req/min, US-listed stocks) covers /quote reliably. The dividend
// endpoint below (/stock/dividend2) is Finnhub's "basic" dividend data — double-check
// https://finnhub.io/docs/api for the current endpoint name/shape before relying on it,
// since third-party API surfaces do change. If it fails or isn't available on your plan,
// this function still returns the price and simply reports the dividend as 0, so lookups
// keep working — you'd just need to enter the dividend manually in that case.

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
          // Most recent payment's per-share amount, as a stand-in for "quarterly" — adjust here if your
          // plan's response shape differs, or if the company pays on a non-quarterly schedule.
          const latest = payments[0];
          quarterlyDividendPerShare = Number(latest.amount ?? latest.dividend ?? 0) || 0;
        }
      }
    } catch (_e) {
      // Dividend lookup is best-effort — price is the important part, so don't fail the whole request.
    }

    return new Response(
      JSON.stringify({
        found: true,
        price: quote.c,
        quarterlyDividendPerShare,
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
