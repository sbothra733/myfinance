import React, { useState, useMemo, useRef, useEffect, useContext, createContext } from "react";
import { supabase } from "./supabaseClient";

// ---------- helpers ----------
const uid = (() => {
  let n = 0;
  return () => `id_${Date.now()}_${n++}`;
})();

// ---------- currency ----------
// Country list with a sensible default currency for each. Currency is auto-set from country but always overridable.
const COUNTRY_CURRENCY = [
  { country: "United States", currency: "USD" },
  { country: "India", currency: "INR" },
];
const CURRENCY_CODES = [...new Set(COUNTRY_CURRENCY.map((c) => c.currency))].sort();
const currencyForCountry = (country) => COUNTRY_CURRENCY.find((c) => c.country === country)?.currency || "USD";
// Rough current benchmarks (as of mid-2026); the Profile tab lets the user override either.
const MORTGAGE_RATE_BY_COUNTRY = { "United States": "6.75", "India": "8.0" };
const mortgageRateForCountry = (country) => MORTGAGE_RATE_BY_COUNTRY[country] || "6.75";

const getCurrencySymbol = (code) => {
  try {
    const parts = (0).toLocaleString("en-US", { style: "currency", currency: code, minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return parts.replace(/[\d\s.,]/g, "") || code;
  } catch (e) {
    return code;
  }
};

const moneyBase = (v, currency = "USD") => {
  const n = Number(v) || 0;
  try {
    return n.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 0 });
  } catch (e) {
    return `${getCurrencySymbol(currency)}${Math.round(n).toLocaleString("en-US")}`;
  }
};
const moneyPreciseBase = (v, currency = "USD") => {
  const n = Number(v) || 0;
  try {
    return n.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 2 });
  } catch (e) {
    return `${getCurrencySymbol(currency)}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
};
const pct = (v) => `${(Number(v) || 0).toFixed(1)}%`;
const num = (v) => (v === "" || v === null || v === undefined ? 0 : parseFloat(v) || 0);

// ---------- recurring deposit math ----------
const RD_PERIODS_PER_YEAR = { daily: 365, weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };
const RD_AVG_DAYS_PER_PERIOD = { daily: 1, weekly: 7, monthly: 30.44, quarterly: 91.31, yearly: 365.25 };

const rdEndDate = (startDateStr, tenureValue, tenureUnit) => {
  if (!startDateStr) return null;
  const d = new Date(startDateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  if (tenureUnit === "years") d.setFullYear(d.getFullYear() + (Number(tenureValue) || 0));
  else d.setMonth(d.getMonth() + (Number(tenureValue) || 0));
  return d;
};

// Future value of a series of equal deposits made at the start of each period (annuity due), compounded
// at the periodic rate implied by the annual rate and deposit frequency.
const rdFutureValue = (deposit, annualRatePct, periodsPerYear, nPeriods) => {
  const n = Math.max(0, Math.floor(nPeriods));
  if (n <= 0 || deposit <= 0) return 0;
  const i = annualRatePct / 100 / periodsPerYear;
  if (i === 0) return deposit * n;
  return deposit * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
};

const CurrencyContext = createContext({ code: "USD", symbol: "$" });

// ---------- field primitives ----------
function Field({ label, suffix, className = "", children }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}{suffix ? <em>{suffix}</em> : null}</span>
      {children}
    </label>
  );
}

function MoneyInput({ value, onChange, placeholder = "0" }) {
  const { symbol } = useContext(CurrencyContext);
  // Comma-grouped, whole-number display — digits only while typing, formatted with thousands separators.
  const displayValue = value === "" || value === null || value === undefined ? "" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const handleChange = (e) => {
    const digitsOnly = e.target.value.replace(/[^0-9]/g, "");
    onChange(digitsOnly === "" ? "" : String(parseInt(digitsOnly, 10)));
  };
  return (
    <div className="money-input">
      <span>{symbol}</span>
      <input
        type="text"
        inputMode="numeric"
        value={displayValue}
        placeholder={placeholder}
        onChange={handleChange}
      />
    </div>
  );
}

function RateInput({ value, onChange }) {
  return (
    <div className="rate-input">
      <input
        type="number"
        step="0.01"
        inputMode="decimal"
        value={value}
        placeholder="0.0"
        onChange={(e) => onChange(e.target.value)}
      />
      <span>%</span>
    </div>
  );
}

function RowShell({ onRemove, gridClassName = "", children }) {
  return (
    <div className="row-shell">
      <div className={`row-grid ${gridClassName}`}>{children}</div>
      <button type="button" className="remove-btn" onClick={onRemove} aria-label="Remove entry">
        ✕
      </button>
    </div>
  );
}

// ---------- main component ----------
export default function InvestmentPlanner() {
  const [tab, setTab] = useState("profile");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [showCashFlowDetail, setShowCashFlowDetail] = useState(false);
  const [explainOpenKey, setExplainOpenKey] = useState(null);
  const [showProjection, setShowProjection] = useState(false);
  const [drillDownPeriod, setDrillDownPeriod] = useState(null);
  const [showFuturePayoff, setShowFuturePayoff] = useState(false);
  const [projectionMode, setProjectionMode] = useState("monthly"); // 'monthly' | 'annual'
  const [projectionPeriods, setProjectionPeriods] = useState("12");
  const [retirementExpense, setRetirementExpense] = useState("");
  const [withdrawalRate, setWithdrawalRate] = useState("4");
  const [propertyAppreciationRate, setPropertyAppreciationRate] = useState("3");
  const [showNetWorthChart, setShowNetWorthChart] = useState(false);
  const [netWorthYears, setNetWorthYears] = useState("20");
  const CURRENT_INFLATION_RATE = "3.5"; // headline CPI, June 2026 (BLS) — used as the default for growth-rate assumptions below
  const [rentGrowthRate, setRentGrowthRate] = useState(CURRENT_INFLATION_RATE);
  const [expenseGrowthRate, setExpenseGrowthRate] = useState(CURRENT_INFLATION_RATE);
  const [propertyCostGrowthRate, setPropertyCostGrowthRate] = useState(CURRENT_INFLATION_RATE);
  const [k401Balance, setK401Balance] = useState("");
  const [k401GrowthRate, setK401GrowthRate] = useState("7");
  const [k401Contribution, setK401Contribution] = useState("");
  const [k401ContributionGrowthRate, setK401ContributionGrowthRate] = useState(CURRENT_INFLATION_RATE);
  const [socialSecurityBenefit, setSocialSecurityBenefit] = useState("");
  const [targetRetirementAge, setTargetRetirementAge] = useState("");
  const [ssTaxRate, setSsTaxRate] = useState("15");

  // --- account management ---
  const [accounts, setAccounts] = useState([]); // [{id, name, updatedAt}]
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [accountStatus, setAccountStatus] = useState("");
  const [showNewAccountInput, setShowNewAccountInput] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");

  // --- profile authentication (one profile per email, holds many named accounts) ---
  const [authStage, setAuthStage] = useState("none"); // 'none' | 'in'
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'signup'
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPassword2, setAuthPassword2] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [currentProfile, setCurrentProfile] = useState(null); // { profileId, email }
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [changeOld, setChangeOld] = useState("");
  const [changeNew, setChangeNew] = useState("");
  const [changeNew2, setChangeNew2] = useState("");
  const [changeStatus, setChangeStatus] = useState("");

  // 0. profile
  const [age, setAge] = useState("");
  const [riskTolerance, setRiskTolerance] = useState("moderate");
  const [marketMortgageRate, setMarketMortgageRate] = useState("6.75");
  const [marketCdRate, setMarketCdRate] = useState("4.0");
  const [emergencyMonths, setEmergencyMonths] = useState("6");
  const [payoffThreshold, setPayoffThreshold] = useState("10000");
  const [country, setCountry] = useState("United States");
  const [currency, setCurrency] = useState("USD");
  const currencySymbol = getCurrencySymbol(currency);
  // shadow the module-level formatters so every money()/moneyPrecise() call in this component
  // automatically uses the selected currency without touching each call site
  const money = (v) => moneyBase(v, currency);
  const moneyPrecise = (v) => moneyPreciseBase(v, currency);

  // 1. income
  const [grossIncome, setGrossIncome] = useState("");
  const [netIncome, setNetIncome] = useState("");
  const [incomeGrowthRate, setIncomeGrowthRate] = useState(CURRENT_INFLATION_RATE);

  // 2. CDs
  const [cds, setCds] = useState([{ id: uid(), label: "CD 1", amount: "", rate: marketCdRate }]);
  const [recurringDeposits, setRecurringDeposits] = useState([]);
  const [plannedItems, setPlannedItems] = useState([]);
  const [collapsedPlannedIds, setCollapsedPlannedIds] = useState([]);

  // 3. savings / checking
  const [savings, setSavings] = useState("");
  const [checking, setChecking] = useState("");

  // 4. properties
  const [properties, setProperties] = useState([
    { id: uid(), label: "Primary residence", type: "self", value: "", loanBalance: "", monthlyMortgage: "", mortgageRate: "", rentalIncome: "", propertyTax: "", hoa: "", managementFee: "" },
  ]);

  // 5. shares
  const [shares, setShares] = useState([
    { id: uid(), ticker: "", quantity: "", price: "", dividendValue: "" },
  ]);
  const [sharesReturn, setSharesReturn] = useState("7");
  const [projectionYears, setProjectionYears] = useState("5");
  const [fetchStatus, setFetchStatus] = useState({}); // { [shareId]: { state: 'loading'|'done'|'error', message } }

  // 6. loans
  const [loans, setLoans] = useState([{ id: uid(), label: "Car loan", balance: "", rate: "", payment: "" }]);

  // 7. expenses
  const [expenses, setExpenses] = useState({
    utilities: "", groceries: "", dining: "", gas: "",
    insurance: "", subscriptions: "", shopping: "", personalCare: "",
    travel: "", childcareEducation: "", healthcare: "", petCare: "", entertainment: "", giftsDonations: "", other: "",
  });

  const tabs = [
    { key: "profile", label: "Profile" },
    { key: "income", label: "Income" },
    { key: "liquid", label: "Cash & Deposits" },
    { key: "property", label: "Property" },
    { key: "shares", label: "Shares" },
    { key: "debt", label: "Debt" },
    { key: "expenses", label: "Expenses" },
    { key: "retirement", label: "Retirement" },
    { key: "networth", label: "Net Worth" },
  ];

  // ---------- row managers ----------
  const addCd = () => setCds((c) => [...c, { id: uid(), label: `CD ${c.length + 1}`, amount: "", rate: marketCdRate }]);
  const removeCd = (id) => setCds((c) => c.filter((x) => x.id !== id));
  const updateCd = (id, key, val) => setCds((c) => c.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  const todayStr = () => new Date().toISOString().slice(0, 10);

  // The date all Net Worth / trajectory calculations treat as "Now" — separate from the live browser
  // date, so a saved snapshot stays anchored to when it was actually saved rather than silently drifting
  // forward every time the app is reopened. Defaults to today for a brand-new session/account.
  const [snapshotDate, setSnapshotDate] = useState(todayStr());
  const snapshotDateObj = new Date(snapshotDate + "T00:00:00");
  const [showSnapshotPrompt, setShowSnapshotPrompt] = useState(false);

  const addRD = () =>
    setRecurringDeposits((r) => [
      ...r,
      { id: uid(), label: `Recurring Deposit ${r.length + 1}`, frequency: "monthly", rate: "", depositAmount: "", startDate: todayStr(), tenureValue: "", tenureUnit: "years" },
    ]);
  const removeRD = (id) => setRecurringDeposits((r) => r.filter((x) => x.id !== id));
  const updateRD = (id, key, val) => setRecurringDeposits((r) => r.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  const currentYear = () => snapshotDateObj.getFullYear();
  const addPlannedItem = () =>
    setPlannedItems((p) => [
      ...p,
      { id: uid(), label: "", category: "Other", type: "liability", fundingSource: "none", amount: "", year: String(currentYear() + 1) },
    ]);
  const removePlannedItem = (id) => {
    setPlannedItems((p) => p.filter((x) => x.id !== id));
    setCollapsedPlannedIds((c) => c.filter((x) => x !== id));
  };
  const updatePlannedItem = (id, key, val) => setPlannedItems((p) => p.map((x) => (x.id === id ? { ...x, [key]: val } : x)));
  const togglePlannedCollapse = (id) => setCollapsedPlannedIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const addShare = () => setShares((s) => [...s, { id: uid(), ticker: "", quantity: "", price: "", dividendValue: "" }]);
  const removeShare = (id) => setShares((s) => s.filter((x) => x.id !== id));
  const updateShare = (id, key, val) => setShares((s) => s.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  const lookupShare = async (id, ticker) => {
    const symbol = (ticker || "").trim();
    if (!symbol) return;
    setFetchStatus((f) => ({ ...f, [id]: { state: "loading" } }));
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lookup-share`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ symbol }),
      });
      const parsed = await response.json();

      if (!response.ok || !parsed.found) {
        setFetchStatus((f) => ({ ...f, [id]: { state: "error", message: parsed?.error || "Ticker not found" } }));
        return;
      }

      setShares((s) =>
        s.map((x) =>
          x.id === id
            ? {
                ...x,
                price: String(parsed.price ?? x.price),
                dividendValue: String(parsed.quarterlyDividendPerShare ?? 0),
              }
            : x
        )
      );
      const sourceLabel = parsed.source ? `${parsed.source} · ${parsed.asOf || ""}`.trim() : parsed.asOf || "Updated";
      setFetchStatus((f) => ({ ...f, [id]: { state: "done", message: sourceLabel } }));
    } catch (err) {
      setFetchStatus((f) => ({ ...f, [id]: { state: "error", message: "Couldn't fetch — enter manually" } }));
    }
  };

  const addProperty = () =>
    setProperties((p) => [
      ...p,
      { id: uid(), label: `Property ${p.length + 1}`, type: "rental", value: "", loanBalance: "", monthlyMortgage: "", mortgageRate: "", rentalIncome: "", propertyTax: "", hoa: "", managementFee: "" },
    ]);
  const removeProperty = (id) => setProperties((p) => p.filter((x) => x.id !== id));
  const updateProperty = (id, key, val) => setProperties((p) => p.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  const addLoan = () => setLoans((l) => [...l, { id: uid(), label: "Personal loan", balance: "", rate: "", payment: "" }]);
  const removeLoan = (id) => setLoans((l) => l.filter((x) => x.id !== id));
  const updateLoan = (id, key, val) => setLoans((l) => l.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  const updateExpense = (key, val) => setExpenses((e) => ({ ...e, [key]: val }));

  // ---------- account persistence (per logged-in profile) ----------

  const serializeProfile = () => ({
    age, riskTolerance, marketMortgageRate, marketCdRate, emergencyMonths, payoffThreshold, country, currency,
    grossIncome, netIncome, incomeGrowthRate, cds, recurringDeposits, plannedItems, savings, checking, properties,
    shares, sharesReturn, projectionYears, loans, expenses,
    retirementExpense, withdrawalRate, propertyAppreciationRate,
    rentGrowthRate, expenseGrowthRate, propertyCostGrowthRate, k401Balance, k401GrowthRate,
    k401Contribution, k401ContributionGrowthRate,
    socialSecurityBenefit, targetRetirementAge, ssTaxRate,
    snapshotDate,
  });

  const applyProfile = (d) => {
    if (!d) return;
    setAge(d.age ?? "");
    setSnapshotDate(d.snapshotDate || todayStr());
    setCountry(d.country ?? "United States");
    setCurrency(d.currency ?? "USD");
    setRiskTolerance(d.riskTolerance ?? "moderate");
    setMarketMortgageRate(d.marketMortgageRate ?? "6.75");
    setMarketCdRate(d.marketCdRate ?? "4.0");
    setEmergencyMonths(d.emergencyMonths ?? "6");
    setPayoffThreshold(d.payoffThreshold ?? "10000");
    setGrossIncome(d.grossIncome ?? "");
    setNetIncome(d.netIncome ?? "");
    setIncomeGrowthRate(d.incomeGrowthRate ?? CURRENT_INFLATION_RATE);
    setCds(d.cds && d.cds.length ? d.cds : [{ id: uid(), label: "CD 1", amount: "", rate: marketCdRate }]);
    setRecurringDeposits(d.recurringDeposits || []);
    setPlannedItems(d.plannedItems || []);
    setSavings(d.savings ?? "");
    setChecking(d.checking ?? "");
    setProperties(
      d.properties && d.properties.length
        ? d.properties
        : [{ id: uid(), label: "Primary residence", type: "self", value: "", loanBalance: "", monthlyMortgage: "", mortgageRate: "", rentalIncome: "", propertyTax: "", hoa: "", managementFee: "" }]
    );
    setShares(d.shares && d.shares.length ? d.shares : [{ id: uid(), ticker: "", quantity: "", price: "", dividendValue: "" }]);
    setSharesReturn(d.sharesReturn ?? "7");
    setProjectionYears(d.projectionYears ?? "5");
    setLoans(d.loans && d.loans.length ? d.loans : [{ id: uid(), label: "Car loan", balance: "", rate: "", payment: "" }]);
    setExpenses({
      utilities: "", groceries: "", dining: "", gas: "", insurance: "", subscriptions: "", shopping: "", personalCare: "",
      travel: "", childcareEducation: "", healthcare: "", petCare: "", entertainment: "", giftsDonations: "", other: "",
      ...(d.expenses || {}),
    });
    setRetirementExpense(d.retirementExpense ?? "");
    setWithdrawalRate(d.withdrawalRate ?? "4");
    setPropertyAppreciationRate(d.propertyAppreciationRate ?? "3");
    setRentGrowthRate(d.rentGrowthRate ?? CURRENT_INFLATION_RATE);
    setExpenseGrowthRate(d.expenseGrowthRate ?? CURRENT_INFLATION_RATE);
    setPropertyCostGrowthRate(d.propertyCostGrowthRate ?? CURRENT_INFLATION_RATE);
    setK401Balance(d.k401Balance ?? "");
    setK401GrowthRate(d.k401GrowthRate ?? "7");
    setK401Contribution(d.k401Contribution ?? "");
    setK401ContributionGrowthRate(d.k401ContributionGrowthRate ?? CURRENT_INFLATION_RATE);
    setSocialSecurityBenefit(d.socialSecurityBenefit ?? "");
    setTargetRetirementAge(d.targetRetirementAge ?? "");
    setSsTaxRate(d.ssTaxRate ?? "15");
  };

  // Restore an existing Supabase session on load (e.g. page refresh) instead of forcing a fresh
  // login every time — Supabase's client persists the session in localStorage on its own.
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setCurrentProfile({ profileId: session.user.id, email: session.user.email });
        setAuthStage("in");
      }
    })();
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setCurrentProfile({ profileId: session.user.id, email: session.user.email });
      }
    });
    return () => authListener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!currentProfile) {
      setAccounts([]);
      setAccountsLoaded(true);
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase
          .from("accounts")
          .select("id, name, updated_at")
          .eq("user_id", currentProfile.profileId)
          .order("updated_at", { ascending: false });
        if (error) throw error;
        setAccounts((data || []).map((a) => ({ id: a.id, name: a.name, updatedAt: new Date(a.updated_at).getTime() })));
      } catch (e) {
        setAccounts([]);
      } finally {
        setAccountsLoaded(true);
      }
    })();
  }, [currentProfile]);

  const doSaveAccount = async (overrideSnapshotDate) => {
    if (!currentProfile || !activeAccountId) return;
    setAccountStatus("Saving…");
    try {
      const data = serializeProfile();
      if (overrideSnapshotDate) data.snapshotDate = overrideSnapshotDate;
      const { error } = await supabase
        .from("accounts")
        .update({ data, updated_at: new Date().toISOString() })
        .eq("id", activeAccountId)
        .eq("user_id", currentProfile.profileId);
      if (error) throw error;
      setAccounts((prev) => prev.map((a) => (a.id === activeAccountId ? { ...a, updatedAt: Date.now() } : a)));
      if (overrideSnapshotDate) setSnapshotDate(overrideSnapshotDate);
      setAccountStatus("Saved");
      setTimeout(() => setAccountStatus(""), 2500);
    } catch (e) {
      setAccountStatus(`Couldn't save: ${e?.message || "unknown error"}`);
    }
  };

  const saveAccount = async () => {
    if (!currentProfile) {
      setAuthError("Log in first to save an account.");
      return;
    }
    if (!activeAccountId) {
      setShowNewAccountInput(true);
      return;
    }
    // If the data has moved on from the saved snapshot date, ask before silently rolling "Now" forward —
    // otherwise just save, since there's nothing to reconcile.
    if (snapshotDate !== todayStr()) {
      setShowSnapshotPrompt(true);
      return;
    }
    await doSaveAccount();
  };

  const handleSnapshotChoice = async (updateToToday) => {
    setShowSnapshotPrompt(false);
    await doSaveAccount(updateToToday ? todayStr() : undefined);
  };

  const createAccount = async () => {
    if (!currentProfile) {
      setAuthError("Log in first to create an account.");
      return;
    }
    const name = newAccountName.trim();
    if (!name) return;
    setAccountStatus("Creating…");
    try {
      const freshSnapshotDate = todayStr();
      const data = { ...serializeProfile(), snapshotDate: freshSnapshotDate };
      const { data: inserted, error } = await supabase
        .from("accounts")
        .insert({ user_id: currentProfile.profileId, name, data })
        .select("id, name, updated_at")
        .single();
      if (error) throw error;
      setAccounts((prev) => [{ id: inserted.id, name: inserted.name, updatedAt: new Date(inserted.updated_at).getTime() }, ...prev]);
      setActiveAccountId(inserted.id);
      setSnapshotDate(freshSnapshotDate);
      setNewAccountName("");
      setShowNewAccountInput(false);
      setAccountStatus("Account created");
      setTimeout(() => setAccountStatus(""), 2500);
    } catch (e) {
      setAccountStatus(`Couldn't create account: ${e?.message || "unknown error"}`);
    }
  };

  const switchAccount = async (id) => {
    if (!id) {
      setActiveAccountId(null);
      return;
    }
    if (!currentProfile) return;
    setAccountStatus("Loading…");
    try {
      const { data, error } = await supabase
        .from("accounts")
        .select("data")
        .eq("id", id)
        .eq("user_id", currentProfile.profileId)
        .single();
      if (error) throw error;
      applyProfile(data?.data || {});
      setActiveAccountId(id);
      setAccountStatus("");
    } catch (e) {
      setAccountStatus("Couldn't load account");
    }
  };

  const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const signup = async () => {
    setAuthError("");
    const email = authEmail.trim().toLowerCase();
    if (!isValidEmail(email)) {
      setAuthError("Enter a valid email address.");
      return;
    }
    if (authPassword.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    if (authPassword !== authPassword2) {
      setAuthError("Passwords don't match.");
      return;
    }
    setAuthBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email, password: authPassword });
      if (error) throw error;
      if (!data.session) {
        // Email confirmation is likely enabled on the Supabase project — see README.
        setAuthError("Account created. Check your email to confirm it, then log in.");
        setAuthBusy(false);
        return;
      }
      setCurrentProfile({ profileId: data.user.id, email: data.user.email });
      setAuthStage("in");
      setAuthPassword("");
      setAuthPassword2("");
      setAuthEmail("");
    } catch (e) {
      setAuthError(`Couldn't create profile: ${e?.message || "unknown error"}. Please try again.`);
    } finally {
      setAuthBusy(false);
    }
  };

  const login = async () => {
    setAuthError("");
    const email = authEmail.trim().toLowerCase();
    if (!email || !authPassword) {
      setAuthError("Enter your email and password.");
      return;
    }
    setAuthBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
      if (error) throw error;
      setCurrentProfile({ profileId: data.user.id, email: data.user.email });
      setAuthStage("in");
      setAuthPassword("");
      setAuthEmail("");
    } catch (e) {
      setAuthError(e?.message || "Couldn't log in.");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setCurrentProfile(null);
    setAuthStage("none");
    setAuthMode("login");
    setAccounts([]);
    setActiveAccountId(null);
    setShowChangePassword(false);
  };

  const changePassword = async () => {
    setChangeStatus("");
    if (!currentProfile) return;
    if (changeNew.length < 8) {
      setChangeStatus("New password must be at least 8 characters.");
      return;
    }
    if (changeNew !== changeNew2) {
      setChangeStatus("New passwords don't match.");
      return;
    }
    try {
      // Re-verify the current password by signing in again before allowing the change.
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email: currentProfile.email, password: changeOld });
      if (verifyError) {
        setChangeStatus("Current password is incorrect.");
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: changeNew });
      if (error) throw error;
      setChangeStatus("Password updated.");
      setChangeOld("");
      setChangeNew("");
      setChangeNew2("");
      setTimeout(() => {
        setShowChangePassword(false);
        setChangeStatus("");
      }, 1500);
    } catch (e) {
      setChangeStatus(`Couldn't update password: ${e?.message || "unknown error"}`);
    }
  };

  const activeAccountName = accounts.find((a) => a.id === activeAccountId)?.name || "unsaved-profile";
  const exportJsonText = () => JSON.stringify({ name: activeAccountName, exportedAt: new Date().toISOString(), data: serializeProfile() }, null, 2);

  const copyExportJson = async () => {
    try {
      await navigator.clipboard.writeText(exportJsonText());
      setExportStatus("Copied to clipboard");
    } catch (e) {
      setExportStatus("Couldn't copy automatically — select the text below and copy manually.");
    }
    setTimeout(() => setExportStatus(""), 3000);
  };

  const downloadExportJson = () => {
    try {
      const blob = new Blob([exportJsonText()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeAccountName.replace(/[^a-z0-9-_]+/gi, "_")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportStatus("Download started");
    } catch (e) {
      setExportStatus("Download not supported here — use Copy instead.");
    }
    setTimeout(() => setExportStatus(""), 3000);
  };

  const importFromJsonText = (text, sourceLabel) => {
    try {
      const parsed = JSON.parse(text);
      // accept either the full export wrapper ({ name, exportedAt, data }) or a bare data object
      const data = parsed && typeof parsed === "object" && parsed.data ? parsed.data : parsed;
      if (!data || typeof data !== "object") throw new Error("not an object");
      applyProfile(data);
      setActiveAccountId(null); // this is now unsaved local data until the user explicitly saves it
      setImportStatus(`Loaded${parsed?.name ? ` "${parsed.name}"` : ""}${sourceLabel ? ` from ${sourceLabel}` : ""} — use "Save as…" below to keep it.`);
      setImportText("");
    } catch (e) {
      setImportStatus("Couldn't read that as a valid profile export — check it's the unedited JSON from Export profile.");
    }
  };

  const loadPastedImport = () => {
    if (!importText.trim()) return;
    importFromJsonText(importText, "pasted text");
  };

  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => importFromJsonText(String(evt.target.result), file.name);
    reader.onerror = () => setImportStatus("Couldn't read that file.");
    reader.readAsText(file);
    e.target.value = ""; // allow re-selecting the same file later
  };

  // ---------- computed summary ----------
  const summary = useMemo(() => {
    const totalCds = cds.reduce((s, c) => s + num(c.amount), 0);
    const weightedCdRate =
      totalCds > 0 ? cds.reduce((s, c) => s + num(c.amount) * num(c.rate), 0) / totalCds : 0;

    // --- recurring deposits ---
    const today = new Date(snapshotDateObj);
    const rdComputed = recurringDeposits.map((r) => {
      const periodsPerYear = RD_PERIODS_PER_YEAR[r.frequency] || 12;
      const avgDaysPerPeriod = RD_AVG_DAYS_PER_PERIOD[r.frequency] || 30.44;
      const tenureYears = r.tenureUnit === "years" ? num(r.tenureValue) : num(r.tenureValue) / 12;
      const nTotal = Math.round(periodsPerYear * tenureYears);
      const startDateObj = r.startDate ? new Date(r.startDate + "T00:00:00") : null;
      const endDateObj = rdEndDate(r.startDate, r.tenureValue, r.tenureUnit);
      const daysElapsed = startDateObj ? (today - startDateObj) / (1000 * 60 * 60 * 24) : -1;
      // deposits are made at the START of each period (annuity due), so a plan whose start date has
      // arrived has already made its first deposit even before a full period has elapsed — hence the +1.
      const periodsElapsedRaw = daysElapsed >= 0 ? Math.floor(daysElapsed / avgDaysPerPeriod) + 1 : 0;
      const periodsElapsed = Math.min(nTotal, Math.max(0, periodsElapsedRaw));
      const isActive = startDateObj && endDateObj ? today >= startDateObj && today < endDateObj : false;
      const currentValue = rdFutureValue(num(r.depositAmount), num(r.rate), periodsPerYear, periodsElapsed);
      const maturityValue = rdFutureValue(num(r.depositAmount), num(r.rate), periodsPerYear, nTotal);
      const monthlyDepositEquivalent = isActive ? num(r.depositAmount) * (periodsPerYear / 12) : 0;
      return { ...r, periodsPerYear, nTotal, endDateObj, periodsElapsed, isActive, currentValue, maturityValue, monthlyDepositEquivalent };
    });
    const totalRDCurrentValue = rdComputed.reduce((s, r) => s + r.currentValue, 0);
    const totalRDMaturityValue = rdComputed.reduce((s, r) => s + r.maturityValue, 0);
    const totalRDMonthlyDeposit = rdComputed.reduce((s, r) => s + r.monthlyDepositEquivalent, 0);
    const weightedRDRate =
      totalRDCurrentValue > 0 ? rdComputed.reduce((s, r) => s + r.currentValue * num(r.rate), 0) / totalRDCurrentValue : 0;

    const liquid = num(savings) + num(checking);

    const totalPropertyValue = properties.reduce((s, p) => s + num(p.value), 0);
    const totalPropertyLoans = properties.reduce((s, p) => s + num(p.loanBalance), 0);
    const totalPropertyEquity = totalPropertyValue - totalPropertyLoans;
    const totalMortgagePayments = properties.reduce((s, p) => s + num(p.monthlyMortgage), 0);
    const totalPropertyTax = properties.reduce((s, p) => s + num(p.propertyTax), 0);
    const totalHoa = properties.reduce((s, p) => s + num(p.hoa), 0);
    const totalManagementFees = properties.reduce((s, p) => s + num(p.managementFee), 0);
    const totalPropertyCarryCosts = totalPropertyTax + totalHoa + totalManagementFees;
    const totalRentalIncome = properties
      .filter((p) => p.type === "rental")
      .reduce((s, p) => s + num(p.rentalIncome), 0);

    const totalShares = shares.reduce((s, h) => s + num(h.quantity) * num(h.price), 0);
    const totalQuarterlyDividendIncome = shares.reduce((s, h) => s + num(h.quantity) * num(h.dividendValue), 0);
    const totalAnnualDividendIncome = totalQuarterlyDividendIncome * 4;
    const monthlyDividendIncome = totalAnnualDividendIncome / 12;

    const totalLoanBalance = loans.reduce((s, l) => s + num(l.balance), 0);
    const totalLoanPayments = loans.reduce((s, l) => s + num(l.payment), 0);
    const highInterestLoans = [...loans]
      .filter((l) => num(l.balance) > 0)
      .sort((a, b) => num(b.rate) - num(a.rate));

    const totalExpenses = Object.values(expenses).reduce((s, v) => s + num(v), 0);

    const netWorth = liquid + totalCds + totalRDCurrentValue + totalShares + totalPropertyEquity - totalLoanBalance + num(k401Balance);

    const afterTax = num(netIncome);
    const monthlyInflow = afterTax + totalRentalIncome + monthlyDividendIncome;
    const monthlyOutflow = totalMortgagePayments + totalPropertyCarryCosts + totalLoanPayments + totalExpenses + totalRDMonthlyDeposit;
    const monthlyCashFlow = monthlyInflow - monthlyOutflow;
    const savingsRate = afterTax > 0 ? (monthlyCashFlow / afterTax) * 100 : 0;

    const emMonths = Math.max(1, num(emergencyMonths) || 6);
    const emergencyTarget = monthlyOutflow * emMonths;
    const emergencyCurrent = liquid;
    const emergencyGap = Math.max(0, emergencyTarget - emergencyCurrent);

    // --- age & risk based target allocation ---
    const ageNum = num(age);
    const hasAge = ageNum > 0;
    const baseEquityPct = hasAge ? 110 - ageNum : 65;
    const riskAdj = riskTolerance === "conservative" ? -15 : riskTolerance === "aggressive" ? 15 : 0;
    const targetEquityPct = Math.min(95, Math.max(10, baseEquityPct + riskAdj));
    const targetFixedPct = 100 - targetEquityPct;

    const investablePortfolio = totalCds + totalRDCurrentValue + totalShares;
    const currentEquityPct = investablePortfolio > 0 ? (totalShares / investablePortfolio) * 100 : 0;
    const currentFixedPct = 100 - currentEquityPct;
    const allocationGapPct = targetEquityPct - currentEquityPct;

    // --- mortgage refinance opportunities (one-time) ---
    const marketRate = num(marketMortgageRate);
    const refinanceOpportunities = properties
      .filter((p) => num(p.loanBalance) > 0 && p.mortgageRate !== "" && num(p.mortgageRate) - marketRate > 0.375)
      .map((p) => {
        const rateDiff = num(p.mortgageRate) - marketRate;
        const estMonthlySavings = (num(p.loanBalance) * (rateDiff / 100)) / 12;
        return {
          label: p.label || "Property",
          currentRate: num(p.mortgageRate),
          marketRate,
          estMonthlySavings,
          loanBalance: num(p.loanBalance),
        };
      });

    // --- unified debt list (loans + mortgages) for restructuring analysis ---
    const allDebts = [
      ...loans
        .filter((l) => num(l.balance) > 0 && num(l.rate) > 0)
        .map((l) => ({ key: `loan:${l.id}`, label: l.label || "Loan", balance: num(l.balance), rate: num(l.rate), kind: "loan", payment: num(l.payment) })),
      ...properties
        .filter((p) => num(p.loanBalance) > 0 && p.mortgageRate !== "" && num(p.mortgageRate) > 0)
        .map((p) => ({ key: `mortgage:${p.id}`, label: p.label || "Property", balance: num(p.loanBalance), rate: num(p.mortgageRate), kind: "mortgage", payment: num(p.monthlyMortgage) })),
    ].sort((a, b) => b.rate - a.rate);
    const debtPaymentByKey = {};
    allDebts.forEach((d) => (debtPaymentByKey[d.key] = d.payment));

    // --- pay off high-interest debt using excess cash, then CDs (one-time, near-certain) ---
    // Excess cash = checking + savings beyond the emergency reserve — never touches the reserve itself.
    const excessCash = Math.max(0, liquid - emergencyTarget);
    const payoffThresholdAmt = Math.max(0, num(payoffThreshold) || 10000);
    const remainingBalanceByKey = {};
    allDebts.forEach((d) => (remainingBalanceByKey[d.key] = d.balance));

    const liquidationOpportunities = [];
    let remainingCash = excessCash;
    let remainingCds = totalCds;
    let remainingRD = totalRDCurrentValue;
    for (const d of allDebts) {
      let bal = remainingBalanceByKey[d.key];

      if (remainingCash > 0 && bal > 0) {
        const useCash = Math.min(remainingCash, bal);
        if (useCash >= payoffThresholdAmt) {
          const resultingBalance = bal - useCash;
          liquidationOpportunities.push({
            debt: d.label,
            debtKey: d.key,
            debtRate: d.rate,
            source: `excess cash (checking/savings above your ${emMonths}-month reserve)`,
            sourceType: "cash",
            amount: useCash,
            resultingBalance,
            note: `This cash is sitting beyond your ${money(emergencyTarget)} emergency target earning little or no interest, while this debt costs ${pct(d.rate)} — paying it down is a guaranteed win with no penalty. Balance would drop from ${money(bal)} to ${money(resultingBalance)}.`,
          });
          remainingCash -= useCash;
          bal = resultingBalance;
        }
      }

      if (remainingCds > 0 && bal > 0 && d.rate > weightedCdRate + 0.5) {
        const useCd = Math.min(remainingCds, bal);
        if (useCd >= payoffThresholdAmt) {
          const resultingBalance = bal - useCd;
          liquidationOpportunities.push({
            debt: d.label,
            debtKey: d.key,
            debtRate: d.rate,
            source: "CD funds",
            sourceType: "cd",
            amount: useCd,
            resultingBalance,
            note: `Paying ${pct(d.rate)} on this debt while CDs earn ${pct(weightedCdRate)} — redirecting CD funds here is close to a guaranteed gain (check early-withdrawal penalties first). Balance would drop from ${money(bal)} to ${money(resultingBalance)}.`,
          });
          remainingCds -= useCd;
          bal = resultingBalance;
        }
      }

      if (remainingRD > 0 && bal > 0 && d.rate > weightedRDRate + 0.5) {
        const useRD = Math.min(remainingRD, bal);
        if (useRD >= payoffThresholdAmt) {
          const resultingBalance = bal - useRD;
          liquidationOpportunities.push({
            debt: d.label,
            debtKey: d.key,
            debtRate: d.rate,
            source: "recurring deposit funds",
            sourceType: "rd",
            amount: useRD,
            resultingBalance,
            note: `Paying ${pct(d.rate)} on this debt while your recurring deposits earn ${pct(weightedRDRate)} — breaking one to pay this down is close to a guaranteed gain (check premature-withdrawal penalties first). Balance would drop from ${money(bal)} to ${money(resultingBalance)}.`,
          });
          remainingRD -= useRD;
          bal = resultingBalance;
        }
      }

      remainingBalanceByKey[d.key] = bal;
    }

    // --- cost-of-capital restructuring: liquidate shares vs. pay off remaining debt (after cash/CD paydown above) ---
    const growthRate = num(sharesReturn);
    const dividendYieldPct = totalShares > 0 ? (totalAnnualDividendIncome / totalShares) * 100 : 0;
    const totalExpectedReturn = growthRate + dividendYieldPct;
    const projYears = Math.max(1, num(projectionYears) || 5);

    const payoffSpreadThreshold = riskTolerance === "conservative" ? 0 : riskTolerance === "aggressive" ? -2 : -1;
    const investSpreadThreshold = riskTolerance === "conservative" ? 3 : riskTolerance === "aggressive" ? 1 : 2;

    const restructureAnalysis =
      totalShares > 0
        ? allDebts
            .filter((d) => remainingBalanceByKey[d.key] > 0)
            .map((d) => {
              const balance = remainingBalanceByKey[d.key];
              const spread = totalExpectedReturn - d.rate;
              const amount = Math.min(balance, totalShares);
              const resultingBalance = balance - amount;
              const fvInvest = amount * Math.pow(1 + totalExpectedReturn / 100, projYears);
              const fvPayoff = amount * Math.pow(1 + d.rate / 100, projYears);
              const netAdvantage = fvInvest - fvPayoff;
              let verdict = "borderline";
              if (spread <= payoffSpreadThreshold) verdict = "payoff";
              else if (spread >= investSpreadThreshold) verdict = "invest";
              const meetsThreshold = amount >= payoffThresholdAmt;
              return { ...d, balance, spread, amount, resultingBalance, fvInvest, fvPayoff, netAdvantage, verdict, meetsThreshold };
            })
        : [];

    // --- future payoff proposals ---
    // CDAmount starts from what's left AFTER today's cash/CD/RD/share actions above — never double-counts
    // money already recommended today. Grows monthly at each pool's own rate; every month, checks whether
    // the pool has crossed the minimum payoff threshold, and if so, proposes liquidating it against the
    // highest-rate qualifying debt (rate above that pool's own rate) — same rule as today's one-time actions,
    // just applied prospectively. A pool can trigger more than once over time as it rebuilds after each use.
    const actionableTodayKeys = new Set(
      restructureAnalysis.filter((r) => r.verdict === "payoff" && r.meetsThreshold).map((r) => r.key)
    );
    const todaySharesUsed = restructureAnalysis
      .filter((r) => actionableTodayKeys.has(r.key))
      .reduce((s, r) => s + r.amount, 0);

    const futurePayoffProjection = [];
    {
      const marketCdRatePct = num(marketCdRate) || weightedCdRate;
      const monthlyCdRate = Math.pow(1 + marketCdRatePct / 100, 1 / 12) - 1;
      const monthlyRdRate = Math.pow(1 + weightedRDRate / 100, 1 / 12) - 1;
      const monthlyShareRate = Math.pow(1 + totalExpectedReturn / 100, 1 / 12) - 1;
      // net monthly cash flow surplus builds both pools, same 70/30 split as the Suggested Monthly Allocation
      const monthlyShareContribution = Math.max(0, monthlyCashFlow) * 0.7;
      const monthlyCdContribution = Math.max(0, monthlyCashFlow) * 0.3;

      let projCds = remainingCds; // CD balance not already used in a payoff recommendation above
      let projRD = remainingRD;
      let projShares = Math.max(0, totalShares - todaySharesUsed);

      const openDebts = allDebts
        .filter((d) => remainingBalanceByKey[d.key] > 0 && !actionableTodayKeys.has(d.key))
        .map((d) => ({ ...d, balance: remainingBalanceByKey[d.key] }));

      const today = new Date(snapshotDateObj);
      const maxMonths = 360; // 30-year cap

      for (let m = 1; m <= maxMonths && openDebts.some((d) => d.balance > 0); m++) {
        projCds = projCds * (1 + monthlyCdRate) + monthlyCdContribution;
        projRD *= 1 + monthlyRdRate;
        projShares = projShares * (1 + monthlyShareRate) + monthlyShareContribution;

        const futureDate = new Date(today);
        futureDate.setMonth(futureDate.getMonth() + m);
        const monthLabel = futureDate.toLocaleDateString(undefined, { month: "short", year: "numeric" });

        if (projCds >= payoffThresholdAmt) {
          const target = openDebts.filter((d) => d.balance > 0 && d.rate > marketCdRatePct + 0.5).sort((a, b) => b.rate - a.rate)[0];
          if (target) {
            const amt = Math.min(projCds, target.balance);
            futurePayoffProjection.push({
              month: m, monthLabel, source: "CD funds", sourceRate: marketCdRatePct,
              debt: target.label, debtKey: target.key, debtRate: target.rate, amount: amt, resultingBalance: target.balance - amt,
            });
            target.balance -= amt;
            projCds -= amt;
          }
        }

        if (projRD >= payoffThresholdAmt) {
          const target = openDebts.filter((d) => d.balance > 0 && d.rate > weightedRDRate + 0.5).sort((a, b) => b.rate - a.rate)[0];
          if (target) {
            const amt = Math.min(projRD, target.balance);
            futurePayoffProjection.push({
              month: m, monthLabel, source: "recurring deposit funds", sourceRate: weightedRDRate,
              debt: target.label, debtKey: target.key, debtRate: target.rate, amount: amt, resultingBalance: target.balance - amt,
            });
            target.balance -= amt;
            projRD -= amt;
          }
        }

        if (projShares >= payoffThresholdAmt) {
          const target = openDebts
            .filter((d) => d.balance > 0 && totalExpectedReturn - d.rate <= payoffSpreadThreshold)
            .sort((a, b) => b.rate - a.rate)[0];
          if (target) {
            const amt = Math.min(projShares, target.balance);
            futurePayoffProjection.push({
              month: m, monthLabel, source: "share liquidation", sourceRate: totalExpectedReturn,
              debt: target.label, debtKey: target.key, debtRate: target.rate, amount: amt, resultingBalance: target.balance - amt,
            });
            target.balance -= amt;
            projShares -= amt;
          }
        }
      }
    }

    // --- allocation heuristic ---
    let surplus = Math.max(0, monthlyCashFlow);
    const plan = [];

    if (surplus > 0 && emergencyGap > 0) {
      const toEmergency = Math.min(surplus * 0.5, emergencyGap);
      if (toEmergency > 0) {
        plan.push({ label: "Build emergency fund", amount: toEmergency, note: `${money(emergencyCurrent)} of ${money(emergencyTarget)} target (${emMonths} mo. of obligations)` });
        surplus -= toEmergency;
      }
    }

    const debtThreshold = 7; // rough long-run market-return benchmark
    for (const l of highInterestLoans) {
      if (surplus <= 0) break;
      if (num(l.rate) > debtThreshold) {
        const bal = num(l.balance);
        const toDebt = Math.min(surplus, bal);
        if (toDebt > 0) {
          const resultingBalance = bal - toDebt;
          plan.push({
            label: `Extra payment: ${l.label || "loan"}`,
            amount: toDebt,
            note: `${pct(l.rate)} APR — above typical long-run market return. Balance would drop from ${money(bal)} to ${money(resultingBalance)}.`,
          });
          surplus -= toDebt;
        }
      }
    }

    if (surplus > 0) {
      const toRetirement = surplus * 0.7;
      const toLiquidInvest = surplus * 0.3;
      plan.push({ label: "Diversified investing (index funds / retirement accounts)", amount: toRetirement, note: "Long-term growth allocation" });
      plan.push({ label: "CDs / short-term savings", amount: toLiquidInvest, note: "Capital preservation & liquidity" });
    }

    // --- retirement readiness / FI number ---
    // Default annual retirement expense = current household expenses + property tax/HOA on self-occupied property
    // (rentals are excluded since those costs are offset by rental income, already reflected in cash flow).
    // This base then grows each year at the expense growth rate below (defaults to current inflation, overridable).
    const selfOccupiedCarryCosts = properties
      .filter((p) => p.type === "self")
      .reduce((s, p) => s + num(p.propertyTax) + num(p.hoa), 0);
    const defaultAnnualRetirementExpense = (totalExpenses + selfOccupiedCarryCosts) * 12;
    const annualRetirementExpense = num(retirementExpense) || defaultAnnualRetirementExpense;
    const withdrawalRatePct = num(withdrawalRate) || 4;
    const k401Now = num(k401Balance);

    const rentGrowthPct = num(rentGrowthRate) || 0;
    const expenseGrowthPct = num(expenseGrowthRate) || 0;
    const propCostGrowthPct = num(propertyCostGrowthRate) || 0;
    const incomeGrowthPct = num(incomeGrowthRate) || 0;
    const k401GrowthPct = num(k401GrowthRate) || 0;
    const FULL_RETIREMENT_AGE = 67;

    // Auto-estimate the Social Security benefit at FRA when it hasn't been entered, using the SSA's own
    // PIA formula: average indexed monthly earnings (approximated here by current gross monthly income,
    // capped at the taxable maximum) run through the 2026 bend points ($1,286 / $7,749) at 90% / 32% / 15%.
    // This is a simplification — the real formula uses your highest 35 years of wage-indexed earnings, not
    // a single current income snapshot — so treat it as a ballpark, and override it if you have a real SSA estimate.
    const SS_BEND_1 = 1286;
    const SS_BEND_2 = 7749;
    const SS_TAXABLE_MAX_MONTHLY = 184500 / 12;
    const estimatePIA = (monthlyEarnings) => {
      const aime = Math.min(monthlyEarnings, SS_TAXABLE_MAX_MONTHLY);
      if (aime <= 0) return 0;
      const tier1 = Math.min(aime, SS_BEND_1) * 0.9;
      const tier2 = Math.max(0, Math.min(aime, SS_BEND_2) - SS_BEND_1) * 0.32;
      const tier3 = Math.max(0, aime - SS_BEND_2) * 0.15;
      return tier1 + tier2 + tier3;
    };
    const defaultSsMonthlyAtFRA = country === "India" ? 0 : estimatePIA(num(grossIncome));
    const ssMonthlyAtFRA = num(socialSecurityBenefit) || defaultSsMonthlyAtFRA; // benefit at full retirement age (67), today's dollars, pre-tax
    const ssTaxRatePct = num(ssTaxRate) || 0;

    // Social Security's real early/delayed-claiming adjustment, approximated: claiming before 67 permanently
    // reduces the benefit (~6.7%/yr for the first 3 years early, ~5%/yr beyond that, floor at 62); claiming
    // after 67 adds an ~8%/yr delayed-retirement credit up to age 70. You're assumed to claim SS the same
    // year you retire, so an earlier retirement age both means less time to save AND a smaller SS check.
    const ssAdjustmentFactor = (claimAge) => {
      if (claimAge >= FULL_RETIREMENT_AGE) {
        const yearsDelayed = Math.min(70, claimAge) - FULL_RETIREMENT_AGE;
        return 1 + yearsDelayed * 0.08;
      }
      const monthsEarly = (FULL_RETIREMENT_AGE - Math.max(62, claimAge)) * 12;
      const first36 = Math.min(36, monthsEarly);
      const remaining = Math.max(0, monthsEarly - 36);
      const reduction = first36 * (5 / 900) + remaining * (5 / 1200);
      return Math.max(0.55, 1 - reduction);
    };

    // FI number if retirement happens `y` years from now (or, when hasAge is false, treated as a plain
    // years-from-now horizon with SS assumed active immediately as a simplification).
    const fiNumberAtYear = (y) => {
      const expenseAtYear = annualRetirementExpense * Math.pow(1 + expenseGrowthPct / 100, y);
      const claimAge = hasAge ? ageNum + y : FULL_RETIREMENT_AGE;
      const ssAdjustedMonthly = ssMonthlyAtFRA * ssAdjustmentFactor(claimAge);
      const ssAnnualGrossAtYear = ssAdjustedMonthly * 12 * Math.pow(1 + expenseGrowthPct / 100, y); // grown as a COLA proxy
      const ssAnnualAtYear = ssAnnualGrossAtYear * (1 - ssTaxRatePct / 100); // after-tax, since expenses are paid with after-tax dollars
      const fiNumberAtAge = Math.max(0, expenseAtYear - ssAnnualAtYear) / (withdrawalRatePct / 100);
      return { fiNumberAtAge, expenseAtYear, ssAnnualAtYear, ssAnnualGrossAtYear, claimAge };
    };

    const fiNumber = fiNumberAtYear(0).fiNumberAtAge;
    const retirementPortfolioNow = liquid + totalCds + totalRDCurrentValue + totalShares + k401Now;
    const fiProgressPct = fiNumber > 0 ? Math.min(999, (retirementPortfolioNow / fiNumber) * 100) : 0;

    const annualInvestContribution = Math.max(0, monthlyCashFlow) * 12; // year-0 reference figure, shown in the UI
    const targetAgeInput = num(targetRetirementAge);
    const hasTargetAge = targetAgeInput > 0 && hasAge;
    const k401ContributionNow = num(k401Contribution);
    const k401ContributionGrowthPct = num(k401ContributionGrowthRate) || 0;

    // simulate portfolio growth year by year regardless of mode, so we can read off any year's projected value
    const rdContributionAtYearForRetirement = (y) => {
      const today = new Date(snapshotDateObj);
      const futureDate = new Date(today);
      futureDate.setFullYear(futureDate.getFullYear() + y);
      return rdComputed.reduce((s, r) => {
        if (!r.endDateObj || !r.startDate) return s;
        const startDateObj = new Date(r.startDate + "T00:00:00");
        const stillActive = futureDate >= startDateObj && futureDate < r.endDateObj;
        return s + (stillActive ? r.monthlyDepositEquivalent * 12 : 0);
      }, 0);
    };

    const simulateToYear = (maxY) => {
      let simInvestable = liquid + totalCds + totalShares;
      let simRD = totalRDCurrentValue;
      let simK401 = k401Now;
      for (let y = 1; y <= maxY; y++) {
        const income_y = afterTax * Math.pow(1 + incomeGrowthPct / 100, y);
        const rent_y = totalRentalIncome * Math.pow(1 + rentGrowthPct / 100, y);
        const expenses_y = totalExpenses * Math.pow(1 + expenseGrowthPct / 100, y);
        const propCosts_y = totalPropertyCarryCosts * Math.pow(1 + propCostGrowthPct / 100, y);
        const cashFlow_y = (income_y + monthlyDividendIncome + rent_y) * 12 - (totalMortgagePayments + totalLoanPayments) * 12 - propCosts_y * 12 - expenses_y * 12;
        simInvestable = simInvestable * (1 + totalExpectedReturn / 100) + Math.max(0, cashFlow_y);
        // yearly cumulative: this year's balance = prior balance (with accrued interest) + this year's contribution
        simRD = simRD * (1 + weightedRDRate / 100) + rdContributionAtYearForRetirement(y);
        // 401(k)/PF contributions continue every year up to and including retirement, growing with raises/limit increases
        const k401Contribution_y = k401ContributionNow * Math.pow(1 + k401ContributionGrowthPct / 100, y);
        simK401 = simK401 * (1 + k401GrowthPct / 100) + k401Contribution_y;
      }
      return simInvestable + simRD + simK401;
    };

    let yearsToFI = null;
    let estRetirementAge = null;
    let readinessGap = null; // positive = surplus, negative = shortfall (only set when a target age is given)

    if (hasTargetAge) {
      const yearsFromNow = Math.max(0, targetAgeInput - ageNum);
      const { fiNumberAtAge } = fiNumberAtYear(yearsFromNow);
      const projectedPortfolio = simulateToYear(yearsFromNow);
      yearsToFI = yearsFromNow;
      estRetirementAge = targetAgeInput;
      readinessGap = projectedPortfolio - fiNumberAtAge;
    } else if (retirementPortfolioNow >= fiNumber) {
      yearsToFI = 0;
      estRetirementAge = hasAge ? ageNum : null;
    } else {
      for (let y = 1; y <= 60; y++) {
        const { fiNumberAtAge } = fiNumberAtYear(y);
        const projectedPortfolio = simulateToYear(y);
        if (projectedPortfolio >= fiNumberAtAge) {
          yearsToFI = y;
          estRetirementAge = hasAge ? ageNum + y : null;
          break;
        }
      }
    }

    const ssAtRetirement = estRetirementAge !== null ? fiNumberAtYear(yearsToFI || 0) : null;

    // the age actually used to adjust the *displayed* default estimate: manual target age wins if entered,
    // otherwise the calculated retirement age, otherwise fall back to full retirement age (67)
    const effectiveAgeForSsDefault = hasTargetAge ? targetAgeInput : estRetirementAge ?? FULL_RETIREMENT_AGE;
    const defaultSsMonthlyAtRetirement = ssMonthlyAtFRA * ssAdjustmentFactor(effectiveAgeForSsDefault);

    return {
      totalCds, weightedCdRate, liquid,
      rdComputed, totalRDCurrentValue, totalRDMaturityValue, totalRDMonthlyDeposit, weightedRDRate,
      totalPropertyValue, totalPropertyLoans, totalPropertyEquity, totalMortgagePayments, totalPropertyTax, totalHoa, totalManagementFees, totalPropertyCarryCosts, totalRentalIncome,
      totalShares, totalQuarterlyDividendIncome, totalAnnualDividendIncome, monthlyDividendIncome, totalLoanBalance, totalLoanPayments, highInterestLoans,
      totalExpenses, netWorth, afterTax, monthlyInflow, monthlyOutflow, monthlyCashFlow, savingsRate,
      emergencyTarget, emergencyCurrent, emergencyGap, emMonths, plan,
      hasAge, targetEquityPct, targetFixedPct, currentEquityPct, currentFixedPct, allocationGapPct, investablePortfolio,
      refinanceOpportunities, liquidationOpportunities, excessCash, futurePayoffProjection, debtPaymentByKey, payoffThresholdAmt,
      growthRate, dividendYieldPct, totalExpectedReturn, projYears, restructureAnalysis,
      annualRetirementExpense, defaultAnnualRetirementExpense, selfOccupiedCarryCosts, withdrawalRatePct, fiNumber,
      retirementPortfolioNow, fiProgressPct, yearsToFI, estRetirementAge, annualInvestContribution, k401Now,
      k401ContributionNow, k401ContributionGrowthPct,
      rentGrowthPct, expenseGrowthPct, propCostGrowthPct, incomeGrowthPct, k401GrowthPct,
      ssMonthlyAtFRA, defaultSsMonthlyAtFRA, defaultSsMonthlyAtRetirement, effectiveAgeForSsDefault, ssTaxRatePct, hasTargetAge, readinessGap, ssAnnualAtRetirement: ssAtRetirement?.ssAnnualAtYear ?? 0,
      ssClaimAgeAtRetirement: ssAtRetirement?.claimAge ?? null, fiNumberAtRetirement: ssAtRetirement?.fiNumberAtAge ?? fiNumber,
    };
  }, [
    cds, recurringDeposits, savings, checking, properties, shares, sharesReturn, projectionYears, loans, expenses, netIncome, grossIncome,
    age, riskTolerance, marketMortgageRate, marketCdRate, emergencyMonths, payoffThreshold, retirementExpense, withdrawalRate, country,
    rentGrowthRate, expenseGrowthRate, propertyCostGrowthRate, incomeGrowthRate, k401Balance, k401GrowthRate,
    k401Contribution, k401ContributionGrowthRate,
    socialSecurityBenefit, targetRetirementAge, ssTaxRate, refreshNonce,
  ]);

  const cashProjection = useMemo(() => {
    const startCash = summary.liquid;
    const rentGrowthPct = num(rentGrowthRate) || 0;
    const expenseGrowthPct = num(expenseGrowthRate) || 0;
    const propCostGrowthPct = num(propertyCostGrowthRate) || 0;
    const incomeGrowthPct = num(incomeGrowthRate) || 0;
    const flatOutflow = summary.totalMortgagePayments + summary.totalLoanPayments;
    const today = new Date(snapshotDateObj);

    // recurring deposit contributions stop once a plan matures partway through the projection window
    const rdOutflowAtMonth = (m) => {
      const futureDate = new Date(today);
      futureDate.setMonth(futureDate.getMonth() + m);
      return summary.rdComputed.reduce((s, r) => {
        if (!r.endDateObj || !r.startDate) return s;
        const startDateObj = new Date(r.startDate + "T00:00:00");
        const stillActive = futureDate >= startDateObj && futureDate < r.endDateObj;
        return s + (stillActive ? r.monthlyDepositEquivalent : 0);
      }, 0);
    };

    // once a future payoff proposal triggers for a debt, its monthly payment drops out of outflow from that month on
    const paidOffPaymentReductionAtMonth = (m) =>
      summary.futurePayoffProjection
        .filter((p) => p.month <= m)
        .reduce((s, p) => s + (summary.debtPaymentByKey[p.debtKey] || 0), 0);

    // full income/expense breakdown for a given month index (1-based), with each line grown from today
    // at its own rate — used both for the running cash total and the drill-down detail view
    const detailsAtMonth = (m) => {
      const years = m / 12;
      const income = summary.afterTax * Math.pow(1 + incomeGrowthPct / 100, years);
      const dividends = summary.monthlyDividendIncome; // held flat — no growth assumption entered for this
      const rent = summary.totalRentalIncome * Math.pow(1 + rentGrowthPct / 100, years);
      const expensesAmt = summary.totalExpenses * Math.pow(1 + expenseGrowthPct / 100, years);
      const propCosts = summary.totalPropertyCarryCosts * Math.pow(1 + propCostGrowthPct / 100, years);
      const rdOutflow = rdOutflowAtMonth(m);
      const mortgageLoanPayments = Math.max(0, flatOutflow - paidOffPaymentReductionAtMonth(m));
      const totalInflow = income + dividends + rent;
      const totalOutflow = mortgageLoanPayments + expensesAmt + propCosts + rdOutflow;
      return { income, dividends, rent, mortgageLoanPayments, expensesAmt, propCosts, rdOutflow, totalInflow, totalOutflow, netFlow: totalInflow - totalOutflow };
    };

    const periods =
      projectionMode === "monthly"
        ? Math.min(12, Math.max(1, Math.round(num(projectionPeriods)) || 12))
        : Math.min(10, Math.max(1, Math.round(num(projectionPeriods)) || 5));

    const maxMonths = projectionMode === "monthly" ? periods : periods * 12;
    let cumulative = startCash;
    const monthlyCumulative = [cumulative];
    for (let m = 1; m <= maxMonths; m++) {
      cumulative += detailsAtMonth(m).netFlow;
      monthlyCumulative.push(cumulative);
    }

    const rows = [];
    for (let i = 1; i <= periods; i++) {
      const monthIndex = projectionMode === "monthly" ? i : i * 12;
      rows.push({
        period: i,
        label: projectionMode === "monthly" ? `Month ${i}` : `Year ${i}`,
        cash: monthlyCumulative[monthIndex],
        details: detailsAtMonth(monthIndex),
      });
    }
    const maxAbs = Math.max(startCash, ...rows.map((r) => Math.abs(r.cash)), 1);
    return { startCash, monthlyFlow: summary.monthlyCashFlow, periods, rows, maxAbs, rentGrowthPct, expenseGrowthPct, propCostGrowthPct, incomeGrowthPct };
  }, [
    summary.liquid, summary.monthlyCashFlow, summary.afterTax, summary.monthlyDividendIncome,
    summary.totalMortgagePayments, summary.totalLoanPayments, summary.totalRentalIncome, summary.rdComputed,
    summary.totalExpenses, summary.totalPropertyCarryCosts, summary.futurePayoffProjection, summary.debtPaymentByKey,
    projectionMode, projectionPeriods, rentGrowthRate, expenseGrowthRate, propertyCostGrowthRate, incomeGrowthRate,
  ]);

  const buildNetWorthTrajectory = (applyPayoffs) => {
    const years = Math.min(40, Math.max(1, Math.round(num(netWorthYears)) || 20));
    const apprRate = num(propertyAppreciationRate) || 0;
    const cdRate = (num(marketCdRate) || summary.weightedCdRate) / 100; // new CD money earns today's market rate, not necessarily what old CDs happen to carry
    const rdRate = summary.weightedRDRate / 100;
    const shareReturn = summary.totalExpectedReturn / 100;

    let cdsVal = summary.totalCds;
    let rdVal = summary.totalRDCurrentValue;
    let sharesVal = summary.totalShares;
    let liquidVal = summary.liquid;
    let k401Val = summary.k401Now;
    const k401Rate = summary.k401GrowthPct / 100;

    // recurring deposit contributions: each plan keeps contributing (monthly deposit × 12, for a monthly
    // plan) until its own tenure ends, then stops — mirrors the cash flow projection's treatment.
    const today = new Date(snapshotDateObj);
    const baseYear = today.getFullYear();
    const rdContributionAtYear = (y) => {
      const futureDate = new Date(today);
      futureDate.setFullYear(futureDate.getFullYear() + y);
      return summary.rdComputed.reduce((s, r) => {
        if (!r.endDateObj || !r.startDate) return s;
        const startDateObj = new Date(r.startDate + "T00:00:00");
        const stillActive = futureDate >= startDateObj && futureDate < r.endDateObj;
        return s + (stillActive ? r.monthlyDepositEquivalent * 12 : 0);
      }, 0);
    };

    // this year's cash flow surplus, growing income/rent/expenses/property costs from today at their own rates
    const cashFlowSurplusAtYear = (y) => {
      const income_y = summary.afterTax * Math.pow(1 + summary.incomeGrowthPct / 100, y);
      const rent_y = summary.totalRentalIncome * Math.pow(1 + summary.rentGrowthPct / 100, y);
      const expenses_y = summary.totalExpenses * Math.pow(1 + summary.expenseGrowthPct / 100, y);
      const propCosts_y = summary.totalPropertyCarryCosts * Math.pow(1 + summary.propCostGrowthPct / 100, y);
      const inflow = (income_y + summary.monthlyDividendIncome + rent_y) * 12;
      const outflow = (summary.totalMortgagePayments + summary.totalLoanPayments) * 12 + propCosts_y * 12 + expenses_y * 12;
      return inflow - outflow;
    };

    // emergency fund target grows with expense inflation too — it's 6 (or however many) months of
    // obligations, and those obligations rise with inflation, so the dollar target should too.
    const emergencyTargetAtYear = (y) => summary.emergencyTarget * Math.pow(1 + summary.expenseGrowthPct / 100, Math.max(0, y - 1));

    // planned big items funded by cash or CD hit at their specific year, reducing that pool right away —
    // this is what can push liquid cash below the emergency target and trigger a refill below.
    const plannedCashHitAtYear = (y) =>
      plannedItems
        .filter((i) => i.fundingSource === "cash" && num(i.amount) > 0 && num(i.year) === baseYear + y)
        .reduce((s, i) => s + num(i.amount), 0);
    const plannedCdHitAtYear = (y) =>
      plannedItems
        .filter((i) => i.fundingSource === "cd" && num(i.amount) > 0 && num(i.year) === baseYear + y)
        .reduce((s, i) => s + num(i.amount), 0);

    let propState = properties.map((p) => ({
      key: `mortgage:${p.id}`,
      label: p.label || "Property",
      value: num(p.value),
      loanBalance: num(p.loanBalance),
      rate: num(p.mortgageRate) || 0,
      payment: num(p.monthlyMortgage) * 12,
    }));
    let loanState = loans.map((l) => ({
      key: `loan:${l.id}`,
      label: l.label || "Loan",
      balance: num(l.balance),
      rate: num(l.rate) || 0,
      payment: num(l.payment) * 12,
    }));

    // apply today's already-qualifying one-time actions (from "One-time actions to consider" and the
    // share cost-of-capital "Pay off" cards) right at the start, so the trajectory's baseline actually
    // reflects acting on today's recommendations rather than ignoring them.
    if (applyPayoffs) {
      const applyToDebt = (debtKey, amount) => {
        loanState = loanState.map((l) => (l.key === debtKey ? { ...l, balance: Math.max(0, l.balance - amount) } : l));
        propState = propState.map((pr) => (pr.key === debtKey ? { ...pr, loanBalance: Math.max(0, pr.loanBalance - amount) } : pr));
      };
      for (const opp of summary.liquidationOpportunities) {
        if (opp.sourceType === "cash") liquidVal = Math.max(0, liquidVal - opp.amount);
        else if (opp.sourceType === "cd") cdsVal = Math.max(0, cdsVal - opp.amount);
        else if (opp.sourceType === "rd") rdVal = Math.max(0, rdVal - opp.amount);
        applyToDebt(opp.debtKey, opp.amount);
      }
      for (const r of summary.restructureAnalysis) {
        if (r.verdict === "payoff" && r.meetsThreshold) {
          sharesVal = Math.max(0, sharesVal - r.amount);
          applyToDebt(r.key, r.amount);
        }
      }
    }

    const rows = [
      {
        year: 0, label: "Now",
        liquid: liquidVal, cds: cdsVal, rd: rdVal, shares: sharesVal, k401: k401Val,
        propertyValue: propState.reduce((s, p) => s + p.value, 0),
        propertyLoans: propState.reduce((s, p) => s + p.loanBalance, 0),
        otherLoans: loanState.reduce((s, l) => s + l.balance, 0),
        netWorth: liquidVal + cdsVal + rdVal + sharesVal + k401Val + propState.reduce((s, p) => s + (p.value - p.loanBalance), 0) - loanState.reduce((s, l) => s + l.balance, 0),
        emergencyTarget: summary.emergencyTarget,
      },
    ];

    for (let y = 1; y <= years; y++) {
      // planned cash/CD spending for this year hits first
      liquidVal = Math.max(0, liquidVal - plannedCashHitAtYear(y));
      cdsVal = Math.max(0, cdsVal - plannedCdHitAtYear(y));

      // this year's surplus: top up the (inflation-adjusted) emergency fund first if cash has fallen short —
      // e.g. after a big planned expense — then split whatever's left 70/30 the same way as the
      // Suggested Monthly Allocation plan. Capped at 50% of surplus per year, same as that plan, so a
      // large gap doesn't consume 100% of surplus here while the plan itself only commits up to half.
      let surplus_y = Math.max(0, cashFlowSurplusAtYear(y));
      const target_y = emergencyTargetAtYear(y);
      const gap_y = Math.max(0, target_y - liquidVal);
      if (gap_y > 0 && surplus_y > 0) {
        const toRefill = Math.min(surplus_y * 0.5, gap_y);
        liquidVal += toRefill;
        surplus_y -= toRefill;
      }
      const annualContribution_y = surplus_y * 0.7; // retirement/investing (shares)
      const annualCdContribution_y = surplus_y * 0.3; // CDs/short-term savings

      cdsVal = cdsVal * (1 + cdRate) + annualCdContribution_y;
      // yearly cumulative: this year's balance = prior balance (with accrued interest) + this year's contribution
      rdVal = rdVal * (1 + rdRate) + rdContributionAtYear(y);
      // 401(k)/PF: grows at its own rate, plus its annual contribution (also growing). Unlike the
      // Retirement Readiness simulation, this trajectory has no fixed "retirement year" to stop
      // contributions at, so they're modeled as continuing for the full projection — a simplification
      // worth knowing if you're projecting well past when you actually expect to retire.
      const k401Contribution_y = summary.k401ContributionNow * Math.pow(1 + summary.k401ContributionGrowthPct / 100, y);
      k401Val = k401Val * (1 + k401Rate) + k401Contribution_y;
      sharesVal = sharesVal * (1 + shareReturn) + annualContribution_y;

      propState = propState.map((p) => {
        const newValue = p.value * (1 + apprRate / 100);
        let newBalance = p.loanBalance;
        if (p.loanBalance > 0 && p.rate > 0) {
          const interest = p.loanBalance * (p.rate / 100);
          const principal = Math.max(0, p.payment - interest);
          newBalance = Math.max(0, p.loanBalance - principal);
        }
        return { ...p, value: newValue, loanBalance: newBalance };
      });

      loanState = loanState.map((l) => {
        let newBalance = l.balance;
        if (l.balance > 0 && l.rate > 0) {
          const interest = l.balance * (l.rate / 100);
          const principal = Math.max(0, l.payment - interest);
          newBalance = Math.max(0, l.balance - principal);
        }
        return { ...l, balance: newBalance };
      });

      // apply any future payoff proposals (CD, recurring deposit, or share-funded) that land in this year —
      // the liquidated asset and the paid-down debt both drop by the same amount. Only when requested.
      if (applyPayoffs) {
        const payoffsThisYear = summary.futurePayoffProjection.filter((p) => Math.ceil(p.month / 12) === y);
        for (const p of payoffsThisYear) {
          if (p.source === "CD funds") cdsVal = Math.max(0, cdsVal - p.amount);
          else if (p.source === "recurring deposit funds") rdVal = Math.max(0, rdVal - p.amount);
          else sharesVal = Math.max(0, sharesVal - p.amount);
          loanState = loanState.map((l) => (l.key === p.debtKey ? { ...l, balance: Math.max(0, l.balance - p.amount) } : l));
          propState = propState.map((pr) => (pr.key === p.debtKey ? { ...pr, loanBalance: Math.max(0, pr.loanBalance - p.amount) } : pr));
        }
      }

      const propertyValue = propState.reduce((s, p) => s + p.value, 0);
      const propertyLoans = propState.reduce((s, p) => s + p.loanBalance, 0);
      const otherLoans = loanState.reduce((s, l) => s + l.balance, 0);
      const netWorth = liquidVal + cdsVal + rdVal + sharesVal + k401Val + (propertyValue - propertyLoans) - otherLoans;
      rows.push({ year: y, label: String(baseYear + y), liquid: liquidVal, cds: cdsVal, rd: rdVal, shares: sharesVal, k401: k401Val, propertyValue, propertyLoans, otherLoans, netWorth, emergencyTarget: target_y });
    }

    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.netWorth)), 1);
    const annualContributionYear1 = Math.max(0, cashFlowSurplusAtYear(1)) * 0.7;
    const annualCdContributionYear1 = Math.max(0, cashFlowSurplusAtYear(1)) * 0.3;
    return { rows, years, maxAbs, annualContribution: annualContributionYear1, annualCdContribution: annualCdContributionYear1, apprRate };
  };

  const [netWorthTablePayoffsApplied, setNetWorthTablePayoffsApplied] = useState(false);
  const netWorthTableTrajectory = useMemo(
    () => buildNetWorthTrajectory(netWorthTablePayoffsApplied),
    [
      properties, loans, plannedItems,
      summary.totalCds, summary.totalRDCurrentValue, summary.weightedRDRate, summary.totalShares, summary.liquid, summary.weightedCdRate,
      summary.totalExpectedReturn, summary.monthlyCashFlow, summary.netWorth, summary.futurePayoffProjection,
      summary.liquidationOpportunities, summary.restructureAnalysis, summary.rdComputed,
      summary.afterTax, summary.incomeGrowthPct, summary.totalRentalIncome, summary.rentGrowthPct,
      summary.totalExpenses, summary.expenseGrowthPct, summary.totalPropertyCarryCosts, summary.propCostGrowthPct,
      summary.totalMortgagePayments, summary.totalLoanPayments, summary.monthlyDividendIncome, summary.emergencyTarget,
      summary.k401Now, summary.k401GrowthPct, summary.k401ContributionNow, summary.k401ContributionGrowthPct,
      netWorthYears, propertyAppreciationRate, marketCdRate, netWorthTablePayoffsApplied,
    ]
  );

  const ledgerLines = [
    { label: "Savings + checking", value: summary.liquid, positive: true },
    { label: "CDs", value: summary.totalCds, positive: true },
    { label: "Recurring deposits", value: summary.totalRDCurrentValue, positive: true },
    { label: "Shares", value: summary.totalShares, positive: true },
    { label: country === "India" ? "Provident Fund" : "401(k)", value: summary.k401Now, positive: true },
    { label: "Property equity", value: summary.totalPropertyEquity, positive: summary.totalPropertyEquity >= 0 },
    { label: "Loan balances", value: -summary.totalLoanBalance, positive: false },
  ];

  return (
    <CurrencyContext.Provider value={{ code: currency, symbol: currencySymbol }}>
    <div className="app">
      <style>{`
        * { box-sizing: border-box; }
        .app {
          --bg: #12161B;
          --panel: #1A1F26;
          --panel-2: #1F252D;
          --border: #262D36;
          --text: #EDEBE6;
          --muted: #8791A0;
          --emerald: #4FA88A;
          --rust: #C4694A;
          --gold: #D9A857;
          background: var(--bg);
          color: var(--text);
          font-family: 'Public Sans', 'Segoe UI', system-ui, sans-serif;
          min-height: 100%;
          padding: 28px 20px 60px;
        }
        .app em { font-style: normal; color: var(--muted); font-size: 11px; margin-left: 6px; }
        .header {
          max-width: 1180px; margin: 0 auto 24px; display: flex; align-items: baseline;
          justify-content: space-between; flex-wrap: wrap; gap: 8px;
          border-bottom: 1px solid var(--border); padding-bottom: 18px;
        }
        .header h1 {
          font-size: 26px; margin: 0; letter-spacing: 0.5px; font-weight: 700;
          color: var(--gold);
        }
        .header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; max-width: 480px; }
        .header .stamp {
          font-family: 'IBM Plex Mono', 'SFMono-Regular', monospace; font-size: 11px;
          color: var(--muted); border: 1px solid var(--border); padding: 6px 10px; border-radius: 4px;
        }
        .account-bar {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap; position: relative;
        }
        .account-bar select.type-select { padding: 8px 10px; font-size: 12.5px; }
        .account-status { white-space: nowrap; }
        .new-account-row {
          position: absolute; top: calc(100% + 8px); right: 0; z-index: 5;
          display: flex; gap: 6px; background: var(--panel); border: 1px solid var(--border);
          border-radius: 8px; padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        }
        .new-account-row .text-input { width: 160px; }

        .export-panel {
          position: absolute; top: calc(100% + 8px); right: 0; z-index: 6; width: 360px;
          background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
          padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        }
        .export-panel.snapshot-prompt { border-color: var(--gold); width: 380px; }
        .export-panel-header {
          display: flex; justify-content: space-between; align-items: center;
          font-size: 12.5px; font-weight: 600; color: var(--gold); margin-bottom: 4px;
        }
        .export-textarea {
          width: 100%; height: 160px; background: var(--panel-2); border: 1px solid var(--border);
          border-radius: 6px; color: var(--text); font-family: 'IBM Plex Mono', monospace;
          font-size: 10.5px; padding: 8px; resize: vertical; margin-top: 6px;
        }
        .export-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
        .import-file-label {
          display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; color: var(--muted);
        }
        .import-file-label input[type="file"] {
          font-size: 11.5px; color: var(--text); font-family: inherit;
        }

        .auth-wrap {
          min-height: 70vh; display: flex; align-items: center; justify-content: center; padding: 20px;
        }
        .auth-card {
          width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--border);
          border-radius: 12px; padding: 28px 26px;
        }
        .auth-title { font-size: 20px; text-align: center; margin: 4px 0 14px; color: var(--gold); }
        .auth-sub { font-size: 12.5px; color: var(--muted); text-align: center; margin: 0 0 18px; line-height: 1.5; }
        .auth-toggle {
          display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 16px;
        }
        .auth-toggle .mode-btn { flex: 1; padding: 9px; }
        .auth-input { margin-bottom: 12px; }
        .auth-error { color: var(--rust); font-size: 12px; margin: 4px 0 10px; text-align: center; }
        .auth-submit {
          width: 100%; background: var(--gold); border: none; color: #1a1409; font-weight: 700;
          padding: 11px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13.5px; margin-top: 4px;
        }
        .auth-submit:disabled { opacity: 0.6; cursor: not-allowed; }
        .auth-link {
          display: block; width: 100%; background: transparent; border: none; color: var(--muted);
          font-size: 12px; padding: 8px; cursor: pointer; font-family: inherit; text-align: center;
        }
        .auth-link:hover { color: var(--gold); }
        .auth-note { font-size: 11.5px; color: var(--muted); text-align: center; margin-top: 14px; line-height: 1.5; }

        .profile-bar {
          width: 100%; display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted);
          padding-bottom: 4px;
        }
        .profile-email { font-family: 'IBM Plex Mono', monospace; color: var(--text); }
        .profile-bar .auth-link { width: auto; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; }
        .change-password-panel { top: calc(100% + 4px); width: 300px; }
        .layout {
          max-width: 1180px; margin: 0 auto; display: grid;
          grid-template-columns: 1.15fr 0.85fr; gap: 22px; align-items: start;
        }
        @media (max-width: 880px) { .layout { grid-template-columns: 1fr; } }

        .panel {
          background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
          padding: 20px;
        }
        .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; }
        .tab-btn {
          background: transparent; border: 1px solid var(--border); color: var(--muted);
          padding: 8px 14px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
          font-family: inherit; transition: all .15s ease;
        }
        .tab-btn.active { background: var(--gold); border-color: var(--gold); color: #1a1409; font-weight: 600; }
        .tab-btn:hover:not(.active) { border-color: var(--gold); color: var(--text); }

        h2.section-title { font-size: 15px; margin: 0 0 4px; color: var(--text); }
        p.section-hint { color: var(--muted); font-size: 12.5px; margin: 0 0 18px; }

        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        @media (max-width: 500px) { .grid-2 { grid-template-columns: 1fr; } }

        .field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
        .field-label { color: var(--muted); font-weight: 500; }

        .money-input, .rate-input {
          display: flex; align-items: center; background: var(--panel-2);
          border: 1px solid var(--border); border-radius: 6px; padding: 0 10px;
        }
        .money-input span, .rate-input span { color: var(--muted); font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .money-input input, .rate-input input {
          background: transparent; border: none; outline: none; color: var(--text);
          font-family: 'IBM Plex Mono', monospace; font-size: 14px; padding: 10px 6px; width: 100%; min-width: 0;
        }
        .money-input input::-webkit-outer-spin-button, .money-input input::-webkit-inner-spin-button,
        .rate-input input::-webkit-outer-spin-button, .rate-input input::-webkit-inner-spin-button {
          -webkit-appearance: none; margin: 0;
        }
        .money-input input[type="number"], .rate-input input[type="number"] { -moz-appearance: textfield; }
        select.type-select {
          background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
          border-radius: 6px; padding: 10px; font-family: inherit; font-size: 13px;
        }
        input.text-input {
          background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
          border-radius: 6px; padding: 10px; font-family: inherit; font-size: 13px; outline: none;
        }

        .row-shell {
          display: flex; align-items: flex-end; gap: 8px; padding: 14px 0;
          border-bottom: 1px dashed var(--border);
        }
        .row-shell:last-of-type { border-bottom: none; }
        .row-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; flex: 1; }
        .row-grid.shares-grid { grid-template-columns: 1fr 1fr; row-gap: 14px; }
        .row-grid.shares-grid .field.full-width { grid-column: 1 / -1; }
        @media (max-width: 480px) { .row-grid.shares-grid { grid-template-columns: 1fr; } }
        .row-grid.property-grid { grid-template-columns: repeat(5, 1fr); }
        @media (max-width: 760px) { .row-grid, .row-grid.property-grid { grid-template-columns: 1fr 1fr; } }

        .remove-btn {
          background: transparent; border: 1px solid var(--border); color: var(--muted);
          width: 30px; height: 30px; border-radius: 6px; cursor: pointer; flex-shrink: 0;
          margin-bottom: 2px;
        }
        .remove-btn:hover { border-color: var(--rust); color: var(--rust); }

        .holding-readout {
          grid-column: 1 / -1; display: flex; gap: 18px; font-size: 11.5px; color: var(--muted);
          font-family: 'IBM Plex Mono', monospace; margin-top: 2px; flex-wrap: wrap; align-items: center;
        }
        .holding-readout strong { color: var(--emerald); }
        .fetch-note { font-family: 'Public Sans', sans-serif; }
        .fetch-note.ok { color: var(--emerald); }
        .fetch-note.err { color: var(--rust); }

        .ticker-row { display: flex; gap: 6px; }
        .ticker-row .text-input { flex: 1; min-width: 0; }
        .lookup-btn {
          background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
          border-radius: 6px; padding: 0 12px; font-size: 12px; cursor: pointer; font-family: inherit;
          white-space: nowrap;
        }
        .lookup-btn:hover:not(:disabled) { border-color: var(--gold); color: var(--gold); }
        .lookup-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .add-btn {
          margin-top: 12px; background: transparent; border: 1px dashed var(--border);
          color: var(--muted); padding: 9px 14px; border-radius: 6px; font-size: 12.5px;
          cursor: pointer; font-family: inherit;
        }
        .add-btn:hover { border-color: var(--emerald); color: var(--emerald); }

        /* ---- ledger tape sidebar ---- */
        .ledger {
          background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
          position: sticky; top: 20px; overflow: hidden;
        }
        .ledger-zigzag {
          height: 10px; width: 100%;
          background: linear-gradient(135deg, var(--bg) 25%, transparent 25%) 0 0/10px 10px,
                      linear-gradient(225deg, var(--bg) 25%, transparent 25%) 0 0/10px 10px;
          background-color: var(--panel);
        }
        .ledger-inner { padding: 20px; }
        .ledger-head { text-align: center; margin-bottom: 14px; position: relative; }
        .refresh-btn {
          position: absolute; top: 0; right: 0; background: transparent; border: 1px solid var(--border);
          color: var(--muted); font-size: 11px; padding: 5px 10px; border-radius: 999px; cursor: pointer;
          font-family: inherit;
        }
        .refresh-btn:hover { border-color: var(--gold); color: var(--gold); }
        .refreshed-note { font-size: 10.5px; color: var(--muted); margin-top: 4px; }
        .ledger-head .kicker {
          font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 2px;
          color: var(--muted); text-transform: uppercase;
        }
        .ledger-head .net-worth {
          font-family: 'IBM Plex Mono', monospace; font-size: 32px; font-weight: 700;
          color: var(--gold); margin-top: 4px;
        }
        .ledger-lines { border-top: 1px dashed var(--border); border-bottom: 1px dashed var(--border); padding: 10px 0; margin-bottom: 14px; }
        .ledger-line {
          display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace;
          font-size: 12.5px; padding: 4px 0;
        }
        .ledger-line .val.pos { color: var(--emerald); }
        .ledger-line .val.neg { color: var(--rust); }

        .stat-row { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; }
        .stat-row .label { color: var(--muted); font-size: 12px; }
        .stat-row .value { font-family: 'IBM Plex Mono', monospace; font-size: 14px; }
        .stat-row .value.good { color: var(--emerald); }
        .stat-row .value.bad { color: var(--rust); }

        .cashflow-toggle {
          width: 100%; background: transparent; border: 1px dashed var(--border); color: var(--muted);
          padding: 6px; border-radius: 6px; font-size: 11px; cursor: pointer; font-family: inherit;
          margin: 4px 0 8px;
        }
        .cashflow-toggle:hover { border-color: var(--gold); color: var(--gold); }
        .cashflow-detail {
          background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
          padding: 12px 14px; margin-bottom: 10px;
        }
        .cashflow-section-label {
          font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted);
          margin: 10px 0 4px;
        }
        .cashflow-section-label:first-child { margin-top: 0; }
        .cashflow-line {
          display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace;
          font-size: 11.5px; padding: 2px 0; color: var(--text);
        }
        .cashflow-line.total { border-top: 1px dashed var(--border); margin-top: 4px; padding-top: 6px; font-weight: 600; }
        .cashflow-line.net { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; font-weight: 700; font-size: 13px; }
        .cashflow-line.net.good { color: var(--emerald); }
        .cashflow-line.net.bad { color: var(--rust); }

        .projection-controls { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
        .mode-switch { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
        .mode-btn {
          background: var(--panel); border: none; color: var(--muted); padding: 7px 14px;
          font-size: 12px; cursor: pointer; font-family: inherit;
        }
        .mode-btn.active { background: var(--gold); color: #1a1409; font-weight: 600; }
        .periods-input { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); }
        .threshold-control label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); max-width: 220px; }
        .threshold-control .money-input { margin-top: 2px; }
        .periods-input input {
          background: var(--panel); border: 1px solid var(--border); color: var(--text);
          border-radius: 6px; padding: 7px 10px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; width: 90px;
        }
        .projection-rows { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
        .projection-row { display: grid; grid-template-columns: 64px 1fr 90px; align-items: center; gap: 8px; }
        .projection-row.clickable { cursor: pointer; padding: 3px 4px; border-radius: 4px; }
        .projection-row.clickable:hover { background: var(--panel-2); }
        .drilldown-detail { margin: 6px 0 10px; border-color: var(--gold); }

        .balance-sheet-wrap { overflow-x: auto; margin-top: 16px; border: 1px solid var(--border); border-radius: 8px; }
        .balance-sheet-table { border-collapse: collapse; width: 100%; font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
        .balance-sheet-table th, .balance-sheet-table td {
          padding: 8px 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--border);
        }
        .balance-sheet-table th { background: var(--bg); color: var(--text); font-weight: 600; position: sticky; top: 0; }
        .bs-now-date { font-family: 'Public Sans', sans-serif; font-weight: 400; font-size: 10px; color: var(--gold); margin-top: 2px; text-transform: none; }
        .balance-sheet-table .bs-row-label {
          text-align: left; font-family: 'Public Sans', sans-serif; color: var(--muted); white-space: nowrap;
          position: sticky; left: 0; background: var(--panel); z-index: 1;
        }
        .balance-sheet-table thead .bs-row-label { background: var(--bg); z-index: 2; }
        .balance-sheet-table .bs-section-row td.bs-row-label {
          text-align: left; color: var(--gold); font-weight: 700; font-family: 'Public Sans', sans-serif;
          text-transform: uppercase; font-size: 10.5px; letter-spacing: 1px; background: var(--panel-2);
          border-bottom: none; padding-top: 14px;
        }
        .balance-sheet-table .bs-subtotal-row td { font-weight: 700; border-top: 1px solid var(--border); }
        .balance-sheet-table .bs-networth-row td { font-weight: 700; color: var(--gold); border-top: 2px solid var(--gold); }
        .balance-sheet-table tbody tr:hover td:not(.bs-row-label) { background: var(--panel-2); }

        .recalc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
        .recalc-btn {
          background: var(--panel-2); border: 1px solid var(--gold); color: var(--gold);
          padding: 9px 16px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 600;
        }
        .recalc-btn:hover { background: var(--gold); color: #1a1409; }
        .recalc-btn.active { background: var(--gold); color: #1a1409; }
        .projection-label { font-size: 11px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
        .projection-bar-track {
          background: var(--panel); border: 1px solid var(--border); border-radius: 4px;
          height: 14px; overflow: hidden; position: relative;
        }
        .projection-bar { height: 100%; border-radius: 3px; }
        .projection-bar.good { background: var(--emerald); }
        .projection-bar.bad { background: var(--rust); }
        .projection-value {
          font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; text-align: right;
        }
        .projection-value.good { color: var(--emerald); }
        .projection-value.bad { color: var(--rust); }

        .divider-label {
          font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted);
          margin: 18px 0 8px;
        }

        .alloc-bar {
          display: flex; width: 100%; height: 10px; border-radius: 999px; overflow: hidden;
          background: var(--panel-2); border: 1px solid var(--border);
        }
        .alloc-seg.equity { background: var(--emerald); }
        .alloc-seg.fixed { background: var(--gold); }
        .alloc-legend {
          display: flex; justify-content: space-between; font-size: 11px; color: var(--muted);
          margin-top: 6px; flex-wrap: wrap; gap: 6px;
        }
        .alloc-legend .dot {
          display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px;
        }
        .alloc-legend .dot.equity { background: var(--emerald); }
        .alloc-legend .dot.fixed { background: var(--gold); }
        .alloc-note { font-size: 11.5px; color: var(--muted); margin: 8px 0 0; line-height: 1.5; }

        .fi-progress-track {
          width: 100%; height: 10px; border-radius: 999px; overflow: hidden;
          background: var(--panel-2); border: 1px solid var(--border);
        }
        .fi-progress-fill { height: 100%; background: var(--gold); border-radius: 999px; transition: width 0.3s ease; }
        .fi-progress-fill.done { background: var(--emerald); }

        .plan-item.one-time { border-color: var(--gold); }
        .plan-item.one-time .amt { color: var(--gold); }

        .planned-item-summary { border-color: var(--border); }
        .planned-item-actions { display: flex; gap: 8px; margin-top: 8px; }
        .planned-item-actions .explain-toggle { margin-top: 0; }

        .plan-item.cost-of-capital.payoff { border-color: var(--rust); }
        .plan-item.cost-of-capital.invest { border-color: var(--emerald); }
        .plan-item.cost-of-capital.borderline { border-color: var(--border); }
        .verdict-payoff { color: var(--rust); }
        .verdict-invest { color: var(--emerald); }
        .verdict-borderline { color: var(--muted); }

        .explain-toggle {
          margin-top: 8px; background: transparent; border: 1px dashed var(--border); color: var(--muted);
          padding: 5px 10px; border-radius: 6px; font-size: 10.5px; cursor: pointer; font-family: inherit;
        }
        .explain-toggle:hover { border-color: var(--gold); color: var(--gold); }
        .explain-panel {
          margin-top: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
          padding: 12px 14px;
        }
        .explain-row { margin-bottom: 10px; }
        .explain-row:last-child { margin-bottom: 0; }
        .explain-label {
          display: block; font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
          color: var(--gold); margin-bottom: 3px; font-weight: 600;
        }
        .explain-row p {
          margin: 0; font-size: 11.5px; color: var(--text); line-height: 1.6;
          font-family: 'IBM Plex Mono', monospace;
        }
        .explain-row p strong { font-family: 'IBM Plex Mono', monospace; }

        .plan-item {
          background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
          padding: 10px 12px; margin-bottom: 8px;
        }
        .plan-item .row { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; }
        .plan-item .amt { font-family: 'IBM Plex Mono', monospace; color: var(--emerald); }
        .plan-item .note { color: var(--muted); font-size: 11.5px; margin-top: 3px; }

        .empty-plan { color: var(--muted); font-size: 12.5px; text-align: center; padding: 14px 0; }

        .disclaimer {
          font-size: 11px; color: var(--muted); margin-top: 16px; line-height: 1.5;
          border-top: 1px solid var(--border); padding-top: 12px;
        }

        .warn-badge {
          display: inline-block; background: rgba(196,105,74,0.15); color: var(--rust);
          border: 1px solid var(--rust); border-radius: 999px; padding: 3px 9px; font-size: 10.5px;
          margin-top: 8px;
        }
      `}</style>

      {authStage !== "in" ? (
        <div className="auth-wrap">
          <div className="auth-card">
            <div className="kicker" style={{ textAlign: "center" }}>MyFinance</div>
            <h1 className="auth-title">{authMode === "login" ? "Log in" : "Create your profile"}</h1>

            <div className="auth-toggle">
              <button
                type="button"
                className={`mode-btn ${authMode === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
              >
                Log in
              </button>
              <button
                type="button"
                className={`mode-btn ${authMode === "signup" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("signup");
                  setAuthError("");
                }}
              >
                Sign up
              </button>
            </div>
            <Field label="Email">
              <input
                className="text-input auth-input"
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password">
              <input
                className="text-input auth-input"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder={authMode === "signup" ? "At least 8 characters" : "••••••••"}
              />
            </Field>
            {authMode === "signup" && (
              <Field label="Confirm password">
                <input
                  className="text-input auth-input"
                  type="password"
                  value={authPassword2}
                  onChange={(e) => setAuthPassword2(e.target.value)}
                />
              </Field>
            )}
            {authError && <p className="auth-error">{authError}</p>}
            <button
              type="button"
              className="auth-submit"
              onClick={authMode === "login" ? login : signup}
              disabled={authBusy}
            >
              {authBusy ? "…" : authMode === "login" ? "Log in" : "Create profile"}
            </button>
            <p className="auth-note">
              {authMode === "signup"
                ? "One profile per email address."
                : "Don't have a profile yet? Switch to Sign up above."}
            </p>
          </div>
        </div>
      ) : (
        <>
      <div className="header">
        <div>
          <h1>MyFinance — Investment Planner</h1>
          <p>Enter your full financial picture. The ledger on the right recalculates your net worth, cash flow, and a suggested monthly allocation as you type.</p>
        </div>
        <div className="account-bar">
          <div className="profile-bar">
            <span className="profile-email">{currentProfile?.email}</span>
            <button type="button" className="auth-link" onClick={() => setShowChangePassword((s) => !s)}>
              Change password
            </button>
            <button type="button" className="auth-link" onClick={logout}>
              Log out
            </button>
          </div>
          {showChangePassword && (
            <div className="export-panel change-password-panel">
              <div className="export-panel-header">
                <span>Change password</span>
                <button type="button" className="remove-btn" onClick={() => setShowChangePassword(false)} aria-label="Close">
                  ✕
                </button>
              </div>
              <Field label="Current password">
                <input className="text-input" type="password" value={changeOld} onChange={(e) => setChangeOld(e.target.value)} />
              </Field>
              <Field label="New password">
                <input className="text-input" type="password" value={changeNew} onChange={(e) => setChangeNew(e.target.value)} />
              </Field>
              <Field label="Confirm new password">
                <input className="text-input" type="password" value={changeNew2} onChange={(e) => setChangeNew2(e.target.value)} />
              </Field>
              {changeStatus && <p className="auth-error">{changeStatus}</p>}
              <button type="button" className="lookup-btn" onClick={changePassword} style={{ marginTop: 8 }}>
                Update password
              </button>
            </div>
          )}
          <select
            className="type-select"
            value={activeAccountId || ""}
            onChange={(e) => {
              if (e.target.value === "__new__") {
                setShowNewAccountInput(true);
              } else {
                switchAccount(e.target.value || null);
              }
            }}
          >
            <option value="">{accountsLoaded ? "No account (unsaved)" : "Loading…"}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            <option value="__new__">+ New account…</option>
          </select>
          <button type="button" className="lookup-btn" onClick={saveAccount}>
            {activeAccountId ? "Save" : "Save as…"}
          </button>
          <button type="button" className="lookup-btn" onClick={() => setShowExport((s) => !s)}>
            Export profile
          </button>
          <button
            type="button"
            className="lookup-btn"
            onClick={() => {
              setShowImport((s) => !s);
              setImportStatus("");
            }}
          >
            Import profile
          </button>
          {accountStatus && <span className="fetch-note ok account-status">{accountStatus}</span>}
          {showNewAccountInput && (
            <div className="new-account-row">
              <input
                className="text-input"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="Account name"
                onKeyDown={(e) => e.key === "Enter" && createAccount()}
                autoFocus
              />
              <button type="button" className="lookup-btn" onClick={createAccount}>
                Create
              </button>
              <button
                type="button"
                className="lookup-btn"
                onClick={() => {
                  setShowNewAccountInput(false);
                  setNewAccountName("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {showExport && (
            <div className="export-panel">
              <div className="export-panel-header">
                <span>Export — {activeAccountName}</span>
                <button type="button" className="remove-btn" onClick={() => setShowExport(false)} aria-label="Close export panel">
                  ✕
                </button>
              </div>
              <p className="section-hint" style={{ marginTop: 0 }}>
                Copy this JSON and share it with Claude to have it written into your Google Drive database, or download it as a backup file.
              </p>
              <textarea className="export-textarea" readOnly value={exportJsonText()} onFocus={(e) => e.target.select()} />
              <div className="export-actions">
                <button type="button" className="lookup-btn" onClick={copyExportJson}>
                  Copy JSON
                </button>
                <button type="button" className="lookup-btn" onClick={downloadExportJson}>
                  Download .json
                </button>
                {exportStatus && <span className="fetch-note ok">{exportStatus}</span>}
              </div>
            </div>
          )}
          {showImport && (
            <div className="export-panel">
              <div className="export-panel-header">
                <span>Import profile</span>
                <button type="button" className="remove-btn" onClick={() => setShowImport(false)} aria-label="Close import panel">
                  ✕
                </button>
              </div>
              <p className="section-hint" style={{ marginTop: 0 }}>
                Load a previously exported .json file (or its pasted contents) back into the form. This only fills in the inputs — nothing is saved to your account until you use "Save as…" or "Save" afterward.
              </p>
              <label className="import-file-label">
                <span>Choose a .json file</span>
                <input type="file" accept="application/json,.json" onChange={handleImportFile} />
              </label>
              <p className="section-hint" style={{ marginTop: 10, marginBottom: 4 }}>…or paste the JSON directly:</p>
              <textarea
                className="export-textarea"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="Paste exported JSON here"
              />
              <div className="export-actions">
                <button type="button" className="lookup-btn" onClick={loadPastedImport}>
                  Load pasted JSON
                </button>
                {importStatus && <span className="fetch-note ok">{importStatus}</span>}
              </div>
            </div>
          )}
          {showSnapshotPrompt && (
            <div className="export-panel snapshot-prompt">
              <div className="export-panel-header">
                <span>Update Net Worth snapshot date?</span>
              </div>
              <p className="section-hint" style={{ marginTop: 0 }}>
                Your Net Worth "Now" is currently anchored to <strong>{snapshotDateObj.toLocaleDateString()}</strong>. Today is <strong>{new Date().toLocaleDateString()}</strong>. Update the anchor to today? This shifts every trajectory column, the emergency fund's inflation schedule, and any planned-item timing to start counting from today instead.
              </p>
              <div className="export-actions">
                <button type="button" className="lookup-btn" onClick={() => handleSnapshotChoice(true)}>
                  Yes, update to today
                </button>
                <button type="button" className="lookup-btn" onClick={() => handleSnapshotChoice(false)}>
                  No, keep {snapshotDateObj.toLocaleDateString()}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="stamp">USD · Monthly basis</div>
      </div>

      <div className="layout">
        {/* LEFT: inputs */}
        <div className="panel">
          <div className="tabs">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`tab-btn ${tab === t.key ? "active" : ""}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "profile" && (
            <div>
              <h2 className="section-title">About you</h2>
              <p className="section-hint">Used to shape the suggested investment mix and to benchmark your mortgage rates against today's market.</p>
              <div className="grid-2">
                <Field label="Age">
                  <input
                    className="text-input"
                    type="number"
                    inputMode="numeric"
                    value={age}
                    placeholder="e.g. 35"
                    onChange={(e) => setAge(e.target.value)}
                  />
                </Field>
                <Field label="Risk tolerance">
                  <select className="type-select" value={riskTolerance} onChange={(e) => setRiskTolerance(e.target.value)}>
                    <option value="conservative">Conservative</option>
                    <option value="moderate">Moderate</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Country">
                  <select
                    className="type-select"
                    value={country}
                    onChange={(e) => {
                      const newCountry = e.target.value;
                      setCountry(newCountry);
                      setCurrency(currencyForCountry(newCountry));
                      setMarketMortgageRate(mortgageRateForCountry(newCountry));
                    }}
                  >
                    {COUNTRY_CURRENCY.map((c) => (
                      <option key={c.country} value={c.country}>{c.country}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Currency" suffix="auto-set from country — override anytime">
                  <select className="type-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {CURRENCY_CODES.map((code) => (
                      <option key={code} value={code}>{code} ({getCurrencySymbol(code)})</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Current market mortgage rate" suffix="30-yr fixed benchmark">
                  <RateInput value={marketMortgageRate} onChange={setMarketMortgageRate} />
                </Field>
                <Field label="Current market CD rate" suffix="used for new CDs and projected CD growth">
                  <RateInput value={marketCdRate} onChange={setMarketCdRate} />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Emergency fund target" suffix="months of obligations">
                  <input
                    className="text-input"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={emergencyMonths}
                    placeholder="6"
                    onChange={(e) => setEmergencyMonths(e.target.value)}
                  />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Minimum payoff threshold" suffix="don't recommend liquidating below this amount">
                  <MoneyInput value={payoffThreshold} onChange={setPayoffThreshold} placeholder="10000" />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Property appreciation rate" suffix="annual, used in the net worth trajectory">
                  <RateInput value={propertyAppreciationRate} onChange={setPropertyAppreciationRate} />
                </Field>
                <Field label="Rent growth rate" suffix="annual, defaults to current inflation">
                  <RateInput value={rentGrowthRate} onChange={setRentGrowthRate} />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Expense growth rate" suffix="annual, defaults to current inflation">
                  <RateInput value={expenseGrowthRate} onChange={setExpenseGrowthRate} />
                </Field>
                <Field label="Property cost growth rate" suffix="tax/HOA/fees, defaults to current inflation">
                  <RateInput value={propertyCostGrowthRate} onChange={setPropertyCostGrowthRate} />
                </Field>
              </div>
              <p className="section-hint" style={{ marginTop: 8 }}>
                {country === "India"
                  ? "Indian home loan rates were running roughly 7.1%–8.5% for well-qualified borrowers as of mid-2026, linked to the RBI repo rate — mortgage rates move often, so update this with a current quote for a more accurate refinance comparison."
                  : "National 30-year fixed averages were running roughly 6.6%–6.8% in late July 2026 — mortgage rates move often, so update this with a current quote for a more accurate refinance comparison."}{" "}
                The market CD rate defaults to about 4.0% — a competitive top-tier rate as of mid-2026 (the sleepy national average is closer to 1.7–2%, but a rate-shopper can do much better) — and is used both as the starting rate for any new CD you add and as the growth rate for projected CD balances. The growth-rate defaults above ({CURRENT_INFLATION_RATE}%) are the latest US headline CPI reading (June 2026) — update them if you expect rent, spending, or property costs to grow faster or slower than general inflation.
              </p>
            </div>
          )}

          {tab === "retirement" && (
            <div>
              <h2 className="section-title">Retirement readiness</h2>
              <p className="section-hint">Set your target spending and withdrawal rate — the ledger will estimate your FI number and how many years away you are.</p>
              <div className="grid-2">
                <Field label="Desired annual retirement expenses" suffix={`defaults to your current expenses + self-occupied property tax${country === "India" ? "" : "/HOA"} (${money(summary.defaultAnnualRetirementExpense)}/yr) if left blank`}>
                  <MoneyInput value={retirementExpense} onChange={setRetirementExpense} placeholder={String(Math.round(summary.defaultAnnualRetirementExpense))} />
                </Field>
                <Field label="Safe withdrawal rate" suffix="the '4% rule' is a common default">
                  <RateInput value={withdrawalRate} onChange={setWithdrawalRate} />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label={country === "India" ? "Current Provident Fund balance" : "Current 401(k) balance"}>
                  <MoneyInput value={k401Balance} onChange={setK401Balance} />
                </Field>
                <Field label={country === "India" ? "Provident Fund growth rate" : "401(k) growth rate"} suffix="expected annual capital growth">
                  <RateInput value={k401GrowthRate} onChange={setK401GrowthRate} />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label={country === "India" ? "Annual Provident Fund contribution" : "Annual 401(k) contribution"} suffix="yours + any employer match, per year">
                  <MoneyInput value={k401Contribution} onChange={setK401Contribution} />
                </Field>
                <Field label="Contribution growth rate" suffix="defaults to current inflation — raises, limit increases, etc.">
                  <RateInput value={k401ContributionGrowthRate} onChange={setK401ContributionGrowthRate} />
                </Field>
              </div>
              <p className="section-hint" style={{ marginTop: 8 }}>
                This contribution is added every year up to and including the year you retire (whether that's calculated or the target age you enter below), growing at the rate above — then stops, since contributions end once you retire. It's separate from the balance's own {pct(num(k401GrowthRate) || 0)} investment growth.
              </p>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field
                  label={country === "India" ? "Estimated pension benefit" : "Estimated Social Security benefit"}
                  suffix={
                    country === "India"
                      ? "monthly, today's ₹ — enter your own estimate (EPS/NPS/other)"
                      : `monthly at full retirement age (67), today's $ — auto-estimated at ${moneyPrecise(summary.defaultSsMonthlyAtFRA)} from your gross income if left blank`
                  }
                >
                  <MoneyInput value={socialSecurityBenefit} onChange={setSocialSecurityBenefit} placeholder={String(Math.round(summary.defaultSsMonthlyAtFRA))} />
                </Field>
                <Field label="Target retirement age" suffix="optional — leave blank to calculate the soonest feasible age">
                  <input
                    className="text-input"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={targetRetirementAge}
                    placeholder="e.g. 62"
                    onChange={(e) => setTargetRetirementAge(e.target.value)}
                  />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label={`Tax rate on ${country === "India" ? "pension" : "Social Security"}`} suffix={country === "India" ? "your expected effective tax rate on pension income" : "up to 85% of benefits can be taxable — 15% is a common effective rate"}>
                  <RateInput value={ssTaxRate} onChange={setSsTaxRate} />
                </Field>
              </div>
              <p className="section-hint" style={{ marginTop: 10 }}>
                The default expense figure includes your current household expenses plus property tax{country === "India" ? "" : " and HOA"} on any self-occupied property (rentals are excluded, since those costs are offset by rental income). It grows each year at your expense growth rate (Profile tab, defaults to current inflation — override it if you expect spending to rise faster or slower) to estimate what expenses will actually look like at retirement.
              </p>
              {country === "India" ? (
                <p className="section-hint" style={{ marginTop: 8 }}>
                  There's no single official formula for pension income in India comparable to the US Social Security PIA calculation (it depends on your specific EPS/NPS/other scheme), so this isn't auto-estimated — enter your own expected monthly pension in today's rupees.
                </p>
              ) : (
                <p className="section-hint" style={{ marginTop: 8 }}>
                  If left blank, the Social Security benefit is auto-estimated from your gross income using the SSA's own formula: average indexed monthly earnings (approximated here as your current gross income) run through the 2026 bend points ($1,286 / $7,749) at 90% / 32% / 15%. The real formula uses your highest 35 years of wage-indexed earnings, not a single income snapshot, so treat this as a ballpark — enter your own SSA estimate (from ssa.gov/myaccount) for accuracy.
                </p>
              )}
              {country !== "India" && (
                <p className="section-hint" style={{ marginTop: 8 }}>
                  Whatever figure is used above (auto-estimated or your own) is defined at full retirement age (67), then adjusted for {summary.hasTargetAge ? "your target" : "your calculated"} retirement age of <strong>{summary.effectiveAgeForSsDefault}</strong> — coming to about <strong>{moneyPrecise(summary.defaultSsMonthlyAtRetirement)}/mo</strong> before tax at that age. This updates automatically if your target age or calculated retirement age changes.
                </p>
              )}
              <p className="section-hint" style={{ marginTop: 8 }}>
                FI number = (expected expenses at retirement − after-tax {country === "India" ? "pension" : "Social Security"} benefit at retirement) ÷ withdrawal rate. The benefit is taxed at the rate above before being netted against expenses, since expenses are paid with after-tax money. You're assumed to start claiming the same year you retire, so retiring earlier both means less time to save <strong>and</strong> a permanently smaller benefit (roughly −6.7%/yr for the first 3 years before 67, −5%/yr beyond that, down to age 62; +8%/yr for each year you delay past 67, up to 70) — the standard early/delayed-claiming tradeoff{country === "India" ? " (borrowed here from the US Social Security schedule as a general approximation, since it isn't India-specific)" : ""}.
              </p>
              <p className="section-hint" style={{ marginTop: 8 }}>
                If you leave the target age blank, the app searches year by year for the soonest age where your projected portfolio covers that year's FI number. If you enter one, it instead tells you whether you're on pace to hit it.
              </p>
              <p className="section-hint" style={{ marginTop: 8 }}>
                Compared against your liquid + CD + recurring deposit + shares + {country === "India" ? "Provident Fund" : "401(k)"} balances (not home equity, since that's assumed to stay lived-in rather than fund spending). The {country === "India" ? "Provident Fund" : "401(k)"} compounds separately at its own growth rate, with its own contribution schedule above, until retirement — see the Retirement readiness section in the ledger for the full breakdown.
              </p>
            </div>
          )}

          {tab === "networth" && (
            <div>
              <h2 className="section-title">Net worth & trajectory</h2>
              <p className="section-hint">
                Assets and liabilities down the side, projected ending balance by period across the top. Uses the same growth assumptions as the Net Worth Trajectory chart in the ledger. "Now" is anchored to <strong>{snapshotDateObj.toLocaleDateString()}</strong> — the date this data was last saved, not necessarily today — so a snapshot you're just viewing doesn't silently drift forward. Saving with newer edits will ask whether to move that anchor to today.
              </p>
              <div className="grid-2" style={{ maxWidth: 220 }}>
                <Field label="Years to project" suffix="max 40">
                  <input
                    className="text-input"
                    type="number"
                    min="1"
                    max="40"
                    value={netWorthYears}
                    onChange={(e) => setNetWorthYears(e.target.value)}
                  />
                </Field>
              </div>
              <div className="recalc-row">
                <button
                  type="button"
                  className={`recalc-btn ${netWorthTablePayoffsApplied ? "active" : ""}`}
                  onClick={() => setNetWorthTablePayoffsApplied((s) => !s)}
                >
                  {netWorthTablePayoffsApplied ? "↺ Reset to baseline (no payoffs applied)" : "↻ Recalculate with recommended payoffs"}
                </button>
                {netWorthTablePayoffsApplied && (
                  <span className="fetch-note ok">Applied — CD, recurring deposit, and outstanding loan balances below now reflect the future payoff proposals.</span>
                )}
              </div>

              <h2 className="section-title" style={{ marginTop: 22 }}>Planned big items</h2>
              <p className="section-hint">
                Add any large one-time event you expect — college, a wedding, buying or improving a property, a car — with the year it happens and how it's funded. Collapse an item once it's filled in to keep this list tidy.
              </p>
              {plannedItems.map((item) => {
                const isCollapsed = collapsedPlannedIds.includes(item.id);
                if (isCollapsed) {
                  return (
                    <div className="plan-item planned-item-summary" key={item.id}>
                      <div className="row">
                        <span>{item.label || item.category} <em style={{ marginLeft: 4 }}>{item.year}</em></span>
                        <span className={`amt ${item.type === "asset" ? "verdict-invest" : "verdict-payoff"}`}>
                          {item.type === "asset" ? "+" : "−"}{money(num(item.amount))}
                        </span>
                      </div>
                      <div className="note">
                        {item.category} · {item.type === "asset" ? "Asset" : "Liability"} · funded by {{ none: "external/untracked funds", cash: "cash (savings/checking)", cd: "CD funds", loan: "a new loan" }[item.fundingSource || "none"]}
                      </div>
                      <div className="planned-item-actions">
                        <button type="button" className="explain-toggle" onClick={() => togglePlannedCollapse(item.id)}>Edit ▾</button>
                        <button type="button" className="explain-toggle" onClick={() => removePlannedItem(item.id)}>Remove</button>
                      </div>
                    </div>
                  );
                }
                return (
                  <RowShell key={item.id} onRemove={() => removePlannedItem(item.id)} gridClassName="shares-grid">
                    <Field label="Category">
                      <select
                        className="type-select"
                        value={item.category}
                        onChange={(e) => {
                          updatePlannedItem(item.id, "category", e.target.value);
                          if (!item.label) updatePlannedItem(item.id, "label", e.target.value);
                        }}
                      >
                        <option value="College Expenses">College Expenses</option>
                        <option value="Marriage Expenses">Marriage Expenses</option>
                        <option value="Property Purchase">Property Purchase</option>
                        <option value="Property Improvement">Property Improvement</option>
                        <option value="Car Purchase">Car Purchase</option>
                        <option value="Other">Other</option>
                      </select>
                    </Field>
                    <Field label="Label" className="full-width">
                      <input className="text-input" value={item.label} onChange={(e) => updatePlannedItem(item.id, "label", e.target.value)} placeholder="e.g. Daughter's college tuition" />
                    </Field>
                    <Field label="Type">
                      <select className="type-select" value={item.type} onChange={(e) => updatePlannedItem(item.id, "type", e.target.value)}>
                        <option value="liability">Liability (expense)</option>
                        <option value="asset">Asset</option>
                      </select>
                    </Field>
                    <Field label="Amount">
                      <MoneyInput value={item.amount} onChange={(v) => updatePlannedItem(item.id, "amount", v)} />
                    </Field>
                    <Field label="Year">
                      <input
                        className="text-input"
                        type="number"
                        inputMode="numeric"
                        value={item.year}
                        placeholder={String(currentYear() + 1)}
                        onChange={(e) => updatePlannedItem(item.id, "year", e.target.value)}
                      />
                    </Field>
                    <Field label="Funded by" suffix="what pays for it">
                      <select className="type-select" value={item.fundingSource || "none"} onChange={(e) => updatePlannedItem(item.id, "fundingSource", e.target.value)}>
                        <option value="none">External / untracked funds</option>
                        <option value="cash">Cash (savings/checking)</option>
                        <option value="cd">CD funds</option>
                        <option value="loan">New loan</option>
                      </select>
                    </Field>
                    <div className="holding-readout">
                      <span>
                        {item.fundingSource === "cash" && "Reduces your Savings & Checking row starting that year."}
                        {item.fundingSource === "cd" && "Reduces your CDs row starting that year."}
                        {item.fundingSource === "loan" && "Adds a new loan liability row starting that year."}
                        {(!item.fundingSource || item.fundingSource === "none") && "Applied directly to net worth without touching any tracked cash/CD balance."}
                      </span>
                      <button type="button" className="explain-toggle" onClick={() => togglePlannedCollapse(item.id)} style={{ marginTop: 0 }}>Collapse ▴</button>
                    </div>
                  </RowShell>
                );
              })}
              <button className="add-btn" onClick={addPlannedItem}>+ Add a planned item</button>

              {(() => {
                const allRows = netWorthTableTrajectory.rows;
                const maxCols = 13;
                const shown =
                  allRows.length <= maxCols
                    ? allRows
                    : allRows.filter((_, idx) => idx === 0 || idx === allRows.length - 1 || idx % Math.ceil((allRows.length - 1) / (maxCols - 1)) === 0);
                const baseYear = currentYear();
                const activeAt = (item, r) => (baseYear + r.year >= num(item.year) ? num(item.amount) : 0);
                const plannedRowGetter = (item) => (r) => activeAt(item, r);

                const validItems = plannedItems.filter((i) => num(i.amount) > 0 && num(i.year) > 0);
                const assetItems = validItems.filter((i) => i.type === "asset");
                const loanFundedItems = validItems.filter((i) => i.fundingSource === "loan");
                const untrackedLiabilityItems = validItems.filter((i) => i.type === "liability" && (!i.fundingSource || i.fundingSource === "none"));

                const assetRows = [
                  { label: "Savings & Checking", get: (r) => r.liquid },
                  { label: "CDs", get: (r) => r.cds },
                  { label: "Recurring Deposits", get: (r) => r.rd },
                  { label: "Shares", get: (r) => r.shares },
                  { label: country === "India" ? "Provident Fund" : "401(k)", get: (r) => r.k401 },
                  { label: "Property Value", get: (r) => r.propertyValue },
                  ...assetItems.map((item) => ({ label: `${item.label || item.category} (${item.year})`, get: plannedRowGetter(item) })),
                ];
                const liabilityRows = [
                  { label: "Property Loans", get: (r) => r.propertyLoans },
                  { label: "Other Loans", get: (r) => r.otherLoans },
                  ...untrackedLiabilityItems.map((item) => ({ label: `${item.label || item.category} (${item.year})`, get: plannedRowGetter(item) })),
                  ...loanFundedItems.map((item) => ({ label: `${item.label || item.category} loan (${item.year})`, get: plannedRowGetter(item) })),
                ];
                const totalAssets = (r) => assetRows.reduce((s, row) => s + row.get(r), 0);
                const totalLiabilities = (r) => liabilityRows.reduce((s, row) => s + row.get(r), 0);
                return (
                  <div className="balance-sheet-wrap">
                    <table className="balance-sheet-table">
                      <thead>
                        <tr>
                          <th className="bs-row-label">{" "}</th>
                          {shown.map((r) => (
                            <th key={r.year}>
                              {r.label}
                              {r.year === 0 && <div className="bs-now-date">{snapshotDateObj.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</div>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="bs-section-row">
                          <td className="bs-row-label" colSpan={shown.length + 1}>Assets</td>
                        </tr>
                        {assetRows.map((row) => (
                          <tr key={row.label}>
                            <td className="bs-row-label">{row.label}</td>
                            {shown.map((r) => (
                              <td key={r.year}>{money(row.get(r))}</td>
                            ))}
                          </tr>
                        ))}
                        <tr className="bs-subtotal-row">
                          <td className="bs-row-label">Total Assets</td>
                          {shown.map((r) => (
                            <td key={r.year}>{money(totalAssets(r))}</td>
                          ))}
                        </tr>
                        <tr className="bs-section-row">
                          <td className="bs-row-label" colSpan={shown.length + 1}>Liabilities</td>
                        </tr>
                        {liabilityRows.map((row) => (
                          <tr key={row.label}>
                            <td className="bs-row-label">{row.label}</td>
                            {shown.map((r) => (
                              <td key={r.year}>{money(row.get(r))}</td>
                            ))}
                          </tr>
                        ))}
                        <tr className="bs-subtotal-row">
                          <td className="bs-row-label">Total Liabilities</td>
                          {shown.map((r) => (
                            <td key={r.year}>{money(totalLiabilities(r))}</td>
                          ))}
                        </tr>
                        <tr className="bs-networth-row">
                          <td className="bs-row-label">Net Worth</td>
                          {shown.map((r) => (
                            <td key={r.year}>{money(totalAssets(r) - totalLiabilities(r))}</td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                );
              })()}
              <p className="section-hint" style={{ marginTop: 10 }}>
                Columns are thinned to a readable number when projecting many years — the last column is always the final projected year. {netWorthTablePayoffsApplied ? "The \"Now\" column and every column after reflect today's already-qualifying one-time actions (cash, CD, recurring deposit, and share payoffs), plus every future payoff proposal applied in the year it would trigger." : "This is the baseline path — no one-time or future payoff proposals have been applied yet. Use the button above to see the effect of acting on them."} Planned big items appear once their year arrives and stay reflected after: assets get their own row; cash- or CD-funded items reduce the Savings & Checking or CDs row directly (and count as a genuine draw-down, not just a display subtraction — see below); loan-funded items add a new loan row. Your emergency fund target holds steady in year 1, then grows {pct(summary.expenseGrowthPct)}/yr with expense inflation from year 2 on. If a cash- or CD-funded item pulls Savings & Checking below that target, up to half of each subsequent year's cash flow surplus is redirected to refill it first — the same 50% cap the Suggested Monthly Allocation plan uses — before anything goes toward CDs or shares.
              </p>
            </div>
          )}

          {tab === "income" && (
            <div>
              <h2 className="section-title">Monthly income</h2>
              <p className="section-hint">Gross is before tax and deductions; after-tax is what actually hits your account.</p>
              <div className="grid-2">
                <Field label="Gross monthly income">
                  <MoneyInput value={grossIncome} onChange={setGrossIncome} />
                </Field>
                <Field label="After-tax monthly income" suffix="net of tax & deductions">
                  <MoneyInput value={netIncome} onChange={setNetIncome} />
                </Field>
              </div>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="Income growth rate" suffix="annual, defaults to current inflation — e.g. raises/promotions">
                  <RateInput value={incomeGrowthRate} onChange={setIncomeGrowthRate} />
                </Field>
              </div>
              <p className="section-hint" style={{ marginTop: 8 }}>
                Used to grow your after-tax income forward in the future cash position projection and the retirement simulation, instead of assuming it stays flat.
              </p>
            </div>
          )}

          {tab === "liquid" && (
            <div>
              <h2 className="section-title">Cash accounts</h2>
              <p className="section-hint">Balances in your everyday accounts.</p>
              <div className="grid-2">
                <Field label="Savings account balance">
                  <MoneyInput value={savings} onChange={setSavings} />
                </Field>
                <Field label="Checking account balance">
                  <MoneyInput value={checking} onChange={setChecking} />
                </Field>
              </div>

              <h2 className="section-title" style={{ marginTop: 22 }}>Certificates of deposit</h2>
              <p className="section-hint">Add each CD with its amount and interest rate.</p>
              {cds.map((c) => (
                <RowShell key={c.id} onRemove={() => removeCd(c.id)}>
                  <Field label="Label">
                    <input className="text-input" value={c.label} onChange={(e) => updateCd(c.id, "label", e.target.value)} />
                  </Field>
                  <Field label="Amount">
                    <MoneyInput value={c.amount} onChange={(v) => updateCd(c.id, "amount", v)} />
                  </Field>
                  <Field label="Interest rate">
                    <RateInput value={c.rate} onChange={(v) => updateCd(c.id, "rate", v)} />
                  </Field>
                </RowShell>
              ))}
              <button className="add-btn" onClick={addCd}>+ Add another CD</button>

              <h2 className="section-title" style={{ marginTop: 22 }}>Recurring deposits</h2>
              <p className="section-hint">Add each recurring deposit with its frequency, rate, periodic deposit, start date, and tenure. End date, current value, and maturity value are calculated automatically.</p>
              {summary.rdComputed.map((r) => (
                <RowShell key={r.id} onRemove={() => removeRD(r.id)} gridClassName="shares-grid">
                  <Field label="Label" className="full-width">
                    <input className="text-input" value={r.label} onChange={(e) => updateRD(r.id, "label", e.target.value)} />
                  </Field>
                  <Field label="Frequency">
                    <select className="type-select" value={r.frequency} onChange={(e) => updateRD(r.id, "frequency", e.target.value)}>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </Field>
                  <Field label="Interest rate">
                    <RateInput value={r.rate} onChange={(v) => updateRD(r.id, "rate", v)} />
                  </Field>
                  <Field label="Deposit per period">
                    <MoneyInput value={r.depositAmount} onChange={(v) => updateRD(r.id, "depositAmount", v)} />
                  </Field>
                  <Field label="Start date" className="full-width">
                    <input
                      className="text-input"
                      type="date"
                      value={r.startDate}
                      onChange={(e) => updateRD(r.id, "startDate", e.target.value)}
                    />
                  </Field>
                  <Field label="Tenure">
                    <input
                      className="text-input"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      value={r.tenureValue}
                      placeholder="e.g. 5"
                      onChange={(e) => updateRD(r.id, "tenureValue", e.target.value)}
                    />
                  </Field>
                  <Field label="Tenure unit">
                    <select className="type-select" value={r.tenureUnit} onChange={(e) => updateRD(r.id, "tenureUnit", e.target.value)}>
                      <option value="months">Months</option>
                      <option value="years">Years</option>
                    </select>
                  </Field>
                  <div className="holding-readout">
                    <span>End date: <strong>{r.endDateObj ? r.endDateObj.toLocaleDateString() : "—"}</strong></span>
                    <span>Current value: <strong>{money(r.currentValue)}</strong></span>
                    <span>Maturity value: <strong>{money(r.maturityValue)}</strong></span>
                    {r.isActive && <span className="fetch-note ok">Active — {moneyPrecise(r.monthlyDepositEquivalent)}/mo equivalent counted in cash flow</span>}
                    {!r.isActive && r.endDateObj && snapshotDateObj >= r.endDateObj && <span className="fetch-note ok">Matured</span>}
                  </div>
                </RowShell>
              ))}
              <button className="add-btn" onClick={addRD}>+ Add another recurring deposit</button>
              {summary.totalRDCurrentValue > 0 && (
                <p className="section-hint" style={{ marginTop: 10 }}>
                  Total current value: {money(summary.totalRDCurrentValue)} · Total at maturity: {money(summary.totalRDMaturityValue)}. Current value counts toward net worth and your target investment mix now; the maturity value is shown so you can weigh it when making decisions, and future deposits from active plans are already factored into your monthly cash flow.
                </p>
              )}
            </div>
          )}

          {tab === "property" && (
            <div>
              <h2 className="section-title">Properties</h2>
              <p className="section-hint">
                Mark each as self-occupied or rental. Value is used to estimate equity.{" "}
                {country === "India"
                  ? "Property tax and maintenance are counted as monthly carrying costs; rental income is added to monthly cash flow."
                  : "Property tax, HOA, and (for rentals) management fees are all counted as monthly carrying costs; rental income is added to monthly cash flow."}
              </p>
              {properties.map((p) => (
                <RowShell key={p.id} onRemove={() => removeProperty(p.id)}>
                  <Field label="Label">
                    <input className="text-input" value={p.label} onChange={(e) => updateProperty(p.id, "label", e.target.value)} />
                  </Field>
                  <Field label="Type">
                    <select className="type-select" value={p.type} onChange={(e) => updateProperty(p.id, "type", e.target.value)}>
                      <option value="self">Self-occupied</option>
                      <option value="rental">Rental</option>
                    </select>
                  </Field>
                  <Field label="Current value">
                    <MoneyInput value={p.value} onChange={(v) => updateProperty(p.id, "value", v)} />
                  </Field>
                  <Field label="Loan balance">
                    <MoneyInput value={p.loanBalance} onChange={(v) => updateProperty(p.id, "loanBalance", v)} />
                  </Field>
                  <Field label="Monthly mortgage">
                    <MoneyInput value={p.monthlyMortgage} onChange={(v) => updateProperty(p.id, "monthlyMortgage", v)} />
                  </Field>
                  <Field label="Mortgage rate">
                    <RateInput value={p.mortgageRate} onChange={(v) => updateProperty(p.id, "mortgageRate", v)} />
                  </Field>
                  <Field label="Property tax" suffix="monthly">
                    <MoneyInput value={p.propertyTax} onChange={(v) => updateProperty(p.id, "propertyTax", v)} />
                  </Field>
                  {country !== "India" && (
                    <Field label="HOA" suffix="monthly">
                      <MoneyInput value={p.hoa} onChange={(v) => updateProperty(p.id, "hoa", v)} />
                    </Field>
                  )}
                  {country === "India" ? (
                    <>
                      <Field label="Maintenance" suffix="monthly">
                        <MoneyInput value={p.managementFee} onChange={(v) => updateProperty(p.id, "managementFee", v)} />
                      </Field>
                      {p.type === "rental" && (
                        <Field label="Monthly rental income">
                          <MoneyInput value={p.rentalIncome} onChange={(v) => updateProperty(p.id, "rentalIncome", v)} />
                        </Field>
                      )}
                    </>
                  ) : (
                    p.type === "rental" && (
                      <>
                        <Field label="Management fee" suffix="monthly">
                          <MoneyInput value={p.managementFee} onChange={(v) => updateProperty(p.id, "managementFee", v)} />
                        </Field>
                        <Field label="Monthly rental income">
                          <MoneyInput value={p.rentalIncome} onChange={(v) => updateProperty(p.id, "rentalIncome", v)} />
                        </Field>
                      </>
                    )
                  )}
                </RowShell>
              ))}
              <button className="add-btn" onClick={addProperty}>+ Add another property</button>
            </div>
          )}

          {tab === "shares" && (
            <div>
              <h2 className="section-title">Shares / brokerage holdings</h2>
              <p className="section-hint">Enter a ticker and quantity, then look up the current price and dividend automatically — or type them in yourself.</p>
              {shares.map((h) => {
                const holdingValue = num(h.quantity) * num(h.price);
                const quarterlyIncome = num(h.quantity) * num(h.dividendValue);
                const status = fetchStatus[h.id];
                return (
                  <RowShell key={h.id} onRemove={() => removeShare(h.id)} gridClassName="shares-grid">
                    <Field label="Ticker" className="full-width">
                      <div className="ticker-row">
                        <input
                          className="text-input"
                          value={h.ticker}
                          onChange={(e) => updateShare(h.id, "ticker", e.target.value.toUpperCase())}
                          placeholder="e.g. VOO"
                        />
                        <button
                          type="button"
                          className="lookup-btn"
                          disabled={!h.ticker.trim() || status?.state === "loading"}
                          onClick={() => lookupShare(h.id, h.ticker)}
                        >
                          {status?.state === "loading" ? "…" : "Look up"}
                        </button>
                      </div>
                    </Field>
                    <Field label="Quantity">
                      <input
                        className="text-input"
                        type="number"
                        inputMode="decimal"
                        value={h.quantity}
                        placeholder="0"
                        onChange={(e) => updateShare(h.id, "quantity", e.target.value)}
                      />
                    </Field>
                    <Field label="Market price / share">
                      <MoneyInput value={h.price} onChange={(v) => updateShare(h.id, "price", v)} />
                    </Field>
                    <Field label="Dividend per share" suffix="quarterly" className="full-width">
                      <MoneyInput value={h.dividendValue} onChange={(v) => updateShare(h.id, "dividendValue", v)} />
                    </Field>
                    <div className="holding-readout">
                      <span>Value: <strong>{money(holdingValue)}</strong></span>
                      <span>Est. quarterly income: <strong>{moneyPrecise(quarterlyIncome)}</strong></span>
                      {status?.state === "done" && <span className="fetch-note ok">✓ {status.message}</span>}
                      {status?.state === "error" && <span className="fetch-note err">{status.message}</span>}
                    </div>
                  </RowShell>
                );
              })}
              <button className="add-btn" onClick={addShare}>+ Add another holding</button>
              <p className="section-hint" style={{ marginTop: 10 }}>
                Look up checks free quote sites (stockanalysis.com, then Yahoo Finance) — the status line shows which one was actually used. Prices and dividends can still lag the real market, so treat them as a helpful starting point and double-check anything you're relying on.
              </p>

              <div className="grid-2" style={{ marginTop: 22 }}>
                <Field label="Expected annual price growth" suffix="capital appreciation only — dividends are tracked separately above">
                  <RateInput value={sharesReturn} onChange={setSharesReturn} />
                </Field>
                <Field label="Projection horizon" suffix="years, used in the restructuring analysis">
                  <input
                    className="text-input"
                    type="number"
                    inputMode="numeric"
                    value={projectionYears}
                    onChange={(e) => setProjectionYears(e.target.value)}
                  />
                </Field>
              </div>
              <p className="section-hint" style={{ marginTop: 8 }}>
                Total expected return used for the restructuring comparison below is this growth rate plus your portfolio's actual dividend yield ({pct(summary.dividendYieldPct)} right now) — currently {pct(summary.totalExpectedReturn)}/yr.
              </p>
            </div>
          )}

          {tab === "debt" && (
            <div>
              <h2 className="section-title">Loans</h2>
              <p className="section-hint">Car loans, personal loans, or anything else outstanding (not mortgages — those are under Property).</p>
              {loans.map((l) => (
                <RowShell key={l.id} onRemove={() => removeLoan(l.id)}>
                  <Field label="Label">
                    <input className="text-input" value={l.label} onChange={(e) => updateLoan(l.id, "label", e.target.value)} />
                  </Field>
                  <Field label="Outstanding balance">
                    <MoneyInput value={l.balance} onChange={(v) => updateLoan(l.id, "balance", v)} />
                  </Field>
                  <Field label="Interest rate">
                    <RateInput value={l.rate} onChange={(v) => updateLoan(l.id, "rate", v)} />
                  </Field>
                  <Field label="Monthly payment">
                    <MoneyInput value={l.payment} onChange={(v) => updateLoan(l.id, "payment", v)} />
                  </Field>
                </RowShell>
              ))}
              <button className="add-btn" onClick={addLoan}>+ Add another loan</button>
            </div>
          )}

          {tab === "expenses" && (
            <div>
              <h2 className="section-title">Monthly household expenses</h2>
              <p className="section-hint">Everyday spending, excluding mortgage and loan payments (captured elsewhere).</p>
              <div className="grid-2">
                <Field label="Utilities"><MoneyInput value={expenses.utilities} onChange={(v) => updateExpense("utilities", v)} /></Field>
                <Field label="Groceries"><MoneyInput value={expenses.groceries} onChange={(v) => updateExpense("groceries", v)} /></Field>
                <Field label="Dining out"><MoneyInput value={expenses.dining} onChange={(v) => updateExpense("dining", v)} /></Field>
                <Field label="Gas / fuel"><MoneyInput value={expenses.gas} onChange={(v) => updateExpense("gas", v)} /></Field>
                <Field label="Insurance"><MoneyInput value={expenses.insurance} onChange={(v) => updateExpense("insurance", v)} /></Field>
                <Field label="Subscriptions"><MoneyInput value={expenses.subscriptions} onChange={(v) => updateExpense("subscriptions", v)} /></Field>
                <Field label="Shopping"><MoneyInput value={expenses.shopping} onChange={(v) => updateExpense("shopping", v)} /></Field>
                <Field label="Personal care"><MoneyInput value={expenses.personalCare} onChange={(v) => updateExpense("personalCare", v)} /></Field>
                <Field label="Travel"><MoneyInput value={expenses.travel} onChange={(v) => updateExpense("travel", v)} /></Field>
                <Field label="Childcare / education"><MoneyInput value={expenses.childcareEducation} onChange={(v) => updateExpense("childcareEducation", v)} /></Field>
                <Field label="Healthcare" suffix="out-of-pocket"><MoneyInput value={expenses.healthcare} onChange={(v) => updateExpense("healthcare", v)} /></Field>
                <Field label="Pet care"><MoneyInput value={expenses.petCare} onChange={(v) => updateExpense("petCare", v)} /></Field>
                <Field label="Entertainment & hobbies"><MoneyInput value={expenses.entertainment} onChange={(v) => updateExpense("entertainment", v)} /></Field>
                <Field label="Gifts & donations"><MoneyInput value={expenses.giftsDonations} onChange={(v) => updateExpense("giftsDonations", v)} /></Field>
                <Field label="Other"><MoneyInput value={expenses.other} onChange={(v) => updateExpense("other", v)} /></Field>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: ledger tape summary */}
        <div className="ledger">
          <div className="ledger-zigzag" />
          <div className="ledger-inner">
            <div className="ledger-head">
              <button
                type="button"
                className="refresh-btn"
                onClick={() => {
                  setRefreshNonce((n) => n + 1);
                  setRefreshedAt(new Date());
                }}
                title="Recalculate without changing any inputs"
              >
                ↻ Refresh
              </button>
              <div className="kicker">Net worth</div>
              <div className="net-worth">{money(summary.netWorth)}</div>
              {refreshedAt && (
                <div className="refreshed-note">
                  Recalculated {refreshedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </div>

            <div className="ledger-lines">
              {ledgerLines.map((l) => (
                <div className="ledger-line" key={l.label}>
                  <span>{l.label}</span>
                  <span className={`val ${l.positive ? "pos" : "neg"}`}>
                    {l.value < 0 ? "−" : ""}{money(Math.abs(l.value))}
                  </span>
                </div>
              ))}
            </div>

            <div className="stat-row">
              <span className="label">Monthly cash flow</span>
              <span className={`value ${summary.monthlyCashFlow >= 0 ? "good" : "bad"}`}>{moneyPrecise(summary.monthlyCashFlow)}</span>
            </div>
            {summary.monthlyDividendIncome > 0 && (
              <div className="stat-row">
                <span className="label">— incl. dividend income</span>
                <span className="value good">{moneyPrecise(summary.monthlyDividendIncome)}/mo</span>
              </div>
            )}
            <button type="button" className="cashflow-toggle" onClick={() => setShowCashFlowDetail((s) => !s)}>
              {showCashFlowDetail ? "Hide cash flow breakdown ▲" : "Show cash flow breakdown ▼"}
            </button>
            {showCashFlowDetail && (
              <div className="cashflow-detail">
                <div className="cashflow-section-label">Inflows</div>
                <div className="cashflow-line"><span>After-tax income</span><span>{moneyPrecise(summary.afterTax)}</span></div>
                <div className="cashflow-line"><span>Rental income</span><span>{moneyPrecise(summary.totalRentalIncome)}</span></div>
                <div className="cashflow-line"><span>Dividend income</span><span>{moneyPrecise(summary.monthlyDividendIncome)}</span></div>
                <div className="cashflow-line total"><span>Total inflow</span><span>{moneyPrecise(summary.monthlyInflow)}</span></div>

                <div className="cashflow-section-label">Outflows</div>
                <div className="cashflow-line"><span>Mortgage payments</span><span>{moneyPrecise(summary.totalMortgagePayments)}</span></div>
                <div className="cashflow-line"><span>Property tax / HOA / mgmt fees</span><span>{moneyPrecise(summary.totalPropertyCarryCosts)}</span></div>
                <div className="cashflow-line"><span>Loan payments</span><span>{moneyPrecise(summary.totalLoanPayments)}</span></div>
                {summary.totalRDMonthlyDeposit > 0 && (
                  <div className="cashflow-line"><span>Recurring deposits (active plans)</span><span>{moneyPrecise(summary.totalRDMonthlyDeposit)}</span></div>
                )}
                <div className="cashflow-line"><span>Utilities</span><span>{moneyPrecise(num(expenses.utilities))}</span></div>
                <div className="cashflow-line"><span>Groceries</span><span>{moneyPrecise(num(expenses.groceries))}</span></div>
                <div className="cashflow-line"><span>Dining</span><span>{moneyPrecise(num(expenses.dining))}</span></div>
                <div className="cashflow-line"><span>Gas</span><span>{moneyPrecise(num(expenses.gas))}</span></div>
                <div className="cashflow-line"><span>Insurance</span><span>{moneyPrecise(num(expenses.insurance))}</span></div>
                <div className="cashflow-line"><span>Subscriptions</span><span>{moneyPrecise(num(expenses.subscriptions))}</span></div>
                <div className="cashflow-line"><span>Shopping</span><span>{moneyPrecise(num(expenses.shopping))}</span></div>
                <div className="cashflow-line"><span>Personal care</span><span>{moneyPrecise(num(expenses.personalCare))}</span></div>
                <div className="cashflow-line"><span>Travel</span><span>{moneyPrecise(num(expenses.travel))}</span></div>
                <div className="cashflow-line"><span>Childcare / education</span><span>{moneyPrecise(num(expenses.childcareEducation))}</span></div>
                <div className="cashflow-line"><span>Healthcare</span><span>{moneyPrecise(num(expenses.healthcare))}</span></div>
                <div className="cashflow-line"><span>Pet care</span><span>{moneyPrecise(num(expenses.petCare))}</span></div>
                <div className="cashflow-line"><span>Entertainment & hobbies</span><span>{moneyPrecise(num(expenses.entertainment))}</span></div>
                <div className="cashflow-line"><span>Gifts & donations</span><span>{moneyPrecise(num(expenses.giftsDonations))}</span></div>
                <div className="cashflow-line"><span>Other</span><span>{moneyPrecise(num(expenses.other))}</span></div>
                <div className="cashflow-line total"><span>Total outflow</span><span>{moneyPrecise(summary.monthlyOutflow)}</span></div>

                <div className={`cashflow-line net ${summary.monthlyCashFlow >= 0 ? "good" : "bad"}`}>
                  <span>Net cash flow</span><span>{moneyPrecise(summary.monthlyCashFlow)}</span>
                </div>
              </div>
            )}
            <div className="stat-row">
              <span className="label">Savings rate</span>
              <span className={`value ${summary.savingsRate >= 15 ? "good" : summary.savingsRate < 0 ? "bad" : ""}`}>{pct(summary.savingsRate)}</span>
            </div>
            <div className="stat-row">
              <span className="label">Emergency fund ({summary.emMonths} mo. target)</span>
              <span className="value">{money(summary.emergencyCurrent)} / {money(summary.emergencyTarget)}</span>
            </div>
            {summary.excessCash > 0 && (
              <div className="stat-row">
                <span className="label">Cash beyond reserve</span>
                <span className="value good">{money(summary.excessCash)}</span>
              </div>
            )}
            {summary.monthlyCashFlow < 0 && (
              <span className="warn-badge">Spending exceeds income this month</span>
            )}

            <button type="button" className="cashflow-toggle" onClick={() => setShowProjection((s) => !s)}>
              {showProjection ? "Hide future cash position ▲" : "Show future cash position ▼"}
            </button>
            {showProjection && (
              <div className="cashflow-detail">
                <div className="projection-controls">
                  <div className="mode-switch">
                    <button
                      type="button"
                      className={`mode-btn ${projectionMode === "monthly" ? "active" : ""}`}
                      onClick={() => {
                        setProjectionMode("monthly");
                        setProjectionPeriods("12");
                      }}
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${projectionMode === "annual" ? "active" : ""}`}
                      onClick={() => {
                        setProjectionMode("annual");
                        setProjectionPeriods("5");
                      }}
                    >
                      Annual
                    </button>
                  </div>
                  <label className="periods-input">
                    <span>{projectionMode === "monthly" ? "Months (max 12)" : "Years (max 10)"}</span>
                    <input
                      type="number"
                      min="1"
                      max={projectionMode === "monthly" ? 12 : 10}
                      value={projectionPeriods}
                      onChange={(e) => setProjectionPeriods(e.target.value)}
                    />
                  </label>
                </div>
                <p className="alloc-note" style={{ marginTop: 8 }}>
                  Projects current cash ({money(cashProjection.startCash)}) forward, growing income at {pct(cashProjection.incomeGrowthPct)}/yr, rent at {pct(cashProjection.rentGrowthPct)}/yr, household expenses at {pct(cashProjection.expenseGrowthPct)}/yr, and property tax/HOA/fees at {pct(cashProjection.propCostGrowthPct)}/yr (adjust these in the Income and Profile tabs). Active recurring deposit contributions are deducted until each plan's end date, then stop. Dividends and debt payments are held flat. Click any row for a full income/expense breakdown at that point.
                </p>
                <div className="projection-rows">
                  {cashProjection.rows.map((r) => {
                    const isOpen = drillDownPeriod === r.period;
                    const d = r.details;
                    return (
                      <div key={r.period}>
                        <div className="projection-row clickable" onClick={() => setDrillDownPeriod(isOpen ? null : r.period)}>
                          <span className="projection-label">{r.label}</span>
                          <div className="projection-bar-track">
                            <div
                              className={`projection-bar ${r.cash >= 0 ? "good" : "bad"}`}
                              style={{ width: `${Math.min(100, (Math.abs(r.cash) / cashProjection.maxAbs) * 100)}%` }}
                            />
                          </div>
                          <span className={`projection-value ${r.cash >= 0 ? "good" : "bad"}`}>{money(r.cash)}</span>
                        </div>
                        {isOpen && (
                          <div className="cashflow-detail drilldown-detail">
                            <div className="cashflow-section-label">{r.label} — inflows</div>
                            <div className="cashflow-line"><span>Income (grown)</span><span>{moneyPrecise(d.income)}</span></div>
                            {d.rent > 0 && <div className="cashflow-line"><span>Rental income (grown)</span><span>{moneyPrecise(d.rent)}</span></div>}
                            {d.dividends > 0 && <div className="cashflow-line"><span>Dividend income</span><span>{moneyPrecise(d.dividends)}</span></div>}
                            <div className="cashflow-line total"><span>Total inflow</span><span>{moneyPrecise(d.totalInflow)}</span></div>
                            <div className="cashflow-section-label">{r.label} — outflows</div>
                            <div className="cashflow-line"><span>Mortgage & loan payments</span><span>{moneyPrecise(d.mortgageLoanPayments)}</span></div>
                            <div className="cashflow-line"><span>Property tax/HOA/fees (grown)</span><span>{moneyPrecise(d.propCosts)}</span></div>
                            <div className="cashflow-line"><span>Household expenses (grown)</span><span>{moneyPrecise(d.expensesAmt)}</span></div>
                            {d.rdOutflow > 0 && <div className="cashflow-line"><span>Recurring deposits (active)</span><span>{moneyPrecise(d.rdOutflow)}</span></div>}
                            <div className="cashflow-line total"><span>Total outflow</span><span>{moneyPrecise(d.totalOutflow)}</span></div>
                            <div className={`cashflow-line net ${d.netFlow >= 0 ? "good" : "bad"}`}>
                              <span>Net cash flow this period</span><span>{moneyPrecise(d.netFlow)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <button type="button" className="cashflow-toggle" onClick={() => setShowNetWorthChart((s) => !s)}>
              {showNetWorthChart ? "Hide net worth trajectory ▲" : "Show net worth trajectory ▼"}
            </button>
            {showNetWorthChart && (
              <div className="cashflow-detail">
                <label className="periods-input">
                  <span>Years to project (max 40)</span>
                  <input
                    type="number"
                    min="1"
                    max="40"
                    value={netWorthYears}
                    onChange={(e) => setNetWorthYears(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={`recalc-btn ${netWorthTablePayoffsApplied ? "active" : ""}`}
                  style={{ marginTop: 10 }}
                  onClick={() => setNetWorthTablePayoffsApplied((s) => !s)}
                >
                  {netWorthTablePayoffsApplied ? "↺ Reset to baseline (no payoffs applied)" : "↻ Recalculate with recommended payoffs"}
                </button>
                <p className="alloc-note" style={{ marginTop: 8 }}>
                  Up to half of each year's cash flow surplus tops up your emergency fund first if a big planned expense (or anything else) has pulled cash below target — same 50% cap as the Suggested Monthly Allocation plan. That target holds steady in year 1, then grows {pct(summary.expenseGrowthPct)}/yr with expense inflation from year 2 on, rather than staying a fixed dollar figure forever. The rest of the surplus (all of it, once the fund is full) splits 70/30 between retirement investing (shares) and CDs/short-term savings. CDs grow at your {pct(num(marketCdRate))}/yr market rate (new money earns today's rate, regardless of what any existing CDs happen to carry), shares at {pct(summary.totalExpectedReturn)}/yr plus that contribution, and property at {pct(netWorthTableTrajectory.apprRate)}/yr appreciation, while amortizing mortgages and loans that have a rate on file. Recurring deposits compound at {pct(summary.weightedRDRate)}/yr and keep receiving each plan's own annual contribution (monthly deposit × 12) until that plan's own maturity date, then stop — each year's balance is the prior year's balance plus accrued interest plus that year's contribution. Your {country === "India" ? "Provident Fund" : "401(k)"} grows at {pct(summary.k401GrowthPct)}/yr plus its own annual contribution (growing at {pct(summary.k401ContributionGrowthPct)}/yr) — unlike the Retirement Readiness simulation, this trajectory has no fixed retirement year, so that contribution is assumed to continue for the full projection. {netWorthTablePayoffsApplied ? "Today's already-qualifying one-time actions (cash, CD, recurring deposit, and share payoffs) are applied right at the start, and future payoff proposals are applied in the year they'd trigger — each reducing both that debt and the asset used." : "This is the baseline path — no one-time or future payoff proposals are applied yet; toggle the button above to see their effect."} This toggle is shared with the Net Worth tab's table. A simplification — real contributions, rates, and returns will vary year to year.
                </p>
                <div className="projection-rows nwt-rows">
                  {netWorthTableTrajectory.rows
                    .filter((_, idx) => netWorthTableTrajectory.rows.length <= 16 || idx % Math.ceil(netWorthTableTrajectory.rows.length / 16) === 0 || idx === netWorthTableTrajectory.rows.length - 1)
                    .map((r) => (
                      <div className="projection-row" key={r.year}>
                        <span className="projection-label">{r.label}</span>
                        <div className="projection-bar-track">
                          <div
                            className={`projection-bar ${r.netWorth >= 0 ? "good" : "bad"}`}
                            style={{ width: `${Math.min(100, (Math.abs(r.netWorth) / netWorthTableTrajectory.maxAbs) * 100)}%` }}
                          />
                        </div>
                        <span className={`projection-value ${r.netWorth >= 0 ? "good" : "bad"}`}>{money(r.netWorth)}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div className="divider-label">Target investment mix{summary.hasAge ? "" : " (assumes age 45 — add your age for a tighter fit)"}</div>
            <div className="alloc-bar">
              <div className="alloc-seg equity" style={{ width: `${summary.targetEquityPct}%` }} />
              <div className="alloc-seg fixed" style={{ width: `${summary.targetFixedPct}%` }} />
            </div>
            <div className="alloc-legend">
              <span><i className="dot equity" /> Growth (shares) target {pct(summary.targetEquityPct)}</span>
              <span><i className="dot fixed" /> Stable (CDs/cash) target {pct(summary.targetFixedPct)}</span>
            </div>
            {summary.investablePortfolio > 0 ? (
              <p className="alloc-note">
                Right now your CDs + shares are split {pct(summary.currentEquityPct)} growth / {pct(summary.currentFixedPct)} stable.
                {Math.abs(summary.allocationGapPct) > 8
                  ? summary.allocationGapPct > 0
                    ? " New contributions could lean toward shares/index funds to move closer to your target."
                    : " New contributions could lean toward CDs or fixed income to move closer to your target."
                  : " That's reasonably close to your target mix already."}
              </p>
            ) : (
              <p className="alloc-note">Add CD or share balances to compare against this target.</p>
            )}

            <div className="divider-label">Retirement readiness</div>
            <div className="fi-progress-track">
              <div className={`fi-progress-fill ${summary.fiProgressPct >= 100 ? "done" : ""}`} style={{ width: `${Math.min(100, summary.fiProgressPct)}%` }} />
            </div>
            <div className="alloc-legend">
              <span>{money(summary.retirementPortfolioNow)} saved</span>
              <span>{pct(summary.fiProgressPct)} of {money(summary.fiNumber)} FI number</span>
            </div>
            <p className="alloc-note">
              FI number = {money(summary.annualRetirementExpense)}/yr ÷ {pct(summary.withdrawalRatePct)} withdrawal rate{summary.ssMonthlyAtFRA > 0 ? `, net of an estimated after-tax ${country === "India" ? "pension" : "Social Security"} benefit (taxed at ${pct(summary.ssTaxRatePct)})` : ""}, and it grows {pct(summary.expenseGrowthPct)}/yr with your expense growth assumption. Counting liquid cash + CDs + recurring deposits + shares{summary.k401Now > 0 ? ` + ${money(summary.k401Now)} in ${country === "India" ? "Provident Fund" : "401(k)"}` : ""} (not home equity).
              {summary.hasTargetAge ? (
                <>
                  {" "}At age {summary.estRetirementAge} ({summary.yearsToFI} {summary.yearsToFI === 1 ? "year" : "years"} away), expected expenses net of
                  {summary.ssMonthlyAtFRA > 0 ? ` an estimated ${moneyPrecise(summary.ssAnnualAtRetirement / 12)}/mo ${country === "India" ? "pension" : "Social Security"} benefit (claimed at ${summary.ssClaimAgeAtRetirement})` : ` ${country === "India" ? "pension" : "Social Security"}`} come to a {money(summary.fiNumberAtRetirement)} FI number, and your projected portfolio is {summary.readinessGap >= 0 ? (
                    <><strong className="verdict-invest">{money(summary.readinessGap)} ahead of pace</strong>.</>
                  ) : (
                    <><strong className="verdict-payoff">{money(Math.abs(summary.readinessGap))} short of pace</strong> — a higher savings rate, later retirement age, or lower target spending would close the gap.</>
                  )}
                </>
              ) : summary.yearsToFI === 0 ? (
                " You've already reached this number."
              ) : summary.yearsToFI !== null ? (
                <> Growing shares at {pct(summary.totalExpectedReturn)}/yr{summary.k401Now > 0 || summary.k401ContributionNow > 0 ? ` and your ${country === "India" ? "Provident Fund" : "401(k)"} at ${pct(summary.k401GrowthPct)}/yr${summary.k401ContributionNow > 0 ? ` plus ${moneyPrecise(summary.k401ContributionNow)}/yr in contributions until retirement` : ""}` : ""}, with rent, expenses, property costs{summary.ssMonthlyAtFRA > 0 ? `, and ${country === "India" ? "pension" : "Social Security"}` : ""} all factored in, you'd reach it in about <strong>{summary.yearsToFI} years</strong>{summary.estRetirementAge ? ` (around age ${summary.estRetirementAge}${summary.ssMonthlyAtFRA > 0 ? `, claiming ~${moneyPrecise(summary.ssAnnualAtRetirement / 12)}/mo in ${country === "India" ? "pension" : "Social Security"}` : ""})` : ""}.</>
              ) : (
                " At current savings and growth assumptions, this doesn't resolve within 60 years — a higher savings rate, higher returns, or lower target spending would change that."
              )}
            </p>

            {(summary.refinanceOpportunities.length > 0 || summary.liquidationOpportunities.length > 0) && (
              <>
                <div className="divider-label">One-time actions to consider</div>
                {summary.refinanceOpportunities.map((r, i) => (
                  <div className="plan-item one-time" key={`refi-${i}`}>
                    <div className="row">
                      <span>Refinance: {r.label}</span>
                      <span className="amt">≈ {moneyPrecise(r.estMonthlySavings)}/mo</span>
                    </div>
                    <div className="note">
                      Currently {pct(r.currentRate)} vs. ~{pct(r.marketRate)} market rate on {money(r.loanBalance)} balance. Rough interest-only estimate — weigh against closing costs and how long you'll keep the loan.
                    </div>
                  </div>
                ))}
                {summary.liquidationOpportunities.map((l, i) => (
                  <div className="plan-item one-time" key={`liq-${i}`}>
                    <div className="row">
                      <span>Consider paying off {l.debt} using {l.source}</span>
                      <span className="amt">{moneyPrecise(l.amount)}</span>
                    </div>
                    <div className="note">{l.note}</div>
                  </div>
                ))}
              </>
            )}

            <button type="button" className="cashflow-toggle" onClick={() => setShowFuturePayoff((s) => !s)}>
              {showFuturePayoff ? "Hide future payoff opportunities ▲" : "Show future payoff opportunities ▼"}
            </button>
            {showFuturePayoff && (
              <div className="cashflow-detail">
                <div className="threshold-control">
                  <label>
                    <span>Minimum payoff threshold</span>
                    <MoneyInput value={payoffThreshold} onChange={setPayoffThreshold} placeholder="10000" />
                  </label>
                </div>
                <p className="alloc-note" style={{ marginTop: 8 }}>
                  Projects your CD, recurring deposit, and share balances forward (starting from what's left after any actions above) to find the first month each pool crosses your {money(summary.payoffThresholdAmt)} minimum — then proposes liquidating it against the highest-rate qualifying debt at that time, same rule as today's actions. Amounts and dates are projections, not guarantees.
                </p>
                {summary.futurePayoffProjection.length === 0 ? (
                  <p className="empty-plan">No future payoff crosses your {money(summary.payoffThresholdAmt)} threshold within 30 years at current growth assumptions.</p>
                ) : (
                  summary.futurePayoffProjection.map((p, i) => (
                    <div className="plan-item one-time" key={`future-payoff-${i}`}>
                      <div className="row">
                        <span>{p.monthLabel}: pay off {p.debt} using {p.source}</span>
                        <span className="amt">{moneyPrecise(p.amount)}</span>
                      </div>
                      <div className="note">
                        {p.source} projected to reach {money(summary.payoffThresholdAmt)}+ by then (growing at {pct(p.sourceRate)}/yr) while {p.debt} still costs {pct(p.debtRate)}. Balance would drop to {money(p.resultingBalance)}. Already reflected in the future cash position and net worth trajectory below.
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {summary.restructureAnalysis.length > 0 && (
              <>
                <div className="divider-label">Liquidate shares vs. pay off debt — {summary.projYears}-yr outlook</div>
                <p className="alloc-note" style={{ marginTop: 0 }}>
                  Comparing each debt's rate against your {pct(summary.totalExpectedReturn)}/yr expected total return (price growth + dividend yield). Balances shown are what's left after any cash/CD paydown above.
                </p>
                {summary.restructureAnalysis.map((r, i) => {
                  const isOpen = explainOpenKey === i;
                  return (
                    <div className={`plan-item cost-of-capital ${r.verdict}`} key={`cost-${i}`}>
                      <div className="row">
                        <span>{r.label} <em style={{ marginLeft: 4 }}>{pct(r.rate)} rate</em></span>
                        <span className={`amt verdict-${r.verdict}`}>
                          {r.verdict === "payoff" ? "Pay off" : r.verdict === "invest" ? "Stay invested" : "Borderline"}
                        </span>
                      </div>
                      <div className="note">
                        Remaining balance: {money(r.balance)}. Spread: {r.spread >= 0 ? "+" : ""}{r.spread.toFixed(1)} pts ({pct(summary.totalExpectedReturn)} return vs {pct(r.rate)} debt cost).
                        Over {summary.projYears} yrs on {money(r.amount)}: staying invested projects to {money(r.fvInvest)} vs. {money(r.fvPayoff)} of avoided interest —
                        {" "}
                        {r.netAdvantage >= 0
                          ? `${money(Math.abs(r.netAdvantage))} in favor of staying invested.`
                          : `${money(Math.abs(r.netAdvantage))} in favor of paying off debt.`}
                        {r.verdict === "payoff" && (
                          <>
                            {" "}Liquidating {money(r.amount)} in shares would drop this balance to {money(r.resultingBalance)}.
                            {!r.meetsThreshold && ` This is below your ${money(summary.payoffThresholdAmt)} minimum payoff threshold — informational only, not an active recommendation.`}
                          </>
                        )}
                        {" "}Assumes expected returns hold and ignores taxes on any gains sold.
                      </div>
                      <button
                        type="button"
                        className="explain-toggle"
                        onClick={() => setExplainOpenKey(isOpen ? null : i)}
                      >
                        {isOpen ? "Hide explanation ▲" : "Explanation ▼"}
                      </button>
                      {isOpen && (
                        <div className="explain-panel">
                          <div className="explain-row">
                            <span className="explain-label">1. Remaining balance</span>
                            <p>
                              {money(r.balance)} is what's left on this {r.kind === "mortgage" ? "mortgage" : "loan"} after any excess cash and CD funds were already applied in the steps above — this comparison only runs on what's still outstanding.
                            </p>
                          </div>
                          <div className="explain-row">
                            <span className="explain-label">2. Expected return vs. debt cost</span>
                            <p>
                              Your total expected return is {pct(summary.totalExpectedReturn)}/yr, made up of {pct(summary.growthRate)} expected price growth + {pct(summary.dividendYieldPct)} actual dividend yield from your holdings.
                              {" "}This debt costs {pct(r.rate)}/yr. Spread = {pct(summary.totalExpectedReturn)} − {pct(r.rate)} = {r.spread >= 0 ? "+" : ""}{r.spread.toFixed(1)} points.
                              {" "}A positive spread favors staying invested; a negative one favors paying off debt.
                            </p>
                          </div>
                          <div className="explain-row">
                            <span className="explain-label">3. Amount compared</span>
                            <p>
                              {money(r.amount)} — the smaller of this debt's {money(r.balance)} balance and your {money(summary.totalShares)} in total shares, since the app can't recommend liquidating more than you actually hold.
                            </p>
                          </div>
                          <div className="explain-row">
                            <span className="explain-label">4. {summary.projYears}-year projection</span>
                            <p>
                              Staying invested: {money(r.amount)} × (1 + {pct(summary.totalExpectedReturn)})^{summary.projYears} = <strong>{money(r.fvInvest)}</strong>
                              <br />
                              Paying off debt: {money(r.amount)} × (1 + {pct(r.rate)})^{summary.projYears} = <strong>{money(r.fvPayoff)}</strong> in avoided compounding interest
                            </p>
                          </div>
                          <div className="explain-row">
                            <span className="explain-label">5. Net advantage</span>
                            <p>
                              {money(r.fvInvest)} − {money(r.fvPayoff)} = <strong className={r.netAdvantage >= 0 ? "verdict-invest" : "verdict-payoff"}>{money(Math.abs(r.netAdvantage))} {r.netAdvantage >= 0 ? "in favor of staying invested" : "in favor of paying off debt"}</strong>.
                            </p>
                          </div>
                          <div className="explain-row">
                            <span className="explain-label">Caveats</span>
                            <p>
                              The avoided-interest side is close to guaranteed — debt costs are contractual. The investment side assumes {pct(summary.totalExpectedReturn)}/yr actually holds, which isn't guaranteed, and ignores capital gains tax you'd owe if shares were sold to pay off debt.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            <div className="divider-label">Suggested monthly allocation</div>
            {summary.plan.length === 0 && (
              <div className="empty-plan">Enter income and expenses to see a suggested plan.</div>
            )}
            {summary.plan.map((p, i) => (
              <div className="plan-item" key={i}>
                <div className="row">
                  <span>{p.label}</span>
                  <span className="amt">{moneyPrecise(p.amount)}</span>
                </div>
                <div className="note">{p.note}</div>
              </div>
            ))}

            <div className="disclaimer">
              This is a general starting point based on the numbers you entered — not personalized financial advice. Consider talking to a licensed financial advisor before acting on it.
            </div>
          </div>
        </div>
      </div>
        </>
      )}
    </div>
    </CurrencyContext.Provider>
  );
}
